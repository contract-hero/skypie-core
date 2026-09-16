// Scope — the paired-device session: server (this machine serves a file a
// paired device asked for) and client (this machine pulls a file from a
// paired device).
//
// Trust is single-tier. A paired device is one of the user's OWN devices, so
// the host order of checks, per request, is:
//   1. allowlist — the connection's NodeId must be in peers.json, or the
//      handshake is refused before a single request byte is parsed;
//   2. the path names an existing regular file (`gate_readable`);
//      `GetArtifact` adds the transfer size cap on top, because that rule is
//      about bytes on the wire rather than about reachability.
//
// Refusals all carry the share module's no-existence-leak wording: a peer
// cannot tell a missing file from a refused one.
//
// Metadata rides this stream; artifact BYTES ride the existing iroh-blobs
// protocol, content-addressed and verified there. `GetArtifact` stages the
// file into the same store Beam uses and records a peer-locked grant that the
// blobs request gate consults.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::endpoint::{Connection, ConnectionError, RecvStream, SendStream, VarInt};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{EndpointAddr, EndpointId};
use iroh_blobs::api::Tag;
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::Hash;
use tokio::sync::{mpsc, oneshot};

use crate::beam::{delete_tags, parse_hash};
use crate::endpoint::{self, RemoteNode};
use crate::paths::mtime_secs;
use crate::peers::{self, now_unix, PeerStore, Pairing, PendingPair};
use crate::proto::{self, ArtifactMeta, HelloAck, PairAck, PairHello, Req, Res};

/// The host seams live in `host.rs` — re-exported here because they are part
/// of this module's contract: a host implements them to serve a session.
pub use crate::host::{EventSink, HostSignal};

/// The one refusal string. Same wording as the share module: a peer learns
/// nothing about what exists from a denial.
pub const DENIED: &str = "path not found or out of root";

/// Run synchronous filesystem work off the runtime worker.
///
/// A join failure means the closure panicked. That is this machine's bug, not
/// a judgement about the peer, so it becomes the same opaque `DENIED` every
/// other refusal uses rather than leaking a panic message onto the wire.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(result) => result,
        Err(e) => {
            eprintln!("skypie: scope: blocking task failed: {e}");
            Err(DENIED.to_string())
        }
    }
}

/// Concurrent sessions one peer may hold. Bounds a paired-but-misbehaving
/// machine (design §7, "resource exhaustion").
pub const MAX_SESSIONS_PER_PEER: usize = 4;

/// How long a staged artifact stays fetchable by the peer that asked for it.
/// Long enough to fetch and refetch, short enough that a closed session's
/// bytes stop being reachable.
pub const GRANT_TTL_SECS: u64 = 3600;

/// Handshake timeout. A peer that opens a connection and says nothing must
/// not hold a session slot forever. The dial half lives in
/// `endpoint::DIAL_TIMEOUT`, shared with Beam.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// QUIC close code for a refused session. The value is arbitrary; the peer
/// only needs to see that it was refused, not why.
const CLOSE_REFUSED: u32 = 1;

/// QUIC close code for the ONE refusal a dialer may act on destructively:
/// this node is not on the allowlist, so that device has unpaired it.
///
/// Its own code because the reason TEXT cannot carry this. `CLOSE_REFUSED`
/// covers a protocol skew, an unexpected frame and the session cap as well,
/// and a caller that read those as "they removed you" would offer to delete a
/// working pairing over a version number. The text is another machine's; the
/// code is the protocol's.
const CLOSE_NOT_PAIRED: u32 = 2;

/// Display cap on a close reason a peer wrote. Every reason this crate sends
/// is three or four words; the bound is here because the bytes belong to
/// another machine, and they end up in a sentence a human reads.
const MAX_CLOSE_REASON_CHARS: usize = 100;

/// Subject of every failed dial this module makes — a session, a pairing
/// handshake, a cache fetch. `endpoint::dial` appends the cause, and a
/// timeout reads the same as a refusal because both mean the same thing to
/// the person looking at the screen.
const PEER_OFFLINE: &str = "peer offline — could not reach it";

// ── Grants: peer-locked blob capabilities ──────────────────────────────────

struct Grant {
    /// Peers allowed to fetch this hash, each with the moment ITS OWN
    /// capability lapses. A grant is NOT a beam ticket: possession of the
    /// hash is not enough, the fetching NodeId must be one that asked for the
    /// artifact through a session.
    peers: HashMap<EndpointId, u64>,
    /// The staging tag this grant owns — the collector root that keeps the
    /// bytes on disk while any peer may still fetch them.
    tag: Tag,
}

impl Grant {
    fn new(peer: EndpointId, tag: Tag) -> Self {
        Grant { peers: HashMap::from([(peer, now_unix() + GRANT_TTL_SECS)]), tag }
    }

    /// Let one more peer fetch these bytes, and restart that peer's clock — a
    /// peer that just asked is about to fetch. Every other peer on this hash
    /// keeps the expiry it earned, so one peer's traffic cannot extend
    /// another's capability.
    fn admit(&mut self, peer: EndpointId) {
        self.peers.insert(peer, now_unix() + GRANT_TTL_SECS);
    }

    /// May this peer still fetch? Unknown and lapsed answer the same.
    fn admits(&self, peer: &EndpointId, now: u64) -> bool {
        self.peers.get(peer).is_some_and(|expires_at| *expires_at > now)
    }

    /// Drop the peers whose hour ran out, and report whether anybody is left.
    /// A grant survives while ONE peer still holds it: dropping the whole
    /// entry on the first lapse would take the pin with it and free bytes a
    /// live peer is still allowed to fetch.
    fn retain_live(&mut self, now: u64) -> bool {
        self.peers.retain(|_, expires_at| *expires_at > now);
        !self.peers.is_empty()
    }
}

/// Blob capabilities minted by `GetArtifact`, consulted by the blobs request
/// gate beside the Beam offers registry.
#[derive(Default)]
pub struct Grants {
    inner: Mutex<HashMap<Hash, Grant>>,
}

// Hand-written: the router requires `Debug` on a protocol handler, and a
// grant's contents (which peer may fetch what) are not log material.
impl std::fmt::Debug for Grants {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grants").finish_non_exhaustive()
    }
}

impl Grants {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record (or refresh) a grant. Returns a tag the caller must delete: the
    /// redundant staging tag when this content was already staged — leaving
    /// it would pin a second copy of the bytes that nothing can reach.
    fn insert(&self, hash: Hash, peer: EndpointId, tag: Tag) -> Option<Tag> {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match map.get_mut(&hash) {
            Some(existing) => {
                existing.admit(peer);
                Some(tag)
            }
            None => {
                map.insert(hash, Grant::new(peer, tag));
                None
            }
        }
    }

    /// The gate's question: may this connection fetch this hash? Unknown,
    /// expired and wrong-peer all answer the same `false`.
    pub fn admit(&self, hash: &Hash, peer: Option<EndpointId>, is_blob_request: bool) -> bool {
        if !is_blob_request {
            return false;
        }
        let Some(peer) = peer else { return false };
        let map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match map.get(hash) {
            Some(grant) => grant.admits(&peer, now_unix()),
            None => false,
        }
    }

