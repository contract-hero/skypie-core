// Annotations — the comment store behind the paid feature.
//
// The format is a SUBSET of the W3C Web Annotation Data Model, in plain JSON:
// the property names and the selector vocabulary are the recommendation's,
// the JSON-LD `@context` machinery is not. Two reasons for borrowing it
// rather than inventing a shape. It already has the anchoring vocabulary a
// comment on a live-reloading file needs (`TextQuoteSelector` survives edits,
// `TextPositionSelector` is fast, `FragmentSelector` covers line ranges and
// image regions), and a language model asked to read a comment already knows
// what `motivation: "commenting"` means — which is the whole point of the
// hook that feeds these back to an agent.
//
// ── Storage ────────────────────────────────────────────────────────────────
//
//   <state_dir>/annotations/<blake3(portable path)>.jsonl  one entry per line
//   <state_dir>/annotations/index.json   store key -> { path, open, total }
//
// "Portable path" because iOS moves the app container UUID on every update:
// a file inside the state directory is keyed by where it sits, not by which
// container it sat in. A path outside the state directory keys unchanged.
//
// One file per TARGET, not per session. The question a consumer always asks
// is "what feedback exists on this file", and one read answers it. A session
// is then a query (same creator, same day, same `session` label), not a file.
//
// The file is APPEND-ONLY, which is what makes merging two devices a union by
// annotation id instead of a CRDT: each device appends only its own lines, so
// two files concatenated in any order fold to the same state. A status change
// is therefore not an edit — it is a new `assessing` entry pointing at the
// original, and the fold keeps the newest. History comes free.
//
// The store lives in the state directory and never beside the user's file:
// the read-only-tree principle holds, external files with no project still
// get comments, and iOS — which has no user tree at all — works unchanged.
// `export_sidecar` is the explicit escape hatch for people who want the
// feedback in git, and it is never automatic.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Cap on one annotations file. A comment store is text a human typed; a file
/// past this is a bug or a hostile peer's push, and refusing to append is
/// better than letting the sidebar read 200 MB on a badge refresh.
pub const MAX_STORE_BYTES: u64 = 8 * 1024 * 1024;

/// Cap on one comment body. Generous for prose, small enough that the wire
/// message carrying a review pass stays bounded.
pub const MAX_BODY_CHARS: usize = 10_000;

// ────────────────────────────────────────────────────────────────────────────
// The document
// ────────────────────────────────────────────────────────────────────────────

/// Who wrote a comment. The iroh node id and the sanitized device name the
/// peer store already holds — no accounts, no sign-in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Creator {
    /// `node:<hex>` for a device, or any opaque id a future author kind uses.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// The comment text. `TextualBody` is the only body type this build writes;
/// the field is kept so a document written by a richer build round-trips.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Body {
    #[serde(rename = "type", default = "textual_body")]
    pub kind: String,
    pub value: String,
}

fn textual_body() -> String {
    "TextualBody".to_string()
}

/// Where a comment points. Modelled loosely on purpose: `Selector` keeps an
/// `Other` arm so a selector kind this build does not understand survives a
/// read-modify-write instead of being silently dropped from the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Selector {
    /// Survives edits: the exact text plus enough context to find it again.
    TextQuoteSelector {
        exact: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        suffix: Option<String>,
    },
    /// Fast, and wrong the moment anything above it changes. Always stored
    /// WITH a quote selector, never instead of one.
    TextPositionSelector { start: usize, end: usize },
    /// `line=142` (RFC 5147) for text, `xywh=percent:31,18,4,4` (Media
    /// Fragments) for an image region. Percent coordinates on purpose: a pin
    /// dropped on a phone must land in the same place on a 27" display.
    FragmentSelector {
        #[serde(rename = "conformsTo", default, skip_serializing_if = "Option::is_none")]
        conforms_to: Option<String>,
        value: String,
    },
    #[serde(untagged)]
    Other(serde_json::Value),
}

/// The file a comment is about, and what it looked like at the time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    /// Absolute path, or `skypie-remote://<peer><path>` for a pulled file.
    pub source: String,
    /// `blake3:<hex>` of the file's bytes when the comment was made. The
    /// re-anchoring pass reads this first: an unchanged hash means every
    /// stored position is still exact and no search is needed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(default)]
    pub selector: Vec<Selector>,
}

/// Lifecycle of a thread. `Wontfix` exists so "I read it and I am not doing
/// it" is a distinct outcome from "still open" — an agent reading the hook's
/// context needs that distinction to stop re-raising it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Addressed,
    Wontfix,
}

impl Default for Status {
    fn default() -> Self {
        Status::Open
    }
}

/// Why this entry exists. The W3C motivation vocabulary, restricted to the
/// four this app writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Motivation {
    /// A root comment.
    Commenting,
    /// A reply in a thread (`in_reply_to` is set).
    Replying,
    /// A selection with no body — a pure highlight.
    Highlighting,
    /// A status change for the annotation in `in_reply_to`. Carries no new
    /// anchor; the fold reads only its `status`, `creator` and `created`.
    Assessing,
}

/// One line of a `.jsonl` store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    /// UUIDv7 — sortable by creation time, so a file read back in line order
    /// is already in chronological order without parsing timestamps.
    pub id: String,
    #[serde(rename = "type", default = "annotation_type")]
    pub kind: String,
    pub motivation: Motivation,
    /// RFC 3339, UTC.
    pub created: String,
    pub creator: Creator,
    /// Free-text grouping label ("2026-09-13/iphone-morning"). Optional: a
    /// session is a query over creator and day when this is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(rename = "inReplyTo", default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Body>,
    pub target: Target,
    /// Anything a newer build wrote. Kept so this build's fold-and-rewrite
    /// never truncates a document it did not fully understand.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

fn annotation_type() -> String {
    "Annotation".to_string()
}

// ────────────────────────────────────────────────────────────────────────────
// Paths
// ────────────────────────────────────────────────────────────────────────────

/// `<state_dir>/annotations/`.
pub fn annotations_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("annotations")
}

/// The store key for a target: BLAKE3 of the target's PORTABLE form, hex.
///
/// A hash rather than an escaped path because a path can be longer than any
/// filesystem's name limit, can contain `/` at every depth, and differs in
/// case sensitivity per volume. A fixed-width hex name has none of those
/// problems, and the index carries the human-readable path back.
///
/// Portable, not raw, for the reason `portable_path` exists at all: iOS moves
/// the app container UUID on every update, so a comment on a file INSIDE the
/// state directory — a pulled artifact under `remote/cache/`, a landed beam
/// under `received/` — would hash to a different name after that update and
/// the user's comments would read as gone. Hashing the `skypie-state:` form
/// keys those files by where they sit rather than by which container they sat
/// in. A path outside the state directory is returned unchanged by
/// `to_portable`, so a file on the Mac keys exactly as it did before.
/// Also CANONICAL, and for a reason the wire found: the scope gate
/// canonicalizes before the host store ever sees a path, so a peer's comments
/// landed under `/private/var/…` while the local UI — which passes the tab's
/// raw path — looked under `/var/…`. Two spellings, two stores, and a push
/// that answered `Merged { added: 3 }` while the rail stayed empty. Resolving
/// here settles which FILE the comments land in. Which `source` the entries
/// themselves claim is a second question, settled by the stamp in `merge` —
/// the two ends of a pull do not name one file the same way at all.
///
/// A path that cannot be canonicalized (it does not exist yet, or is a
/// `skypie-remote://` address rather than a file) keeps its original spelling —
/// there is nothing better to key it by, and refusing would lose the comment.
pub fn store_key(state_dir: &Path, source: &str) -> String {
    let canonical = std::fs::canonicalize(source)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| source.to_string());
    let portable = crate::portable_path::to_portable(&canonical, state_dir);
    blake3::hash(portable.as_bytes()).to_hex().to_string()
}

