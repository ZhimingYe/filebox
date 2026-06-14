use std::path::Path;

const DENIED_EXTENSIONS: &[&str] = &[
    ".env", ".pem", ".key", ".crt", ".p12", ".pfx",
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
    ".envrc", ".condarc",
    "known_hosts", "authorized_keys",
    "credentials", "credentials.json", "token.json", "secrets.json",
];

/// Specific files inside directories that are otherwise allowed
const DENIED_IN_DIR: &[(&str, &str)] = &[
    (".cargo", "credentials"),
    (".cargo", "credentials.toml"),
    (".gradle", "gradle.properties"),
    (".maven", "settings.xml"),
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
];

pub fn is_denied(relative_path: &str) -> bool {
    let path = Path::new(relative_path);

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
    }
}