    /// Drop expired grants, returning the staging tags they owned for cleanup.
    /// An entry goes only when its LAST peer lapses, because the tag it owns
    /// is what keeps the bytes on disk for the peers still inside their hour.
    fn take_expired(&self, now: u64) -> Vec<Tag> {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut expired = Vec::new();
        map.retain(|_, grant| {
            if grant.retain_live(now) {
                return true;
            }
            expired.push(grant.tag.clone());
            false
        });
        expired
    }

    /// Revoke every grant held by one peer — what unpairing must do to bytes
    /// already staged for it. Returns the tags of grants nobody holds anymore.
    fn revoke_peer(&self, peer: &EndpointId) -> Vec<Tag> {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut orphaned = Vec::new();
        map.retain(|_, grant| {
            grant.peers.remove(peer);
            if grant.peers.is_empty() {
                orphaned.push(grant.tag.clone());
                false
            } else {
                true
            }
        });
        orphaned
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).len()
    }
}

// ── Host state ─────────────────────────────────────────────────────────────

/// The host's comment store, as the wire needs it.
///
/// A seam rather than a direct call, for the same reason `EventSink` and
/// `Dirs` are seams: the annotation schema lives in the app, this crate is
/// the transport, and the dependency runs app → crate. The app implements
/// this over `annotations.rs`; a test implements it over a `Vec`.
///
/// Both methods take the host's OWN absolute path. The gate has already
/// canonicalized it and proved it is a regular file the peer may reach, so an
/// implementation never re-checks the path — it only keys its store.
pub trait AnnotationStore: Send + Sync + 'static {
    /// Every stored entry for `path`, one JSON object per string — UNFOLDED.
    /// A status change is its own entry with its own id, and a folded view
    /// would never let a reader learn of it: its `merge` skips the root id
    /// it already holds.
    fn get(&self, path: &Path) -> Vec<String>;
    /// Merge `entries`, ignoring ids already present. Returns how many were
    /// new. `Err` is a host-side failure, never a judgement about the peer.
    fn put(&self, path: &Path, entries: &[String]) -> Result<usize, String>;
}

/// The default: a host that serves no annotations.
///
/// A READ serves an empty page rather than a refusal: a build without a
/// comment store is a perfectly good reader, and its peers should see "no
/// comments" rather than a denial they cannot interpret. A WRITE is refused,
/// because there is nowhere to put it.
#[derive(Debug, Default)]
pub struct NoAnnotations;

impl AnnotationStore for NoAnnotations {
    fn get(&self, _path: &Path) -> Vec<String> {
        Vec::new()
    }
    fn put(&self, _path: &Path, _entries: &[String]) -> Result<usize, String> {
        Err("this device does not accept comments".to_string())
    }
}

/// What the host has OFFERED each peer — the pull-side answer to "send a file
/// to my phone".
///
/// Same inversion as `AnnotationStore`: the transport does not own the
/// storage, and the dependency runs app -> crate.
///
/// This is a read-only view onto intent. The host records an offer when the
/// user shares a link for a device; the device lists it when it foregrounds
/// and fetches only when the user taps. Nothing here moves bytes, and nothing
/// here is a queue: an offer the peer never redeems simply stays listed.
pub trait SharedStore: Send + Sync + 'static {
    /// Newest-first offers for exactly this peer, by node id.
    ///
    /// A peer may only ever be asked about ITSELF — the caller passes the id
    /// the live connection proved — so an implementation never filters on
    /// behalf of the caller, it keys on what it is given.
    fn list_for(&self, node_id: &str) -> Vec<proto::SharedEntry>;
}

/// The default: a host that offers nothing.
///
/// An empty list, never a refusal — same reasoning as `NoAnnotations` on the
/// read path. A build without a share store is a working reader whose peers
/// should see "nothing waiting", not a denial they cannot interpret.
#[derive(Debug, Default)]
pub struct NoShared;

impl SharedStore for NoShared {
    fn list_for(&self, _node_id: &str) -> Vec<proto::SharedEntry> {
        Vec::new()
    }
}

/// Everything the host side needs that exists before the endpoint boots. Held
/// by `RemoteState` so `remote_list_peers` works with zero sockets, and
/// handed to the router at boot.
pub struct ScopeState {
    pub peers: Arc<PeerStore>,
    pub pairing: Arc<Pairing>,
    pub device: String,
    sessions: Mutex<Vec<Session>>,
    next_session_id: AtomicU64,
    signal: Box<dyn EventSink>,
    annotations: Box<dyn AnnotationStore>,
    shared: Box<dyn SharedStore>,
}

impl std::fmt::Debug for ScopeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScopeState").field("device", &self.device).finish_non_exhaustive()
    }
}

struct Session {
    id: u64,
    peer: String,
    /// How to cut this session's TRANSPORT, not just its registration.
    ///
    /// Unregistering a revoked peer and re-reading the peer per request
    /// refuses its next request — but neither ends the QUIC connection, and a
    /// client that is not asking for anything sits there believing it still
    /// holds a session. A closure rather than the `Connection` itself, so the
    /// registry stays a plain value the unit tests can build without two live
    /// endpoints.
    cut: Arc<dyn Fn() + Send + Sync>,
}

impl ScopeState {
    pub fn new(
        peers: Arc<PeerStore>,
        pairing: Arc<Pairing>,
        device: String,
        signal: impl EventSink,
    ) -> Self {
        Self {
            peers,
            pairing,
            device,
            sessions: Mutex::new(Vec::new()),
            next_session_id: AtomicU64::new(1),
            signal: Box::new(signal),
            // A host serves no comments until one is wired in. See
            // `NoAnnotations`: an absent store is an empty page, not a
            // refusal the peer cannot interpret.
            annotations: Box::new(NoAnnotations),
            shared: Box::new(NoShared),
        }
    }

    /// Wire the host's shared-file list in. Builder-style so existing call
    /// sites — and every test that only cares about artifacts — stay
    /// unchanged.
    pub fn with_shared(mut self, store: impl SharedStore) -> Self {
        self.shared = Box::new(store);
        self
    }

