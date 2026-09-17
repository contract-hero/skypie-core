// The local socket `skypie-mcp` drives this app through, and the dispatcher
// every transport shares.
//
// The app is the only iroh node on the machine. A Claude Code session that
// wants a share link, a beam link or a pairing asks THIS process over
// `<state_dir>/app.sock` — one JSON line in, one JSON line out, per
// connection (`skypie_ipc`). Nearly every request maps onto the same
// `pub(crate)` function the matching `#[tauri::command]` wraps, so there is
// exactly one implementation of each operation; `E2eEval` is the exception,
// since it has no UI counterpart to wrap (`e2e.rs`).
//
// `skypie-mcp` is also not the only caller any more: the E2E harness's
// loopback TCP listener (`e2e.rs`) serves the same dispatcher on iOS, which
// has no unix socket at all.
//
// Trust: the socket is 0600 inside `~/Library/Application Support/SkyPie`,
// so it is reachable by this user's processes and nobody else's — the same
// boundary `identity.key` already draws. The loopback port draws no such
// boundary, which is why it is handed `Transport::E2eOnly` and answers only
// the verbs a test driver needs.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use skypie_ipc::{read_line, write_line, Reply, Request, Response};
use tauri::Manager;

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use skypie_ipc::socket_path;
#[cfg(target_os = "macos")]
use tokio::net::{UnixListener, UnixStream};

/// How long one connection may take to send its request line, and to read
/// its reply back. A client that connects and says nothing, or that never
/// drains its reply, must not hold a task forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

// ── The unix socket (macOS only) ────────────────────────────────────────────
// The MCP server runs beside the desktop app; the phone has no such
// neighbour, so every item down to `claim_socket` — the `OWNS_SOCKET` flag,
// `path`, `start`, `cleanup`, `serve` and `claim_socket` itself — is
// target-gated, as is the `Listener` impl for `UnixListener` further below.
// Everything else from `Transport` down serves every target, because the
// E2E harness's loopback TCP listener (`e2e.rs`) reuses it verbatim.

/// Set once THIS process bound the socket. A second instance over the same
/// state directory steps aside in `claim_socket`, and must not unlink the
/// live one on its own exit — the survivor would keep listening on an
/// unlinked inode, and every `skypie-mcp` call would launch it again.
#[cfg(target_os = "macos")]
static OWNS_SOCKET: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
fn path() -> PathBuf {
    socket_path(&crate::state_store::state_dir())
}

/// Bind the socket and serve it for the life of the app. Spawned from the
/// Tauri setup hook; failures are logged, never fatal — the app is fully
/// usable without an MCP client.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app).await {
            eprintln!("skypie: ipc: {e}");
        }
    });
}

/// Remove the socket file on exit, so the next launch (and `skypie-mcp`'s
/// "is the app running?" probe) sees a clean state directory.
#[cfg(target_os = "macos")]
pub fn cleanup() {
    if OWNS_SOCKET.swap(false, Ordering::SeqCst) {
        let _ = std::fs::remove_file(path());
    }
}

#[cfg(target_os = "macos")]
async fn serve(app: tauri::AppHandle) -> Result<(), String> {
    let path = path();
    let listener = claim_socket(&path).await?;
    eprintln!("skypie: ipc: listening at {}", path.display());
    serve_connections(listener, Transport::Trusted { label: "ipc" }, app).await;
    Ok(())
}

