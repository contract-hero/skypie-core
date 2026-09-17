// The client half of the local socket: connect to the running app, launch it
// when it is not running, and ask it one question per connection.
//
// This crate holds NO identity, NO peer list and NO transport of its own.
// Everything a tool does — mint a share link, beam a file, pair a device —
// is the desktop app's operation, driven over `<state_dir>/app.sock` with
// the request/reply contract in `skypie_ipc`. What lives here is argument
// hygiene (before a byte reaches the socket), the launch-and-retry that
// makes "the app must be running" a detail the user never sees, and the one
// roots gate this process keeps for itself.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::io::BufReader;
use tokio::net::UnixStream;
use skypie_ipc::{
    read_line, short_id, socket_path, state_dir, write_line, AppStatus, Reply, Request, Response,
};

use crate::args;

/// How long to keep trying the socket after the app was asked to launch. A
/// cold start opens the blob store and binds the endpoint — a few seconds on
/// a slow disk — and the socket appears only after that.
pub const LAUNCH_WAIT: Duration = Duration::from_secs(15);

/// Between connection attempts while waiting for the launch.
const LAUNCH_POLL: Duration = Duration::from_millis(250);

/// How long one request may take end to end. Long enough for a
/// `list_devices { probe: true }` that waits out its probe timeout on a
/// sleeping device, plus a cold boot.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(90);

/// The app's bundle id, which `open -b` resolves through Launch Services
/// without anybody knowing where the .app sits. Frozen with the scheme and
/// the state directory (STATUS.md).
pub const APP_BUNDLE_ID: &str = "ai.skypie.SkyPie";

/// How the app is started when the socket is absent. A closure so the tests
/// can watch it being called — and refuse — without a Launch Services call.
pub type Launcher = Box<dyn Fn() -> Result<(), String> + Send + Sync>;

/// What `server_status` returns: the app's own report plus this process's
/// facts around it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ServerStatus {
    #[serde(flatten)]
    pub app: AppStatus,
    pub node_id_short: String,
    pub socket_path: PathBuf,
    /// The boundary `beam_artifact` refuses paths outside of.
    pub roots: Vec<PathBuf>,
    /// Whether this process launched the app during this session.
    pub launched_app: bool,
    pub mcp_uptime_secs: u64,
}

pub struct AppClient {
    socket: PathBuf,
    roots: Vec<PathBuf>,
    cwd: PathBuf,
    home: Option<PathBuf>,
    launcher: std::sync::Arc<Launcher>,
    launched: AtomicBool,
    started: Instant,
}

