// What this Mac has SHARED — the pull-side answer to "send a file to my
// phone".
//
// PRODUCT.md principle 4 says remote access is read-only: a peer fetches what
// the user could already see, and nothing is ever written to a peer. So the
// Mac does not send. It records that a file was shared, the phone lists that
// when it foregrounds, and the bytes move only when the user taps one.
//
// That inversion is what lets this exist at all. A push needs a listener, and
// an iOS app has no network endpoint while backgrounded — which is why the
// outbox and its drainer were deleted on 2026-09-12 (commit f78310a). Asking
// at foreground needs no listener, no wake-up and no server.
//
// ── Why ONE list, not one per peer ──────────────────────────────────────────
//
// `build_open_link(path, from)` puts the HOST's node id in `from`: a share
// link names its source and never a destination, and the action is called
// "Copy link for my devices", plural. So the fact recorded here has exactly
// one dimension — the user shared this file — and keying it per peer
// denormalised a fact with no peer dimension. It also produced a real bug: a
// device paired AFTER a share saw nothing, though the link worked for it.
//
// Nothing needs forgetting on unpair, either. An unpaired device cannot open
// a session, so it can never call `ListShared`; the handshake allowlist is
// the boundary, not this file.
//
// Storage lives beside the peer list in the app's own state directory, never
// in the user's tree, and is written with the same private-atomic discipline
// as `peers.json`: it holds absolute paths of the user's files.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use skypie_remote::proto::SharedEntry;

/// One shared file as persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Offer {
    pub path: String,
    pub name: String,
    pub shared_at: u64,
}

/// The on-disk document.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Doc {
    /// Newest LAST as appended; reversed on read.
    #[serde(default)]
    shared: Vec<Offer>,
}

#[derive(Debug)]
pub struct OfferStore {
    path: PathBuf,
    doc: Mutex<Doc>,
}

impl OfferStore {
    /// Cap on stored offers.
    ///
    /// The FRAME cap (`MAX_SHARED_ENTRIES`, 200) bounds one answer; this
    /// bounds the store, so a year of sharing does not grow a file forever.
    /// Fifty is a list a person scrolls, not an archive they search.
    const MAX_OFFERS: usize = 50;

    /// Load from `<remote_dir>/shared.json`, tolerating a missing or corrupt
    /// file: an unreadable list must not stop the app from starting, and the
    /// worst case is that the phone sees nothing waiting.
    pub fn load(remote_dir: &Path) -> Self {
        let path = remote_dir.join("shared.json");
        let doc = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Doc>(&s).ok())
            .unwrap_or_default();
        Self { path, doc: Mutex::new(doc) }
    }

    /// Newest-first.
    pub fn list(&self) -> Vec<SharedEntry> {
        let Ok(doc) = self.doc.lock() else { return Vec::new() };
        doc.shared
            .iter()
            .rev()
            .map(|o| SharedEntry {
                path: o.path.clone(),
                name: o.name.clone(),
                shared_at: o.shared_at,
            })
            .collect()
    }

    /// Record that the user shared `path`.
    ///
    /// Replace-and-promote, not append: sharing the same file twice moves the
    /// existing entry to the top instead of listing it twice. The list is
    /// "things waiting for you", and the same file waiting twice is not two
    /// things.
    ///
    /// Note what is deliberately absent: any notion of "delivered". A peer
    /// cannot tell this Mac that it fetched something — that would be a peer
    /// writing to the host, which principle 4 forbids, and it is the same
    /// rule that killed push. So an entry leaves this list by being pushed
    /// off the end by newer ones. Never by being read.
    pub fn record(&self, path: &str) {
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
        let offer = Offer {
            path: path.to_string(),
            name,
            shared_at: skypie_ipc::now_unix(),
        };
        let Ok(mut doc) = self.doc.lock() else { return };
        doc.shared.retain(|o| o.path != offer.path);
        doc.shared.push(offer);
        // Newest are at the END, so the overflow to drop is at the FRONT.
        if doc.shared.len() > Self::MAX_OFFERS {
            let excess = doc.shared.len() - Self::MAX_OFFERS;
            doc.shared.drain(..excess);
        }
        self.persist(&doc);
    }

    /// Same discipline as `peers.json`: tmp + rename at 0600. A crash
    /// mid-write would otherwise truncate the file, and `load` would then
    /// silently start from empty and overwrite the survivors.
    fn persist(&self, doc: &Doc) {
        let Ok(json) = serde_json::to_string_pretty(doc) else { return };
        if let Err(e) = skypie_remote::paths::write_private_atomic(&self.path, json.as_bytes()) {
            eprintln!("skypie: could not persist the shared list: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, OfferStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = OfferStore::load(dir.path());
        (dir, store)
    }

    #[test]
    fn a_shared_file_is_listed() {
        let (_d, s) = store();
        s.record("/w/report.html");
        assert_eq!(s.list().len(), 1);
        assert_eq!(s.list()[0].name, "report.html");
    }

    #[test]
    fn newest_is_first() {
        let (_d, s) = store();
        s.record("/w/one.html");
        s.record("/w/two.html");
        let names: Vec<_> = s.list().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["two.html", "one.html"]);
    }

    #[test]
    fn re_sharing_promotes_rather_than_duplicates() {
        let (_d, s) = store();
        s.record("/w/a.html");
        s.record("/w/b.html");
        s.record("/w/a.html");
        let names: Vec<_> = s.list().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["a.html", "b.html"], "the same file waiting twice is not two things");
    }

    #[test]
    fn the_store_is_capped_and_drops_the_oldest() {
        let (_d, s) = store();
        for i in 0..(OfferStore::MAX_OFFERS + 10) {
            s.record(&format!("/w/f{i}.html"));
        }
        let list = s.list();
        assert_eq!(list.len(), OfferStore::MAX_OFFERS);
        assert_eq!(list[0].name, format!("f{}.html", OfferStore::MAX_OFFERS + 9), "newest kept");
        assert_eq!(list[list.len() - 1].name, "f10.html", "oldest dropped");
    }

    #[test]
    fn a_device_paired_after_a_share_still_sees_it() {
        // The bug the per-peer model had: an offer recorded before a device
        // paired was invisible to it, though the share LINK worked for it.
        // One list has no such blind spot — there is no peer dimension to
        // miss.
        let (_d, s) = store();
        s.record("/w/shared-before-you-paired.html");
        assert_eq!(s.list().len(), 1);
    }

    #[test]
    fn offers_survive_a_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        OfferStore::load(dir.path()).record("/w/a.html");
        assert_eq!(OfferStore::load(dir.path()).list().len(), 1);
    }

    #[test]
    fn the_file_is_private() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().expect("tempdir");
            let s = OfferStore::load(dir.path());
            s.record("/w/a.html");
            let mode = std::fs::metadata(dir.path().join("shared.json"))
                .expect("written")
                .permissions()
                .mode()
                & 0o777;
            // It holds absolute paths of the user's files, same class as
            // peers.json.
            assert_eq!(mode, 0o600, "the shared list must not be world-readable");
        }
    }

    #[test]
    fn a_corrupt_document_loads_as_empty_rather_than_failing() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("shared.json"), "{ not json").unwrap();
        assert!(OfferStore::load(dir.path()).list().is_empty());
    }
}
