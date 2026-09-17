//! The local contract between the desktop app and `skypie-mcp`.
//!
//! The app is the only iroh node on a machine. Anything else that wants to
//! share a file, mint a beam link or pair a device asks the running app over
//! a Unix domain socket at `<state_dir>/app.sock`. This crate owns:
//!
//! - the state-directory rule both binaries resolve identically;
//! - the request / reply types, as newline-delimited JSON;
//! - the two framing helpers (one line in, one line out).
//!
//! One request per connection: connect, write one line, read one line,
//! close. No ids, no multiplexing — the MCP server calls are sequential and
//! the app answers each on its own task.
//!
//! No iroh, no tauri, no tokio networking here on purpose: `skypie-mcp` links
//! this crate and nothing of the transport stack.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Bump when a request or reply changes shape. The app reports its value in
/// `AppStatus::ipc_proto`, so a `server_status` call can say which side is
/// old when a reply stops parsing.
pub const IPC_PROTO: u32 = 2;

/// File name of the socket under the state directory.
pub const SOCKET_NAME: &str = "app.sock";

/// Upper bound on one JSON line in either direction. Replies carry paths,
/// links and short device lists — 64 KiB is generous, and a peer that sends
/// more is not the other half of this contract.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// The directory that holds `state.json`, `remote/`, `received/` and the
/// socket. `SKYPIE_STATE_DIR` overrides (tests and dev builds); otherwise the
/// platform config dir + `SkyPie` — `~/Library/Application Support/SkyPie` on
/// macOS. The name is frozen (STATUS.md): it is where every existing install
/// keeps its identity key.
pub fn state_dir() -> PathBuf {
    if let Ok(s) = std::env::var("SKYPIE_STATE_DIR") {
        return PathBuf::from(s);
    }
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("SkyPie")
}

/// `<state_dir>/app.sock`.
pub fn socket_path(state_dir: &Path) -> PathBuf {
    state_dir.join(SOCKET_NAME)
}

/// Unix seconds. The unit every expiry and timestamp on this contract uses.
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The first 10 hex characters of a NodeId — the same width iroh's own
/// `fmt_short` prints, so a short id in a tool reply and one in the app's
/// Devices pane are the same string. Guarded for a truncated input.
pub fn short_id(node_id: &str) -> String {
    node_id.chars().take(10).collect()
}

/// KiB / MiB for a person. ONE formatter for both binaries: the size beside
/// a link in a tool reply and the size in the app's own "file is X — caps at
/// Y" refusal must read the same.
pub fn human_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    if bytes >= MIB {
        format!("{} MiB", bytes / MIB)
    } else {
        format!("{} KiB", bytes.div_ceil(KIB))
    }
}

