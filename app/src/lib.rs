// SkyPie Tauri core library. Modules are declared here so integration tests
// under tests/ can import them as `skypie_app::workspace::...` etc.

// The Tauri builder itself. Shared by the desktop `main.rs` shim and by the
// iOS `start_app` entry point (`#[tauri::mobile_entry_point]` on `app::run`).
pub mod app;
pub mod workspace;
pub mod reader;
pub mod deeplink;
pub mod platform;
pub mod device_name;
pub mod shared_offers;
// macOS-only: the payload it builds is an AppKit pasteboard shape
// (`public.file-url` + a `file://` URL) for drag-out to Finder. iOS has no
// Finder and no drag-out target, and the `drag` plugin that consumes the
// shape is a macOS-target dependency.
#[cfg(target_os = "macos")]
pub mod drag_spike;
pub mod security;
pub mod share;
pub mod state_store;
pub mod portable_path;
pub mod annotations;
pub mod annotations_api;
pub mod recents;
pub mod bookmarks;
pub mod watcher;
pub mod remote;
// macOS-only: the Unix socket `skypie-mcp` drives the app through. The MCP
// server runs beside the desktop app; the phone has no such neighbour.
#[cfg(target_os = "macos")]
pub mod ipc_server;

/// Intent kind surfaced to the webview as a lowercase string in JSON
/// (`"open"` or `"reveal"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeepLinkIntentKind {
    Open,
    Reveal,
}

/// Typed payload emitted on `skypie://open-file` after a deep-link is parsed
/// and the path is canonicalized. `out_of_root` is true when the path
/// canonicalizes successfully but falls outside every configured root — the
/// frontend renders these as ad-hoc external files with a visible badge.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OpenFileEvent {
    pub path: std::path::PathBuf,
    pub intent: DeepLinkIntentKind,
    pub out_of_root: bool,
    /// Optional line number from `skypie://open?path=…&line=N`.
    #[serde(default)]
    pub line: Option<u32>,
}

/// A `skypie://open?path=…&from=<paired device>` link: the file lives on
/// another of the user's devices, and this one pulls it. `path` is the path
/// ON THAT DEVICE — validated as absolute, never canonicalized here.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OpenRemoteEvent {
    pub peer: String,
    pub device: String,
    pub path: String,
    pub intent: DeepLinkIntentKind,
    #[serde(default)]
    pub line: Option<u32>,
}

/// What `dispatch_deep_link` knows about this install: its own NodeId and
/// its paired peers. Borrowed closures, so a test can pass a fixed map and
/// the app can pass its peer store without either naming the other.
pub struct LocalPeers<'a> {
    pub self_id: Option<&'a str>,
    pub lookup: &'a dyn Fn(&str) -> Option<remote::peers::Peer>,
}

impl LocalPeers<'static> {
    /// An install with no identity and no peers — every `from` is foreign.
    pub const NONE: LocalPeers<'static> = LocalPeers { self_id: None, lookup: &|_| None };
}

/// Typed payload emitted on `skypie://deep-link-error` when the URL is
/// unparseable, the path is rejected by the root check, or the path does
/// not exist.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeepLinkErrorEvent {
    pub url: String,
    pub reason: String,
    /// The one rejection the UI acts on: the link comes from a device this
    /// install is not paired with. Carries that device's short id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unpaired_from: Option<String>,
}

/// Typed payload emitted on `skypie://beam-receive-request` after a
/// `skypie://receive` link parses and its ticket validates. Nothing has
/// been fetched at this point — the frontend's confirm dialog gates the
/// actual transfer.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BeamReceiveRequest {
    pub ticket: String,
    /// Sanitized display name (attacker-controlled hint, already reduced to
    /// a safe bare filename).
    pub name: String,
    /// Size hint in bytes. Display only — the cap is enforced on the actual
    /// stream.
    pub size: Option<u64>,
    /// True when the size hint crosses the backend's warn threshold. The
    /// backend owns the limits; the dialog never mirrors the constant.
    pub warn: bool,
    /// The sender's NodeId (full and short fingerprint), straight from the
    /// ticket. What the user verifies before accepting.
    pub sender_id: String,
    pub sender_id_short: String,
    pub hash: String,
}