    /// Wire the host's comment store in. Builder-style so existing call sites
    /// — and every test that only cares about artifacts — stay unchanged.
    pub fn with_annotations(mut self, store: impl AnnotationStore) -> Self {
        self.annotations = Box::new(store);
        self
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, Vec<Session>> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Register a session, refusing the peer past its concurrency cap.
    fn register(&self, session: Session) -> Result<u64, String> {
        let mut sessions = self.sessions();
        if sessions.iter().filter(|s| s.peer == session.peer).count() >= MAX_SESSIONS_PER_PEER {
            return Err("too many open sessions for this peer".to_string());
        }
        let id = session.id;
        sessions.push(session);
        Ok(id)
    }

    fn unregister(&self, id: u64) {
        self.sessions().retain(|s| s.id != id);
    }

    /// Drop every session held by a peer — what revocation does to sessions
    /// that were already open when the user unpaired. The connection goes
    /// with the registration, which is what makes the other side notice.
    fn drop_sessions_for(&self, node_id: &str) {
        // Collected under the lock and cut outside it: holding the registry
        // across another module's code is how a lock order gets invented by
        // accident.
        let revoked: Vec<Arc<dyn Fn() + Send + Sync>> = {
            let mut sessions = self.sessions();
            let cuts =
                sessions.iter().filter(|s| s.peer == node_id).map(|s| s.cut.clone()).collect();
            sessions.retain(|s| s.peer != node_id);
            cuts
        };
        for cut in revoked {
            cut();
        }
    }

    fn signal(&self, signal: HostSignal) {
        self.signal.emit(signal);
    }
}

/// The wire's input hardening, then the filesystem's answer: absolute path,
/// no NUL bytes (the deep-link parser's rules), then canonicalize. One
/// refusal string for every failure, so a peer cannot tell a missing file
/// from a malformed request.
///
/// No root set is consulted. A paired device is the user's own device, and a
/// link it follows names whatever file the user chose to share — the same
/// posture a local `skypie://open` link has.
fn gate_raw(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || !raw.starts_with('/') || raw.contains('\0') {
        return Err(DENIED.to_string());
    }
    Path::new(raw).canonicalize().map_err(|_| DENIED.to_string())
}

// ── Host: the scope protocol server ────────────────────────────────────────

/// The `skypie/scope/1` handler. Registered on the same Router as iroh-blobs,
/// so one endpoint serves both protocols (design §4).
#[derive(Debug, Clone)]
pub struct ScopeServer {
    pub state: Arc<ScopeState>,
    store: FsStore,
    grants: Arc<Grants>,
}

impl ScopeServer {
    pub fn new(state: Arc<ScopeState>, store: FsStore, grants: Arc<Grants>) -> Self {
        Self { state, store, grants }
    }

    /// Revoke a peer's grants and drop its sessions. Called on unpair.
    pub async fn revoke(&self, node_id: &str) {
        self.state.drop_sessions_for(node_id);
        if let Ok(id) = node_id.parse::<EndpointId>() {
            let orphaned = self.grants.revoke_peer(&id);
            delete_tags(&self.store, orphaned).await;
        }
    }

    async fn handle(&self, node_id: &str, peer_id: EndpointId, req: Req) -> Res {
        // Every refusal — path, size — is an `Err`, and this is the ONE place
        // it becomes the no-existence-leak `Denied` frame.
        match req {
            // A second Hello on a live session is a protocol error, not a
            // request; answer it as a refusal rather than re-handshaking.
            Req::Hello { .. } => Res::Denied("session already established".to_string()),
            Req::GetArtifact { path } => self
                .artifact(node_id, peer_id, &path)
                .await
                .map(Res::Artifact)
                .unwrap_or_else(Res::Denied),
            // Both annotation frames touch the filesystem synchronously — a
            // merge parses, then appends to, a store that can hold thousands of
            // lines. Run off the runtime worker, or one peer's review pass
            // stalls every other connection this node is serving.
            Req::GetAnnotations { path } => {
                let this = self.clone();
                blocking(move || this.read_annotations(&path))
                    .await
                    .map(Res::Annotations)
                    .unwrap_or_else(Res::Denied)
            }
            Req::PutAnnotations { path, entries } => {
                let this = self.clone();
                let node_id = node_id.to_string();
                blocking(move || this.write_annotations(&node_id, &path, &entries))
                    .await
                    .map(|added| Res::Merged { added })
                    .unwrap_or_else(Res::Denied)
            }
            // No gate and no path validation, because there is no path to
            // validate: the peer names nothing, and the answer is derived
            // entirely from what the HOST chose to offer this node id. The
            // paths it returns are re-gated when the peer fetches one.
            Req::ListShared => Res::Shared(self.shared_page(node_id)),
        }
    }

    /// The offers the host has made to one peer, newest first and capped.
    fn shared_page(&self, node_id: &str) -> proto::SharedPage {
        let mut entries = self.state.shared.list_for(node_id);
        let truncated = entries.len() > proto::MAX_SHARED_ENTRIES;
        if truncated {
            entries.truncate(proto::MAX_SHARED_ENTRIES);
        }
        proto::SharedPage { entries, truncated }
    }

    /// A peer reading the host's comments on one of the host's files.
    ///
    /// Goes through the SAME `gate_raw` + regular-file check as `artifact`:
    /// a path the peer may not read is also a path whose comments it may not
    /// read, and the refusal is the same no-existence-leak string, so the
    /// peer cannot probe the host's filesystem through this frame either.
    fn read_annotations(&self, raw: &str) -> Result<proto::AnnotationPage, String> {
        let (canonical, _) = self.gate_readable(raw)?;
        let mut entries = self.state.annotations.get(&canonical);
        let truncated = entries.len() > proto::MAX_ANNOTATION_ENTRIES;
        if truncated {
            entries.truncate(proto::MAX_ANNOTATION_ENTRIES);
        }
        Ok(proto::AnnotationPage { entries, truncated })
    }

    /// A peer appending comments to the host's store — the first write this
    /// wire has ever carried.
    ///
    /// Four things bound it, and the order matters. The connection already
    /// proved the peer is PAIRED. The peer list is re-read, because an unpair
    /// may have landed since the session opened. The path goes through the
    /// same gate as a read. The frame is size- and shape-checked before a
    /// byte reaches the store. What is still possible afterwards: a paired
    /// device adds comments the user will see. What is not: editing or
    /// deleting anything already there, or writing outside the state
    /// directory, both of which the append-only store forbids on its own.
    fn write_annotations(
        &self,
        node_id: &str,
        raw: &str,
        entries: &[String],
    ) -> Result<usize, String> {
        if self.state.peers.get(node_id).is_none() {
            return Err(DENIED.to_string());
        }
        proto::check_entries(entries)?;
        let (canonical, _) = self.gate_readable(raw)?;
        self.state
            .annotations
            .put(&canonical, entries)
            // A store failure is THIS machine's problem; the peer sees the
            // same opaque refusal as everything else.
            .inspect_err(|e| eprintln!("skypie: scope: cannot merge annotations: {e}"))
            .map_err(|_| DENIED.to_string())
    }

    /// THE path gate. Every frame that names a host file goes through here.
    ///
    /// Shared rather than repeated per frame on purpose: this decides what a
    /// paired peer may reach, and a later rule — a symlink refusal, a deny
    /// list, a state-directory restriction — must land once and cover every
    /// frame. Two copies is how one of them silently keeps the old rule.
    ///
    /// Returns the metadata too, so a caller with a size rule of its own does
    /// not `stat` the file a second time.
    fn gate_readable(&self, raw: &str) -> Result<(std::path::PathBuf, std::fs::Metadata), String> {
        let canonical = gate_raw(raw)?;
        let meta = std::fs::metadata(&canonical).map_err(|_| DENIED.to_string())?;
        if !meta.is_file() {
            return Err(DENIED.to_string());
        }
        Ok((canonical, meta))
    }

