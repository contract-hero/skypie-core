// Remote subsystem — the Tauri half of Beam (share with anyone who holds the
// link) and Scope (pull from one of the user's own paired devices).
//
// The networked core lives in the `skypie-remote` crate: identity, endpoint,
// wire protocol, peer store and request gate. THIS file is everything that
// crate deliberately does not know — the `#[tauri::command]` layer, the
// `skypie://*` event glue, and the one seam the crate asks a host to fill:
//
//   * `EventSink` — `host_signal_sink` turns each `HostSignal` into the
//                   webview event it belongs to;
//   * base dirs   — `dirs()` names `~/Library/Application Support/SkyPie`,
//                   which the crate itself never mentions.
//
// Every command is a thin wrapper over a `pub(crate) …_for(&AppHandle, …)`
// function, because the local socket server (`ipc_server.rs`) drives the
// same operations for `skypie-mcp` and must not grow a second implementation
// of any of them.
//
// Lazy-boot contract: the app makes ZERO network connections until the user
// invokes a remote action — or, at launch, when the peer store is non-empty
// AND `preferences.remote_listen` is on (its default). `RemoteState.node`
// starts empty and is populated on the first action that truly needs it;
// listing peers and revoking a peer never boot it.

pub use skypie_remote::{beam, endpoint, peers, proto, resolve, scope};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use skypie_ipc::{AppStatus, DeviceInfo, OfferSummary, PendingPairing, Presence};

use peers::{Peer, PendingPair};
use proto::ArtifactMeta;
use scope::ConnectError;
// Re-exported for the app's own consumers (deep-link layer, tests).
pub use skypie_remote::{Dirs, HostSignal};

/// Shortest offer-hash prefix `beam_stop_for` accepts. Eight hex characters
/// is 32 bits — enough that a typo lands on no real offer.
const MIN_HASH_CHARS: usize = 8;

/// How long `list_devices { probe: true }` waits on one device before it
/// reports it offline. Bounds the whole probe at about this, because every
/// device is dialed at once.
#[cfg(target_os = "macos")]
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);

/// Where this app keeps the remote subsystem's files. The crate hardcodes no
/// directory: every path below derives from the app's own state dir.
pub(crate) fn dirs() -> Dirs {
    Dirs::new(crate::state_store::state_dir())
}

/// Managed Tauri state: the lazily booted node, plus the host-side state that
/// exists with or without an endpoint (peers, pending pairings) and the
/// client-side sessions this instance holds.
pub struct RemoteState {
    node: tokio::sync::Mutex<Option<Arc<endpoint::RemoteNode>>>,
    /// Why the last boot failed, for `server_status`. Cleared on success.
    last_boot_error: std::sync::Mutex<Option<String>>,
    peers: Arc<peers::PeerStore>,
    /// What this Mac has OFFERED each paired device — read over the wire by
    /// `Req::ListShared`, never sent. Distinct from `RemoteNode::offers`,
    /// which is Beam's staged-blob registry for strangers.
    shared: Arc<crate::shared_offers::OfferStore>,
    pairing: Arc<peers::Pairing>,
    device: String,
    /// This install's NodeId, read from `identity.key` (created if absent)
    /// WITHOUT binding a socket — a share link needs the id, not the
    /// endpoint. `None` only when the key cannot be read or created, which
    /// `boot` reports as a hard error on its own.
    self_id: Option<String>,
    /// Read by `status_for`, which only the macOS socket server calls.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    started: Instant,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<scope::ClientSession>>>,
    /// One dial gate per peer id, so `session()` can serialize the dials for
    /// ONE peer without serializing the dials for all of them. Entries are
    /// never removed: it is one empty mutex per device this process has
    /// dialed, and a device that is unpaired and paired again comes back
    /// under the same node id.
    dials: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Which round of sessions this app is on. Bumped when it abandons every
    /// session it holds — the iOS foreground hop — and read by each session's
    /// `on_closed` before that callback reports presence. Dropping a session
    /// does not wake its reader task: the task sits on a connection nobody
    /// uses until the peer's idle timer kills it, and by then a live
    /// replacement may have been dialed for the same peer. The generation is
    /// what tells the late callback that it speaks for a session the app no
    /// longer has.
    session_generation: AtomicU64,
}

impl RemoteState {
    pub fn new() -> Self {
        let remote_dir = dirs().remote();
        let self_id = match endpoint::load_or_create_identity(&remote_dir) {
            Ok(secret) => Some(secret.public().to_string()),
            Err(e) => {
                eprintln!("skypie: remote: cannot read this install's identity: {e}");
                None
            }
        };
        Self {
            node: tokio::sync::Mutex::new(None),
            last_boot_error: std::sync::Mutex::new(None),
            peers: Arc::new(peers::PeerStore::load(&remote_dir)),
            shared: Arc::new(crate::shared_offers::OfferStore::load(&remote_dir)),
            pairing: Arc::new(peers::Pairing::new()),
            device: crate::device_name::announced_name(),
            self_id,
            started: Instant::now(),
            sessions: tokio::sync::Mutex::new(HashMap::new()),
            dials: tokio::sync::Mutex::new(HashMap::new()),
            session_generation: AtomicU64::new(0),
        }
    }

    /// This install's NodeId, hex. What `dispatch_deep_link` compares a
    /// link's `from` against to tell "mine" from "a paired device's".
    pub fn self_id(&self) -> Option<&str> {
        self.self_id.as_deref()
    }

    /// This install's announced device name — the same sanitized string a
    /// peer sees at pairing time. Comment authorship reads it so "Alvaro's
    /// iPhone" on a comment and "Alvaro's iPhone" in the Devices pane are
    /// one string from one source.
    pub fn device_name(&self) -> &str {
        &self.device
    }

    /// The trusted-peer store — the deep-link layer asks it whether a link's
    /// `from` names a paired device.
    pub fn peers(&self) -> &peers::PeerStore {
        &self.peers
    }

    /// Get the booted node, booting it on first use. `scope_state` is a
    /// FACTORY, not a value: every call after the first returns the node
    /// already in hand.
    async fn node(
        &self,
        scope_state: impl FnOnce() -> Arc<scope::ScopeState> + Send,
        on_offers_change: impl Fn(Vec<beam::OfferInfo>) + Send + Sync + 'static,
    ) -> Result<Arc<endpoint::RemoteNode>, String> {
        let mut guard = self.node.lock().await;
        if let Some(node) = guard.as_ref() {
            return Ok(node.clone());
        }
        let booted = endpoint::boot(&dirs(), Some(scope_state()), on_offers_change).await;
        *self.last_boot_error.lock().unwrap_or_else(|p| p.into_inner()) =
            booted.as_ref().err().cloned();
        let node = Arc::new(booted?);
        *guard = Some(node.clone());
        Ok(node)
    }

