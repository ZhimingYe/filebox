use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::wizard::{self, Prompter};
use crate::ProviderConfig;

type ConfigValidator = dyn Fn(&Value) -> Result<(), String>;

pub struct StdioPrompter;

impl wizard::Prompter for StdioPrompter {
    fn line(&mut self, label: &str, default: Option<&str>) -> Result<String, String> {
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

    fn secret(&mut self, label: &str) -> Result<String, String> {
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

    fn yes_no(&mut self, label: &str, default: bool) -> Result<bool, String> {
        let suffix = if default { "Y/n" } else { "y/N" };
        loop {
            let value = self.line(&format!("{label} [{suffix}]"), None)?;
            if value.is_empty() {
                return Ok(default);
            }
            match value.to_ascii_lowercase().as_str() {
                "y" | "yes" => return Ok(true),
                "n" | "no" => return Ok(false),
                _ => eprintln!("Answer yes or no."),
            }
        }
    }

    fn choose(&mut self, label: &str, options: &[String]) -> Result<usize, String> {
        eprintln!("{label}:");
        for (index, option) in options.iter().enumerate() {
            eprintln!("  {}. {option}", index + 1);
        }
        loop {
            let choice = self.line("Choice", Some("1"))?;
            match choice.parse::<usize>() {
                Ok(choice) if (1..=options.len()).contains(&choice) => return Ok(choice - 1),
                _ => eprintln!("Choose a number from 1 to {}.", options.len()),
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FeatureBinding {
    pub key: &'static str,
    pub question: &'static str,
}

pub trait ProviderStore {
    fn provider_names(&self) -> Vec<String>;
    fn has_inline_binding(&self, key: &str) -> bool;
    fn insert_provider(
        &mut self,
        name: &str,
        provider: &ProviderConfig,
        inline_key: Option<&str>,
    ) -> Result<(), String>;
    fn bind(&mut self, key: &str, provider: &str) -> Result<(), String>;
    fn save(&mut self) -> Result<(), String>;
}

pub struct JsonProviderStore {
    path: PathBuf,
    target: PathBuf,
    original: Vec<u8>,
    root: Value,
    validate: Box<ConfigValidator>,
    validation_provider: Option<(String, Option<String>)>,
}

impl JsonProviderStore {
    pub fn open(
        path: &Path,
        validate: impl Fn(&Value) -> Result<(), String> + 'static,
    ) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                format!("config not found: {}", path.display())
            } else {
                format!("failed to read '{}': {error}", path.display())
            }
        })?;
        let target = fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve '{}': {error}", path.display()))?;
        let mut original = Vec::new();
        file.read_to_end(&mut original)
            .map_err(|error| format!("failed to read '{}': {error}", path.display()))?;
        let contents = std::str::from_utf8(&original)
            .map_err(|error| format!("failed to read '{}': {error}", path.display()))?;
        let root = serde_json::from_str(contents)
            .map_err(|error| format!("failed to parse '{}': {error}", path.display()))?;
        Ok(Self {
            path: path.to_owned(),
            target,
            original,
            root,
            validate: Box::new(validate),
            validation_provider: None,
        })
    }
}

impl ProviderStore for JsonProviderStore {
    fn provider_names(&self) -> Vec<String> {
        self.root
            .get("llm_providers")
            .and_then(Value::as_object)
            .map(|providers| providers.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn has_inline_binding(&self, key: &str) -> bool {
        self.root.get(key).is_some_and(|value| {
            value
                .get("provider")
                .and_then(Value::as_str)
                .is_none()
        })
    }

    fn insert_provider(
        &mut self,
        name: &str,
        provider: &ProviderConfig,
        inline_key: Option<&str>,
    ) -> Result<(), String> {
        let root = self
            .root
            .as_object_mut()
            .ok_or_else(|| "config must be a JSON object".to_string())?;
        let providers = root.entry("llm_providers").or_insert_with(|| json!({}));
        let providers = providers
            .as_object_mut()
            .ok_or_else(|| "llm_providers must be a JSON object".to_string())?;
        let mut provider_value = serde_json::to_value(provider)
            .map_err(|error| format!("failed to serialize provider: {error}"))?;
        if let Some(key) = inline_key {
            provider_value["api_key"] = Value::String(key.to_owned());
        }
        providers.insert(name.to_owned(), provider_value);
        self.validation_provider = Some((name.to_owned(), provider.api_key.clone()));
        Ok(())
    }

    fn bind(&mut self, key: &str, provider: &str) -> Result<(), String> {
        let root = self
            .root
            .as_object_mut()
            .ok_or_else(|| "config must be a JSON object".to_string())?;
        root.insert(key.to_owned(), json!({"provider": provider}));
        Ok(())
    }

    fn save(&mut self) -> Result<(), String> {
        let mut validation_root = self.root.clone();
        if let Some((name, Some(api_key))) = &self.validation_provider {
            let providers = validation_root
                .get_mut("llm_providers")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "llm_providers must be a JSON object".to_string())?;
            let provider = providers
                .get_mut(name)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "merged provider is missing".to_string())?;
            provider.insert("api_key".into(), Value::String(api_key.clone()));
        }
        (self.validate)(&validation_root)?;

        let mut contents = serde_json::to_vec_pretty(&self.root)
            .map_err(|error| format!("failed to serialize merged config: {error}"))?;
        contents.push(b'\n');
        write_config_atomic(&self.path, &self.target, &self.original, &contents)
    }
}

pub async fn init_interactive(
    store: &mut dyn ProviderStore,
    bindings: &[FeatureBinding],
    product: &str,
) -> Result<(), String> {
    let mut prompter = StdioPrompter;
    let outcome = wizard::run(&mut prompter, &store.provider_names()).await?;
    store.insert_provider(
        &outcome.name,
        &outcome.provider,
        outcome.inline_key.as_deref(),
    )?;

    let mut bound = Vec::new();
    for binding in bindings {
        if store.has_inline_binding(binding.key) {
            eprintln!(
                "The existing inline {} configuration will be replaced if you bind this provider.",
                binding.key
            );
        }
        if prompter.yes_no(binding.question, true)? {
            store.bind(binding.key, &outcome.name)?;
            bound.push(binding);
        }
    }
    store.save()?;

    eprintln!();
    eprintln!(
        "Saved provider '{}' ({}, model {}).",
        outcome.name,
        outcome.provider.protocol.as_str(),
        outcome.provider.model
    );
    for binding in bound {
        let feature = binding
            .question
            .strip_prefix("Use this provider for ")
            .and_then(|label| label.strip_suffix('?'))
            .unwrap_or(binding.key);
        eprintln!("{feature} is configured to use '{}'.", outcome.name);
    }
    eprintln!("Restart the {product} to apply.");
    Ok(())
}

fn write_config_atomic(
    path: &Path,
    target: &Path,
    original: &[u8],
    contents: &[u8],
) -> Result<(), String> {
    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let current_target = fs::canonicalize(path).map_err(|_| {
        format!(
            "'{}' now points to a different file than when the wizard started; rerun the wizard",
            path.display()
        )
    })?;
    if current_target != target {
        return Err(format!(
            "'{}' now points to a different file than when the wizard started; rerun the wizard",
            path.display()
        ));
    }
    let current = fs::read(target)
        .map_err(|error| format!("failed to read '{}': {error}", path.display()))?;
    if current != original {
        return Err(format!(
            "'{}' changed while the wizard was running; rerun the wizard",
            path.display()
        ));
    }
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .ok_or_else(|| format!("invalid config path '{}'", path.display()))?
        .to_string_lossy();
    #[cfg(unix)]
    let target_metadata = fs::metadata(target)
        .map_err(|error| format!("failed to read metadata for '{}': {error}", path.display()))?;

    let mut temp = None;
    for _ in 0..128 {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let temp_path = parent.join(format!(".{name}.tmp-{}-{id}", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temp_path) {
            Ok(file) => {
                temp = Some((temp_path, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "failed to create temporary config for '{}': {error}",
                    path.display()
                ));
            }
        }
    }
    let Some((temp_path, mut file)) = temp else {
        return Err(format!(
            "failed to create temporary config for '{}': too many name collisions",
            path.display()
        ));
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let owner = (target_metadata.uid(), target_metadata.gid());
        let temp_owner = file.metadata().map(|metadata| (metadata.uid(), metadata.gid()));
        let result = temp_owner.and_then(|temp_owner| {
            if temp_owner == owner {
                Ok(())
            } else {
                std::os::unix::fs::fchown(&file, Some(owner.0), Some(owner.1))
            }
        });
        if let Err(error) = result {
            drop(file);
            let _ = fs::remove_file(&temp_path);
            return Err(format!(
                "failed to preserve owner {}:{} of '{}': {error}; run the wizard as the config owner or root",
                owner.0,
                owner.1,
                path.display()
            ));
        }
    }

    let result = file
        .write_all(contents)
        .and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| fs::rename(&temp_path, target));
    if let Err(error) = result {
        let cleanup_error = fs::remove_file(&temp_path).err();
        return Err(match cleanup_error {
            Some(cleanup_error) if cleanup_error.kind() != io::ErrorKind::NotFound => format!(
                "failed to save '{}': {error}; failed to remove temporary file '{}': {cleanup_error}",
                path.display(),
                temp_path.display()
            ),
            _ => format!("failed to save '{}': {error}", path.display()),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Protocol;

    fn provider() -> ProviderConfig {
        ProviderConfig {
            protocol: Protocol::ChatCompletions,
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-flash".into(),
            api_key: Some("wizard-test-key".into()),
            api_key_env: Some("DEEPSEEK_API_KEY".into()),
            timeout_secs: 20,
            path: None,
        }
    }

    fn open_store(
        path: &Path,
        validate: impl Fn(&Value) -> Result<(), String> + 'static,
    ) -> JsonProviderStore {
        JsonProviderStore::open(path, validate).unwrap()
    }

    #[test]
    fn json_store_merges_provider_bindings_and_saves_private_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub.json");
        fs::write(
            &path,
            r#"{"listen_addr":"127.0.0.1:8080","unrelated":{"kept":true},"agent_token_hash":"hash","users":[]}"#,
        )
        .unwrap();
        let mut store = open_store(&path, |root| {
            assert_eq!(root["llm_providers"]["deepseek"]["api_key"], "wizard-test-key");
            Ok(())
        });
        store
            .insert_provider("deepseek", &provider(), None)
            .unwrap();
        store.bind("prompt_review", "deepseek").unwrap();
        store.save().unwrap();

        let written_bytes = fs::read(&path).unwrap();
        let written: Value = serde_json::from_slice(&written_bytes).unwrap();
        assert!(written_bytes.ends_with(b"\n"));
        assert_eq!(written["unrelated"]["kept"], true);
        assert_eq!(written["prompt_review"], json!({"provider":"deepseek"}));
        assert_eq!(
            written["llm_providers"]["deepseek"]["api_key_env"],
            "DEEPSEEK_API_KEY"
        );
        assert!(written["llm_providers"]["deepseek"]
            .get("api_key")
            .is_none());
        assert_eq!(store.provider_names(), vec!["deepseek"]);
        assert!(!store.has_inline_binding("prompt_review"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn json_store_writes_inline_key_and_detects_inline_binding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub.json");
        fs::write(
            &path,
            r#"{"prompt_review":{"protocol":"chat_completions","base_url":"https://old.example","model":"old","api_key":"old"},"llm_providers":{},"agent_token_hash":"hash","users":[]}"#,
        )
        .unwrap();
        let mut store = open_store(&path, |_| Ok(()));
        assert!(store.has_inline_binding("prompt_review"));
        store
            .insert_provider("deepseek", &provider(), Some("inline-test-key"))
            .unwrap();
        store.save().unwrap();
        let written: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(
            written["llm_providers"]["deepseek"]["api_key"],
            "inline-test-key"
        );
    }

    #[test]
    fn failed_validation_leaves_original_config_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub.json");
        let original = br#"{"agent_token_hash":"hash","users":[]}"#;
        fs::write(&path, original).unwrap();
        let mut store = open_store(&path, |_| Err("invalid merged config".into()));
        store
            .insert_provider("deepseek", &provider(), None)
            .unwrap();
        assert_eq!(store.save().unwrap_err(), "invalid merged config");
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn json_store_reports_missing_config_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.json");
        let error = JsonProviderStore::open(&path, |_| Ok(()))
            .err()
            .unwrap();
        assert_eq!(error, format!("config not found: {}", path.display()));
    }

    #[test]
    fn reference_bindings_are_not_reported_as_inline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub.json");
        fs::write(
            &path,
            r#"{"prompt_review":{"provider":"deepseek"},"llm_providers":{},"agent_token_hash":"hash","users":[]}"#,
        )
        .unwrap();
        let store = open_store(&path, |_| Ok(()));
        assert!(!store.has_inline_binding("prompt_review"));
    }

    #[cfg(unix)]
    #[test]
    fn json_store_follows_symlink_and_keeps_target_private_without_temp_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let dir = tempfile::tempdir().unwrap();
        let target_dir = dir.path().join("target");
        let link_dir = dir.path().join("links");
        fs::create_dir(&target_dir).unwrap();
        fs::create_dir(&link_dir).unwrap();
        let target = target_dir.join("hub.json");
        let link = link_dir.join("hub.json");
        fs::write(
            &target,
            r#"{"agent_token_hash":"hash","users":[]}"#,
        )
        .unwrap();
        symlink(&target, &link).unwrap();
        let original_link_target = fs::read_link(&link).unwrap();

        let mut store = open_store(&link, |_| Ok(()));
        store
            .insert_provider("deepseek", &provider(), None)
            .unwrap();
        store.save().unwrap();

        let saved: Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        assert_eq!(
            saved["llm_providers"]["deepseek"]["model"],
            "deepseek-flash"
        );
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&link).unwrap(), original_link_target);
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read_dir(&target_dir).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&link_dir).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn json_store_rejects_repointed_symlink_without_modifying_targets() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let first_target = dir.path().join("first.json");
        let second_target = dir.path().join("second.json");
        let link = dir.path().join("hub.json");
        let first_original = br#"{"agent_token_hash":"first","users":[]}"#;
        let second_original = br#"{"agent_token_hash":"second","users":[]}"#;
        fs::write(&first_target, first_original).unwrap();
        fs::write(&second_target, second_original).unwrap();
        symlink(&first_target, &link).unwrap();

        let mut store = open_store(&link, |_| Ok(()));
        store
            .insert_provider("deepseek", &provider(), None)
            .unwrap();
        fs::remove_file(&link).unwrap();
        symlink(&second_target, &link).unwrap();

        assert_eq!(
            store.save().unwrap_err(),
            format!(
                "'{}' now points to a different file than when the wizard started; rerun the wizard",
                link.display()
            )
        );
        assert_eq!(fs::read(&first_target).unwrap(), first_original);
        assert_eq!(fs::read(&second_target).unwrap(), second_original);
    }

