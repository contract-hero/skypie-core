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
///
/// 3: `Request::AddToPie` / `Reply::AddedToPie` (M5, agent reach).
pub const IPC_PROTO: u32 = 3;

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

    // ── Agent reach (M5) ────────────────────────────────────────────────
    /// Add `path` to the pie named or identified by `pie` — a name resolves
    /// case-insensitively, and one that matches no pie CREATES it (an agent
    /// must never have to ask the user to make the pie first). `origin` is
    /// provenance only (never used to decide anything); each of its fields
    /// is independently optional because a caller may not have a
    /// `session_id`/`prompt_id` to hand, and `cwd` is filled in by the MCP
    /// client from its OWN trusted working directory, not taken from the
    /// model's argument.
    AddToPie {
        pie: String,
        path: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<MemberOrigin>,
    },

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

/// Provenance recorded on a member `add_to_pie` creates — mirrors
/// `app/src/pies.rs`'s `PieMemberOrigin` field for field, kept as a SEPARATE
/// type in this crate (rather than reused from `skypie-app`, which this
/// crate cannot depend on: see the module doc's "no tauri here" rule).
/// `#[serde(default)]` so an old caller's bare `{"session_id":"x"}` (missing
/// `prompt_id`/`cwd`) still parses, and each field is ALSO
/// `skip_serializing_if` so a request that supplies none of them serializes
/// with no `origin` object at all rather than `{}`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemberOrigin {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Practical cap on ONE origin field. Provenance, not content: long enough
/// for any real identifier, short enough that nothing can stuff a paragraph
/// into a field the UI renders as a short tag.
pub const MAX_ORIGIN_FIELD_LEN: usize = 128;

/// Practical cap on a pie's name. More generous than an origin field because
/// a pie's name IS rendered — the band tile's label and the plate's
/// `aria-label` — so it needs room for an ordinary human sentence.
pub const MAX_PIE_NAME_LEN: usize = 200;

impl MemberOrigin {
    /// Trim every field, drop an empty one to `None`, and refuse a control
    /// character or an over-long value. Lives HERE, beside the type it
    /// guards, because two sides need the identical rule: `skypie-mcp` cleans
    /// what a model handed it, and the app cleans what reached `app.sock` —
    /// the socket, not the MCP crate, is the trust boundary the app owns, so
    /// a direct socket client gets the same hygiene.
    ///
    /// An over-long or control-bearing value is a hard `Err`, never a silent
    /// truncation: a value cut short reads as though it round-tripped
    /// correctly when it did not.
    pub fn validated(self) -> Result<Self, String> {
        Ok(Self {
            session_id: validate_origin_field(self.session_id)?,
            prompt_id: validate_origin_field(self.prompt_id)?,
            cwd: validate_origin_field(self.cwd)?,
        })
    }
}

/// One origin field, cleaned. See `MemberOrigin::validated`.
pub fn validate_origin_field(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = raw else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().any(char::is_control) {
        return Err("origin field must not contain control characters".to_string());
    }
    if trimmed.chars().count() > MAX_ORIGIN_FIELD_LEN {
        return Err(format!("origin field must be {MAX_ORIGIN_FIELD_LEN} characters or fewer"));
    }
    Ok(Some(trimmed.to_string()))
}

/// Trim a pie name and refuse an empty, control-character-bearing, or
/// over-long result. Shared for the same reason as the origin rule: the MCP
/// client refuses a bad name before it dials the socket, and the app refuses
/// one that arrived over the socket from anything else. Unlike an origin
/// field, a pie's name is never invisible — it is the band tile's and the
/// plate's accessible name — so an empty, multi-line or 5,000-character name
/// directly breaks the UI a person looks at.
pub fn validate_pie_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("pie name must not be empty".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("pie name must not contain control characters".to_string());
    }
    if trimmed.chars().count() > MAX_PIE_NAME_LEN {
        return Err(format!("pie name must be {MAX_PIE_NAME_LEN} characters or fewer"));
    }
    Ok(trimmed.to_string())
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

    // ── Agent reach (M5) ────────────────────────────────────────────────
    /// The outcome of `AddToPie`. `pie`/`pie_id` are the resolved pie's own
    /// name/id — `pie_id` lets the caller act on it again without a second
    /// name lookup; `created` is true when `pie` named no existing pie and
    /// one was minted; `added` is false when the path was ALREADY a member
    /// (idempotent, same as `add_member`) rather than newly inserted.
    /// `members` is the pie's member count after the call, so a caller can
    /// tell the add actually landed without a second `list_devices`-style
    /// round trip.
    AddedToPie {
        pie: String,
        pie_id: String,
        path: PathBuf,
        members: usize,
        created: bool,
        added: bool,
    },

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

