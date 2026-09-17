// SkyPie Tauri app entry point. Boots tauri::Builder with the deep-link plugin
// and the workspace/reader/security state.
//
// This lives in the library, not in `main.rs`, because iOS has no `main`:
// the generated Xcode project links the crate as a static library and calls
// the `start_app` symbol that `#[tauri::mobile_entry_point]` emits from
// `run()`. `main.rs` is now a desktop-only shim that calls the same `run()`.

use std::sync::Mutex;
// `Manager` for `state()` on every platform (the deep-link dispatch reads the
// peer store) and, on desktop only, `get_webview_window` for the foreground
// hop.
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

pub struct AppState {
    pub scanner: Mutex<crate::workspace::Scanner>,
    pub roots: crate::security::RootSet,
    pub watcher: Mutex<Option<crate::watcher::WatcherHandle>>,
    /// Watcher covering individual out-of-root files open in tabs.
    pub external_watcher: Mutex<Option<crate::watcher::WatcherHandle>>,
}

#[tauri::command]
fn list_dir(
    state: tauri::State<AppState>,
    path: String,
) -> Result<Vec<crate::workspace::Entry>, String> {
    let scanner = state.scanner.lock().map_err(|e| e.to_string())?;
    scanner
        .list_dir(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_workspace_roots(
    state: tauri::State<AppState>,
    path: String,
) -> Result<Vec<crate::workspace::Entry>, String> {
    let scanner = state.scanner.lock().map_err(|e| e.to_string())?;
    scanner
        .list_workspace_roots(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file(
    path: String,
) -> Result<crate::reader::FilePayload, String> {
    crate::reader::read_file(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_files_recursive(
    path: String,
) -> Result<crate::workspace::FileIndex, String> {
    crate::workspace::list_files_recursive(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

// ─── state_store + recents + bookmarks IPC ───────────────────────────────────
// These wrap the existing module functions as Tauri commands. The frontend
// (src/ipc.ts, src/state/recents-context.tsx, src/state/bookmarks-context.tsx,
// src/hooks/useBookmarks.ts) consumes them through invoke().

#[tauri::command]
fn get_state() -> serde_json::Value {
    crate::state_store::current_state_value()
}

#[tauri::command]
fn set_state_field(app: tauri::AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    crate::state_store::set_state_field(&key, value)?;
    // Broadcast the updated document so useSettings subscribers (e.g. the
    // Preview header's Slack button) pick up preference changes without an
    // app restart — the listener predates this emitter and was dead code.
    let _ = app.emit("skypie://state-updated", crate::state_store::current_state_value());
    Ok(())
}

#[tauri::command]
fn list_recents() -> Vec<crate::state_store::RecentEntry> {
    crate::recents::list()
}

#[tauri::command]
fn push_recent(path: String) -> Result<(), String> {
    crate::recents::push(std::path::Path::new(&path))
}

#[tauri::command]
fn list_bookmarks() -> Vec<crate::state_store::BookmarkEntry> {
    crate::bookmarks::list()
}

#[tauri::command]
fn add_bookmark(app: tauri::AppHandle, path: String) -> Result<(), String> {
    crate::bookmarks::add(std::path::Path::new(&path))?;
    // Broadcast the updated list so every useBookmarks subscriber (Explorer
    // star state, Preview-header star, Sidebar Bookmarks section) stays in
    // sync without each instance maintaining its own optimistic state.
    let _ = app.emit("skypie://bookmarks-updated", crate::bookmarks::list());
    Ok(())
}

#[tauri::command]
fn remove_bookmark(app: tauri::AppHandle, path: String) -> Result<(), String> {
    crate::bookmarks::remove(std::path::Path::new(&path))?;
    let _ = app.emit("skypie://bookmarks-updated", crate::bookmarks::list());
    Ok(())
}

#[tauri::command]
fn reorder_bookmarks(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    crate::bookmarks::reorder(&paths)?;
    let _ = app.emit("skypie://bookmarks-updated", crate::bookmarks::list());
    Ok(())
}

// ─── Pies IPC (M2) ─────────────────────────────────────────────────────────
// Every op below is a thin `#[tauri::command]` over a `pub(crate)
// …_for(&AppHandle, …)` function — the convention `remote.rs` follows
// (its own doc comment: "because the local socket server drives the same
// operations ... and must not grow a second implementation of any of
// them"). M5 adds `add_to_pie` on the agent socket, which will call these
// same `_for` functions directly rather than duplicate them — the ones that
// take a `&RootSet` get it from `app.state::<crate::security::RootSet>()`,
// the way `remote.rs::beam_offer_for` already does. Every write
// emits the full list on `skypie://pies-updated`, exactly as `add_bookmark`
// does for `skypie://bookmarks-updated`, so every `usePies()` subscriber —
// the band, the picker, another window later — reconciles off one source.
//
// Rust command params stay single-word (`id`, `name`, `path`, `kind`),
// matching every existing command in this file: Tauri's arg pipeline
// converts a snake_case Rust param name to camelCase for the JS `invoke()`
// call, and a single word has no case to convert.

/// Broadcast the whole pies list on `skypie://pies-updated`. Every write op
/// below ends with this call, so the six copies of the emit stay one line
/// that cannot drift apart (a dropped emit leaves the band stale).
fn emit_pies(app: &tauri::AppHandle) {
    // A dropped emit leaves every band stale with no sign of it, so say so.
    // Not an error the op should fail on: the write already landed.
    if let Err(e) = app.emit("skypie://pies-updated", crate::pies::list()) {
        eprintln!("skypie: pies: could not broadcast skypie://pies-updated: {e}");
    }
}

pub(crate) fn list_pies_for(_app: &tauri::AppHandle) -> crate::pies::PiesList {
    crate::pies::list()
}

/// The pies, plus the reason there are none when this build cannot read the
/// document — see `pies::PiesList`. `usePies` raises the warning as one
/// notice instead of showing an empty band with no explanation.
#[tauri::command]
fn list_pies(app: tauri::AppHandle) -> crate::pies::PiesList {
    list_pies_for(&app)
}

pub(crate) fn upsert_pie_for(
    app: &tauri::AppHandle,
    id: Option<&str>,
    name: &str,
) -> Result<crate::pies::Pie, String> {
    let pie = crate::pies::upsert(id, name)?;
    emit_pies(app);
    Ok(pie)
}

/// Create (`id` absent/null) or rename (`id` present) a pie. Returns the
/// resulting `Pie` — the frontend needs the id a NEW pie was minted with,
/// since `pies::upsert` (not the caller) chooses it.
#[tauri::command]
fn upsert_pie(
    app: tauri::AppHandle,
    id: Option<String>,
    name: String,
) -> Result<crate::pies::Pie, String> {
    upsert_pie_for(&app, id.as_deref(), &name)
}

pub(crate) fn remove_pie_for(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    crate::pies::remove(id)?;
    emit_pies(app);
    Ok(())
}

#[tauri::command]
fn remove_pie(app: tauri::AppHandle, id: String) -> Result<(), String> {
    remove_pie_for(&app, &id)
}

/// Resolve one caller-supplied path through the single canonicalisation
/// gate. `security.rs` states there is exactly ONE gate on this machine;
/// `pies.rs` used to hold a second `fs::canonicalize` of its own, which the
/// gate's own `canonicalize_allow_rootless` variant already covers — pie
/// members may legitimately live outside the workspace root (spec section
/// 6), and only an UNRESOLVABLE path is refused. `_out_of_root` is bound
/// rather than discarded because M3's census reads it.
fn canonicalize_member_path(
    path: &str,
    roots: &crate::security::RootSet,
) -> Result<std::path::PathBuf, String> {
    let (canonical, _out_of_root) =
        crate::security::canonicalize_allow_rootless(std::path::Path::new(path), roots)
            .map_err(|e| e.to_string())?;
    Ok(canonical)
}

pub(crate) fn add_pie_member_for(
    app: &tauri::AppHandle,
    roots: &crate::security::RootSet,
    id: &str,
    path: &str,
    kind: crate::pies::PieMemberKind,
    source: Option<crate::pies::PieMemberSource>,
) -> Result<(), String> {
    let canonical = canonicalize_member_path(path, roots)?;
    crate::pies::add_member(id, &canonical, kind, source)?;
    emit_pies(app);
    Ok(())
}

#[tauri::command]
fn add_pie_member(
    app: tauri::AppHandle,
    roots: tauri::State<'_, crate::security::RootSet>,
    id: String,
    path: String,
    kind: crate::pies::PieMemberKind,
    source: Option<crate::pies::PieMemberSource>,
) -> Result<(), String> {
    add_pie_member_for(&app, &roots, &id, &path, kind, source)
}

pub(crate) fn remove_pie_member_for(app: &tauri::AppHandle, id: &str, path: &str) -> Result<(), String> {
    crate::pies::remove_member(id, std::path::Path::new(path))?;
    emit_pies(app);
    Ok(())
}

#[tauri::command]
fn remove_pie_member(app: tauri::AppHandle, id: String, path: String) -> Result<(), String> {
    remove_pie_member_for(&app, &id, &path)
}

pub(crate) fn relocate_pie_member_for(
    app: &tauri::AppHandle,
    roots: &crate::security::RootSet,
    id: &str,
    old: &str,
    new: &str,
) -> Result<(), String> {
    let canonical_new = canonicalize_member_path(new, roots)?;
    crate::pies::relocate_member(id, std::path::Path::new(old), &canonical_new)?;
    emit_pies(app);
    Ok(())
}

#[tauri::command]
fn relocate_pie_member(
    app: tauri::AppHandle,
    roots: tauri::State<'_, crate::security::RootSet>,
    id: String,
    old: String,
    new: String,
) -> Result<(), String> {
    relocate_pie_member_for(&app, &roots, &id, &old, &new)
}

pub(crate) fn touch_pie_seen_for(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    crate::pies::touch_seen(id)?;
    emit_pies(app);
    Ok(())
}

#[tauri::command]
fn touch_pie_seen(app: tauri::AppHandle, id: String) -> Result<(), String> {
    touch_pie_seen_for(&app, &id)
}

/// Resolve `path` to its canonical form for the UI — used before comparing
/// a caller-supplied path (a tab entry, a tree row, a deep link — none
/// guaranteed canonical) against a pie's stored members, which the add path
/// canonicalizes the same way. Runs the SAME gate
/// (`canonicalize_member_path`) the add does, so the picker's check mark can
/// never disagree with what an add would store. Errors when the path cannot
/// be resolved, which `PiePicker` turns into a refusal notice rather than
/// opening a picker with a check mark that can never match.
pub(crate) fn canonicalize_path_for(
    roots: &crate::security::RootSet,
    path: &str,
) -> Result<String, String> {
    Ok(canonicalize_member_path(path, roots)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn canonicalize_path(
    roots: tauri::State<'_, crate::security::RootSet>,
    path: String,
) -> Result<String, String> {
    canonicalize_path_for(&roots, &path)
}

/// Start (or replace) the filesystem watcher rooted at `path`. Each successful
/// call drops any previous watcher handle, which shuts down its entire
/// pipeline (watcher, flush thread, raw-event thread, and the bridge thread
/// below via channel disconnect), then spawns a fresh notify-rs watcher plus
/// a bridge thread that forwards `TreeChange` events to the webview as
/// `skypie://tree-changed`.
#[tauri::command]
fn set_workspace_root(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    roots: tauri::State<crate::security::RootSet>,
    path: String,
) -> Result<(), String> {
    // The picked workspace must be *addable* to the root set, not gated by
    // the boot-time set — gating here would reject any workspace outside
    // ~/workspace and defeat the folder picker. RootSet is Arc-shared, so
    // the deep-link callback's clone sees the addition immediately and deep
    // links into the picked workspace classify as in-root.
    let root = std::path::PathBuf::from(&path);
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {canonical:?}"));
    }
    roots.add_root(&canonical);

    let ignore_globs: Vec<String> = crate::workspace::DEFAULT_IGNORED
        .iter()
        .map(|s| (*s).to_string())
        .collect();

    let (tx, rx) = std::sync::mpsc::channel();
    let handle = crate::watcher::start_watching(vec![canonical], ignore_globs, tx)
        .map_err(|e| format!("{e:?}"))?;

    {
        let mut guard = state.watcher.lock().map_err(|e| e.to_string())?;
        *guard = Some(handle);
    }

    std::thread::spawn(move || {
        for change in rx {
            let _ = app.emit("skypie://tree-changed", change);
        }
    });

    Ok(())
}

/// Replace the set of individually watched out-of-root files. The frontend
/// calls this with the full set of open external-tab files whenever a tab
/// opens or closes; an empty set clears the watcher. Changes are emitted as
/// `skypie://file-changed` with a `{ kind, path }` payload — a dedicated
/// event so tab auto-reload stays decoupled from tree refresh.
#[tauri::command]
fn watch_external_paths(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    // Drop the previous watcher first — its pipeline shuts down via the
    // handle's Drop cascade.
    {
        let mut guard = state.external_watcher.lock().map_err(|e| e.to_string())?;
        *guard = None;

        if paths.is_empty() {
            return Ok(());
        }

        let (tx, rx) = std::sync::mpsc::channel();
        let path_bufs: Vec<std::path::PathBuf> =
            paths.iter().map(std::path::PathBuf::from).collect();

        // The watcher canonicalizes inputs and emits CANONICAL paths, but the
        // frontend keys reloads by the exact string stored in its tab state
        // (e.g. "/tmp/x.html", which canonicalizes to "/private/tmp/x.html"
        // on macOS). Map canonical → caller-supplied so emitted events match
        // what the frontend is listening for.
        let originals: std::collections::HashMap<std::path::PathBuf, std::path::PathBuf> =
            path_bufs
                .iter()
                .filter_map(|p| p.canonicalize().ok().map(|c| (c, p.clone())))
                .collect();

        let handle = crate::watcher::watch_files(path_bufs, tx)
            .map_err(|e| format!("{e:?}"))?;
        *guard = Some(handle);

        std::thread::spawn(move || {
            for change in rx {
                // The webview event keeps the caller's original path so an
                // open external tab (addressed by that path) reloads.
                let display = crate::watcher::FileChange {
                    kind: change.kind,
                    path: originals.get(&change.path).cloned().unwrap_or(change.path),
                };
                let _ = app.emit("skypie://file-changed", display);
            }
        });
    }

    Ok(())
}

pub fn run(context: tauri::Context) {
    let home = std::env::var("HOME").unwrap_or_else(|_| String::from("/"));
    let default_root = std::path::PathBuf::from(format!("{home}/workspace"));
    let roots = crate::security::RootSet::new(vec![default_root]);
    let roots_for_setup = roots.clone();

    // Eager-load the on-disk state.json into the in-memory global state so the
    // very first `get_state` / `list_recents` / `list_bookmarks` call after
    // launch returns the persisted values, not Default. Without this the
    // frontend silently rehydrates to empty on every cold start.
    crate::state_store::load();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    // Desktop-only plugins. `window-state` has no window geometry to persist
    // on iOS and `drag` (drag-out to Finder) has no iOS platform impl at all,
    // so both are macOS-target dependencies (see Cargo.toml) and both are
    // registered only here.
    #[cfg(target_os = "macos")]
    let builder = builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_drag::init());

    let builder = builder
        .manage(AppState {
            scanner: Mutex::new(crate::workspace::Scanner::new()),
            roots: roots.clone(),
            watcher: Mutex::new(None),
            external_watcher: Mutex::new(None),
        })
        .manage(roots)
        .manage(crate::remote::RemoteState::new());
    // The E2E harness's rendezvous state (`eval_in_webview` ↔ `e2e_report`).
    // Managed unconditionally when the module is compiled at all — the
    // module itself carries the debug/feature gate (lib.rs), so there is
    // nothing further to gate here.
    #[cfg(any(feature = "e2e-hooks", debug_assertions))]
    let builder = builder.manage(crate::e2e::E2eState::default());

    builder
        .invoke_handler(tauri::generate_handler![
            list_dir,
            list_workspace_roots,
            read_file,
            list_files_recursive,
            crate::platform::platform_info,
            set_workspace_root,
            watch_external_paths,
            get_state,
            set_state_field,
            list_recents,
            push_recent,
            list_bookmarks,
            add_bookmark,
            remove_bookmark,
            reorder_bookmarks,
            list_pies,
            upsert_pie,
            remove_pie,
            add_pie_member,
            remove_pie_member,
            relocate_pie_member,
            touch_pie_seen,
            canonicalize_path,
            crate::share::share_file,
            crate::share::share_link,
            crate::remote::beam_offer,
            crate::remote::beam_stop,
            crate::remote::beam_list_offers,
            crate::remote::beam_receive,
            crate::remote::beam_received_dir,
            crate::remote::beam_list_received,
            crate::remote::remote_list_peers,
            crate::remote::remote_pair_begin,
            crate::remote::remote_pair_complete,
            crate::remote::remote_pair_confirm,
            crate::remote::remote_unpair,
            crate::remote::remote_connect,
            crate::remote::remote_get,
            crate::remote::remote_share_link,
            crate::remote::remote_list_shared,
            crate::remote::remote_sync_annotations,
            crate::annotations_api::annotations_list,
            crate::annotations_api::annotations_index,
            crate::annotations_api::annotations_add,
            crate::annotations_api::annotations_reply,
            crate::annotations_api::annotations_set_status,
            crate::annotations_api::annotations_export,
            #[cfg(any(feature = "e2e-hooks", debug_assertions))]
            crate::e2e::e2e_report,
            #[cfg(any(feature = "e2e-hooks", debug_assertions))]
            crate::e2e::e2e_ready,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            // The debounced state writer runs on a bare thread with no
            // AppHandle of its own (state_store.rs, `set_write_failure_sink`).
            // Give it one emit closure so a failed write reaches the user
            // instead of only stderr: every pies action is a state write.
            {
                let sink_handle = app_handle.clone();
                crate::state_store::set_write_failure_sink(move |message| {
                    let _ = sink_handle.emit("skypie://state-write-failed", message);
                });
            }
            // Lazy boot, launch half (design §4): sockets at startup only
            // when this install has peers AND `preferences.remote_listen`
            // is on. Otherwise the app still dials nothing until an action.
            crate::remote::listen_at_launch(&app_handle);
            // The local socket `skypie-mcp` talks to. macOS only: the MCP
            // server runs beside the desktop app.
            #[cfg(target_os = "macos")]
            crate::ipc_server::start(app_handle.clone());
            // The E2E harness's loopback listener — iOS has no unix socket
            // to reach this app through, so a driver dials TCP instead when
            // `SKYPIE_E2E_PORT` is set. A no-op otherwise, on every platform.
            #[cfg(any(feature = "e2e-hooks", debug_assertions))]
            crate::e2e::start_tcp_if_configured(app_handle.clone());
            let roots = roots_for_setup;
            app.deep_link().on_open_url(move |event| {
                // Bring the window to the foreground before dispatching, so a
                // deep-link click from another app raises Sky Pie instead of
                // silently delivering the file to a backgrounded / minimized /
                // hidden window. On macOS, `set_focus` activates the app via
                // NSApp.activate(ignoringOtherApps:) — `macosPrivateApi` is
                // already enabled in tauri.conf.json. Calls are idempotent, so
                // an already-focused window sees no flicker.
                //
                // Desktop only: iOS has no window to unminimize, and the
                // system already foregrounds the app when it hands over a
                // URL, so `unminimize`/`show`/`set_focus` do not exist there.
                #[cfg(desktop)]
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                for url in event.urls() {
                    let url_str = url.to_string();
                    crate::handle_deep_link(&url_str);
                    let remote = app_handle.state::<crate::remote::RemoteState>();
                    let lookup = |id: &str| remote.peers().get(id);
                    let local = crate::LocalPeers { self_id: remote.self_id(), lookup: &lookup };
                    match crate::dispatch_deep_link(&url_str, &roots, &local) {
                        Ok(crate::DeepLinkAction::OpenFile(open_event)) => {
                            let _ = app_handle.emit("skypie://open-file", open_event);
                        }
                        Ok(crate::DeepLinkAction::OpenRemote(ev)) => {
                            let _ = app_handle.emit(
                                "skypie://remote-event",
                                crate::remote::RemoteEvent::OpenRemote {
                                    peer: ev.peer,
                                    device: ev.device,
                                    path: ev.path,
                                    line: ev.line,
                                    intent: ev.intent,
                                },
                            );
                        }
                        Ok(crate::DeepLinkAction::BeamReceive(req)) => {
                            let _ = app_handle.emit("skypie://beam-receive-request", req);
                        }
                        Ok(crate::DeepLinkAction::BeamSend(req)) => {
                            let _ = app_handle.emit("skypie://beam-send-request", req);
                        }
                        Ok(crate::DeepLinkAction::Pair(req)) => {
                            // Debug-only E2E hook (third arm, same env contract
                            // as `remote::test_autopair`): a simulator cannot
                            // be tapped, so the arriving link dials without the
                            // confirm UI. Absent from release builds, and the
                            // env var is named in exactly one place.
                            #[cfg(debug_assertions)]
                            if crate::remote::autopair_enabled() {
                                crate::remote::test_autopair_dial(
                                    app_handle.clone(),
                                    req.ticket.clone(),
                                );
                            }
                            // Joins the frozen `skypie://*` namespace through
                            // the one remote event name, discriminated by
                            // `kind` — no new event for one more verb.
                            let _ = app_handle.emit(
                                "skypie://remote-event",
                                crate::remote::RemoteEvent::PairLink {
                                    peer: req.host_id,
                                    peer_short: req.host_id_short,
                                    device: req.device,
                                    ticket: req.ticket,
                                },
                            );
                        }
                        Err(err_event) => {
                            eprintln!(
                                "skypie: deep-link rejected: {} ({})",
                                err_event.reason, err_event.url
                            );
                            let _ = app_handle.emit("skypie://deep-link-error", err_event);
                        }
                    }
                }
            });
            Ok(())
        })
        .build(context)
        .expect("error while building Tauri application")
        .run(|app, event| {
            // The one signal iOS gives that the app is in front of the user
            // again. It must be `WindowEvent::Resumed` — that is Tauri's name
            // for `applicationWillEnterForeground`. `RunEvent::Resumed` looks
            // like the same thing and is not: on mobile it comes from the
            // event loop's own `StartCause::Poll` and fires while the phone
            // is still asleep, so the recovery would run against a frozen
            // network stack and then never run when it matters.
            //
            // Both the arm and its handler are mobile-only, because macOS
            // never suspends the process. The arm MUST stay cfg-gated:
            // `WindowEvent::Resumed` itself does not exist off mobile, so an
            // ungated arm stops the desktop build compiling.
            #[cfg(mobile)]
            if let tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Resumed,
                ..
            } = &event
            {
                crate::remote::on_foreground(app);
            }
            // The handle is read by the arm above and by nothing else, so the
            // desktop build has to say out loud that it is not reading it.
            #[cfg(not(mobile))]
            let _ = app;
            if let tauri::RunEvent::Exit = event {
                // Flush any debounced state_store write so a quit within the
                // 250 ms window doesn't lose bookmarks/recents/pane sizes.
                crate::state_store::flush();
                #[cfg(target_os = "macos")]
                crate::ipc_server::cleanup();
            }
        });
}
