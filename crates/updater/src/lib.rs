use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use flate2::read::GzDecoder;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use semver::Version;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const DEFAULT_RELEASE_BASE_URL: &str =
    "https://github.com/ZhimingYe/filebox/releases/latest/download";
const SUPPORTED_ARCHIVE_SUFFIX: &str = "-x86_64-musl.tar.gz";
const FRONTEND_DIST_RELATIVE_PATH: &str = "frontend/dist";

pub type UpdateResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Product {
    Hub,
    Agent,
}

impl Product {
    fn binary_name(self) -> &'static str {
        match self {
            Product::Hub => "hub",
            Product::Agent => "agent",
        }
    }

    fn asset_prefix(self) -> &'static str {
        match self {
            Product::Hub => "filebox-hub-",
            Product::Agent => "filebox-agent-",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpdateCommand {
    Run,
    Help,
    InitConfig(ConfigInitRequest),
    Update(UpdateRequest),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigInitRequest {
    pub output: Option<PathBuf>,
    pub force: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateRequest {
    pub base_url: Option<String>,
    pub allow_insecure_update: bool,
    pub allow_downgrade: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateOutcome {
    pub installed: bool,
    pub source_url: String,
    pub current_version: &'static str,
    pub target_version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ReleaseAsset {
    filename: String,
    sha256: String,
    version: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VersionAction {
    AlreadyCurrent,
    Upgrade,
    Downgrade,
}

pub fn usage(binary_name: &str) -> String {
    let default_config = if binary_name == "hub" {
        "config/hub.json"
    } else {
        "agent.toml"
    };
    format!(
        "Usage:\n  {binary_name}\n  {binary_name} --init-config [--output <path>] [--force]\n  {binary_name} --update [--update-base-url <url>] [--allow-insecure-update] [--allow-downgrade]\n  {binary_name} --help\n\nOptions:\n  --init-config             Interactively create a ready-to-use config file.\n  --output <path>           Config output path. Default: {default_config}\n  --force                   Replace an existing config file.\n  --update                  Download the latest release and replace the local install in place.\n  --update-base-url <url>   Override the release asset base URL.\n                            The URL must expose SHA256SUMS.txt and the release tarballs.\n                            Default: {DEFAULT_RELEASE_BASE_URL}\n  --allow-insecure-update   Allow http:// update sources. Dangerous; use only on trusted networks.\n                            Env override: FILEBOX_ALLOW_INSECURE_UPDATE=1\n  --allow-downgrade         Allow replacing the current version with an older release.\n                            Env override: FILEBOX_ALLOW_DOWNGRADE=1\n  --help                    Show this help text.\n"
    )
}

pub fn prompt_line(label: &str, default: Option<&str>) -> Result<String, String> {
    match default {
        Some(value) => eprint!("{label} [{value}]: "),
        None => eprint!("{label}: "),
    }
    io::stderr()
        .flush()
        .map_err(|error| format!("failed to write prompt: {error}"))?;
    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .map_err(|error| format!("failed to read input: {error}"))?;
    let value = input.trim().to_string();
    if value.is_empty() {
        Ok(default.unwrap_or_default().to_string())
    } else {
        Ok(value)
    }
}

pub fn prompt_nonempty_secret(label: &str) -> Result<String, String> {
    loop {
        let value = rpassword::prompt_password(format!("{label}: "))
            .map_err(|error| format!("failed to read {label}: {error}"))?;
        if value.is_empty() {
            eprintln!("{label} cannot be empty.");
        } else {
            return Ok(value);
        }
    }
}

pub fn prompt_confirmed_secret(label: &str, confirm_label: &str) -> Result<String, String> {
    loop {
        let value = prompt_nonempty_secret(label)?;
        let confirmation = rpassword::prompt_password(format!("{confirm_label}: "))
            .map_err(|error| format!("failed to read confirmation: {error}"))?;
        if value == confirmation {
            return Ok(value);
        }
        eprintln!("Values do not match; try again.");
    }
}

pub fn prompt_yes_no(label: &str, default_yes: bool) -> Result<bool, String> {
    let suffix = if default_yes { "Y/n" } else { "y/N" };
    loop {
        let value = prompt_line(&format!("{label} [{suffix}]"), None)?;
        if value.is_empty() {
            return Ok(default_yes);
        }
        match value.to_ascii_lowercase().as_str() {
            "y" | "yes" => return Ok(true),
            "n" | "no" => return Ok(false),
            _ => eprintln!("Answer yes or no."),
        }
    }
}

pub fn ensure_output_available(path: &Path, force: bool) -> Result<(), String> {
    if path.exists() && !force {
        return Err(format!(
            "config already exists: {} (use --force to replace it)",
            path.display()
        ));
    }
    Ok(())
}

pub fn write_private_file(path: &Path, contents: &[u8], force: bool) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create '{}': {error}", parent.display()))?;
    }

    let mut options = OpenOptions::new();
    options.write(true);
    if force {
        options.create(true).truncate(true);
    } else {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            format!(
                "config already exists: {} (use --force to replace it)",
                path.display()
            )
        } else {
            format!("failed to create '{}': {error}", path.display())
        }
    })?;
    file.write_all(contents)
        .map_err(|error| format!("failed to write '{}': {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("failed to sync '{}': {error}", path.display()))?;

    #[cfg(unix)]
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .map_err(|error| format!("failed to secure '{}': {error}", path.display()))?;

    Ok(())
}

pub fn parse_command(
    binary_name: &str,
    args: impl IntoIterator<Item = String>,
) -> Result<UpdateCommand, String> {
    let mut update = false;
    let mut init_config = false;
    let mut output = None;
    let mut force = false;
    let mut base_url = None;
    let mut allow_insecure_update = false;
    let mut allow_downgrade = false;
    let mut iter = args.into_iter();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--help" | "-h" => return Ok(UpdateCommand::Help),
            "--init-config" => init_config = true,
            "--force" => force = true,
            "--output" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--output requires a path argument".to_string())?;
                if value.is_empty() {
                    return Err("--output requires a non-empty path".to_string());
                }
                output = Some(PathBuf::from(value));
            }
            _ if let Some(value) = arg.strip_prefix("--output=") => {
                if value.is_empty() {
                    return Err("--output requires a non-empty path".to_string());
                }
                output = Some(PathBuf::from(value));
            }
            "--update" => update = true,
            "--allow-insecure-update" => allow_insecure_update = true,
            "--allow-downgrade" => allow_downgrade = true,
            "--update-base-url" => {
                let value = iter.next().ok_or_else(|| {
                    "--update-base-url requires a URL argument".to_string()
                })?;
                base_url = Some(value);
            }
            _ if let Some(value) = arg.strip_prefix("--update-base-url=") => {
                if value.is_empty() {
                    return Err("--update-base-url requires a non-empty URL".to_string());
                }
                base_url = Some(value.to_string());
            }
            _ => return Err(format!("unknown argument for {binary_name}: {arg}")),
        }
    }

    if init_config && update {
        return Err("--init-config and --update are mutually exclusive".to_string());
    }

    if init_config {
        if base_url.is_some() || allow_insecure_update || allow_downgrade {
            return Err("update options cannot be used together with --init-config".to_string());
        }
        return Ok(UpdateCommand::InitConfig(ConfigInitRequest {
            output,
            force,
        }));
    }

    if output.is_some() || force {
        return Err("--output and --force can only be used with --init-config".to_string());
    }

    if !update {
        if base_url.is_some() || allow_insecure_update || allow_downgrade {
            return Err(
                "--update-base-url, --allow-insecure-update, and --allow-downgrade can only be used together with --update"
                    .to_string(),
            );
        }
        return Ok(UpdateCommand::Run);
    }

    Ok(UpdateCommand::Update(UpdateRequest {
        base_url,
        allow_insecure_update,
        allow_downgrade,
    }))
}

pub async fn run_update(product: Product, request: UpdateRequest) -> UpdateResult<UpdateOutcome> {
    ensure_supported_runtime()?;

    let current_version = env!("CARGO_PKG_VERSION");
    let base_url = resolve_base_url(&request);
    validate_base_url(&base_url, request.allow_insecure_update || allow_insecure_update())?;
    eprintln!(
        "[{}] checking for updates from {}",
        product.binary_name(),
        base_url
    );

    let client = build_http_client(current_version)?;
    let checksums_url = format!("{base_url}/SHA256SUMS.txt");
    let checksums = download_text(&client, &checksums_url).await?;
    let asset = find_release_asset(product, &checksums)?;

    match compare_versions(current_version, &asset.version)? {
        VersionAction::AlreadyCurrent => {
            return Ok(UpdateOutcome {
                installed: false,
                source_url: base_url,
                current_version,
                target_version: asset.version,
            });
        }
        VersionAction::Downgrade if !(request.allow_downgrade || allow_downgrade()) => {
            return Err(other_error(format!(
                "refusing to downgrade from v{current_version} to v{}; rerun with --allow-downgrade or FILEBOX_ALLOW_DOWNGRADE=1 if this is intentional",
                asset.version
            )));
        }
        VersionAction::Upgrade | VersionAction::Downgrade => {}
    }

    let tarball_url = format!("{}/{}", base_url, asset.filename);
    eprintln!(
        "[{}] downloading {}",
        product.binary_name(),
        tarball_url
    );

    let temp_dir = tempfile::tempdir()?;
    let archive_path = temp_dir.path().join(&asset.filename);
    let actual_sha256 = download_archive(&client, &tarball_url, &archive_path).await?;

    if !actual_sha256.eq_ignore_ascii_case(&asset.sha256) {
        return Err(other_error(format!(
            "checksum mismatch for {}: expected {}, got {}",
            asset.filename, asset.sha256, actual_sha256
        )));
    }

    eprintln!(
        "[{}] checksum verified, unpacking {}",
        product.binary_name(),
        asset.filename
    );
    let package_root = unpack_archive(&archive_path, &asset.filename, &temp_dir)?;
    apply_update(product, &package_root)?;

    Ok(UpdateOutcome {
        installed: true,
        source_url: base_url,
        current_version,
        target_version: asset.version,
    })
}

fn ensure_supported_runtime() -> UpdateResult<()> {
    if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        return Ok(());
    }

    Err(other_error(
        "self-update is only supported on Linux x86_64 installations".to_string(),
    ))
}

