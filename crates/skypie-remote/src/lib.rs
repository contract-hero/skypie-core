// skypie-remote — the Tauri-free core of Beam (share a file with anyone who
// holds the link) and Scope (pull a file from one of the user's own paired
// devices), over iroh.
//
// This crate is the whole networked surface: identity, endpoint lifecycle, the
// wire protocol, the trusted-peer store and the request gate. It knows nothing
// about a webview, a window, or an application-support directory — the app
// passes a `Dirs` base and implements one seam (`EventSink`).
//
// Invariants that must survive any refactor of this crate:
//   1. a paired peer may read only an existing regular file it named, under
//      the transfer cap, and only through a peer-locked grant;
//   2. the scope server refuses a NodeId that is not in peers.json before it
//      parses a single request byte;
//   3. iroh / iroh-blobs / iroh-tickets are exact-pinned, and all of their
//      types stay behind endpoint.rs, beam.rs and scope.rs.

pub mod beam;
pub mod endpoint;
pub mod host;
pub mod paths;
pub mod peers;
pub mod proto;
pub mod resolve;
pub mod scope;
pub mod security;

pub use host::{EventSink, HostSignal};
pub use paths::{Dirs, DEFAULT_IGNORED};

/// This machine's human-readable name, announced in every handshake
/// (design §4). The hostname is the machine's own answer to "which machine is
/// this"; an unreadable one falls back to the product name rather than
/// leaking an empty string onto the other screen.
pub fn device_name() -> String {
    let mut buf = [0i8; 256];
    // SAFETY: `gethostname` writes at most `len` bytes into the buffer and
    // NUL-terminates when it fits. The buffer outlives the read below.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr(), buf.len() - 1) } == 0;
    if ok {
        let bytes: Vec<u8> = buf
            .iter()
            .take_while(|b| **b != 0)
            .map(|b| *b as u8)
            .collect();
        if let Ok(name) = String::from_utf8(bytes) {
            let trimmed = name.trim_end_matches(".local").trim();
            if !trimmed.is_empty() {
                return proto::sanitize_device(trimmed);
            }
        }
    }
    "Sky Pie".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_device_name_is_never_empty_and_is_already_sanitized() {
        let name = device_name();
        assert!(!name.is_empty());
        assert_eq!(name, proto::sanitize_device(&name));
    }
}
