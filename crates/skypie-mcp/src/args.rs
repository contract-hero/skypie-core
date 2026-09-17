// Tool arguments: the JSON Schema an LLM caller sees, and the validation that
// runs before any of them reaches the network.
//
// Every check here is a pure function over strings. The rule is the same one
// the app's IPC layer follows: reject a malformed argument with a message that
// says what to send instead, and never let a defaulted value silently widen
// what the call does.

use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::Deserialize;

/// TTL bounds for a beam link, in hours. Mirrors `skypie_remote::beam`'s
/// constants, which this crate no longer links: the app clamps to the same
/// range, so a value refused here would have been silently clamped there.
pub const DEFAULT_TTL_HOURS: u32 = 24;
pub const MIN_TTL_HOURS: u32 = 1;
pub const MAX_TTL_HOURS: u32 = 24 * 30;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ShareLinkArgs {
    /// Absolute path of the file to share with the user's own devices. A
    /// relative path resolves against the server's working directory.
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct BeamArtifactArgs {
    /// Absolute path of the file to send. A relative path resolves against the
    /// server's working directory.
    pub path: String,
    /// How long the link stays fetchable, in hours (1-720). Defaults to 24.
    #[serde(default)]
    pub ttl_hours: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct StopBeamArgs {
    /// Which link to revoke: the content hash reported by beam_artifact or
    /// server_status, or a prefix of it (8 characters or more). Omit it to
    /// revoke every link this server is still serving.
    #[serde(default)]
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct ListDevicesArgs {
    /// Dial every paired device to report live presence. Costs a network
    /// round trip per device; without it presence is "unknown" unless a
    /// session is already open.
    #[serde(default)]
    pub probe: bool,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ForgetDeviceArgs {
    /// Which paired device to forget: its name, or a prefix of its node id.
    pub device: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ConfirmPairingArgs {
    /// True completes the pairing, false discards it. A discarded pairing
    /// writes nothing to disk.
    pub accept: bool,
    /// Which pending pairing to resolve. Optional while exactly one is
    /// waiting; required when more than one is.
    #[serde(default)]
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AddToPieArgs {
    /// The pie to add the file to, by NAME (case-insensitive) or by id. If no
    /// pie with this name exists yet, one is created — you never need to ask
    /// the user to make the pie first. If more than one pie shares this name,
    /// the call fails and lists their ids; call again with one of those ids.
    pub pie: String,
    /// Absolute path of the file or folder to add. A relative path resolves
    /// against the server's working directory, and a leading `~` expands
    /// against the user's home directory. Use the path you just wrote or the
    /// folder you just produced output into.
    pub path: String,
    /// Your own identifier for this Claude Code session, if you have one.
    /// Stored on the member for the user's own reference; never used to
    /// decide anything.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Your own identifier for the prompt or turn that produced this file,
    /// if you have one. Stored on the member for the user's own reference;
    /// never used to decide anything.
    #[serde(default)]
    pub prompt_id: Option<String>,
}

/// Resolve a caller-supplied path argument. `cwd` and `home` are parameters,
/// not process lookups, so the rule is testable without touching the
/// environment.
///
/// This is argument hygiene only. Whether the file may actually be shared is
/// decided by the app.
pub fn resolve_arg_path(raw: &str, cwd: &Path, home: Option<&Path>) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("path must not contain NUL bytes".to_string());
    }
    if trimmed == "~" || trimmed.starts_with("~/") {
        let home = home.ok_or_else(|| "cannot expand ~: no home directory".to_string())?;
        let rest = trimmed.trim_start_matches('~').trim_start_matches('/');
        return Ok(if rest.is_empty() { home.to_path_buf() } else { home.join(rest) });
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(cwd.join(path))
    }
}

/// Clamp-free TTL validation: an out-of-range number is an error, because a
/// caller that asked for 0 hours or 10 years wanted something this server
/// cannot give and should be told so.
pub fn validate_ttl(hours: Option<u32>) -> Result<u32, String> {
    match hours {
        None => Ok(DEFAULT_TTL_HOURS),
        Some(h) if (MIN_TTL_HOURS..=MAX_TTL_HOURS).contains(&h) => Ok(h),
        Some(h) => Err(format!(
            "ttl_hours must be between {MIN_TTL_HOURS} and {MAX_TTL_HOURS}, got {h}"
        )),
    }
}

/// A device argument is free text matched against the peer list later; the
/// only thing to reject here is nothing at all.
pub fn validate_device_query(raw: &str) -> Result<&str, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("device must not be empty — call list_devices to see the paired names".to_string());
    }
    Ok(trimmed)
}

/// An annotation id, as the hook's context block printed it.
///
/// UUIDs only: the store's ids are UUIDv7, and refusing anything else here
/// means a model that hallucinated a "comment 3" gets a message telling it to
/// use the id from the feedback block instead of a confusing "no comment".
pub fn validate_annotation_id(raw: &str) -> Result<&str, String> {
    let trimmed = raw.trim();
    const SHAPE: &str =
        "id must be the comment's uuid, exactly as the feedback listing printed it";
    if trimmed.len() != 36 {
        return Err(SHAPE.to_string());
    }
    let ok = trimmed.chars().enumerate().all(|(i, c)| {
        if matches!(i, 8 | 13 | 18 | 23) {
            c == '-'
        } else {
            c.is_ascii_hexdigit()
        }
    });
    if ok {
        Ok(trimmed)
    } else {
        Err(SHAPE.to_string())
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListFeedbackArgs {
    /// Absolute path of the file to read feedback for. Omit it to list every
    /// file that has open feedback.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ResolveFeedbackArgs {
    /// Absolute path of the file the comment is on.
    pub path: String,
    /// The comment's uuid, copied from the feedback listing.
    pub id: String,
    /// A short line saying what was done. Shown to the user next to their
    /// comment, so write it for them, not for a log.
    #[serde(default)]
    pub note: Option<String>,
    /// False records "read it, not doing it" instead of "done". Use it when
    /// you are declining the feedback, and always put the reason in `note`.
    #[serde(default = "default_true")]
    pub addressed: bool,
}

fn default_true() -> bool {
    true
}

/// Confine a path to one of `roots`: it must exist, and its canonical form
/// must sit under a canonical root. One refusal string for "does not exist",
/// "outside the roots" and "no roots configured" — the share module's
/// no-existence-leak convention. The only path gate this process keeps for
/// itself, because a beam link publishes to strangers and the caller is a
/// model steerable by text it has read.
pub fn confine(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    const DENIED: &str = "path not found or out of root";
    let canonical = path.canonicalize().map_err(|_| DENIED.to_string())?;
    let inside = roots
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .any(|r| canonical.starts_with(&r));
    if inside {
        Ok(canonical)
    } else {
        Err(DENIED.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cwd() -> PathBuf {
        PathBuf::from("/work/project")
    }

    #[test]
    fn an_absolute_path_passes_through_unchanged() {
        let got = resolve_arg_path("/w/report.html", &cwd(), None).unwrap();
        assert_eq!(got, PathBuf::from("/w/report.html"));
    }

    #[test]
    fn a_relative_path_resolves_against_the_working_directory() {
        let got = resolve_arg_path("dist/report.html", &cwd(), None).unwrap();
        assert_eq!(got, PathBuf::from("/work/project/dist/report.html"));
        // Surrounding whitespace is a copy-paste artifact, not part of a name.
        assert_eq!(
            resolve_arg_path("  dist/report.html  ", &cwd(), None).unwrap(),
            PathBuf::from("/work/project/dist/report.html")
        );
    }

    #[test]
    fn a_tilde_expands_only_when_a_home_directory_is_known() {
        let home = PathBuf::from("/Users/x");
        assert_eq!(
            resolve_arg_path("~/notes/a.md", &cwd(), Some(&home)).unwrap(),
            PathBuf::from("/Users/x/notes/a.md")
        );
        assert_eq!(resolve_arg_path("~", &cwd(), Some(&home)).unwrap(), home);
        assert!(resolve_arg_path("~/a.md", &cwd(), None).is_err());
        // A bare `~name` is NOT a home directory reference — leave it alone
        // rather than guessing another user's directory.
        assert_eq!(
            resolve_arg_path("~other/a.md", &cwd(), Some(&home)).unwrap(),
            PathBuf::from("/work/project/~other/a.md")
        );
    }

    #[test]
    fn empty_and_nul_paths_are_refused() {
        assert_eq!(resolve_arg_path("", &cwd(), None).unwrap_err(), "path must not be empty");
        assert_eq!(resolve_arg_path("   ", &cwd(), None).unwrap_err(), "path must not be empty");
        assert_eq!(
            resolve_arg_path("/w/a\0b.html", &cwd(), None).unwrap_err(),
            "path must not contain NUL bytes"
        );
    }

    #[test]
    fn ttl_defaults_to_a_day_and_refuses_out_of_range_values() {
        assert_eq!(validate_ttl(None).unwrap(), DEFAULT_TTL_HOURS);
        assert_eq!(validate_ttl(Some(1)).unwrap(), 1);
        assert_eq!(validate_ttl(Some(MAX_TTL_HOURS)).unwrap(), MAX_TTL_HOURS);
        // Zero would mint a link that is already dead; the ceiling is the same
        // one `beam::offer` clamps to, surfaced as an error instead.
        assert!(validate_ttl(Some(0)).is_err());
        assert!(validate_ttl(Some(MAX_TTL_HOURS + 1)).is_err());
        assert!(validate_ttl(Some(u32::MAX)).is_err());
    }

    #[test]
    fn a_device_query_must_carry_something_to_match_on() {
        assert_eq!(validate_device_query("  MacBook  ").unwrap(), "MacBook");
        assert!(validate_device_query("").is_err());
        assert!(validate_device_query("\t \n").is_err());
    }

    #[test]
    fn confine_admits_only_an_existing_file_under_a_root() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("w");
        std::fs::create_dir(&root).unwrap();
        let inside = root.join("a.html");
        std::fs::write(&inside, "x").unwrap();
        let outside = dir.path().join("b.html");
        std::fs::write(&outside, "x").unwrap();

        assert_eq!(confine(&inside, &[root.clone()]).unwrap(), inside.canonicalize().unwrap());
        // A traversal that climbs out is caught after canonicalization.
        let traversal = root.join("..").join("b.html");
        assert_eq!(confine(&traversal, &[root.clone()]).unwrap_err(), "path not found or out of root");
        assert_eq!(confine(&outside, &[root.clone()]).unwrap_err(), "path not found or out of root");
        assert_eq!(confine(&root.join("nope"), &[root.clone()]).unwrap_err(), "path not found or out of root");
        assert_eq!(confine(&inside, &[]).unwrap_err(), "path not found or out of root");
    }
}