    /// Peek the node without booting — for commands where "no node yet"
    /// means "nothing to do" (listing, revoking). Booting sockets to answer
    /// a guaranteed no-op would break the lazy-boot contract.
    async fn existing(&self) -> Option<Arc<endpoint::RemoteNode>> {
        self.node.lock().await.clone()
    }

    /// This peer's dial gate, created on first use. The map lock is taken and
    /// released without an await in between, so a peer whose gate is held for
    /// a whole thirty-second dial blocks nobody but the next dial to itself.
    async fn dial_gate(&self, peer: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.dials
            .lock()
            .await
            .entry(peer.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}

impl Default for RemoteState {
    fn default() -> Self {
        Self::new()
    }
}

fn offers_changed(app: &tauri::AppHandle, node: &endpoint::RemoteNode) {
    let _ = app.emit("skypie://beam-offers-updated", node.offers.list());
}

// ═══ Beam ═══════════════════════════════════════════════════════════════════

/// Stage a file into the blob store, mint a ticket, and register the offer.
/// `ttl_hours` overrides the preference; both are clamped by the crate.
pub(crate) async fn beam_offer_for(
    app: &tauri::AppHandle,
    path: &Path,
    ttl_hours: Option<u32>,
) -> Result<beam::OfferInfo, String> {
    let roots = app.state::<crate::security::RootSet>();
    let cand = beam::resolve_offerable(path, &roots)?;
    let ttl_hours = ttl_hours
        .or(crate::state_store::current_state().preferences.beam_ttl_hours)
        .unwrap_or(beam::DEFAULT_TTL_HOURS);

    let node = boot_node(app).await?;
    let info = beam::offer(&node, &cand, ttl_hours).await?;
    offers_changed(app, &node);
    Ok(info)
}

/// Path policy lives in `beam::resolve_offerable`, shared with the
/// `skypie://beam` dispatch arm: conservative share gate, files only, hard
/// cap — rechecked here at confirm time.
#[tauri::command]
pub async fn beam_offer(app: tauri::AppHandle, path: String) -> Result<beam::OfferInfo, String> {
    beam_offer_for(&app, Path::new(&path), None).await
}

/// Revoke offers: every one whose hash starts with `prefix`, or all of them
/// when `prefix` is absent. The ticket dies with the offer: the request gate
/// consults the registry per request, so the next fetch is denied even if
/// the blob bytes are still in the store. Never boots — with no node there
/// is nothing to revoke. Returns what was stopped.
pub(crate) async fn beam_stop_for(
    app: &tauri::AppHandle,
    prefix: Option<&str>,
) -> Result<Vec<beam::OfferInfo>, String> {
    let state = app.state::<RemoteState>();
    let Some(node) = state.existing().await else {
        return Ok(Vec::new());
    };
    let live = node.offers.list();
    let stopped: Vec<beam::OfferInfo> = match prefix {
        None => live,
        Some(raw) => {
            let Some(needle) = resolve::needle(raw, MIN_HASH_CHARS) else {
                return Err(format!(
                    "hash must be at least {MIN_HASH_CHARS} characters of the offer's hash"
                ));
            };
            resolve::by_prefix(&live, &needle, |o| o.id.as_str()).into_iter().cloned().collect()
        }
    };
    for offer in &stopped {
        beam::stop(&node, &offer.id).await;
    }
    if !stopped.is_empty() {
        offers_changed(app, &node);
    }
    Ok(stopped)
}

#[tauri::command]
pub async fn beam_stop(app: tauri::AppHandle, offer_id: String) -> Result<(), String> {
    beam_stop_for(&app, Some(&offer_id)).await.map(|_| ())
}

/// Active (unexpired) offers for the "beaming" indicator. Never boots.
#[tauri::command]
pub async fn beam_list_offers(
    state: tauri::State<'_, RemoteState>,
) -> Result<Vec<beam::OfferInfo>, String> {
    Ok(state.existing().await.map(|n| n.offers.list()).unwrap_or_default())
}

/// Post-confirm fetch: dial the ticket, stream the BLAKE3-verified blob, and
/// land it under `received/<date>/`. Progress goes out as
/// `skypie://beam-progress` events keyed by the ticket's hash.
#[tauri::command]
pub async fn beam_receive(
    app: tauri::AppHandle,
    ticket: String,
    name: Option<String>,
) -> Result<beam::ReceivedFile, String> {
    let node = boot_node(&app).await?;
    let progress_app = app.clone();
    beam::receive(
        &node,
        &ticket,
        name.as_deref(),
        &dirs().received(),
        move |hash_hex, received| {
            let _ = progress_app.emit(
                "skypie://beam-progress",
                beam::ProgressEvent { hash: hash_hex.to_string(), received },
            );
        },
    )
    .await
}

/// Where received artifacts land — the frontend uses this prefix to swap the
/// "external" badge for a "beamed" one.
#[tauri::command]
pub fn beam_received_dir() -> String {
    dirs().received().to_string_lossy().into_owned()
}

/// Past beams, newest first, for the "Received" list.
#[tauri::command]
pub fn beam_list_received() -> Vec<beam::ReceivedEntry> {
    beam::list_received(&dirs().received())
}

// ═══ Share link (own devices) ═══════════════════════════════════════════════

/// What `remote_share_link` returns: the link plus what it names.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ShareLink {
    pub link: String,
    pub node_id: String,
    pub device: String,
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
}

/// Mint a `skypie://open?path=…&from=<this node>` link for a local file.
///
/// Boots the endpoint: a link to a node that is not listening is a dead
/// link, and the person copying it is about to open it on another device.
/// No root gate — the link only works on the user's own paired devices, so
/// its posture is a local `skypie://open`'s.
pub(crate) async fn share_link_for(app: &tauri::AppHandle, path: &Path) -> Result<ShareLink, String> {
    let cand = beam::resolve_offerable_any(path)?;
    let node = boot_node(app).await?;
    let node_id = node.endpoint.id().to_string();
    let state = app.state::<RemoteState>();
    // One record, not one per peer: the link names its SOURCE and never a
    // destination, so the fact has no peer dimension. Every paired device
    // reads the same list, including one paired after this share.
    state.shared.record(&cand.canonical.to_string_lossy());
    Ok(ShareLink {
        link: beam::build_open_link(&cand.canonical, &node_id),
        node_id,
        device: state.device.clone(),
        path: cand.canonical,
        name: cand.name,
        size: cand.size,
    })
}

#[tauri::command]
pub async fn remote_share_link(app: tauri::AppHandle, path: String) -> Result<ShareLink, String> {
    share_link_for(&app, Path::new(&path)).await
}

// ═══ Scope ══════════════════════════════════════════════════════════════════

/// What `skypie://remote-presence` carries. One payload for all three states.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PresenceEvent {
    pub peer: String,
    /// "connecting" | "online" | "offline".
    pub state: &'static str,
    /// The host's announced device name, once the handshake produced one.
    pub device: Option<String>,
    /// Why the session ended or failed to start. Absent on success.
    pub reason: Option<String>,
}