/// Bind `path`, dealing with what a previous run left behind.
///
/// A socket file that something still answers on belongs to another running
/// copy of this app over the same state directory: this one steps aside
/// (logs, does not serve) rather than steal the name. A file nothing
/// answers on is a crash leftover and is removed.
#[cfg(target_os = "macos")]
async fn claim_socket(path: &Path) -> Result<UnixListener, String> {
    if path.exists() {
        match UnixStream::connect(path).await {
            Ok(_) => {
                return Err(format!(
                    "another Sky Pie already serves {} — not binding it",
                    path.display()
                ))
            }
            Err(_) => {
                std::fs::remove_file(path)
                    .map_err(|e| format!("cannot remove the stale socket {}: {e}", path.display()))?;
            }
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        // The state directory holds `identity.key`; nothing else in the app
        // sets its mode, and `SKYPIE_STATE_DIR` can point anywhere.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    // `bind` creates the socket inode at `0777 & ~umask`, and one request
    // line is enough to drive this app — so the socket is never reachable
    // under its published name until it is owner-only: bind under a staging
    // name, restrict it, then rename it into place.
    let staging = path.with_extension("sock.new");
    let _ = std::fs::remove_file(&staging);
    let listener = UnixListener::bind(&staging).map_err(|e| {
        format!("cannot bind {} ({} bytes): {e}", staging.display(), staging.as_os_str().len())
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot restrict {}: {e}", staging.display()))?;
    }
    std::fs::rename(&staging, path)
        .map_err(|e| format!("cannot move {} into place: {e}", staging.display()))?;
    OWNS_SOCKET.store(true, Ordering::SeqCst);
    Ok(listener)
}

/// One accepted connection, independent of how it arrived. Both transports
/// carry the same JSON-line protocol, so the accept → spawn → read →
/// dispatch → answer body below is written once and parameterised on this.
pub(crate) trait Listener {
    type Conn: AsyncRead + AsyncWrite + Unpin + Send + 'static;
    fn accept(&self) -> impl std::future::Future<Output = std::io::Result<Self::Conn>> + Send;
}

#[cfg(target_os = "macos")]
impl Listener for UnixListener {
    type Conn = UnixStream;
    async fn accept(&self) -> std::io::Result<UnixStream> {
        UnixListener::accept(self).await.map(|(stream, _)| stream)
    }
}

impl Listener for tokio::net::TcpListener {
    type Conn = tokio::net::TcpStream;
    async fn accept(&self) -> std::io::Result<tokio::net::TcpStream> {
        tokio::net::TcpListener::accept(self).await.map(|(stream, _)| stream)
    }
}

/// What a transport is allowed to ask for — a capability, not a label.
///
/// The unix socket is 0600 inside the state directory, so anything that
/// reaches it is already this user: it may drive every verb. The E2E
/// harness's loopback TCP port has no such boundary (any process on the
/// machine can dial it), so it carries `E2eOnly` and the sharing and
/// pairing verbs are refused on it. Making this an enum rather than a
/// string means a new transport has to state which of the two it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Transport {
    /// Only the unix socket constructs this, and that listener is macOS-only
    /// — on iOS the variant is still part of the shared dispatcher's
    /// vocabulary, just never built.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Trusted { label: &'static str },
    E2eOnly,
}

impl Transport {
    /// How this transport names itself in the log lines.
    fn label(self) -> &'static str {
        match self {
            Transport::Trusted { label } => label,
            Transport::E2eOnly => "e2e",
        }
    }
}

/// The verbs that mint links, move files or change who this device trusts.
/// Only a trusted transport may drive them.
fn is_trusted_only(req: &Request) -> bool {
    matches!(
        req,
        Request::ShareLink { .. }
            | Request::BeamArtifact { .. }
            | Request::StopBeam { .. }
            | Request::ListDevices { .. }
            | Request::PairDevice
            | Request::PairStatus
            | Request::ConfirmPairing { .. }
            | Request::ForgetDevice { .. }
    )
}

/// Serve `listener` for the life of the app: one request in, one response
/// out, per connection. `transport` says what the connections arriving here
/// may ask for, and names them in the log lines. Never returns.
pub(crate) async fn serve_connections<L: Listener>(
    listener: L,
    transport: Transport,
    app: tauri::AppHandle,
) {
    let label = transport.label();
    loop {
        let stream = match listener.accept().await {
            Ok(stream) => stream,
            Err(e) => {
                eprintln!("skypie: {label}: accept failed: {e}");
                // A transient fault (a client gone between SYN and accept)
                // retries immediately enough after this pause; a persistent
                // one (EMFILE, a broken listener) would otherwise spin the
                // loop hot and flood stderr for the life of the app.
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let app = app.clone();
        tokio::spawn(async move {
            let mut stream = stream;
            let response = handle_conn(&mut stream, |req| dispatch(app, transport, req)).await;
            // Bounded like the read: a client that never reads its reply
            // must not pin this task once the send buffer fills.
            match tokio::time::timeout(REQUEST_TIMEOUT, write_line(&mut stream, &response)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => eprintln!("skypie: {label}: cannot answer: {e}"),
                Err(_) => eprintln!("skypie: {label}: the client did not read its reply in time"),
            }
        });
    }
}

/// Read one request and produce its response. `dispatch` is a parameter so
/// the framing — timeout, oversized line, malformed JSON — is provable
/// without an `AppHandle`.
async fn handle_conn<S, F, Fut>(stream: &mut S, dispatch: F) -> Response
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnOnce(Request) -> Fut,
    Fut: std::future::Future<Output = Result<Reply, String>>,
{
    // Borrowed, not split: the reader is dropped before the caller writes
    // the reply on the same stream.
    let mut reader = BufReader::new(stream);
    let request = match tokio::time::timeout(REQUEST_TIMEOUT, read_line::<_, Request>(&mut reader))
        .await
    {
        Ok(Ok(req)) => req,
        Ok(Err(e)) => return Response::err(e),
        Err(_) => return Response::err("no request arrived in time"),
    };
    match dispatch(request).await {
        Ok(reply) => Response::ok(reply),
        Err(message) => Response::err(message),
    }
}

/// One request onto the operation the app already implements.
///
/// Every transport shares this one dispatcher, so a verb answers the same
/// way whichever socket carried it — except for what `transport` is allowed
/// to ask for, which is checked once, up front. The MCP verbs below reach
/// code that only exists on macOS (`remote.rs`'s own gates); on any other
/// target they are replaced by the single fallthrough arm at the end, which
/// answers an error instead of silently behaving differently.
async fn dispatch(
    app: tauri::AppHandle,
    transport: Transport,
    req: Request,
) -> Result<Reply, String> {
    #[cfg(target_os = "macos")]
    use crate::remote;
    if transport == Transport::E2eOnly && is_trusted_only(&req) {
        return Err(e2e_only_refusal(&req));
    }
    match req {
        #[cfg(target_os = "macos")]
        Request::ShareLink { path } => {
            let link = remote::share_link_for(&app, &path).await?;
            Ok(Reply::ShareLink {
                link: link.link,
                node_id: link.node_id,
                device: link.device,
                path: link.path,
                name: link.name,
                size: link.size,
            })
        }
        #[cfg(target_os = "macos")]
        Request::BeamArtifact { path, ttl_hours } => {
            let offer = remote::beam_offer_for(&app, &path, ttl_hours).await?;
            Ok(Reply::BeamLink {
                link: offer.link,
                ticket: offer.ticket,
                name: offer.name,
                size: offer.size,
                expires_at: offer.expires_at,
                hash: offer.id,
            })
        }
        #[cfg(target_os = "macos")]
        Request::StopBeam { hash } => {
            let stopped = remote::beam_stop_for(&app, hash.as_deref()).await?;
            Ok(Reply::Stopped { stopped: stopped.iter().map(remote::offer_summary).collect() })
        }
        #[cfg(target_os = "macos")]
        Request::ListDevices { probe } => {
            Ok(Reply::Devices { devices: remote::list_devices_for(&app, probe).await })
        }
        #[cfg(target_os = "macos")]
        Request::PairDevice => {
            let invite = remote::pair_begin_for(&app).await?;
            Ok(Reply::PairInvite {
                link: invite.link,
                ticket: invite.ticket,
                node_id: invite.node_id,
                device: invite.device,
                expires_at: invite.expires_at,
            })
        }
        #[cfg(target_os = "macos")]
        Request::PairStatus => Ok(Reply::PairStatus { pending: remote::pair_status_for(&app) }),
        #[cfg(target_os = "macos")]
        Request::ConfirmPairing { accept, node_id } => {
            let outcome = remote::pair_confirm_for(&app, accept, node_id.as_deref())?;
            Ok(Reply::PairingOutcome {
                paired: outcome.peer.is_some(),
                device: outcome.device,
                node_id: outcome.node_id,
            })
        }
        #[cfg(target_os = "macos")]
        Request::ForgetDevice { device } => {
            let peer = remote::forget_device_for(&app, &device).await?;
            Ok(Reply::Forgotten { device: peer.device, node_id: peer.node_id })
        }
        Request::Status => Ok(Reply::Status(crate::remote::status_for(&app).await)),

        // ── Agent reach (M5) ────────────────────────────────────────────
        // Called SYNCHRONOUSLY, like `pair_confirm_for` above — `add_to_pie_for`
        // does its own filesystem I/O (`fs::canonicalize`, `fs::metadata`)
        // OUTSIDE the state lock (inside `pies::add_member`/`pies::canonicalize`
        // themselves), so nothing here needs `spawn_blocking`.
        Request::AddToPie { pie, path, origin } => {
            // Sanitize each origin field HERE, not just trust what a
            // caller sent — `skypie-mcp::args::validate_origin_field`
            // already does this for the `skypie-mcp` client, but the
            // socket is the actual trust boundary the app owns, and any
            // other client of it (this e2e harness included) must get the
            // same hygiene (review: ipc_server.rs:222, minor). `pie` itself
            // is trimmed/validated a few lines down, inside
            // `add_to_pie_for` → `pies::find_or_create`.
            let origin = origin
                .map(|o| -> Result<crate::pies::PieMemberOrigin, String> {
                    let field = |raw: Option<String>| match raw {
                        Some(s) => crate::pies::validate_origin_field(&s),
                        None => Ok(None),
                    };
                    Ok(crate::pies::PieMemberOrigin {
                        session_id: field(o.session_id)?,
                        prompt_id: field(o.prompt_id)?,
                        cwd: field(o.cwd)?,
                    })
                })
                .transpose()?;
            // The RootSet is the one canonicalisation gate's state, held
            // by the app the same way every webview command receives it as
            // a `tauri::State`; the socket reads it from the handle.
            let roots = app.state::<crate::security::RootSet>();
            let added = crate::app::add_to_pie_for(&app, &roots, &pie, &path, origin)?;
            Ok(Reply::AddedToPie {
                pie: added.pie.name,
                pie_id: added.pie.id,
                path: added.path,
                members: added.pie.members.len(),
                created: added.created,
                added: added.added,
            })
        }

        // ── Feedback ────────────────────────────────────────────────────
        Request::FeedbackFor { path } => {
            let source = path.to_string_lossy().into_owned();
            // One read, both answers — see `hook_feedback`.
            let (open, context) = crate::annotations_api::hook_feedback(&source);
            Ok(Reply::Feedback { path, open, context })
        }
        Request::FeedbackIndex => Ok(Reply::FeedbackIndex {
            files: crate::annotations_api::index_for()
                .into_iter()
                .filter(|row| row.open > 0)
                .map(|row| skypie_ipc::FeedbackFile {
                    path: std::path::PathBuf::from(&row.source),
                    open: row.open,
                    total: row.total,
                    updated_at: row.updated_at,
                })
                .collect(),
        }),
        // ── E2E harness ─────────────────────────────────────────────────
        #[cfg(any(feature = "e2e-hooks", debug_assertions))]
        Request::E2eEval { js } => {
            let value = crate::e2e::eval_in_webview(&app, js).await?;
            Ok(Reply::E2eResult { value })
        }

        Request::ResolveFeedback { path, id, note, addressed } => {
            let source = path.to_string_lossy().into_owned();
            let status = if addressed {
                crate::annotations::Status::Addressed
            } else {
                crate::annotations::Status::Wontfix
            };
            crate::annotations_api::set_status_for(&app, &source, &id, status, note)?;
            Ok(Reply::FeedbackResolved {
                id,
                path,
                resolution: if addressed { "addressed".into() } else { "wontfix".into() },
                remaining: crate::annotations::open_count(
                    &crate::state_store::state_dir(),
                    &source,
                ),
            })
        }

        // The MCP verbs above are macOS-only. Answering explicitly beats a
        // compile error here, because the E2E harness's TCP listener serves
        // this same dispatcher on iOS.
        #[cfg(not(target_os = "macos"))]
        other => Err(no_remote_sharing(&other)),
    }
}

/// Why an `E2eOnly` transport refused a verb. Names the verb: `Request`
/// derives `Debug`, and a refusal that does not say what it refused reads
/// as a transport fault to whoever hits it.
fn e2e_only_refusal(req: &Request) -> String {
    format!("this transport serves only e2e verbs (got {req:?})")
}

/// Why a non-macOS build refused a verb. Also names it, so a future variant
/// a macOS-first author forgets to serve on iOS is not silently absorbed.
#[cfg(not(target_os = "macos"))]
fn no_remote_sharing(req: &Request) -> String {
    format!("this build serves no remote-sharing verbs (got {req:?})")
}

// Unix-socket specific: `claim_socket` and its stale-file handling have no
// counterpart on the TCP side.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    /// A short socket path: macOS caps `sun_path` at 104 bytes, and a
    /// tempdir under `/var/folders/…` plus a name fits with room to spare.
    fn sock(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("t.sock")
    }

    #[tokio::test]
    async fn a_stale_socket_file_is_removed_and_a_live_one_is_respected() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = sock(&dir);
        // A file nothing listens on: what a crash leaves behind.
        std::fs::write(&path, b"").unwrap();
        let listener = claim_socket(&path).await.expect("the stale file is replaced");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "owner-only");
        }
        // Something is listening now: a second claim steps aside.
        let err = claim_socket(&path).await.expect_err("a live socket is not stolen");
        assert!(err.contains("another Sky Pie"), "{err}");
        drop(listener);
    }

    #[tokio::test]
    async fn one_request_is_answered_and_a_bad_line_is_an_error_reply() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = sock(&dir);
        let listener = claim_socket(&path).await.unwrap();

        // Good line.
        let client = tokio::spawn({
            let path = path.clone();
            async move {
                let mut c = UnixStream::connect(&path).await.unwrap();
                write_line(&mut c, &Request::Status).await.unwrap();
                let mut r = BufReader::new(c);
                read_line::<_, Response>(&mut r).await.unwrap()
            }
        });
        let (mut server_side, _) = listener.accept().await.unwrap();
        let response = handle_conn(&mut server_side, |req| async move {
            assert_eq!(req, Request::Status);
            Ok(Reply::Forgotten { device: "x".into(), node_id: "y".into() })
        })
        .await;
        write_line(&mut server_side, &response).await.unwrap();
        assert_eq!(
            client.await.unwrap(),
            Response::ok(Reply::Forgotten { device: "x".into(), node_id: "y".into() })
        );

        // Garbage line: the dispatcher never runs, the reply is an error.
        let client = tokio::spawn({
            let path = path.clone();
            async move {
                let mut c = UnixStream::connect(&path).await.unwrap();
                c.write_all(b"this is not json\n").await.unwrap();
                let mut r = BufReader::new(c);
                read_line::<_, Response>(&mut r).await.unwrap()
            }
        });
        let (mut server_side, _) = listener.accept().await.unwrap();
        let response = handle_conn(&mut server_side, |_| async {
            panic!("a malformed request must not be dispatched")
        })
        .await;
        write_line(&mut server_side, &response).await.unwrap();
        match client.await.unwrap() {
            Response::Err { message } => assert!(message.contains("malformed"), "{message}"),
            other => panic!("expected an error reply, got {other:?}"),
        }
    }
}