/// Typed payload emitted for a `skypie://pair` deep link after the ticket
/// parses. Nothing is persisted and no fingerprint exists yet — the frontend
/// calls `remote_pair_complete` with the ticket, which is what dials the
/// host and produces the six words both screens compare.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PairRequest {
    pub ticket: String,
    /// The inviting instance's NodeId (full and short), straight from the
    /// ticket — shown beside the device name before the user proceeds.
    pub host_id: String,
    pub host_id_short: String,
    /// Sanitized device-name hint from the ticket.
    pub device: String,
}

/// Typed payload emitted on `skypie://beam-send-request` for the CLI's
/// `skypie beam <path>`. Opens the send dialog; the offer is only minted when
/// the user confirms there.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BeamSendRequest {
    pub path: std::path::PathBuf,
    pub name: String,
    pub size: u64,
}

/// What a successfully dispatched deep link asks the app to do. `main.rs`
/// maps each variant onto its `skypie://*` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkAction {
    OpenFile(OpenFileEvent),
    OpenRemote(OpenRemoteEvent),
    BeamReceive(BeamReceiveRequest),
    BeamSend(BeamSendRequest),
    Pair(PairRequest),
}

/// C2: truncate-at-char-boundary helper exposed to tests (B5 carry-forward).
/// Uses `chars().take(N).collect()` semantics so multibyte boundaries never
/// panic. Public for T-019.
pub fn snippet_chars_take(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Parse a `skypie://` URL, canonicalize the path against `roots`, push the
/// path to Recents on Open intent (best-effort), and return a typed action
/// the webview can consume. Single entry point used by `app.rs`'s
/// `on_open_url` callback.
///
/// A link's `from` decides whose file it names: absent or this install's
/// own id → a local open; a paired peer's id → `OpenRemote`, which the
/// frontend resolves by pulling the file; anything else → an error the UI
/// can act on ("not paired").
pub fn dispatch_deep_link(
    url: &str,
    roots: &security::RootSet,
    local: &LocalPeers<'_>,
) -> Result<DeepLinkAction, DeepLinkErrorEvent> {
    let make_err = |reason: String| DeepLinkErrorEvent {
        url: url.to_string(),
        reason,
        unpaired_from: None,
    };

    let intent = deeplink::parse(url).map_err(|e| make_err(e.to_string()))?;

    let (path, kind, line, from) = match intent {
        deeplink::DeepLinkIntent::Open { path, line, from } => {
            (path, DeepLinkIntentKind::Open, line, from)
        }
        deeplink::DeepLinkIntent::Reveal { path, from } => {
            (path, DeepLinkIntentKind::Reveal, None, from)
        }
        deeplink::DeepLinkIntent::Receive { ticket, name, size } => {
            // Validate the ticket and surface the sender's identity for the
            // confirm dialog. Pure parse — no endpoint boot, no fetch.
            let info = remote::beam::ticket_info(&ticket).map_err(&make_err)?;
            let name = remote::beam::sanitize_beam_name(name.as_deref(), &info.hash);
            return Ok(DeepLinkAction::BeamReceive(BeamReceiveRequest {
                ticket,
                name,
                warn: size.is_some_and(|s| s > remote::beam::WARN_BYTES),
                size,
                sender_id: info.node_id,
                sender_id_short: info.node_id_short,
                hash: info.hash,
            }));
        }
        deeplink::DeepLinkIntent::Pair { ticket } => {
            // Validate the ticket and surface the inviting instance for the
            // confirm face. Pure parse — no endpoint boot, no dial.
            let parsed: remote::peers::PairTicket = ticket.parse().map_err(&make_err)?;
            let id = parsed.addr.id;
            return Ok(DeepLinkAction::Pair(PairRequest {
                ticket,
                host_id: id.to_string(),
                host_id_short: id.fmt_short().to_string(),
                device: parsed.device,
            }));
        }
        deeplink::DeepLinkIntent::Beam { path } => {
            // One offer-path policy, shared with beam_offer: conservative
            // share gate (beam sends data OFF the machine), files only,
            // hard cap — an oversized file dies here, not after the user
            // clicks through the dialog.
            let cand = remote::beam::resolve_offerable(&path, roots).map_err(&make_err)?;
            return Ok(DeepLinkAction::BeamSend(BeamSendRequest {
                path: cand.canonical,
                name: cand.name,
                size: cand.size,
            }));
        }
    };

    // Whose file is this? A `from` that is not this install names a paired
    // device — or nobody, which is the one refusal the UI turns into "pair
    // it first".
    if let Some(from) = from.filter(|f| Some(f.as_str()) != local.self_id) {
        // With no readable identity, "not mine" cannot be told from "mine":
        // say that, rather than calling this install's own links foreign.
        if local.self_id.is_none() {
            return Err(make_err(
                "this install cannot read its own identity, so it cannot tell whose link this is"
                    .to_string(),
            ));
        }
        let Some(peer) = (local.lookup)(&from) else {
            let short = remote::peers::short_id(&from);
            return Err(DeepLinkErrorEvent {
                url: url.to_string(),
                reason: format!("not paired with the device this link comes from ({short})"),
                unpaired_from: Some(short),
            });
        };
        return Ok(DeepLinkAction::OpenRemote(OpenRemoteEvent {
            peer: peer.node_id,
            device: peer.device,
            path: path.to_string_lossy().into_owned(),
            intent: kind,
            line,
        }));
    }

    // Ad-hoc external-open policy: paths that exist but lie outside every
    // configured root — or any path at all when no workspace has been picked
    // yet — are allowed with `out_of_root: true`; anything the OS can't
    // resolve is a hard error. Opening only displays the file locally, so the
    // rootless variant is safe here (share_file stays conservative).
    let (canonical, out_of_root) =
        security::canonicalize_allow_rootless(&path, roots).map_err(|e| make_err(e.to_string()))?;

    if matches!(kind, DeepLinkIntentKind::Open) && !out_of_root {
        // Recents is scoped to in-root files; ad-hoc external opens stay
        // ephemeral until the user adopts a multi-root model.
        let _ = recents::push(&canonical);
    }

    Ok(DeepLinkAction::OpenFile(OpenFileEvent {
        path: canonical,
        intent: kind,
        out_of_root,
        line,
    }))
}

/// Handle a deep-link URL: parse it and (when the `e2e-hooks` feature is
/// enabled AND `SKYPIE_E2E_ECHO_LOG` is set) write a content snippet to
/// that log file. The feature gate ensures production builds cannot use
/// the env var as a write-anywhere primitive (B3 / R6-001 fix).
pub fn handle_deep_link(url: &str) {
    let intent = match deeplink::parse(url) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("skypie: deep-link parse error: {e}");
            return;
        }
    };

    let path = match intent {
        // A remote file is not on this disk; nothing to echo.
        deeplink::DeepLinkIntent::Open { from: Some(_), .. }
        | deeplink::DeepLinkIntent::Reveal { from: Some(_), .. } => return,
        deeplink::DeepLinkIntent::Open { path, .. } => path,
        deeplink::DeepLinkIntent::Reveal { path, .. } => path,
        deeplink::DeepLinkIntent::Beam { path } => path,
        deeplink::DeepLinkIntent::Pair { ticket } => {
            eprintln!(
                "skypie: deep-link: pair ticket {}…",
                ticket.chars().take(16).collect::<String>()
            );
            return;
        }
        deeplink::DeepLinkIntent::Receive { ticket, .. } => {
            // No local path to echo — the ticket names remote content.
            // chars().take, not a byte slice: panic-free even if the ticket
            // charset ever admits multibyte input.
            eprintln!("skypie: deep-link: receive ticket {}…", ticket.chars().take(16).collect::<String>());
            return;
        }
    };
    eprintln!("skypie: deep-link: {}", path.display());

    #[cfg(any(feature = "e2e-hooks", debug_assertions))]
    e2e_echo(&path);
    #[cfg(not(any(feature = "e2e-hooks", debug_assertions)))]
    let _ = path;
}