fn resolve_base_url(request: &UpdateRequest) -> String {
    let resolved = request
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            std::env::var("FILEBOX_UPDATE_BASE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| DEFAULT_RELEASE_BASE_URL.to_string());
    resolved.trim_end_matches('/').to_string()
}

fn validate_base_url(base_url: &str, allow_insecure: bool) -> UpdateResult<()> {
    let url = reqwest::Url::parse(base_url).map_err(|error| {
        other_error(format!("invalid update base URL '{}': {}", base_url, error))
    })?;

    match url.scheme() {
        "https" => Ok(()),
        "http" if allow_insecure => {
            eprintln!(
                "[update] WARNING: using plaintext update source {} (FILEBOX_ALLOW_INSECURE_UPDATE=1 / --allow-insecure-update)",
                base_url
            );
            Ok(())
        }
        "http" => Err(other_error(format!(
            "update base URL must use https://. Got {}. Re-run with --allow-insecure-update or FILEBOX_ALLOW_INSECURE_UPDATE=1 only on a trusted network",
            base_url
        ))),
        scheme => Err(other_error(format!(
            "update base URL must use https://. Unsupported scheme '{}' in {}",
            scheme, base_url
        ))),
    }
}

fn allow_insecure_update() -> bool {
    std::env::var("FILEBOX_ALLOW_INSECURE_UPDATE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn allow_downgrade() -> bool {
    std::env::var("FILEBOX_ALLOW_DOWNGRADE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn compare_versions(current: &str, target: &str) -> UpdateResult<VersionAction> {
    let current = Version::parse(current)
        .map_err(|error| other_error(format!("invalid current version '{}': {}", current, error)))?;
    let target = Version::parse(target)
        .map_err(|error| other_error(format!("invalid target version '{}': {}", target, error)))?;

    if target == current {
        return Ok(VersionAction::AlreadyCurrent);
    }

    if target > current {
        return Ok(VersionAction::Upgrade);
    }

    Ok(VersionAction::Downgrade)
}

fn build_http_client(version: &str) -> UpdateResult<reqwest::Client> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&format!("filebox-updater/{version}"))?,
    );

    Ok(reqwest::Client::builder()
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(10))
        .build()?)
}