/// `<state_dir>/annotations/<key>.jsonl`.
pub fn store_path(state_dir: &Path, source: &str) -> PathBuf {
    annotations_dir(state_dir).join(format!("{}.jsonl", store_key(state_dir, source)))
}

/// `blake3:<hex>` of a file's current bytes, or `None` when it cannot be read.
/// Stored with every comment so re-anchoring can skip all searching when the
/// file has not changed since.
pub fn content_hash(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("blake3:{}", blake3::hash(&bytes).to_hex()))
}

// ────────────────────────────────────────────────────────────────────────────
// Reading
// ────────────────────────────────────────────────────────────────────────────

/// Read one target's store and fold it.
///
/// Returns the root comments and replies in file order (= chronological, by
/// UUIDv7), each carrying the status its newest `assessing` entry set.
/// `assessing` entries themselves are NOT returned: they are the event log,
/// not the state, and a UI that rendered them would show "addressed" as a
/// comment in the thread.
///
/// A line that does not parse is SKIPPED, not fatal. A half-written last line
/// from a killed process must not hide the fifty comments above it.
pub fn list(state_dir: &Path, source: &str) -> Vec<Annotation> {
    fold(raw(state_dir, source))
}

/// Read one target's store WITHOUT folding: every line, `assessing` entries
/// included, in file order.
///
/// This is what a reconcile compares. The fold is a view, and a status change
/// is a separate line with its own id: a peer that only ever received the
/// folded view would see "addressed" as a property its `merge` skips (the
/// root id already exists) and never learn of it.
pub fn raw(state_dir: &Path, source: &str) -> Vec<Annotation> {
    parse_lines(&read_store(state_dir, source))
}

/// The lines of one target's store that parse, as stored — what crosses the
/// wire. Every line is still parsed once, to drop the ones this build cannot
/// read; what is skipped is the fold and the re-serialize, and the bytes on
/// the wire are the bytes on disk. A dropped line decides what every peer
/// never learns exists, so the count is logged.
pub fn raw_lines(state_dir: &Path, source: &str) -> Vec<String> {
    let text = read_store(state_dir, source);
    let mut skipped = 0usize;
    let out: Vec<String> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter(|l| {
            let ok = serde_json::from_str::<Annotation>(l).is_ok();
            if !ok {
                skipped += 1;
            }
            ok
        })
        .map(str::to_string)
        .collect();
    if skipped > 0 {
        eprintln!("skypie: {skipped} unreadable line(s) in the comment store for {source} not served");
    }
    out
}

/// The whole store file, or empty.
///
/// An absent store is empty by definition. Any other read error is LOGGED
/// and still read as empty — a `reindex` on this path then deletes the
/// file's index row, and the comments stay on disk with no badge. `merge`
/// reads the file itself and refuses instead, because duplicating a store
/// is worse than losing a badge.
fn read_store(state_dir: &Path, source: &str) -> String {
    match std::fs::read_to_string(store_path(state_dir, source)) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            eprintln!("skypie: cannot read the comment store for {source}: {e}");
            String::new()
        }
    }
}

/// The entries of `mine` that `theirs` has never seen, by id.
///
/// Ids are UUIDv7 minted on one device each, so an id present on both sides
/// is the same entry, and an append-only store never edits one — a set
/// difference is the whole algorithm. Running it after both sides have
/// merged yields nothing, which is what lets a poll call it blindly — as
/// long as `theirs` is COMPLETE. A truncated page (the wire caps one at
/// `MAX_ANNOTATION_ENTRIES`) is a prefix, not a set, and would keep
/// reporting the same entries as unseen; `reconcile` never calls this on one.
pub fn unseen(mine: &[Annotation], theirs: &[Annotation]) -> Vec<Annotation> {
    let known: std::collections::HashSet<&str> = theirs.iter().map(|a| a.id.as_str()).collect();
    mine.iter().filter(|a| !known.contains(a.id.as_str())).cloned().collect()
}

/// What one reconcile pass with a host produced, before the push.
pub struct Reconciled {
    /// Host entries this store had not seen; already on disk.
    pub pulled: usize,
    /// Local lines the host lacks, framed for `PutAnnotations`. Empty when
    /// the host's page was a prefix.
    pub outgoing: Vec<String>,
}

/// The store half of one reconcile pass: merge the host's page into
/// `source`, then frame what the host lacks.
///
/// Pure with respect to the wire, so the ordering that makes the sync
/// two-way — `unseen` computed against the store as it was BEFORE the merge
/// — is testable with two stores in one directory. `complete` is the
/// negation of the page's `truncated`: a prefix is not a set, so on a
/// truncated page the pull still lands but nothing is pushed, or the reader
/// would re-send every entry past the host's cut on every pass forever.
///
/// The caller must `notify` on `Err` as well as on `pulled > 0`: `merge`
/// appends before it reindexes, so a failure may have landed lines.
pub fn reconcile(
    state_dir: &Path,
    source: &str,
    page: &[String],
    complete: bool,
) -> Result<Reconciled, String> {
    let mut unreadable = 0usize;
    let remote: Vec<Annotation> = page
        .iter()
        // A line this build cannot read is dropped, as a local read drops it —
        // deliberately NOT the host's all-or-nothing rule at `put`: there the
        // peer is told what failed, here there is nobody to tell, and refusing
        // the page would strand the tab on a host one version ahead.
        .filter_map(|raw| match serde_json::from_str::<Annotation>(raw) {
            Ok(a) => Some(a),
            Err(_) => {
                unreadable += 1;
                None
            }
        })
        .collect();
    if unreadable > 0 {
        eprintln!("skypie: {unreadable} comment(s) from the host of {source} are not readable by this build");
    }

    // Before the merge, or every just-pulled entry would look unseen and be
    // echoed straight back to the host.
    let local = raw(state_dir, source);
    let pulled = merge(state_dir, source, &remote)?;

    if !complete {
        eprintln!(
            "skypie: the host's comment page for {source} is a prefix (over {} lines); the push is skipped",
            skypie_remote::proto::MAX_ANNOTATION_ENTRIES
        );
        return Ok(Reconciled { pulled, outgoing: Vec::new() });
    }

    let framed = unseen(&local, &remote)
        .into_iter()
        // One frame per pass. A backlog larger than the wire's cap goes out
        // over the next passes; each pass shrinks it.
        .take(skypie_remote::proto::MAX_ANNOTATION_ENTRIES)
        .map(|a| serde_json::to_string(&a))
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| format!("a local comment cannot be encoded for the wire: {e}"))?;
    // One entry the wire would refuse (over `MAX_ANNOTATION_BYTES`, or a
    // newline) must not stall every other comment behind it for the life of
    // the tab: it is left out of the frame, and the count is logged.
    let (outgoing, rejected): (Vec<String>, Vec<String>) = framed
        .into_iter()
        .partition(|e| skypie_remote::proto::check_entries(std::slice::from_ref(e)).is_ok());
    if !rejected.is_empty() {
        eprintln!("skypie: {} local comment(s) on {source} cannot be framed for the wire", rejected.len());
    }
    Ok(Reconciled { pulled, outgoing })
}

