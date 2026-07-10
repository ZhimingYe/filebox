use std::path::{Path, PathBuf};

use filebox_protocol::resources::{validate_pinned_path, RootConfig};

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
    let was_already_configured = existing_roots
        .iter()
        .any(|existing| existing.name == root.name && existing.path == root.path);
    let path = Path::new(&root.path);
    let canonical = match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(e) if was_already_configured => {
            tracing::warn!(
                "Previously configured root '{}' path '{}' is unavailable: {} — preserving it so it can be disabled, deleted, or repaired",
                root.name,
                root.path,
                e,
            );
            return Ok(());
        }
        Err(e) => {
            return Err(format!(
                "Root '{}' path '{}' cannot be resolved: {}",
                root.name, root.path, e
            ));
        }
    };

    if !canonical.is_dir() {
        if was_already_configured {
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
}