async fn download_text(client: &reqwest::Client, url: &str) -> UpdateResult<String> {
    let response = client.get(url).send().await?.error_for_status()?;
    Ok(response.text().await?)
}

async fn download_archive(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
) -> UpdateResult<String> {
    let mut response = client.get(url).send().await?.error_for_status()?;
    let mut file = fs::File::create(destination)?;
    let mut hasher = Sha256::new();

    while let Some(chunk) = response.chunk().await? {
        hasher.update(&chunk);
        io::Write::write_all(&mut file, &chunk)?;
    }

    Ok(hex::encode(hasher.finalize()))
}

fn find_release_asset(product: Product, checksums: &str) -> UpdateResult<ReleaseAsset> {
    for line in checksums.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let Some(sha256) = parts.next() else {
            continue;
        };
        let Some(filename) = parts.next() else {
            continue;
        };

        if !filename.starts_with(product.asset_prefix())
            || !filename.ends_with(SUPPORTED_ARCHIVE_SUFFIX)
        {
            continue;
        }

        let version = filename
            .strip_prefix(product.asset_prefix())
            .and_then(|value| value.strip_suffix(SUPPORTED_ARCHIVE_SUFFIX))
            .ok_or_else(|| {
                other_error(format!("unable to parse version from release asset {filename}"))
            })?;

        return Ok(ReleaseAsset {
            filename: filename.to_string(),
            sha256: sha256.to_string(),
            version: version.to_string(),
        });
    }

    Err(other_error(format!(
        "SHA256SUMS.txt does not contain a {} release archive",
        product.binary_name()
    )))
}

