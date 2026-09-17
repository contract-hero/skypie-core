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

/// Provenance recorded on a member `add_to_pie` (M5) creates. `#[serde(
/// default)]` on the struct lets an old, field-missing `origin` object still
/// parse; `skip_serializing_if` on each field keeps `state.json` clean (no
/// member added through the picker/menu/Finder ever carries an `origin` key
/// at all) and matches `ui/src/ipc.ts`'s `PieMemberOrigin`, whose three
/// fields are likewise all optional on the wire.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PieMemberOrigin {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
/// leaf) — and, critically, leaving the value COMPLETELY UNTOUCHED both when
/// it already holds an object whose `v` we don't recognise AND when it fails
/// to parse as a `PiesDoc` at all. That second case used to fall through
/// `unwrap_or_default()` into an EMPTY document — one unparseable member (an
/// unknown `kind` string, a non-numeric `added_at`, a hand-edited or
/// torn-write entry) silently deleted every pie in the store on the next
/// mutation (review: pies.rs:132). A parse failure is just as much "a
/// document this build does not understand" as an unrecognised `v`, so it
/// gets the same response: touch nothing. That is the "no write ever
/// replaces the key" guarantee from spec section 9: an older build must
/// never downgrade a newer build's `pies` document just because it ran a
/// mutating op while that document was on disk. Every op in this file is
/// safe by construction because they all funnel through here.
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
            let Ok(parsed) = serde_json::from_value::<PiesDoc>(val.clone()) else { return };
            parsed
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
/// already a member of the pie is a no-op — and, critically, LEAVES the
/// existing member untouched rather than overwriting its `origin`/
/// `added_at`/`source`: a second `add_to_pie` call for a path an agent (or
/// the UI) already added must not erase who added it first, or silently
/// re-date it to "just now".
///
/// One function, not two (M5 widened this rather than adding a parallel
/// `add_member_with_origin`) — every existing call site (`app.rs`, tests)
/// passes `origin: None`, which is exactly what a picker/menu/Finder add
/// means: "no agent provenance for this one".
pub fn add_member(
    id: &str,
    path: &Path,
    kind: PieMemberKind,
    source: Option<&str>,
    origin: Option<PieMemberOrigin>,
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
                    origin: origin.clone(),
                });
            }
        }
    })
}

