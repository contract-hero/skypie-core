// The thin client against a FAKE app: a Unix socket in a tempdir that
// answers canned replies. Proves the request each tool sends, the launch
// when nothing is listening, and the gates that refuse before a byte goes
// out — without an iroh endpoint anywhere.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use skypie_ipc::{read_line, write_line, Reply, Request, Response};
use skypie_mcp::AppClient;

/// A short socket path: macOS caps `sun_path` at 104 bytes.
fn sock(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("a.sock")
}

/// Serve exactly one connection: read its request, hand it to `answer`,
/// write what comes back. Returns the request it saw.
async fn serve_one(
    listener: &UnixListener,
    answer: impl FnOnce(&Request) -> Response,
) -> Request {
    let (mut stream, _) = listener.accept().await.unwrap();
    let req: Request = {
        let mut r = BufReader::new(&mut stream);
        read_line(&mut r).await.unwrap()
    };
    let res = answer(&req);
    write_line(&mut stream, &res).await.unwrap();
    req
}

fn client(socket: PathBuf, roots: Vec<PathBuf>, launcher: skypie_mcp::core::Launcher) -> AppClient {
    AppClient::with_launcher(socket, roots, PathBuf::from("/work"), Some(PathBuf::from("/home/u")), launcher)
}

#[tokio::test]
async fn each_tool_sends_the_request_it_documents_and_reads_the_reply() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = sock(&dir);
    let listener = UnixListener::bind(&path).unwrap();
    let c = client(path, vec![], Box::new(|| panic!("the app is running; no launch")));

    // share_link: a relative path resolves against cwd; the app's reply
    // comes back whole.
    let server = serve_one(&listener, |req| {
        assert_eq!(req, &Request::ShareLink { path: "/work/dist/report.html".into() });
        Response::ok(Reply::ShareLink {
            link: "skypie://open?path=%2Fwork%2Fdist%2Freport.html&from=ab".into(),
            node_id: "ab".into(),
            device: "Mac".into(),
            path: "/work/dist/report.html".into(),
            name: "report.html".into(),
            size: 7,
        })
    });
    let (_, got) = tokio::join!(server, c.share_link("dist/report.html"));
    let got = got.unwrap();
    assert_eq!(got.link, "skypie://open?path=%2Fwork%2Fdist%2Freport.html&from=ab");
    assert_eq!(
        got.web_link,
        "https://skypie.ai/l#open?path=%2Fwork%2Fdist%2Freport.html&from=ab",
        "the https twin is derived client-side, never sent by the app"
    );
    assert_eq!(got.device, "Mac");

    // list_devices carries the probe flag.
    let server = serve_one(&listener, |req| {
        assert_eq!(req, &Request::ListDevices { probe: true });
        Response::ok(Reply::Devices { devices: vec![] })
    });
    let (_, got) = tokio::join!(server, c.list_devices(true));
    assert!(got.unwrap().is_empty());

    // confirm_pairing trims the optional id and keeps an empty one absent.
    let server = serve_one(&listener, |req| {
        assert_eq!(req, &Request::ConfirmPairing { accept: true, node_id: None });
        Response::ok(Reply::PairingOutcome { paired: true, device: "iPhone".into(), node_id: "cd".into() })
    });
    let (_, got) = tokio::join!(server, c.confirm_pairing(true, Some("  ")));
    assert!(got.unwrap().paired);

    // forget_device: the query is trimmed, the reply is rendered with a
    // short id.
    let server = serve_one(&listener, |req| {
        assert_eq!(req, &Request::ForgetDevice { device: "phone".into() });
        Response::ok(Reply::Forgotten { device: "iPhone".into(), node_id: "cd".repeat(32) })
    });
    let (_, got) = tokio::join!(server, c.forget_device(" phone "));
    assert_eq!(got.unwrap().node_id_short, "cdcdcdcdcd");

    // The app's own refusal is this call's Err, verbatim.
    let server = serve_one(&listener, |_| Response::err("no paired device matches \"tablet\""));
    let (_, got) = tokio::join!(server, c.forget_device("tablet"));
    assert_eq!(got.unwrap_err(), "no paired device matches \"tablet\"");
}

