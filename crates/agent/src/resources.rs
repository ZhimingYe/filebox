use std::path::{Path, PathBuf};

use filebox_protocol::resources::{
    validate_collection_item_path, validate_collection_name, validate_pinned_path, CollectionConfig,
    RootConfig,
};

use crate::config_store::PersistedConfig;

pub struct ResourceManager {
    pub config: PersistedConfig,
    data_dir: PathBuf,
}

impl ResourceManager {
    pub fn new(data_dir: PathBuf) -> Self {
        let config = PersistedConfig::load_or_create(&data_dir);
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
        if desired_revision <= self.config.resource_revision {
            return Err(format!(
                "Stale revision {} (current {}); ignoring",
                desired_revision, self.config.resource_revision
            ));
        }

        // Expand shell-style home prefixes (`~`, `~/…`) against *this* agent's
        // home directory before validate/persist. Hub must not expand: the
        // home that matters is the machine the agent runs on, not the hub's.
        // Stored paths are always absolute so fs ops never see a bare `~`.
        let roots = expand_root_homes(roots);

        // Validate all roots. A root that was valid when configured may have
        // disappeared since then (for example, an unmounted network volume).
        // Keep recognizing that exact configured root so it cannot block a
        // later disable/delete/pin update, while still rejecting a newly
        // supplied invalid path.
        for root in &roots {
            validate_root(root, &self.config.roots)?;
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

    pub fn collections_revision(&self) -> u64 {
        self.config.collections_revision
    }

    pub fn collections(&self) -> &[CollectionConfig] {
        &self.config.collections
    }

    pub fn current_collections_state(&self) -> (u64, Vec<CollectionConfig>) {
        (
            self.config.collections_revision,
            self.config.collections.clone(),
        )
    }

    /// Validate and atomically apply a desired collections state.
    pub fn apply_collections_desired(
        &mut self,
        desired_revision: u64,
        collections: Vec<CollectionConfig>,
    ) -> Result<u64, String> {
        if desired_revision <= self.config.collections_revision {
            return Err(format!(
                "Stale collections revision {} (current {}); ignoring",
                desired_revision, self.config.collections_revision
            ));
        }

        for coll in &collections {
            validate_collection(&coll, &self.config.roots)?;
        }

        self.config.collections_revision = desired_revision;
        self.config.collections = collections;
        self.config.save(&self.data_dir);

        tracing::info!(
            "Applied collections: rev={}, {} collections",
            desired_revision,
            self.config.collections.len(),
        );

        Ok(desired_revision)
    }
}

/// Expand `~` / `~/…` (and `~\…` on Windows-style inputs) to an absolute path
/// using the given home directory. Non-tilde paths are returned unchanged.
/// If home is unknown, the original string is kept so validation can still
/// report a clear "cannot be resolved" error rather than inventing a path.
///
/// Important: this is **prefix** expansion (shell-style), not `Path::join`.
/// `Path::join("/home/u", "/docs")` replaces the base with `/docs`, so a
/// typed `~//docs` would incorrectly become `/docs` and escape `$HOME`.
/// We strip leading separators from the remainder and then join component-wise.
/// `~/../..` and similar escape attempts are left as-is so validation rejects them.
fn expand_home_path_with(value: &str, home: Option<PathBuf>) -> String {
    if value == "~" {
        return home
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|| value.to_string());
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        if let Some(home) = home {
            // `~//docs` / `~\\docs` must stay under home (shell keeps $HOME prefix).
            let rest = rest.trim_start_matches(['/', '\\']);
            if rest.is_empty() {
                return home.to_string_lossy().into_owned();
            }
            let joined = home.join(rest);
            // Reject `~/../..` escape attempts: the cleaned path must remain inside home.
            if !lexically_within(&home, &joined) {
                return value.to_string();
            }
            return joined.to_string_lossy().into_owned();
        }
    }
    value.to_string()
}

/// Lexically check whether `path` is the same as or under `base`, without
/// requiring the paths to exist. This catches `~/a/../../etc` while still
/// allowing `~/a/../b`.
fn lexically_within(base: &Path, path: &Path) -> bool {
    let mut stack: Vec<std::path::Component> = Vec::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                stack.pop();
            }
            std::path::Component::CurDir => {}
            _ => stack.push(comp),
        }
    }
    let base_comps: Vec<_> = base.components().collect();
    if base_comps.len() > stack.len() {
        return false;
    }
    base_comps.iter().zip(stack.iter()).all(|(a, b)| a == b)
}