fn unpack_archive(archive_path: &Path, filename: &str, temp_dir: &TempDir) -> UpdateResult<PathBuf> {
    let extract_dir = temp_dir.path().join("unpacked");
    fs::create_dir_all(&extract_dir)?;

    let archive_file = fs::File::open(archive_path)?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(&extract_dir)?;

    let package_dir_name = filename
        .strip_suffix(".tar.gz")
        .ok_or_else(|| other_error(format!("release archive has an unexpected filename: {filename}")))?;
    let package_root = extract_dir.join(package_dir_name);
    if !package_root.is_dir() {
        return Err(other_error(format!(
            "release archive did not unpack the expected directory {}",
            package_root.display()
        )));
    }
    Ok(package_root)
}

fn apply_update(product: Product, package_root: &Path) -> UpdateResult<()> {
    let current_exe = current_executable_path()?;
    let new_binary = match product {
        Product::Hub => package_root.join("bin/hub"),
        Product::Agent => package_root.join("agent"),
    };

    if !new_binary.is_file() {
        return Err(other_error(format!(
            "release package is missing {}",
            new_binary.display()
        )));
    }

    let binary_staging_path = stage_binary(&new_binary, &current_exe)?;
    match product {
        Product::Agent => replace_file(&binary_staging_path, &current_exe)?,
        Product::Hub => {
            let source_frontend_dist = package_root.join(FRONTEND_DIST_RELATIVE_PATH);
            if !source_frontend_dist.join("index.html").is_file() {
                return Err(other_error(format!(
                    "release package is missing {}",
                    source_frontend_dist.display()
                )));
            }
            let destination_frontend_dist = locate_frontend_dist(&current_exe)?;
            let frontend_backup = swap_directory(&source_frontend_dist, &destination_frontend_dist)?;
            if let Err(error) = replace_file(&binary_staging_path, &current_exe) {
                rollback_directory_swap(&destination_frontend_dist, &frontend_backup)?;
                return Err(error);
            }
            if let Some(backup) = frontend_backup {
                fs::remove_dir_all(backup)?;
            }
        }
    }

    Ok(())
}