impl AppClient {
    /// The production client: socket under the shared state directory, roots
    /// from `SKYPIE_MCP_ROOTS` (or the working directory), the app launched
    /// through Launch Services.
    pub fn from_env() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Self::with_launcher(
            socket_path(&state_dir()),
            configured_roots(&cwd),
            cwd,
            home,
            Box::new(launch_app),
        )
    }

    pub fn with_launcher(
        socket: PathBuf,
        roots: Vec<PathBuf>,
        cwd: PathBuf,
        home: Option<PathBuf>,
        launcher: Launcher,
    ) -> Self {
        Self {
            socket,
            roots,
            cwd,
            home,
            launcher: std::sync::Arc::new(launcher),
            launched: AtomicBool::new(false),
            started: Instant::now(),
        }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    // ── The one call ────────────────────────────────────────────────────────

    /// Send one request and read its reply. When nothing answers on the
    /// socket the app is launched and the connection retried for
    /// `LAUNCH_WAIT`; the app's own `Err` reply comes back as this `Err`.
    pub async fn call(&self, req: Request) -> Result<Reply, String> {
        let mut stream = self.connect().await?;
        write_line(&mut stream, &req)
            .await
            .map_err(|e| format!("cannot send the request to Sky Pie: {e}"))?;
        let mut reader = BufReader::new(stream);
        let response = tokio::time::timeout(REPLY_TIMEOUT, read_line::<_, Response>(&mut reader))
            .await
            .map_err(|_| "Sky Pie did not answer in time".to_string())?
            .map_err(|e| format!("Sky Pie answered something this build cannot read: {e}"))?;
        response.into_result()
    }

    async fn connect(&self) -> Result<UnixStream, String> {
        match UnixStream::connect(&self.socket).await {
            Ok(stream) => return Ok(stream),
            Err(e) if !is_absent(&e) => {
                return Err(format!("cannot reach Sky Pie at {}: {e}", self.socket.display()))
            }
            Err(_) => {}
        }
        // Nothing is listening: the app is not running (or a stale socket
        // file is all that is left of it). Launch it, then wait for the
        // socket to appear.
        // `open -b` blocks until Launch Services answers; keep that off the
        // worker that also drives the stdio transport. `spawn_blocking`, not
        // `block_in_place`: the latter needs the multi-thread runtime, and a
        // test runs this on a current-thread one.
        let launcher = self.launcher.clone();
        tokio::task::spawn_blocking(move || launcher())
            .await
            .map_err(|e| format!("the launcher panicked: {e}"))??;
        self.launched.store(true, Ordering::Relaxed);
        let deadline = Instant::now() + LAUNCH_WAIT;
        loop {
            tokio::time::sleep(LAUNCH_POLL).await;
            match UnixStream::connect(&self.socket).await {
                Ok(stream) => return Ok(stream),
                Err(e) if is_absent(&e) && Instant::now() < deadline => continue,
                Err(e) => {
                    return Err(format!(
                        "Sky Pie was launched but its socket at {} did not come up: {e}. \
                         Open the app by hand and try again.",
                        self.socket.display()
                    ))
                }
            }
        }
    }

    // ── Tools ───────────────────────────────────────────────────────────────

    /// A `skypie://open?…&from=<app>` link for the user's own paired devices.
    /// Argument hygiene only: the app decides whether the file is shareable.
    pub async fn share_link(&self, raw_path: &str) -> Result<ShareLink, String> {
        let path = args::resolve_arg_path(raw_path, &self.cwd, self.home.as_deref())?;
        match self.call(Request::ShareLink { path }).await? {
            Reply::ShareLink { link, node_id, device, path, name, size } => {
                let web_link = skypie_ipc::web_link_of(&link)
                    .ok_or_else(|| format!(
                        "Sky Pie returned a share link this MCP build does not recognise ({link}). \
                         The app and the plugin are out of step: update Sky Pie, then retry."
                    ))?;
                Ok(ShareLink { link, web_link, node_id, device, path, name, size })
            }
            other => Err(unexpected(other)),
        }
    }

    /// A `skypie://receive?ticket=…` link anyone may fetch. Gated by this
    /// process's roots BEFORE the socket is touched: a beam publishes to
    /// strangers, and the caller is a model steerable by text it has read.
    pub async fn beam_artifact(&self, raw_path: &str, ttl_hours: Option<u32>) -> Result<BeamLink, String> {
        let ttl = args::validate_ttl(ttl_hours)?;
        let path = args::resolve_arg_path(raw_path, &self.cwd, self.home.as_deref())?;
        let path = args::confine(&path, &self.roots)?;
        match self.call(Request::BeamArtifact { path, ttl_hours: Some(ttl) }).await? {
            Reply::BeamLink { link, ticket, name, size, expires_at, hash } => {
                Ok(BeamLink { link, ticket, name, size, expires_at, hash })
            }
            other => Err(unexpected(other)),
        }
    }

    pub async fn stop_beam(&self, hash: Option<&str>) -> Result<Vec<skypie_ipc::OfferSummary>, String> {
        // Omitted means "every link". A hash that was PROVIDED and is empty
        // is an argument error, not the widest possible action.
        let hash = match hash.map(str::trim) {
            None => None,
            Some("") => {
                return Err("hash must name a link — omit it to revoke every link".to_string())
            }
            Some(h) => Some(h.to_string()),
        };
        match self.call(Request::StopBeam { hash }).await? {
            Reply::Stopped { stopped } => Ok(stopped),
            other => Err(unexpected(other)),
        }
    }

    pub async fn list_devices(&self, probe: bool) -> Result<Vec<skypie_ipc::DeviceInfo>, String> {
        match self.call(Request::ListDevices { probe }).await? {
            Reply::Devices { devices } => Ok(devices),
            other => Err(unexpected(other)),
        }
    }

    pub async fn pair_device(&self) -> Result<PairingInvite, String> {
        match self.call(Request::PairDevice).await? {
            Reply::PairInvite { link, ticket, node_id, device, expires_at } => Ok(PairingInvite {
                link,
                ticket,
                node_id,
                device,
                expires_at,
                instructions: pairing_instructions(),
                fingerprint_hint: "call pair_status and read the six words to the user".to_string(),
            }),
            other => Err(unexpected(other)),
        }
    }

    pub async fn pair_status(&self) -> Result<Vec<skypie_ipc::PendingPairing>, String> {
        match self.call(Request::PairStatus).await? {
            Reply::PairStatus { pending } => Ok(pending),
            other => Err(unexpected(other)),
        }
    }

    pub async fn confirm_pairing(&self, accept: bool, node_id: Option<&str>) -> Result<PairingOutcome, String> {
        let node_id = node_id.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
        match self.call(Request::ConfirmPairing { accept, node_id }).await? {
            Reply::PairingOutcome { paired, device, node_id } => {
                Ok(PairingOutcome { paired, device, node_id })
            }
            other => Err(unexpected(other)),
        }
    }

    // ── Agent reach (M5) ────────────────────────────────────────────────

    /// Add a file (or folder) this session just produced to `pie` — a NAME
    /// (case-insensitive; created if none matches — never a reason to ask
    /// the user to make it first) or an id. `session_id`/`prompt_id` are
    /// this tool's own optional provenance arguments; `cwd` is NOT one of
    /// them — it always comes from THIS process's own trusted working
    /// directory (`self.cwd`), never from a model-supplied argument, the
    /// same reasoning `args::confine` already applies to `roots`.
    pub async fn add_to_pie(
        &self,
        pie: &str,
        raw_path: &str,
        session_id: Option<String>,
        prompt_id: Option<String>,
    ) -> Result<AddedToPie, String> {
        // The same two validators the APP runs on whatever reaches its
        // socket, applied here so a bad argument is refused before this
        // process even dials — a model-supplied identifier is free text, not
        // a value to trust blindly.
        let pie = skypie_ipc::validate_pie_name(pie)?;
        let path = args::resolve_arg_path(raw_path, &self.cwd, self.home.as_deref())?;
        let origin = skypie_ipc::MemberOrigin {
            session_id,
            prompt_id,
            cwd: Some(self.cwd.to_string_lossy().into_owned()),
        }
        .validated()?;
        match self.call(Request::AddToPie { pie, path, origin: Some(origin) }).await?
        {
            Reply::AddedToPie { pie, pie_id, path, members, created, added } => {
                Ok(AddedToPie { pie, pie_id, path, members, created, added })
            }
            other => Err(unexpected(other)),
        }
    }

    pub async fn forget_device(&self, device: &str) -> Result<Forgotten, String> {
        let device = args::validate_device_query(device)?.to_string();
        match self.call(Request::ForgetDevice { device }).await? {
            Reply::Forgotten { device, node_id } => Ok(Forgotten {
                node_id_short: short_id(&node_id),
                device,
                node_id,
            }),
            other => Err(unexpected(other)),
        }
    }

    // ── Feedback ────────────────────────────────────────────────────────
    //
    // Note the absence of a "write a comment" call. The agent may read
    // feedback and mark a point addressed; authoring a comment in the user's
    // name is not something a model gets to do, and the store has no verb
    // for it on this socket.

    pub async fn feedback_for(&self, path: &Path) -> Result<Feedback, String> {
        match self.call(Request::FeedbackFor { path: path.to_path_buf() }).await? {
            Reply::Feedback { path, open, context } => Ok(Feedback { path, open, context }),
            other => Err(unexpected(other)),
        }
    }

    pub async fn feedback_index(&self) -> Result<Vec<skypie_ipc::FeedbackFile>, String> {
        match self.call(Request::FeedbackIndex).await? {
            Reply::FeedbackIndex { files } => Ok(files),
            other => Err(unexpected(other)),
        }
    }

    pub async fn resolve_feedback(
        &self,
        path: &Path,
        id: &str,
        note: Option<String>,
        addressed: bool,
    ) -> Result<Resolved, String> {
        let id = args::validate_annotation_id(id)?.to_string();
        match self
            .call(Request::ResolveFeedback {
                path: path.to_path_buf(),
                id,
                note,
                addressed,
            })
            .await?
        {
            Reply::FeedbackResolved { id, path, resolution, remaining } => {
                Ok(Resolved { id, path, resolution, remaining })
            }
            other => Err(unexpected(other)),
        }
    }

    /// One round trip that must NEVER launch the app.
    ///
    /// THE no-launch rule, as one named method. A `PostToolUse` hook fires on
    /// every `Read` in every session, and launching a GUI because an agent
    /// read a file would be indefensible — so the hook path connects to the
    /// socket directly instead of going through `connect`, which launches and
    /// retries. Nothing listening, a timeout, an app error: all `None`, which
    /// the hook renders as silence.
    async fn call_if_running(&self, req: Request) -> Option<Reply> {
        let mut stream = UnixStream::connect(&self.socket).await.ok()?;
        write_line(&mut stream, &req).await.ok()?;
        let mut reader = BufReader::new(stream);
        tokio::time::timeout(REPLY_TIMEOUT, read_line::<_, Response>(&mut reader))
            .await
            .ok()?
            .ok()?
            .into_result()
            .ok()
    }

    /// A file's open feedback, without launching the app.
    pub async fn feedback_if_running(&self, path: &Path) -> Option<Feedback> {
        match self
            .call_if_running(Request::FeedbackFor { path: path.to_path_buf() })
            .await?
        {
            Reply::Feedback { path, open, context } => Some(Feedback { path, open, context }),
            _ => None,
        }
    }

    /// Every waiting file, without launching the app. The `UserPromptSubmit`
    /// hook's half of the no-launch rule.
    pub async fn feedback_index_if_running(&self) -> Option<Vec<skypie_ipc::FeedbackFile>> {
        match self.call_if_running(Request::FeedbackIndex).await? {
            Reply::FeedbackIndex { files } => Some(files),
            _ => None,
        }
    }

    pub async fn server_status(&self) -> Result<ServerStatus, String> {
        match self.call(Request::Status).await? {
            Reply::Status(app) => Ok(ServerStatus {
                node_id_short: short_id(&app.node_id),
                app,
                socket_path: self.socket.clone(),
                roots: self.roots.clone(),
                launched_app: self.launched.load(Ordering::Relaxed),
                mcp_uptime_secs: self.started.elapsed().as_secs(),
            }),
            other => Err(unexpected(other)),
        }
    }
}