#[tokio::test]
async fn share_link_refuses_a_reply_whose_link_is_not_skypie() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = sock(&dir);
    let listener = UnixListener::bind(&path).unwrap();
    let c = client(path, vec![], Box::new(|| panic!("the app is running; no launch")));
    let server = serve_one(&listener, |_| {
        Response::ok(Reply::ShareLink {
            link: "http://evil.example/x".into(),
            node_id: "ab".into(),
            device: "Mac".into(),
            path: "/work/a.html".into(),
            name: "a.html".into(),
            size: 1,
        })
    });
    let (_, got) = tokio::join!(server, c.share_link("a.html"));
    let err = got.expect_err("a link the twin cannot be derived from never reaches chat");
    assert!(err.contains("out of step"), "{err}");
}

#[tokio::test]
async fn stop_beam_trims_a_hash_and_never_widens_an_empty_one_to_all() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = sock(&dir);
    let listener = UnixListener::bind(&path).unwrap();
    let c = client(path, vec![], Box::new(|| panic!("running")));

    let server = serve_one(&listener, |req| {
        assert_eq!(req, &Request::StopBeam { hash: Some("abcdef12".into()) });
        Response::ok(Reply::Stopped { stopped: vec![] })
    });
    let (_, got) = tokio::join!(server, c.stop_beam(Some(" abcdef12 ")));
    assert!(got.unwrap().is_empty());

    // A whitespace hash is refused before the socket is touched: it must
    // not become the revoke-everything form.
    let err = c.stop_beam(Some("   ")).await.unwrap_err();
    assert!(err.contains("omit it"), "{err}");

    let server = serve_one(&listener, |req| {
        assert_eq!(req, &Request::StopBeam { hash: None });
        Response::ok(Reply::Stopped { stopped: vec![] })
    });
    let (_, got) = tokio::join!(server, c.stop_beam(None));
    assert!(got.unwrap().is_empty());
}

#[tokio::test]
async fn a_missing_socket_launches_the_app_and_then_connects() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = sock(&dir);
    let launches = Arc::new(AtomicUsize::new(0));
    let c = client(path.clone(), vec![], {
        let launches = launches.clone();
        let path = path.clone();
        Box::new(move || {
            launches.fetch_add(1, Ordering::SeqCst);
            // "The app starts": a listener appears a moment later, on a
            // thread of its own so the client's poll loop is what finds it.
            let path = path.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                let listener = UnixListener::bind(&path).unwrap();
                serve_one(&listener, |req| {
                    assert_eq!(req, &Request::PairStatus);
                    Response::ok(Reply::PairStatus { pending: vec![] })
                })
                .await;
            });
            Ok(())
        })
    });

    let pending = c.pair_status().await.expect("the app came up and answered");
    assert!(pending.is_empty());
    assert_eq!(launches.load(Ordering::SeqCst), 1, "launched exactly once");
}

#[tokio::test]
async fn a_launch_that_fails_is_a_clear_error_and_nothing_hangs() {
    let dir = tempfile::TempDir::new().unwrap();
    let c = client(
        sock(&dir),
        vec![],
        Box::new(|| Err("Sky Pie is not installed".to_string())),
    );
    let err = c.pair_device().await.unwrap_err();
    assert_eq!(err, "Sky Pie is not installed");
}