/// What `skypie://remote-event` carries. One event name, discriminated by
/// `kind`, so the frozen `skypie://*` namespace does not grow per verb.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RemoteEvent {
    /// A pairing reached the fingerprint step on THIS machine. The UI shows
    /// the six words and calls `remote_pair_confirm`.
    PairPending {
        peer: String,
        device: String,
        fingerprint: Vec<String>,
        /// "host" (this machine minted the ticket) or "guest".
        role: String,
    },
    /// A `skypie://pair?ticket=…` deep link arrived. The UI shows the inviting
    /// device and calls `remote_pair_complete(ticket)` when the user proceeds
    /// — the link alone never dials anything.
    PairLink {
        peer: String,
        peer_short: String,
        device: String,
        ticket: String,
    },
    /// The peer list changed (paired, unpaired).
    PeersUpdated,
    /// A `skypie://open?…&from=<paired device>` link arrived. The UI opens a
    /// tab at the remote address; the tab's loader pulls the file.
    OpenRemote {
        peer: String,
        device: String,
        path: String,
        line: Option<u32>,
        intent: crate::DeepLinkIntentKind,
    },
    /// iOS brought the app back to the foreground. Every cached session was
    /// dropped immediately before this went out; the next pull re-dials.
    Resumed,
}

/// A verified artifact fetched from a peer, in the local content-addressed
/// cache. `path` is what the render pipeline opens.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteArtifact {
    pub peer: String,
    /// The path ON THE HOST — the identity the tab uses.
    pub remote_path: String,
    /// The local cache file: `remote/cache/<hash><ext>`.
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub mtime: u64,
    pub warn: bool,
}

/// Trusted peers, newest pairing first. Never boots the endpoint.
#[tauri::command]
pub fn remote_list_peers(state: tauri::State<'_, RemoteState>) -> Vec<Peer> {
    state.peers.list()
}

/// Mint a one-time pairing token and the `skypie://pair?ticket=…` link that
/// carries it. Boots the endpoint: the ticket must contain reachable
/// addresses, which only a bound endpoint knows.
pub(crate) async fn pair_begin_for(app: &tauri::AppHandle) -> Result<peers::PairInvite, String> {
    let node = boot_node(app).await?;
    // Bounded wait for relay + discovery so the ticket dials from another
    // network; on timeout it still carries direct addresses (same policy as
    // minting a beam ticket).
    let _ = tokio::time::timeout(Duration::from_secs(10), node.endpoint.online()).await;
    let state = app.state::<RemoteState>();
    Ok(peers::mint_invite(node.endpoint.addr(), &state.pairing, &state.device))
}

#[tauri::command]
pub async fn remote_pair_begin(app: tauri::AppHandle) -> Result<peers::PairInvite, String> {
    pair_begin_for(&app).await
}

/// Open a pairing ticket: dial the host's pairing ALPN, present the token,
/// and park the pairing at the fingerprint step. NOTHING is persisted here —
/// `remote_pair_confirm` is the step the human authorizes.
#[tauri::command]
pub async fn remote_pair_complete(
    app: tauri::AppHandle,
    ticket: String,
) -> Result<PendingPair, String> {
    let ticket: peers::PairTicket = ticket.parse()?;
    let node = boot_node(&app).await?;
    let device = app.state::<RemoteState>().device.clone();
    let pending = scope::pair_dial(&node, &ticket, device).await?;
    park_and_announce(&app, pending.clone());
    Ok(pending)
}

// Only the macOS socket server (`ipc_server.rs`) calls this.
#[cfg(target_os = "macos")]
/// Pairings parked at the fingerprint step, for `pair_status`.
pub(crate) fn pair_status_for(app: &tauri::AppHandle) -> Vec<PendingPairing> {
    app.state::<RemoteState>()
        .pairing
        .parked()
        .into_iter()
        .map(|p| PendingPairing {
            node_id_short: peers::short_id(&p.node_id),
            node_id: p.node_id,
            device: p.device,
            fingerprint: p.fingerprint,
            role: p.role,
            created_at: p.created_at,
        })
        .collect()
}

/// Resolve a parked pairing after the human compared the six words. `query`
/// names it (full id, prefix or device name) and may be omitted while
/// exactly one pairing waits. `accept: false` discards it — the peer is
/// never written to disk, so a mismatched fingerprint leaves no trace.
/// Returns who was decided on, and the persisted peer on acceptance.
pub(crate) fn pair_confirm_for(
    app: &tauri::AppHandle,
    accept: bool,
    query: Option<&str>,
) -> Result<PairOutcome, String> {
    let state = app.state::<RemoteState>();
    let parked = state.pairing.parked();
    let chosen = resolve::resolve_pending(&parked, query)?.node_id.clone();
    let Some(pending) = state.pairing.take(&chosen) else {
        return Err("no pairing is waiting for confirmation".to_string());
    };
    let (node_id, device) = (pending.node_id.clone(), pending.device.clone());
    if !accept {
        return Ok(PairOutcome { node_id, device, peer: None });
    }
    let peer = match state.peers.confirm(&pending.node_id, &pending.device) {
        Ok(peer) => peer,
        Err(e) => {
            // Put it back. The human is still standing in front of the six
            // words, and a store that could not be written is a reason to
            // retry, not a reason to lose the pairing.
            state.pairing.park(pending);
            return Err(e);
        }
    };
    let _ = app.emit("skypie://remote-event", RemoteEvent::PeersUpdated);
    Ok(PairOutcome { node_id, device, peer: Some(peer) })
}

