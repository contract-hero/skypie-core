// Portable paths — how `state.json` survives an iOS app update.
//
// iOS moves the app's data container on every install and every update: the
// same file that was
//
//   /var/mobile/Containers/Data/Application/<UUID-A>/Library/Application Support/SkyPie/received/2026-09-13/report.html
//
// yesterday is under `<UUID-B>` today. Anything that persisted the absolute
// path is now a 404, so a restored session opens nothing and the Received
// entries a user pulled from their Mac read as deleted. macOS has no such
// problem — `~/Library/Application Support/SkyPie` is stable — but the
// document is shared, so the rule is one rule on both platforms.
//
// The fix is to write paths INSIDE the state directory as relative to it, and
// to re-resolve them against the CURRENT state directory at load. Paths
// outside the state directory (the user's own tree, on macOS) are absolute and
// stay absolute: they mean nothing else.
//
// The encoding is a marked string rather than a bare relative path so the two
// cases can never be confused:
//
//   "skypie-state:received/2026-09-13/report.html"
//
// The rewrite runs over the whole `state.json` document as JSON, not over the
// typed `State`, for two reasons. The store deliberately preserves unknown
// fields (a newer build's keys survive an older build's write), and the tab
// session lives under `panes.tabs` as an opaque blob this crate never models.
// A field-by-field rewrite would cover neither.

use std::path::{Path, PathBuf};

/// Marks a string in `state.json` as relative to the state directory.
/// Chosen to be un-typeable as a real path: a leading `skypie-state:` segment
/// is not something a POSIX absolute path can start with.
pub const STATE_PREFIX: &str = "skypie-state:";

/// Absolute → portable. Returns the `skypie-state:`-prefixed relative form when
/// `path` sits inside `state_dir`, and the input unchanged otherwise.
///
/// The state dir itself maps to `skypie-state:` with an empty remainder, which
/// `to_absolute` resolves back to the state dir.
pub fn to_portable(path: &str, state_dir: &Path) -> String {
    // Already portable: idempotent, so a double pass over a document cannot
    // produce `skypie-state:skypie-state:…`.
    if path.starts_with(STATE_PREFIX) {
        return path.to_string();
    }
    let Some(rel) = strip_base(path, state_dir) else {
        return path.to_string();
    };
    format!("{STATE_PREFIX}{rel}")
}

/// Portable → absolute. Unprefixed strings pass through: they are either real
/// absolute paths outside the state directory, or not paths at all.
pub fn to_absolute(value: &str, state_dir: &Path) -> String {
    let Some(rel) = value.strip_prefix(STATE_PREFIX) else {
        return value.to_string();
    };
    if rel.is_empty() {
        return state_dir.to_string_lossy().into_owned();
    }
    state_dir.join(rel).to_string_lossy().into_owned()
}