#[tokio::test]
async fn beam_artifact_refuses_a_path_outside_the_roots_before_touching_the_socket() {
    let dir = tempfile::TempDir::new().unwrap();
    let inside = dir.path().join("w");
    std::fs::create_dir(&inside).unwrap();
    std::fs::write(inside.join("ok.html"), "x").unwrap();
    let outside = dir.path().join("secret.txt");
    std::fs::write(&outside, "x").unwrap();

    // No listener, and a launcher that must never run: a refused path costs
    // no connection attempt at all.
    let c = client(
        sock(&dir),
        vec![inside.clone()],
        Box::new(|| panic!("a refused path must not launch the app")),
    );
    let err = c.beam_artifact(&outside.to_string_lossy(), None).await.unwrap_err();
    assert_eq!(err, "path not found or out of root");
    let err = c.beam_artifact(&inside.join("missing.html").to_string_lossy(), None).await.unwrap_err();
    assert_eq!(err, "path not found or out of root");
    // A bad TTL is refused even earlier.
    let err = c.beam_artifact(&inside.join("ok.html").to_string_lossy(), Some(0)).await.unwrap_err();
    assert!(err.contains("ttl_hours"), "{err}");

    // And an in-root file goes out with the confined path.
    let path = sock(&dir);
    let listener = UnixListener::bind(&path).unwrap();
    let c = client(path, vec![inside.clone()], Box::new(|| panic!("running")));
    let canonical = inside.join("ok.html").canonicalize().unwrap();
    let server = serve_one(&listener, move |req| {
        assert_eq!(req, &Request::BeamArtifact { path: canonical, ttl_hours: Some(24) });
        Response::ok(Reply::BeamLink {
            link: "skypie://receive?ticket=T&name=ok.html&size=1".into(),
            ticket: "T".into(),
            name: "ok.html".into(),
            size: 1,
            expires_at: 9,
            hash: "ff".into(),
        })
    });
    let ok_path = inside.join("ok.html").to_string_lossy().into_owned();
    let (_, got) = tokio::join!(server, c.beam_artifact(&ok_path, None));
    assert_eq!(got.unwrap().ticket, "T");
}

#[tokio::test]
async fn a_reply_this_build_cannot_read_is_an_error_not_a_panic() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = sock(&dir);
    let listener = UnixListener::bind(&path).unwrap();
    let c = client(path, vec![], Box::new(|| panic!("running")));

    let server = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let _: Request = {
            let mut r = BufReader::new(&mut stream);
            read_line(&mut r).await.unwrap()
        };
        stream.write_all(b"{\"status\":\"ok\",\"kind\":\"from_the_future\"}\n").await.unwrap();
    };
    let (_, got) = tokio::join!(server, c.pair_status());
    let err = got.unwrap_err();
    assert!(err.contains("cannot read"), "{err}");
}

// ── Feedback ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_feedback_tools_send_what_they_document() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = sock(&dir);
    let listener = UnixListener::bind(&path).unwrap();
    let c = client(path, vec![], Box::new(|| panic!("the app is running; no launch")));

    // list_feedback with a path.
    let server = serve_one(&listener, |req| {
        assert_eq!(req, &Request::FeedbackFor { path: "/w/audit.html".into() });
        Response::ok(Reply::Feedback {
            path: "/w/audit.html".into(),
            open: 2,
            context: "SkyPie feedback on /w/audit.html (2 open):\n1. …".into(),
        })
    });
    let (_, got) = tokio::join!(server, c.feedback_for(std::path::Path::new("/w/audit.html")));
    assert_eq!(got.unwrap().open, 2);

    // list_feedback with no path.
    let server = serve_one(&listener, |req| {
        assert_eq!(req, &Request::FeedbackIndex);
        Response::ok(Reply::FeedbackIndex {
            files: vec![skypie_ipc::FeedbackFile {
                path: "/w/audit.html".into(),
                open: 2,
                total: 3,
                updated_at: 11,
            }],
        })
    });
    let (_, got) = tokio::join!(server, c.feedback_index());
    assert_eq!(got.unwrap().len(), 1);

    // resolve_feedback carries the id, the note and the addressed flag.
    let server = serve_one(&listener, |req| {
        assert_eq!(
            req,
            &Request::ResolveFeedback {
                path: "/w/audit.html".into(),
                id: "0192c6f1-8f2e-7c1a-9d3b-4e5f6a7b8c9d".into(),
                note: Some("added the Q3 column".into()),
                addressed: true,
            }
        );
        Response::ok(Reply::FeedbackResolved {
            id: "0192c6f1-8f2e-7c1a-9d3b-4e5f6a7b8c9d".into(),
            path: "/w/audit.html".into(),
            resolution: "addressed".into(),
            remaining: 1,
        })
    });
    let (_, got) = tokio::join!(
        server,
        c.resolve_feedback(
            std::path::Path::new("/w/audit.html"),
            "0192c6f1-8f2e-7c1a-9d3b-4e5f6a7b8c9d",
            Some("added the Q3 column".into()),
            true,
        )
    );
    assert_eq!(got.unwrap().remaining, 1);
}

