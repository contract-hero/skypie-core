// The E2E harness hook — a debug-only way to drive the REAL app instead of
// re-implementing its UI logic inside a test.
//
// The contract (`skypie_ipc::Request::E2eEval`) travels over the same
// JSON-line socket everything else in this app uses: the macOS unix socket
// (`ipc_server.rs`) and, here, an OPTIONAL loopback TCP listener for iOS,
// which has no unix socket at all (see `start_tcp_if_configured`). Both
// callers share `eval_in_webview`, so there is one implementation of "run
// this JS in the app and get the answer back", not two.
//
// The result has to travel back on its own: `WebviewWindow::eval` is
// fire-and-forget by design, and `eval_with_callback` hands back a string
// only after the script settles synchronously, which an expression that
// awaits UI work does not.
//
// So instead this reuses the ONE Rust→JS channel already proven throughout
// the app: `app.emit` + the frontend's `listen`, the same pattern
// `skypie://tree-changed` / `skypie://state-updated` / `skypie://remote-event`
// already rely on. `useE2eBridge` (ui/src/hooks/useE2eBridge.ts) is the
// frontend half — it runs `js` as an async expression and reports the result
// back through the `e2e_report` command below. `E2eState` is the rendezvous
// point in between: `eval_in_webview` parks a oneshot sender under a fresh
// id before it emits, and `e2e_report` looks the id up and fires it.
//
// This whole module — and the `Request`/`Reply` variants it serves — exists
// only under `cfg(any(feature = "e2e-hooks", debug_assertions))` (see
// `lib.rs`), so a release build without the feature carries none of it: the
// module is not compiled, its Tauri commands are not registered, and the
// socket line simply fails to parse as `Request` (skypie-ipc's own gate).
// `useE2eBridge`'s JS ships in every build (the frontend bundle doesn't vary
// by Rust profile), but it arms itself only if `e2e_ready` below accepts the
// call — a release build has no such command, so `invoke` rejects, the hook
// tears its listener down and the bridge stays permanently off. The gate is
// the EXISTENCE of the command, this build's own compiled-in cfg, so
// nothing running in the page can spoof a "yes".

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

/// How long `eval_in_webview` waits for the page to announce itself ready
/// (`e2e_ready`) before the first evaluation. The simulator can take a while
/// to load the page after the listener is already up.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// How long `eval_in_webview` waits for the page to call `e2e_report` back.
/// Generous — a fixture workspace scan or a render pass is real work — but
/// bounded, so a JS expression that never resolves (a stray `await` on
/// nothing) fails the request instead of hanging the socket connection.
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);

/// Payload of the `skypie://e2e-eval` event `useE2eBridge` listens for.
#[derive(Clone, serde::Serialize)]
struct E2eEvalEvent<'a> {
    id: &'a str,
    js: &'a str,
}

/// What one evaluation settles to: the JS value, or the message a throwing
/// expression (or a timeout) produced.
type EvalResult = Result<serde_json::Value, String>;

/// Rendezvous between `eval_in_webview` (parks a sender, awaits it) and the
/// `e2e_report` command (looks the id up, fires it). One instance, `managed`
/// by the Tauri app, reachable from both the unix-socket dispatcher and the
/// TCP one below.
#[derive(Default)]
pub struct E2eState {
    pending: Mutex<HashMap<String, oneshot::Sender<EvalResult>>>,
    /// Set once by `e2e_ready`, when the page has attached its listener. An
    /// event emitted before that is simply lost (nobody is listening), and
    /// the socket listeners come up in `setup`, well before the page loads,
    /// so a driver's first request routinely arrives too early. Waiting on
    /// this instead of emitting blindly turns that race into a short wait.
    /// `Default` is exactly right here: a fresh `watch::Sender<bool>` holds
    /// `false`, which is the "the page has not announced itself" state.
    ready: tokio::sync::watch::Sender<bool>,
}