    async fn artifact(
        &self,
        node_id: &str,
        peer_id: EndpointId,
        raw: &str,
    ) -> Result<ArtifactMeta, String> {
        let (canonical, meta) = self.gate_readable(raw)?;
        // Same caps as Beam: the transfer path is the same blob protocol.
        // The cap is `artifact`'s alone — it is about bytes on the wire, not
        // about whether the peer may reach the path.
        if meta.len() > crate::beam::HARD_CAP_BYTES {
            return Err("artifact exceeds the transfer size cap".to_string());
        }
        // A staging failure is THIS machine's problem (a full disk, an
        // unreadable store), and the peer only ever sees `Denied` — so it is
        // logged here, where somebody can fix it.
        let hash = stage_for_peer(&self.store, &self.grants, &canonical, peer_id)
            .await
            .inspect_err(|e| eprintln!("skypie: scope: cannot stage {}: {e}", canonical.display()))?;
        // The unpair may have run while `add_path` was awaiting: the request
        // passed its per-request peer check, `revoke` swept the grants, and
        // the line above just minted a fresh one-hour grant for a peer that
        // is gone. The peer list is the authority, so re-read it.
        if self.state.peers.get(node_id).is_none() {
            delete_tags(&self.store, self.grants.revoke_peer(&peer_id)).await;
            return Err(DENIED.to_string());
        }
        Ok(ArtifactMeta {
            hash: hash.to_string(),
            size: meta.len(),
            mtime: mtime_secs(&meta),
            warn: meta.len() > crate::beam::WARN_BYTES,
        })
    }
}

/// Stage a file into the blob store and grant EXACTLY ONE peer a fetch of the
/// resulting hash — plus the housekeeping sweep that unpins whatever expired
/// while the store was at hand.
///
/// The `add_path` and the `grants.insert` are one operation on purpose: bytes
/// in the store with no grant behind them are unreachable, and a grant is
/// what makes the fetch peer-locked — splitting the pair is how a hash
/// becomes fetchable by anyone who learns it.
async fn stage_for_peer(
    store: &FsStore,
    grants: &Grants,
    path: &Path,
    peer: EndpointId,
) -> Result<Hash, String> {
    delete_tags(store, grants.take_expired(now_unix())).await;
    let tag = store
        .blobs()
        .add_path(path)
        .await
        .map_err(|e| format!("cannot stage artifact: {e}"))?;
    if let Some(redundant) = grants.insert(tag.hash, peer, tag.name) {
        // This content was already staged: the fresh tag would pin a second
        // copy of the same bytes that nothing can reach.
        delete_tags(store, vec![redundant]).await;
    }
    Ok(tag.hash)
}

impl ProtocolHandler for ScopeServer {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let peer_id = connection.remote_id();
        let node_id = peer_id.to_string();

        // 1 — the allowlist, before a single request byte is parsed. QUIC
        // already authenticated this NodeId, so there is nothing to spoof.
        if self.state.peers.get(&node_id).is_none() {
            // CLOSE_NOT_PAIRED, not CLOSE_REFUSED: this is the one refusal a
            // dialer may act on by re-pairing or by forgetting this device.
            connection.close(VarInt::from_u32(CLOSE_NOT_PAIRED), b"not a paired peer");
            return Err(refused("not a paired peer"));
        }
        // `last_seen` is written once, by `refresh_device` after the
        // handshake, so a connection costs one peers.json rewrite, not two.
        let (mut send, mut recv) = connection.accept_bi().await?;

        // Handshake: version first, everything else after.
        let hello = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame::<Req>(&mut recv))
            .await
            .map_err(|_| refused("handshake timed out"))?
            .map_err(refused_owned)?;
        let device = match hello {
            Req::Hello { proto, device } if proto == proto::PROTO_VERSION => {
                proto::sanitize_device(&device)
            }
            Req::Hello { .. } => {
                write_frame(&mut send, &Res::Denied("unsupported protocol version".into()))
                    .await
                    .ok();
                connection.close(VarInt::from_u32(CLOSE_REFUSED), b"protocol version");
                return Err(refused("unsupported protocol version"));
            }
            _ => {
                connection.close(VarInt::from_u32(CLOSE_REFUSED), b"expected hello");
                return Err(refused("expected hello"));
            }
        };
        // The device name travels in every handshake (design §4): keep the
        // stored name current. This runs AFTER the allowlist check at the
        // top, with an await in between. `refresh_device` never inserts, so a
        // peer the operator revoked inside that window cannot write itself
        // back into the store — and we refuse it here rather than registering
        // a session it would otherwise keep.
        match self.state.peers.refresh_device(&node_id, &device) {
            Ok(true) => {}
            Ok(false) => {
                connection.close(VarInt::from_u32(CLOSE_NOT_PAIRED), b"not a paired peer");
                return Err(refused("peer was revoked during the handshake"));
            }
            Err(e) => eprintln!("skypie: remote: cannot persist peers.json: {e}"),
        }

        let id = self.state.next_session_id.fetch_add(1, Ordering::SeqCst);
        // The same wording the allowlist refuses a fresh dial with, so a peer
        // cut mid-session and one turned away at the door read alike.
        let cut = {
            let connection = connection.clone();
            Arc::new(move || {
                connection.close(VarInt::from_u32(CLOSE_NOT_PAIRED), b"not a paired peer");
            })
        };
        self.state
            .register(Session { id, peer: node_id.clone(), cut })
            .map_err(|e| {
                connection.close(VarInt::from_u32(CLOSE_REFUSED), b"session cap");
                refused_owned(e)
            })?;

        let ack = Res::Hello(HelloAck {
            proto: proto::PROTO_VERSION,
            device: self.state.device.clone(),
        });
        let result = match write_frame(&mut send, &ack).await {
            Ok(()) => self.serve(&node_id, peer_id, &mut send, &mut recv).await,
            Err(e) => Err(e),
        };
        self.state.unregister(id);
        let _ = send.finish();
        if let Err(e) = &result {
            eprintln!("skypie: scope: session with {node_id} ended: {e}");
        }
        connection.close(VarInt::from_u32(0), b"bye");
        Ok(())
    }
}

impl ScopeServer {
    async fn serve(
        &self,
        node_id: &str,
        peer_id: EndpointId,
        send: &mut SendStream,
        recv: &mut RecvStream,
    ) -> Result<(), String> {
        loop {
            // A closed stream is the normal end of a session.
            let req: Req = read_frame(recv).await?;
            // Re-read the peer per request: a revocation mid-session must
            // take effect on the next request, not on the next connection.
            if self.state.peers.get(node_id).is_none() {
                return Err("peer was revoked".to_string());
            }
            let res = self.handle(node_id, peer_id, req).await;
            write_frame(send, &res).await.map_err(|_| "client stopped reading".to_string())?;
        }
    }
}

// ── Host: the pairing server (its own ALPN) ────────────────────────────────

/// `skypie/pair/1`. The only door an unpaired NodeId may knock on, and only
/// with a live one-time token. Nothing is persisted here — the handshake
/// parks a pending pairing and the local human confirms the fingerprint.
#[derive(Debug, Clone)]
pub struct PairServer {
    pub state: Arc<ScopeState>,
    /// This endpoint's own NodeId, threaded in at construction: the
    /// fingerprint is derived from BOTH ids, and a `Connection` only exposes
    /// the remote one.
    local: EndpointId,
}

