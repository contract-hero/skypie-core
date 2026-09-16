// Trusted-peer store, pairing and revocation (design §6 "Pairing").
//
// `peers.json` IS the social graph: a NodeId, the device name it announced,
// and two timestamps. Trust is single-tier — a paired device is one of the
// user's own — so there is no grant to record. Revocation is deleting the
// entry: the scope server consults this store at handshake time, so a removed
// peer is refused on its next connection with nothing to invalidate.
//
// Pairing is a one-time token plus a mutual six-word fingerprint. The token
// admits an unknown NodeId onto the pairing ALPN exactly once; the
// fingerprint — derived from BOTH NodeIds, so a machine in the middle cannot
// make the two screens agree — is what the humans compare before either side
// persists anything.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use iroh::{EndpointAddr, EndpointId, SecretKey};
use iroh_blobs::Hash;
use iroh_tickets::{ParseError, Ticket};
use serde::{Deserialize, Serialize};

use crate::{paths, proto};

/// On-disk schema version for `peers.json`. A document written by a newer
/// build is left alone rather than rewritten in an older shape.
///
/// Still 1 after the three-tier scope went away: `Peer` does not
/// `deny_unknown_fields`, so a document carrying `scope` / `last_ack_scope`
/// keys still loads, and those keys are dropped on the next rewrite. A
/// pairing made under the old model stays a pairing.
pub const PEERS_SCHEMA: u32 = 1;

/// How long a minted pairing token stays usable. Long enough to walk to the
/// other machine, short enough that a leaked link is dead by the time it is
/// forwarded anywhere.
pub const PAIR_TOKEN_TTL_SECS: u64 = 10 * 60;

/// Words in a fingerprint. Six words over a 256-word list = 48 bits, which
/// is what a human will actually read out loud and compare.
pub const FINGERPRINT_WORDS: usize = 6;

/// One trusted peer. This is also the IPC shape `remote_list_peers` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peer {
    /// The peer's NodeId, hex — the stable, dialable address.
    pub node_id: String,
    /// Human-readable device name it announced at pairing time (sanitized).
    pub device: String,
    pub paired_at: u64,
    pub last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PeersDoc {
    v: u32,
    peers: Vec<Peer>,
}

/// The trusted-peer store, backed by `remote/peers.json`. Lock discipline
/// matches the offers registry: short critical sections, never held across
/// an await.
pub struct PeerStore {
    path: PathBuf,
    inner: Mutex<Vec<Peer>>,
    /// Set when `load` read a file it could not parse (corrupt, or a newer
    /// schema). While true the store holds no peers AND `save` refuses to
    /// write, so one later pairing cannot replace the real file with a
    /// one-entry document. `None` on a fresh install (no file) or a clean load.
    load_error: Option<String>,
}

impl PeerStore {
    /// Load `<dir>/peers.json`, tolerating a missing file (fresh install).
    /// A corrupt or newer-schema document loads as EMPTY and is never
    /// overwritten in place: silently rewriting it would revoke every peer
    /// on the machine without telling anyone.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("peers.json");
        let (peers, load_error) = match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<PeersDoc>(&raw) {
                Ok(doc) if doc.v == PEERS_SCHEMA => (doc.peers, None),
                Ok(doc) => {
                    let msg = format!(
                        "peers.json is schema v{} but this build reads v{PEERS_SCHEMA}",
                        doc.v
                    );
                    eprintln!("skypie: remote: {msg} — ignoring it, and NOT overwriting it");
                    (Vec::new(), Some(msg))
                }
                Err(e) => {
                    let msg = format!("peers.json is unreadable ({e})");
                    eprintln!("skypie: remote: {msg} — no peers are trusted, and it is NOT overwritten");
                    (Vec::new(), Some(msg))
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
            Err(e) => {
                let msg = format!("cannot read {path:?}: {e}");
                eprintln!("skypie: remote: {msg}");
                (Vec::new(), Some(msg))
            }
        };
        Self { path, inner: Mutex::new(peers), load_error }
    }