#[cfg(any(feature = "e2e-hooks", debug_assertions))]
fn e2e_echo(path: &std::path::Path) {
    use std::io::Write;
    let Ok(log_path) = std::env::var("SKYPIE_E2E_ECHO_LOG") else {
        return;
    };
    let raw = std::fs::read_to_string(path).unwrap_or_else(|_| String::from("(unreadable)"));
    let snippet = snippet_chars_take(&raw, 200);
    let content = format!("{}\n{}\n", path.display(), snippet);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
    {
        let _ = f.write_all(content.as_bytes());
    }
}

#[cfg(test)]
mod dispatch_deep_link_tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // Redirect state_store writes to the crate-shared test tempdir. Without
    // this, `recents::push` → `state_store::set_state_field` spawns a
    // debounced thread (DEBOUNCE_MS=250) that outlives the test and writes to
    // the developer's real ~/Library/Application Support/SkyPie/state.json.
    // The tempdir + set_var live in state_store::ensure_shared_test_state_dir
    // so this module and bookmarks::tests stop racing each other's env value.
    fn ensure_isolated_state_dir() {
        crate::state_store::ensure_shared_test_state_dir();
    }

    fn setup_root_with_file(name: &str) -> (TempDir, std::path::PathBuf, security::RootSet) {
        ensure_isolated_state_dir();
        let dir = TempDir::new().expect("tempdir");
        let file_path = dir.path().join(name);
        fs::write(&file_path, "content").expect("write");
        let roots = security::RootSet::new(vec![dir.path().to_path_buf()]);
        (dir, file_path, roots)
    }

    /// The three-argument entry point with no identity and no peers: every
    /// test below is about the local branches unless it says otherwise.
    fn dispatch(url: &str, roots: &security::RootSet) -> Result<DeepLinkAction, DeepLinkErrorEvent> {
        dispatch_with(url, roots, &LocalPeers::NONE)
    }

    /// Every dispatch in this module goes through one lock: an in-root open
    /// pushes to the ONE shared recents store, and `recents::push` is a
    /// read-modify-write, so two tests dispatching at once can lose an
    /// entry the other just asserted on.
    fn dispatch_with(
        url: &str,
        roots: &security::RootSet,
        local: &LocalPeers<'_>,
    ) -> Result<DeepLinkAction, DeepLinkErrorEvent> {
        let _one_at_a_time = serial();
        dispatch_deep_link(url, roots, local)
    }

    /// The lock above, for a test that must also ASSERT on the store before
    /// anybody else pushes: the cap is `MAX_RECENTS`, and enough sibling
    /// tests dispatching in the gap would truncate the entry just recorded.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
        SERIAL.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn expect_open(action: DeepLinkAction) -> OpenFileEvent {
        match action {
            DeepLinkAction::OpenFile(ev) => ev,
            other => panic!("expected OpenFile action, got {other:?}"),
        }
    }

    #[test]
    fn open_intent_within_root_returns_open_event() {
        let (_dir, file_path, roots) = setup_root_with_file("hello.html");
        let url = format!("skypie://open?path={}", file_path.display());

        let event = expect_open(dispatch(&url, &roots).expect("ok"));

        assert_eq!(event.intent, DeepLinkIntentKind::Open);
        assert_eq!(event.path, file_path.canonicalize().unwrap());
        assert!(!event.out_of_root);
    }

    #[test]
    fn reveal_intent_within_root_returns_reveal_event() {
        let (_dir, file_path, roots) = setup_root_with_file("revealme.txt");
        let url = format!("skypie://reveal?path={}", file_path.display());

        let event = expect_open(dispatch(&url, &roots).expect("ok"));

        assert_eq!(event.intent, DeepLinkIntentKind::Reveal);
        assert_eq!(event.path, file_path.canonicalize().unwrap());
        assert!(!event.out_of_root);
    }

    #[test]
    fn path_outside_roots_returns_ad_hoc_open_event() {
        ensure_isolated_state_dir();
        let dir = TempDir::new().expect("tempdir");
        let outside = TempDir::new().expect("tempdir-outside");
        let outside_file = outside.path().join("a.html");
        fs::write(&outside_file, "x").expect("write");
        let roots = security::RootSet::new(vec![dir.path().to_path_buf()]);
        let url = format!("skypie://open?path={}", outside_file.display());

        let event = expect_open(dispatch(&url, &roots).expect("ok"));

        assert_eq!(event.intent, DeepLinkIntentKind::Open);
        assert_eq!(event.path, outside_file.canonicalize().unwrap());
        assert!(event.out_of_root);
    }

    #[test]
    fn nonexistent_path_still_returns_error() {
        ensure_isolated_state_dir();
        let dir = TempDir::new().expect("tempdir");
        let roots = security::RootSet::new(vec![dir.path().to_path_buf()]);
        let url = "skypie://open?path=/no/such/path/exists/here.html";

        let err = dispatch(url, &roots).expect_err("expected error");

        assert_eq!(err.url, url);
        assert!(!err.reason.is_empty());
    }

    #[test]
    fn malformed_url_returns_parse_error() {
        let roots = security::RootSet::new(vec![std::env::temp_dir()]);
        let err = dispatch("notaurl://garbage", &roots).expect_err("err");
        assert_eq!(err.url, "notaurl://garbage");
        assert!(!err.reason.is_empty());
    }

    #[test]
    fn empty_roots_existing_path_falls_through_out_of_root() {
        ensure_isolated_state_dir();
        let dir = TempDir::new().expect("tempdir");
        let file_path = dir.path().join("adhoc.html");
        fs::write(&file_path, "x").expect("write");
        let roots = security::RootSet::empty();
        let url = format!("skypie://open?path={}", file_path.display());

        let event = expect_open(dispatch(&url, &roots).expect("ok"));

        assert_eq!(event.path, file_path.canonicalize().unwrap());
        assert!(event.out_of_root);
    }

    #[test]
    fn empty_roots_missing_path_still_errors() {
        ensure_isolated_state_dir();
        let roots = security::RootSet::empty();
        let url = "skypie://open?path=/no/such/path/anywhere.html";

        let err = dispatch(url, &roots).expect_err("err");
        assert!(!err.reason.is_empty());
    }

    #[test]
    fn open_line_param_survives_dispatch() {
        let (_dir, file_path, roots) = setup_root_with_file("lined.md");
        let url = format!("skypie://open?path={}&line=42", file_path.display());

        let event = expect_open(dispatch(&url, &roots).expect("ok"));
        assert_eq!(event.line, Some(42));
    }

    #[test]
    fn reveal_rejects_relative_path() {
        let err = deeplink::parse("skypie://reveal?path=relative/path.md").expect_err("err");
        assert!(err.to_string().contains("absolute"));
    }

    #[test]
    fn reveal_rejects_nul_bytes() {
        let err = deeplink::parse("skypie://reveal?path=/tmp/a%00b").expect_err("err");
        assert!(err.to_string().contains("NUL"));
    }

    // ── Recents side effect (the `!out_of_root` guard's actual purpose) ──

    fn recents_contains(path: &std::path::Path) -> bool {
        recents::list().iter().any(|r| r.path == path)
    }

    #[test]
    fn in_root_open_pushes_recents() {
        let (_dir, file_path, roots) = setup_root_with_file("recorded.md");
        let url = format!("skypie://open?path={}", file_path.display());

        let _held_through_the_assert = serial();
        dispatch_deep_link(&url, &roots, &LocalPeers::NONE).expect("ok");

        assert!(recents_contains(&file_path.canonicalize().unwrap()));
    }

    #[test]
    fn out_of_root_open_stays_out_of_recents() {
        ensure_isolated_state_dir();
        let dir = TempDir::new().expect("tempdir");
        let outside = TempDir::new().expect("tempdir-outside");
        let outside_file = outside.path().join("ephemeral.md");
        fs::write(&outside_file, "x").expect("write");
        let roots = security::RootSet::new(vec![dir.path().to_path_buf()]);
        let url = format!("skypie://open?path={}", outside_file.display());

        dispatch(&url, &roots).expect("ok");

        assert!(!recents_contains(&outside_file.canonicalize().unwrap()));
    }

    #[test]
    fn reveal_does_not_push_recents() {
        let (_dir, file_path, roots) = setup_root_with_file("revealed-not-recorded.md");
        let url = format!("skypie://reveal?path={}", file_path.display());

        dispatch(&url, &roots).expect("ok");

        assert!(!recents_contains(&file_path.canonicalize().unwrap()));
    }

    // ── Beam verbs through the dispatcher ────────────────────────────────

    #[test]
    fn beam_verb_returns_send_request_with_metadata() {
        let (_dir, file_path, roots) = setup_root_with_file("to-beam.html");
        let url = format!("skypie://beam?path={}", file_path.display());

        let action = dispatch(&url, &roots).expect("ok");

        match action {
            DeepLinkAction::BeamSend(req) => {
                assert_eq!(req.path, file_path.canonicalize().unwrap());
                assert_eq!(req.name, "to-beam.html");
                assert_eq!(req.size, "content".len() as u64);
            }
            other => panic!("expected BeamSend, got {other:?}"),
        }
    }

    #[test]
    fn beam_verb_rejects_on_empty_root_set() {
        // Beaming sends data off the machine: conservative like share, not
        // permissive like open.
        ensure_isolated_state_dir();
        let dir = TempDir::new().expect("tempdir");
        let file_path = dir.path().join("adhoc.html");
        fs::write(&file_path, "x").expect("write");
        let url = format!("skypie://beam?path={}", file_path.display());

        let err = dispatch(&url, &security::RootSet::empty()).expect_err("err");
        assert_eq!(err.reason, "path not found or out of root");
    }

    #[test]
    fn beam_verb_rejects_directories() {
        ensure_isolated_state_dir();
        let dir = TempDir::new().expect("tempdir");
        let sub = dir.path().join("subdir");
        fs::create_dir(&sub).expect("mkdir");
        let roots = security::RootSet::new(vec![dir.path().to_path_buf()]);
        let url = format!("skypie://beam?path={}", sub.display());

        let err = dispatch(&url, &roots).expect_err("err");
        assert_eq!(err.reason, "only files can be shared");
    }

    #[test]
    fn receive_verb_with_garbage_ticket_is_rejected_before_any_ui() {
        let roots = security::RootSet::empty();
        let err =
            dispatch("skypie://receive?ticket=notaticket123", &roots).expect_err("err");
        assert!(err.reason.contains("invalid beam ticket"));
    }

    #[test]
    fn receive_verb_with_valid_ticket_surfaces_sender_and_sanitized_name() {
        // Mint a real ticket shape without any network: a made-up node id
        // plus a content hash, exactly what a hostile link could carry.
        let secret = iroh::SecretKey::generate();
        let hash = iroh_blobs::Hash::new(b"payload");
        let ticket = iroh_blobs::ticket::BlobTicket::new(
            secret.public().into(),
            hash,
            iroh_blobs::BlobFormat::Raw,
        )
        .to_string();
        let url = format!("skypie://receive?ticket={ticket}&name=..%2F..%2Fevil.html&size=42");

        let action = dispatch(&url, &security::RootSet::empty()).expect("ok");

        match action {
            DeepLinkAction::BeamReceive(req) => {
                assert_eq!(req.ticket, ticket);
                assert_eq!(req.name, "evil.html", "path traversal in the hint must be stripped");
                assert_eq!(req.size, Some(42));
                assert_eq!(req.sender_id, secret.public().to_string());
                assert_eq!(req.hash, hash.to_string());
            }
            other => panic!("expected BeamReceive, got {other:?}"),
        }
    }

    // ── The pair verb (Scope v2) ─────────────────────────────────────────

    #[test]
    fn pair_verb_surfaces_the_inviting_instance_without_dialing_it() {
        let secret = iroh::SecretKey::generate();
        let ticket = remote::peers::PairTicket {
            addr: iroh::EndpointAddr::from(secret.public()),
            token: [7u8; 32],
            // Hostile device hint: the bidi override must not survive to the
            // confirm face.
            device: "Mac\u{202E}Studio".to_string(),
        }
        .to_string();
        let url = format!("skypie://pair?ticket={ticket}");

        match dispatch(&url, &security::RootSet::empty()).expect("ok") {
            DeepLinkAction::Pair(req) => {
                assert_eq!(req.ticket, ticket);
                assert_eq!(req.host_id, secret.public().to_string());
                assert_eq!(req.host_id_short, secret.public().fmt_short().to_string());
                assert_eq!(req.device, "MacStudio");
            }
            other => panic!("expected Pair, got {other:?}"),
        }
    }

    #[test]
    fn pair_verb_with_a_garbage_ticket_is_rejected_before_any_ui() {
        let err = dispatch("skypie://pair?ticket=notaticket123", &security::RootSet::empty())
            .expect_err("err");
        assert!(err.reason.contains("invalid pairing ticket"), "got: {}", err.reason);
    }

    #[test]
    fn pair_verb_rejects_a_beam_ticket() {
        // Both are base32; the kind prefix is what keeps the two verbs apart.
        let ticket = iroh_blobs::ticket::BlobTicket::new(
            iroh::SecretKey::generate().public().into(),
            iroh_blobs::Hash::new(b"payload"),
            iroh_blobs::BlobFormat::Raw,
        )
        .to_string();
        let url = format!("skypie://pair?ticket={ticket}");
        assert!(dispatch(&url, &security::RootSet::empty()).is_err());
    }

    #[test]
    fn pair_verb_enforces_the_same_strict_parsing_as_receive() {
        // Missing parameter, empty value, and a non-alphanumeric ticket all
        // die in the parser — the ticket parser never sees them.
        assert!(deeplink::parse("skypie://pair").is_err());
        assert!(deeplink::parse("skypie://pair?ticket=").is_err());
        let err = deeplink::parse("skypie://pair?ticket=abc%2F..%2Fdef").expect_err("err");
        assert!(err.to_string().contains("alphanumeric"));
        let err = deeplink::parse("skypie://pair?ticket=ab%00cd").expect_err("err");
        assert!(err.to_string().contains("alphanumeric"));
    }

    #[test]
    fn receive_verb_rejects_hashseq_tickets() {
        let secret = iroh::SecretKey::generate();
        let ticket = iroh_blobs::ticket::BlobTicket::new(
            secret.public().into(),
            iroh_blobs::Hash::new(b"seq"),
            iroh_blobs::BlobFormat::HashSeq,
        )
        .to_string();
        let url = format!("skypie://receive?ticket={ticket}");

        let err = dispatch(&url, &security::RootSet::empty()).expect_err("err");
        assert!(err.reason.contains("single-file"));
    }

    // ── `from`: whose file a link names ────────────────────────────────────

    fn peer(node_id: &str, device: &str) -> remote::peers::Peer {
        remote::peers::Peer {
            node_id: node_id.to_string(),
            device: device.to_string(),
            paired_at: 1,
            last_seen: 1,
        }
    }

    const MAC: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PHONE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const STRANGER: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    /// This install is the phone, paired with the Mac.
    fn phone_view() -> LocalPeers<'static> {
        LocalPeers {
            self_id: Some(PHONE),
            lookup: &|id| (id == MAC).then(|| peer(MAC, "Mac Studio")),
        }
    }

    #[test]
    fn a_link_from_a_paired_device_opens_remotely_without_touching_the_disk() {
        ensure_isolated_state_dir();
        // The path does not exist HERE — it exists on the Mac.
        let url = format!("skypie://open?path=/Users/me/report.html&from={MAC}&line=7");
        match dispatch_with(&url, &security::RootSet::empty(), &phone_view()).expect("ok") {
            DeepLinkAction::OpenRemote(ev) => {
                assert_eq!(ev.peer, MAC);
                assert_eq!(ev.device, "Mac Studio");
                assert_eq!(ev.path, "/Users/me/report.html");
                assert_eq!(ev.intent, DeepLinkIntentKind::Open);
                assert_eq!(ev.line, Some(7));
            }
            other => panic!("expected OpenRemote, got {other:?}"),
        }
        // `reveal` from a peer opens too: there is no remote tree to reveal in.
        let url = format!("skypie://reveal?path=/Users/me/report.html&from={MAC}");
        match dispatch_with(&url, &security::RootSet::empty(), &phone_view()).expect("ok") {
            DeepLinkAction::OpenRemote(ev) => assert_eq!(ev.intent, DeepLinkIntentKind::Reveal),
            other => panic!("expected OpenRemote, got {other:?}"),
        }
    }

    #[test]
    fn a_link_from_this_install_is_a_local_open() {
        ensure_isolated_state_dir();
        let (_tmp, file, roots) = setup_root_with_file("mine.html");
        let url = format!("skypie://open?path={}&from={PHONE}", file.display());
        let event = expect_open(dispatch_with(&url, &roots, &phone_view()).expect("ok"));
        assert_eq!(event.path, file.canonicalize().unwrap());
    }

    #[test]
    fn a_link_from_an_unpaired_device_says_so() {
        ensure_isolated_state_dir();
        let url = format!("skypie://open?path=/Users/me/report.html&from={STRANGER}");
        let err = dispatch_with(&url, &security::RootSet::empty(), &phone_view())
            .expect_err("a stranger's link is refused");
        assert!(err.reason.contains("not paired"), "{}", err.reason);
        assert_eq!(err.unpaired_from.as_deref(), Some(&STRANGER[..10]), "typed, not parsed");
    }

    #[test]
    fn a_share_link_round_trips_through_dispatch() {
        ensure_isolated_state_dir();
        let path = std::path::Path::new("/Users/me/mi informe año.html");
        let link = remote::beam::build_open_link(path, MAC);
        match dispatch_with(&link, &security::RootSet::empty(), &phone_view()).expect("ok") {
            DeepLinkAction::OpenRemote(ev) => assert_eq!(ev.path, path.to_string_lossy()),
            other => panic!("expected OpenRemote, got {other:?}"),
        }
    }

    #[test]
    fn a_link_with_from_is_refused_with_the_real_cause_when_this_install_has_no_identity() {
        ensure_isolated_state_dir();
        let url = format!("skypie://open?path=/Users/me/report.html&from={MAC}");
        let no_identity = LocalPeers { self_id: None, lookup: &|_| Some(peer(MAC, "Mac Studio")) };
        let err = dispatch_with(&url, &security::RootSet::empty(), &no_identity)
            .expect_err("an install that cannot tell whose link this is refuses it");
        assert!(err.reason.contains("own identity"), "{}", err.reason);
        assert_eq!(err.unpaired_from, None, "this is not a pairing problem");
    }
}
