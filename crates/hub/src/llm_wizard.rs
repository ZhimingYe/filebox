use filebox_llm::cli::{FeatureBinding, JsonProviderStore};
use filebox_updater::ConfigInitRequest;
use serde_json::Value;

pub async fn init_interactive(request: ConfigInitRequest) -> Result<(), String> {
    let path = request
        .output
        .unwrap_or_else(crate::config::resolve_config_path);
    let mut store = JsonProviderStore::open(&path, validate_hub_config).map_err(|error| {
        if error == format!("config not found: {}", path.display()) {
            format!(
                "Hub config not found: {}; run `hub --init-config` first",
                path.display()
            )
        } else {
            error
        }
    })?;
    filebox_llm::cli::init_interactive(
        &mut store,
        &[FeatureBinding {
            key: "prompt_review",
            question: "Use this provider for AI Agents prompt review?",
        }],
        "Hub",
    )
    .await
}

fn validate_hub_config(root: &Value) -> Result<(), String> {
    let mut config: crate::config::HubConfig = serde_json::from_value(root.clone())
        .map_err(|_| "merged config has invalid Hub configuration fields".to_string())?;
    config.prompt_review_mode = crate::prompt_review::ReviewMode::Mandatory;
    config.resolve_prompt_review()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hub_validator_rejects_unknown_provider_and_accepts_a_valid_merge() {
        let unknown = json!({
            "agent_token_hash": "hash",
            "users": [],
            "llm_providers": {},
            "prompt_review": {"provider": "missing"}
        });
        assert!(validate_hub_config(&unknown)
            .unwrap_err()
            .contains("unknown"));

        let valid = json!({
            "agent_token_hash": "hash",
            "users": [],
            "llm_providers": {
                "deepseek": {
                    "protocol": "chat_completions",
                    "base_url": "https://api.deepseek.com",
                    "model": "deepseek-flash",
                    "api_key": "validator-test-key",
                    "timeout_secs": 20
                }
            },
            "prompt_review": {"provider": "deepseek"}
        });
        assert!(validate_hub_config(&valid).is_ok());
    }
}
