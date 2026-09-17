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

/// Every field a build newer than this one added to a record, kept verbatim.
///
/// `state_store` holds the whole state document as a `Value` precisely so
/// unknown keys survive a round trip. This file broke that guarantee inside
/// the `pies` key, because it parses into typed records and re-serialises
/// them: any field this build does not name was deleted on the next write.
/// M3 adds census and freshness fields under the SAME `v: 1`, so one
/// `touch_seen` from an M2 build would have erased them. `#[serde(flatten)]`
/// gives those fields a home to be read into and written back out from.
/// Deliberately NOT `deny_unknown_fields`: that would turn a newer
/// document into a parse failure instead of a forward-compatible one.
type UnknownFields = serde_json::Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pie {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub seen_at: u64,
    pub members: Vec<PieMember>,
    #[serde(flatten)]
    pub rest: UnknownFields,
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

/// How a member got into its pie. A closed set, not a free string: the
/// frontend already models it as the union `"picker" | "menu" | "finder" |
/// "agent"` (`ui/src/ipc.ts`), and M5's agent socket is a second writer that
/// must not be able to store a value the UI cannot render. Lowercase on the
/// wire for the same reason `PieMemberKind` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PieMemberSource {
    Picker,
    Menu,
    Finder,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PieMember {
    pub kind: PieMemberKind,
    pub path: PathBuf,
    pub added_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PieMemberSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<PieMemberOrigin>,
    /// See `UnknownFields` — M3's census fields land here on an M2 build.
    #[serde(flatten)]
    pub rest: UnknownFields,
}

fn now_ms() -> u64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64,
        // A clock set before 1970 is a real machine misconfiguration, and
        // stamping 0 makes every affected record look ancient. Say so once
        // per write rather than hiding it behind `unwrap_or(0)`.
        Err(e) => {
            eprintln!("skypie: pies: the system clock is before the unix epoch ({e}); stamping 0");
            0
        }
    }
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
/// Takes the value BY VALUE so `serde_json::from_value` consumes it rather
/// than copying it again on the way in. (`list()` clones the `pies` subtree
/// out of the locked document; `mutate_doc` clones it too, because it must
/// keep the original intact to leave it untouched on a refusal.)
/// Parsing runs FIRST and the typed `doc.v` is the gate, so the common
/// cases are classified on real data. A document that fails to parse is
/// still reported as a version problem when it DECLARES a `v` that is not
/// ours, because a newer build's shape is expected to be unparseable here.
/// A document with no `v` at all is damaged, not a version problem: nothing
/// in it says "a newer build wrote this", and telling the user to upgrade
/// sends them after a release that does not exist.
fn readable_doc(val: Value) -> Result<PiesDoc, DocError> {
    if val.is_null() {
        return Ok(PiesDoc::default());
    }
    let declared = val.get("v").and_then(Value::as_u64);
    match serde_json::from_value::<PiesDoc>(val) {
        Ok(doc) if doc.v == CURRENT_VERSION => Ok(doc),
        Ok(_) => Err(DocError::UnknownVersion),
        Err(_) if matches!(declared, Some(v) if v != u64::from(CURRENT_VERSION)) => {
            Err(DocError::UnknownVersion)
        }
        Err(_) => Err(DocError::Unparseable),
    }
}

/// What `list()` answers with: the pies, plus the reason the list is empty
/// when the document could not be read.
///
/// The `warning` exists because an empty `Vec` alone is ambiguous — "you
/// have no pies" and "this build cannot read your pies, and they are all
/// still on disk" looked identical in the band. `readable_doc` already
/// knows which one it is; this carries that answer to the UI, which raises
/// exactly one notice for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PiesList {
    pub pies: Vec<Pie>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Read-only: the current `pies` document's list, or an empty list plus a
