// State store — JSON-backed settings document at
// `~/Library/Application Support/SkyPie/state.json`.
//
// - Schema-versioned with unknown-field-preserving round-trip (R12.4)
// - SKYPIE_STATE_DIR env-var override for tests
// - Atomic write (tmp + rename)
// - Debounced writer (~250 ms quiet window)
// - Corrupt-file recovery (rename to .broken.<unix-ts> and return defaults)

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: PathBuf,
    pub opened_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookmarkEntry {
    pub path: PathBuf,
    pub bookmarked_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowGeom {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Default for WindowGeom {
    fn default() -> Self {
        Self { x: 0, y: 0, width: 1280, height: 800 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PaneSizes {
    pub sidebar_px: u32,
    pub preview_px: u32,
    pub sidebar_visible: bool,
}

// Hand-written because `sidebar_visible` must default to TRUE: every
// pre-upgrade state.json lacks the field, and a derived default would hide
// the sidebar for the whole installed base. The px zeros keep the derived
// behavior — the frontend treats 0 as "no saved width".
impl Default for PaneSizes {
    fn default() -> Self {
        Self { sidebar_px: 0, preview_px: 0, sidebar_visible: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub ignore_globs: Vec<String>,
    pub drag_out_mode: String,
    /// Slack share target: a full `slack://…` URL or a `TEAMID/CHANNELID`
    /// shorthand the frontend expands. None = the Open-in-Slack affordance
    /// stays hidden.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slack_target: Option<String>,
    /// Beam offer lifetime in hours. None = the built-in default (24 h);
    /// clamped to ≥ 1 at the use site so a zero can't mint dead tickets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beam_ttl_hours: Option<u32>,
    /// Accept sessions from paired devices at launch. Default TRUE: a
    /// device that is paired is one the user wants reachable. Off, the app
    /// opens no listening socket until the user shares or opens a link.
    /// Even when on, the endpoint only starts if the peer store is non-empty.
    pub remote_listen: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            ignore_globs: Vec::new(),
            drag_out_mode: "file".to_string(),
            slack_target: None,
            beam_ttl_hours: None,
            remote_listen: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub schema_version: u32,
    pub roots: Vec<PathBuf>,
    pub recents: Vec<RecentEntry>,
    pub bookmarks: Vec<BookmarkEntry>,
    pub window: WindowGeom,
    pub panes: PaneSizes,
    pub preferences: Preferences,
}

impl Default for State {
    fn default() -> Self {
        Self {
            schema_version: 1,
            roots: Vec::new(),
            recents: Vec::new(),
            bookmarks: Vec::new(),
            window: WindowGeom::default(),
            panes: PaneSizes::default(),
            preferences: Preferences::default(),
        }
    }
}

/// Test support: ONE shared tempdir for `SKYPIE_STATE_DIR` across every test
/// module in the crate. Previously bookmarks.rs and lib.rs each pointed the
/// process-global env var at their *own* OnceLock<TempDir>, racing each
/// other mid-run (benign-by-luck, and UB territory for concurrent set_var).
#[cfg(test)]
pub(crate) fn ensure_shared_test_state_dir() {
    use std::sync::OnceLock;
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    static SET: OnceLock<()> = OnceLock::new();
    let dir = DIR.get_or_init(|| tempfile::TempDir::new().expect("state tempdir"));
    // set_var exactly once per process; later callers only read.
    SET.get_or_init(|| std::env::set_var("SKYPIE_STATE_DIR", dir.path()));
}

/// The directory that holds `state.json` — the one rule both binaries
/// share, so the app's socket and the MCP server's search for it can never
/// split. `SKYPIE_STATE_DIR` overrides (tests use this to point at tempdirs).
pub use skypie_ipc::state_dir;

/// Path to the active `state.json` (under `state_dir()`).
pub fn state_path() -> PathBuf {
    state_dir().join("state.json")
}

// ────────────────────────────────────────────────────────────────────────────
// Global in-memory state, write counter, and debounce machinery.
// We use serde_json::Value as intermediate so unknown fields survive round-trips.
// ────────────────────────────────────────────────────────────────────────────

static GLOBAL_STATE: OnceLock<Arc<Mutex<serde_json::Value>>> = OnceLock::new();
static WRITE_COUNTER: OnceLock<Arc<AtomicU64>> = OnceLock::new();
static PENDING_WRITE: OnceLock<Arc<Mutex<Option<std::time::Instant>>>> = OnceLock::new();

/// How many times a disk write has been SCHEDULED. Test-only, and counted at
/// the one place that schedules, so a test can assert that an op which
/// changed nothing also wrote nothing — the observable effect of
/// `update_state_field_if_changed`'s fast path.
#[cfg(test)]
static SCHEDULED_WRITES: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
pub(crate) fn scheduled_writes_for_test() -> u64 {
    SCHEDULED_WRITES.load(std::sync::atomic::Ordering::Relaxed)
}

const DEBOUNCE_MS: u64 = 250;

pub(crate) fn global_state() -> &'static Arc<Mutex<serde_json::Value>> {
    GLOBAL_STATE.get_or_init(|| Arc::new(Mutex::new(serde_json::Value::Null)))
}

fn write_counter_arc() -> &'static Arc<AtomicU64> {
    WRITE_COUNTER.get_or_init(|| Arc::new(AtomicU64::new(0)))
}

fn pending_write() -> &'static Arc<Mutex<Option<std::time::Instant>>> {
    PENDING_WRITE.get_or_init(|| Arc::new(Mutex::new(None)))
}

/// Read the current in-memory state as a raw `serde_json::Value` (clones the
/// global). Preserves unknown fields. Use this for the `get_state` Tauri
/// command so the frontend sees the full document including any keys this
/// build doesn't know about.
pub fn current_state_value() -> serde_json::Value {
    global_state().lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Read the current in-memory state as a structured State.
/// Does NOT read from disk — reads from the in-memory global Value.
pub fn current_state() -> State {
    let val = global_state().lock().unwrap_or_else(|p| p.into_inner()).clone();
    if val.is_object() {
        serde_json::from_value(val).unwrap_or_default()
    } else {
        State::default()
    }
}

/// Load the state document.
/// - Missing file → returns default state.
/// - Corrupt file → renames to .broken.<unix-ts>, returns default state.
/// - Valid file → deserializes, updates global cache, returns structured State.
pub fn load() -> State {
    let path = state_path();

    if !path.exists() {
        let default_state = State::default();
        let val = serde_json::to_value(&default_state)
            .unwrap_or_else(|_| serde_json::Value::Object(Default::default()));
        *global_state().lock().unwrap_or_else(|p| p.into_inner()) = val;
        return default_state;
    }

    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("skypie: failed to read state.json: {e}");
            let default_state = State::default();
            let val = serde_json::to_value(&default_state).unwrap_or_default();
            *global_state().lock().unwrap_or_else(|p| p.into_inner()) = val;
            return default_state;
        }
    };

    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(mut val) => {
            // Re-resolve paths written as state-dir-relative against the
            // state directory THIS launch has. On iOS the container UUID
            // moves on every app update, so the absolute path a previous
            // install wrote is already dead; see `portable_path`.
            crate::portable_path::absolute_document(&mut val, &state_dir());
            // Parse as structured State (with defaults for missing fields).
            let state: State = serde_json::from_value(val.clone()).unwrap_or_default();
            // Store the raw Value so unknown fields are preserved on save.
            *global_state().lock().unwrap_or_else(|p| p.into_inner()) = val;
            state
        }
        Err(e) => {
            eprintln!("skypie: state.json is corrupt ({e}), recovering");
            // Rename corrupt file.
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let broken_path = path.with_file_name(format!("state.json.broken.{ts}"));
            if let Err(re) = std::fs::rename(&path, &broken_path) {
                eprintln!("skypie: failed to rename corrupt state.json: {re}");
            }
            let default_state = State::default();
            let val = serde_json::to_value(&default_state).unwrap_or_default();
            *global_state().lock().unwrap_or_else(|p| p.into_inner()) = val;
            default_state
        }
    }
}

/// Save the state document atomically (write-tmp + rename).
/// Merges the given State into the current global Value to preserve unknown fields.
pub fn save(state: &State) -> Result<(), String> {
    let dir = state_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = state_path();
    let tmp_path = path.with_extension("json.tmp");

    // Merge: start from current global value (preserves unknown fields),
    // then overwrite known keys from the provided state.
    let mut base_val = global_state()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();

    if !base_val.is_object() {
        base_val = serde_json::Value::Object(Default::default());
    }

    let state_val = serde_json::to_value(state).map_err(|e| e.to_string())?;
    if let (serde_json::Value::Object(base_map), serde_json::Value::Object(state_map)) =
        (&mut base_val, state_val)
    {
        for (k, v) in state_map {
            base_map.insert(k, v);
        }
    }

    // Update global state to reflect the merged value.
    *global_state().lock().unwrap_or_else(|p| p.into_inner()) = base_val.clone();

    let on_disk = crate::portable_path::portable_document(&base_val, &dir);
    let json = serde_json::to_string_pretty(&on_disk).map_err(|e| e.to_string())?;

    std::fs::write(&tmp_path, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;

    write_counter_arc().fetch_add(1, Ordering::SeqCst);
    Ok(())
}

/// Update one field by key path under the ONE `GLOBAL_STATE` lock: read the
/// current leaf, let `f` modify it in place, write it back — all inside a
/// single critical section — then schedule the debounced disk write.
///
/// The pattern this replaces is the CALLER-side one still used by
/// `bookmarks.rs`/`recents.rs`, which takes the lock TWICE: the caller locks
/// and clones out a whole key (`bookmarks.rs::list_from_global`), unlocks,
/// mutates ITS OWN clone, then calls `set_state_field`, which locks again to
/// overwrite. (`set_state_field` itself was always one lock; the two
/// acquisitions are one apiece, with the caller's edit in between.) Two concurrent
/// callers doing that race a classic read-modify-write: both read the same
/// starting array, both append to their own copy, and whichever write lands
/// second silently discards the first's change. `pies.rs` needs a stronger
/// guarantee than that — the UI's `touch_seen` on every plate open and, from
/// M5, the socket thread both write the `pies` key, and neither may be able
/// to drop the other's write — so every mutating op there goes through this
/// instead. `bookmarks.rs`/`recents.rs` keep the old two-step path; they
/// have no second writer yet, and switching them is out of scope here.
pub fn update_state_field(
    key: &str,
    f: impl FnOnce(&mut serde_json::Value),
) -> Result<(), String> {
    update_state_field_if_changed(key, |leaf| {
        f(leaf);
        true
    })
}

/// `update_state_field`, except the closure reports whether it actually
/// CHANGED the leaf. A `false` skips `schedule_debounced_write` entirely.
///
/// The lock and the walk still run, because the closure needs the real leaf
/// to decide. Only the disk write is skipped. An op that changed nothing —
/// an idempotent `add_to_pie` re-adding a path that is already a member — has
/// no new bytes to persist, so making it rewrite `state.json` is pure churn
/// on the user's disk.
pub fn update_state_field_if_changed(
    key: &str,
    f: impl FnOnce(&mut serde_json::Value) -> bool,
) -> Result<(), String> {
    let changed = {
        let mut global = global_state().lock().unwrap_or_else(|p| p.into_inner());
        if !global.is_object() {
            // Initialize with default state if not yet loaded.
            let default_val = serde_json::to_value(&State::default()).unwrap_or_default();
            *global = default_val;
        }
        let leaf = get_or_insert_nested_mut(&mut global, key)?;
        f(leaf)
    };
    if changed {
        schedule_debounced_write();
    }
    Ok(())
}

/// Update one field by key path (whole-value replace); schedules a debounced
/// disk write. Supports top-level keys ("roots") and dot-nested keys
/// ("preferences.ignore_globs"). Re-expressed on top of `update_state_field`
/// so there is exactly one code path that walks/creates a nested key and
/// schedules the write — this is just that path with a closure that ignores
/// whatever was there before and drops in `value`.
pub fn set_state_field(key: &str, value: serde_json::Value) -> Result<(), String> {
    update_state_field(key, move |v| *v = value)
}

/// Mark a write pending and, if one isn't already counting down, spawn the
/// thread that flushes after the `DEBOUNCE_MS` quiet window. Split out of
/// the old `set_state_field` body so `update_state_field` and
/// `set_state_field` both schedule through this one function.
fn schedule_debounced_write() {
    #[cfg(test)]
    SCHEDULED_WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut pending = pending_write().lock().unwrap_or_else(|p| p.into_inner());
    let now = std::time::Instant::now();
    let was_none = pending.is_none();
    *pending = Some(now);
    if was_none {
        // Spawn a thread to flush after the debounce window.
        let state_arc = Arc::clone(global_state());
        let pending_arc = Arc::clone(pending_write());
        let counter_arc = Arc::clone(write_counter_arc());
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(DEBOUNCE_MS));
                let mut pending_guard = pending_arc.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(last) = *pending_guard {
                    if last.elapsed() >= Duration::from_millis(DEBOUNCE_MS) {
                        // Time to flush.
                        *pending_guard = None;
                        drop(pending_guard);
                        let val = state_arc.lock().unwrap_or_else(|p| p.into_inner()).clone();
                        do_write_value(&val, &counter_arc);
                        break;
                    }
                } else {
                    break;
                }
            }
        });
    }
}

