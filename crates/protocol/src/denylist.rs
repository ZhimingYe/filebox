use std::path::Path;

const DENIED_EXTENSIONS: &[&str] = &[
    ".env", ".pem", ".key", ".crt", ".p12", ".pfx", ".jks",
    ".sqlite", ".sqlite3", ".db", ".keychain",
];

const DENIED_EXACT: &[&str] = &[
    ".DS_Store",
    ".bashrc", ".bash_profile", ".bash_login", ".profile",
    ".zshrc", ".zprofile", ".zlogin", ".zshenv",
    ".fishrc", ".cshrc", ".tcshrc", ".kshrc",
    ".bash_history", ".zsh_history", ".python_history",
    ".mysql_history", ".psql_history", ".sqlite_history",
    ".node_repl_history", ".lesshst", ".wget-hsts",
    ".netrc", ".git-credentials", ".gitconfig",
    ".npmrc", ".yarnrc", ".pnpmrc", ".pypirc",
    ".Renviron", ".Rprofile",
    ".envrc", ".condarc", ".vault-token",
    "known_hosts", "authorized_keys",
    "credentials", "credentials.json", "token.json", "secrets.json",
    "kubeconfig",
];

/// Specific files inside directories that are otherwise allowed
const DENIED_IN_DIR: &[(&str, &str)] = &[
    (".cargo", "credentials"),
    (".cargo", "credentials.toml"),
    (".gradle", "gradle.properties"),
    (".maven", "settings.xml"),
    (".config/rclone", "rclone.conf"),
];

const DENIED_PREFIXES: &[&str] = &[
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
    "service-account", "firebase",
];

const DENIED_DIRS: &[&str] = &[
    ".git", ".svn", ".hg",
    ".ssh", ".gnupg",
    ".aws", ".azure", ".gcloud", ".kube", ".docker",
    ".direnv",
    ".jupyter",
    ".ipython",
    ".password-store",
];