fn expand_home_path(value: &str) -> String {
    expand_home_path_with(value, dirs::home_dir())
}

fn expand_root_homes(mut roots: Vec<RootConfig>) -> Vec<RootConfig> {
    for root in &mut roots {
        root.path = expand_home_path(&root.path);
    }
    roots
}

fn normalize_item_path(p: &str) -> String {
    let mut s = p.to_string();
    if !s.starts_with('/') {
        s = format!("/{s}");
    }
    if s.len() > 1 && s.ends_with('/') {
        s = s.trim_end_matches('/').to_string();
    }
    s
}

fn validate_collection(collection: &CollectionConfig, roots: &[RootConfig]) -> Result<(), String> {
    validate_collection_name(&collection.name)?;

    let mut seen = std::collections::HashSet::new();
    for item in &collection.items {
        validate_collection_item_path(&item.path)
            .map_err(|e| format!("Collection '{}': {}", collection.name, e))?;

        if item.root.is_empty() {
            return Err(format!(
                "Collection '{}': item root name cannot be empty",
                collection.name
            ));
        }

        if !roots.iter().any(|r| r.name == item.root) {
            return Err(format!(
                "Collection '{}': unknown root '{}'",
                collection.name, item.root
            ));
        }

        let key = (item.root.clone(), normalize_item_path(&item.path));
        if !seen.insert(key) {
            return Err(format!(
                "Collection '{}': duplicate item {}/{}",
                collection.name, item.root, item.path
            ));
        }
    }

    Ok(())
}

fn validate_root(root: &RootConfig, existing_roots: &[RootConfig]) -> Result<(), String> {
    if root.name.is_empty() {
        return Err("Root name cannot be empty".to_string());
    }
    if root.path.is_empty() {
        return Err(format!("Root '{}' path cannot be empty", root.name));
    }

    // Validate pinned-folder paths (shape only — no existence check, so a
    // deleted/unmounted folder never blocks a config apply).
    for pin in &root.pinned_folders {
        validate_pinned_path(pin).map_err(|e| format!("Root '{}': {}", root.name, e))?;
    }

    // Only an exact root already present in the last applied state gets the
    // stale-path exception. This is what lets a vanished root be disabled or
    // carried through while another root is edited, without turning typos in
    // newly added/changed paths into successful configuration updates.
    let existing_root = existing_roots
        .iter()
        .find(|existing| existing.name == root.name && existing.path == root.path);
    let path = Path::new(&root.path);
    let canonical = match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(e) => {
            if let Some(existing) = existing_root {
                if !existing.enabled && root.enabled {
                    return Err(format!(
                        "Root '{}' path '{}' cannot be enabled while unavailable: {}",
                        root.name, root.path, e
                    ));
                }
                tracing::warn!(
                    "Previously configured root '{}' path '{}' is unavailable: {} — preserving it so it can be disabled, deleted, or repaired",
                    root.name,
                    root.path,
                    e,
                );
                return Ok(());
            }
            return Err(format!(
                "Root '{}' path '{}' cannot be resolved: {}",
                root.name, root.path, e
            ));
        }
    };

    if !canonical.is_dir() {
        if let Some(existing) = existing_root {
            if !existing.enabled && root.enabled {
                return Err(format!(
                    "Root '{}' path '{}' cannot be enabled because it is no longer a directory",
                    root.name, root.path
                ));
            }
            tracing::warn!(
                "Previously configured root '{}' path '{}' is no longer a directory — preserving it so it can be disabled, deleted, or repaired",
                root.name,
                root.path,
            );
            return Ok(());
        }
        return Err(format!(
            "Root '{}' path '{}' is not a directory",
            root.name, root.path
        ));
    }

    if is_sensitive_virtual_root(&canonical) {
        return Err(format!(
            "Root '{}' path '{}' is a sensitive virtual filesystem",
            root.name, root.path
        ));
    }

    Ok(())
}

#[cfg(unix)]
fn is_sensitive_virtual_root(path: &Path) -> bool {
    ["/proc", "/sys", "/dev/fd", "/dev/mapper"]
        .iter()
        .map(Path::new)
        .any(|blocked| path == blocked || path.starts_with(blocked))
}