/// Walk (creating as needed) the dot-nested path `key` inside `val`, and
/// return a mutable reference to the LEAF — the `set_nested_key` this
/// replaces took a value to insert; this instead hands the caller (inside
/// `update_state_field`) the existing leaf to read before deciding what to
/// write. Intermediate segments become `Value::Object`; a leaf that doesn't
/// exist yet is created as `Value::Null`, so a closure sees "nothing here
/// yet" the same shape a freshly-loaded document missing the key would show.
fn get_or_insert_nested_mut<'a>(
    val: &'a mut serde_json::Value,
    key: &str,
) -> Result<&'a mut serde_json::Value, String> {
    let parts: Vec<&str> = key.splitn(2, '.').collect();
    match parts.as_slice() {
        [top_key] => {
            let serde_json::Value::Object(map) = val else {
                return Err("global state is not an object".to_string());
            };
            Ok(map.entry(top_key.to_string()).or_insert(serde_json::Value::Null))
        }
        [top_key, rest] => {
            let serde_json::Value::Object(map) = val else {
                return Err("global state is not an object".to_string());
            };
            let sub = map
                .entry(top_key.to_string())
                .or_insert_with(|| serde_json::Value::Object(Default::default()));
            get_or_insert_nested_mut(sub, rest)
        }
        _ => Err("empty key".to_string()),
    }
}