/// Resolve `query` to exactly one pie (decision 1, M5 brief): an exact `id`
/// match first, else a case-insensitive unique NAME match, else `Ok(None)`
/// when nothing matches. Two or more pies sharing a case-insensitive name is
/// an `Err` listing their ids, rather than silently picking the first —
/// `add_to_pie_for` (app.rs) turns a `None` into "create a pie named
/// `query`" (an agent must never have to ask the user to make the pie
/// first), so this function itself stays a pure, three-way lookup over
/// `list()` with no side effect and no lock re-entry (`list()` takes its own
/// lock and returns; this never calls `mutate_doc`).
pub fn find(query: &str) -> Result<Option<Pie>, String> {
    let pies = list();
    if let Some(p) = pies.iter().find(|p| p.id == query) {
        return Ok(Some(p.clone()));
    }
    let query_lower = query.to_lowercase();
    let matches: Vec<&Pie> = pies.iter().filter(|p| p.name.to_lowercase() == query_lower).collect();
    match matches.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some((*one).clone())),
        many => Err(format!(
            "{} pies are named {query:?} ({}) — use one's id instead",
            many.len(),
            many.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
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

        add_member(&pie.id, &file, PieMemberKind::File, Some("picker"), None).unwrap();
        add_member(&pie.id, &file, PieMemberKind::File, Some("picker"), None).unwrap();

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
        assert!(add_member(&pie.id, &missing, PieMemberKind::File, None, None).is_err());
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
        add_member(&pie.id, &file, PieMemberKind::File, None, None).unwrap();
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
        add_member(&pie.id, &file, PieMemberKind::File, None, None).unwrap();

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
        add_member(&pie.id, &file, PieMemberKind::File, None, None).unwrap();
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
            add_member(&id_a, &a, PieMemberKind::File, None, None).unwrap();
        });
        let tb = std::thread::spawn(move || {
            barrier_b.wait();
            add_member(&id_b, &b, PieMemberKind::File, None, None).unwrap();
        });
        ta.join().unwrap();
        tb.join().unwrap();

        let members = list().into_iter().find(|p| p.id == pie.id).unwrap().members;
        assert_eq!(members.len(), 2, "both interleaved writers' members must survive: {members:?}");
    }

    // ── M5: find(), agent members, socket-vs-UI interleaving ────────────

    #[test]
    fn find_matches_an_id_exactly_and_a_name_case_insensitively() {
        let _g = guard();
        reset();
        let pie = upsert(None, "Pricing").unwrap();

        assert_eq!(find(&pie.id).unwrap().as_ref().map(|p| &p.id), Some(&pie.id));
        assert_eq!(find("pricing").unwrap().as_ref().map(|p| &p.id), Some(&pie.id));
        assert_eq!(find("PRICING").unwrap().as_ref().map(|p| &p.id), Some(&pie.id));
        assert_eq!(find("PrIcInG").unwrap().as_ref().map(|p| &p.id), Some(&pie.id));
        assert_eq!(find("Nope").unwrap(), None, "no match is Ok(None), not an error");
    }

    #[test]
    fn find_refuses_an_ambiguous_name_and_lists_the_candidates() {
        let _g = guard();
        reset();
        let a = upsert(None, "Pricing").unwrap();
        let b = upsert(None, "pricing").unwrap();

        let err = find("Pricing").unwrap_err();
        assert!(err.contains(&a.id), "{err}");
        assert!(err.contains(&b.id), "{err}");
        // An id is still an EXACT match even while the name is ambiguous —
        // decision 1's fallback order is id, then name, so this must not
        // also error.
        assert_eq!(find(&a.id).unwrap().as_ref().map(|p| &p.id), Some(&a.id));
    }

    #[test]
    fn an_agent_member_round_trips_its_source_and_origin() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pricing-v3.html");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Pricing").unwrap();
        let origin = PieMemberOrigin {
            session_id: Some("sess-1".into()),
            prompt_id: Some("prompt-1".into()),
            cwd: Some("/work".into()),
        };

        add_member(&pie.id, &file, PieMemberKind::File, Some("agent"), Some(origin.clone())).unwrap();

        let member = list().into_iter().find(|p| p.id == pie.id).unwrap().members.into_iter().next().unwrap();
        assert_eq!(member.source.as_deref(), Some("agent"));
        assert_eq!(member.origin, Some(origin));

        // Serializing the doc omits every absent origin field and, for a
        // member with NO origin at all (every other source), omits the
        // whole `origin` key — the on-disk shape `ui/src/ipc.ts`'s
        // `PieMemberOrigin` (all-optional fields) expects.
        let doc = crate::state_store::current_state_value();
        let stored = &doc["pies"]["pies"][0]["members"][0];
        assert_eq!(stored["origin"]["session_id"], "sess-1");
        assert_eq!(stored["origin"]["prompt_id"], "prompt-1");
        assert_eq!(stored["origin"]["cwd"], "/work");
    }

    /// A second `add_member` for a path already a member (the idempotent
    /// case) must not rewrite the FIRST member's `origin`/`added_at`/
    /// `source` — an agent re-adding a file it already put in the pie must
    /// not erase the provenance a person's earlier add wrote, or vice
    /// versa.
    #[test]
    fn re_adding_an_existing_member_does_not_overwrite_its_origin() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Docs").unwrap();
        let origin = PieMemberOrigin {
            session_id: Some("first".into()),
            prompt_id: None,
            cwd: None,
        };
        add_member(&pie.id, &file, PieMemberKind::File, Some("agent"), Some(origin.clone())).unwrap();
        let first_added_at =
            list().into_iter().find(|p| p.id == pie.id).unwrap().members[0].added_at;

        // A second add, with a DIFFERENT origin, for the same path.
        add_member(
            &pie.id,
            &file,
            PieMemberKind::File,
            Some("agent"),
            Some(PieMemberOrigin { session_id: Some("second".into()), prompt_id: None, cwd: None }),
        )
        .unwrap();

        let stored = list().into_iter().find(|p| p.id == pie.id).unwrap();
        assert_eq!(stored.members.len(), 1, "still one member, not two");
        assert_eq!(stored.members[0].origin, Some(origin), "the FIRST origin survives");
        assert_eq!(stored.members[0].added_at, first_added_at, "added_at is not re-stamped");
    }

    /// The socket thread's `add_member` racing the UI's `touch_seen` on the
    /// SAME pie — the exact M5 pairing (`add_to_pie_for` vs. every plate
    /// open) `update_state_field`'s single lock acquisition exists to make
    /// safe. Mirrors `two_interleaved_writers_both_survive` above, but with
    /// the second writer touching `seen_at` instead of adding its own
    /// member, since that is the actual race M5 introduces.
    #[test]
    fn add_member_and_touch_seen_interleave_without_losing_either_write() {
        let _g = guard();
        reset();
        let pie = upsert(None, "Pricing").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pricing-v3.html");
        std::fs::write(&file, "hi").unwrap();

        let id_a = pie.id.clone();
        let id_b = pie.id.clone();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let (barrier_a, barrier_b) = (std::sync::Arc::clone(&barrier), std::sync::Arc::clone(&barrier));
        let ta = std::thread::spawn(move || {
            barrier_a.wait();
            add_member(&id_a, &file, PieMemberKind::File, Some("agent"), None).unwrap();
        });
        let tb = std::thread::spawn(move || {
            barrier_b.wait();
            touch_seen(&id_b).unwrap();
        });
        ta.join().unwrap();
        tb.join().unwrap();

        let stored = list().into_iter().find(|p| p.id == pie.id).unwrap();
        assert_eq!(stored.members.len(), 1, "the socket thread's member survives");
        assert!(stored.seen_at > 0, "the UI's touch_seen survives");
    }
}