impl E2eState {
    /// The one place the lock is taken. A poisoned mutex is recovered from
    /// rather than propagated: the map is a plain `HashMap` of senders, so a
    /// panic elsewhere cannot leave it in a state a later insert minds.
    fn pending(&self) -> MutexGuard<'_, HashMap<String, oneshot::Sender<EvalResult>>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Evaluate `js` as an async expression in the app's webview and return its
/// JSON-serialised result. Shared by both transports' dispatchers.
pub async fn eval_in_webview(app: &tauri::AppHandle, js: String) -> EvalResult {
    let state = app.state::<E2eState>();

    // The common case by far — the page announced itself long ago — costs
    // one borrow. Only a request that genuinely raced the page load pays
    // for a subscription and the timeout below.
    if !*state.ready.borrow() {
        let mut ready = state.ready.subscribe();
        let wait = ready.wait_for(|r| *r);
        if tokio::time::timeout(READY_TIMEOUT, wait).await.is_err() {
            return Err(format!(
                "the page never announced the e2e bridge within {READY_TIMEOUT:?} \
                 (is useE2eBridge mounted, and is this a debug build?)"
            ));
        }
    }

    // uuid v7 rather than a counter: the id also has to be unique across the
    // macOS socket and the TCP listener sharing one `E2eState`, and this
    // crate already reaches for v7 elsewhere (annotations.rs) for the same
    // "sortable, no shared counter" reason.
    let id = uuid::Uuid::now_v7().to_string();
    let (tx, rx) = oneshot::channel();
    state.pending().insert(id.clone(), tx);

    if let Err(e) = app.emit("skypie://e2e-eval", E2eEvalEvent { id: &id, js: &js }) {
        state.pending().remove(&id);
        return Err(format!("cannot reach the webview: {e}"));
    }

    match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        // The sender was dropped without sending — cannot happen on the path
        // above (e2e_report always sends before dropping it), but a future
        // change must not turn that into a hang.
        Ok(Err(_)) => Err("the webview closed the channel without a result".to_string()),
        Err(_) => {
            state.pending().remove(&id);
            Err(format!(
                "no result from the webview within {EVAL_TIMEOUT:?} — {id} \
                 (is useE2eBridge mounted, and is this a debug build?)"
            ))
        }
    }
}

/// Called by `useE2eBridge` right after it attached its `skypie://e2e-eval`
/// listener. From here on an emitted evaluation is guaranteed to have an
/// audience. Its EXISTENCE is also the harness's whole gate — see the module
/// doc comment for why the frontend cannot fake a "yes" here.
#[tauri::command]
pub(crate) fn e2e_ready(state: tauri::State<E2eState>) {
    let _ = state.ready.send(true);
}

/// The page's half of the round trip: called once `useE2eBridge`'s async
/// evaluation settles. Silently drops a report whose id is not pending —
/// that is a late arrival after `eval_in_webview`'s own timeout already gave
/// up and removed it, not a bug to surface to the caller.
#[tauri::command]
pub(crate) fn e2e_report(state: tauri::State<E2eState>, id: String, ok: bool, value: serde_json::Value) {
    let Some(tx) = state.pending().remove(&id) else {
        return;
    };
    let result = if ok {
        Ok(value)
    } else {
        // The catch arm above always sends a string; anything else reaching
        // here is a future caller of the command, not the script above.
        let message = match value {
            serde_json::Value::String(s) => s,
            other => other.to_string(),
        };
        Err(message)
    };
    // The receiver is gone when `eval_in_webview` already timed out; the
    // report just has nowhere left to land.
    let _ = tx.send(result);
}

// ── The iOS loopback listener ───────────────────────────────────────────────
// `ipc_server.rs`'s unix socket is macOS-only (it lives beside the MCP
// server, which never runs on a phone). iOS has no such neighbour process,
// so an E2E driver instead dials a plain TCP port on loopback. Same
// JSON-line framing, same `Request`/`Response` types, and the SAME
// dispatcher: `ipc_server::serve_connections` takes any listener, so this
// transport answers every verb the socket does, with no second copy of the
// accept/read/dispatch/answer body. Nothing is target-gated here on
// purpose: a desktop debug build can use the same path in a pinch, and the
// one thing that decides whether it runs at all is the env var below.

/// Names the loopback port. Unset (the default for every build a person
/// runs), nothing binds — this is not a socket every debug build opens, only
/// one an E2E driver explicitly asked for.
const E2E_PORT_ENV: &str = "SKYPIE_E2E_PORT";

/// Start the loopback listener when `SKYPIE_E2E_PORT` is set; otherwise a
/// no-op. Call once from `setup()`.
pub fn start_tcp_if_configured(app: tauri::AppHandle) {
    let Ok(raw_port) = std::env::var(E2E_PORT_ENV) else {
        return;
    };
    let Ok(port) = raw_port.parse::<u16>() else {
        eprintln!("skypie: e2e: {E2E_PORT_ENV}={raw_port:?} is not a valid port; not listening");
        return;
    };
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                eprintln!("skypie: e2e: listening at 127.0.0.1:{port}");
                crate::ipc_server::serve_connections(listener, "e2e", app).await;
            }
            Err(e) => eprintln!("skypie: e2e: cannot bind 127.0.0.1:{port}: {e}"),
        }
    });
}
