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
use serde_json::Value;
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

/// Why a `pies` document can't be read. The two cases get DISTINCT
/// messages because they need distinct fixes: an unrecognised `v` means
/// "this build is older than the document, upgrade"; an unparseable
/// document means "the bytes are damaged". Reporting a corrupt document as
/// a version problem sent users looking for an upgrade that does not exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocError {
    UnknownVersion,
    Unparseable,
}

impl DocError {
    fn message(self) -> &'static str {
        match self {
            DocError::UnknownVersion => "pies: unrecognised pies schema version on disk",
            DocError::Unparseable => "pies: the pies document on disk could not be parsed",
        }
    }
}

/// Parse the `pies` leaf into a `PiesDoc`, or say why it can't be. A
/// missing key (`Value::Null`, what `update_state_field` hands a brand new
/// leaf) is a brand new, empty document, not an error.
///
/// Takes the value BY VALUE so `serde_json::from_value` consumes it: the
/// single caller-side clone of the `pies` subtree is the only copy made.
/// Parsing runs FIRST and the typed `doc.v` is the gate, so the common
/// cases are classified on real data. A document that fails to parse is
/// still reported as a version problem when its raw `v` is not ours,
/// because a newer build's shape is expected to be unparseable here.
fn readable_doc(val: Value) -> Result<PiesDoc, DocError> {
    if val.is_null() {
        return Ok(PiesDoc::default());
    }
    let declared = val.get("v").and_then(Value::as_u64);
    match serde_json::from_value::<PiesDoc>(val) {
        Ok(doc) if doc.v == CURRENT_VERSION => Ok(doc),
        Ok(_) => Err(DocError::UnknownVersion),
        Err(_) if declared != Some(u64::from(CURRENT_VERSION)) => Err(DocError::UnknownVersion),
        Err(_) => Err(DocError::Unparseable),
    }
}

/// Read-only: the current `pies` document's list, or an empty Vec when the
/// key is absent OR the document can't be read (see `readable_doc`) — an
/// older build reading a newer build's document shows no user pies rather
/// than guessing at an unknown shape (spec section 9).
///
/// Clones ONLY the `pies` subtree, and only while the lock is held. The
/// whole state document (every tab, bookmark and annotation) used to be
/// deep-cloned on every single call, and then the subtree cloned again for
/// `from_value`.
pub fn list() -> Vec<Pie> {
    let pies_val = {
        let global = crate::state_store::global_state()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        match global.get("pies") {
            Some(v) => v.clone(),
            None => return Vec::new(),
        }
    };
    readable_doc(pies_val).map(|doc| doc.pies).unwrap_or_default()
}

/// Run `f` over the `pies` document under the store's single lock
/// (`update_state_field`) — and, critically, leave the value COMPLETELY
/// UNTOUCHED whenever `readable_doc` refuses it, both for an unrecognised
/// `v` and for a document that does not parse at all. That second case used
/// to fall through `unwrap_or_default()` into an EMPTY document — one
/// unparseable member (an unknown `kind` string, a non-numeric `added_at`,
/// a hand-edited or torn-write entry) silently deleted every pie in the
/// store on the next mutation (review: pies.rs:132). A parse failure is
/// just as much "a document this build does not understand" as an
/// unrecognised `v`, so it gets the same response: touch nothing, and
/// return the reason so the caller can say which one it was. That is the
/// "no write ever replaces the key" guarantee from spec section 9: an older
/// build must never downgrade a newer build's `pies` document just because
/// it ran a mutating op while that document was on disk. Every op in this
/// file is safe by construction because they all funnel through here.
fn mutate_doc(f: impl FnOnce(&mut PiesDoc)) -> Result<(), String> {
    let mut refused: Option<DocError> = None;
    crate::state_store::update_state_field("pies", |val| match readable_doc(val.clone()) {
        Ok(mut doc) => {
            f(&mut doc);
            *val = serde_json::to_value(&doc).unwrap_or(Value::Null);
        }
        Err(e) => refused = Some(e),
    })?;
    match refused {
        Some(e) => Err(e.message().to_string()),
        None => Ok(()),
    }
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
    // Unreachable in practice: `mutate_doc` either ran `f` (which always
    // sets `out`) or returned the refusal above through `?`.
    out.ok_or_else(|| DocError::Unparseable.message().to_string())
}

/// Remove a pie. Idempotent: removing an id that doesn't exist (already
/// gone, or the document's `v` was unrecognised) is a no-op, not an error —
/// mirrors `bookmarks::remove`.
pub fn remove(id: &str) -> Result<(), String> {
    mutate_doc(|doc| {
        doc.pies.retain(|p| p.id != id);
    })
}

/// Canonicalize `path` for a caller that must ERROR when it can't be
/// resolved (adding a member, or the "new" side of a relocate — both
/// contracts refuse a path that doesn't exist). Also exposed to the UI as
/// the `canonicalize_path` command (`app.rs`): a picker path like `/tmp/x`
/// must resolve to `/private/tmp/x` BEFORE it is compared against a pie's
/// stored (always-canonical) members, or the comparison silently never
/// matches for any non-canonical input (review: pies.ts:57 / pies.rs:206).
pub fn canonicalize(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|e| format!("can't resolve {}: {e}", path.display()))
}

