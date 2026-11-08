use axum::http::{header, HeaderMap, Method, Uri};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use crate::auth::{Session, SessionStore};

pub(super) const PARAM: &str = "__filebox_manifest";
pub(super) const ENDPOINT: &str = "__filebox_manifest_token";
const TTL: u64 = 600;

pub(super) fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;

pub(super) fn clean(uri: &Uri) -> (String, Option<String>) {
    let mut tokens = Vec::new();
    let query: Vec<_> = uri.query().into_iter().flat_map(|q| q.split('&')).filter(|part| {
        if let Some((key, value)) = url::form_urlencoded::parse(part.as_bytes()).next() {
            if key == PARAM { tokens.push(value.into_owned()); return false; }
        }
        true
    }).collect();
    let target = if query.is_empty() { uri.path().into() } else { format!("{}?{}", uri.path(), query.join("&")) };
    (target, if tokens.len() == 1 { tokens.pop() } else { None })
}

#[derive(Clone)]
pub(super) struct Signer { pub base: url::Url, origin: url::Origin, prefix: String, session: Session, expires: u64 }
impl Signer {
    pub fn new(base: url::Url, prefix: String, session: Session) -> Self {
        let expires = now().saturating_add(TTL).min(session.expires_at);
        Self { origin: base.origin(), base, prefix, session, expires }
    }
    fn mac(session: &Session, expires: u64, prefix: &str, target: &str) -> Hmac<Sha256> {
        let mut mac = Hmac::<Sha256>::new_from_slice(session.session_id.as_bytes()).unwrap();
        mac.update(&serde_json::to_vec(&("filebox-manifest-v1", &session.principal_id, expires, prefix, target)).unwrap());
        mac
    }
    pub fn href(&self, value: &str) -> Option<String> {
        let mut url = self.base.join(value).ok()?;
        if url.origin() != self.origin || !url.path().starts_with(&format!("{}/", self.prefix))
            || url.path() == format!("{}/{}", self.prefix, ENDPOINT) || !url.username().is_empty() || url.password().is_some() { return None; }
        let uri: Uri = url[url::Position::BeforePath..url::Position::AfterQuery].parse().ok()?;
        let (target, _) = clean(&uri);
        let signature = URL_SAFE_NO_PAD.encode(Self::mac(&self.session, self.expires, &self.prefix, &target).finalize().into_bytes());
        let token = format!("{}.{}.{signature}", self.session.principal_id, self.expires);
        let query = target.split_once('?').map(|(_, q)| format!("{q}&{PARAM}={token}")).unwrap_or_else(|| format!("{PARAM}={token}"));
        url.set_query(Some(&query));
        Some(url.to_string())
    }
    pub fn authenticate(store: &SessionStore, method: &Method, headers: &HeaderMap, uri: &Uri, time: u64) -> Option<Session> {
        if method != Method::GET || headers.contains_key(header::UPGRADE) || headers.get("sec-fetch-dest").is_some_and(|v| v != "manifest") { return None; }
        let (target, token) = clean(uri);
        let token = token.filter(|v| v.len() < 256)?;
        let mut fields = token.split('.');
        let principal = fields.next()?;
        let expires: u64 = fields.next()?.parse().ok()?;
        let signature = URL_SAFE_NO_PAD.decode(fields.next()?).ok()?;
        if fields.next().is_some() || expires <= time || expires > time.saturating_add(TTL) { return None; }
        let rest = uri.path().strip_prefix("/_fwd/")?;
        let mut parts = rest.splitn(3, '/');
        let prefix = format!("/_fwd/{}/{}", parts.next()?, parts.next()?);
        parts.next()?;
        let session = store.get_session_by_principal(principal)?;
        Self::mac(session, expires, &prefix, &target).verify_slice(&signature).ok()?;
        Some(session.clone())
    }
}