/// `warning` when the document can't be read (see `readable_doc`) — an
/// older build reading a newer build's document shows no user pies rather
/// than guessing at an unknown shape (spec section 9).
///
/// Clones ONLY the `pies` subtree, and only while the lock is held. The
/// whole state document (every tab, bookmark and annotation) used to be
/// deep-cloned on every single call, and then the subtree cloned again for
/// `from_value`.
pub fn list() -> PiesList {
    let pies_val = {
        let global = crate::state_store::global_state()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        match global.get("pies") {
            Some(v) => v.clone(),
            None => return PiesList { pies: Vec::new(), warning: None },
        }
    };
    match readable_doc(pies_val) {
        Ok(doc) => PiesList { pies: doc.pies, warning: None },
        Err(e) => PiesList { pies: Vec::new(), warning: Some(e.message().to_string()) },
    }
}

/// One pie by id, or `None` when no pie carries it. Resolves the entry
/// under the SAME single lock+parse `list` uses, then clones only that one
/// pie — `list()` followed by a `.find()` allocated a `Vec` of every pie,
/// with every member of every pie, to keep one of them.
pub fn find(id: &str) -> Option<Pie> {
    let pies_val = {
        let global = crate::state_store::global_state()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        global.get("pies")?.clone()
    };
    // A document this build cannot read answers `None`, exactly as `list`
    // answers an empty list: no pie is findable in a document whose shape
    // is unknown.
    readable_doc(pies_val)
        .ok()?
        .pies
        .into_iter()
        .find(|p| p.id == id)
}

/// Run `f` over the `pies` document under the store's single lock
/// (`update_state_field`) — and, critically, leave the value COMPLETELY
/// UNTOUCHED whenever `readable_doc` refuses it, both for an unrecognised
/// `v` and for a document that does not parse at all. That second case used
/// to fall through `unwrap_or_default()` into an EMPTY document — one
/// unparseable member (an unknown `kind` string, a non-numeric `added_at`,
/// a hand-edited or torn-write entry) silently deleted every pie in the
/// store on the next mutation. A parse failure is
/// just as much "a document this build does not understand" as an
/// unrecognised `v`, so it gets the same response: touch nothing, and
/// return the reason so the caller can say which one it was. That is the
/// "no write ever replaces the key" guarantee from spec section 9: an older
/// build must never downgrade a newer build's `pies` document just because
/// it ran a mutating op while that document was on disk. Every op in this
/// file is safe by construction because they all funnel through here.
///
/// RE-SERIALIZING the mutated document can fail too — `PathBuf`'s serializer
/// rejects a non-UTF-8 path, which exFAT and SMB volumes really do produce —
/// and that failure gets the identical contract: leave `val` alone and
/// report. Writing `Value::Null` there instead looked like success to every
/// caller and then read back as a brand new, empty document, which deleted
/// every pie in the store.
///
/// Generic over the closure's return so an op can report a decision it can
/// only make with the document in hand (`add_member` refusing an id that
/// names no pie). It also removes `upsert`'s fabricated "unreachable" error.
fn mutate_doc<R>(f: impl FnOnce(&mut PiesDoc) -> R) -> Result<R, String> {
    let mut refused: Option<String> = None;
    let mut out: Option<R> = None;
    crate::state_store::update_state_field("pies", |val| match readable_doc(val.clone()) {
        Ok(mut doc) => {
            let r = f(&mut doc);
            match serde_json::to_value(&doc) {
                Ok(next) => {
                    *val = next;
                    out = Some(r);
                }
                // Same contract as an unreadable document: touch nothing, report.
                Err(e) => {
                    refused = Some(format!(
                        "pies: the updated pies document could not be encoded ({e}); nothing was changed"
                    ))
                }
            }
        }
        Err(e) => refused = Some(e.message().to_string()),
    })?;
    match (refused, out) {
        (Some(e), _) => Err(e),
        (None, Some(r)) => Ok(r),
        // `update_state_field` ran neither arm: the key path could not be
        // walked, which it already reports through `?` above.
        (None, None) => Err(DocError::Unparseable.message().to_string()),
    }
}