    /// Why the on-disk store did not load, if it did not. A caller can surface
    /// this so the user knows their pairings are hidden, not gone — and that
    /// re-pairing would overwrite the real file (which `save` now refuses).
    pub fn load_error(&self) -> Option<&str> {
        self.load_error.as_deref()
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, Vec<Peer>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Every trusted peer, newest pairing first.
    pub fn list(&self) -> Vec<Peer> {
        let mut peers = self.guard().clone();
        peers.sort_by(|a, b| b.paired_at.cmp(&a.paired_at));
        peers
    }

    pub fn is_empty(&self) -> bool {
        self.guard().is_empty()
    }

    pub fn len(&self) -> usize {
        self.guard().len()
    }

    /// The allowlist check. `None` ⇒ the caller must refuse the connection.
    pub fn get(&self, node_id: &str) -> Option<Peer> {
        self.guard().iter().find(|p| p.node_id == node_id).cloned()
    }

    /// Seed a peer directly. Test and fixture use only — production pairs
    /// through `confirm` and refreshes through `refresh_device`, so that no
    /// live path can create a peer without a human confirming it.
    #[doc(hidden)]
    pub fn seed(&self, node_id: &str, device: &str) -> Result<Peer, String> {
        self.write(node_id, device)
    }

    /// Persist a pairing a human just confirmed. Re-pairing an already-trusted
    /// device refreshes its name and keeps its original `paired_at`.
    pub fn confirm(&self, node_id: &str, device: &str) -> Result<Peer, String> {
        self.write(node_id, device)
    }

    /// The one inserting writer. It always refreshes the device name and
    /// `last_seen`, and creates the entry when the peer is new.
    fn write(&self, node_id: &str, device: &str) -> Result<Peer, String> {
        let now = now_unix();
        // DISK FIRST, then memory. The in-memory list IS the handshake
        // allowlist (`get`, read by `ScopeServer::accept`), so mutating it
        // before the write lands would leave a device trusted for the life of
        // the process after `save_list` refused — while the caller returned an
        // error saying it was not paired. The guard is held across the write so
        // no other writer can interleave between the save and the commit.
        let mut peers = self.guard();
        let mut next = peers.clone();
        let peer = match next.iter_mut().find(|p| p.node_id == node_id) {
            Some(existing) => {
                existing.device = device.to_string();
                existing.last_seen = now;
                existing.clone()
            }
            None => {
                let peer = Peer {
                    node_id: node_id.to_string(),
                    device: device.to_string(),
                    paired_at: now,
                    last_seen: now,
                };
                next.push(peer.clone());
                peer
            }
        };
        self.save_list(&next)?;
        *peers = next;
        Ok(peer)
    }

    /// Refresh a peer this store ALREADY trusts: its announced device name and
    /// `last_seen`, and never an entry that is not there. Returns false when
    /// the peer is gone.
    ///
    /// The handshake path runs this after its allowlist check, with an await
    /// in between. An insert-or-update writer there would let a peer revoked
    /// inside that window write itself back into the store, which is a
    /// revocation the peer itself can undo by stalling its `Hello`.
    pub fn refresh_device(&self, node_id: &str, device: &str) -> Result<bool, String> {
        let mut peers = self.guard();
        if !peers.iter().any(|p| p.node_id == node_id) {
            return Ok(false);
        }
        let mut next = peers.clone();
        if let Some(existing) = next.iter_mut().find(|p| p.node_id == node_id) {
            existing.device = device.to_string();
            existing.last_seen = now_unix();
        }
        self.save_list(&next)?;
        *peers = next;
        Ok(true)
    }

    /// Revocation. Returns true when an entry actually went away.
    ///
    /// MEMORY FIRST here, unlike every other writer, and deliberately: this is
    /// the one operation whose safe failure mode is to take effect anyway. The
    /// peer stops being trusted the moment it leaves the list, and a refused
    /// write costs the revocation only on the next restart — whereas saving
    /// first would leave a peer the operator just revoked trusted in memory.
    /// The `Err` still reaches the caller, so the failure is not silent.
    pub fn remove(&self, node_id: &str) -> Result<bool, String> {
        let mut peers = self.guard();
        let before = peers.len();
        peers.retain(|p| p.node_id != node_id);
        if peers.len() == before {
            return Ok(false);
        }
        self.save_list(&peers)?;
        Ok(true)
    }

    /// Atomic write (tmp + rename), 0600 — the file names the machines this
    /// install trusts.
    ///
    /// Takes the list to write rather than reading `self.inner`, so a caller
    /// can persist a CANDIDATE list before committing it to memory. That
    /// ordering is what keeps a refused write from leaving a peer trusted —
    /// see `write`. Never locks: the caller already holds the guard.
    fn save_list(&self, peers: &[Peer]) -> Result<(), String> {
        // A store that did not load holds no peers; writing it would replace a
        // corrupt-but-real file with an empty (or one-entry) document and lose
        // every pairing. Refuse, and tell the caller where the file is.
        if let Some(reason) = &self.load_error {
            return Err(format!(
                "refusing to overwrite {:?}: it did not load ({reason}). \
                 Move the file aside to start a fresh peer list.",
                self.path
            ));
        }
        let doc = PeersDoc { v: PEERS_SCHEMA, peers: peers.to_vec() };
        let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
        paths::write_private_atomic(&self.path, json.as_bytes())
    }
}

/// Unix seconds and the short-id width, from the contract crate so the app
/// and the MCP server print the same strings.
pub use skypie_ipc::{now_unix, short_id};

// ── Pairing ticket ─────────────────────────────────────────────────────────

/// The capability inside `skypie://pair?ticket=…`: where to dial, plus the
/// one-time token that admits an unknown NodeId onto the pairing ALPN. Same
/// encoding discipline as `BlobTicket` (postcard + base32, kind prefix), so
/// the string stays alphanumeric and survives the deep-link parser's charset
/// check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairTicket {
    pub addr: EndpointAddr,
    pub token: [u8; 32],
    pub device: String,
}

