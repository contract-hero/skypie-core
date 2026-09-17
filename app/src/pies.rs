// Pies store — persisted user pies (M2, spec section 9). Shaped like
// bookmarks.rs (list/add/remove over one JSON array), but with two
// differences that matter:
//
//   1. Every write goes through `state_store::update_state_field("pies",
//      ...)`, never `set_state_field`. `bookmarks.rs`'s
//      `list_from_global()` + `set_state_field` pattern is a
//      read-modify-write across TWO separate lock acquisitions — fine for
//      bookmarks, which only the UI ever writes, but pies gets a second
//      writer in M5 (the agent socket) that must not be able to race the UI
//      (e.g. `touch_seen` on every plate open) and drop a write. Routing
//      every op below through `update_state_field` keeps the whole
//      read-modify-write inside ONE lock acquisition, which makes that race
//      structurally impossible rather than merely unlikely.
//   2. Timestamps are ms epoch (`as_millis`), NOT the seconds
//      `bookmarks.rs`/`recents.rs` use (`as_secs`) — spec section 9 is
//      explicit that every pies timestamp is ms, and the derived Pinned/
//      Recent pies convert seconds to ms at the UI boundary instead
//      (`derived-pies.ts`). Do not "unify" the two stores onto one clock;
//      bookmarks.rs and recents.rs are unrelated persisted documents with
//      their own established on-disk shape, and changing their resolution
//      would be a silent schema change to data already on disk.
//
// Ids: `uuid::Uuid::now_v7()`, already a workspace dependency (Cargo.toml,
// used by annotations.rs) and time-sortable, which is the one property a
// `ulid` crate would add over a plain v4 uuid. Adding a second id library
// for a property `uuid` already has is not worth the extra dependency.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The only schema version this build understands. `list()` and every
/// mutating op below refuse to touch a document whose `v` doesn't match —
/// see `mutate_doc`'s doc comment for exactly what "refuse" means.
pub const CURRENT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PiesDoc {
    pub v: u32,
    pub pies: Vec<Pie>,
}