/// What `pair_confirm_for` decided on: the pairing it took, and the peer it
/// persisted when the human accepted.
pub(crate) struct PairOutcome {
    /// Named back to the MCP caller; the app's own command only wants `peer`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub node_id: String,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub device: String,
    pub peer: Option<Peer>,
}

#[tauri::command]
pub fn remote_pair_confirm(
    app: tauri::AppHandle,
    node_id: String,
    accept: bool,
) -> Result<Option<Peer>, String> {
    pair_confirm_for(&app, accept, Some(&node_id)).map(|o| o.peer)
}

/// Revoke a peer: delete the entry, drop its open sessions, and un-grant the
/// artifacts staged for it. The scope server rejects it at the next
/// handshake, so revocation is immediate. Never boots. `query` is a full
/// node id, a prefix or a device name; returns the peer that was forgotten.
pub(crate) async fn forget_device_for(app: &tauri::AppHandle, query: &str) -> Result<Peer, String> {
    let state = app.state::<RemoteState>();
    let peer = resolve::resolve_device(&state.peers.list(), query).map_err(|e| e.to_string())?;
    let node_id = peer.node_id.clone();
    state.peers.remove(&node_id)?;
    state.sessions.lock().await.remove(&node_id);
    if let Some(node) = state.existing().await {
        if let Some(server) = &node.scope {
            server.revoke(&node_id).await;
        }
    }
    let _ = app.emit("skypie://remote-event", RemoteEvent::PeersUpdated);
    Ok(peer)
}

#[tauri::command]
pub async fn remote_unpair(app: tauri::AppHandle, node_id: String) -> Result<(), String> {
    forget_device_for(&app, &node_id).await.map(|_| ())
}

/// Dial a paired peer and keep the session, so presence goes online. The
/// Devices pane's "check who's online" and the launch/resume reconnect use
/// this; a pull dials on its own.
#[tauri::command]
pub async fn remote_connect(app: tauri::AppHandle, peer: String) -> Result<(), String> {
    session(&app, &peer).await.map(|_| ())
}

/// What one paired device has offered THIS install.
///
/// The phone asks when it comes to the foreground. A device that cannot be
/// reached answers with an empty list rather than an error: "nothing waiting"
/// and "I could not ask" look the same on a start page, and a reader opening
/// the app should not be met with a failure for a list they did not request.
/// A real pull still reports its own failure, which is where the reader can
/// act on it.
#[tauri::command]
pub async fn remote_list_shared(
    app: tauri::AppHandle,
    peer: String,
) -> Result<Vec<skypie_remote::proto::SharedEntry>, String> {
    let Ok(session) = session_inner(&app, &peer).await else {
        return Ok(Vec::new());
    };
    match session.list_shared().await {
        Ok(page) => Ok(page.entries),
        // A session that died under the request is FORGOTTEN, so the next
        // call dials fresh — the same repair `remote_get` performs. Without
        // it a dead cached session would keep answering "nothing waiting"
        // forever, and the user could not tap a row to trigger the repair
        // because no row would render.
        Err(scope::GetFailure::Closed) => {
            forget_session(&app, &peer, &session).await;
            Ok(Vec::new())
        }
        // A refusal is the host's answer. There is no older-peer case to
        // handle: `PROTO_VERSION` moved to 2 with this frame, so a build
        // without it is turned away at the handshake instead.
        Err(_) => Ok(Vec::new()),
    }
}

/// Fetch an artifact from a peer: ask for its content address on the session
/// stream, then pull the bytes over the verified blob protocol into
/// `remote/cache/<hash><ext>`. Returns the LOCAL cache path the render
/// pipeline opens.
#[tauri::command]
pub async fn remote_get(
    app: tauri::AppHandle,
    peer: String,
    path: String,
) -> Result<RemoteArtifact, RemoteGetError> {
    let session = session_inner(&app, &peer).await?;
    let meta: ArtifactMeta = match session.get_artifact(path.clone()).await {
        Ok(meta) => meta,
        // The cached session died under the request — the Mac quit, or the
        // phone was suspended — and `is_closed()` had not caught up. Forget
        // it and dial ONCE more: a peer that is really gone now fails at the
        // dial, as `Unreachable`, which is the screen the reader should see.
        // A session that dies AGAIN under the fresh request is the same
        // story one step later, and keeps the same cause.
        Err(scope::GetFailure::Closed) => {
            forget_session(&app, &peer, &session).await;
            let fresh = session_inner(&app, &peer).await?;
            fresh.get_artifact(path.clone()).await.map_err(RemoteGetError::from)?
        }
        Err(e) => return Err(e.into()),
    };
    // A live session means the endpoint is already up — `session` booted it
    // (or reused the boot that opened the cached one), and the node is never
    // torn down.
    let state = app.state::<RemoteState>();
    let node = state
        .existing()
        .await
        .ok_or_else(|| RemoteGetError::denied("the remote endpoint is gone".to_string()))?;
    let addr = endpoint::addr_for(&peer).map_err(RemoteGetError::denied)?;
    // The cache filename carries the source extension: the local reader
    // dispatches raster images by extension and never sniffs bytes, so a
    // bare hash would lose image rendering entirely.
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let cached = scope::fetch_into_cache(&node, addr, &meta.hash, &ext, &dirs().cache())
        .await
        .map_err(RemoteGetError::denied)?;
    Ok(RemoteArtifact {
        peer,
        remote_path: path,
        path: cached.to_string_lossy().into_owned(),
        hash: meta.hash,
        size: meta.size,
        mtime: meta.mtime,
        warn: meta.warn,
    })
}