    #[test]
    fn json_store_rejects_concurrent_config_edit_without_overwriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub.json");
        let original = br#"{"agent_token_hash":"hash","users":[]}"#;
        let changed = br#"{"agent_token_hash":"changed","users":[]}"#;
        fs::write(&path, original).unwrap();

        let mut store = open_store(&path, |_| Ok(()));
        store
            .insert_provider("deepseek", &provider(), None)
            .unwrap();
        fs::write(&path, changed).unwrap();

        assert_eq!(
            store.save().unwrap_err(),
            format!(
                "'{}' changed while the wizard was running; rerun the wizard",
                path.display()
            )
        );
        assert_eq!(fs::read(&path).unwrap(), changed);
    }

    #[cfg(unix)]
    #[test]
    fn json_store_preserves_existing_config_owner() {
        use std::os::unix::fs::MetadataExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub.json");
        fs::write(&path, r#"{"agent_token_hash":"hash","users":[]}"#).unwrap();
        let original_metadata = fs::metadata(&path).unwrap();

        let mut store = open_store(&path, |_| Ok(()));
        store
            .insert_provider("deepseek", &provider(), None)
            .unwrap();
        store.save().unwrap();

        let saved_metadata = fs::metadata(&path).unwrap();
        assert_eq!(saved_metadata.uid(), original_metadata.uid());
        assert_eq!(saved_metadata.gid(), original_metadata.gid());
    }
}