/// Where a failed debounced write is reported, besides stderr.
///
/// The writer runs on a bare `std::thread` spawned by
/// `schedule_debounced_write`, which holds no `tauri::AppHandle` and cannot
/// get one — this module is deliberately free of Tauri. A sink registered
/// once at startup (`lib.rs`) is the smallest thing that actually reaches
/// the UI: it emits `skypie://state-write-failed`, and the App shows one
/// persistent notice. `eprintln!` alone told nobody but a terminal, and
/// pies is the first feature where EVERY user action is a state write.
type WriteFailureSink = Box<dyn Fn(&str) + Send + Sync + 'static>;
static WRITE_FAILURE_SINK: OnceLock<WriteFailureSink> = OnceLock::new();

/// Register the sink. Idempotent by `OnceLock`: a second call is ignored,
/// so a test or a second window cannot displace the app's own reporter.
pub fn set_write_failure_sink(sink: impl Fn(&str) + Send + Sync + 'static) {
    let _ = WRITE_FAILURE_SINK.set(Box::new(sink));
}

fn report_write_failure(message: String) {
    eprintln!("skypie: {message}");
    if let Some(sink) = WRITE_FAILURE_SINK.get() {
        sink(&message);
    }
}

fn do_write_value(val: &serde_json::Value, counter: &AtomicU64) {
    let dir = state_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        report_write_failure(format!("cannot create state dir: {e}"));
        return;
    }
    let path = state_path();
    let tmp_path = path.with_extension("json.tmp");
    let on_disk = crate::portable_path::portable_document(val, &dir);
    let json = match serde_json::to_string_pretty(&on_disk) {
        Ok(j) => j,
        Err(e) => {
            report_write_failure(format!("cannot serialize state: {e}"));
            return;
        }
    };
    if let Err(e) = std::fs::write(&tmp_path, &json) {
        report_write_failure(format!("cannot write state.json.tmp: {e}"));
        return;
    }
    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        report_write_failure(format!("cannot rename state.json.tmp: {e}"));
        return;
    }
    counter.fetch_add(1, Ordering::SeqCst);
}

