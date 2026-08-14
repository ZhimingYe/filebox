//! Shared validation rules for the agent temp-upload folder.
//!
//! The hub and the agent both validate uploaded file names with these rules
//! so a name the hub accepts is always a name the agent accepts (defense in
//! depth — the agent re-validates on its own anyway). Names are constrained
//! to a single path component: no separators, no `..`, no NUL, bounded length.
//! The agent then treats the name as a leaf inside its dedicated upload
//! directory only.

/// Hard cap on an uploaded file's name length (bytes). Kept at 255 so a
/// validated name can never exceed a single filesystem component.
pub const TEMP_UPLOAD_NAME_MAX_BYTES: usize = 255;

/// Validate the shape of an uploaded file name. Returns the trimmed name on
/// success, or a machine-readable error code on failure.
///
/// Rules:
/// - Non-empty after trimming.
/// - ≤ [`TEMP_UPLOAD_NAME_MAX_BYTES`] bytes.
/// - No `/`, `\`, or NUL — a single path component only.
/// - Not `.` or `..`.
pub fn validate_upload_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("temp_name_invalid".to_string());
    }
    if name.len() > TEMP_UPLOAD_NAME_MAX_BYTES {
        return Err("temp_name_invalid".to_string());
    }
    if name.contains('\0') || name.contains('/') || name.contains('\\') {
        return Err("temp_name_invalid".to_string());
    }
    if name == "." || name == ".." {
        return Err("temp_name_invalid".to_string());
    }
    Ok(name.to_string())
}

/// Validate the name of the temp upload *folder* itself (the directory
/// created under the agent's temp base dir). Same component rules, so the
/// folder can never escape its parent.
pub fn validate_upload_folder_name(raw: &str) -> Result<String, String> {
    validate_upload_name(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_names() {
        assert_eq!(validate_upload_name("report.pdf").unwrap(), "report.pdf");
        assert_eq!(validate_upload_name("  shot.png  ").unwrap(), "shot.png");
        assert_eq!(validate_upload_name("a.b-c_d (1).jpg").unwrap(), "a.b-c_d (1).jpg");
        assert_eq!(validate_upload_name("照片.png").unwrap(), "照片.png");
    }

    #[test]
    fn accepts_hidden_names() {
        // Hidden names are legal components; the agent stores them 0600.
        assert_eq!(validate_upload_name(".gitignore").unwrap(), ".gitignore");
    }

    #[test]
    fn rejects_escapes_and_separators() {
        for bad in [
            "",
            "   ",
            ".",
            "..",
            "../etc/passwd",
            "..\\..\\x",
            "a/b",
            "a\\b",
            "a\0b",
        ] {
            assert_eq!(validate_upload_name(bad), Err("temp_name_invalid".to_string()));
        }
    }

    #[test]
    fn rejects_overlong_names() {
        let long = "x".repeat(TEMP_UPLOAD_NAME_MAX_BYTES + 1);
        assert_eq!(validate_upload_name(&long), Err("temp_name_invalid".to_string()));
        let ok = "x".repeat(TEMP_UPLOAD_NAME_MAX_BYTES);
        assert!(validate_upload_name(&ok).is_ok());
    }
}