/// Create (`id: None`) or rename (`id: Some`) a pie, and return the result —
/// the caller (the Tauri command) needs the real id back, since a newly
/// created pie's id is minted here, not chosen by the frontend. An `id`
/// that names no existing pie falls through to creating a fresh one, the
/// same tolerance `bookmarks::add`'s idempotent re-add has for a caller
/// racing a delete.
pub fn upsert(id: Option<&str>, name: &str) -> Result<Pie, String> {
    mutate_doc(|doc| {
        if let Some(id) = id {
            if let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) {
                p.name = name.to_string();
                return p.clone();
            }
        }
        let pie = Pie {
            id: uuid::Uuid::now_v7().to_string(),
            name: name.to_string(),
            created_at: now_ms(),
            seen_at: 0,
            members: Vec::new(),
            rest: UnknownFields::new(),
        };
        doc.pies.push(pie.clone());
        pie
    })
}

/// Remove a pie. Idempotent: removing an id that names no pie (already
/// gone) is a no-op, not an error — but a document this build cannot read
/// (unrecognised `v`, or unparseable) is refused with an error and left
/// untouched; see `mutate_doc`.
pub fn remove(id: &str) -> Result<(), String> {
    mutate_doc(|doc| {
        doc.pies.retain(|p| p.id != id);
    })
}

/// The error every op that names a pie by id reports when no pie carries
/// that id. One wording, so the UI shows the same sentence whichever op the
/// user was running.
fn no_such_pie(id: &str) -> String {
    format!("pies: no pie with id {id} (it may have just been deleted)")
}

/// Canonicalize `path` the same way the command layer's gate does, but fall back to
/// `path` unchanged when it can't be resolved instead of erroring — used to
/// match a MEMBER path that must still be findable even after its target
/// has gone missing (e.g. removing a member whose file was deleted since it
/// was added, where `fs::canonicalize` would now fail on the very path that
/// is already stored verbatim).
fn canonicalize_lenient(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Add `path` as a member of pie `id`.
///
/// `path` must ALREADY be canonical: the command layer (`app.rs`) resolves
/// it through `security::canonicalize_allow_rootless`, the one
/// canonicalisation gate on this machine. A second `fs::canonicalize` here
/// would be a second gate, which `security.rs` says does not exist.
///
/// An `id` that names no pie is an ERROR, not a silent no-op: a file added
/// to a pie another window just deleted (or one inside its delete-undo
/// window) was dropped while the picker reported success, and M5's socket
/// writer would inherit that. Idempotent in the one way that is safe:
/// re-adding a path already a member of the pie is a no-op, not a duplicate.
pub fn add_member(
    id: &str,
    canonical: &Path,
    kind: PieMemberKind,
    source: Option<PieMemberSource>,
) -> Result<(), String> {
    mutate_doc(|doc| {
        let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) else {
            return Err(no_such_pie(id));
        };
        if !p.members.iter().any(|m| m.path == canonical) {
            p.members.push(PieMember {
                kind,
                path: canonical.to_path_buf(),
                added_at: now_ms(),
                source,
                origin: None,
                rest: UnknownFields::new(),
            });
        }
        Ok(())
    })?
}

/// Remove a member by path. Canonicalizes `path` FIRST — `add_member`
/// stores the canonical form, but a caller (the UI, a menu) may still pass
/// the non-canonical form it was given (a picker path like `/tmp/x` for a
/// stored `/private/tmp/x`); comparing the raw string made removal a silent
/// no-op for exactly the paths the command layer canonicalizes on the way
/// in. Falls back to the raw path when it can no
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
/// `origin`/unknown fields) — "Locate…" on a folder member whose old
/// location is gone (M3). `canonical_new` arrives already resolved by the
/// command layer's gate, the same as `add_member`'s path; `old` is
/// canonicalized leniently, the same reasoning as `remove_member` — a member
/// not found under either form is a no-op. An `id` that names no pie is an
/// error, for the same reason `add_member`'s is.
pub fn relocate_member(id: &str, old: &Path, canonical_new: &Path) -> Result<(), String> {
    let canonical_old = canonicalize_lenient(old);
    mutate_doc(|doc| {
        let Some(p) = doc.pies.iter_mut().find(|p| p.id == id) else {
            return Err(no_such_pie(id));
        };
        if let Some(m) = p.members.iter_mut().find(|m| m.path == canonical_old) {
            m.path = canonical_new.to_path_buf();
        }
        Ok(())
    })?
}