/// The part of `path` below `state_dir`, as a forward-slash relative string.
///
/// Compares component-wise rather than by string prefix so that a sibling
/// directory sharing a name prefix — `…/SkyPie-backup/x` beside `…/SkyPie` —
/// is not mistaken for a child.
fn strip_base(path: &str, state_dir: &Path) -> Option<String> {
    let p = PathBuf::from(path);
    let rel = p.strip_prefix(state_dir).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// Rewrite every string in `value`, in place, through `f`.
///
/// Deliberately blind to which keys hold paths. Any string that resolves under
/// the state directory is one the app wrote about its own tree, and the
/// reverse pass only touches strings carrying the marker, so a non-path string
/// can never be corrupted by a round trip.
fn map_strings(value: &mut serde_json::Value, f: &dyn Fn(&str) -> String) {
    match value {
        serde_json::Value::String(s) => {
            let mapped = f(s);
            if &mapped != s {
                *s = mapped;
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                map_strings(item, f);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                map_strings(v, f);
            }
        }
        _ => {}
    }
}

/// Prepare an in-memory document for disk: container-dependent paths become
/// container-independent.
pub fn portable_document(value: &serde_json::Value, state_dir: &Path) -> serde_json::Value {
    let mut out = value.clone();
    map_strings(&mut out, &|s| to_portable(s, state_dir));
    out
}

/// Resolve a document read from disk against the state directory this process
/// actually has.
pub fn absolute_document(value: &mut serde_json::Value, state_dir: &Path) {
    map_strings(value, &|s| to_absolute(s, state_dir));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        PathBuf::from("/var/mobile/Containers/Data/Application/AAAA/Library/Application Support/SkyPie")
    }

    #[test]
    fn a_path_inside_the_state_dir_becomes_relative() {
        let p = dir().join("received/2026-09-13/report.html").to_string_lossy().into_owned();
        assert_eq!(
            to_portable(&p, &dir()),
            "skypie-state:received/2026-09-13/report.html"
        );
    }

    #[test]
    fn a_path_outside_the_state_dir_is_untouched() {
        let p = "/Users/valrov/workspace/x/audit.html";
        assert_eq!(to_portable(p, &dir()), p);
    }

    #[test]
    fn a_sibling_with_a_shared_name_prefix_is_not_a_child() {
        let sibling = "/var/mobile/Containers/Data/Application/AAAA/Library/Application Support/SkyPie-backup/x.html";
        assert_eq!(to_portable(sibling, &dir()), sibling);
    }

    #[test]
    fn the_container_uuid_moves_and_the_path_still_resolves() {
        let old = dir().join("received/r.html").to_string_lossy().into_owned();
        let portable = to_portable(&old, &dir());

        let moved = PathBuf::from(
            "/var/mobile/Containers/Data/Application/BBBB/Library/Application Support/SkyPie",
        );
        assert_eq!(
            to_absolute(&portable, &moved),
            moved.join("received/r.html").to_string_lossy()
        );
    }

    #[test]
    fn making_a_document_portable_is_idempotent() {
        let p = dir().join("received/r.html").to_string_lossy().into_owned();
        let once = to_portable(&p, &dir());
        assert_eq!(to_portable(&once, &dir()), once);
    }

    #[test]
    fn a_round_trip_through_disk_preserves_an_outside_path() {
        let doc = serde_json::json!({
            "recents": [{ "path": "/Users/valrov/x.md", "opened_at": 7 }],
        });
        let mut on_disk = portable_document(&doc, &dir());
        absolute_document(&mut on_disk, &dir());
        assert_eq!(on_disk, doc);
    }

    #[test]
    fn the_whole_document_is_rewritten_including_the_opaque_tab_session() {
        let doc = serde_json::json!({
            "recents": [{ "path": dir().join("received/a.html").to_string_lossy(), "opened_at": 7 }],
            "panes": {
                // `panes.tabs` is written by the frontend and never modelled
                // here; the generic walk is what covers it.
                "tabs": { "v": 1, "tabs": [{ "history": [{ "path": dir().join("cache/b.html").to_string_lossy() }] }] }
            }
        });
        let on_disk = portable_document(&doc, &dir());
        assert_eq!(on_disk["recents"][0]["path"], "skypie-state:received/a.html");
        assert_eq!(
            on_disk["panes"]["tabs"]["tabs"][0]["history"][0]["path"],
            "skypie-state:cache/b.html"
        );

        let moved = PathBuf::from("/var/mobile/Containers/Data/Application/BBBB/Library/Application Support/SkyPie");
        let mut restored = on_disk;
        absolute_document(&mut restored, &moved);
        assert_eq!(
            restored["panes"]["tabs"]["tabs"][0]["history"][0]["path"],
            moved.join("cache/b.html").to_string_lossy().into_owned()
        );
    }

    #[test]
    fn non_path_strings_survive_a_round_trip() {
        let doc = serde_json::json!({
            "preferences": { "drag_out_mode": "file", "slack_target": "T123/C456" },
            "schema_version": 1,
        });
        let mut out = portable_document(&doc, &dir());
        absolute_document(&mut out, &dir());
        assert_eq!(out, doc);
    }
}