#[derive(Serialize, Deserialize)]
enum PairTicketWire {
    // A single-variant enum forces postcard to emit a discriminator, leaving
    // room for a second wire shape later (the BlobTicket idiom).
    Variant0 { addr: EndpointAddr, token: [u8; 32], device: String },
}

impl Ticket for PairTicket {
    const KIND: &'static str = "skypiepair";

    fn encode_bytes(&self) -> Vec<u8> {
        postcard::to_stdvec(&PairTicketWire::Variant0 {
            addr: self.addr.clone(),
            token: self.token,
            device: self.device.clone(),
        })
        .expect("postcard serialization of a pair ticket cannot fail")
    }

    fn decode_bytes(bytes: &[u8]) -> Result<Self, ParseError> {
        let PairTicketWire::Variant0 { addr, token, device } = postcard::from_bytes(bytes)?;
        Ok(Self { addr, token, device: proto::sanitize_device(&device) })
    }
}

impl std::fmt::Display for PairTicket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&Ticket::encode_string(self))
    }
}

impl std::str::FromStr for PairTicket {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ticket::decode_string(s).map_err(|e| format!("invalid pairing ticket: {e}"))
    }
}

/// Build the `skypie://pair?ticket=…` link the other machine opens.
pub fn build_pair_link(ticket: &str) -> String {
    format!("skypie://pair?ticket={ticket}")
}

/// Everything "open pairing" produces: the ticket, the link that carries it,
/// who is offering, and when the token dies. Consumers wrap this in their own
/// IPC shape — the desktop's `PairInvite` command result, the MCP server's
/// `PairingInvite` with its extra prose fields — instead of re-deriving the
/// four facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairInvite {
    /// The encoded `PairTicket`.
    pub ticket: String,
    /// `skypie://pair?ticket=…`.
    pub link: String,
    /// The offering machine's NodeId, hex.
    pub node_id: String,
    /// The offering machine's sanitized device name.
    pub device: String,
    /// Unix seconds after which the token is dead.
    pub expires_at: u64,
}