/// Test/inspection: count of disk writes since process start.
pub fn write_count() -> u64 {
    write_counter_arc().load(Ordering::SeqCst)
}

// Pure serde — no filesystem, no SKYPIE_STATE_DIR, no debounce thread.
#[cfg(test)]
mod pane_sizes_tests {
    use super::{PaneSizes, State};

    #[test]
    fn state_json_without_sidebar_visible_keeps_the_sidebar_shown() {
        let p: PaneSizes = serde_json::from_str(r#"{"sidebar_px":280,"preview_px":0}"#).unwrap();
        assert!(p.sidebar_visible, "pre-upgrade state.json must not hide the sidebar");
        assert_eq!(p.sidebar_px, 280);
    }

    #[test]
    fn state_without_a_panes_object_keeps_the_sidebar_shown() {
        let s: State = serde_json::from_str(r#"{"schema_version":1}"#).unwrap();
        assert!(s.panes.sidebar_visible);
    }

    #[test]
    fn hidden_sidebar_round_trips_through_json() {
        let hidden = PaneSizes { sidebar_px: 280, preview_px: 0, sidebar_visible: false };
        let json = serde_json::to_string(&hidden).unwrap();
        assert!(json.contains("\"sidebar_visible\":false"));
        assert_eq!(serde_json::from_str::<PaneSizes>(&json).unwrap(), hidden);
    }
}

// These exercise `update_state_field` directly against the process-global
// state (there's no injectable store to test against in isolation — see the
// function's own doc comment), so, like bookmarks.rs's tests, they share
// `ensure_shared_test_state_dir()` and run serially under their own lock.
#[cfg(test)]
mod update_state_field_tests {
    use super::*;
    use std::sync::{Barrier, Mutex, OnceLock};

    fn guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ensure_shared_test_state_dir();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn a_missing_key_is_created() {
        let _g = guard();
        *global_state().lock().unwrap_or_else(|p| p.into_inner()) = serde_json::json!({});
        update_state_field("widgets.count", |v| *v = serde_json::json!(1)).unwrap();
        assert_eq!(current_state_value()["widgets"]["count"], serde_json::json!(1));
    }

    /// The race `update_state_field` exists to close: two threads each
    /// append ONE element to the same array through the function. Because
    /// the whole read-modify-write happens under one lock acquisition per
    /// call (not read-then-separately-write, the way
    /// `bookmarks.rs::list_from_global()` + `set_state_field` do it), the
    /// two calls can only ever interleave as "whole calls", never mid-way —
    /// so this is a correctness property, not a race that merely usually
    /// doesn't lose data. A `Barrier` maximizes the chance the two threads'
    /// calls are actually in flight at the same wall-clock moment, which is
    /// exactly the scenario the old two-lock pattern would drop one of.
    #[test]
    fn two_interleaved_writers_both_survive() {
        let _g = guard();
        *global_state().lock().unwrap_or_else(|p| p.into_inner()) =
            serde_json::json!({ "widgets": { "list": [] } });

        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|n| {
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    update_state_field("widgets.list", move |v| {
                        v.as_array_mut()
                            .expect("widgets.list is an array")
                            .push(serde_json::json!(format!("item-{n}")));
                    })
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let list = current_state_value()["widgets"]["list"].clone();
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), 2, "both appends must survive: {list:?}");
    }
}

/// Flush any pending debounced write immediately.
/// Only writes if there is a pending (unsent) write scheduled.
pub fn flush() {
    let has_pending = {
        let mut pending = pending_write().lock().unwrap_or_else(|p| p.into_inner());
        let had = pending.is_some();
        *pending = None; // Cancel the background write.
        had
    };
    if has_pending {
        let val = global_state().lock().unwrap_or_else(|p| p.into_inner()).clone();
        if val.is_object() {
            do_write_value(&val, write_counter_arc());
        }
    }
}