impl Default for PiesDoc {
    fn default() -> Self {
        Self { v: CURRENT_VERSION, pies: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pie {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub seen_at: u64,
    pub members: Vec<PieMember>,
}

/// A member's own kind — a plain file, or a folder whose contents the
/// (M3) census walks. Lowercase on the wire ("file"/"folder") so a Tauri
/// command can take this type directly as a param and the frontend passes
/// the same string spec section 9's `PieMember["kind"]` union names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PieMemberKind {
    File,
    Folder,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PieMemberOrigin {
    pub session_id: Option<String>,
    pub prompt_id: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PieMember {
    pub kind: PieMemberKind,
    pub path: PathBuf,
    pub added_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<PieMemberOrigin>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read-only: the current `pies` document's list, or an empty Vec when the
/// key is absent OR its `v` doesn't match `CURRENT_VERSION` — an older
/// build reading a newer build's document shows no user pies rather than
/// guessing at an unknown shape (spec section 9).
pub fn list() -> Vec<Pie> {
    let val = crate::state_store::global_state()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let Some(pies_val) = val.get("pies") else { return Vec::new() };
    let Ok(doc) = serde_json::from_value::<PiesDoc>(pies_val.clone()) else { return Vec::new() };
    if doc.v != CURRENT_VERSION {
        return Vec::new();
    }
    doc.pies
}

/// Run `f` over the `pies` document under the store's single lock
/// (`update_state_field`), starting from `PiesDoc::default()` when the key
/// is missing (`Value::Null`, what `update_state_field` hands a brand new
/// leaf) — and, critically, leaving the value COMPLETELY UNTOUCHED when it
/// already holds an object whose `v` we don't recognise. That is the "no
/// write ever replaces the key" guarantee from spec section 9: an older
/// build must never downgrade a newer build's `pies` document just because
/// it ran a mutating op while that document was on disk. Every op in this
/// file is safe by construction because they all funnel through here.
fn mutate_doc(f: impl FnOnce(&mut PiesDoc)) -> Result<(), String> {
    crate::state_store::update_state_field("pies", move |val| {
        if !val.is_null() {
            let v = val.get("v").and_then(|v| v.as_u64());
            if v != Some(u64::from(CURRENT_VERSION)) {
                return;
            }
        }
        let mut doc: PiesDoc = if val.is_null() {
            PiesDoc::default()
        } else {
            serde_json::from_value(val.clone()).unwrap_or_default()
        };
        f(&mut doc);
        *val = serde_json::to_value(&doc).unwrap_or(serde_json::Value::Null);
    })
}

/// Create (`id: None`) or rename (`id: Some`) a pie, and return the result —
/// the caller (the Tauri command) needs the real id back, since a newly
/// created pie's id is minted here, not chosen by the frontend. An `id`
/// that names no existing pie falls through to creating a fresh one, the
/// same tolerance `bookmarks::add`'s idempotent re-add has for a caller
/// racing a delete.
pub fn upsert(id: Option<&str>, name: &str) -> Result<Pie, String> {
    let mut out: Option<Pie> = None;
    mutate_doc(|doc| {
        if let Some(id) = id {
            if let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) {
                p.name = name.to_string();
                out = Some(p.clone());
                return;
            }
        }
        let pie = Pie {
            id: uuid::Uuid::now_v7().to_string(),
            name: name.to_string(),
            created_at: now_ms(),
            seen_at: 0,
            members: Vec::new(),
        };
        doc.pies.push(pie.clone());
        out = Some(pie);
    })?;
    out.ok_or_else(|| "pies: unrecognised pies schema version on disk".to_string())
}

/// Remove a pie. Idempotent: removing an id that doesn't exist (already
/// gone, or the document's `v` was unrecognised) is a no-op, not an error —
/// mirrors `bookmarks::remove`.
pub fn remove(id: &str) -> Result<(), String> {
    mutate_doc(|doc| {
        doc.pies.retain(|p| p.id != id);
    })
}

/// Add `path` as a member of pie `id`. Canonicalizes FIRST, outside the
/// lock — filesystem I/O has no business holding the one process-wide state
/// mutex — and refuses a path that doesn't exist, so a member can never be
/// added un-resolvable in the first place. Idempotent: re-adding a path
/// already a member of the pie is a no-op rather than a duplicate.
pub fn add_member(
    id: &str,
    path: &Path,
    kind: PieMemberKind,
    source: Option<&str>,
) -> Result<(), String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("can't add {}: {e}", path.display()))?;
    mutate_doc(|doc| {
        if let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) {
            if !p.members.iter().any(|m| m.path == canonical) {
                p.members.push(PieMember {
                    kind,
                    path: canonical.clone(),
                    added_at: now_ms(),
                    source: source.map(str::to_string),
                    origin: None,
                });
            }
        }
    })
}

/// Remove a member by its stored (already-canonical) path. Idempotent.
pub fn remove_member(id: &str, path: &Path) -> Result<(), String> {
    mutate_doc(|doc| {
        if let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) {
            p.members.retain(|m| m.path != path);
        }
    })
}

/// Replace a member's stored path in place (keeping `added_at`/`source`/
/// `origin`) — "Locate…" on a folder member whose old location is gone
/// (M3). `new` is canonicalized the same way `add_member` canonicalizes an
/// add; a member not found under `old` is a no-op.
pub fn relocate_member(id: &str, old: &Path, new: &Path) -> Result<(), String> {
    let canonical_new =
        std::fs::canonicalize(new).map_err(|e| format!("can't relocate to {}: {e}", new.display()))?;
    mutate_doc(|doc| {
        if let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) {
            if let Some(m) = p.members.iter_mut().find(|m| m.path == old) {
                m.path = canonical_new.clone();
            }
        }
    })
}

