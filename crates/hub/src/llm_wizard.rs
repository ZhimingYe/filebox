use std::path::Path;

use filebox_llm::wizard::{self, Prompter, WizardOutcome};
use serde_json::{json, Value};

struct StdioPrompter;

impl Prompter for StdioPrompter {
    fn line(&mut self, label: &str, default: Option<&str>) -> Result<String, String> {
        filebox_updater::prompt_line(label, default)
    }

    fn secret(&mut self, label: &str) -> Result<String, String> {
        filebox_updater::prompt_nonempty_secret(label)
    }

    fn yes_no(&mut self, label: &str, default: bool) -> Result<bool, String> {
        filebox_updater::prompt_yes_no(label, default)
    }

    fn choose(&mut self, label: &str, options: &[String]) -> Result<usize, String> {
        eprintln!("{label}:");
        for (index, option) in options.iter().enumerate() {
            eprintln!("  {}. {option}", index + 1);
        }
        loop {
            let choice = filebox_updater::prompt_line("Choice", Some("1"))?;
            match choice.parse::<usize>() {
                Ok(choice) if (1..=options.len()).contains(&choice) => return Ok(choice - 1),
                _ => eprintln!("Choose a number from 1 to {}.", options.len()),
            }
        }
    }
}

pub async fn init_interactive(request: filebox_updater::ConfigInitRequest) -> Result<(), String> {
    let path = request
        .output
        .unwrap_or_else(crate::config::resolve_config_path);
    if !path.is_file() {
        return Err(format!(
            "Hub config not found: {}; run `hub --init-config` first",
            path.display()
        ));
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| format!("failed to read '{}': {error}", path.display()))?;
    let root: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse '{}': {error}", path.display()))?;
    let existing_names = root
        .get("llm_providers")
        .and_then(Value::as_object)
        .map(|providers| providers.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();

    let outcome = wizard::run(&mut StdioPrompter, &existing_names).await?;
    let existing_inline_review = root
        .get("prompt_review")
        .is_some_and(|review| review.get("provider").is_none());
    if existing_inline_review {
        eprintln!("The existing inline prompt_review configuration will be replaced if you bind this provider.");
    }
    let bind_review =
        filebox_updater::prompt_yes_no("Use this provider for AI Agents prompt review?", true)?;
    let merged = merge_config_value(
        root,
        &outcome,
        bind_review,
    )?;
    write_config(&path, &merged)?;

    eprintln!();
    eprintln!(
        "Saved provider '{}' ({}, model {}).",
        outcome.name,
        outcome.provider.protocol.as_str(),
        outcome.provider.model
    );
    if bind_review {
        eprintln!("AI Agents prompt review is configured to use '{}'.", outcome.name);
    }
    eprintln!("Restart the Hub to apply.");
    Ok(())
}

fn merge_config_value(
    mut root: Value,
    outcome: &WizardOutcome,
    bind_review: bool,
) -> Result<Value, String> {
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| "Hub config must be a JSON object".to_string())?;
    let providers = root_object
        .entry("llm_providers")
        .or_insert_with(|| json!({}));
    let providers = providers
        .as_object_mut()
        .ok_or_else(|| "llm_providers must be a JSON object".to_string())?;
    let mut provider_value = serde_json::to_value(&outcome.provider)
        .map_err(|error| format!("failed to serialize provider: {error}"))?;
    if let Some(key) = &outcome.inline_key {
        provider_value["api_key"] = Value::String(key.clone());
    }
    providers.insert(outcome.name.clone(), provider_value);
    if bind_review {
        root_object.insert(
            "prompt_review".into(),
            json!({"provider": outcome.name}),
        );
    }

    let mut validation_root = root.clone();
    let validation_provider = validation_root["llm_providers"]
        .get_mut(&outcome.name)
        .ok_or_else(|| "merged provider is missing".to_string())?;
    if let Some(key) = &outcome.provider.api_key {
        validation_provider["api_key"] = Value::String(key.clone());
    }
    let mut config: crate::config::HubConfig = serde_json::from_value(validation_root)
        .map_err(|_| "merged config has invalid Hub configuration fields".to_string())?;
    config.prompt_review_mode = crate::prompt_review::ReviewMode::Mandatory;
    config.resolve_prompt_review()?;
    Ok(root)
}

fn write_config(path: &Path, root: &Value) -> Result<(), String> {
    let mut contents = serde_json::to_string_pretty(root)
        .map_err(|error| format!("failed to serialize merged Hub config: {error}"))?;
    contents.push('\n');
    filebox_updater::write_private_file(path, contents.as_bytes(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use filebox_llm::{Protocol, ProviderConfig};
    use std::collections::BTreeMap;

    fn outcome(inline_key: Option<String>) -> WizardOutcome {
        WizardOutcome {
            name: "deepseek".into(),
            provider: ProviderConfig {
                protocol: Protocol::ChatCompletions,
                base_url: "https://api.deepseek.com".into(),
                model: "deepseek-flash".into(),
                api_key: Some("wizard-test-key".into()),
                api_key_env: inline_key
                    .is_none()
                    .then(|| "DEEPSEEK_API_KEY".into()),
                timeout_secs: 20,
                path: None,
            },
            inline_key,
            probe: filebox_llm::wizard::ProbeReport {
                chat: Ok(()),
                json: Ok(()),
                tools: Ok(()),
            },
        }
    }

    #[test]
    fn merge_preserves_unrelated_fields_binds_provider_and_writes_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub.json");
        let source = json!({
            "listen_addr": "127.0.0.1:8080",
            "agent_token_hash": "hash",
            "users": [{"username":"admin","password_hash":"hash"}],
            "unrelated": {"kept": true}
        });
        let merged = merge_config_value(source, &outcome(Some("inline-test-key".into())), true)
            .unwrap();
        write_config(&path, &merged).unwrap();

        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["unrelated"]["kept"], true);
        assert_eq!(written["prompt_review"], json!({"provider":"deepseek"}));
        assert_eq!(
            written["llm_providers"]["deepseek"]["api_key"],
            "inline-test-key"
        );
        let parsed: crate::config::HubConfig = serde_json::from_value(written).unwrap();
        assert!(matches!(
            parsed.prompt_review,
            Some(crate::config::PromptReviewConfig::Provider(_))
        ));

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
    fn env_storage_does_not_persist_the_testing_key() {
        let source = json!({
            "agent_token_hash": "hash",
            "users": [],
            "llm_providers": {}
        });
        let merged = merge_config_value(source, &outcome(None), true).unwrap();
        assert!(merged["llm_providers"]["deepseek"].get("api_key").is_none());
        assert_eq!(
            merged["llm_providers"]["deepseek"]["api_key_env"],
            "DEEPSEEK_API_KEY"
        );
    }

    #[test]
    fn merge_preserves_existing_inline_review_when_binding_is_declined() {
        let mut source = json!({
            "agent_token_hash": "hash",
            "users": [],
            "prompt_review": {
                "protocol": "chat_completions",
                "base_url": "https://api.deepseek.com",
                "model": "old-model",
                "api_key": "old-key"
            },
            "llm_providers": BTreeMap::<String, Value>::new()
        });
        let expected_review = source["prompt_review"].clone();
        let merged = merge_config_value(source.take(), &outcome(None), false).unwrap();
        assert_eq!(merged["prompt_review"], expected_review);
    }
}