fn current_executable_path() -> UpdateResult<PathBuf> {
    let current_exe = std::env::current_exe()?;
    Ok(fs::canonicalize(&current_exe).unwrap_or(current_exe))
}

fn stage_binary(source: &Path, current_exe: &Path) -> UpdateResult<PathBuf> {
    let parent = current_exe
        .parent()
        .ok_or_else(|| other_error("current executable has no parent directory".to_string()))?;
    let staging_path = parent.join(format!(
        ".{}.filebox-update-new",
        current_exe
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("binary")
    ));

    if staging_path.exists() {
        let _ = fs::remove_file(&staging_path);
    }

    fs::copy(source, &staging_path)?;
    let permissions = fs::metadata(source)?.permissions();
    fs::set_permissions(&staging_path, permissions)?;
    Ok(staging_path)
}

fn replace_file(staging_path: &Path, destination: &Path) -> UpdateResult<()> {
    fs::rename(staging_path, destination)?;
    Ok(())
}

fn locate_frontend_dist(current_exe: &Path) -> UpdateResult<PathBuf> {
    let mut cursor = current_exe
        .parent()
        .ok_or_else(|| other_error("hub executable has no parent directory".to_string()))?;

    for _ in 0..8 {
        let candidate = cursor.join(FRONTEND_DIST_RELATIVE_PATH);
        if candidate.join("index.html").is_file() {
            return Ok(candidate);
        }

        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent;
    }

    Err(other_error(
        "unable to locate frontend/dist next to the current hub install".to_string(),
    ))
}

fn swap_directory(source: &Path, destination: &Path) -> UpdateResult<Option<PathBuf>> {
    let parent = destination
        .parent()
        .ok_or_else(|| other_error("destination directory has no parent".to_string()))?;
    fs::create_dir_all(parent)?;

    let staging_path = parent.join(format!(
        "{}.filebox-update-new",
        destination
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("dist")
    ));
    let backup_path = parent.join(format!(
        "{}.filebox-update-backup",
        destination
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("dist")
    ));

    if staging_path.exists() {
        fs::remove_dir_all(&staging_path)?;
    }
    if backup_path.exists() {
        fs::remove_dir_all(&backup_path)?;
    }

    copy_directory(source, &staging_path)?;

    let had_existing_destination = destination.exists();
    if had_existing_destination {
        fs::rename(destination, &backup_path)?;
    }

    if let Err(error) = fs::rename(&staging_path, destination) {
        if had_existing_destination {
            let _ = fs::rename(&backup_path, destination);
        }
        return Err(Box::new(error));
    }

    Ok(had_existing_destination.then_some(backup_path))
}

fn rollback_directory_swap(destination: &Path, backup: &Option<PathBuf>) -> UpdateResult<()> {
    if !destination.exists() {
        return Ok(());
    }

    fs::remove_dir_all(destination)?;
    if let Some(backup_dir) = backup {
        fs::rename(backup_dir, destination)?;
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> UpdateResult<()> {
    fs::create_dir_all(destination)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)?;
            let permissions = fs::metadata(&source_path)?.permissions();
            fs::set_permissions(&destination_path, permissions)?;
        } else {
            return Err(other_error(format!(
                "unsupported entry in release package: {}",
                source_path.display()
            )));
        }
    }

    Ok(())
}