/// Reconcile the comments on a pulled tab with the host's store, both ways.
///
/// One idempotent pass: read the host's page, `annotations::reconcile` it
/// under the tab's store (`source`, the `skypie-remote://` address the rail
/// reads — passed through rather than rebuilt here so the key is the same
/// bytes the UI uses), then push what the host lacks under the host's
/// `path`. The reader calls it on open, on a timer while the window is
/// visible and this tab is the active one, on a focus or visibility wake,
/// and after every local write — see `src/state/remote-comment-sync.ts` for
/// the policy. Both halves are a union by id, so a comment written while the
/// host was unreachable goes out on the first pass that reaches it. No
/// outbox.
#[tauri::command]
pub async fn remote_sync_annotations(
    app: tauri::AppHandle,
    peer: String,
    path: String,
    source: String,
) -> Result<(), RemoteGetError> {
    let session = session_inner(&app, &peer).await?;
    // Bind the session that answered, so the push rides it too.
    let (session, page) = match session.get_annotations(path.clone()).await {
        Ok(page) => (session, page),
        // Same repair as `remote_get`: a cached session that died under the
        // request is forgotten and dialed once more.
        Err(scope::GetFailure::Closed) => {
            forget_session(&app, &peer, &session).await;
            let fresh = session_inner(&app, &peer).await?;
            let page = fresh.get_annotations(path.clone()).await.map_err(RemoteGetError::from)?;
            (fresh, page)
        }
        Err(e) => return Err(e.into()),
    };

    // The store half is disk work under `STORE_LOCK`, and this runtime also
    // hosts the endpoint and the scope server — off the worker, as the host
    // side does for the same store (`scope::blocking`).
    let state_dir = crate::state_store::state_dir();
    let key = source.clone();
    let complete = !page.truncated;
    let outcome = tokio::task::spawn_blocking(move || {
        crate::annotations::reconcile(&state_dir, &key, &page.entries, complete)
    })
    .await
    .map_err(|e| RemoteGetError::denied(format!("the reconcile task failed: {e}")))?;

    // On `Err` as well as on a pull: `merge` appends before it reindexes, so
    // a failure may have landed lines the rail should show.
    if outcome.as_ref().map_or(true, |r| r.pulled > 0) {
        crate::annotations_api::notify(&app, &source);
    }
    let outcome = outcome.map_err(RemoteGetError::denied)?;

    if !outcome.outgoing.is_empty() {
        session.put_annotations(path, outcome.outgoing).await.map_err(RemoteGetError::from)?;
    }
    Ok(())
}

// ═══ Status for the local socket ════════════════════════════════════════════

// Only the macOS socket server (`ipc_server.rs`) calls this.
#[cfg(target_os = "macos")]
pub(crate) fn offer_summary(o: &beam::OfferInfo) -> OfferSummary {
    OfferSummary {
        name: o.name.clone(),
        size: o.size,
        link: o.link.clone(),
        expires_at: o.expires_at,
        fetches: o.fetches,
        hash: o.id.clone(),
    }
}

// Only the macOS socket server (`ipc_server.rs`) calls this.
#[cfg(target_os = "macos")]
/// The paired devices, each with its presence. `probe` dials every device
/// at once (bounded by `PROBE_TIMEOUT`); without it a device is `online`
/// only when this app already holds a live session with it, and `unknown`
/// otherwise — nothing is dialed.
pub(crate) async fn list_devices_for(app: &tauri::AppHandle, probe: bool) -> Vec<DeviceInfo> {
    let state = app.state::<RemoteState>();
    let peers = state.peers.list();
    let live: Vec<String> = {
        let sessions = state.sessions.lock().await;
        peers
            .iter()
            .filter(|p| sessions.get(&p.node_id).is_some_and(|s| !s.is_closed()))
            .map(|p| p.node_id.clone())
            .collect()
    };

    let mut probes = tokio::task::JoinSet::new();
    if probe {
        for peer in peers.iter().filter(|p| !live.contains(&p.node_id)) {
            let app = app.clone();
            let node_id = peer.node_id.clone();
            probes.spawn(async move {
                let outcome =
                    tokio::time::timeout(PROBE_TIMEOUT, session_inner(&app, &node_id)).await;
                let presence = match outcome {
                    Ok(Ok(_)) => Presence::Online,
                    Ok(Err(ConnectError::Unpaired(_))) => Presence::Unpaired,
                    Ok(Err(ConnectError::Refused(_))) => Presence::Refused,
                    Ok(Err(ConnectError::Unreachable(_))) | Err(_) => Presence::Offline,
                    // This side never dialed: nothing about the device is known.
                    Ok(Err(ConnectError::Local(_))) => Presence::Unknown,
                };
                (node_id, presence)
            });
        }
    }
    let mut probed: HashMap<String, Presence> = HashMap::new();
    while let Some(done) = probes.join_next().await {
        match done {
            Ok((node_id, presence)) => {
                probed.insert(node_id, presence);
            }
            // A probe that panicked reads as `unknown` below — say so, or it
            // is indistinguishable from a device nobody dialed.
            Err(e) => eprintln!("skypie: remote: probe task failed: {e}"),
        }
    }

    peers
        .into_iter()
        .map(|p| {
            let presence = if live.contains(&p.node_id) {
                Presence::Online
            } else {
                probed.get(&p.node_id).copied().unwrap_or(Presence::Unknown)
            };
            DeviceInfo {
                node_id_short: peers::short_id(&p.node_id),
                node_id: p.node_id,
                device: p.device,
                paired_at: p.paired_at,
                last_seen: p.last_seen,
                presence,
            }
        })
        .collect()
}

// Only the macOS socket server (`ipc_server.rs`) calls this.
#[cfg(target_os = "macos")]
pub(crate) async fn status_for(app: &tauri::AppHandle) -> AppStatus {
    let state = app.state::<RemoteState>();
    let node = state.existing().await;
    let boot_error = state.last_boot_error.lock().unwrap_or_else(|p| p.into_inner()).clone();
    AppStatus {
        ipc_proto: skypie_ipc::IPC_PROTO,
        app_version: app.package_info().version.to_string(),
        node_id: node
            .as_ref()
            .map(|n| n.endpoint.id().to_string())
            .or_else(|| state.self_id.clone())
            .unwrap_or_default(),
        device: state.device.clone(),
        state_dir: crate::state_store::state_dir(),
        booted: node.is_some(),
        boot_error,
        uptime_secs: state.started.elapsed().as_secs(),
        paired_devices: state.peers.len(),
        active_offers: node.map(|n| n.offers.list().iter().map(offer_summary).collect()).unwrap_or_default(),
    }
}

// ── Plumbing shared by the commands ────────────────────────────────────────

async fn boot_node(app: &tauri::AppHandle) -> Result<Arc<endpoint::RemoteNode>, String> {
    let state = app.state::<RemoteState>();
    let offers_app = app.clone();
    let sink_app = app.clone();
    let shared_store = state.shared.clone();
    state
        .node(
            // Cold path only: `node` calls this exactly when it is about to
            // boot, so a command that finds the endpoint already up never
            // builds a `ScopeState` it would immediately drop.
            || {
                Arc::new(
                    scope::ScopeState::new(
                        state.peers.clone(),
                        state.pairing.clone(),
                        state.device.clone(),
                        host_signal_sink(sink_app.clone()),
                    )
                    .with_annotations(HostAnnotations { app: sink_app })
                    .with_shared(HostShared { store: shared_store }),
                )
            },
            move |offers| {
                let _ = offers_app.emit("skypie://beam-offers-updated", offers);
            },
        )
        .await
}