// ── Pie members ─────────────────────────────────────────────────────────────
// These two enums describe a pie member, which `app/src/pies.rs` persists.
// They live HERE, not there, because this crate is the contract the socket
// speaks and `skypie-app` depends on this crate rather than the other way
// round: a request that names a member's source (M5's `add_to_pie`) can only
// carry a typed `PieMemberSource` if the type is reachable from this file.
// Declared in this crate and re-exported from `pies.rs`, so there is still
// exactly ONE definition and the store's own call sites read unchanged.

/// A member's own kind — a plain file, or a folder whose contents the census
/// walks. Lowercase on the wire ("file"/"folder"), the same strings spec
/// section 9's `PieMember["kind"]` union names and `ui/src/ipc.ts` types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PieMemberKind {
    File,
    Folder,
}

/// How a member got into its pie. A closed set, not a free string: the
/// frontend already models it as the union `"picker" | "menu" | "finder" |
/// "agent"` (`ui/src/ipc.ts`), and M5's agent socket is a second writer that
/// must not be able to store a value the UI cannot render. Lowercase on the
/// wire for the same reason `PieMemberKind` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PieMemberSource {
    Picker,
    Menu,
    Finder,
    Agent,
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
            Request::AddToPie {
                pie: "Pricing".into(),
                path: "/tmp/pricing-v3.html".into(),
                origin: Some(MemberOrigin {
                    session_id: Some("sess-1".into()),
                    prompt_id: Some("prompt-1".into()),
                    cwd: Some("/work".into()),
                }),
            },
            Request::AddToPie {
                pie: "Pricing".into(),
                path: "/tmp/pricing-v3.html".into(),
                origin: None,
            },
            #[cfg(any(feature = "e2e-hooks", debug_assertions))]
            Request::E2eEval {
                js: "document.title".into(),
            },
        ];
        for r in all {
            assert_eq!(round_trip(&r), r);
        }
    }

    /// `add_to_pie`'s own wire shape (the brief's own naming: a
    /// `the_wire_shape_is_tagged_by_op`-style assertion) — `origin` absent
    /// entirely when not supplied, and a PARTIAL `origin` (missing
    /// `prompt_id`/`cwd`) still parses courtesy of `MemberOrigin`'s own
    /// `#[serde(default)]`.
    #[test]
    fn add_to_pie_is_tagged_by_op_and_origin_is_optional_all_the_way_down() {
        let s = serde_json::to_string(&Request::AddToPie {
            pie: "Pricing".into(),
            path: "/tmp/a.html".into(),
            origin: None,
        })
        .unwrap();
        assert_eq!(s, r#"{"op":"add_to_pie","pie":"Pricing","path":"/tmp/a.html"}"#);

        let r: Request = serde_json::from_str(
            r#"{"op":"add_to_pie","pie":"Pricing","path":"/tmp/a.html","origin":{"session_id":"s1"}}"#,
        )
        .unwrap();
        assert_eq!(
            r,
            Request::AddToPie {
                pie: "Pricing".into(),
                path: "/tmp/a.html".into(),
                origin: Some(MemberOrigin {
                    session_id: Some("s1".into()),
                    prompt_id: None,
                    cwd: None,
                }),
            }
        );

        let added = Response::ok(Reply::AddedToPie {
            pie: "Pricing".into(),
            pie_id: "p1".into(),
            path: "/tmp/a.html".into(),
            members: 1,
            created: false,
            added: true,
        });
        let s = serde_json::to_string(&added).unwrap();
        assert_eq!(
            s,
            r#"{"status":"ok","kind":"added_to_pie","pie":"Pricing","pie_id":"p1","path":"/tmp/a.html","members":1,"created":false,"added":true}"#
        );
        assert_eq!(round_trip(&added), added);
    }

    /// The origin rule lives here once, so both the MCP client and the app's
    /// own socket dispatch enforce the identical thing.
    #[test]
    fn an_origin_field_is_trimmed_dropped_when_empty_and_refused_when_hostile() {
        let some = |s: &str| Some(s.to_string());
        assert_eq!(validate_origin_field(some("  sess-42  ")).unwrap().as_deref(), Some("sess-42"));
        assert_eq!(validate_origin_field(None).unwrap(), None);
        assert_eq!(validate_origin_field(some("")).unwrap(), None, "empty becomes absent");
        assert_eq!(validate_origin_field(some("   ")).unwrap(), None, "whitespace-only too");
        assert!(validate_origin_field(some("line1\nline2")).unwrap_err().contains("control"));
        assert!(validate_origin_field(some("bell\x07")).unwrap_err().contains("control"));
        let ok = "a".repeat(MAX_ORIGIN_FIELD_LEN);
        assert_eq!(validate_origin_field(Some(ok.clone())).unwrap(), Some(ok));
        let too_long = "a".repeat(MAX_ORIGIN_FIELD_LEN + 1);
        assert!(validate_origin_field(Some(too_long))
            .unwrap_err()
            .contains(&MAX_ORIGIN_FIELD_LEN.to_string()));

        let cleaned = MemberOrigin {
            session_id: Some("  s1 ".into()),
            prompt_id: Some("   ".into()),
            cwd: Some("/work".into()),
        }
        .validated()
        .unwrap();
        assert_eq!(
            cleaned,
            MemberOrigin { session_id: some("s1"), prompt_id: None, cwd: some("/work") }
        );
        assert!(MemberOrigin { session_id: some("a\nb"), ..Default::default() }.validated().is_err());
    }

    #[test]
    fn a_pie_name_is_trimmed_and_refused_when_empty_control_bearing_or_over_long() {
        assert_eq!(validate_pie_name("  Pricing  ").unwrap(), "Pricing");
        assert!(validate_pie_name("").unwrap_err().contains("empty"));
        assert!(validate_pie_name("   ").unwrap_err().contains("empty"));
        assert!(validate_pie_name("line1\nline2").unwrap_err().contains("control"));
        let too_long = "x".repeat(MAX_PIE_NAME_LEN + 1);
        assert!(validate_pie_name(&too_long).unwrap_err().contains(&MAX_PIE_NAME_LEN.to_string()));
    }

    #[cfg(any(feature = "e2e-hooks", debug_assertions))]
    #[test]
    fn e2e_eval_is_tagged_by_op_and_its_result_round_trips() {
        let s = serde_json::to_string(&Request::E2eEval { js: "1+1".into() }).unwrap();
        assert_eq!(s, r#"{"op":"e2e_eval","js":"1+1"}"#);

        let ok = Response::ok(Reply::E2eResult { value: serde_json::json!({ "n": 2 }) });
        assert_eq!(round_trip(&ok), ok);
    }

    /// The release safety claim, executed. Without the feature and without
    /// `debug_assertions` the variant is not in the enum at all, so the line
    /// an E2E driver would send cannot parse as a `Request`. Run by
    /// `cargo test -p skypie-ipc --release` (see `scripts/verify.sh`).
    #[cfg(not(any(feature = "e2e-hooks", debug_assertions)))]
    #[test]
    fn a_release_build_cannot_even_parse_an_e2e_eval_line() {
        let e = serde_json::from_str::<Request>(r#"{"op":"e2e_eval","js":"1+1"}"#)
            .expect_err("a release build must not accept this verb");
        assert!(e.to_string().contains("unknown variant"), "{e}");
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
    fn pie_member_enums_are_lowercase_on_the_wire() {
        // The exact strings `ui/src/ipc.ts` types and `state.json` already
        // holds: a rename here silently orphans every stored member.
        assert_eq!(serde_json::to_value(PieMemberKind::Folder).unwrap(), "folder");
        assert_eq!(serde_json::to_value(PieMemberKind::File).unwrap(), "file");
        assert_eq!(serde_json::to_value(PieMemberSource::Finder).unwrap(), "finder");
        assert_eq!(
            serde_json::from_str::<PieMemberSource>("\"agent\"").unwrap(),
            PieMemberSource::Agent
        );
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
