// The whole paired-device story, in one process: a phone pairs with a Mac
// over `skypie/pair/1`, follows a `skypie://open?…&from=<mac>` link by pulling
// the file over `skypie/scope/1` + iroh-blobs, and loses everything the moment
// the Mac unpairs it.
//
// The DATA PATH is loopback, exactly like the Beam transfer test: the guest
// dials `127.0.0.1:<host port>` instead of resolving the host's NodeId
// through n0 DNS, so no relay and no discovery lookup carry the session.

use std::sync::{Arc, Mutex};

use skypie_remote::beam;
use skypie_remote::peers::{self, PairTicket, PeerStore, Pairing};
use skypie_remote::scope::{self, ClientSession, ConnectError, HostSignal, ScopeState, DENIED};
use skypie_remote::{endpoint, Dirs};

/// The host's address with its transport reduced to loopback — the endpoint
/// binds 0.0.0.0, so 127.0.0.1 always reaches it.
async fn loopback_addr(node: &endpoint::RemoteNode) -> iroh::EndpointAddr {
    let socket = endpoint::loopback_socket(node)
        .await
        .expect("the endpoint publishes an IPv4 direct address");
    endpoint::addr_at_id(node.endpoint.id(), socket)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paired_device_pulls_what_a_link_names_and_nothing_after_an_unpair() {
    let host_dir = tempfile::TempDir::new().unwrap();
    let guest_dir = tempfile::TempDir::new().unwrap();
    let workspace = tempfile::TempDir::new().unwrap();
    let elsewhere = tempfile::TempDir::new().unwrap();
    let cache = tempfile::TempDir::new().unwrap();

    let artifact = workspace.path().join("report.html");
    std::fs::write(&artifact, "<!doctype html><h1>pulled</h1>").unwrap();
    // A file nowhere near the "workspace": paired means the user's own
    // device, so a link to it works the same.
    let anywhere = elsewhere.path().join("notes.md");
    std::fs::write(&anywhere, "# anywhere on the Mac").unwrap();
    let folder = workspace.path().join("sub");
    std::fs::create_dir(&folder).unwrap();

    // ── Host ────────────────────────────────────────────────────────────────
    let signals: Arc<Mutex<Vec<HostSignal>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = signals.clone();
    let host_peers = Arc::new(PeerStore::load(host_dir.path()));
    let host_pairing = Arc::new(Pairing::new());
    let host_state = Arc::new(ScopeState::new(
        host_peers.clone(),
        host_pairing.clone(),
        "Mac Studio".to_string(),
        move |signal| sink.lock().unwrap().push(signal),
    ));
    let host = endpoint::boot(&Dirs::new(host_dir.path()), Some(host_state.clone()), |_| {})
        .await
        .expect("host boot");
    let host_addr = loopback_addr(&host).await;
    let host_id = host.endpoint.id();

    // ── Guest ───────────────────────────────────────────────────────────────
    let guest_peers = Arc::new(PeerStore::load(guest_dir.path()));
    let guest_state = Arc::new(ScopeState::new(
        guest_peers.clone(),
        Arc::new(Pairing::new()),
        "iPhone".to_string(),
        |_| {},
    ));
    let guest = endpoint::boot(&Dirs::new(guest_dir.path()), Some(guest_state), |_| {})
        .await
        .expect("guest boot");
    let guest_id = guest.endpoint.id();

    // ── A stranger is refused at the handshake, and told why ────────────────
    let err = ClientSession::connect(&guest, host_addr.clone(), "iPhone".to_string(), || {})
        .await
        .expect_err("an unpaired NodeId must not get a session");
    assert_eq!(err, ConnectError::Unpaired("not a paired peer".to_string()));

    // ── Pairing ─────────────────────────────────────────────────────────────
    let ticket = PairTicket {
        addr: host_addr.clone(),
        token: host_pairing.mint(),
        device: "Mac Studio".to_string(),
    };
    assert!(peers::build_pair_link(&ticket.to_string()).starts_with("skypie://pair?ticket="));

    let pending = scope::pair_dial(&guest, &ticket, "iPhone".to_string())
        .await
        .expect("pairing handshake");
    assert_eq!(pending.node_id, host_id.to_string());
    assert_eq!(pending.device, "Mac Studio");
    assert_eq!(pending.role, "guest");

    // Both screens derived the same six words.
    let host_signal = signals.lock().unwrap().first().cloned().expect("host saw the pairing");
    let HostSignal::PairPending(host_pending) = host_signal;
    assert_eq!(host_pending.node_id, guest_id.to_string());
    assert_eq!(host_pending.device, "iPhone");
    assert_eq!(host_pending.role, "host");
    assert_eq!(host_pending.fingerprint, pending.fingerprint);
    assert_eq!(pending.fingerprint.len(), peers::FINGERPRINT_WORDS);

    // A replayed token is dead.
    let replay = scope::pair_dial(&guest, &ticket, "iPhone".to_string())
        .await
        .expect_err("a token works once");
    assert!(replay.contains("not open"), "{replay}");

    // Both humans confirm: each side persists the other.
    host_peers.confirm(&guest_id.to_string(), &host_pending.device).expect("host trusts guest");
    guest_peers.confirm(&host_id.to_string(), &pending.device).expect("guest trusts host");

    // ── The link ────────────────────────────────────────────────────────────
    let link = beam::build_open_link(&artifact, &host_id.to_string());
    assert!(link.starts_with("skypie://open?path="));
    assert!(link.ends_with(&format!("&from={host_id}")));

    // ── The pull ────────────────────────────────────────────────────────────
    let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let session = {
        let closed = closed.clone();
        ClientSession::connect(&guest, host_addr.clone(), "iPhone".to_string(), move || {
            closed.store(true, std::sync::atomic::Ordering::SeqCst)
        })
        .await
        .expect("a paired peer gets a session")
    };
    assert_eq!(session.device, "Mac Studio");

    let meta = session
        .get_artifact(artifact.to_string_lossy().into_owned())
        .await
        .expect("the file the link names");
    assert_eq!(meta.size, 30);
    assert!(!meta.warn);

    let landed = scope::fetch_into_cache(&guest, host_addr.clone(), &meta.hash, ".html", cache.path())
        .await
        .expect("the bytes arrive, verified");
    assert_eq!(std::fs::read(&landed).unwrap(), b"<!doctype html><h1>pulled</h1>");
    assert_eq!(landed, cache.path().join(format!("{}.html", meta.hash)));
    // Content-addressed: the second fetch is a cache hit.
    let again = scope::fetch_into_cache(&guest, host_addr.clone(), &meta.hash, ".html", cache.path())
        .await
        .unwrap();
    assert_eq!(again, landed);

    // Anywhere on the Mac, not just a workspace.
    let elsewhere_meta = session
        .get_artifact(anywhere.to_string_lossy().into_owned())
        .await
        .expect("a paired device reaches any file the link names");
    assert_eq!(elsewhere_meta.size, 21);

    // What is refused, with one wording: a folder, a missing file, a
    // relative path.
    for raw in [
        folder.to_string_lossy().into_owned(),
        workspace.path().join("missing.html").to_string_lossy().into_owned(),
        "relative/report.html".to_string(),
    ] {
        assert_eq!(
            session.get_artifact(raw.clone()).await.unwrap_err(),
            scope::GetFailure::Denied(DENIED.to_string()),
            "{raw}"
        );
    }

    // ── Unpair: the live session is cut and the grant is gone ───────────────
    host_peers.remove(&guest_id.to_string()).expect("the human unpairs the phone");
    host.scope.as_ref().expect("the host serves scope").revoke(&guest_id.to_string()).await;

    let cut = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !session.is_closed() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(cut.is_ok(), "the phone learns it was unpaired without asking for anything");

    let fresh_cache = tempfile::TempDir::new().unwrap();
    let refused = scope::fetch_into_cache(
        &guest,
        host_addr.clone(),
        &meta.hash,
        ".html",
        fresh_cache.path(),
    )
    .await
    .expect_err("a revoked peer's grant is gone even though it knows the hash");
    assert!(!refused.is_empty());

    let redial = ClientSession::connect(&guest, host_addr, "iPhone".to_string(), || {})
        .await
        .expect_err("and it cannot open a new session");
    assert_eq!(redial, ConnectError::Unpaired("not a paired peer".to_string()));

    // A request on the dead session is told apart from a refusal: this is
    // the arm the app answers with a fresh dial rather than an error screen.
    assert_eq!(
        session.get_artifact(artifact.to_string_lossy().into_owned()).await.unwrap_err(),
        scope::GetFailure::Closed
    );

    host.shutdown().await;
    guest.shutdown().await;
}

/// A comment made on the phone reaches the Mac, and the write path stays
/// bounded on every axis the design promised.
///
/// This is the FIRST write this wire has ever carried, so the test is as much
/// about what a peer cannot do as about what it can.
#[tokio::test(flavor = "multi_thread")]
async fn a_paired_device_appends_comments_and_cannot_do_anything_else() {
    use std::sync::atomic::AtomicBool;

    let host_dir = tempfile::TempDir::new().unwrap();
    let guest_dir = tempfile::TempDir::new().unwrap();
    let workspace = tempfile::TempDir::new().unwrap();

    let artifact = workspace.path().join("audit.html");
    std::fs::write(&artifact, "<p>Total revenue</p>").unwrap();
    let folder = workspace.path().join("sub");
    std::fs::create_dir(&folder).unwrap();

    // The host's comment store, as the app would supply it: an append-only
    // list keyed by path, and a record of every path it was asked about.
    #[derive(Default)]
    struct MemStore {
        lines: Mutex<Vec<(String, String)>>,
    }
    impl scope::AnnotationStore for MemStore {
        fn get(&self, path: &std::path::Path) -> Vec<String> {
            let key = path.to_string_lossy().into_owned();
            self.lines
                .lock()
                .unwrap()
                .iter()
                .filter(|(p, _)| *p == key)
                .map(|(_, l)| l.clone())
                .collect()
        }
        fn put(&self, path: &std::path::Path, entries: &[String]) -> Result<usize, String> {
            let key = path.to_string_lossy().into_owned();
            let mut lines = self.lines.lock().unwrap();
            let mut added = 0;
            for e in entries {
                // Union by id, exactly like the real store.
                if lines.iter().any(|(p, l)| *p == key && l == e) {
                    continue;
                }
                lines.push((key.clone(), e.clone()));
                added += 1;
            }
            Ok(added)
        }
    }

    let store = Arc::new(MemStore::default());
    struct Shared(Arc<MemStore>);
    impl scope::AnnotationStore for Shared {
        fn get(&self, path: &std::path::Path) -> Vec<String> {
            self.0.get(path)
        }
        fn put(&self, path: &std::path::Path, entries: &[String]) -> Result<usize, String> {
            self.0.put(path, entries)
        }
    }

    let host_peers = Arc::new(PeerStore::load(host_dir.path()));
    let host_pairing = Arc::new(Pairing::new());
    let host_state = Arc::new(
        ScopeState::new(
            host_peers.clone(),
            host_pairing.clone(),
            "Mac Studio".to_string(),
            |_| {},
        )
        .with_annotations(Shared(store.clone())),
    );
    let host = endpoint::boot(&Dirs::new(host_dir.path()), Some(host_state.clone()), |_| {})
        .await
        .expect("host boot");
    let host_addr = loopback_addr(&host).await;
    let host_id = host.endpoint.id();

    let guest_peers = Arc::new(PeerStore::load(guest_dir.path()));
    let guest_state = Arc::new(ScopeState::new(
        guest_peers.clone(),
        Arc::new(Pairing::new()),
        "iPhone".to_string(),
        |_| {},
    ));
    let guest = endpoint::boot(&Dirs::new(guest_dir.path()), Some(guest_state), |_| {})
        .await
        .expect("guest boot");
    let guest_id = guest.endpoint.id();

    // Pair.
    let ticket = PairTicket {
        addr: host_addr.clone(),
        token: host_pairing.mint(),
        device: "Mac Studio".to_string(),
    };
    let pending = scope::pair_dial(&guest, &ticket, "iPhone".to_string())
        .await
        .expect("pairing handshake");
    host_peers.confirm(&guest_id.to_string(), "iPhone").expect("host trusts guest");
    guest_peers.confirm(&host_id.to_string(), &pending.device).expect("guest trusts host");

    let closed = Arc::new(AtomicBool::new(false));
    let cut = closed.clone();
    let session = ClientSession::connect(&guest, host_addr.clone(), "iPhone".to_string(), move || {
        cut.store(true, std::sync::atomic::Ordering::SeqCst)
    })
    .await
    .expect("a paired peer gets a session");

    let path = artifact.to_string_lossy().into_owned();
    // The gate canonicalizes before the store ever sees a path, so the host
    // keys by the canonical form. On macOS a tempdir lives under /var, which
    // is a symlink to /private/var — so the two spellings differ, and reading
    // the store by the un-canonicalized path would find nothing. This is the
    // behaviour that makes a comment made through a symlinked path and one
    // made directly land in the SAME store.
    let stored_as = artifact.canonicalize().unwrap();
    assert_ne!(
        stored_as, artifact,
        "this assertion documents the symlink; if it ever fails the test below proves less"
    );

    // Nothing there yet.
    let page = session.get_annotations(path.clone()).await.expect("read");
    assert!(page.entries.is_empty());
    assert!(!page.truncated);

    // The phone pushes a comment.
    let one = r#"{"id":"0192c6f1-8f2e-7c1a-9d3b-4e5f6a7b8c9d","body":"needs Q3"}"#.to_string();
    let added = session.put_annotations(path.clone(), vec![one.clone()]).await.expect("push");
    assert_eq!(added, 1);

    // The Mac has it, and a re-read from the phone shows it.
    assert_eq!(scope::AnnotationStore::get(&*store, &stored_as), vec![one.clone()]);
    assert_eq!(session.get_annotations(path.clone()).await.unwrap().entries, vec![one.clone()]);

    // Replaying the same push adds nothing: the union by id is what makes the
    // offline queue safe to retry.
    assert_eq!(session.put_annotations(path.clone(), vec![one.clone()]).await.unwrap(), 0);

    // ── What the peer CANNOT do ─────────────────────────────────────────────

    // Reach a path that is not a regular file, or does not exist. Same
    // no-existence-leak refusal as `GetArtifact`, so this frame is not a
    // filesystem probe either.
    for bad in [folder.to_string_lossy().into_owned(), "/nope/missing.md".to_string()] {
        let err = session.get_annotations(bad.clone()).await.expect_err("must refuse");
        assert_eq!(err, scope::GetFailure::Denied(DENIED.to_string()), "{bad}");
        let err = session.put_annotations(bad.clone(), vec![one.clone()]).await.expect_err("refuse");
        assert_eq!(err, scope::GetFailure::Denied(DENIED.to_string()), "{bad}");
    }

    // Send a relative path, or one with a NUL.
    for bad in ["relative/path.md".to_string(), "/a\0b".to_string()] {
        assert!(session.get_annotations(bad).await.is_err());
    }

    // Flood the store. Refused locally, so nothing goes on the wire at all.
    let flood: Vec<String> = (0..2000).map(|i| format!(r#"{{"id":"{i}"}}"#)).collect();
    let err = session.put_annotations(path.clone(), flood).await.expect_err("capped");
    assert!(matches!(err, scope::GetFailure::Denied(ref m) if m.contains("too many")), "{err:?}");

    // Send an entry carrying a newline, which would split into two lines.
    let torn = "{\"id\":\"x\",\"body\":\"a\nb\"}".to_string();
    assert!(session.put_annotations(path.clone(), vec![torn]).await.is_err());

    // Nothing above reached the store.
    assert_eq!(
        scope::AnnotationStore::get(&*store, &stored_as).len(),
        1,
        "no refused frame stored anything"
    );

    // ── Unpair cuts the write path with everything else ─────────────────────
    host_peers.remove(&guest_id.to_string()).expect("the human unpairs the phone");
    host.scope.as_ref().expect("the host serves scope").revoke(&guest_id.to_string()).await;

    let err = session
        .put_annotations(path.clone(), vec![r#"{"id":"after-unpair"}"#.to_string()])
        .await
        .expect_err("an unpaired peer must not write");
    assert!(
        matches!(err, scope::GetFailure::Denied(_) | scope::GetFailure::Closed),
        "{err:?}"
    );
    assert_eq!(
        scope::AnnotationStore::get(&*store, &stored_as).len(),
        1,
        "the unpaired push stored nothing"
    );
}