impl PairServer {
    pub fn new(state: Arc<ScopeState>, local: EndpointId) -> Self {
        Self { state, local }
    }
}

impl ProtocolHandler for PairServer {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let peer_id = connection.remote_id();
        // The one door with no allowlist: every wait on a stranger is
        // bounded, or a node that connects and says nothing parks a task.
        let (mut send, mut recv) = tokio::time::timeout(HANDSHAKE_TIMEOUT, connection.accept_bi())
            .await
            .map_err(|_| refused("pairing handshake timed out"))??;
        let hello = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame::<PairHello>(&mut recv))
            .await
            .map_err(|_| refused("pairing handshake timed out"))?
            .map_err(refused_owned)?;

        let ack = if hello.proto != proto::PROTO_VERSION {
            PairAck::Denied("unsupported protocol version".to_string())
        } else if !self.state.pairing.consume(&hello.token) {
            // Unknown, expired and already-used tokens are one refusal.
            PairAck::Denied("pairing is not open on this machine".to_string())
        } else {
            let device = proto::sanitize_device(&hello.device);
            self.state.signal(HostSignal::PairPending(PendingPair {
                node_id: peer_id.to_string(),
                device: device.clone(),
                fingerprint: peers::fingerprint(&self.local, &peer_id),
                role: "host".to_string(),
                created_at: now_unix(),
            }));
            PairAck::Ok {
                proto: proto::PROTO_VERSION,
                device: self.state.device.clone(),
            }
        };
        write_frame(&mut send, &ack).await.map_err(refused_owned)?;
        let _ = send.finish();
        let _ = tokio::time::timeout(HANDSHAKE_TIMEOUT, connection.closed()).await;
        Ok(())
    }
}

// ── Client: dialing a host ─────────────────────────────────────────────────

/// Why a dial did not end in a session, split by what the caller may do next.
///
/// The classification is produced HERE, where the cause is known, and never
/// re-derived from the message. `Display` yields the inner string verbatim on
/// every variant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    /// The peer was never spoken to: the dial itself failed (`endpoint::dial`
    /// already appends the cause to `PEER_OFFLINE`), or it accepted the
    /// connection and never answered the handshake. Only this means "asleep".
    Unreachable(String),
    /// The peer, or its stream, answered — a refusal, a version mismatch, a
    /// frame that is not an ack, a stream that broke after the handshake.
    Refused(String),
    /// The peer answered and said this node is not on its allowlist — the one
    /// cause that means "this device unpaired this one".
    ///
    /// Decided by `CLOSE_NOT_PAIRED` on the wire, never by matching the
    /// reason text, which the other machine writes.
    Unpaired(String),
    /// This side never dialed: the peer is not in the local allowlist, the
    /// endpoint failed to boot, the id does not parse. Nothing about the
    /// peer follows from it — a presence probe reports it as unknown, not as
    /// a refusal the peer never made.
    Local(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Unreachable(reason)
            | ConnectError::Refused(reason)
            | ConnectError::Unpaired(reason)
            | ConnectError::Local(reason) => f.write_str(reason),
        }
    }
}

/// What the peer SAID when it closed. `ScopeServer::accept` turns a dial from
/// a device that has unpaired this node away by closing with
/// `CLOSE_NOT_PAIRED` before `accept_bi`, so there is no stream to carry a
/// `Res::Denied` — these close bytes are the whole account of it.
fn stated_refusal(connection: &Connection) -> Option<(u32, String)> {
    let ConnectionError::ApplicationClosed(close) = connection.close_reason()? else {
        return None;
    };
    stated_reason(close.error_code.into_inner() as u32, &close.reason)
}

/// The treatment a close reason gets, split from the connection that carried
/// it so a proof can reach it: the crate's one strip set, then a cap.
fn stated_reason(code: u32, reason: &[u8]) -> Option<(u32, String)> {
    let said =
        proto::strip_spoofing_chars(&String::from_utf8_lossy(reason), MAX_CLOSE_REASON_CHARS);
    let said = said.trim();
    (!said.is_empty()).then(|| (code, said.to_string()))
}

/// One post-dial failure, told in the peer's own words when it left any and
/// in the transport's when it did not — and sorted into the variant its close
/// CODE earns, never the one its text suggests.
fn refusal(connection: &Connection, transport: String) -> ConnectError {
    match stated_refusal(connection) {
        Some((code, said)) => classify_close(code, said),
        None => ConnectError::Refused(transport),
    }
}

/// The close CODE decides which refusal this is. Exactly one place knows
/// `CLOSE_NOT_PAIRED` is the only code a caller may act on by deleting a
/// pairing.
fn classify_close(code: u32, reason: String) -> ConnectError {
    match code {
        CLOSE_NOT_PAIRED => ConnectError::Unpaired(reason),
        // Includes `CLOSE_REFUSED` and any code a future or foreign build
        // invents. Unknown means "not entitled".
        _ => ConnectError::Refused(reason),
    }
}

/// A live session with a paired host. Owns a reader task (responses) and a
/// writer task (requests), so the caller just awaits futures.
pub struct ClientSession {
    pub peer: String,
    pub device: String,
    reqs: mpsc::Sender<(Req, oneshot::Sender<Res>)>,
    closed: Arc<AtomicBool>,
}

impl std::fmt::Debug for ClientSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientSession")
            .field("peer", &self.peer)
            .field("device", &self.device)
            .finish_non_exhaustive()
    }
}

impl ClientSession {
    /// Dial `addr` on the scope ALPN, handshake, and start the pumps.
    /// `on_closed` fires once when the session ends, which is what drives
    /// presence back to offline.
    pub async fn connect(
        node: &RemoteNode,
        addr: EndpointAddr,
        device: String,
        on_closed: impl FnOnce() + Send + 'static,
    ) -> Result<Arc<Self>, ConnectError> {
        let peer = addr.id.to_string();
        // The two causes that mean the peer is asleep, and the only two: the
        // dial never reached it, or it took the connection and said nothing.
        let connection = endpoint::dial(&node.endpoint, addr, proto::SCOPE_ALPN, PEER_OFFLINE)
            .await
            .map_err(ConnectError::Unreachable)?;

        // Everything from here on happens on a connection the peer accepted,
        // so it is a refusal even when it reads like a network fault. Each
        // step asks the connection for a stated reason first: a peer that
        // closed on purpose left one.
        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .map_err(|e| refusal(&connection, format!("cannot open the session stream: {e}")))?;

        write_frame(&mut send, &Req::Hello { proto: proto::PROTO_VERSION, device })
            .await
            .map_err(|e| refusal(&connection, e))?;

        // The timeout arm stays UNREACHABLE: a peer that took the connection
        // and then said nothing is the one shape here that really does mean
        // asleep.
        let ack = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame::<Res>(&mut recv))
            .await
            .map_err(|_| {
                ConnectError::Unreachable("the peer did not answer the handshake".to_string())
            })?
            .map_err(|e| refusal(&connection, e))?;
        let host_device = classify_ack(ack)?;