/// Stamp `seen_at` to now — called on every plate open (spec section 9);
/// freshness (`mtime > seen_at`) is M3.
pub fn touch_seen(id: &str) -> Result<(), String> {
    mutate_doc(|doc| {
        if let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) {
            p.seen_at = now_ms();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    // Pies mutate the process-global state object, so these tests must run
    // serially and against the crate-shared isolated state dir — the same
    // pattern bookmarks.rs::tests uses, copied verbatim (own lock, own key).
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        crate::state_store::ensure_shared_test_state_dir();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|p| p.into_inner())
    }

    fn reset() {
        let _ = crate::state_store::set_state_field(
            "pies",
            serde_json::json!({ "v": 1, "pies": [] }),
        );
    }

    #[test]
    fn upsert_none_creates_and_upsert_some_renames() {
        let _g = guard();
        reset();
        let created = upsert(None, "Pricing").unwrap();
        assert_eq!(created.name, "Pricing");
        assert_eq!(created.members.len(), 0);
        assert!(list().iter().any(|p| p.id == created.id));

        let renamed = upsert(Some(&created.id), "Pricing v2").unwrap();
        assert_eq!(renamed.id, created.id, "rename keeps the same id");
        assert_eq!(list().iter().find(|p| p.id == created.id).unwrap().name, "Pricing v2");
    }

    #[test]
    fn add_member_canonicalizes_and_is_idempotent() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Docs").unwrap();

        add_member(&pie.id, &file, PieMemberKind::File, Some("picker")).unwrap();
        add_member(&pie.id, &file, PieMemberKind::File, Some("picker")).unwrap();

        let stored = list().into_iter().find(|p| p.id == pie.id).unwrap();
        assert_eq!(stored.members.len(), 1, "re-adding the same path must not duplicate it");
        // Compare against fs::canonicalize(fixture), not the literal path —
        // on macOS /var is a symlink to /private/var, so tempdir() paths
        // canonicalize to a different string than they're constructed with.
        assert_eq!(stored.members[0].path, std::fs::canonicalize(&file).unwrap());
        assert_eq!(stored.members[0].source.as_deref(), Some("picker"));
    }

    #[test]
    fn add_member_rejects_a_missing_path() {
        let _g = guard();
        reset();
        let pie = upsert(None, "Docs").unwrap();
        let missing = std::env::temp_dir().join("skypie-e2e-does-not-exist-42");
        assert!(add_member(&pie.id, &missing, PieMemberKind::File, None).is_err());
        assert_eq!(list().into_iter().find(|p| p.id == pie.id).unwrap().members.len(), 0);
    }

    #[test]
    fn remove_member_and_remove_pie_are_idempotent() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Docs").unwrap();
        add_member(&pie.id, &file, PieMemberKind::File, None).unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();

        remove_member(&pie.id, &canonical).unwrap();
        remove_member(&pie.id, &canonical).unwrap(); // no-op, not an error
        assert_eq!(list().into_iter().find(|p| p.id == pie.id).unwrap().members.len(), 0);

        remove(&pie.id).unwrap();
        remove(&pie.id).unwrap(); // no-op, not an error
        assert!(list().iter().all(|p| p.id != pie.id));
    }

    #[test]
    fn touch_seen_stamps_now() {
        let _g = guard();
        reset();
        let pie = upsert(None, "Docs").unwrap();
        assert_eq!(pie.seen_at, 0);
        touch_seen(&pie.id).unwrap();
        let seen = list().into_iter().find(|p| p.id == pie.id).unwrap().seen_at;
        assert!(seen > 0);
    }

    /// The safety property spec section 9 asks for: a document whose `v`
    /// this build doesn't recognise is never overwritten by a mutating op —
    /// `list()` sees no pies, but the bytes underneath are untouched.
    #[test]
    fn an_unknown_version_is_never_overwritten() {
        let _g = guard();
        let _ = crate::state_store::set_state_field(
            "pies",
            serde_json::json!({ "v": 99, "pies": [{"future": true}] }),
        );
        assert_eq!(list().len(), 0, "an unrecognised v shows no pies");

        // A mutating op against this state must be refused...
        assert!(upsert(None, "New").is_err());

        // ...and the document on disk (well, in memory — the debounced
        // write hasn't necessarily landed) must be byte-for-byte the same.
        let val = crate::state_store::current_state_value();
        assert_eq!(val["pies"], serde_json::json!({ "v": 99, "pies": [{"future": true}] }));
    }

    /// Two threads each add one member to the SAME pie through the public
    /// API — the scenario `update_state_field`'s single lock acquisition
    /// per call exists to make safe (state_store.rs has the same test at
    /// the primitive level; this is the same property through pies.rs's own
    /// surface, since that's what the UI and, from M5, the agent socket
    /// actually call).
    #[test]
    fn two_interleaved_writers_both_survive() {
        let _g = guard();
        reset();
        let pie = upsert(None, "Shared").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();

        let id_a = pie.id.clone();
        let id_b = pie.id.clone();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let (barrier_a, barrier_b) = (std::sync::Arc::clone(&barrier), std::sync::Arc::clone(&barrier));
        let ta = std::thread::spawn(move || {
            barrier_a.wait();
            add_member(&id_a, &a, PieMemberKind::File, None).unwrap();
        });
        let tb = std::thread::spawn(move || {
            barrier_b.wait();
            add_member(&id_b, &b, PieMemberKind::File, None).unwrap();
        });
        ta.join().unwrap();
        tb.join().unwrap();

        let members = list().into_iter().find(|p| p.id == pie.id).unwrap().members;
        assert_eq!(members.len(), 2, "both interleaved writers' members must survive: {members:?}");
    }
}