fn parse_lines(raw: &str) -> Vec<Annotation> {
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Annotation>(l).ok())
        .collect()
}

/// Apply every `assessing` entry to the annotation it points at, then drop
/// the assessments.
///
/// The NEWEST assessment wins, decided by entry id and not by position in the
/// file. Ids are UUIDv7, so a greater id is a later assessment — which is the
/// only thing that survives a merge, because `merge` appends a peer's entries
/// at the end of the file whatever their timestamps say. Deciding by position
/// meant a stale `wontfix` synced from a phone could permanently re-close a
/// thread the Mac had reopened hours later, with no way to correct it in an
/// append-only store.
fn fold(entries: Vec<Annotation>) -> Vec<Annotation> {
    let mut statuses: HashMap<String, (String, Status)> = HashMap::new();
    for e in &entries {
        if e.motivation == Motivation::Assessing {
            if let Some(target_id) = &e.in_reply_to {
                statuses
                    .entry(target_id.clone())
                    .and_modify(|slot| {
                        if e.id > slot.0 {
                            *slot = (e.id.clone(), e.status);
                        }
                    })
                    .or_insert_with(|| (e.id.clone(), e.status));
            }
        }
    }
    entries
        .into_iter()
        .filter(|e| e.motivation != Motivation::Assessing)
        .map(|mut e| {
            if let Some((_, s)) = statuses.get(&e.id) {
                e.status = *s;
            }
            e
        })
        .collect()
}

/// A root thread — an annotation that answers nothing.
pub fn is_root(a: &Annotation) -> bool {
    a.in_reply_to.is_none()
}

/// A thread still waiting on someone. THE definition, in one place: `Status`
/// can gain a variant, and when it does there must be exactly one site that
/// decides what "open" means, not three that each decide again.
pub fn is_open_root(a: &Annotation) -> bool {
    is_root(a) && a.status == Status::Open
}

/// `(open, total)` root counts from an ALREADY-FOLDED list.
///
/// Takes the list rather than a path because every caller has just folded it.
/// Re-reading and re-parsing a file to count what you are already holding was
/// the most repeated waste in this module's call graph.
pub fn counts(folded: &[Annotation]) -> (usize, usize) {
    (
        folded.iter().filter(|a| is_open_root(a)).count(),
        folded.iter().filter(|a| is_root(a)).count(),
    )
}

/// Count of root comments still `open` on a target.
pub fn open_count(state_dir: &Path, source: &str) -> usize {
    counts(&list(state_dir, source)).0
}

// ────────────────────────────────────────────────────────────────────────────
// Writing
// ────────────────────────────────────────────────────────────────────────────

/// Append one annotation to its target's store, then refresh the index entry.
///
/// Append rather than read-modify-write: `O_APPEND` on a single `write` of a
/// line under the pipe-buffer size is atomic on the platforms this ships to,
/// so two processes appending — the app and, later, a peer push landing —
/// cannot interleave a half line.
pub fn append(state_dir: &Path, annotation: &Annotation) -> Result<(), String> {
    let line = encode_line(annotation)?;
    let source = &annotation.target.source;
    // Same lock `merge` takes: a local comment landing between a merge's read
    // and its reindex would have the merge overwrite the index row with a
    // count computed from a store that was missing this line.
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    open_store(state_dir, source)?
        .write_all(line.as_bytes())
        .map_err(|e| format!("cannot append to the comment store: {e}"))?;
    reindex(state_dir, source)
}

/// One annotation as the single `.jsonl` line that represents it, validated.
///
/// Shared by `append` and `merge` so the size rule and the one-line framing
/// are decided once. A stored line must never contain a newline of its own,
/// or one entry becomes two unparseable ones — `to_string` (not
/// `to_string_pretty`) guarantees that, and serde escapes any newline inside
/// a body value.
fn encode_line(annotation: &Annotation) -> Result<String, String> {
    if let Some(body) = &annotation.body {
        if body.value.chars().count() > MAX_BODY_CHARS {
            return Err(format!("comment is longer than {MAX_BODY_CHARS} characters"));
        }
    }
    let mut line = serde_json::to_string(annotation).map_err(|e| e.to_string())?;
    debug_assert!(!line.contains('\n'));
    line.push('\n');
    Ok(line)
}

/// The target's store, opened for appending, with the size cap enforced.
fn open_store(state_dir: &Path, source: &str) -> Result<std::fs::File, String> {
    let dir = annotations_dir(state_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let path = store_path(state_dir, source);
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= MAX_STORE_BYTES {
            return Err("the comment store for this file is full".to_string());
        }
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))
}

/// Set a thread's status by appending an `assessing` entry that points at it.
/// `note` becomes the entry's body, so "why it was closed" is recorded next
/// to the fact that it was.
pub fn set_status(
    state_dir: &Path,
    source: &str,
    annotation_id: &str,
    status: Status,
    note: Option<String>,
    creator: Creator,
) -> Result<Annotation, String> {
    // Same read-then-append shape as `merge`, so the same lock: without it a
    // concurrent write lands between the existence check and the reindex.
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    // The fold done for the existence check is the same fold `reindex` needs
    // afterwards, so it is kept and handed on rather than recomputed.
    let mut folded = list(state_dir, source);
    if !folded.iter().any(|a| a.id == annotation_id) {
        return Err(format!("no comment {annotation_id} on this file"));
    }
    let entry = Annotation {
        id: new_id(),
        kind: annotation_type(),
        motivation: Motivation::Assessing,
        created: now_rfc3339(),
        creator,
        session: None,
        in_reply_to: Some(annotation_id.to_string()),
        status,
        body: note.map(|value| Body { kind: textual_body(), value }),
        // An assessment inherits the target but anchors nothing: it is about
        // the comment, not about a place in the file.
        target: Target { source: source.to_string(), hash: None, selector: Vec::new() },
        extra: HashMap::new(),
    };
    let line = encode_line(&entry)?;
    open_store(state_dir, source)?
        .write_all(line.as_bytes())
        .map_err(|e| format!("cannot append to the comment store: {e}"))?;

    // Apply the assessment to the fold already in hand instead of re-reading
    // and re-folding the file a second time.
    if let Some(target) = folded.iter_mut().find(|a| a.id == annotation_id) {
        target.status = status;
    }
    reindex_from(state_dir, source, &folded)?;
    Ok(entry)
}