        let (req_tx, mut req_rx) = mpsc::channel::<(Req, oneshot::Sender<Res>)>(32);
        // Responses arrive in request order; the reader pops the matching
        // waiter for each `Res` frame.
        let (waiter_tx, mut waiter_rx) = mpsc::unbounded_channel::<oneshot::Sender<Res>>();
        let closed = Arc::new(AtomicBool::new(false));

        let writer_closed = closed.clone();
        tokio::spawn(async move {
            while let Some((req, reply)) = req_rx.recv().await {
                // Register the waiter BEFORE the frame goes out: a nearby host
                // can answer while this task is still inside `write_frame`.
                if waiter_tx.send(reply).is_err() {
                    break;
                }
                if write_frame(&mut send, &req).await.is_err() {
                    break;
                }
            }
            let _ = send.finish();
            writer_closed.store(true, Ordering::SeqCst);
        });

        let reader_closed = closed.clone();
        tokio::spawn(async move {
            loop {
                match read_frame::<Res>(&mut recv).await {
                    Ok(res) => match waiter_rx.try_recv() {
                        Ok(reply) => {
                            let _ = reply.send(res);
                        }
                        // A response with nobody waiting means the two sides
                        // disagree about the stream; stop rather than guess.
                        Err(_) => break,
                    },
                    Err(_) => break,
                }
            }
            reader_closed.store(true, Ordering::SeqCst);
            on_closed();
        });

        Ok(Arc::new(Self { peer, device: host_device, reqs: req_tx, closed }))
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Issue one request and await its response.
    async fn request(&self, req: Req) -> Result<Res, String> {
        let (tx, rx) = oneshot::channel();
        self.reqs
            .send((req, tx))
            .await
            .map_err(|_| "the session is closed".to_string())?;
        rx.await.map_err(|_| "the session is closed".to_string())
    }

    /// Ask the host for a file's content address. A `Denied` frame is the
    /// host's answer, not a protocol failure, and surfaces verbatim; a
    /// session that died under the request is told apart, because the
    /// caller's right move is a fresh dial, not an error screen.
    pub async fn get_artifact(&self, path: String) -> Result<ArtifactMeta, GetFailure> {
        let res = self.request(Req::GetArtifact { path }).await.map_err(|_| GetFailure::Closed)?;
        match res {
            Res::Artifact(meta) => Ok(meta),
            other => Err(GetFailure::Denied(unexpected(other))),
        }
    }

    /// Ask the host what it has offered THIS device.
    ///
    /// Metadata only — the answer names files, it does not carry them. The
    /// caller fetches one with `get_artifact` if the user asks for it.
    pub async fn list_shared(&self) -> Result<proto::SharedPage, GetFailure> {
        let res = self.request(Req::ListShared).await.map_err(|_| GetFailure::Closed)?;
        match res {
            Res::Shared(page) => Ok(page),
            other => Err(GetFailure::Denied(unexpected(other))),
        }
    }

    /// Read the host's comments on one of its files.
    pub async fn get_annotations(
        &self,
        path: String,
    ) -> Result<proto::AnnotationPage, GetFailure> {
        let res =
            self.request(Req::GetAnnotations { path }).await.map_err(|_| GetFailure::Closed)?;
        match res {
            Res::Annotations(page) => Ok(page),
            other => Err(GetFailure::Denied(unexpected(other))),
        }
    }

    /// Append comments to the host's store for one of its files.
    ///
    /// The frame is checked HERE as well as on the host. A push the host
    /// would refuse then fails locally, with a message naming what is wrong,
    /// instead of coming back as the deliberately opaque `Denied`.
    pub async fn put_annotations(
        &self,
        path: String,
        entries: Vec<String>,
    ) -> Result<usize, GetFailure> {
        proto::check_entries(&entries).map_err(GetFailure::Denied)?;
        let res = self
            .request(Req::PutAnnotations { path, entries })
            .await
            .map_err(|_| GetFailure::Closed)?;
        match res {
            Res::Merged { added } => Ok(added),
            other => Err(GetFailure::Denied(unexpected(other))),
        }
    }
}

/// Why `get_artifact` did not answer with a content address.
///
/// `is_closed()` is a cached flag the reader task sets only once the
/// transport notices — for a peer that quit or suspended, that is the QUIC
/// idle timer, up to a minute later. Until then a cached session is handed
/// out and the request fails HERE, not at the dial. `Closed` is the one
/// arm that means "dial again"; `Denied` is the host's own answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GetFailure {
    /// The session is gone: the request never reached the host, or its
    /// answer never came back.
    Closed,
    /// The host answered, and its answer was not an artifact: its own
    /// `Denied` wording, or — for a frame that makes no sense — a note that
    /// says so. Neither improves by asking again.
    Denied(String),
}

impl std::fmt::Display for GetFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GetFailure::Closed => f.write_str("the session is closed"),
            GetFailure::Denied(reason) => f.write_str(reason),
        }
    }
}

/// The handshake answer, classified: the host's device name, or the reason
/// there is no session. Every error arm is `Refused`: the peer spoke, so
/// waiting for it to wake up is not the answer to any of them.
fn classify_ack(ack: Res) -> Result<String, ConnectError> {
    match ack {
        // The host's name lands in the Devices pane: the one strip set, like
        // every other name off the wire.
        Res::Hello(ack) if ack.proto == proto::PROTO_VERSION => Ok(proto::sanitize_device(&ack.device)),
        Res::Hello(_) => Err(ConnectError::Refused("unsupported protocol version".to_string())),
        Res::Denied(reason) => Err(ConnectError::Refused(reason)),
        _ => Err(ConnectError::Refused("the peer answered with an unexpected frame".to_string())),
    }
}

/// A `Denied` frame is the host's answer, not a bug — surface its wording
/// verbatim so the UI shows the same no-existence-leak string.
fn unexpected(res: Res) -> String {
    match res {
        Res::Denied(reason) => reason,
        other => format!("unexpected response from the peer: {other:?}"),
    }
}

/// Dial a host's pairing ALPN with a ticket's token. Returns the host's
/// device name and the six-word fingerprint both screens must show.
pub async fn pair_dial(
    node: &RemoteNode,
    ticket: &crate::peers::PairTicket,
    local_device: String,
) -> Result<PendingPair, String> {
    let host_id = ticket.addr.id;
    let connection = endpoint::dial(
        &node.endpoint,
        ticket.addr.clone(),
        proto::PAIR_ALPN,
        PEER_OFFLINE,
    )
    .await?;

    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|e| format!("cannot open the pairing stream: {e}"))?;
    write_frame(
        &mut send,
        &PairHello {
            proto: proto::PROTO_VERSION,
            token: ticket.token,
            device: local_device,
        },
    )
    .await?;
    let _ = send.finish();

    let ack = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame::<PairAck>(&mut recv))
        .await
        .map_err(|_| "the peer did not answer the pairing handshake".to_string())??;
    match ack {
        PairAck::Ok { proto: version, device } if version == proto::PROTO_VERSION => {
            Ok(PendingPair {
                node_id: host_id.to_string(),
                device: proto::sanitize_device(&device),
                fingerprint: peers::fingerprint(&node.endpoint.id(), &host_id),
                role: "guest".to_string(),
                created_at: now_unix(),
            })
        }
        PairAck::Ok { .. } => Err("unsupported protocol version".to_string()),
        PairAck::Denied(reason) => Err(reason),
    }
}