/// Mint a one-time token and wrap it in the ticket, the link and the TTL that
/// belong to it. `addr` is the offering endpoint's own address — the caller
/// owns the bounded `online()` wait that makes it reachable from another
/// network, because that is endpoint lifecycle, not pairing policy.
///
/// One place mints, so a caller cannot mint a token and then describe it with
/// a TTL, a link shape or a NodeId that does not match what it handed out.
pub fn mint_invite(addr: EndpointAddr, pairing: &Pairing, device: &str) -> PairInvite {
    let node_id = addr.id.to_string();
    let ticket = PairTicket {
        addr,
        token: pairing.mint(),
        device: device.to_string(),
    }
    .to_string();
    PairInvite {
        link: build_pair_link(&ticket),
        ticket,
        node_id,
        device: device.to_string(),
        expires_at: now_unix() + PAIR_TOKEN_TTL_SECS,
    }
}

// ── One-time pairing tokens ────────────────────────────────────────────────

/// Live pairing tokens minted by `remote_pair_begin`. A token is consumed by
/// the first handshake that presents it: a replay of the same link — or a
/// second machine racing for it — finds nothing.
#[derive(Default)]
pub struct Pairing {
    tokens: Mutex<Vec<(u64, [u8; 32])>>,
    /// Pairings waiting for the local human to confirm the fingerprint,
    /// keyed by the other machine's NodeId.
    pending: Mutex<HashMap<String, PendingPair>>,
}

/// A pairing that reached the fingerprint step. Nothing is persisted until
/// the local user accepts it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingPair {
    pub node_id: String,
    pub device: String,
    /// The six words BOTH screens must show.
    pub fingerprint: Vec<String>,
    /// "host" (minted the ticket) or "guest" (opened the link). Display only.
    pub role: String,
    pub created_at: u64,
}

impl Pairing {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a fresh single-use token. The bytes come from a throwaway
    /// ed25519 secret key — 32 bytes straight out of iroh's CSPRNG, which
    /// keeps the random source identical to the one that mints identities
    /// instead of adding a second one.
    pub fn mint(&self) -> [u8; 32] {
        let token = SecretKey::generate().to_bytes();
        let mut tokens = self.sweep();
        tokens.push((now_unix(), token));
        token
    }

    /// Consume a token. `false` for an unknown, expired, or already-used
    /// token — the three are indistinguishable to the caller on purpose.
    pub fn consume(&self, token: &[u8; 32]) -> bool {
        let mut tokens = self.sweep();
        let Some(idx) = tokens.iter().position(|(_, t)| t == token) else {
            return false;
        };
        tokens.remove(idx);
        true
    }

    /// Take the token list with every expired entry already dropped. The TTL
    /// is applied HERE and nowhere else, so no entry point can see a token the
    /// others consider dead.
    fn sweep(&self) -> std::sync::MutexGuard<'_, Vec<(u64, [u8; 32])>> {
        let mut tokens = self.tokens.lock().unwrap_or_else(|p| p.into_inner());
        let now = now_unix();
        tokens.retain(|(minted, _)| now.saturating_sub(*minted) < PAIR_TOKEN_TTL_SECS);
        tokens
    }

    /// How many tokens are still usable. Test-only: nothing in the product
    /// asks, and a live count is exactly the pairing fact worth not logging.
    #[cfg(test)]
    fn live_tokens(&self) -> usize {
        self.sweep().len()
    }

    /// Park a pairing at the fingerprint step.
    pub fn park(&self, pending: PendingPair) {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(pending.node_id.clone(), pending);
    }

    /// Take a parked pairing — `remote_pair_confirm` resolves it exactly once.
    pub fn take(&self, node_id: &str) -> Option<PendingPair> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(node_id)
    }

    pub fn parked(&self) -> Vec<PendingPair> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).values().cloned().collect()
    }
}

// ── Six-word fingerprint ───────────────────────────────────────────────────