// ── Requests ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// A `skypie://open?path=…&from=<this node>` link for a local file. Only
    /// paired devices can follow it.
    ShareLink { path: PathBuf },
    /// Stage a file and mint a `skypie://receive?ticket=…` link anyone
    /// holding it can fetch while the app runs.
    BeamArtifact {
        path: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttl_hours: Option<u32>,
    },
    /// Revoke one offer by hash prefix, or every offer when `hash` is absent.
    StopBeam {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hash: Option<String>,
    },
    /// Paired devices; `probe` dials each one to report presence.
    ListDevices {
        #[serde(default)]
        probe: bool,
    },
    /// Mint a pairing invite (link + ticket).
    PairDevice,
    /// Pairings parked for a human decision, with their six words.
    PairStatus,
    /// Accept or decline a parked pairing. `node_id` may be a prefix or the
    /// device name; it may be omitted when exactly one pairing is parked.
    ConfirmPairing {
        accept: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        node_id: Option<String>,
    },
    /// Unpair a device; `device` is a name, node id or prefix.
    ForgetDevice { device: String },
    /// Node identity, boot state, offers.
    Status,

    // ── Feedback ────────────────────────────────────────────────────────
    // What the Claude Code plugin drives. Deliberately three narrow verbs
    // rather than a general store API: the agent may READ feedback and mark
    // a point addressed, and nothing else. It cannot author a comment in the
    // user's name, and it cannot delete one.
    /// Open feedback on one file, rendered as the prose block a
    /// `PostToolUse` hook returns as `additionalContext`. Empty when the
    /// file has none — the hook prints nothing and exits 0.
    FeedbackFor { path: PathBuf },
    /// Every file with open feedback. What a `UserPromptSubmit` hook
    /// summarises, and what the hook's filesystem short-circuit is built
    /// from so an unrelated `Read` costs no socket round trip.
    FeedbackIndex,
    /// Mark one comment addressed (or won't-fix). The user watches their pin
    /// turn green as the agent answers it.
    ResolveFeedback {
        path: PathBuf,
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        /// `false` records "read it, not doing it" rather than "done".
        #[serde(default = "yes")]
        addressed: bool,
    },

    // ── E2E harness ─────────────────────────────────────────────────────
    // A debug-only hook: an E2E driver scripts the REAL app it is testing
    // instead of a stand-in. Absent from this enum entirely in a release
    // build with the feature off, so `{"op":"e2e_eval",...}` there fails to
    // parse as `Request` (an "unknown variant" `serde_json` error, which
    // `read_line` turns into the same "malformed message" reply any other
    // garbage line gets) rather than being silently accepted by a build that
    // must not run it.
    /// Evaluate `js` as an async expression in the app's main webview and
    /// return its JSON-serialised result. `js` may `await` — the app wraps
    /// it in an async IIFE — so a driver can wait on the UI settling before
    /// reading it back.
    #[cfg(any(feature = "e2e-hooks", debug_assertions))]
    E2eEval { js: String },
}

fn yes() -> bool {
    true
}

// ── Replies ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok {
        #[serde(flatten)]
        reply: Reply,
    },
    Err {
        message: String,
    },
}

impl Response {
    pub fn ok(reply: Reply) -> Self {
        Response::Ok { reply }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Response::Err {
            message: message.into(),
        }
    }

    pub fn into_result(self) -> Result<Reply, String> {
        match self {
            Response::Ok { reply } => Ok(reply),
            Response::Err { message } => Err(message),
        }
    }
}

/// Prefix of the https twin of a `skypie://` link. Chat surfaces that only
/// forward `http(s)` (Claude Desktop denies every other scheme; iOS never
/// linkifies one) make the twin clickable, and the static page at this URL
/// hands the fragment back to the `skypie://` handler. The page is served
/// at this URL on skypie.ai; move both halves together.
pub const WEB_LINK_PREFIX: &str = "https://skypie.ai/l#";

/// `skypie://<intent>` → `https://…/l#<intent>`. `None` for anything that is
/// not a `skypie://` link. The intent rides in the fragment, which a browser
/// never sends, so the host serving the page learns neither path nor node id.
pub fn web_link_of(link: &str) -> Option<String> {
    link.strip_prefix("skypie://").map(|intent| format!("{WEB_LINK_PREFIX}{intent}"))
}