/// Fetch an artifact by content address into `remote/cache/<hash><ext>`,
/// verified by the blob protocol. Content-addressed: a hash (+ extension)
/// already in the cache is a hit and costs no network at all.
///
/// `ext` is the source path's extension, WITH its leading dot (e.g. `.png`),
/// or empty. It rides along purely so the local reader can dispatch on it.
pub async fn fetch_into_cache(
    node: &RemoteNode,
    addr: EndpointAddr,
    hash_hex: &str,
    ext: &str,
    cache_dir: &Path,
) -> Result<PathBuf, String> {
    // The string arrives over the wire, so it is parsed the guarded way —
    // see `parse_hash`.
    let hash = parse_hash(hash_hex).ok_or_else(|| "malformed content address".to_string())?;
    let target = cache_dir.join(format!("{hash_hex}{ext}"));
    if target.is_file() {
        return Ok(target);
    }
    std::fs::create_dir_all(cache_dir)
        .map_err(|e| format!("cannot prepare the cache folder {}: {e}", cache_dir.display()))?;

    let connection =
        endpoint::dial(&node.endpoint, addr, iroh_blobs::ALPN, PEER_OFFLINE).await?;

    // Same staging, verification and one-cleanup discipline as a Beam
    // receive — it IS that routine. Only the final move differs: the cache
    // name is the content address, so the target is known before the bytes are.
    let partial = cache_dir.join(crate::beam::partial_name(hash_hex, ext));
    let (_written, landed) = crate::beam::download_to(
        connection,
        hash,
        hash_hex,
        &partial,
        |partial| {
            std::fs::rename(partial, &target)
                .map_err(|e| format!("cannot move the fetched artifact into place: {e}"))?;
            Ok(target.clone())
        },
        &mut |_, _| {},
    )
    .await?;
    Ok(landed)
}

// ── Framing over a QUIC stream ─────────────────────────────────────────────

async fn write_frame<T: serde::Serialize>(send: &mut SendStream, value: &T) -> Result<(), String> {
    let bytes = proto::encode_frame(value)?;
    send.write_all(&bytes).await.map_err(|e| format!("cannot write frame: {e}"))
}

async fn read_frame<T: serde::de::DeserializeOwned>(recv: &mut RecvStream) -> Result<T, String> {
    let mut prefix = [0u8; 4];
    recv.read_exact(&mut prefix)
        .await
        .map_err(|e| format!("stream ended: {e}"))?;
    let len = proto::frame_len(prefix)?;
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body)
        .await
        .map_err(|e| format!("stream ended: {e}"))?;
    proto::decode_frame(&body)
}

fn refused(reason: &'static str) -> AcceptError {
    AcceptError::from_err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, reason))
}