/// Merge foreign entries into a target's store, ignoring ids already present.
///
/// Every accepted entry is STAMPED with `source`: the entry's own
/// `target.source` is discarded (the comment in the body says why). This is
/// what a peer's push and a reader's pull both land through, and why the
/// format is append-only: a union by id needs no ordering guarantee and no
/// conflict resolution. Returns how many entries were new.
pub fn merge(state_dir: &Path, source: &str, incoming: &[Annotation]) -> Result<usize, String> {
    // Read and append must not interleave. Two peers pushing the same frame on
    // two sessions both read before either appended, both saw every id as new,
    // and both appended — and in an append-only store a duplicate is forever.
    // `append` takes the same lock, so a local comment cannot land between a
    // merge's read and its reindex either.
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    let mut known: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Only an ABSENT store may read as empty. An unreadable-but-present one
    // would make every incoming id look new and duplicate the whole file.
    let raw = match std::fs::read_to_string(store_path(state_dir, source)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("cannot read the comment store: {e}")),
    };
    let mut existing = parse_lines(&raw);
    known.extend(existing.iter().map(|a| a.id.clone()));

    // Serialize the whole batch first, so a malformed entry or an over-long
    // body is caught before ANY of it reaches disk. A push is one message
    // from one device; landing half of it and failing is worse than landing
    // none of it.
    let mut lines = String::new();
    let mut accepted: Vec<Annotation> = Vec::new();
    for entry in incoming {
        // A duplicate id, or a second copy inside this same batch.
        if !known.insert(entry.id.clone()) {
            continue;
        }
        // The store an entry lands in is THIS `source`, whatever the entry
        // claims: the two ends of a pull name one file differently (the host
        // by its absolute path, the reader by `skypie-remote://<peer><path>`),
        // and the host's gate canonicalizes while the reader's link may not.
        // Stamping here keeps each file self-consistent without any boundary
        // having to remember a rewrite. A peer still cannot scatter comments:
        // `source` is the caller's, never the entry's.
        let mut entry = entry.clone();
        entry.target.source = source.to_string();
        lines.push_str(&encode_line(&entry)?);
        accepted.push(entry);
    }
    if accepted.is_empty() {
        return Ok(0);
    }

    // ONE append and ONE reindex for the batch. Doing both per entry meant a
    // 500-entry push re-read and re-parsed the whole store 500 times and
    // rewrote the index 500 times — see `MAX_ANNOTATION_ENTRIES` on the wire.
    open_store(state_dir, source)?
        .write_all(lines.as_bytes())
        .map_err(|e| format!("cannot append to the comment store: {e}"))?;

    let added = accepted.len();
    existing.append(&mut accepted);
    reindex_from(state_dir, source, &fold(existing))?;
    Ok(added)
}