/// The app's `AnnotationStore` — how a paired peer reaches the comment store.
///
/// The seam exists because `skypie-remote` is the transport and knows nothing
/// of the annotation schema; this is the one place the two meet. Both methods
/// receive a path the scope gate already canonicalized and proved is a
/// regular file, so neither re-checks it.
struct HostAnnotations {
    app: tauri::AppHandle,
}

/// The app's `SharedStore` — how a paired peer reads what this Mac has
/// offered it. Same seam as `HostAnnotations`: the transport crate owns no
/// storage, so the app hands it a reader.
///
/// Read-only by construction. There is no write half of this trait, because
/// a peer learning what was offered must never be able to change it.
struct HostShared {
    store: Arc<crate::shared_offers::OfferStore>,
}

impl scope::SharedStore for HostShared {
    // `node_id` is unread: one list serves every paired device. The trait
    // keeps the parameter because the connection-proven id is the right thing
    // for the transport to pass, and it is the seam an addressed share would
    // land on if one ever arrives.
    fn list_for(&self, _node_id: &str) -> Vec<skypie_remote::proto::SharedEntry> {
        self.store.list()
    }
}

impl scope::AnnotationStore for HostAnnotations {
    fn get(&self, path: &Path) -> Vec<String> {
        // The lines as stored, not the fold: a folded view would carry a
        // status the reader's `merge` skips (the root id is known) and the
        // `assessing` line that changed it would never cross.
        crate::annotations::raw_lines(&crate::state_store::state_dir(), &path.to_string_lossy())
    }

    fn put(&self, path: &Path, entries: &[String]) -> Result<usize, String> {
        let source = path.to_string_lossy().into_owned();

        // Parse before storing. The transport carries opaque strings on
        // purpose, so THIS is the boundary where a peer's bytes become
        // annotations — an entry that does not parse is dropped rather than
        // appended, or the next local read would skip it forever as a
        // corrupt line.
        // ALL of them, or none. `filter_map(...ok())` here would silently drop
        // the entries this build cannot decode and still report success for
        // the rest — a peer sending 50 comments would be told 12 landed with
        // no hint that 38 vanished, which also defeats the all-or-nothing
        // guarantee `merge` goes out of its way to provide one layer down.
        let mut parsed: Vec<crate::annotations::Annotation> = Vec::with_capacity(entries.len());
        for (n, raw) in entries.iter().enumerate() {
            parsed.push(serde_json::from_str(raw).map_err(|e| {
                format!("comment {} of {} is not readable: {e}", n + 1, entries.len())
            })?);
        }
        if parsed.is_empty() {
            return Err("no comments in the message".to_string());
        }

        // `merge` is a union by id, and every entry lands in `source` — the
        // gated path, never a path the entry claims — so a peer can neither
        // overwrite an existing comment nor scatter comments across files
        // the user never opened.
        let added =
            crate::annotations::merge(&crate::state_store::state_dir(), &source, &parsed)?;

        if added > 0 {
            // A comment pushed from the phone appears on the Mac without a
            // refresh — which is the whole point of the feature.
            crate::annotations_api::notify(&self.app, &source);
        }
        Ok(added)
    }
}

/// Turn host-side signals into the webview events they belong to. This is the
/// app's `EventSink` — the only place Tauri meets the scope server.
fn host_signal_sink(app: tauri::AppHandle) -> impl Fn(HostSignal) + Send + Sync + 'static {
    move |signal| match signal {
        HostSignal::PairPending(pending) => park_and_announce(&app, pending),
    }
}

/// Park a pairing at the fingerprint step and tell the UI about it. BOTH faces
/// of pairing land here — the outbound `remote_pair_complete` and the inbound
/// `HostSignal::PairPending` — so the order is the same on either side: park
/// first, because `remote_pair_confirm` resolves against the parked entry, and
/// only then emit the prompt that makes a human call it.
fn park_and_announce(app: &tauri::AppHandle, pending: PendingPair) {
    app.state::<RemoteState>().pairing.park(pending.clone());
    let _ = app.emit(
        "skypie://remote-event",
        RemoteEvent::PairPending {
            peer: pending.node_id.clone(),
            device: pending.device.clone(),
            fingerprint: pending.fingerprint.clone(),
            role: pending.role.clone(),
        },
    );
    // Debug-only E2E hook: a simulator has no screen to tap "Confirm" on, so
    // both faces honor SKYPIE_TEST_AUTOPAIR. Absent from release builds — see
    // the banner below.
    #[cfg(debug_assertions)]
    test_autopair(app, &pending);
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  TEST-ONLY AUTOPAIR HOOK — NOT PRESENT IN RELEASE BUILDS  ██
// ═════════════════════════════════════════════════════════════════════════════
//
// WHAT THIS DOES: it answers the six-word fingerprint prompt FOR the human.
// A stranger who dials this instance becomes a trusted peer with no screen
// to compare and nobody to compare it. That is the whole point of the
// pairing step, so this MUST NOT reach a shipped binary.
//
// WHY IT EXISTS: the iOS simulator E2E runs headless. The simulator instance
// mints a pairing ticket, the driver machine dials it, and the inbound
// `HostSignal::PairPending` lands on the simulator — where no test driver
// can tap "Confirm". This hook resolves that one parked pairing.
//
// TWO INDEPENDENT GATES, BOTH REQUIRED:
//   1. `#[cfg(debug_assertions)]` — a compile-time gate, so a release build
//      does not contain this function, its call site, or the env-var read.
//   2. `SKYPIE_TEST_AUTOPAIR` — the env var must be present in the process
//      environment (any value). Unset, the hook does nothing at all.

/// The env var name, declared ONCE. Both hooks below and the deep-link gate in
/// `app.rs` (through `autopair_enabled`) read this const.
#[cfg(debug_assertions)]
const AUTOPAIR_ENV: &str = "SKYPIE_TEST_AUTOPAIR";

/// Is the hook armed? The deep-link arm in `app.rs` asks before it dials an
/// arriving `skypie://pair` link with no human in the loop.
#[cfg(debug_assertions)]
pub fn autopair_enabled() -> bool {
    std::env::var(AUTOPAIR_ENV).is_ok()
}

#[cfg(debug_assertions)]
fn test_autopair(app: &tauri::AppHandle, pending: &PendingPair) {
    if !autopair_enabled() {
        return;
    }
    let state = app.state::<RemoteState>();
    // Take the entry the caller just parked. `take` is what
    // `remote_pair_confirm` does, so the two paths cannot both resolve the
    // same pairing.
    let Some(parked) = state.pairing.take(&pending.node_id) else {
        return;
    };
    match state.peers.confirm(&parked.node_id, &parked.device) {
        Ok(_) => {
            eprintln!(
                "skypie: {AUTOPAIR_ENV}: AUTO-CONFIRMED {} ({}) — TEST BUILD ONLY",
                parked.device, parked.node_id
            );
            let _ = app.emit("skypie://remote-event", RemoteEvent::PeersUpdated);
        }
        Err(e) => eprintln!("skypie: {AUTOPAIR_ENV}: cannot persist the peer: {e}"),
    }
}

// Debug-only E2E hook, third arm: a `skypie://pair` link arrived and no human
// can tap the confirm UI (simulator). Dial + park + `test_autopair` — the same
// steps `remote_pair_complete` then a confirm tap would take.
#[cfg(debug_assertions)]
pub fn test_autopair_dial(app: tauri::AppHandle, ticket: String) {
    tauri::async_runtime::spawn(async move {
        let parsed: peers::PairTicket = match ticket.parse() {
            Ok(t) => t,
            Err(e) => return eprintln!("skypie: {AUTOPAIR_ENV}: bad ticket: {e}"),
        };
        let node = match boot_node(&app).await {
            Ok(n) => n,
            Err(e) => return eprintln!("skypie: {AUTOPAIR_ENV}: boot failed: {e}"),
        };
        let state = app.state::<RemoteState>();
        let pending = match scope::pair_dial(&node, &parsed, state.device.clone()).await {
            Ok(p) => p,
            Err(e) => return eprintln!("skypie: {AUTOPAIR_ENV}: dial failed: {e}"),
        };
        state.pairing.park(pending.clone());
        test_autopair(&app, &pending);
    });
}

/// Get a live session with a paired peer, dialing on first use. The
/// string-error face of `session_inner`, for the commands.
async fn session(app: &tauri::AppHandle, peer: &str) -> Result<Arc<scope::ClientSession>, String> {
    session_inner(app, peer).await.map_err(|e| e.to_string())
}

/// Why a pull failed, typed for the tab that shows it. The webview decides
/// between "pair it" and "wait for it" on `cause`, never on the sentence.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteGetError {
    /// "unpaired" | "unreachable" | "refused" | "local" | "denied".
    pub cause: &'static str,
    pub reason: String,
}