pub fn is_denied(relative_path: &str) -> bool {
    // Lowercase the path for case-insensitive matching. Case-insensitive
    // filesystems (macOS, Windows) treat .AWS/credentials the same as
    // .aws/credentials, so the denylist must too. Original case is not
    // needed for matching decisions.
    let relative_path: String = relative_path.to_lowercase();
    let path = Path::new(&relative_path);

    // Check each component of the path
    let mut prev_name: Option<String> = None;
    for component in path.components() {
        let name = match component {
            std::path::Component::Normal(n) => n.to_string_lossy().to_string(),
            _ => { prev_name = None; continue; }
        };

        // Check denied directories
        if DENIED_DIRS.contains(&name.as_str()) {
            return true;
        }

        // Check exact matches
        if DENIED_EXACT.contains(&name.as_str()) {
            return true;
        }

        // Check denied extensions
        for ext in DENIED_EXTENSIONS {
            if name.ends_with(ext) {
                return true;
            }
        }

        // Check denied prefixes
        for prefix in DENIED_PREFIXES {
            if name.starts_with(prefix) {
                return true;
            }
        }

        // Check .env.* pattern
        if name.starts_with(".env.") {
            return true;
        }

        // Check *.env pattern
        if name.ends_with(".env") {
            return true;
        }

        // Check *.local pattern
        if name.ends_with(".local") {
            return true;
        }

        // Check .config/fish/config.fish
        if name == "config.fish" && prev_name.as_deref() == Some("fish") {
            // Check if two components back is .config by looking at the path prefix
            if relative_path.starts_with(".config/fish/") || relative_path.contains("/.config/fish/") {
                return true;
            }
        }

        // Check .ipython/profile_default/security/
        if name == "security" && prev_name.as_deref() == Some("profile_default") {
            if relative_path.starts_with(".ipython/") || relative_path.contains("/.ipython/") {
                return true;
            }
        }

        // Check .config/gcloud/
        if name == "gcloud" && prev_name.as_deref() == Some(".config") {
            return true;
        }

        prev_name = Some(name.clone());
    }

    // Check denied files inside specific directories
    for (dir, file) in DENIED_IN_DIR {
        // Match dir as a whole path component
        if relative_path == *dir || relative_path.starts_with(&format!("{}/", dir)) {
            if let Some(rest) = relative_path.strip_prefix(dir) {
                let rest = rest.strip_prefix('/').unwrap_or(rest);
                if rest == *file || rest.starts_with(&format!("{}/", file)) {
                    return true;
                }
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_denied_paths() {
        assert!(is_denied(".git/config"));
        assert!(is_denied(".ssh/id_rsa"));
        assert!(is_denied(".env"));
        assert!(is_denied(".env.local"));
        assert!(is_denied("some/.env.production"));
        assert!(is_denied("secret.pem"));
        assert!(is_denied("server.key"));
        assert!(is_denied(".bashrc"));
        assert!(is_denied(".aws/credentials"));
        assert!(is_denied("data.sqlite"));
        // New entries
        assert!(is_denied(".envrc"));
        assert!(is_denied(".condarc"));
        assert!(is_denied(".config/gcloud/application_default_credentials.json"));
        assert!(is_denied(".cargo/credentials"));
        assert!(is_denied(".cargo/credentials.toml"));
        assert!(is_denied(".gradle/gradle.properties"));
        assert!(is_denied(".maven/settings.xml"));
        // New entries
        assert!(is_denied(".password-store/gpg-key.gpg"));
        assert!(is_denied(".vault-token"));
        assert!(is_denied(".config/rclone/rclone.conf"));
        assert!(is_denied("server.jks"));
        assert!(is_denied("kubeconfig"));
        // Allowed paths
        assert!(!is_denied("src/main.rs"));
        assert!(!is_denied("README.md"));
        assert!(!is_denied("Cargo.toml"));
        assert!(!is_denied(".cargo/config.toml"));
        assert!(!is_denied(".gradle/wrapper/gradle-wrapper.jar"));
        assert!(!is_denied(".maven/repository/some/lib.jar"));
        assert!(!is_denied(".config/gh/hosts.yml"));
        assert!(!is_denied(".cargo-bad/config.toml"));
        assert!(!is_denied("my.cargo/config.toml"));
        // Case-insensitive matching (macOS/Windows filesystems treat these the same)
        assert!(is_denied(".GIT/config"));
        assert!(is_denied(".SSH/id_rsa"));
        assert!(is_denied(".ENV"));
        assert!(is_denied("SECRET.PEM"));
        assert!(is_denied("ID_RSA"));
        assert!(is_denied(".AWS/credentials"));
        assert!(is_denied(".Config/GCloud/application_default_credentials.json"));
        assert!(is_denied("Data.SQLITE"));
        // HTML files of any case are NOT denied (preview feature must work)
        assert!(!is_denied("index.html"));
        assert!(!is_denied("INDEX.HTML"));
        assert!(!is_denied("Page.Html"));
        assert!(!is_denied(".hidden-page.html"));
    }

    #[test]
    fn empty_path_is_allowed() {
        // No path means no sensitive segment to match.
        assert!(!is_denied(""));
    }

    #[test]
    fn plain_filename_without_extension_is_allowed() {
        assert!(!is_denied("notes"));
        assert!(!is_denied("README"));
    }

    #[test]
    fn dotfiles_outside_denylist_are_allowed() {
        // .gitignore and .editorconfig are not in the denylist
        assert!(!is_denied(".gitignore"));
        assert!(!is_denied(".editorconfig"));
        assert!(!is_denied(".dockerignore"));
    }

    #[test]
    fn denied_directories_match_as_path_component_only() {
        // `.git` as a leading dir is denied
        assert!(is_denied(".git/refs/heads/main"));
        // But `my.git/notes` should NOT match the `.git` directory rule
        // because `.git` is a complete path component, not a substring.
        // Note: the actual rule matches any path component named `.git`,
        // so `my.git` is a different component and should be allowed.
        assert!(!is_denied("my.git/notes"));
    }

    #[test]
    fn env_files_in_nested_dirs_are_denied() {
        assert!(is_denied("apps/api/.env"));
        assert!(is_denied("config/.env.local"));
        assert!(is_denied("deploy/prod/.env.production"));
    }

    #[test]
    fn id_rsa_prefix_matches_variants() {
        assert!(is_denied("id_rsa"));
        assert!(is_denied("id_rsa.pub"));
        assert!(is_denied("id_ed25519"));
        assert!(is_denied("id_ecdsa"));
        // The plain filename "id" is not denied
        assert!(!is_denied("id"));
    }

    #[test]
    fn service_account_json_files_are_denied() {
        assert!(is_denied("service-account.json"));
        assert!(is_denied("service-account-prod.json"));
        assert!(is_denied("firebase-adminsdk.json"));
    }

    #[test]
    fn credential_filenames_are_denied() {
        assert!(is_denied("credentials"));
        assert!(is_denied("credentials.json"));
        assert!(is_denied("token.json"));
        assert!(is_denied("secrets.json"));
    }

    #[test]
    fn database_files_are_denied() {
        assert!(is_denied("app.sqlite"));
        assert!(is_denied("app.sqlite3"));
        assert!(is_denied("app.db"));
        assert!(is_denied("backup.db"));
    }

    #[test]
    fn windows_style_paths_are_handled() {
        // Backslashes are not path separators in this implementation —
        // the file is matched as a single component. This documents behavior:
        // agent-side path resolution normalizes separators before calling is_denied.
        // A `.env` segment anywhere in a slash-separated path is caught.
        assert!(is_denied("project/.env"));
    }

    #[test]
    fn fish_config_in_correct_path_is_denied() {
        assert!(is_denied(".config/fish/config.fish"));
        assert!(is_denied("home/user/.config/fish/config.fish"));
        // config.fish outside .config/fish should be allowed
        assert!(!is_denied("docs/config.fish"));
    }

    #[test]
    fn ipython_security_dir_is_denied() {
        assert!(is_denied(".ipython/profile_default/security/foo"));
        assert!(is_denied("home/u/.ipython/profile_default/security/ca.crt"));
    }

    #[test]
    fn shell_history_files_are_denied() {
        assert!(is_denied(".bash_history"));
        assert!(is_denied(".zsh_history"));
        assert!(is_denied(".python_history"));
        assert!(is_denied(".mysql_history"));
        assert!(is_denied(".psql_history"));
        assert!(is_denied(".sqlite_history"));
    }

    #[test]
    fn allowed_code_files_are_not_denied() {
        assert!(!is_denied("src/lib.rs"));
        assert!(!is_denied("tests/test_main.py"));
        assert!(!is_denied("package.json"));
        assert!(!is_denied("tsconfig.json"));
        assert!(!is_denied("docker-compose.yml"));
        assert!(!is_denied("Dockerfile"));
        assert!(!is_denied("Makefile"));
    }

    #[test]
    fn non_sensitive_extensions_are_allowed() {
        assert!(!is_denied("data.csv"));
        assert!(!is_denied("data.tsv"));
        assert!(!is_denied("image.png"));
        assert!(!is_denied("doc.pdf"));
        assert!(!is_denied("archive.zip"));
        assert!(!is_denied("archive.tar.gz"));
    }
}