/// Write a target's folded annotations beside the file itself, as
/// `<file>.comments.jsonl`. Explicit action only — see the module header.
pub fn export_sidecar(state_dir: &Path, source: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(source);
    if !target.is_absolute() {
        return Err("can only export beside a local file".to_string());
    }
    let name = target
        .file_name()
        .ok_or_else(|| "the target has no file name".to_string())?
        .to_string_lossy()
        .into_owned();
    let dest = target.with_file_name(format!("{name}.comments.jsonl"));

    let mut out = String::new();
    for a in list(state_dir, source) {
        out.push_str(&serde_json::to_string(&a).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    std::fs::write(&dest, out).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    Ok(dest)
}

// ────────────────────────────────────────────────────────────────────────────
// Index
// ────────────────────────────────────────────────────────────────────────────

/// One row of `index.json`: what the sidebar badges and what the Claude Code
/// hook short-circuits on, both without opening a single `.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexEntry {
    pub source: String,
    pub open: usize,
    pub total: usize,
    pub updated_at: u64,
}

fn index_path(state_dir: &Path) -> PathBuf {
    annotations_dir(state_dir).join("index.json")
}

/// Every target that has ever had a comment, newest activity first.
pub fn index(state_dir: &Path) -> Vec<IndexEntry> {
    let raw = std::fs::read_to_string(index_path(state_dir)).unwrap_or_default();
    let map: HashMap<String, IndexEntry> = serde_json::from_str(&raw).unwrap_or_default();
    let mut rows: Vec<IndexEntry> = map
        .into_values()
        // Stored portable, handed out absolute — the caller compares these
        // against a live tab path. Mirrors what `state_store::load` does.
        .map(|mut row| {
            row.source = crate::portable_path::to_absolute(&row.source, state_dir);
            row
        })
        .collect();
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    rows
}

/// Serializes the index's read-modify-write.
///
/// Appending to two DIFFERENT targets at once is normal — the user comments
/// while a peer push merges — and both then rewrite this one shared file.
/// Without the lock, two writers staged the same temp path and the first
/// rename took the file out from under the second, which failed with ENOENT;
/// on a luckier interleaving one writer's row simply vanished. The temp name
/// is also unique per write, so a crash between the two steps cannot leave a
/// half-written file that the next writer renames into place.
///
/// Process-wide is enough: the app socket admits one app instance per state
/// directory, and the index is derived state that can be deleted and rebuilt.
static INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Serializes a store's read-modify-append.
///
/// `append` is a single `O_APPEND` write and needs no help on its own, but
/// `merge` reads the whole store to build its id set BEFORE appending, and
/// nothing about `O_APPEND` makes that pair atomic. Two merges of the same
/// frame — one peer, two of its `MAX_SESSIONS_PER_PEER` sessions — both read
/// before either wrote, both found every id new, and both appended. The store
/// is append-only, so those duplicates could never be removed.
///
/// One global lock rather than one per target: a comment write is a human
/// typing, the critical section is a few milliseconds of file I/O, and a
/// keyed map of mutexes would be more machinery than the contention justifies.
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Recompute one target's row from its store. Called after every append, so
/// the index is derived state that can be deleted and rebuilt at any time.
fn reindex(state_dir: &Path, source: &str) -> Result<(), String> {
    reindex_from(state_dir, source, &list(state_dir, source))
}

/// `reindex` for a caller that has already folded the store — which, inside
/// this module, every caller has. Saves a read and a full parse per write.
fn reindex_from(state_dir: &Path, source: &str, folded: &[Annotation]) -> Result<(), String> {
    let (open, total) = counts(folded);

    let path = index_path(state_dir);
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    let mut map: HashMap<String, IndexEntry> = serde_json::from_str(&raw).unwrap_or_default();

    if total == 0 {
        map.remove(&store_key(state_dir, source));
    } else {
        map.insert(
            store_key(state_dir, source),
            // Portable for the same reason `store_key` is: an absolute path
            // recorded here is dead after the next iOS container move, and
            // every badge that compares against it would read 0. `index()`
            // resolves it back against the state dir this launch has.
            IndexEntry {
                source: crate::portable_path::to_portable(source, state_dir),
                open,
                total,
                updated_at: skypie_ipc::now_unix(),
            },
        );
    }

    let json = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    // Unique per WRITE. `process::id()` alone is constant for the life of the
    // process, so it separates processes and nothing else; the counter is what
    // keeps two writes off the same staged path.
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.tmp.{}.{seq}", std::process::id()));
    std::fs::write(&tmp, json).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cannot replace the index: {e}"))
}

// ────────────────────────────────────────────────────────────────────────────
// Construction helpers
// ────────────────────────────────────────────────────────────────────────────

/// A fresh UUIDv7. Time-ordered, so ids sort the way the comments were made.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Current time as RFC 3339 in UTC, to the second.
///
/// Hand-rolled from a unix timestamp rather than pulling `chrono` in for one
/// format: the app already carries `now_unix` on the IPC contract, and a date
/// library is a large dependency for a string this shape.
pub fn now_rfc3339() -> String {
    format_rfc3339(skypie_ipc::now_unix())
}

fn format_rfc3339(unix: u64) -> String {
    let secs = unix % 60;
    let mins = (unix / 60) % 60;
    let hours = (unix / 3600) % 24;
    let days = unix / 86_400;

    // Civil-from-days (Howard Hinnant's algorithm), shifted to a 0000-03-01
    // era so leap years need no special case.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hours:02}:{mins:02}:{secs:02}Z")
}

/// Build a root comment on `source` with the given anchors.
pub fn comment(
    source: &str,
    body: String,
    selector: Vec<Selector>,
    creator: Creator,
    session: Option<String>,
) -> Annotation {
    Annotation {
        id: new_id(),
        kind: annotation_type(),
        motivation: if body.trim().is_empty() {
            Motivation::Highlighting
        } else {
            Motivation::Commenting
        },
        created: now_rfc3339(),
        creator,
        session,
        in_reply_to: None,
        status: Status::Open,
        body: if body.trim().is_empty() {
            None
        } else {
            Some(Body { kind: textual_body(), value: body })
        },
        target: Target {
            source: source.to_string(),
            hash: content_hash(Path::new(source)),
            selector,
        },
        extra: HashMap::new(),
    }
}

/// Build a reply in `parent_id`'s thread. A reply inherits the thread's
/// anchor rather than carrying its own — it is about the comment, not about a
/// second place in the file.
pub fn reply(source: &str, parent_id: &str, body: String, creator: Creator) -> Annotation {
    Annotation {
        id: new_id(),
        kind: annotation_type(),
        motivation: Motivation::Replying,
        created: now_rfc3339(),
        creator,
        session: None,
        in_reply_to: Some(parent_id.to_string()),
        status: Status::Open,
        body: Some(Body { kind: textual_body(), value: body }),
        target: Target { source: source.to_string(), hash: None, selector: Vec::new() },
        extra: HashMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn who() -> Creator {
        Creator { id: "node:3f9a1c".into(), name: Some("Alvaro's iPhone".into()) }
    }

    fn quote(exact: &str) -> Vec<Selector> {
        vec![Selector::TextQuoteSelector {
            exact: exact.into(),
            prefix: Some("| ".into()),
            suffix: Some(" |".into()),
        }]
    }

    #[test]
    fn raw_keeps_the_assessing_lines_the_fold_hides() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/r.md", "fix".into(), quote("x"), who(), None);
        append(dir.path(), &a).unwrap();
        set_status(dir.path(), "/tmp/r.md", &a.id, Status::Addressed, None, who()).unwrap();

        assert_eq!(list(dir.path(), "/tmp/r.md").len(), 1);
        let lines = raw(dir.path(), "/tmp/r.md");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].motivation, Motivation::Assessing);
        // The wire form is the same lines, as stored.
        let text = raw_lines(dir.path(), "/tmp/r.md");
        assert_eq!(text.len(), 2);
        assert_eq!(serde_json::from_str::<Annotation>(&text[1]).unwrap().id, lines[1].id);
    }

    #[test]
    fn unseen_is_a_set_difference_by_id_and_empty_once_both_sides_merged() {
        let shared = comment("/h/a.md", "both".into(), quote("x"), who(), None);
        let only_here = comment("/h/a.md", "mine".into(), quote("y"), who(), None);
        let only_there = comment("/h/a.md", "theirs".into(), quote("z"), who(), None);

        let local = vec![shared.clone(), only_here.clone()];
        let remote = vec![only_there.clone(), shared.clone()];
        let ids = |v: Vec<Annotation>| v.into_iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(ids(unseen(&local, &remote)), vec![only_here.id.clone()]);
        assert_eq!(ids(unseen(&remote, &local)), vec![only_there.id.clone()]);

        let local2 = vec![shared.clone(), only_here.clone(), only_there.clone()];
        let remote2 = vec![only_there, shared, only_here];
        assert!(unseen(&local2, &remote2).is_empty());
        assert!(unseen(&remote2, &local2).is_empty());
    }

    #[test]
    fn a_merged_entry_takes_the_store_it_lands_in_as_its_source() {
        let dir = TempDir::new().unwrap();
        let host_side = comment("/h/a.md", "from the host".into(), quote("x"), who(), None);
        let reader_key = "skypie-remote://peer1/h/a.md";

        assert_eq!(merge(dir.path(), reader_key, &[host_side.clone()]).unwrap(), 1);
        let got = list(dir.path(), reader_key);
        assert_eq!(got[0].id, host_side.id);
        assert_eq!(got[0].target.source, reader_key);
        assert_eq!(got[0].target.selector, host_side.target.selector);
        // The push direction is the same stamp the other way round.
        assert_eq!(merge(dir.path(), "/h/a.md", &got).unwrap(), 1);
        assert_eq!(list(dir.path(), "/h/a.md")[0].target.source, "/h/a.md");
    }

    #[test]
    fn raw_lines_drops_a_torn_line_and_keeps_the_same_ids_as_raw() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/t.md", "one".into(), quote("x"), who(), None);
        append(dir.path(), &a).unwrap();
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(store_path(dir.path(), "/tmp/t.md"))
                .unwrap();
            f.write_all(b"{\"id\":\"half-writ\n").unwrap();
        }
        let b = comment("/tmp/t.md", "two".into(), quote("y"), who(), None);
        append(dir.path(), &b).unwrap();

        let lines = raw_lines(dir.path(), "/tmp/t.md");
        assert_eq!(lines.len(), 2);
        let ids: Vec<String> =
            lines.iter().map(|l| serde_json::from_str::<Annotation>(l).unwrap().id).collect();
        assert_eq!(ids, raw(dir.path(), "/tmp/t.md").iter().map(|a| a.id.clone()).collect::<Vec<_>>());
    }

    #[test]
    fn a_peer_resending_a_known_id_cannot_change_what_it_says() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/a.md", "original".into(), quote("x"), who(), None);
        append(dir.path(), &a).unwrap();

        let mut forged = a.clone();
        forged.body = Some(Body { kind: "TextualBody".into(), value: "forged".into() });
        forged.status = Status::Wontfix;
        assert_eq!(merge(dir.path(), "/tmp/a.md", &[forged]).unwrap(), 0);
        let got = list(dir.path(), "/tmp/a.md");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].body.as_ref().unwrap().value, "original");
        assert_eq!(got[0].status, Status::Open);
    }

    /// Two stores in one directory play host and reader: the keys differ, so
    /// they are two files, and the wire is stood in for by `raw_lines`.
    fn host_and_reader() -> (TempDir, Annotation, Annotation) {
        let dir = TempDir::new().unwrap();
        let h = comment("/h/a.md", "host says".into(), quote("x"), who(), None);
        append(dir.path(), &h).unwrap();
        let r = comment(READER, "reader says".into(), quote("y"), who(), None);
        append(dir.path(), &r).unwrap();
        (dir, h, r)
    }
    const HOST: &str = "/h/a.md";
    const READER: &str = "skypie-remote://peer1/h/a.md";

    fn host_applies(dir: &TempDir, outgoing: &[String]) -> usize {
        let parsed: Vec<Annotation> =
            outgoing.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
        merge(dir.path(), HOST, &parsed).unwrap()
    }

    #[test]
    fn two_stores_converge_in_one_pass_each_way_and_a_replay_moves_nothing() {
        let (dir, h, r) = host_and_reader();

        let pass = reconcile(dir.path(), READER, &raw_lines(dir.path(), HOST), true).unwrap();
        assert_eq!(pass.pulled, 1);
        assert_eq!(pass.outgoing.len(), 1);
        assert_eq!(serde_json::from_str::<Annotation>(&pass.outgoing[0]).unwrap().id, r.id);
        assert_eq!(host_applies(&dir, &pass.outgoing), 1);

        for (key, _) in [(HOST, &h), (READER, &r)] {
            let got = list(dir.path(), key);
            assert_eq!(got.len(), 2);
            assert!(got.iter().all(|a| a.target.source == key));
        }

        let again = reconcile(dir.path(), READER, &raw_lines(dir.path(), HOST), true).unwrap();
        assert_eq!(again.pulled, 0);
        assert!(again.outgoing.is_empty());
        assert_eq!(raw(dir.path(), HOST).len(), 2);
        assert_eq!(raw(dir.path(), READER).len(), 2);
    }

    #[test]
    fn a_status_set_on_the_pulled_tab_reaches_the_host_store_and_back() {
        let (dir, h, r) = host_and_reader();
        let first = reconcile(dir.path(), READER, &raw_lines(dir.path(), HOST), true).unwrap();
        host_applies(&dir, &first.outgoing);

        // Reader resolves the host's thread.
        set_status(dir.path(), READER, &h.id, Status::Addressed, None, who()).unwrap();
        let pass = reconcile(dir.path(), READER, &raw_lines(dir.path(), HOST), true).unwrap();
        assert_eq!(pass.outgoing.len(), 1);
        assert_eq!(
            serde_json::from_str::<Annotation>(&pass.outgoing[0]).unwrap().motivation,
            Motivation::Assessing
        );
        assert_eq!(host_applies(&dir, &pass.outgoing), 1);
        let host = list(dir.path(), HOST);
        assert_eq!(host.len(), 2);
        assert_eq!(host.iter().find(|a| a.id == h.id).unwrap().status, Status::Addressed);

        // Host won't-fixes the reader's thread; the reader pulls the fold.
        set_status(dir.path(), HOST, &r.id, Status::Wontfix, None, who()).unwrap();
        let back = reconcile(dir.path(), READER, &raw_lines(dir.path(), HOST), true).unwrap();
        assert_eq!(back.pulled, 1);
        assert!(back.outgoing.is_empty());
        let reader = list(dir.path(), READER);
        assert_eq!(reader.iter().find(|a| a.id == r.id).unwrap().status, Status::Wontfix);

        // The seam this depends on: the wire carries the unfolded lines.
        assert_eq!(raw_lines(dir.path(), HOST).len(), 4);
        assert_eq!(list(dir.path(), HOST).len(), 2);
    }

    #[test]
    fn a_truncated_page_still_pulls_but_pushes_nothing() {
        let (dir, _h, _r) = host_and_reader();
        let pass = reconcile(dir.path(), READER, &raw_lines(dir.path(), HOST), false).unwrap();
        assert_eq!(pass.pulled, 1);
        assert!(pass.outgoing.is_empty(), "a prefix is not a set; the reader's entry must wait");
    }

    #[test]
    fn an_entry_the_wire_would_refuse_is_left_out_of_the_frame_not_blocking_the_rest() {
        let (dir, _h, _r) = host_and_reader();
        // A second local comment whose encoded line the wire refuses.
        let mut huge = comment(READER, "big".into(), quote("z"), who(), None);
        huge.extra.insert("pad".into(), serde_json::Value::String("x".repeat(70 * 1024)));
        append(dir.path(), &huge).unwrap();

        let pass = reconcile(dir.path(), READER, &raw_lines(dir.path(), HOST), true).unwrap();
        assert_eq!(pass.outgoing.len(), 1, "the good entry still goes out");
        assert!(!pass.outgoing[0].contains("\"pad\""));
    }

    #[test]
    fn a_comment_round_trips_through_the_store() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/audit.html", "Needs Q3 numbers.".into(), quote("Total revenue"), who(), None);
        append(dir.path(), &a).unwrap();

        let got = list(dir.path(), "/tmp/audit.html");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, a.id);
        assert_eq!(got[0].body.as_ref().unwrap().value, "Needs Q3 numbers.");
        assert_eq!(got[0].status, Status::Open);
    }

    #[test]
    fn an_empty_body_is_a_highlight_not_a_comment() {
        let a = comment("/tmp/x.md", "   ".into(), quote("hi"), who(), None);
        assert_eq!(a.motivation, Motivation::Highlighting);
        assert!(a.body.is_none());
    }

    #[test]
    fn resolving_appends_rather_than_rewrites_and_the_fold_hides_the_event() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/a.md", "fix this".into(), quote("x"), who(), None);
        append(dir.path(), &a).unwrap();
        set_status(dir.path(), "/tmp/a.md", &a.id, Status::Addressed, Some("done".into()), who())
            .unwrap();

        // The file grew; nothing was edited in place.
        let raw = std::fs::read_to_string(store_path(dir.path(), "/tmp/a.md")).unwrap();
        assert_eq!(raw.lines().count(), 2);

        // The fold shows one comment, addressed — not two entries.
        let got = list(dir.path(), "/tmp/a.md");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].status, Status::Addressed);
    }

    #[test]
    fn the_newest_assessment_wins() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/a.md", "fix".into(), quote("x"), who(), None);
        append(dir.path(), &a).unwrap();
        set_status(dir.path(), "/tmp/a.md", &a.id, Status::Addressed, None, who()).unwrap();
        set_status(dir.path(), "/tmp/a.md", &a.id, Status::Open, Some("reopening".into()), who())
            .unwrap();
        assert_eq!(list(dir.path(), "/tmp/a.md")[0].status, Status::Open);
    }

    #[test]
    fn resolving_an_unknown_id_is_an_error_not_a_dangling_entry() {
        let dir = TempDir::new().unwrap();
        let err = set_status(dir.path(), "/tmp/a.md", "nope", Status::Addressed, None, who())
            .unwrap_err();
        assert!(err.contains("no comment"));
        assert!(!store_path(dir.path(), "/tmp/a.md").exists());
    }

    #[test]
    fn a_corrupt_line_does_not_hide_the_good_ones() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/a.md", "one".into(), quote("x"), who(), None);
        let b = comment("/tmp/a.md", "two".into(), quote("y"), who(), None);
        append(dir.path(), &a).unwrap();

        // Simulate a process killed mid-append: a truncated last line.
        let p = store_path(dir.path(), "/tmp/a.md");
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"{\"id\":\"half-writ\n").unwrap();
        drop(f);
        append(dir.path(), &b).unwrap();

        let got = list(dir.path(), "/tmp/a.md");
        assert_eq!(got.len(), 2, "the torn line is skipped, the two comments survive");
    }

    #[test]
    fn merging_two_devices_is_a_union_by_id() {
        let dir = TempDir::new().unwrap();
        let mine = comment("/tmp/a.md", "mine".into(), quote("x"), who(), None);
        append(dir.path(), &mine).unwrap();

        let theirs = comment(
            "/tmp/a.md",
            "theirs".into(),
            quote("y"),
            Creator { id: "node:beef".into(), name: Some("Mac".into()) },
            None,
        );
        // Their push carries an entry I already have plus one I do not.
        let added = merge(dir.path(), "/tmp/a.md", &[mine.clone(), theirs.clone()]).unwrap();
        assert_eq!(added, 1);
        assert_eq!(list(dir.path(), "/tmp/a.md").len(), 2);

        // Replaying the same push changes nothing.
        assert_eq!(merge(dir.path(), "/tmp/a.md", &[mine, theirs]).unwrap(), 0);
    }

    #[test]
    fn a_push_lands_only_in_the_store_it_was_sent_to_whatever_it_claims() {
        let dir = TempDir::new().unwrap();
        let elsewhere = comment("/etc/passwd", "hi".into(), quote("root"), who(), None);
        assert_eq!(merge(dir.path(), "/tmp/a.md", &[elsewhere]).unwrap(), 1);
        assert!(list(dir.path(), "/etc/passwd").is_empty());
        assert_eq!(list(dir.path(), "/tmp/a.md")[0].target.source, "/tmp/a.md");
    }

    #[test]
    fn the_index_badges_open_roots_only() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/a.md", "one".into(), quote("x"), who(), None);
        let b = comment("/tmp/a.md", "two".into(), quote("y"), who(), None);
        append(dir.path(), &a).unwrap();
        append(dir.path(), &b).unwrap();
        append(dir.path(), &reply("/tmp/a.md", &a.id, "me too".into(), who())).unwrap();
        set_status(dir.path(), "/tmp/a.md", &b.id, Status::Wontfix, None, who()).unwrap();

        let rows = index(dir.path());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "/tmp/a.md");
        assert_eq!(rows[0].total, 2, "replies are not threads");
        assert_eq!(rows[0].open, 1, "wontfix is not open");
        assert_eq!(open_count(dir.path(), "/tmp/a.md"), 1);
    }

    #[test]
    fn a_stale_assessment_from_a_peer_does_not_reopen_a_resolved_thread() {
        // The fold decides by entry id, not by position, because `merge`
        // appends a peer's entries at the END of the file whatever their
        // timestamps say. Deciding by position let an older `wontfix` synced
        // from a phone permanently re-close a thread the Mac had reopened.
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/a.md", "fix this".into(), quote("x"), who(), None);
        append(dir.path(), &a).unwrap();

        // An assessment the phone made EARLIER — a smaller id — but which
        // reaches this store LAST, which is what a sync does.
        let assessment = |id: &str, status: Status| Annotation {
            id: id.to_string(),
            kind: "Annotation".to_string(),
            motivation: Motivation::Assessing,
            created: now_rfc3339(),
            creator: who(),
            session: None,
            in_reply_to: Some(a.id.clone()),
            status,
            body: None,
            target: Target {
                source: "/tmp/a.md".to_string(),
                hash: None,
                selector: Vec::new(),
            },
            extra: HashMap::new(),
        };

        // The Mac reopened the thread at 12:00 (the greater id).
        append(dir.path(), &assessment("0192c700-0000-7000-8000-000000000002", Status::Open))
            .unwrap();
        assert_eq!(list(dir.path(), "/tmp/a.md")[0].status, Status::Open);

        // The phone's 09:00 `wontfix` now syncs, landing last in the file.
        merge(
            dir.path(),
            "/tmp/a.md",
            &[assessment("0192c700-0000-7000-8000-000000000001", Status::Wontfix)],
        )
        .unwrap();

        assert_eq!(
            list(dir.path(), "/tmp/a.md")[0].status,
            Status::Open,
            "an older assessment arriving last must not beat a newer one"
        );
    }

    #[test]
    fn concurrent_appends_to_different_files_all_land_in_the_index() {
        // The app writing a comment while a peer push merges is normal, and
        // both rewrite the one shared index. This used to lose a row — or
        // fail outright with ENOENT when one writer's rename took the shared
        // temp file out from under another's.
        // A BARRIER, and enough rounds to be a pin rather than a smoke test:
        // without it the threads finish sequentially on most runs and the
        // test passes with the lock removed.
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        const WRITERS: usize = 8;
        let gate = std::sync::Arc::new(std::sync::Barrier::new(WRITERS));

        for round in 0..25 {
            let handles: Vec<_> = (0..WRITERS)
                .map(|i| {
                    let root = root.clone();
                    let gate = gate.clone();
                    std::thread::spawn(move || {
                        let source = format!("/tmp/concurrent-{round}-{i}.md");
                        let a = comment(&source, format!("note {i}"), quote("x"), who(), None);
                        gate.wait();
                        append(&root, &a).expect("append must not fail under contention");
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap();
            }
        }

        let rows = index(&root);
        assert_eq!(rows.len(), 25 * WRITERS, "every file must keep its row");
    }

    #[test]
    fn concurrent_merges_of_the_same_frame_store_it_once() {
        // THE race `STORE_LOCK` exists for. `merge` reads the store to build
        // its id set and then appends; without the lock two merges of the
        // same frame — one peer, two of its four allowed sessions — both read
        // before either wrote, both saw every id as new, and both appended.
        // The store is append-only, so those duplicates are permanent.
        //
        // A barrier and enough rounds that the interleaving is reliable
        // rather than lucky: the earlier version of this test finished its
        // threads sequentially and passed with the lock removed.
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();

        for round in 0..25 {
            let source = format!("/tmp/merge-race-{round}.md");
            let frame: Vec<Annotation> = (0..4)
                .map(|i| comment(&source, format!("note {i}"), quote("x"), who(), None))
                .collect();

            let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let root = root.clone();
                    let source = source.clone();
                    let frame = frame.clone();
                    let gate = gate.clone();
                    std::thread::spawn(move || {
                        gate.wait();
                        merge(&root, &source, &frame).expect("merge under contention");
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap();
            }

            let stored = list(&root, &source);
            assert_eq!(
                stored.len(),
                4,
                "round {round}: the same frame merged twice must store 4, not 8"
            );
            assert_eq!(index(&root).iter().find(|r| r.source == source).unwrap().open, 4);
        }
    }

    #[test]
    fn concurrent_appends_to_the_same_file_keep_every_comment() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();

        let handles: Vec<_> = (0..8)
            .map(|i| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let a = comment("/tmp/one.md", format!("note {i}"), quote("x"), who(), None);
                    append(&root, &a).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        // O_APPEND of one short line is atomic: no line may be torn or lost.
        assert_eq!(list(&root, "/tmp/one.md").len(), 8);
        assert_eq!(index(&root)[0].open, 8);
    }

    #[test]
    fn a_comment_on_a_file_inside_the_state_dir_survives_the_container_moving() {
        // The bug `portable_path` exists for, reaching the comment store: a
        // pulled artifact lives under `<state>/remote/cache/`, and iOS moves
        // the container UUID on every app update. Keyed by the raw absolute
        // path, every comment on every received file would read as gone.
        let old_container = TempDir::new().unwrap();
        let new_container = TempDir::new().unwrap();

        let pulled_old = old_container.path().join("remote/cache/report.html");
        let pulled_new = new_container.path().join("remote/cache/report.html");

        assert_eq!(
            store_key(old_container.path(), &pulled_old.to_string_lossy()),
            store_key(new_container.path(), &pulled_new.to_string_lossy()),
            "the same file in a moved container must keep its comments"
        );
    }

    #[test]
    fn a_file_outside_the_state_dir_keys_by_its_absolute_path() {
        // The Mac case: nothing portable about it, and two different files
        // must never collide.
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        assert_eq!(
            store_key(a.path(), "/Users/me/work/audit.html"),
            store_key(b.path(), "/Users/me/work/audit.html"),
            "an outside path does not depend on which state dir asks"
        );
        assert_ne!(
            store_key(a.path(), "/Users/me/work/audit.html"),
            store_key(a.path(), "/Users/me/work/other.html")
        );
    }

    #[test]
    fn merging_a_batch_writes_once_and_indexes_once() {
        let dir = TempDir::new().unwrap();
        let batch: Vec<Annotation> = (0..25)
            .map(|i| comment("/tmp/a.md", format!("note {i}"), quote("x"), who(), None))
            .collect();

        assert_eq!(merge(dir.path(), "/tmp/a.md", &batch).unwrap(), 25);
        assert_eq!(list(dir.path(), "/tmp/a.md").len(), 25);
        assert_eq!(index(dir.path())[0].open, 25);

        // Replaying the whole batch adds nothing and leaves the file alone.
        let before = std::fs::read_to_string(store_path(dir.path(), "/tmp/a.md")).unwrap();
        assert_eq!(merge(dir.path(), "/tmp/a.md", &batch).unwrap(), 0);
        assert_eq!(
            std::fs::read_to_string(store_path(dir.path(), "/tmp/a.md")).unwrap(),
            before
        );
    }

    #[test]
    fn a_batch_carrying_one_duplicate_id_stores_it_once() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/a.md", "one".into(), quote("x"), who(), None);
        // The same entry twice inside ONE frame — a retrying peer can send it.
        assert_eq!(merge(dir.path(), "/tmp/a.md", &[a.clone(), a]).unwrap(), 1);
        assert_eq!(list(dir.path(), "/tmp/a.md").len(), 1);
    }

    #[test]
    fn a_batch_with_an_over_long_body_lands_none_of_itself() {
        // Half a review pass is worse than none: the peer can retry a
        // rejected frame, but it cannot tell which half landed.
        let dir = TempDir::new().unwrap();
        let good = comment("/tmp/a.md", "fine".into(), quote("x"), who(), None);
        let bad = comment("/tmp/a.md", "x".repeat(MAX_BODY_CHARS + 1), quote("y"), who(), None);

        assert!(merge(dir.path(), "/tmp/a.md", &[good, bad]).is_err());
        assert!(list(dir.path(), "/tmp/a.md").is_empty());
    }

    #[test]
    fn an_over_long_body_is_refused_before_it_reaches_disk() {
        let dir = TempDir::new().unwrap();
        let long = "x".repeat(MAX_BODY_CHARS + 1);
        let a = comment("/tmp/a.md", long, quote("x"), who(), None);
        assert!(append(dir.path(), &a).is_err());
        assert!(!store_path(dir.path(), "/tmp/a.md").exists());
    }

    #[test]
    fn two_targets_never_share_a_store() {
        let dir = TempDir::new().unwrap();
        assert_ne!(
            store_key(dir.path(), "/tmp/a.md"),
            store_key(dir.path(), "/tmp/b.md")
        );
        assert_eq!(store_key(dir.path(), "/tmp/a.md").len(), 64);
    }

    #[test]
    fn an_unknown_selector_kind_survives_a_read() {
        let dir = TempDir::new().unwrap();
        let mut a = comment("/tmp/a.md", "shape".into(), Vec::new(), who(), None);
        a.target.selector = vec![Selector::Other(serde_json::json!({
            "type": "SvgSelector",
            "value": "<svg><polygon points='1,2 3,4'/></svg>"
        }))];
        append(dir.path(), &a).unwrap();

        let got = list(dir.path(), "/tmp/a.md");
        match &got[0].target.selector[0] {
            Selector::Other(v) => assert_eq!(v["type"], "SvgSelector"),
            other => panic!("selector was rewritten: {other:?}"),
        }
    }

    #[test]
    fn an_unknown_top_level_field_survives_a_read() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/a.md", "hi".into(), quote("x"), who(), None);
        let mut line = serde_json::to_value(&a).unwrap();
        line["reactions"] = serde_json::json!(["👍"]);
        std::fs::create_dir_all(annotations_dir(dir.path())).unwrap();
        std::fs::write(
            store_path(dir.path(), "/tmp/a.md"),
            format!("{}\n", serde_json::to_string(&line).unwrap()),
        )
        .unwrap();

        let got = list(dir.path(), "/tmp/a.md");
        assert_eq!(got[0].extra.get("reactions"), Some(&serde_json::json!(["👍"])));
    }

    #[test]
    fn the_content_hash_changes_with_the_file() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("doc.md");
        std::fs::write(&f, "one").unwrap();
        let first = content_hash(&f).unwrap();
        std::fs::write(&f, "two").unwrap();
        assert_ne!(first, content_hash(&f).unwrap());
        assert!(first.starts_with("blake3:"));
    }

    #[test]
    fn an_export_lands_beside_the_file_and_never_in_the_state_dir() {
        let dir = TempDir::new().unwrap();
        let work = TempDir::new().unwrap();
        let doc = work.path().join("audit.html");
        std::fs::write(&doc, "<p>Total revenue</p>").unwrap();
        let source = doc.to_string_lossy().into_owned();

        append(dir.path(), &comment(&source, "Q3?".into(), quote("Total revenue"), who(), None))
            .unwrap();
        let dest = export_sidecar(dir.path(), &source).unwrap();

        assert_eq!(dest, work.path().join("audit.html.comments.jsonl"));
        assert_eq!(std::fs::read_to_string(&dest).unwrap().lines().count(), 1);
    }

    #[test]
    fn rfc3339_matches_known_instants() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339(1_789_296_131), "2026-09-13T10:42:11Z");
        // A leap day, which the era-shifted civil algorithm must get right.
        assert_eq!(format_rfc3339(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn ids_sort_in_creation_order() {
        let mut ids: Vec<String> = (0..8).map(|_| new_id()).collect();
        let made = ids.clone();
        ids.sort();
        assert_eq!(ids, made, "UUIDv7 must be lexicographically time-ordered");
    }
}