impl From<ConnectError> for RemoteGetError {
    fn from(e: ConnectError) -> Self {
        let cause = match e {
            ConnectError::Unreachable(_) => "unreachable",
            ConnectError::Refused(_) => "refused",
            ConnectError::Unpaired(_) => "unpaired",
            ConnectError::Local(_) => "local",
        };
        RemoteGetError { cause, reason: e.to_string() }
    }
}

impl RemoteGetError {
    /// The host answered and refused this one file, or the fetch itself
    /// failed after a session was up: nothing to pair, nothing to wake.
    fn denied(reason: String) -> Self {
        RemoteGetError { cause: "denied", reason }
    }
}

impl From<scope::GetFailure> for RemoteGetError {
    fn from(e: scope::GetFailure) -> Self {
        match e {
            // The session went away under the request: the peer is gone,
            // not refusing, so the reader is told to try again.
            scope::GetFailure::Closed => ConnectError::Unreachable(e.to_string()).into(),
            scope::GetFailure::Denied(reason) => RemoteGetError::denied(reason),
        }
    }
}

/// `session`, keeping the cause typed: the presence probe sorts devices by
/// it. Presence transitions are emitted here, so every entry point drives
/// the Devices pane the same way.
async fn session_inner(
    app: &tauri::AppHandle,
    peer: &str,
) -> Result<Arc<scope::ClientSession>, ConnectError> {
    let state = app.state::<RemoteState>();
    // Only paired peers are dialable — the allowlist is symmetric.
    if state.peers.get(peer).is_none() {
        return Err(local_failure(app, peer, "not a paired device".to_string()));
    }
    // Held across the whole dial, so ONE peer is dialed once. Per peer and
    // not per process because a dial to a device that does not answer costs
    // the whole connect timeout, and a probe dials every device at once.
    let gate = state.dial_gate(peer).await;
    let _dialing = gate.lock().await;

    // Re-read now that this call owns the gate: the dial it queued behind may
    // have landed the very session it was about to make. The generation is
    // read under the same lock the foreground hop clears the map with.
    let generation = {
        let sessions = state.sessions.lock().await;
        if let Some(existing) = sessions.get(peer) {
            if !existing.is_closed() {
                return Ok(existing.clone());
            }
        }
        state.session_generation.load(Ordering::Acquire)
    };

    let node = boot_node(app).await.map_err(|e| local_failure(app, peer, e))?;
    let addr = endpoint::addr_for(peer).map_err(|e| local_failure(app, peer, e))?;
    presence(app, peer, "connecting", None, None);

    let closed_app = app.clone();
    let closed_peer = peer.to_string();
    let session = scope::ClientSession::connect(&node, addr, state.device.clone(), move || {
        // The generation this callback speaks for is fixed at dial time; the
        // one it is compared against is read now, because a resume may have
        // happened at any point in between. Equality, not "at least as new":
        // every generation but the current one is a round this app has
        // finished with.
        let current = closed_app.state::<RemoteState>().session_generation.load(Ordering::Acquire);
        if generation != current {
            return;
        }
        presence(&closed_app, &closed_peer, "offline", None, None);
    })
    .await
    .inspect_err(|e| presence(app, peer, "offline", None, Some(e.to_string())))?;

    presence(app, peer, "online", Some(session.device.clone()), None);
    // The map is for REUSE, and two things can have made this session
    // unreusable while the dial was in flight: a resume emptied the map and
    // bumped the generation under this same lock, or `forget_device_for`
    // deleted the peer. The caller still receives the session it asked for
    // in both cases.
    {
        let mut sessions = state.sessions.lock().await;
        let same_round = state.session_generation.load(Ordering::Acquire) == generation;
        if same_round && state.peers.get(peer).is_some() {
            sessions.insert(peer.to_string(), session.clone());
        }
    }
    Ok(session)
}