// ── Result shapes the tools render ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ShareLink {
    pub link: String,
    /// `https://…/l#open?…` twin of `link`, derived here: clickable where
    /// only `http(s)` is forwarded (Claude Desktop, iOS plain text).
    pub web_link: String,
    pub node_id: String,
    pub device: String,
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BeamLink {
    pub link: String,
    pub ticket: String,
    pub name: String,
    pub size: u64,
    pub expires_at: u64,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PairingInvite {
    pub link: String,
    pub ticket: String,
    pub node_id: String,
    pub device: String,
    pub expires_at: u64,
    pub instructions: Vec<String>,
    pub fingerprint_hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PairingOutcome {
    pub paired: bool,
    pub device: String,
    pub node_id: String,
}

/// Open feedback on one file, as the app rendered it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Feedback {
    pub path: PathBuf,
    pub open: usize,
    pub context: String,
}

/// One comment after the agent marked it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Resolved {
    pub id: String,
    pub path: PathBuf,
    pub resolution: String,
    pub remaining: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Forgotten {
    pub device: String,
    pub node_id: String,
    pub node_id_short: String,
}

/// The outcome of `add_to_pie`, as the app reported it. `Serialize` — not
/// optional: `server::ok` refuses a `structuredContent` that isn't a JSON
/// object, and every tool result in this crate flows through it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AddedToPie {
    pub pie: String,
    pub pie_id: String,
    pub path: PathBuf,
    pub members: usize,
    pub created: bool,
    pub added: bool,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// "Nothing is listening": the socket file is missing, or it exists and no
/// process answers on it. Both mean "launch the app"; every other error is
/// something launching would not fix.
fn is_absent(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
    )
}