fn other_error(message: String) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(io::Error::other(message))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        compare_versions, find_release_asset, parse_command, resolve_base_url, usage,
        validate_base_url, write_private_file, ConfigInitRequest, Product, UpdateCommand,
        UpdateRequest, VersionAction,
    };

    #[test]
    fn parse_command_defaults_to_run() {
        let command = parse_command("hub", Vec::<String>::new()).unwrap();
        assert_eq!(command, UpdateCommand::Run);
    }

    #[test]
    fn parse_command_supports_config_init_options() {
        let command = parse_command(
            "hub",
            vec![
                "--init-config".to_string(),
                "--output".to_string(),
                "/tmp/hub.json".to_string(),
                "--force".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            command,
            UpdateCommand::InitConfig(ConfigInitRequest {
                output: Some(PathBuf::from("/tmp/hub.json")),
                force: true,
            })
        );
    }

    #[test]
    fn parse_command_rejects_config_init_mixed_with_update() {
        let error = parse_command(
            "agent",
            vec!["--init-config".to_string(), "--update".to_string()],
        )
        .unwrap_err();
        assert!(error.contains("mutually exclusive"));
    }

    #[test]
    fn parse_command_rejects_config_output_without_init() {
        let error = parse_command("agent", vec!["--output=agent.toml".to_string()]).unwrap_err();
        assert!(error.contains("only be used with --init-config"));
    }

    #[test]
    fn config_writer_is_private_and_refuses_unforced_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/config");
        write_private_file(&path, b"first", false).unwrap();
        let error = write_private_file(&path, b"second", false).unwrap_err();
        assert!(error.contains("--force"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

        write_private_file(&path, b"second", true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn parse_command_supports_update_base_url_equals_form() {
        let command = parse_command(
            "hub",
            vec![
                "--update".to_string(),
                "--update-base-url=https://mirror.example.com/releases".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            command,
            UpdateCommand::Update(UpdateRequest {
                base_url: Some("https://mirror.example.com/releases".to_string()),
                allow_insecure_update: false,
                allow_downgrade: false,
            })
        );
    }

    #[test]
    fn parse_command_supports_explicit_risk_flags() {
        let command = parse_command(
            "agent",
            vec![
                "--update".to_string(),
                "--allow-insecure-update".to_string(),
                "--allow-downgrade".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            command,
            UpdateCommand::Update(UpdateRequest {
                base_url: None,
                allow_insecure_update: true,
                allow_downgrade: true,
            })
        );
    }

    #[test]
    fn parse_command_rejects_update_only_flags_without_update() {
        let error = parse_command(
            "agent",
            vec!["--allow-downgrade".to_string()],
        )
        .unwrap_err();
        assert!(error.contains("only be used together with --update"));
    }

    #[test]
    fn resolve_base_url_trims_trailing_slash() {
        let url = resolve_base_url(&UpdateRequest {
            base_url: Some("https://mirror.example.com/releases/".to_string()),
            allow_insecure_update: false,
            allow_downgrade: false,
        });
        assert_eq!(url, "https://mirror.example.com/releases");
    }

    #[test]
    fn validate_base_url_rejects_plain_http_without_override() {
        let error = validate_base_url("http://mirror.example.com/releases", false).unwrap_err();
        assert!(error.to_string().contains("must use https://"));
    }

    #[test]
    fn validate_base_url_accepts_plain_http_with_override() {
        validate_base_url("http://mirror.example.com/releases", true).unwrap();
    }

    #[test]
    fn compare_versions_detects_downgrade_and_prerelease_ordering() {
        assert_eq!(
            compare_versions("0.6.3-rc1", "0.6.2").unwrap(),
            VersionAction::Downgrade
        );
        assert_eq!(
            compare_versions("0.6.3-rc1", "0.6.3").unwrap(),
            VersionAction::Upgrade
        );
    }

    #[test]
    fn find_release_asset_picks_the_requested_product() {
        let checksums = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  filebox-hub-0.6.3-x86_64-musl.tar.gz\n\
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  filebox-agent-0.6.3-x86_64-musl.tar.gz\n";

        let hub = find_release_asset(Product::Hub, checksums).unwrap();
        assert_eq!(hub.version, "0.6.3");
        assert_eq!(hub.filename, "filebox-hub-0.6.3-x86_64-musl.tar.gz");

        let agent = find_release_asset(Product::Agent, checksums).unwrap();
        assert_eq!(agent.version, "0.6.3");
        assert_eq!(agent.filename, "filebox-agent-0.6.3-x86_64-musl.tar.gz");
    }

    #[test]
    fn usage_mentions_update_base_url() {
        let help = usage("hub");
        assert!(help.contains("--init-config"));
        assert!(help.contains("Default: config/hub.json"));
        assert!(help.contains("--update-base-url <url>"));
        assert!(help.contains("--allow-insecure-update"));
        assert!(help.contains("--allow-downgrade"));
    }
}