/// The inverse: `https://…/l#open?…` → `skypie://open?…`, so a pasted web
/// link parses like the raw one. Tolerates what a browser or a chat client
/// does to the page URL (trailing slash, `http://`, host case, `www.`), and
/// accepts only `open?` intents: that is all the redirect page forwards, so
/// an https `pair?`/`receive?` link is `None` like any other non-link.
pub fn open_link_of_web(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://"))?;
    let (host, rest) = rest.split_once('/')?;
    let host = host.to_ascii_lowercase();
    if host.strip_prefix("www.").unwrap_or(&host) != "skypie.ai" {
        return None;
    }
    let (page, intent) = rest.split_once('#')?;
    if page.trim_end_matches('/') != "l" || !intent.starts_with("open?") {
        return None;
    }
    Some(format!("skypie://{intent}"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reply {
    ShareLink {
        link: String,
        node_id: String,
        device: String,
        path: PathBuf,
        name: String,
        size: u64,
    },
    BeamLink {
        link: String,
        ticket: String,
        name: String,
        size: u64,
        expires_at: u64,
        hash: String,
    },
    Stopped {
        stopped: Vec<OfferSummary>,
    },
    Devices {
        devices: Vec<DeviceInfo>,
    },
    PairInvite {
        link: String,
        ticket: String,
        node_id: String,
        device: String,
        expires_at: u64,
    },
    PairStatus {
        pending: Vec<PendingPairing>,
    },
    PairingOutcome {
        paired: bool,
        device: String,
        node_id: String,
    },
    Forgotten {
        device: String,
        node_id: String,
    },
    Status(AppStatus),

    /// Open feedback on one file. `context` is empty when there is none.
    Feedback {
        path: PathBuf,
        open: usize,
        /// The agent-facing block, already rendered by the app so the app
        /// and the UI can never word the same feedback differently.
        context: String,
    },
    /// Files with open feedback, most recently touched first.
    FeedbackIndex { files: Vec<FeedbackFile> },
    /// One comment's new state.
    FeedbackResolved {
        id: String,
        path: PathBuf,
        /// `addressed` or `wontfix`.
        ///
        /// NOT named `status`: `Response` tags itself with `status` and
        /// flattens `Reply` into the same object, so a `status` field here
        /// would serialize twice and the reply would not parse. The
        /// integration test that caught this is the reason the name is
        /// spelled out.
        resolution: String,
        /// Open threads left on the file afterwards — lets the agent know
        /// whether it is done with this file.
        remaining: usize,
    },

    /// Reply to `E2eEval`: whatever the JS expression resolved to. A `js`
    /// that throws, or that never reports back, surfaces as `Response::Err`
    /// instead — this variant only ever carries a success value.
    #[cfg(any(feature = "e2e-hooks", debug_assertions))]
    E2eResult { value: serde_json::Value },
}

/// One row of the feedback index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedbackFile {
    pub path: PathBuf,
    pub open: usize,
    pub total: usize,
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OfferSummary {
    pub name: String,
    pub size: u64,
    pub link: String,
    pub expires_at: u64,
    pub fetches: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    Online,
    Offline,
    Refused,
    Unpaired,
    Unknown,
}

impl Presence {
    /// The wire word, which is also the word a person reads.
    pub fn as_str(self) -> &'static str {
        match self {
            Presence::Online => "online",
            Presence::Offline => "offline",
            Presence::Refused => "refused",
            Presence::Unpaired => "unpaired",
            Presence::Unknown => "unknown",
        }
    }
}

impl std::fmt::Display for Presence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub device: String,
    pub node_id: String,
    pub node_id_short: String,
    pub paired_at: u64,
    pub last_seen: u64,
    pub presence: Presence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingPairing {
    pub node_id: String,
    pub node_id_short: String,
    pub device: String,
    pub fingerprint: Vec<String>,
    pub role: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppStatus {
    pub ipc_proto: u32,
    pub app_version: String,
    pub node_id: String,
    pub device: String,
    pub state_dir: PathBuf,
    pub booted: bool,
    pub boot_error: Option<String>,
    pub uptime_secs: u64,
    pub paired_devices: usize,
    pub active_offers: Vec<OfferSummary>,
}

// ── Framing ─────────────────────────────────────────────────────────────────

/// Serialize `value` as one JSON line.
pub async fn write_line<W, T>(w: &mut W, value: &T) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let mut line = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    // The reader refuses a line over the bound; fail where the line is made,
    // so the error names the real cause instead of "cannot read the reply".
    if line.len() >= MAX_LINE_BYTES {
        return Err(std::io::Error::other(format!(
            "message is {} bytes, over the {MAX_LINE_BYTES} byte line limit",
            line.len()
        )));
    }
    line.push(b'\n');
    w.write_all(&line).await?;
    w.flush().await
}

/// Read one JSON line, bounded by `MAX_LINE_BYTES`. A closed stream before a
/// newline, an oversized line and malformed JSON are all one error kind: the
/// other side is not speaking this contract.
pub async fn read_line<R, T>(r: &mut R) -> Result<T, String>
where
    R: AsyncBufRead + Unpin,
    T: DeserializeOwned,
{
    let mut buf = Vec::new();
    // Read at most MAX_LINE_BYTES + 1 so an oversized line is detected
    // without buffering it whole.
    let limit = (MAX_LINE_BYTES + 1) as u64;
    let mut limited = (&mut *r).take(limit);
    let n = limited
        .read_until(b'\n', &mut buf)
        .await
        .map_err(|e| format!("read failed: {e}"))?;
    if n == 0 {
        return Err("connection closed before a reply".into());
    }
    if buf.last() != Some(&b'\n') {
        return Err(format!("line exceeds {MAX_LINE_BYTES} bytes"));
    }
    serde_json::from_slice(&buf).map_err(|e| format!("malformed message: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn round_trip<T>(v: &T) -> T
    where
        T: Serialize + DeserializeOwned,
    {
        let s = serde_json::to_string(v).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    #[test]
    fn every_request_round_trips() {
        let all = vec![
            Request::ShareLink {
                path: "/tmp/a.html".into(),
            },
            Request::BeamArtifact {
                path: "/tmp/a.html".into(),
                ttl_hours: Some(3),
            },
            Request::BeamArtifact {
                path: "/tmp/a.html".into(),
                ttl_hours: None,
            },
            Request::StopBeam { hash: None },
            Request::StopBeam {
                hash: Some("abcdef12".into()),
            },
            Request::ListDevices { probe: true },
            Request::PairDevice,
            Request::PairStatus,
            Request::ConfirmPairing {
                accept: true,
                node_id: None,
            },
            Request::ForgetDevice {
                device: "phone".into(),
            },
            Request::Status,
            #[cfg(any(feature = "e2e-hooks", debug_assertions))]
            Request::E2eEval {
                js: "document.title".into(),
            },
        ];
        for r in all {
            assert_eq!(round_trip(&r), r);
        }
    }

    #[cfg(any(feature = "e2e-hooks", debug_assertions))]
    #[test]
    fn e2e_eval_is_tagged_by_op_and_its_result_round_trips() {
        let s = serde_json::to_string(&Request::E2eEval { js: "1+1".into() }).unwrap();
        assert_eq!(s, r#"{"op":"e2e_eval","js":"1+1"}"#);

        let ok = Response::ok(Reply::E2eResult { value: serde_json::json!({ "n": 2 }) });
        assert_eq!(round_trip(&ok), ok);
    }

    #[test]
    fn the_wire_shape_is_tagged_by_op() {
        let s = serde_json::to_string(&Request::ListDevices { probe: false }).unwrap();
        assert_eq!(s, r#"{"op":"list_devices","probe":false}"#);
        // `probe` defaults when omitted.
        let r: Request = serde_json::from_str(r#"{"op":"list_devices"}"#).unwrap();
        assert_eq!(r, Request::ListDevices { probe: false });
    }

    #[test]
    fn replies_flatten_under_ok_and_errors_carry_a_message() {
        let ok = Response::ok(Reply::Forgotten {
            device: "phone".into(),
            node_id: "abc".into(),
        });
        let s = serde_json::to_string(&ok).unwrap();
        assert_eq!(
            s,
            r#"{"status":"ok","kind":"forgotten","device":"phone","node_id":"abc"}"#
        );
        assert_eq!(round_trip(&ok), ok);

        let err = Response::err("no such device");
        assert_eq!(
            serde_json::to_string(&err).unwrap(),
            r#"{"status":"err","message":"no such device"}"#
        );
        assert_eq!(err.into_result(), Err("no such device".to_string()));
    }

    #[test]
    fn status_reply_round_trips() {
        let st = Response::ok(Reply::Status(AppStatus {
            ipc_proto: IPC_PROTO,
            app_version: "0.1.0".into(),
            node_id: "ab".into(),
            device: "Mac".into(),
            state_dir: "/tmp/x".into(),
            booted: true,
            boot_error: None,
            uptime_secs: 5,
            paired_devices: 1,
            active_offers: vec![OfferSummary {
                name: "a.html".into(),
                size: 1,
                link: "skypie://receive?ticket=T".into(),
                expires_at: 9,
                fetches: 0,
                hash: "ff".into(),
            }],
        }));
        assert_eq!(round_trip(&st), st);
    }

    #[tokio::test]
    async fn framing_round_trips_and_refuses_bad_lines() {
        let mut buf = Vec::new();
        write_line(&mut buf, &Request::Status).await.unwrap();
        assert!(buf.ends_with(b"\n"));
        let mut r = tokio::io::BufReader::new(Cursor::new(buf));
        let got: Request = read_line(&mut r).await.unwrap();
        assert_eq!(got, Request::Status);

        let mut empty = tokio::io::BufReader::new(Cursor::new(Vec::<u8>::new()));
        let e = read_line::<_, Request>(&mut empty).await.unwrap_err();
        assert!(e.contains("closed"), "{e}");

        let mut garbage = tokio::io::BufReader::new(Cursor::new(b"not json\n".to_vec()));
        let e = read_line::<_, Request>(&mut garbage).await.unwrap_err();
        assert!(e.contains("malformed"), "{e}");

        let big = vec![b'x'; MAX_LINE_BYTES + 10];
        let mut oversized = tokio::io::BufReader::new(Cursor::new(big));
        let e = read_line::<_, Request>(&mut oversized).await.unwrap_err();
        assert!(e.contains("exceeds"), "{e}");
    }

    #[test]
    fn the_shared_display_helpers_agree_with_the_core_crate() {
        assert_eq!(short_id(&"ab".repeat(32)), "ababababab");
        assert_eq!(short_id("abc"), "abc");
        assert_eq!(human_bytes(0), "0 KiB");
        assert_eq!(human_bytes(512), "1 KiB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5 MiB");
        assert_eq!(Presence::Unpaired.to_string(), "unpaired");
        assert_eq!(serde_json::to_value(Presence::Refused).unwrap(), "refused");
    }

    #[test]
    fn state_dir_honors_the_env_override() {
        // Serialised with other env-touching tests by being the only one here.
        std::env::set_var("SKYPIE_STATE_DIR", "/tmp/skypie-ipc-test");
        assert_eq!(state_dir(), PathBuf::from("/tmp/skypie-ipc-test"));
        assert_eq!(
            socket_path(&state_dir()),
            PathBuf::from("/tmp/skypie-ipc-test/app.sock")
        );
        std::env::remove_var("SKYPIE_STATE_DIR");
        assert!(state_dir().ends_with("SkyPie"));
    }

    #[test]
    fn web_link_is_the_open_intent_in_the_fragment_and_round_trips() {
        let open = "skypie://open?path=%2FUsers%2Fme%2Fmi%20informe%20a%C3%B1o.html&from=ab12";
        let web = web_link_of(open).unwrap();
        let (base, fragment) = web.split_once('#').unwrap();
        assert!(!base.contains('?'), "no query: the host must see only the page path");
        assert_eq!(format!("skypie://{fragment}"), open);
        assert_eq!(open_link_of_web(&web).as_deref(), Some(open));
        assert_eq!(web_link_of("https://example.com"), None);
        assert_eq!(open_link_of_web(open), None);
    }

    #[test]
    fn a_web_link_survives_what_browsers_do_to_it_but_carries_only_open() {
        let want = Some("skypie://open?path=%2Fa.html&from=ab".to_string());
        for ok in [
            "https://skypie.ai/l#open?path=%2Fa.html&from=ab",
            "https://skypie.ai/l/#open?path=%2Fa.html&from=ab",
            "http://skypie.ai/l#open?path=%2Fa.html&from=ab",
            "https://WWW.SkyPie.ai/l#open?path=%2Fa.html&from=ab",
            "  https://skypie.ai/l#open?path=%2Fa.html&from=ab\n",
        ] {
            assert_eq!(open_link_of_web(ok), want, "{ok}");
        }
        for bad in [
            "https://skypie.ai/l",
            "https://skypie.ai/l#",
            "https://skypie.ai/l#pair?ticket=abc",
            "https://skypie.ai/l#receive?ticket=abc",
            "https://skypie.ai/other#open?path=%2Fa.html&from=ab",
            "https://evil.example/l#open?path=%2Fa.html&from=ab",
        ] {
            assert_eq!(open_link_of_web(bad), None, "{bad}");
        }
    }
}