/// Drop a cached session that turned out to be dead, so the next
/// `session_inner` dials instead of handing it out again. Guarded on
/// identity: a concurrent dial may already have replaced it.
async fn forget_session(app: &tauri::AppHandle, peer: &str, dead: &Arc<scope::ClientSession>) {
    let state = app.state::<RemoteState>();
    let mut sessions = state.sessions.lock().await;
    if sessions.get(peer).is_some_and(|s| Arc::ptr_eq(s, dead)) {
        sessions.remove(peer);
    }
}

/// A dial that never left this machine. Reported as presence too: without
/// it, "Check who's online" could fail for every device and leave every dot
/// as it was — the frontend only learns presence from these events.
fn local_failure(app: &tauri::AppHandle, peer: &str, reason: String) -> ConnectError {
    presence(app, peer, "offline", None, Some(reason.clone()));
    ConnectError::Local(reason)
}

fn presence(
    app: &tauri::AppHandle,
    peer: &str,
    state: &'static str,
    device: Option<String>,
    reason: Option<String>,
) {
    let _ = app.emit(
        "skypie://remote-presence",
        PresenceEvent { peer: peer.to_string(), state, device, reason },
    );
}

/// Does launch open a listening socket? Pure, because it decides whether an
/// install binds a socket before the user has asked for anything.
///
/// `paired` gates it, so a fresh install with no peers binds nothing at all.
/// `listen_pref` is the user's own switch (on by default), obeyed on every
/// platform.
fn listens_at_launch(paired: bool, listen_pref: bool) -> bool {
    paired && listen_pref
}

/// The launch-time half of the lazy-boot rule: boot the endpoint at startup
/// only when `listens_at_launch` says so. Every other path stays
/// zero-sockets until an action needs one.
pub fn listen_at_launch(app: &tauri::AppHandle) {
    let paired = !app.state::<RemoteState>().peers.is_empty();
    let prefs = crate::state_store::current_state().preferences;
    if !listens_at_launch(paired, prefs.remote_listen) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = boot_node(&app).await {
            eprintln!("skypie: remote: cannot start listening: {e}");
        }
    });
}

/// iOS brought the app back to the foreground. Everything here is recovery
/// from a suspension the process itself never saw: iOS freezes the app, the
/// peer's idle timer tears the QUIC connections down, and NOTHING in this
/// process learns of it — `ClientSession::is_closed` reads a cached
/// `AtomicBool` that the reader task can only set once it is running again.
/// So every cached session is dropped: the next pull dials afresh.
///
/// Called from the `RunEvent::WindowEvent { event: Resumed }` arm in app.rs,
/// which is mobile-only. macOS never suspends the process.
pub fn on_foreground(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<RemoteState>();
        {
            let mut sessions = state.sessions.lock().await;
            sessions.clear();
            // Under the same lock, so the bump and the clear are one act to
            // every dial. ADD, never assign: a counter that came back around
            // would let a session dropped two resumes ago pass the equality
            // check in `on_closed`.
            state.session_generation.fetch_add(1, Ordering::Release);
        }
        let _ = app.emit("skypie://remote-event", RemoteEvent::Resumed);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_listens_for_exactly_one_of_the_four_states_it_can_be_in() {
        assert!(listens_at_launch(true, true));
        // The switch is obeyed.
        assert!(!listens_at_launch(true, false));
        // The zero-sockets promise a fresh install makes: nothing may dial an
        // app that trusts nobody, so listening buys nothing.
        assert!(!listens_at_launch(false, true));
        assert!(!listens_at_launch(false, false));
    }

    #[test]
    fn the_event_kinds_are_the_names_the_webview_switches_on() {
        // `RemoteEvent` is serialized straight onto `skypie://remote-event`,
        // and the frontend dispatches on `kind`. A rename here is a silent
        // no-op there, not a compile error.
        assert_eq!(
            serde_json::to_value(RemoteEvent::Resumed).expect("serialize"),
            serde_json::json!({ "kind": "resumed" })
        );
        let open = RemoteEvent::OpenRemote {
            peer: "ab".into(),
            device: "Mac".into(),
            path: "/w/a.html".into(),
            line: Some(3),
            intent: crate::DeepLinkIntentKind::Open,
        };
        assert_eq!(
            serde_json::to_value(open).expect("serialize"),
            serde_json::json!({
                "kind": "open-remote", "peer": "ab", "device": "Mac",
                "path": "/w/a.html", "line": 3, "intent": "open"
            })
        );
    }

    #[tokio::test]
    async fn one_peers_dial_gate_never_blocks_a_dial_to_another_device() {
        crate::state_store::ensure_shared_test_state_dir();
        let state = RemoteState::new();

        let phone = state.dial_gate("device-a").await;
        let phone_again = state.dial_gate("device-a").await;
        assert!(Arc::ptr_eq(&phone, &phone_again), "the same peer id names the same gate");

        let laptop = state.dial_gate("device-b").await;
        assert!(!Arc::ptr_eq(&phone, &laptop), "another device gets its own gate");

        let dialing_phone = phone.lock().await;
        assert!(laptop.try_lock().is_ok(), "the laptop is dialed while the phone is dialing");
        assert!(phone.try_lock().is_err(), "and the phone is still dialed once");
        drop(dialing_phone);
    }

    #[test]
    fn each_connect_failure_keeps_the_cause_word_the_reader_switches_on() {
        // The five words are a contract with `src/utils/read-error.ts`.
        for (e, cause) in [
            (ConnectError::Unreachable("x".into()), "unreachable"),
            (ConnectError::Refused("x".into()), "refused"),
            (ConnectError::Unpaired("x".into()), "unpaired"),
            (ConnectError::Local("x".into()), "local"),
        ] {
            let mapped = RemoteGetError::from(e.clone());
            assert_eq!(mapped.cause, cause);
            assert_eq!(mapped.reason, e.to_string());
        }
        assert_eq!(RemoteGetError::denied("no".into()).cause, "denied");
        // A session that dies under the request is the peer being gone, not
        // the peer refusing.
        assert_eq!(RemoteGetError::from(scope::GetFailure::Closed).cause, "unreachable");
        assert_eq!(RemoteGetError::from(scope::GetFailure::Denied("x".into())).cause, "denied");
    }

    #[test]
    fn the_install_identity_is_readable_without_a_socket() {
        crate::state_store::ensure_shared_test_state_dir();
        let state = RemoteState::new();
        let id = state.self_id().expect("identity created on first read");
        assert_eq!(id.len(), 64, "a NodeId is 32 bytes of hex");
        // Stable across constructions: the key file is what answers.
        assert_eq!(RemoteState::new().self_id(), Some(id));
    }
}