// Transport-shaped tests: no `AppHandle`, no unix socket, so they run on
// every target the app builds for.
#[cfg(test)]
mod transport_tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    /// The macOS suite proves the framing over a `UnixStream`; iOS carries
    /// the very same `handle_conn` over TCP and nothing exercised that.
    #[tokio::test]
    async fn one_request_is_answered_over_a_tcp_pair() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();

        let client = tokio::spawn(async move {
            let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
            write_line(&mut c, &Request::Status).await.unwrap();
            let mut r = BufReader::new(c);
            read_line::<_, Response>(&mut r).await.unwrap()
        });
        let mut server_side = Listener::accept(&listener).await.unwrap();
        let response = handle_conn(&mut server_side, |req| async move {
            assert_eq!(req, Request::Status);
            Ok(Reply::Forgotten { device: "x".into(), node_id: "y".into() })
        })
        .await;
        write_line(&mut server_side, &response).await.unwrap();
        assert_eq!(
            client.await.unwrap(),
            Response::ok(Reply::Forgotten { device: "x".into(), node_id: "y".into() })
        );

        // And a garbage line is an error reply here too.
        let client = tokio::spawn(async move {
            let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
            c.write_all(b"this is not json\n").await.unwrap();
            let mut r = BufReader::new(c);
            read_line::<_, Response>(&mut r).await.unwrap()
        });
        let mut server_side = Listener::accept(&listener).await.unwrap();
        let response = handle_conn(&mut server_side, |_| async {
            panic!("a malformed request must not be dispatched")
        })
        .await;
        write_line(&mut server_side, &response).await.unwrap();
        match client.await.unwrap() {
            Response::Err { message } => assert!(message.contains("malformed"), "{message}"),
            other => panic!("expected an error reply, got {other:?}"),
        }
    }

    /// The capability, not the wiring: every sharing and pairing verb is
    /// trusted-only, and the harness verbs are not.
    #[test]
    fn only_the_sharing_and_pairing_verbs_need_a_trusted_transport() {
        for req in [
            Request::ShareLink { path: "/tmp/a".into() },
            Request::BeamArtifact { path: "/tmp/a".into(), ttl_hours: None },
            Request::StopBeam { hash: None },
            Request::ListDevices { probe: false },
            Request::PairDevice,
            Request::PairStatus,
            Request::ConfirmPairing { accept: true, node_id: None },
            Request::ForgetDevice { device: "phone".into() },
        ] {
            assert!(is_trusted_only(&req), "{req:?}");
            let message = e2e_only_refusal(&req);
            assert!(message.starts_with("this transport serves only e2e verbs (got "), "{message}");
        }
        for req in [Request::Status, Request::FeedbackIndex] {
            assert!(!is_trusted_only(&req), "{req:?}");
        }
    }

    /// iOS-only text, pinned here so a rewording is a test failure rather
    /// than a surprise in a simulator log. Does not run on macOS.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn the_non_macos_fallthrough_names_the_verb_it_refused() {
        let message = no_remote_sharing(&Request::PairDevice);
        assert_eq!(message, "this build serves no remote-sharing verbs (got PairDevice)");
    }
}
