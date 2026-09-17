// The local socket `skypie-mcp` drives this app through.
//
// The app is the only iroh node on the machine. A Claude Code session that
// wants a share link, a beam link or a pairing asks THIS process over
// `<state_dir>/app.sock` — one JSON line in, one JSON line out, per
// connection (`skypie_ipc`). Every request maps onto the same `pub(crate)`
// function the matching `#[tauri::command]` wraps, so there is exactly one
// implementation of each operation.
//
// Trust: the socket is 0600 inside `~/Library/Application Support/SkyPie`,
// so it is reachable by this user's processes and nobody else's — the same
// boundary `identity.key` already draws.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::BufReader;
use tokio::net::{UnixListener, UnixStream};
use skypie_ipc::{read_line, socket_path, write_line, Reply, Request, Response};

/// How long one connection may take to send its request line. A client
/// that connects and says nothing must not hold a task forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Set once THIS process bound the socket. A second instance over the same
/// state directory steps aside in `claim_socket`, and must not unlink the
/// live one on its own exit — the survivor would keep listening on an
/// unlinked inode, and every `skypie-mcp` call would launch it again.
static OWNS_SOCKET: AtomicBool = AtomicBool::new(false);

fn path() -> PathBuf {
    socket_path(&crate::state_store::state_dir())
}

/// Bind the socket and serve it for the life of the app. Spawned from the
/// Tauri setup hook; failures are logged, never fatal — the app is fully
/// usable without an MCP client.
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app).await {
            eprintln!("skypie: ipc: {e}");
        }
    });
}

/// Remove the socket file on exit, so the next launch (and `skypie-mcp`'s
/// "is the app running?" probe) sees a clean state directory.
pub fn cleanup() {
    if OWNS_SOCKET.swap(false, Ordering::SeqCst) {
        let _ = std::fs::remove_file(path());
    }
}

async fn serve(app: tauri::AppHandle) -> Result<(), String> {
    let path = path();
    let listener = claim_socket(&path).await?;
    eprintln!("skypie: ipc: listening at {}", path.display());
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("skypie: ipc: accept failed: {e}");
                continue;
            }
        };
        let app = app.clone();
        tokio::spawn(async move {
            let mut stream = stream;
            let response = handle_conn(&mut stream, |req| dispatch(app, req)).await;
            // Bounded like the read: a client that never reads its reply
            // must not pin this task once the send buffer fills.
            match tokio::time::timeout(REQUEST_TIMEOUT, write_line(&mut stream, &response)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => eprintln!("skypie: ipc: cannot answer: {e}"),
                Err(_) => eprintln!("skypie: ipc: the client did not read its reply in time"),
            }
        });
    }
}

/// Bind `path`, dealing with what a previous run left behind.
///
/// A socket file that something still answers on belongs to another running
/// copy of this app over the same state directory: this one steps aside
/// (logs, does not serve) rather than steal the name. A file nothing
/// answers on is a crash leftover and is removed.
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

/// Read one request and produce its response. `dispatch` is a parameter so
/// the framing — timeout, oversized line, malformed JSON — is provable
/// without an `AppHandle`.
async fn handle_conn<F, Fut>(stream: &mut UnixStream, dispatch: F) -> Response
where
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
async fn dispatch(app: tauri::AppHandle, req: Request) -> Result<Reply, String> {
    use crate::remote;
    match req {
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
        Request::StopBeam { hash } => {
            let stopped = remote::beam_stop_for(&app, hash.as_deref()).await?;
            Ok(Reply::Stopped { stopped: stopped.iter().map(remote::offer_summary).collect() })
        }
        Request::ListDevices { probe } => {
            Ok(Reply::Devices { devices: remote::list_devices_for(&app, probe).await })
        }
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
        Request::PairStatus => Ok(Reply::PairStatus { pending: remote::pair_status_for(&app) }),
        Request::ConfirmPairing { accept, node_id } => {
            let outcome = remote::pair_confirm_for(&app, accept, node_id.as_deref())?;
            Ok(Reply::PairingOutcome {
                paired: outcome.peer.is_some(),
                device: outcome.device,
                node_id: outcome.node_id,
            })
        }
        Request::ForgetDevice { device } => {
            let peer = remote::forget_device_for(&app, &device).await?;
            Ok(Reply::Forgotten { device: peer.device, node_id: peer.node_id })
        }
        Request::Status => Ok(Reply::Status(remote::status_for(&app).await)),

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
    }
}

#[cfg(test)]
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