/// The six words both machines show. Derived from BLAKE3 over the two
/// NodeIds in SORTED order, so each side computes the same words without
/// caring who dialed whom — and a machine in the middle, which necessarily
/// holds a different key pair on each leg, cannot make the two screens agree.
pub fn fingerprint(a: &EndpointId, b: &EndpointId) -> Vec<String> {
    let (first, second) = {
        let (x, y) = (a.as_bytes(), b.as_bytes());
        if x <= y {
            (x, y)
        } else {
            (y, x)
        }
    };
    let mut material = Vec::with_capacity(64);
    material.extend_from_slice(first);
    material.extend_from_slice(second);
    let digest = Hash::new(&material);
    digest.as_bytes()[..FINGERPRINT_WORDS]
        .iter()
        .map(|byte| WORDS[*byte as usize].to_string())
        .collect()
}

/// 256 short, distinct words — one per byte — drawn from the EFF short-list
/// style (no homophones, no words under three letters that read as noise).
/// The list is frozen: changing an entry changes every fingerprint, so a
/// re-pair would be needed to reconcile two builds.
pub const WORDS: [&str; 256] = [
    "acid", "acorn", "acre", "actor", "afar", "aged", "agent", "aging",
    "aim", "air", "alarm", "album", "alias", "alien", "alike", "alive",
    "alley", "aloe", "alpha", "amber", "amend", "ample", "amuse", "angel",
    "anger", "angle", "ankle", "apple", "apron", "arena", "argue", "arise",
    "armor", "army", "aroma", "arrow", "ashen", "aside", "asset", "atlas",
    "atom", "attic", "audio", "aunt", "avoid", "awake", "award", "awoke",
    "axis", "bacon", "badge", "bagel", "baker", "balmy", "banjo", "barge",
    "basil", "basin", "batch", "baton", "beach", "beam", "bean", "bench",
    "berry", "bike", "bison", "blade", "blank", "blast", "bless", "blimp",
    "blink", "bliss", "block", "blond", "blouse", "blur", "board", "bonus",
    "booth", "boss", "botany", "bowl", "brain", "brand", "brass", "brave",
    "bread", "brick", "brisk", "broad", "bronze", "brook", "broom", "brush",
    "buddy", "bugle", "bulk", "bunch", "bunny", "bush", "cabin", "cable",
    "cache", "cactus", "cadet", "cage", "cake", "calm", "camel", "canal",
    "candy", "canoe", "canvas", "cargo", "carol", "carry", "cart", "carve",
    "case", "cave", "cedar", "cell", "chain", "chalk", "charm", "chase",
    "cheek", "cheer", "chess", "chest", "chief", "chili", "chill", "chip",
    "chirp", "choir", "chop", "chore", "chosen", "chrome", "chunk", "churn",
    "cider", "cinema", "circle", "city", "civic", "claim", "clamp", "clang",
    "clash", "clasp", "class", "clay", "clean", "clerk", "cliff", "climb",
    "cling", "cloak", "clock", "clone", "cloth", "cloud", "clover", "club",
    "clump", "coach", "coast", "cobra", "cocoa", "comet", "comic", "coral",
    "corn", "cost", "cove", "cozy", "crack", "craft", "cramp", "crane",
    "crate", "crawl", "crazy", "creek", "crepe", "crest", "crib", "crisp",
    "croak", "crop", "cross", "crowd", "crown", "crumb", "crush", "crust",
    "cube", "cuff", "curb", "curl", "curve", "cycle", "daily", "dairy",
    "daisy", "dance", "dandy", "darts", "dash", "dawn", "debit", "debug",
    "decaf", "decal", "decay", "deck", "decoy", "deed", "deer", "delay",
    "delta", "demo", "dense", "dent", "depth", "derby", "desk", "detail",
    "devil", "dial", "diary", "dice", "diet", "dime", "diner", "dingo",
    "dirt", "disco", "ditch", "dive", "dizzy", "dock", "dodge", "dole",
    "donor", "donut", "doodle", "dose", "dot", "dough", "dove", "dozen",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &tempfile::TempDir) -> PeerStore {
        PeerStore::load(dir.path())
    }

    fn id(seed: u8) -> EndpointId {
        SecretKey::from_bytes(&[seed; 32]).public()
    }

    // ── Peer store CRUD ────────────────────────────────────────────────────

    #[test]
    fn store_starts_empty_and_round_trips_through_disk() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = store(&dir);
        assert!(s.list().is_empty());
        assert!(s.is_empty());

        s.seed("nodeA", "Mac Studio").unwrap();
        assert_eq!(s.list().len(), 1);

        // A fresh load sees the persisted entry — this is what survives a
        // relaunch.
        let reloaded = store(&dir);
        let peer = reloaded.get("nodeA").expect("persisted");
        assert_eq!(peer.device, "Mac Studio");
        assert!(peer.paired_at > 0);
    }

    #[test]
    fn refresh_device_updates_the_name_and_never_inserts() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = store(&dir);
        s.seed("nodeA", "Mac Studio").unwrap();
        assert!(s.refresh_device("nodeA", "Mac Studio (renamed)").unwrap());
        let peer = s.get("nodeA").unwrap();
        assert_eq!(peer.device, "Mac Studio (renamed)");
        assert_eq!(s.list().len(), 1, "refresh must not duplicate");
    }

    #[test]
    fn a_peers_file_written_under_the_three_tier_model_still_trusts_its_devices() {
        // Written BY HAND in the exact shape the previous build produced, with
        // the `scope` and `last_ack_scope` keys this build no longer has.
        // `PeerStore::load` treats a document it cannot parse as EMPTY, so a
        // build that refused unknown keys would revoke every pairing on every
        // existing install at the next launch.
        let dir = tempfile::TempDir::new().unwrap();
        let previous_build = r#"{"v":1,"peers":[{"node_id":"nodeA","device":"iPhone","scope":"control","paired_at":10,"last_seen":20,"last_ack_scope":"browse"}]}"#;
        std::fs::write(dir.path().join("peers.json"), previous_build).unwrap();

        let s = store(&dir);
        assert_eq!(s.load_error(), None, "a document this build reads is not a load error");
        let peer = s.get("nodeA").expect("the pairing survives the upgrade");
        assert_eq!(peer.paired_at, 10);
        assert_eq!(peer.last_seen, 20);

        // The next rewrite drops the keys it does not know.
        assert!(s.refresh_device("nodeA", "iPhone").unwrap());
        let raw = std::fs::read_to_string(dir.path().join("peers.json")).unwrap();
        assert!(!raw.contains("scope"), "the old grant keys do not survive a rewrite: {raw}");
    }

    #[test]
    fn a_revoked_peer_is_never_re_created_by_a_handshake_refresh() {
        // The revocation race: `ScopeServer::accept` checks the allowlist,
        // then awaits the peer's `Hello` for up to HANDSHAKE_TIMEOUT, then
        // refreshes the stored name. An insert-or-update writer there let a
        // peer revoked inside that window write itself back — a revocation
        // the peer could undo by stalling its `Hello`.
        let dir = tempfile::TempDir::new().unwrap();
        let s = store(&dir);
        s.seed("nodeA", "iPhone").unwrap();
        assert!(s.remove("nodeA").unwrap());

        assert!(
            !s.refresh_device("nodeA", "iPhone").unwrap(),
            "a refresh must report the peer is gone, not re-create it"
        );
        assert!(s.get("nodeA").is_none(), "still revoked in memory");
        assert!(store(&dir).get("nodeA").is_none(), "and still revoked on disk");
    }

    #[test]
    fn a_write_that_cannot_reach_disk_grants_nothing_in_memory_either() {
        // The in-memory list IS the handshake allowlist, so a refused write
        // must not leave a device trusted while the caller is told it failed.
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("peers.json"), "{not json").unwrap();
        let s = store(&dir);
        assert!(s.load_error().is_some(), "the store must have refused to load");

        assert!(s.confirm("nodeA", "iPhone").is_err());
        assert!(s.get("nodeA").is_none(), "a failed confirm trusts nobody");
        assert!(s.list().is_empty());
    }

    #[test]
    fn confirm_refreshes_the_name_and_never_duplicates() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = store(&dir);
        s.confirm("nodeA", "iPhone").unwrap();
        let kept = s.confirm("nodeA", "iPhone (renamed)").unwrap();
        assert_eq!(kept.device, "iPhone (renamed)");
        assert_eq!(s.list().len(), 1, "confirm must not duplicate");
        assert_eq!(store(&dir).get("nodeA").unwrap().device, "iPhone (renamed)");
    }

    #[test]
    fn confirm_preserves_the_original_pairing_timestamp() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = store(&dir);
        let first = s.confirm("nodeA", "iPhone").unwrap();
        let again = s.confirm("nodeA", "iPhone").unwrap();
        assert_eq!(again.paired_at, first.paired_at, "re-pairing is not a new pairing");
    }

    #[test]
    fn revocation_is_deleting_the_entry() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = store(&dir);
        s.seed("nodeA", "Mac Studio").unwrap();
        assert!(s.remove("nodeA").unwrap());
        assert!(s.get("nodeA").is_none(), "a revoked peer fails the allowlist check");
        assert!(!s.remove("nodeA").unwrap(), "removing twice is not an error");
        assert!(store(&dir).get("nodeA").is_none(), "revocation survives a reload");
    }

    #[test]
    fn a_newer_schema_document_trusts_nobody_and_is_left_alone() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("peers.json");
        let future = r#"{"v":99,"peers":[{"node_id":"x","device":"d","scope":"control","paired_at":1,"last_seen":1}]}"#;
        std::fs::write(&path, future).unwrap();
        let s = store(&dir);
        assert!(s.get("x").is_none(), "an unreadable grant is not a grant");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), future, "never rewritten");
    }

    #[test]
    fn a_corrupt_document_trusts_nobody() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("peers.json"), "{not json").unwrap();
        assert!(store(&dir).list().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn peers_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::TempDir::new().unwrap();
        store(&dir).seed("nodeA", "d").unwrap();
        let mode = std::fs::metadata(dir.path().join("peers.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // ── One-time tokens ────────────────────────────────────────────────────

    #[test]
    fn a_pairing_token_works_exactly_once() {
        let pairing = Pairing::new();
        let token = pairing.mint();
        assert!(pairing.consume(&token), "first use pairs");
        assert!(!pairing.consume(&token), "a replayed link finds nothing");
        assert_eq!(pairing.live_tokens(), 0);
    }

    #[test]
    fn tokens_are_unique_and_unknown_tokens_are_refused() {
        let pairing = Pairing::new();
        let a = pairing.mint();
        let b = pairing.mint();
        assert_ne!(a, b);
        assert!(!pairing.consume(&[0u8; 32]));
        assert_eq!(pairing.live_tokens(), 2);
        // Consuming one leaves the other usable.
        assert!(pairing.consume(&a));
        assert!(pairing.consume(&b));
    }

    #[test]
    fn parked_pairings_resolve_exactly_once() {
        let pairing = Pairing::new();
        pairing.park(PendingPair {
            node_id: "nodeA".into(),
            device: "Mac Studio".into(),
            fingerprint: vec!["acid".into()],
            role: "host".into(),
            created_at: now_unix(),
        });
        assert_eq!(pairing.parked().len(), 1);
        assert!(pairing.take("nodeA").is_some());
        assert!(pairing.take("nodeA").is_none(), "confirm resolves a pairing once");
    }

    // ── Fingerprint ────────────────────────────────────────────────────────

    #[test]
    fn fingerprint_is_deterministic_and_symmetric() {
        let (a, b) = (id(1), id(2));
        let from_a = fingerprint(&a, &b);
        let from_b = fingerprint(&b, &a);
        assert_eq!(from_a, from_b, "both screens must show the same words");
        assert_eq!(from_a, fingerprint(&a, &b), "and the same words every time");
        assert_eq!(from_a.len(), FINGERPRINT_WORDS);
    }

    #[test]
    fn a_different_peer_produces_different_words() {
        let (a, b, c) = (id(1), id(2), id(3));
        // The man-in-the-middle case: the two legs hold different keys, so
        // the two screens cannot agree.
        assert_ne!(fingerprint(&a, &b), fingerprint(&a, &c));
    }

    #[test]
    fn the_wordlist_is_a_full_distinct_byte_map() {
        assert_eq!(WORDS.len(), 256);
        let unique: std::collections::HashSet<&str> = WORDS.iter().copied().collect();
        assert_eq!(unique.len(), 256, "a repeated word would blur two fingerprints");
        assert!(WORDS.iter().all(|w| w.chars().all(|c| c.is_ascii_lowercase())));
    }

    // ── Pair ticket ────────────────────────────────────────────────────────

    #[test]
    fn pair_ticket_round_trips_and_stays_alphanumeric() {
        let addr = EndpointAddr::from(id(7));
        let ticket = PairTicket { addr: addr.clone(), token: [9u8; 32], device: "Mac Studio".into() };
        let encoded = ticket.to_string();
        assert!(
            encoded.chars().all(|c| c.is_ascii_alphanumeric()),
            "the deep-link parser only admits alphanumeric tickets: {encoded}"
        );
        let back: PairTicket = encoded.parse().expect("re-parse");
        assert_eq!(back, ticket);
        assert_eq!(back.addr.id, addr.id);
    }

    #[test]
    fn pair_ticket_rejects_garbage_and_foreign_kinds() {
        assert!("".parse::<PairTicket>().is_err());
        assert!("notaticket".parse::<PairTicket>().is_err());
        // A blob ticket is not a pairing ticket, even though both are base32.
        let blob = iroh_blobs::ticket::BlobTicket::new(
            id(4).into(),
            iroh_blobs::Hash::new(b"x"),
            iroh_blobs::BlobFormat::Raw,
        )
        .to_string();
        assert!(blob.parse::<PairTicket>().is_err());
    }

    #[test]
    fn a_hostile_device_name_in_a_ticket_is_sanitized_on_decode() {
        let ticket = PairTicket {
            addr: EndpointAddr::from(id(7)),
            token: [1u8; 32],
            device: "Mac\u{202E}Studio".into(),
        };
        let back: PairTicket = ticket.to_string().parse().unwrap();
        assert_eq!(back.device, "MacStudio");
    }

    #[test]
    fn pair_link_has_the_documented_shape() {
        assert_eq!(build_pair_link("TICKET"), "skypie://pair?ticket=TICKET");
    }

    #[test]
    fn mint_invite_hands_out_a_token_that_is_actually_live() {
        let pairing = Pairing::new();
        let invite = mint_invite(EndpointAddr::from(id(7)), &pairing, "Mac Studio");

        assert_eq!(invite.node_id, id(7).to_string());
        assert_eq!(invite.device, "Mac Studio");
        assert_eq!(invite.link, build_pair_link(&invite.ticket));
        assert!(invite.expires_at > now_unix(), "the link must not be born dead");

        // The described ticket IS the minted one: decoding the link's ticket
        // yields a token this `Pairing` accepts, exactly once.
        let decoded: PairTicket = invite.ticket.parse().expect("own ticket re-parses");
        assert_eq!(decoded.device, "Mac Studio");
        assert_eq!(pairing.live_tokens(), 1);
        assert!(pairing.consume(&decoded.token));
        assert!(!pairing.consume(&decoded.token));
    }

    // ── Short ids ──────────────────────────────────────────────────────────

    #[test]
    fn short_id_matches_iroh_fmt_short_and_never_panics() {
        let node = id(3);
        assert_eq!(short_id(&node.to_string()), node.fmt_short().to_string());
        assert_eq!(short_id(&node.to_string()).len(), 10);
        // A truncated entry read off disk must not slice past its end.
        assert_eq!(short_id("abc"), "abc");
        assert_eq!(short_id(""), "");
    }
}