/// Canonicalize `path` the same way `canonicalize` does, but fall back to
/// `path` unchanged when it can't be resolved instead of erroring — used to
/// match a MEMBER path that must still be findable even after its target
/// has gone missing (e.g. removing a member whose file was deleted since it
/// was added, where `fs::canonicalize` would now fail on the very path that
/// is already stored verbatim).
fn canonicalize_lenient(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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
    let canonical = canonicalize(path)?;
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

/// Remove a member by path. Canonicalizes `path` FIRST — `add_member`
/// stores the canonical form, but a caller (the UI, a menu) may still pass
/// the non-canonical form it was given (a picker path like `/tmp/x` for a
/// stored `/private/tmp/x`); comparing the raw string made removal a silent
/// no-op for exactly the paths `add_member` itself canonicalizes on the way
/// in (review: pies.rs:206). Falls back to the raw path when it can no
/// longer be resolved (the file was deleted since it was added) rather than
/// erroring, so a dangling member can still be removed. Idempotent.
pub fn remove_member(id: &str, path: &Path) -> Result<(), String> {
    let canonical = canonicalize_lenient(path);
    mutate_doc(|doc| {
        if let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) {
            p.members.retain(|m| m.path != canonical);
        }
    })
}

/// Replace a member's stored path in place (keeping `added_at`/`source`/
/// `origin`) — "Locate…" on a folder member whose old location is gone
/// (M3). `new` is canonicalized the same way `add_member` canonicalizes an
/// add (errors if unresolvable); `old` is canonicalized leniently, the same
/// reasoning as `remove_member` — a member not found under either form is a
/// no-op.
pub fn relocate_member(id: &str, old: &Path, new: &Path) -> Result<(), String> {
    let canonical_new = canonicalize(new)?;
    let canonical_old = canonicalize_lenient(old);
    mutate_doc(|doc| {
        if let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) {
            if let Some(m) = p.members.iter_mut().find(|m| m.path == canonical_old) {
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

    /// `add_member` stores the CANONICAL path, but a caller (the UI) may
    /// still pass the raw, non-canonical form it was given — a picker path
    /// like the tempdir fixture below, which on macOS canonicalizes through
    /// the /var → /private/var symlink to a different string. Comparing the
    /// raw string used to make removal a silent no-op for exactly the paths
    /// `add_member` itself resolves on the way in (review: pies.rs:206 /
    /// pies.ts:57).
    #[test]
    fn remove_member_matches_a_non_canonical_caller_path() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Docs").unwrap();
        add_member(&pie.id, &file, PieMemberKind::File, None).unwrap();

        // `file` itself — NOT `fs::canonicalize(&file)` — is what a picker
        // row built straight from a tab entry's path would pass.
        remove_member(&pie.id, &file).unwrap();
        assert_eq!(
            list().into_iter().find(|p| p.id == pie.id).unwrap().members.len(),
            0,
            "remove_member must resolve the raw path before comparing, the same as add_member",
        );
    }

    /// A member whose file was deleted since it was added can no longer be
    /// re-canonicalized — `remove_member` must fall back to the already-
    /// stored (canonical) path instead of erroring trying to re-resolve it.
    #[test]
    fn remove_member_falls_back_when_the_path_no_longer_resolves() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Docs").unwrap();
        add_member(&pie.id, &file, PieMemberKind::File, None).unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        std::fs::remove_file(&file).unwrap();

        remove_member(&pie.id, &canonical).unwrap();
        assert_eq!(list().into_iter().find(|p| p.id == pie.id).unwrap().members.len(), 0);
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

    /// The other half of the same safety property: a document whose `v`
    /// MATCHES `CURRENT_VERSION` but fails to parse as a `PiesDoc` (one
    /// member with an unrecognised `kind`, here) must ALSO be left
    /// untouched. Before this fix, `mutate_doc` answered a parse failure
    /// with `unwrap_or_default()` — a fresh, EMPTY `PiesDoc` — and then
    /// wrote that empty document straight back, deleting every pie in the
    /// store over one bad member (review: pies.rs:132).
    #[test]
    fn an_unparseable_document_is_never_overwritten() {
        let _g = guard();
        let corrupt = serde_json::json!({
            "v": 1,
            "pies": [{
                "id": "p1",
                "name": "Pricing",
                "created_at": 0,
                "seen_at": 0,
                "members": [{ "kind": "not-a-real-kind", "path": "/x", "added_at": 0 }]
            }]
        });
        let _ = crate::state_store::set_state_field("pies", corrupt.clone());

        // Same as an unrecognised v: list() sees no pies...
        assert_eq!(list().len(), 0);

        // ...a mutating op is refused rather than silently succeeding
        // against an empty document conjured by unwrap_or_default()...
        assert!(upsert(None, "New").is_err());

        // ...and the corrupt document survives byte-for-byte.
        let val = crate::state_store::current_state_value();
        assert_eq!(val["pies"], corrupt, "an unparseable document must never be overwritten");
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