#[cfg(not(unix))]
fn is_sensitive_virtual_root(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_store::PersistedConfig;
    use filebox_protocol::resources::RootConfig;
    use std::fs;
    use tempfile::tempdir;

    fn manager_in_temp() -> ResourceManager {
        let dir = tempdir().unwrap();
        ResourceManager::new(dir.path().to_path_buf())
    }

    #[test]
    fn new_manager_generates_stable_agent_id() {
        let mgr = manager_in_temp();
        let id = mgr.agent_id();
        assert!(!id.is_empty());
        // UUID format check
        assert_eq!(id.len(), 36);
    }

    #[test]
    fn fresh_manager_has_zero_revision_and_no_roots() {
        let mgr = manager_in_temp();
        assert_eq!(mgr.resource_revision(), 0);
        assert!(mgr.roots().is_empty());
    }

    #[test]
    fn current_state_returns_clone_of_internal_state() {
        let mgr = manager_in_temp();
        let (rev, roots) = mgr.current_state();
        assert_eq!(rev, 0);
        assert!(roots.is_empty());
    }

    #[test]
    fn apply_desired_accepts_valid_directory_root() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());

        let real_root = tempdir().unwrap();
        let roots = vec![RootConfig {
            name: "data".to_string(),
            path: real_root.path().to_str().unwrap().to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];

        let new_rev = mgr.apply_desired(5, roots).unwrap();
        assert_eq!(new_rev, 5);
        assert_eq!(mgr.resource_revision(), 5);
        assert_eq!(mgr.roots().len(), 1);
        assert_eq!(mgr.roots()[0].name, "data");
    }

    #[test]
    fn apply_desired_rejects_empty_root_name() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());

        let real_root = tempdir().unwrap();
        let roots = vec![RootConfig {
            name: "".to_string(),
            path: real_root.path().to_str().unwrap().to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];

        let err = mgr.apply_desired(1, roots).unwrap_err();
        assert!(err.contains("name cannot be empty"));
        // State unchanged
        assert_eq!(mgr.resource_revision(), 0);
        assert!(mgr.roots().is_empty());
    }

    #[test]
    fn apply_desired_rejects_empty_path() {
        let mut mgr = manager_in_temp();
        let roots = vec![RootConfig {
            name: "empty".to_string(),
            path: "".to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];
        let err = mgr.apply_desired(1, roots).unwrap_err();
        assert!(err.contains("path cannot be empty"));
    }

    #[test]
    fn apply_desired_rejects_new_nonexistent_path() {
        let mut mgr = manager_in_temp();
        let roots = vec![RootConfig {
            name: "ghost".to_string(),
            path: "/this/path/definitely/does/not/exist/xyz".to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];
        let err = mgr.apply_desired(1, roots).unwrap_err();
        assert!(err.contains("cannot be resolved"));
        assert_eq!(mgr.resource_revision(), 0);
        assert!(mgr.roots().is_empty());
    }

    #[test]
    fn apply_desired_rejects_new_file_path_as_root() {
        let mut mgr = manager_in_temp();
        let file = tempfile::NamedTempFile::new().unwrap();
        let roots = vec![RootConfig {
            name: "file".to_string(),
            path: file.path().to_str().unwrap().to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];
        let err = mgr.apply_desired(1, roots).unwrap_err();
        assert!(err.contains("not a directory"));
        assert_eq!(mgr.resource_revision(), 0);
    }

    #[test]
    fn apply_desired_rejects_changing_existing_root_to_missing_path() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());
        let real_root = tempdir().unwrap();
        mgr.apply_desired(
            1,
            vec![RootConfig {
                name: "data".to_string(),
                path: real_root.path().to_str().unwrap().to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        )
        .unwrap();

        let err = mgr
            .apply_desired(
                2,
                vec![RootConfig {
                    name: "data".to_string(),
                    path: "/this/replacement/path/does/not/exist".to_string(),
                    enabled: true,
                    pinned_folders: vec![],
                }],
            )
            .unwrap_err();

        assert!(err.contains("cannot be resolved"));
        assert_eq!(mgr.resource_revision(), 1);
        assert_eq!(mgr.roots()[0].path, real_root.path().to_str().unwrap());
    }

    #[test]
    fn apply_desired_rejects_stale_revision() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());

        let real_root = tempdir().unwrap();
        let roots = vec![RootConfig {
            name: "data".to_string(),
            path: real_root.path().to_str().unwrap().to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];

        mgr.apply_desired(5, roots.clone()).unwrap();
        let err = mgr.apply_desired(5, roots.clone()).unwrap_err();
        assert!(err.contains("Stale revision 5"));
        let err = mgr.apply_desired(4, roots).unwrap_err();
        assert!(err.contains("Stale revision 4"));
        assert_eq!(mgr.resource_revision(), 5);
    }

    #[test]
    fn apply_desired_preserves_last_good_state_on_validation_failure() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());

        // First, successfully apply a known-good state
        let good_root = tempdir().unwrap();
        let good_roots = vec![RootConfig {
            name: "good".to_string(),
            path: good_root.path().to_str().unwrap().to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];
        mgr.apply_desired(3, good_roots).unwrap();
        assert_eq!(mgr.resource_revision(), 3);

        // Now attempt to apply invalid state
        let bad_roots = vec![RootConfig {
            name: "".to_string(),
            path: "/anything".to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];
        let result = mgr.apply_desired(99, bad_roots);
        assert!(result.is_err());

        // Last good state MUST be preserved
        assert_eq!(mgr.resource_revision(), 3, "revision must not change on failure");
        assert_eq!(mgr.roots().len(), 1);
        assert_eq!(mgr.roots()[0].name, "good");
    }

    #[test]
    fn apply_desired_validates_all_roots_before_applying_any() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());

        let good_root = tempdir().unwrap();
        // Mixed: one valid, one invalid (empty name)
        let mixed_roots = vec![
            RootConfig {
                name: "valid".to_string(),
                path: good_root.path().to_str().unwrap().to_string(),
                enabled: true,
                pinned_folders: vec![],
            },
            RootConfig {
                name: "".to_string(),
                path: "/anywhere".to_string(),
                enabled: true,
                pinned_folders: vec![],
            },
        ];

        let result = mgr.apply_desired(1, mixed_roots);
        assert!(result.is_err());
        // Nothing applied
        assert_eq!(mgr.resource_revision(), 0);
        assert!(mgr.roots().is_empty());
    }

    #[test]
    fn apply_desired_persists_state_across_manager_instances() {
        let dir = tempdir().unwrap();
        let data_path = dir.path().to_path_buf();

        let real_root = tempdir().unwrap();
        let roots = vec![RootConfig {
            name: "persisted".to_string(),
            path: real_root.path().to_str().unwrap().to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];

        // Apply in one manager
        let original_id = {
            let mut mgr = ResourceManager::new(data_path.clone());
            let id = mgr.agent_id().to_string();
            mgr.apply_desired(7, roots).unwrap();
            id
        };

        // New manager from same data_dir must reload
        let reloaded = ResourceManager::new(data_path);
        assert_eq!(reloaded.agent_id(), original_id, "agent_id must be stable");
        assert_eq!(reloaded.resource_revision(), 7);
        assert_eq!(reloaded.roots().len(), 1);
        assert_eq!(reloaded.roots()[0].name, "persisted");
    }

    #[test]
    fn apply_desired_replacing_roots_entirely() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());

        let r1 = tempdir().unwrap();
        let r2 = tempdir().unwrap();

        // Apply first set
        mgr.apply_desired(
            1,
            vec![RootConfig {
                name: "old".to_string(),
                path: r1.path().to_str().unwrap().to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        )
        .unwrap();

        // Replace entirely
        mgr.apply_desired(
            2,
            vec![RootConfig {
                name: "new".to_string(),
                path: r2.path().to_str().unwrap().to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        )
        .unwrap();

        assert_eq!(mgr.resource_revision(), 2);
        assert_eq!(mgr.roots().len(), 1);
        assert_eq!(mgr.roots()[0].name, "new");
    }

    #[test]
    fn apply_desired_clears_roots_with_empty_vec() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());

        // First add a root
        let r = tempdir().unwrap();
        mgr.apply_desired(
            1,
            vec![RootConfig {
                name: "temp".to_string(),
                path: r.path().to_str().unwrap().to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        )
        .unwrap();
        assert_eq!(mgr.roots().len(), 1);

        // Clear
        mgr.apply_desired(2, vec![]).unwrap();
        assert_eq!(mgr.resource_revision(), 2);
        assert!(mgr.roots().is_empty());
    }

    #[test]
    fn apply_desired_accepts_disabled_root() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());
        let real_root = tempdir().unwrap();

        let roots = vec![RootConfig {
            name: "off".to_string(),
            path: real_root.path().to_str().unwrap().to_string(),
            enabled: false,
            pinned_folders: vec![],
        }];

        mgr.apply_desired(1, roots).unwrap();
        assert!(!mgr.roots()[0].enabled);
    }

    #[test]
    fn apply_desired_rejects_reenabling_unavailable_root_until_path_recovers() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());
        let root_parent = tempdir().unwrap();
        let root_path = root_parent.path().join("root");
        std::fs::create_dir(&root_path).unwrap();
        let path = root_path.to_str().unwrap().to_string();

        mgr.apply_desired(
            1,
            vec![RootConfig {
                name: "data".to_string(),
                path: path.clone(),
                enabled: true,
                pinned_folders: vec![],
            }],
        )
        .unwrap();
        std::fs::remove_dir(&root_path).unwrap();

        mgr.apply_desired(
            2,
            vec![RootConfig {
                name: "data".to_string(),
                path: path.clone(),
                enabled: false,
                pinned_folders: vec![],
            }],
        )
        .unwrap();

        let err = mgr
            .apply_desired(
                3,
                vec![RootConfig {
                    name: "data".to_string(),
                    path: path.clone(),
                    enabled: true,
                    pinned_folders: vec![],
                }],
            )
            .unwrap_err();
        assert!(err.contains("cannot be enabled while unavailable"));
        assert_eq!(mgr.resource_revision(), 2);
        assert!(!mgr.roots()[0].enabled);

        std::fs::create_dir(&root_path).unwrap();
        mgr.apply_desired(
            3,
            vec![RootConfig {
                name: "data".to_string(),
                path,
                enabled: true,
                pinned_folders: vec![],
            }],
        )
        .unwrap();
        assert_eq!(mgr.resource_revision(), 3);
        assert!(mgr.roots()[0].enabled);
    }

    #[test]
    fn apply_desired_rejects_reenabling_root_that_became_a_file() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());
        let root_parent = tempdir().unwrap();
        let root_path = root_parent.path().join("root");
        std::fs::create_dir(&root_path).unwrap();
        let path = root_path.to_str().unwrap().to_string();

        mgr.apply_desired(
            1,
            vec![RootConfig {
                name: "data".to_string(),
                path: path.clone(),
                enabled: true,
                pinned_folders: vec![],
            }],
        )
        .unwrap();
        std::fs::remove_dir(&root_path).unwrap();
        std::fs::write(&root_path, b"not a directory").unwrap();

        mgr.apply_desired(
            2,
            vec![RootConfig {
                name: "data".to_string(),
                path: path.clone(),
                enabled: false,
                pinned_folders: vec![],
            }],
        )
        .unwrap();

        let err = mgr
            .apply_desired(
                3,
                vec![RootConfig {
                    name: "data".to_string(),
                    path,
                    enabled: true,
                    pinned_folders: vec![],
                }],
            )
            .unwrap_err();
        assert!(err.contains("cannot be enabled because it is no longer a directory"));
        assert_eq!(mgr.resource_revision(), 2);
        assert!(!mgr.roots()[0].enabled);
    }

    #[test]
    fn can_modify_roots_when_another_root_path_is_missing() {
        // A root that was valid when applied but later disappeared must not
        // block modifications to other roots.
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());

        let good_root = tempdir().unwrap();
        let disappearing_root = tempdir().unwrap();
        let disappearing_path = disappearing_root.path().to_str().unwrap().to_string();

        // Establish a fully valid last-applied state first.
        mgr.apply_desired(
            1,
            vec![
                RootConfig {
                    name: "good".to_string(),
                    path: good_root.path().to_str().unwrap().to_string(),
                    enabled: true,
                    pinned_folders: vec!["/sub".to_string()],
                },
                RootConfig {
                    name: "ghost".to_string(),
                    path: disappearing_path.clone(),
                    enabled: true,
                    pinned_folders: vec![],
                },
            ],
        )
        .unwrap();
        disappearing_root.close().unwrap();

        // Unpin from the good root while the other root is missing.
        mgr.apply_desired(
            2,
            vec![
                RootConfig {
                    name: "good".to_string(),
                    path: good_root.path().to_str().unwrap().to_string(),
                    enabled: true,
                    pinned_folders: vec![], // pin removed
                },
                RootConfig {
                    name: "ghost".to_string(),
                    path: disappearing_path.clone(),
                    enabled: true,
                    pinned_folders: vec![],
                },
            ],
        )
        .unwrap();
        assert!(mgr.roots().iter().find(|r| r.name == "good").unwrap().pinned_folders.is_empty());

        // Now disable the ghost root (still missing path). Must succeed.
        mgr.apply_desired(
            3,
            vec![RootConfig {
                name: "ghost".to_string(),
                path: disappearing_path,
                enabled: false, // disabled
                pinned_folders: vec![],
            }],
        )
        .unwrap();
        assert!(!mgr.roots()[0].enabled);

        // Deleting the unavailable root must remain possible.
        mgr.apply_desired(4, vec![]).unwrap();
        assert!(mgr.roots().is_empty());
    }

    #[test]
    fn validate_root_hard_rejects_sensitive_virtual_root() {
        // The sensitive-virtual-root check (/proc, /sys, …) stays a hard reject.
        // Guarded by target_os because these virtual filesystems only exist on
        // Linux.
        #[cfg(target_os = "linux")]
        {
            let root = RootConfig {
                name: "proc".to_string(),
                path: "/proc".to_string(),
                enabled: true,
                pinned_folders: vec![],
            };
            let err = validate_root(&root, &[]).unwrap_err();
            assert!(err.contains("sensitive virtual filesystem"));
        }
        // On non-Linux, verify the is_sensitive_virtual_root function directly
        // (already covered by sensitive_virtual_root_detection_rejects_nested_paths).
    }

    #[test]
    #[cfg(unix)]
    fn validate_root_rejects_new_symlink_to_file() {
        let real_file = tempfile::NamedTempFile::new().unwrap();
        let dir = tempdir().unwrap();
        let link_path = dir.path().join("link_to_file");
        std::os::unix::fs::symlink(real_file.path(), &link_path).unwrap();

        let root = RootConfig {
            name: "link".to_string(),
            path: link_path.to_str().unwrap().to_string(),
            enabled: true,
            pinned_folders: vec![],
        };
        let err = validate_root(&root, &[]).unwrap_err();
        assert!(err.contains("not a directory"));
    }

    #[test]
    fn validate_root_rejects_bad_pinned_folder_path() {
        let real_root = tempdir().unwrap();
        let root = RootConfig {
            name: "data".to_string(),
            path: real_root.path().to_str().unwrap().to_string(),
            enabled: true,
            // Leading slash so the check reaches the `..` component rule
            pinned_folders: vec!["/ok".to_string(), "/../escape".to_string()],
        };
        let err = validate_root(&root, &[]).unwrap_err();
        assert!(err.contains("must not contain '..'"), "got: {err}");
    }

    #[test]
    fn apply_desired_accepts_valid_pinned_folders_and_persists_them() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());
        let real_root = tempdir().unwrap();

        let roots = vec![RootConfig {
            name: "data".to_string(),
            path: real_root.path().to_str().unwrap().to_string(),
            enabled: true,
            pinned_folders: vec!["/".to_string(), "/reports".to_string()],
        }];
        mgr.apply_desired(1, roots).unwrap();
        assert_eq!(mgr.roots()[0].pinned_folders.len(), 2);
    }

    #[test]
    fn apply_desired_preserves_state_when_pinned_folder_invalid() {
        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());

        // Establish good state
        let good_root = tempdir().unwrap();
        mgr.apply_desired(
            1,
            vec![RootConfig {
                name: "good".to_string(),
                path: good_root.path().to_str().unwrap().to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        )
        .unwrap();

        // Bad pin shape — must reject and preserve last-good state
        let err = mgr
            .apply_desired(
                2,
                vec![RootConfig {
                    name: "good".to_string(),
                    path: good_root.path().to_str().unwrap().to_string(),
                    enabled: true,
                    pinned_folders: vec!["/../escape".to_string()],
                }],
            )
            .unwrap_err();
        assert!(err.contains("must not contain '..'"));
        assert_eq!(mgr.resource_revision(), 1, "revision must not advance on failure");
        assert!(mgr.roots()[0].pinned_folders.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn sensitive_virtual_root_detection_rejects_nested_paths() {
        assert!(is_sensitive_virtual_root(Path::new("/proc")));
        assert!(is_sensitive_virtual_root(Path::new("/proc/self")));
        assert!(is_sensitive_virtual_root(Path::new("/sys/kernel")));
        assert!(is_sensitive_virtual_root(Path::new("/dev/fd")));
        assert!(!is_sensitive_virtual_root(Path::new("/var/log")));
    }

    #[test]
    fn persist_config_round_trip_via_manager() {
        // Smoke test the persisted JSON shape is stable
        let dir = tempdir().unwrap();
        let cfg = PersistedConfig::new("agent-shape".to_string());
        cfg.save(&dir.path().to_path_buf());

        let text = fs::read_to_string(dir.path().join("agent_state.json")).unwrap();
        assert!(text.contains("\"agent_id\": \"agent-shape\""));
        assert!(text.contains("\"resource_revision\": 0"));
        assert!(text.contains("\"roots\": []"));
    }

    #[test]
    fn expand_home_path_expands_tilde_forms() {
        let home = PathBuf::from("/home/alice");
        assert_eq!(
            expand_home_path_with("~", Some(home.clone())),
            "/home/alice"
        );
        assert_eq!(
            expand_home_path_with("~/docs", Some(home.clone())),
            "/home/alice/docs"
        );
        assert_eq!(
            expand_home_path_with("~\\docs", Some(home.clone())),
            "/home/alice/docs"
        );
        // Double-slash after ~ must NOT Path::join-replace away from home.
        assert_eq!(
            expand_home_path_with("~//docs", Some(home.clone())),
            "/home/alice/docs"
        );
        assert_eq!(
            expand_home_path_with("~\\\\docs", Some(home.clone())),
            "/home/alice/docs"
        );
        // Bare ~/ with only separators → home itself.
        assert_eq!(
            expand_home_path_with("~/", Some(home.clone())),
            "/home/alice"
        );
        // Non-tilde (and ~user, which we do not expand) stays literal.
        assert_eq!(
            expand_home_path_with("/abs/path", Some(home.clone())),
            "/abs/path"
        );
        assert_eq!(
            expand_home_path_with("~alice/docs", Some(home.clone())),
            "~alice/docs"
        );
        // Missing home: leave tilde as-is so canonicalize can fail clearly.
        assert_eq!(expand_home_path_with("~/docs", None), "~/docs");
        assert_eq!(expand_home_path_with("~", None), "~");
        // Escape attempts must be left as-is so validate_root rejects them.
        assert_eq!(
            expand_home_path_with("~/../../etc", Some(home.clone())),
            "~/../../etc"
        );
        assert_eq!(
            expand_home_path_with("~/a/../../etc", Some(home.clone())),
            "~/a/../../etc"
        );
        // A non-escaping `..` inside the home is fine.
        assert_eq!(
            expand_home_path_with("~/a/../b", Some(home.clone())),
            "/home/alice/a/../b"
        );
    }

    #[test]
    fn lexically_within_detects_home_escape_attempts() {
        let home = PathBuf::from("/home/alice");
        assert!(lexically_within(&home, Path::new("/home/alice")));
        assert!(lexically_within(&home, Path::new("/home/alice/docs")));
        assert!(lexically_within(&home, Path::new("/home/alice/a/../b")));
        assert!(!lexically_within(&home, Path::new("/home/alice/a/../../etc")));
        assert!(!lexically_within(&home, Path::new("/etc")));
    }

    #[test]
    fn apply_desired_expands_tilde_root_path_and_persists_absolute() {
        let home = tempdir().unwrap();
        let docs = home.path().join("docs");
        fs::create_dir(&docs).unwrap();

        // Point the process home at our temp dir so dirs::home_dir() resolves
        // there. Restore afterwards so other tests aren't affected.
        let prev_home = std::env::var_os("HOME");
        // SAFETY: single-threaded cargo test default; we restore below.
        std::env::set_var("HOME", home.path());

        let dir = tempdir().unwrap();
        let mut mgr = ResourceManager::new(dir.path().to_path_buf());
        let result = mgr.apply_desired(
            1,
            vec![RootConfig {
                name: "docs".to_string(),
                path: "~/docs".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        );

        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }

        result.expect("tilde path should expand and apply");
        let stored = &mgr.roots()[0].path;
        assert!(
            !stored.starts_with('~'),
            "persisted path must be absolute, got {stored}"
        );
        assert_eq!(
            Path::new(stored).canonicalize().unwrap(),
            docs.canonicalize().unwrap()
        );
    }
}
