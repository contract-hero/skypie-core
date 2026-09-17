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
// module is not compiled, neither Tauri command is registered, and the
// socket line simply fails to parse as `Request` (skypie-ipc's own gate).
// `useE2eBridge`'s JS ships in every build (the frontend bundle doesn't vary
// by Rust profile), but it never calls `listen()` at all unless
// `e2e_bridge_enabled` answers true — a release build has no such command,
// so `invoke` rejects and the bridge stays permanently off. Nothing can
// spoof that answer: it is this build's own compiled-in cfg, not a value
// carried on the wire.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// Rendezvous between `eval_in_webview` (parks a sender, awaits it) and the
/// `e2e_report` command (looks the id up, fires it). One instance, `managed`
/// by the Tauri app, reachable from both the unix-socket dispatcher and the
/// TCP one below.
#[derive(Default)]
pub struct E2eState {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>>,
    /// Set once by `e2e_ready`, when the page has attached its listener. An
    /// event emitted before that is simply lost (nobody is listening), and
    /// the socket listeners come up in `setup`, well before the page loads,
    /// so a driver's first request routinely arrives too early. Waiting on
    /// this instead of emitting blindly turns that race into a short wait.
    ready: tokio::sync::watch::Sender<bool>,
}

impl E2eState {
    pub fn new() -> Self {
        Self { pending: Mutex::default(), ready: tokio::sync::watch::channel(false).0 }
    }
}

/// Evaluate `js` as an async expression in the app's webview and return its
/// JSON-serialised result. Shared by both transports' dispatchers.
pub async fn eval_in_webview(
    app: &tauri::AppHandle,
    js: String,
) -> Result<serde_json::Value, String> {
    // uuid v7 rather than a counter: the id also has to be unique across the
    // macOS socket and the TCP listener sharing one `E2eState`, and this
    // crate already reaches for v7 elsewhere (annotations.rs) for the same
    // "sortable, no shared counter" reason.
    {
        let mut ready = app.state::<E2eState>().ready.subscribe();
        let wait = ready.wait_for(|r| *r);
        if tokio::time::timeout(READY_TIMEOUT, wait).await.is_err() {
            return Err(format!(
                "the page never announced the e2e bridge within {READY_TIMEOUT:?} \
                 (is useE2eBridge mounted, and is this a debug build?)"
            ));
        }
    }
    let id = uuid::Uuid::now_v7().to_string();
    let (tx, rx) = oneshot::channel();
    {
        let state = app.state::<E2eState>();
        state.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), tx);
    }

    if let Err(e) = app.emit("skypie://e2e-eval", E2eEvalEvent { id: &id, js: &js }) {
        let state = app.state::<E2eState>();
        state.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        return Err(format!("cannot reach the webview: {e}"));
    }

    match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        // The sender was dropped without sending — cannot happen on the path
        // above (e2e_report always sends before dropping it), but a future
        // change must not turn that into a hang.
        Ok(Err(_)) => Err("the webview closed the channel without a result".to_string()),
        Err(_) => {
            let state = app.state::<E2eState>();
            state.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            Err(format!(
                "no result from the webview within {EVAL_TIMEOUT:?} — {id} \
                 (is useE2eBridge mounted, and is e2e_bridge_enabled true?)"
            ))
        }
    }
}

/// Runtime gate `useE2eBridge` calls before it ever subscribes to
/// `skypie://e2e-eval`. Its EXISTENCE is the gate — see the module doc
/// comment for why the frontend cannot fake a "yes" here.
#[tauri::command]
pub(crate) fn e2e_bridge_enabled() -> bool {
    true
}

/// Called by `useE2eBridge` right after it attached its `skypie://e2e-eval`
/// listener. From here on an emitted evaluation is guaranteed to have an
/// audience.
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
    let sender = {
        let mut pending = state.pending.lock().unwrap_or_else(|p| p.into_inner());
        pending.remove(&id)
    };
    let Some(tx) = sender else {
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
// so an E2E driver instead dials a plain TCP port on loopback — same
// JSON-line framing, same `Request`/`Response` types, a dispatcher narrowed
// to the two verbs a driver needs: `E2eEval` and `Status` (a liveness/
// protocol-version check). Nothing is target-gated here on purpose: a
// desktop debug build can use the same path in a pinch, and the one thing
// that decides whether it runs at all is the env var below.

/// Names the loopback port. Unset (the default for every build a person
/// runs), nothing binds — this is not a socket every debug build opens, only
/// one an E2E driver explicitly asked for.
const E2E_PORT_ENV: &str = "SKYPIE_E2E_PORT";

/// How long one connection may take to send its request line — the same
/// bound `ipc_server.rs` holds its unix socket to, and for the same reason:
/// a client that connects and says nothing must not pin a task forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
        if let Err(e) = serve_tcp(app, port).await {
            eprintln!("skypie: e2e: tcp: {e}");
        }
    });
}

async fn serve_tcp(app: tauri::AppHandle, port: u16) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("cannot bind 127.0.0.1:{port}: {e}"))?;
    eprintln!("skypie: e2e: listening at 127.0.0.1:{port}");
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("skypie: e2e: accept failed: {e}");
                continue;
            }
        };
        let app = app.clone();
        tokio::spawn(async move {
            let mut stream = stream;
            let response = handle_tcp_conn(&mut stream, app).await;
            match tokio::time::timeout(REQUEST_TIMEOUT, skypie_ipc::write_line(&mut stream, &response)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => eprintln!("skypie: e2e: cannot answer: {e}"),
                Err(_) => eprintln!("skypie: e2e: the client did not read its reply in time"),
            }
        });
    }
}

async fn handle_tcp_conn(
    stream: &mut tokio::net::TcpStream,
    app: tauri::AppHandle,
) -> skypie_ipc::Response {
    use skypie_ipc::{read_line, Request, Response};
    // Borrowed, not split: dropping `reader` at the end of this function
    // releases the borrow, so the caller can write the reply on the same
    // `stream` afterwards — the same shape `ipc_server::handle_conn` uses.
    let mut reader = tokio::io::BufReader::new(stream);
    let request =
        match tokio::time::timeout(REQUEST_TIMEOUT, read_line::<_, Request>(&mut reader)).await {
            Ok(Ok(req)) => req,
            Ok(Err(e)) => return Response::err(e),
            Err(_) => return Response::err("no request arrived in time"),
        };
    match request {
        Request::E2eEval { js } => match eval_in_webview(&app, js).await {
            Ok(value) => Response::ok(skypie_ipc::Reply::E2eResult { value }),
            Err(e) => Response::err(e),
        },
        Request::Status => Response::ok(skypie_ipc::Reply::Status(status(&app))),
        _ => Response::err("this socket serves only e2e_eval and status"),
    }
}

/// A minimal `AppStatus` that never touches macOS-only state (`RemoteState`
/// is behind `remote::status_for`'s own `cfg(target_os = "macos")`): just
/// enough for a driver to confirm the right build answered and the protocol
/// version matches.
fn status(app: &tauri::AppHandle) -> skypie_ipc::AppStatus {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let uptime = START.get_or_init(Instant::now).elapsed().as_secs();
    skypie_ipc::AppStatus {
        ipc_proto: skypie_ipc::IPC_PROTO,
        app_version: app.package_info().version.to_string(),
        node_id: String::new(),
        device: String::new(),
        state_dir: crate::state_store::state_dir(),
        booted: true,
        boot_error: None,
        uptime_secs: uptime,
        paired_devices: 0,
        active_offers: Vec::new(),
    }
}