/// The app answered with a reply that does not belong to the request. Only a
/// build skew between the two binaries produces this.
fn unexpected(reply: Reply) -> String {
    format!("Sky Pie answered an unexpected reply ({reply:?}) — are both builds current?")
}

/// Launch the desktop app through Launch Services. `SKYPIE_APP_BUNDLE_ID`
/// overrides the bundle id for a dev build that registers its own.
fn launch_app() -> Result<(), String> {
    let bundle = std::env::var("SKYPIE_APP_BUNDLE_ID").unwrap_or_else(|_| APP_BUNDLE_ID.to_string());
    let status = std::process::Command::new("open")
        .args(["-g", "-b", &bundle])
        .status()
        .map_err(|e| format!("cannot run `open -b {bundle}`: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Sky Pie is not running and could not be launched (`open -b {bundle}` exited \
             with {status}). Install the app or open it by hand, then try again."
        ))
    }
}

/// The roots `beam_artifact` confines a path to. `SKYPIE_MCP_ROOTS` is a
/// colon-separated list; unset, the working directory is the one root.
pub fn configured_roots(cwd: &Path) -> Vec<PathBuf> {
    match std::env::var("SKYPIE_MCP_ROOTS") {
        Ok(raw) => {
            let roots: Vec<PathBuf> =
                raw.split(':').map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from).collect();
            if roots.is_empty() {
                vec![cwd.to_path_buf()]
            } else {
                roots
            }
        }
        Err(_) => vec![cwd.to_path_buf()],
    }
}