#[tokio::test]
async fn a_hallucinated_comment_id_is_refused_before_it_reaches_the_socket() {
    let dir = tempfile::TempDir::new().unwrap();
    // No listener at all: reaching the socket would fail differently, so a
    // clean refusal proves the gate ran first.
    let c = client(sock(&dir), vec![], Box::new(|| panic!("must not launch")));

    let err = c
        .resolve_feedback(std::path::Path::new("/w/a.md"), "comment 3", None, true)
        .await
        .unwrap_err();
    assert!(err.contains("uuid"), "{err}");
}

#[tokio::test]
async fn the_hook_path_never_launches_the_app_and_says_nothing_when_it_is_down() {
    let dir = tempfile::TempDir::new().unwrap();
    // Nothing listening. The MCP tools would launch here; the hook must not.
    let c = client(sock(&dir), vec![], Box::new(|| panic!("the hook must never launch the app")));

    assert!(c
        .feedback_if_running(std::path::Path::new("/w/a.md"))
        .await
        .is_none());
    assert!(c.feedback_index_if_running().await.is_none());
}

// ── Agent reach (M5) ────────────────────────────────────────────────────────

#[tokio::test]
async fn add_to_pie_sends_a_resolved_path_and_a_trustworthy_origin() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = sock(&dir);
    let listener = UnixListener::bind(&path).unwrap();
    let c = client(path, vec![], Box::new(|| panic!("the app is running; no launch")));

    // A relative path resolves against the client's own cwd (/work, see
    // `client()` above); a blank session_id is dropped to `None` by
    // `validate_origin_field`, prompt_id is carried through, and `origin.cwd`
    // is the MCP process's own trusted cwd — never something the model sent.
    let server = serve_one(&listener, |req| {
        assert_eq!(
            req,
            &Request::AddToPie {
                pie: "Pricing".into(),
                path: "/work/pricing-v3.html".into(),
                origin: Some(skypie_ipc::MemberOrigin {
                    session_id: None,
                    prompt_id: Some("prompt-1".into()),
                    cwd: Some("/work".into()),
                }),
            }
        );
        Response::ok(Reply::AddedToPie {
            pie: "Pricing".into(),
            pie_id: "p1".into(),
            path: "/work/pricing-v3.html".into(),
            members: 1,
            created: false,
            added: true,
        })
    });
    let (_, got) = tokio::join!(
        server,
        c.add_to_pie("Pricing", "pricing-v3.html", Some("   ".into()), Some("prompt-1".into()))
    );
    let got = got.unwrap();
    assert_eq!(got.pie_id, "p1");
    assert!(got.added);
    assert!(!got.created);
}

#[tokio::test]
async fn add_to_pie_refuses_an_empty_pie_before_touching_the_socket() {
    let dir = tempfile::TempDir::new().unwrap();
    // No listener: an empty `pie` must be refused before a connection is
    // even attempted.
    let c = client(sock(&dir), vec![], Box::new(|| panic!("must not launch")));
    let err = c.add_to_pie("   ", "a.html", None, None).await.unwrap_err();
    assert!(err.contains("pie"), "{err}");
}

#[tokio::test]
async fn the_hook_path_reads_feedback_when_the_app_is_running() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = sock(&dir);
    let listener = UnixListener::bind(&path).unwrap();
    let c = client(path, vec![], Box::new(|| panic!("the app is running")));

    let server = serve_one(&listener, |req| {
        assert_eq!(req, &Request::FeedbackFor { path: "/w/a.md".into() });
        Response::ok(Reply::Feedback {
            path: "/w/a.md".into(),
            open: 1,
            context: "SkyPie feedback on /w/a.md (1 open):\n1. [line 4] Phone — fix this".into(),
        })
    });
    let (_, got) = tokio::join!(server, c.feedback_if_running(std::path::Path::new("/w/a.md")));
    let got = got.unwrap();
    assert_eq!(got.open, 1);
    assert!(got.context.contains("line 4"));
}