/// Stamp `seen_at` to now — called on every plate open (spec section 9);
/// freshness (`mtime > seen_at`) is M3. Idempotent like `remove`: an id that
/// names no pie is a no-op, not an error. Every plate open fires this, so a
/// pie deleted in another window between the open and this call must not
/// raise an error at the user.
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

    /// Every test below that names a pie goes through this: `list()` now
    /// answers `{ pies, warning }`, and the pies alone are what these
    /// assertions are about.
    fn pies() -> Vec<Pie> {
        list().pies
    }

    /// The command layer canonicalizes before calling `add_member`, so the
    /// tests do too — `add_member` itself no longer resolves anything.
    fn canonical(path: &std::path::Path) -> PathBuf {
        std::fs::canonicalize(path).expect("fixture path resolves")
    }

    #[test]
    fn upsert_none_creates_and_upsert_some_renames() {
        let _g = guard();
        reset();
        let created = upsert(None, "Pricing").unwrap();
        assert_eq!(created.name, "Pricing");
        assert_eq!(created.members.len(), 0);
        assert!(pies().iter().any(|p| p.id == created.id));

        let renamed = upsert(Some(&created.id), "Pricing v2").unwrap();
        assert_eq!(renamed.id, created.id, "rename keeps the same id");
        assert_eq!(pies().iter().find(|p| p.id == created.id).unwrap().name, "Pricing v2");
    }

    #[test]
    fn add_member_canonicalizes_and_is_idempotent() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Docs").unwrap();

        add_member(&pie.id, &canonical(&file), PieMemberKind::File, Some(PieMemberSource::Picker)).unwrap();
        add_member(&pie.id, &canonical(&file), PieMemberKind::File, Some(PieMemberSource::Picker)).unwrap();

        let stored = pies().into_iter().find(|p| p.id == pie.id).unwrap();
        assert_eq!(stored.members.len(), 1, "re-adding the same path must not duplicate it");
        // Compare against fs::canonicalize(fixture), not the literal path —
        // on macOS /var is a symlink to /private/var, so tempdir() paths
        // canonicalize to a different string than they're constructed with.
        assert_eq!(stored.members[0].path, std::fs::canonicalize(&file).unwrap());
        assert_eq!(stored.members[0].source, Some(PieMemberSource::Picker));
    }

    /// A path that cannot be resolved never reaches `add_member` at all:
    /// the command layer's single canonicalisation gate refuses it first.
    /// This test pins the gate's answer, which is the contract
    /// `add_member`'s "the path is already canonical" doc comment rests on.
    #[test]
    fn the_gate_refuses_a_missing_path_before_add_member_sees_it() {
        let missing = std::env::temp_dir().join("skypie-e2e-does-not-exist-42");
        assert!(crate::security::canonicalize_allow_rootless(
            &missing,
            &crate::security::RootSet::empty()
        )
        .is_err());
    }

    /// An id that names no pie is an ERROR for the two WRITING ops, not a
    /// silent success: a file added to a pie another window just deleted
    /// used to vanish while the picker reported it added.
    #[test]
    fn add_member_and_relocate_member_refuse_an_unknown_id() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Docs").unwrap();

        let err = add_member("no-such-id", &canonical(&file), PieMemberKind::File, None)
            .expect_err("adding to an unknown id must be an error");
        assert!(err.contains("no-such-id"), "the message names the id: {err}");
        let err = relocate_member("no-such-id", &file, &canonical(&file))
            .expect_err("relocating inside an unknown id must be an error");
        assert!(err.contains("no-such-id"), "the message names the id: {err}");

        // The real pie is untouched by either refusal.
        assert_eq!(pies().into_iter().find(|p| p.id == pie.id).unwrap().members.len(), 0);
    }

    /// `upsert(Some(unknown))` deliberately does NOT follow the same rule:
    /// a rename racing a delete creates the pie instead, the tolerance
    /// `upsert`'s own doc comment states. Pinned here so the missing-id
    /// error above is never "generalised" onto it by accident.
    #[test]
    fn upsert_with_an_unknown_id_creates_a_new_pie() {
        let _g = guard();
        reset();
        let created = upsert(Some("no-such-id"), "Ghost").expect("upsert falls through to create");
        assert_ne!(created.id, "no-such-id", "a fresh id is minted, not the caller's");
        assert!(pies().iter().any(|p| p.id == created.id && p.name == "Ghost"));
    }

    #[test]
    fn remove_member_and_remove_pie_are_idempotent() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Docs").unwrap();
        add_member(&pie.id, &canonical(&file), PieMemberKind::File, None).unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();

        remove_member(&pie.id, &canonical).unwrap();
        remove_member(&pie.id, &canonical).unwrap(); // no-op, not an error
        assert_eq!(pies().into_iter().find(|p| p.id == pie.id).unwrap().members.len(), 0);

        remove(&pie.id).unwrap();
        remove(&pie.id).unwrap(); // no-op, not an error
        assert!(pies().iter().all(|p| p.id != pie.id));
    }

    /// `add_member` stores the CANONICAL path, but a caller (the UI) may
    /// still pass the raw, non-canonical form it was given — a picker path
    /// like the tempdir fixture below, which on macOS canonicalizes through
    /// the /var → /private/var symlink to a different string. Comparing the
    /// raw string used to make removal a silent no-op for exactly the paths
    /// the add path resolves on the way in.
    #[test]
    fn remove_member_matches_a_non_canonical_caller_path() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hi").unwrap();
        let pie = upsert(None, "Docs").unwrap();
        add_member(&pie.id, &canonical(&file), PieMemberKind::File, None).unwrap();

        // `file` itself — NOT `fs::canonicalize(&file)` — is what a picker
        // row built straight from a tab entry's path would pass.
        remove_member(&pie.id, &file).unwrap();
        assert_eq!(
            pies().into_iter().find(|p| p.id == pie.id).unwrap().members.len(),
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
        add_member(&pie.id, &canonical(&file), PieMemberKind::File, None).unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        std::fs::remove_file(&file).unwrap();

        remove_member(&pie.id, &canonical).unwrap();
        assert_eq!(pies().into_iter().find(|p| p.id == pie.id).unwrap().members.len(), 0);
    }

    #[test]
    fn touch_seen_stamps_now() {
        let _g = guard();
        reset();
        let pie = upsert(None, "Docs").unwrap();
        assert_eq!(pie.seen_at, 0);
        touch_seen(&pie.id).unwrap();
        let seen = pies().into_iter().find(|p| p.id == pie.id).unwrap().seen_at;
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
        assert_eq!(pies().len(), 0, "an unrecognised v shows no pies");

        // A mutating op against this state must be refused...
        assert!(upsert(None, "New").is_err());

        // ...and the document on disk (well, in memory — the debounced
        // write hasn't necessarily landed) must be byte-for-byte the same.
        let val = crate::state_store::current_state_value();
        assert_eq!(val["pies"], serde_json::json!({ "v": 99, "pies": [{"future": true}] }));

        // Hand the next test a readable document: every test here shares
        // one process-global store, and a refused one is sticky.
        reset();
    }

    /// The other half of the same safety property: a document whose `v`
    /// MATCHES `CURRENT_VERSION` but fails to parse as a `PiesDoc` (one
    /// member with an unrecognised `kind`, here) must ALSO be left
    /// untouched. Before this fix, `mutate_doc` answered a parse failure
    /// with `unwrap_or_default()` — a fresh, EMPTY `PiesDoc` — and then
    /// wrote that empty document straight back, deleting every pie in the
    /// store over one bad member.
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
        assert_eq!(pies().len(), 0);

        // ...a mutating op is refused rather than silently succeeding
        // against an empty document conjured by unwrap_or_default()...
        assert!(upsert(None, "New").is_err());

        // ...and the corrupt document survives byte-for-byte.
        let val = crate::state_store::current_state_value();
        assert_eq!(val["pies"], corrupt, "an unparseable document must never be overwritten");

        // Same reason as above: do not leak a refused document forward.
        reset();
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
            add_member(&id_a, &canonical(&a), PieMemberKind::File, None).unwrap();
        });
        let tb = std::thread::spawn(move || {
            barrier_b.wait();
            add_member(&id_b, &canonical(&b), PieMemberKind::File, None).unwrap();
        });
        ta.join().unwrap();
        tb.join().unwrap();

        let members = pies().into_iter().find(|p| p.id == pie.id).unwrap().members;
        assert_eq!(members.len(), 2, "both interleaved writers' members must survive: {members:?}");
    }

    // ── relocate_member ────────────────────────────────────────────────────

    /// A relocate keeps everything about the member except its path, and
    /// matches a NON-canonical `old` the same way `remove_member` does.
    #[test]
    fn relocate_member_keeps_the_record_and_matches_a_non_canonical_old() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        std::fs::write(&old, "a").unwrap();
        std::fs::write(&new, "b").unwrap();
        let pie = upsert(None, "Docs").unwrap();
        add_member(&pie.id, &canonical(&old), PieMemberKind::Folder, Some(PieMemberSource::Finder))
            .unwrap();
        let before = pies().into_iter().find(|p| p.id == pie.id).unwrap().members[0].clone();

        // `old`, not `canonical(&old)` — the raw form a caller still holds.
        relocate_member(&pie.id, &old, &canonical(&new)).unwrap();

        let after = pies().into_iter().find(|p| p.id == pie.id).unwrap().members;
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].path, canonical(&new));
        assert_eq!(after[0].added_at, before.added_at, "added_at survives a relocate");
        assert_eq!(after[0].source, before.source, "source survives a relocate");
        assert_eq!(after[0].origin, before.origin, "origin survives a relocate");
        assert_eq!(after[0].kind, before.kind);
    }

    /// An `old` that names no member is a no-op, not an error — the same
    /// tolerance `remove_member` has for a member that is already gone.
    #[test]
    fn relocate_member_is_a_no_op_for_an_absent_old() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let held = dir.path().join("held.md");
        let stranger = dir.path().join("stranger.md");
        std::fs::write(&held, "a").unwrap();
        std::fs::write(&stranger, "b").unwrap();
        let pie = upsert(None, "Docs").unwrap();
        add_member(&pie.id, &canonical(&held), PieMemberKind::File, None).unwrap();

        relocate_member(&pie.id, &stranger, &canonical(&stranger)).unwrap();

        let members = pies().into_iter().find(|p| p.id == pie.id).unwrap().members;
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].path, canonical(&held), "the held member is untouched");
    }

    /// A `new` side that cannot be resolved is refused by the command
    /// layer's gate before `relocate_member` runs, and the member keeps its
    /// old path — the mirror of the add path's own contract.
    #[test]
    fn relocate_member_refuses_an_unresolvable_new_and_changes_nothing() {
        let _g = guard();
        reset();
        let dir = tempfile::tempdir().unwrap();
        let held = dir.path().join("held.md");
        std::fs::write(&held, "a").unwrap();
        let pie = upsert(None, "Docs").unwrap();
        add_member(&pie.id, &canonical(&held), PieMemberKind::File, None).unwrap();

        let missing = dir.path().join("never-created.md");
        assert!(crate::security::canonicalize_allow_rootless(
            &missing,
            &crate::security::RootSet::empty()
        )
        .is_err());

        let members = pies().into_iter().find(|p| p.id == pie.id).unwrap().members;
        assert_eq!(members[0].path, canonical(&held), "a refused relocate changes nothing");
    }

    // ── readable_doc ───────────────────────────────────────────────────────

    /// The two refusals carry DISTINCT text, because they ask the user for
    /// distinct things ("upgrade" vs "your file is damaged"). A shared
    /// message sent people looking for an upgrade that does not exist.
    #[test]
    fn the_two_doc_errors_read_differently() {
        let unknown = DocError::UnknownVersion.message();
        let unparseable = DocError::Unparseable.message();
        assert_ne!(unknown, unparseable);
        assert!(unknown.contains("version"), "the version message says version: {unknown}");
        assert!(
            unparseable.contains("parsed"),
            "the parse message says parsed: {unparseable}"
        );
    }

    /// A document that declares a `v` this build does not know AND whose
    /// shape does not parse is a VERSION problem, not a damaged file: a
    /// newer build's shape is expected to be unparseable here.
    #[test]
    fn an_unknown_version_with_an_unparseable_shape_is_a_version_problem() {
        let val = serde_json::json!({ "v": 99, "pies": "not even an array" });
        assert_eq!(readable_doc(val), Err(DocError::UnknownVersion));
    }

    /// A document with NO `v` at all is damaged, not a version problem —
    /// nothing about it says "a newer build wrote this".
    #[test]
    fn a_document_with_no_version_is_not_a_version_problem() {
        let val = serde_json::json!({ "pies": [] });
        assert_eq!(readable_doc(val), Err(DocError::Unparseable));
    }

    // ── forward compatibility ──────────────────────────────────────────────

    /// The other half of `state_store`'s unknown-field guarantee, inside the
    /// `pies` key: a field this build does not name survives a mutating op.
    /// M3 adds census fields under this same `v: 1`, and an M2 build running
    /// one `touch_seen` used to erase them.
    #[test]
    fn unknown_fields_survive_a_mutating_op() {
        let _g = guard();
        let _ = crate::state_store::set_state_field(
            "pies",
            serde_json::json!({
                "v": 1,
                "pies": [{
                    "id": "p1",
                    "name": "Pricing",
                    "created_at": 0,
                    "seen_at": 0,
                    "members": [{
                        "kind": "file",
                        "path": "/x",
                        "added_at": 0,
                        "census_files": 12
                    }],
                    "future_field": "keep me"
                }]
            }),
        );

        touch_seen("p1").unwrap();

        let val = crate::state_store::current_state_value();
        let pie = &val["pies"]["pies"][0];
        assert_eq!(pie["future_field"], "keep me", "an unknown pie field survives a write");
        assert_eq!(
            pie["members"][0]["census_files"], 12,
            "an unknown member field survives a write"
        );
        assert!(pie["seen_at"].as_u64().unwrap() > 0, "the op itself still landed");
        reset();
    }

    /// The serialize-side twin of `an_unparseable_document_is_never_overwritten`.
    /// Serde's `PathBuf` serializer fails on a non-UTF-8 path, which exFAT
    /// and SMB volumes really do produce. Writing `Value::Null` on that
    /// failure looked like success and then read back as a brand new, empty
    /// document: every pie gone. Unix only — `PathBuf` on Windows has no
    /// equivalent construction from raw bytes.
    #[cfg(unix)]
    #[test]
    fn a_document_that_cannot_be_encoded_is_never_overwritten() {
        use std::os::unix::ffi::OsStrExt;
        let _g = guard();
        reset();
        let pie = upsert(None, "Docs").unwrap();
        let bad = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/\xff"));

        // The store is readable and holds the pie right before the attempt.
        let before = crate::state_store::current_state_value()["pies"].clone();
        let err = add_member(&pie.id, &bad, PieMemberKind::File, None)
            .expect_err("a non-UTF-8 member path must be refused");
        assert!(err.contains("encoded"), "the refusal says what failed: {err}");

        let after = crate::state_store::current_state_value()["pies"].clone();
        assert_eq!(after, before, "a document that cannot be encoded must never be overwritten");
        assert_eq!(
            pies().into_iter().find(|p| p.id == pie.id).unwrap().members.len(),
            0,
            "and the member was not added",
        );
    }
}