fn refused_owned(reason: String) -> AcceptError {
    AcceptError::from_err(std::io::Error::other(reason))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Dirs;
    use iroh::SecretKey;

    fn id(seed: u8) -> EndpointId {
        SecretKey::from_bytes(&[seed; 32]).public()
    }

    fn state(dir: &tempfile::TempDir) -> Arc<ScopeState> {
        Arc::new(ScopeState::new(
            Arc::new(PeerStore::load(dir.path())),
            Arc::new(Pairing::new()),
            "Test Mac".to_string(),
            |_| {},
        ))
    }

    // ── Path gate ──────────────────────────────────────────────────────────

    #[test]
    fn the_gate_admits_any_existing_file_and_refuses_the_rest_identically() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("a.html");
        std::fs::write(&file, "x").unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();

        assert_eq!(gate_raw(&file.to_string_lossy()).unwrap(), file.canonicalize().unwrap());
        // A traversal resolves to the same canonical answer.
        let traversal = format!("{}/sub/../a.html", dir.path().display());
        assert_eq!(gate_raw(&traversal).unwrap(), file.canonicalize().unwrap());
        // A missing file and a directory both go through canonicalize; the
        // directory is refused later by `artifact` (is_file), the missing one
        // here, and both with the one wording.
        assert_eq!(
            gate_raw(&format!("{}/nope.html", dir.path().display())).unwrap_err(),
            DENIED
        );
    }

    #[test]
    fn relative_paths_and_nul_bytes_never_reach_the_filesystem() {
        assert_eq!(gate_raw("relative/path.html").unwrap_err(), DENIED);
        assert_eq!(gate_raw("").unwrap_err(), DENIED);
        assert_eq!(gate_raw("/tmp/a\0b").unwrap_err(), DENIED);
    }

    // ── Session registry ───────────────────────────────────────────────────

    fn session(id: u64, peer: &str) -> (Session, Arc<AtomicBool>) {
        let was_cut = Arc::new(AtomicBool::new(false));
        let flag = was_cut.clone();
        let session = Session {
            id,
            peer: peer.to_string(),
            cut: Arc::new(move || flag.store(true, Ordering::SeqCst)),
        };
        (session, was_cut)
    }

    #[test]
    fn a_peer_cannot_hold_more_than_the_session_cap() {
        let dir = tempfile::TempDir::new().unwrap();
        let st = state(&dir);
        let mut ids = Vec::new();
        for n in 0..MAX_SESSIONS_PER_PEER {
            let (session, _) = session(n as u64, "nodeA");
            ids.push(st.register(session).expect("under the cap"));
        }
        let (over_cap, _) = session(99, "nodeA");
        assert!(st.register(over_cap).is_err(), "the cap refuses the next session");

        // Another peer is unaffected — the cap is per peer.
        let (other_peer, _) = session(100, "nodeB");
        assert!(st.register(other_peer).is_ok());

        st.unregister(ids[0]);
        let (replacement, _) = session(101, "nodeA");
        assert!(st.register(replacement).is_ok());
    }

    #[test]
    fn revoking_a_peer_cuts_the_connection_it_was_already_holding() {
        let dir = tempfile::TempDir::new().unwrap();
        let st = state(&dir);
        let (revoked, was_cut) = session(1, "nodeA");
        let (bystander, untouched) = session(2, "nodeB");
        st.register(revoked).unwrap();
        st.register(bystander).unwrap();

        st.drop_sessions_for("nodeA");

        assert!(was_cut.load(Ordering::SeqCst), "the revoked peer's transport goes too");
        assert!(!untouched.load(Ordering::SeqCst), "and nobody else's does");
        assert_eq!(st.sessions().len(), 1);
        assert_eq!(st.sessions()[0].peer, "nodeB");
    }

    // ── Grants ─────────────────────────────────────────────────────────────

    #[test]
    fn a_grant_is_peer_locked_and_expires() {
        let grants = Grants::new();
        let hash = Hash::new(b"artifact");
        assert!(grants.insert(hash, id(1), Tag::from("t1")).is_none());

        assert!(grants.admit(&hash, Some(id(1)), true));
        assert!(!grants.admit(&hash, Some(id(2)), true), "another peer holds no grant");
        assert!(!grants.admit(&hash, None, true), "an anonymous fetch holds no grant");
        assert!(!grants.admit(&hash, Some(id(1)), false), "only plain blob requests");
        assert!(!grants.admit(&Hash::new(b"other"), Some(id(1)), true));

        // A second peer asking for the same artifact shares the entry, and
        // the redundant staging tag comes back for deletion.
        assert!(grants.insert(hash, id(2), Tag::from("t2")).is_some());
        assert!(grants.admit(&hash, Some(id(2)), true));
        assert_eq!(grants.len(), 1);
    }

    #[test]
    fn expired_grants_are_swept_with_their_tags() {
        let grants = Grants::new();
        let hash = Hash::new(b"artifact");
        grants.insert(hash, id(1), Tag::from("t1"));
        let tags = grants.take_expired(now_unix() + GRANT_TTL_SECS + 1);
        assert_eq!(tags.len(), 1);
        assert!(!grants.admit(&hash, Some(id(1)), true));
    }

    #[test]
    fn revoking_a_peer_drops_the_grants_only_it_held() {
        let grants = Grants::new();
        let solo = Hash::new(b"solo");
        let shared = Hash::new(b"shared");
        grants.insert(solo, id(1), Tag::from("t1"));
        grants.insert(shared, id(1), Tag::from("t2"));
        grants.insert(shared, id(2), Tag::from("t3"));

        let orphaned = grants.revoke_peer(&id(1));
        assert_eq!(orphaned.len(), 1, "only the grant nobody else holds is collectable");
        assert!(!grants.admit(&solo, Some(id(1)), true));
        assert!(!grants.admit(&shared, Some(id(1)), true));
        assert!(grants.admit(&shared, Some(id(2)), true), "the other peer keeps it");
    }

    // ── Connect errors ─────────────────────────────────────────────────────

    #[test]
    fn every_connect_failure_reports_its_own_cause_not_one_string() {
        let dial = ConnectError::Unreachable(format!("{PEER_OFFLINE} (timed out)"));
        assert_eq!(dial.to_string(), "peer offline — could not reach it (timed out)");

        assert_eq!(
            classify_ack(Res::Denied("not a paired peer".to_string())),
            Err(ConnectError::Refused("not a paired peer".to_string())),
            "the host's own wording survives, verbatim"
        );
        assert_eq!(
            classify_ack(Res::Hello(HelloAck {
                proto: proto::PROTO_VERSION + 1,
                device: "Mac Studio".to_string(),
            })),
            Err(ConnectError::Refused("unsupported protocol version".to_string()))
        );
        assert_eq!(
            classify_ack(Res::Artifact(ArtifactMeta {
                hash: String::new(),
                size: 0,
                mtime: 0,
                warn: false
            })),
            Err(ConnectError::Refused("the peer answered with an unexpected frame".to_string()))
        );
        assert_eq!(
            classify_ack(Res::Hello(HelloAck {
                proto: proto::PROTO_VERSION,
                device: "Mac Studio".to_string(),
            })),
            Ok("Mac Studio".to_string())
        );
    }

    #[test]
    fn a_refusal_that_is_not_an_unpairing_never_reads_as_one() {
        assert_eq!(
            classify_close(CLOSE_NOT_PAIRED, "not a paired peer".to_string()),
            ConnectError::Unpaired("not a paired peer".to_string())
        );
        for (code, reason) in [
            (CLOSE_REFUSED, "session cap"),
            (CLOSE_REFUSED, "protocol version"),
            (CLOSE_REFUSED, "expected hello"),
            (99, "something this build cannot name"),
        ] {
            assert_eq!(
                classify_close(code, reason.to_string()),
                ConnectError::Refused(reason.to_string())
            );
        }
        // A peer cannot talk its way into the destructive variant by writing
        // the magic words: the code is the protocol's, the text is theirs.
        assert_eq!(
            classify_close(CLOSE_REFUSED, "not a paired peer".to_string()),
            ConnectError::Refused("not a paired peer".to_string())
        );
    }

    #[test]
    fn a_close_reason_from_another_machine_is_bounded_before_a_human_reads_it() {
        let spoof = format!("not a paired peer\u{202E}{}", "x".repeat(500));
        let (code, shown) =
            stated_reason(CLOSE_NOT_PAIRED, spoof.as_bytes()).expect("a non-empty reason");
        assert_eq!(code, CLOSE_NOT_PAIRED);
        assert!(!shown.contains('\u{202E}'));
        assert_eq!(shown.chars().count(), MAX_CLOSE_REASON_CHARS);
        assert_eq!(stated_reason(CLOSE_REFUSED, b""), None);
        assert_eq!(stated_reason(CLOSE_REFUSED, b"   "), None);
    }

    // ── Two real endpoints ─────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn a_device_that_unpaired_this_node_says_so_instead_of_reading_as_a_dead_link() {
        let host_dir = tempfile::TempDir::new().unwrap();
        let dialer_dir = tempfile::TempDir::new().unwrap();
        // An EMPTY peer store is the unpair: `accept` looks the dialer up,
        // misses, and refuses.
        let host = endpoint::boot(&Dirs::new(host_dir.path()), Some(state(&host_dir)), |_| {})
            .await
            .expect("the host is up");
        let dialer = endpoint::boot(&Dirs::new(dialer_dir.path()), None, |_| {})
            .await
            .expect("the dialer is up");

        let addr = endpoint::addr_at(
            &host.endpoint.id().to_string(),
            endpoint::loopback_socket(&host).await.expect("the host bound a port"),
        )
        .unwrap();
        let failed = ClientSession::connect(&dialer, addr, "iPhone".to_string(), || {})
            .await
            .expect_err("a host that does not list this node refuses it");

        assert_eq!(failed, ConnectError::Unpaired("not a paired peer".to_string()));

        host.shutdown().await;
        dialer.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_revoked_peer_finds_its_live_connection_closed_and_not_merely_ignored() {
        let host_dir = tempfile::TempDir::new().unwrap();
        let dialer_dir = tempfile::TempDir::new().unwrap();
        let state = state(&host_dir);
        let host = endpoint::boot(&Dirs::new(host_dir.path()), Some(state.clone()), |_| {})
            .await
            .expect("the host is up");
        let dialer = endpoint::boot(&Dirs::new(dialer_dir.path()), None, |_| {})
            .await
            .expect("the dialer is up");

        let dialer_id = dialer.endpoint.id().to_string();
        state.peers.seed(&dialer_id, "iPhone").expect("paired");
        let addr = endpoint::addr_at(
            &host.endpoint.id().to_string(),
            endpoint::loopback_socket(&host).await.expect("the host bound a port"),
        )
        .unwrap();
        let session = ClientSession::connect(&dialer, addr, "iPhone".to_string(), || {})
            .await
            .expect("a paired peer gets a session");
        assert!(!session.is_closed());
        assert_eq!(session.device, "Test Mac");

        // The unpair, exactly as the app's own `remote_unpair` does it.
        state.peers.remove(&dialer_id).expect("the human unpairs this device");
        host.scope.as_ref().expect("the host serves scope").revoke(&dialer_id).await;

        // The client learns WITHOUT asking for anything.
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            while !session.is_closed() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(closed.is_ok(), "the revoked peer's transport is cut, not merely deregistered");

        host.shutdown().await;
        dialer.shutdown().await;
    }
}
