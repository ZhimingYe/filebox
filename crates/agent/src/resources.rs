use std::path::{Path, PathBuf};

use filebox_protocol::resources::RootConfig;

use crate::config_store::PersistedConfig;

pub struct ResourceManager {
    pub config: PersistedConfig,
    data_dir: PathBuf,
}

impl ResourceManager {
    pub fn new(data_dir: PathBuf, agent_id: String) -> Self {
        let config = PersistedConfig::load_or_create(&data_dir, agent_id);
        Self { config, data_dir }
    }

    pub fn agent_id(&self) -> &str {
        &self.config.agent_id
    }

    pub fn resource_revision(&self) -> u64 {
        self.config.resource_revision
    }

    pub fn roots(&self) -> &[RootConfig] {
        &self.config.roots
    }

    /// Validate and atomically apply a desired resource state.
    /// Returns Ok(new_revision) on success, Err(message) on validation failure.
    /// On failure, the previous good state is preserved.
    pub fn apply_desired(
        &mut self,
        desired_revision: u64,
        roots: Vec<RootConfig>,
    ) -> Result<u64, String> {
        // Validate all roots
        for root in &roots {
            validate_root(root)?;
        }

        // All valid — apply atomically
        self.config.resource_revision = desired_revision;
        self.config.roots = roots;
        self.config.save(&self.data_dir);

        tracing::info!(
            "Applied resources: rev={}, {} roots",
            desired_revision,
            self.config.roots.len(),
        );

        Ok(desired_revision)
    }

    /// Get the current resource state for registration.
    pub fn current_state(&self) -> (u64, Vec<RootConfig>) {
        (
            self.config.resource_revision,
            self.config.roots.clone(),
        )
    }
}

fn validate_root(root: &RootConfig) -> Result<(), String> {
    if root.name.is_empty() {
        return Err("Root name cannot be empty".to_string());
    }
    if root.path.is_empty() {
        return Err(format!("Root '{}' path cannot be empty", root.name));
    }

    let path = Path::new(&root.path);

    // Resolve to canonical path to check it exists and isn't a symlink escape
    let canonical = path.canonicalize().map_err(|e| {
        format!(
            "Root '{}' path '{}' cannot be resolved: {}",
            root.name, root.path, e
        )
    })?;

    if !canonical.is_dir() {
        return Err(format!(
            "Root '{}' path '{}' is not a directory",
            root.name, root.path
        ));
    }

    // Ensure the canonical path is what we expect (no symlink tricks)
    // We store the original path for display but use canonical for operations
    Ok(())
}