/// The human half of pairing, written for the model to read out loud.
fn pairing_instructions() -> Vec<String> {
    vec![
        "Give the link to the person at the other device — it is a capability, so send it over a channel you trust. The Mac's Settings → Devices also shows it as a QR code.".to_string(),
        "On that device, open the link (or scan the code). On iOS, tap it; on a Mac running Sky Pie, click it.".to_string(),
        "Both screens now show six words. They must match. If they differ, reject the pairing.".to_string(),
        "Call pair_status to read this Mac's six words, then confirm_pairing { accept: true } to finish.".to_string(),
        "The link expires 10 minutes after it is minted, and one link pairs one device.".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_means_launch_and_everything_else_means_stop() {
        assert!(is_absent(&std::io::Error::from(std::io::ErrorKind::NotFound)));
        assert!(is_absent(&std::io::Error::from(std::io::ErrorKind::ConnectionRefused)));
        assert!(!is_absent(&std::io::Error::from(std::io::ErrorKind::PermissionDenied)));
    }

    #[test]
    fn roots_come_from_the_env_or_the_working_directory() {
        let cwd = PathBuf::from("/work");
        // Not touching the process env here: the parsing rule is the thing.
        std::env::remove_var("SKYPIE_MCP_ROOTS");
        assert_eq!(configured_roots(&cwd), vec![cwd.clone()]);
        std::env::set_var("SKYPIE_MCP_ROOTS", " /a : /b :");
        assert_eq!(configured_roots(&cwd), vec![PathBuf::from("/a"), PathBuf::from("/b")]);
        std::env::set_var("SKYPIE_MCP_ROOTS", " : ");
        assert_eq!(configured_roots(&cwd), vec![cwd]);
        std::env::remove_var("SKYPIE_MCP_ROOTS");
    }
}
