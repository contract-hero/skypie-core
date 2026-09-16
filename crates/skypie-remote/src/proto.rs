// Scope wire protocol. Pure serde + postcard: no iroh types, no I/O — the
// framing helpers that touch a QUIC stream live in scope.rs, so every shape
// here is testable without an endpoint.
//
// Framing: one QUIC bi-stream per session carries length-prefixed postcard
// frames (u32 little-endian length, then the postcard body). The client
// writes `Req` frames; the server answers each with one `Res` frame, in
// order.
//
// Versioning: postcard identifies enum variants BY DECLARATION ORDER, so
// appending a variant is compatible and reordering is a break. `PROTO_VERSION`
// is the explicit break mechanism — `Hello` carries it and the server refuses
// a mismatch before answering anything else. The ALPN's trailing integer is
// the second, coarser one: `/1` is the single-tier pull protocol, and a `/0`
// peer never reaches a frame.

use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// Session protocol ALPN. Bumping the trailing integer is the transport-level
/// protocol break; `PROTO_VERSION` is the fine-grained one.
pub const SCOPE_ALPN: &[u8] = b"skypie/scope/1";

/// Pairing runs on its OWN ALPN. The scope server rejects every NodeId that
/// is not already in peers.json before it parses a byte, which is
/// exactly the check a first-time peer cannot pass — so the pairing handshake,
/// whose capability is the one-time token instead of the peer list, needs a
/// separate door.
pub const PAIR_ALPN: &[u8] = b"skypie/pair/1";

/// Wire version carried in `Hello` / `PairHello`. A mismatch is refused.
///
/// Bumped to 2 for `Req::ListShared`. The bump is not cosmetic: postcard
/// identifies a variant by declaration order, so a build that predates
/// `ListShared` cannot DECODE the frame — `read_frame::<Req>` fails, `serve`
/// returns `Err`, and the connection dies. Left at 1, an old peer would pass
/// the handshake and then drop its session the first time the new peer asked
/// what was shared, showing an empty list and flipping to offline with
/// nothing to re-dial.
///
/// At 2 the mismatch is caught where it is legible: the handshake answers
/// `Denied("unsupported protocol version")` and closes with `CLOSE_REFUSED`,
/// which `ConnectError` already reports as "refused" rather than "offline".
/// Both ends must be on this build — which for a personal two-device pairing
/// is the honest contract, and is what the user already does when they
/// install the app on both.
pub const PROTO_VERSION: u32 = 2;

/// Frames carry metadata only — artifact bytes ride the iroh-blobs protocol.
/// The cap bounds what one hostile frame header can make us allocate.
pub const MAX_FRAME_BYTES: usize = 256 * 1024;

/// Longest device name accepted from the wire, in chars. Display-only text
/// from another machine: bounded and stripped like a beam name hint.
pub const MAX_DEVICE_CHARS: usize = 64;

// ── Requests (client → host) ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Req {
    /// Always the first frame. Rejected on version mismatch.
    Hello { proto: u32, device: String },
    /// Answers hash/size/mtime only; the bytes move over iroh-blobs.
    GetArtifact { path: String },
    // ── Annotations ─────────────────────────────────────────────────────
    // APPENDED, never inserted: postcard identifies a variant by declaration
    // order, so adding at the end is compatible and reordering is a break.
    /// Read the host's comments on one of its files.
    GetAnnotations { path: String },
    /// Append comments to the host's store for one of its files.
    ///
    /// The FIRST write path over this wire. It is bounded on every axis the
    /// design allows: paired peers only (the connection already proved that),
    /// one target per frame, `MAX_ANNOTATION_ENTRIES` lines, each under
    /// `MAX_ANNOTATION_BYTES`, append-only, landing in the host's state
    /// directory and never in its tree. A peer can add to what the user sees;
    /// it can never edit or delete what is already there.
    PutAnnotations {
        path: String,
        /// One JSON object per entry, verbatim. Opaque here on purpose: the
        /// transport crate has no business knowing the annotation schema, and
        /// the host validates every line before it is stored.
        entries: Vec<String>,
    },
    /// What has the host offered THIS peer? Metadata only; no bytes move.
    ///
    /// The pull-side answer to "send a file to my phone". The host records an
    /// intent to share when the user shares a link for a device; the device
    /// asks for that list when it next comes to the foreground, and fetches
    /// with `GetArtifact` only when the user taps one. Nothing is queued and
    /// nothing is delivered: the host offers, the peer decides.
    ///
    /// No arguments on purpose — a peer may ask only what was offered to IT,
    /// and the connection already proved which peer it is.
    ListShared,
}

// ── Responses (host → client) ───────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Res {
    Hello(HelloAck),
    Artifact(ArtifactMeta),
    /// Every refusal — path, size — with the no-existence-leak wording of the
    /// share module. One variant so the client cannot tell a missing file
    /// from a refused one.
    Denied(String),
    // Appended; see the note on `Req`.
    /// The host's comments on one file, one JSON object per entry.
    Annotations(AnnotationPage),
    /// How many of a `PutAnnotations` frame's entries were new.
    Merged { added: usize },
    /// The answer to `ListShared`.
    Shared(SharedPage),
}

/// Cap on entries in one `Shared` frame.
///
/// A share list is what the user pointed at their own phone, not a catalogue.
/// The cap bounds the frame the same way `MAX_ANNOTATION_ENTRIES` bounds a
/// review pass.
pub const MAX_SHARED_ENTRIES: usize = 200;

/// One file the host has offered this peer. Metadata only — the bytes still
/// move over `GetArtifact` + iroh-blobs, and only if the user asks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedEntry {
    /// Absolute path on the HOST. Opaque to the peer: it is what a later
    /// `GetArtifact` names, and the host re-validates it then. Listing a path
    /// grants nothing the peer could not already fetch by link.
    pub path: String,
    /// Basename, for a list the user reads. Sent rather than derived so the
    /// peer never has to parse a foreign platform's path separators.
    pub name: String,
    /// Unix seconds when the user shared it. The list is newest-first.
    pub shared_at: u64,
}

/// The answer to `ListShared`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedPage {
    /// Newest first, at most `MAX_SHARED_ENTRIES`.
    pub entries: Vec<SharedEntry>,
    /// True when the host had more and sent a prefix, so the peer can say so
    /// instead of implying the list is complete.
    ///
    /// Unreachable from THIS app today: its store caps at 50, well under
    /// `MAX_SHARED_ENTRIES`. The flag stays because the cap belongs to the
    /// protocol, not to one implementation — a host that raises its store cap,
    /// or a different implementation entirely, must still be able to say "there
    /// is more" rather than quietly truncate.
    pub truncated: bool,
}

/// Cap on entries in one annotations frame, in either direction.
///
/// A review pass is tens of comments, not thousands. The cap is what stops a
/// paired-but-compromised device from growing the host's store without bound
/// through a write path that is otherwise unauthenticated beyond pairing.
pub const MAX_ANNOTATION_ENTRIES: usize = 500;

/// Cap on one entry. `MAX_BODY_CHARS` in the store is 10k; this leaves room
/// for the selectors and the envelope around it.
pub const MAX_ANNOTATION_BYTES: usize = 64 * 1024;

/// The answer to `GetAnnotations`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnnotationPage {
    /// One JSON object per entry, as stored.
    pub entries: Vec<String>,
    /// True when the host had more than `MAX_ANNOTATION_ENTRIES` and sent a
    /// prefix. A prefix is not a set: the app's reconcile merges what it got
    /// and pushes nothing on such a page, because a set difference against a
    /// prefix would re-send every entry past the cut on every pass. An
    /// addressable page is the follow-up recorded in STATUS.md.
    pub truncated: bool,
}

/// Reject an entry list before it is sent or stored.
///
/// Pure, and shared by both ends: the client refuses to send a frame the host
/// would refuse to store, so a bad push fails locally with a message the user
/// can act on instead of as an opaque `Denied`.
pub fn check_entries(entries: &[String]) -> Result<(), String> {
    if entries.is_empty() {
        return Err("nothing to send".to_string());
    }
    if entries.len() > MAX_ANNOTATION_ENTRIES {
        return Err(format!(
            "too many comments in one message (max {MAX_ANNOTATION_ENTRIES})"
        ));
    }
    for e in entries {
        if e.len() > MAX_ANNOTATION_BYTES {
            return Err("a comment is too large to send".to_string());
        }
        // One entry per line is the store's whole framing. An embedded
        // newline would split one comment into two unparseable halves on
        // the far side.
        if e.contains('\n') {
            return Err("a comment contains a line break and cannot be framed".to_string());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloAck {
    pub proto: u32,
    pub device: String,
}

/// The answer to `GetArtifact`: a content address plus display facts. The
/// bytes are fetched by `hash` over iroh-blobs, verified there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactMeta {
    /// BLAKE3 hash, hex.
    pub hash: String,
    pub size: u64,
    /// Unix seconds; 0 when the host cannot read a modification time.
    pub mtime: u64,
    /// The host crossed its soft size threshold. The host owns the limits;
    /// the client never mirrors the constant.
    pub warn: bool,
}

// ── Pairing handshake (its own ALPN, its own tiny protocol) ─────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairHello {
    pub proto: u32,
    /// The one-time token from the pairing ticket. Possession of a live token
    /// is what admits an unknown NodeId here.
    pub token: [u8; 32],
    pub device: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairAck {
    Ok { proto: u32, device: String },
    Denied(String),
}

// ── Framing ────────────────────────────────────────────────────────────────

/// Encode one frame: u32-LE length prefix + postcard body.
pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let body = postcard::to_stdvec(value).map_err(|e| format!("cannot encode frame: {e}"))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err("frame exceeds the protocol size cap".to_string());
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// Decode one frame body (the bytes AFTER the length prefix).
pub fn decode_frame<T: DeserializeOwned>(body: &[u8]) -> Result<T, String> {
    postcard::from_bytes(body).map_err(|e| format!("cannot decode frame: {e}"))
}

/// Read a length prefix and validate it against the cap. Returns the body
/// length the caller must read next.
pub fn frame_len(prefix: [u8; 4]) -> Result<usize, String> {
    let len = u32::from_le_bytes(prefix) as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err("frame exceeds the protocol size cap".to_string());
    }
    Ok(len)
}

/// Drop every character that must not survive into display text or an on-disk
/// name, then bound the length to `max_chars`. Two classes go: Cc control
/// characters, and the Cf bidi / zero-width set a U+202E extension spoof rides
/// on (`report<RLO>gnp.html` renders as `reporthtml.png`).
///
/// The ONE strip set in the crate. Both hostile strings a peer can hand us —
/// the device name here and the beam name hint — pass through it, and each
/// caller adds only its own trimming and fallback on top; a second copy is how
/// one of them silently stops stripping a character the other does.
pub fn strip_spoofing_chars(s: &str, max_chars: usize) -> String {
    s.chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c,
                    '\u{200B}'..='\u{200F}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{FEFF}')
        })
        .take(max_chars)
        .collect()
}

/// Reduce an attacker-controlled device name to safe display text: no control
/// characters, no bidi/zero-width spoofing, bounded length. Same distrust the
/// beam name hint gets — this string lands in the peer list and the drawer
/// header.
pub fn sanitize_device(name: &str) -> String {
    let cleaned = strip_spoofing_chars(name, MAX_DEVICE_CHARS);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "unknown device".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_shared_is_the_last_request_variant() {
        // postcard identifies a variant by declaration ORDER, so appending is
        // compatible and reordering is a silent break: an old peer would
        // decode the wrong variant rather than fail. This pins the tag so a
        // future insertion in the middle fails here instead of on someone's
        // phone.
        let bytes = encode_frame(&Req::ListShared).expect("encode");
        assert_eq!(bytes[4], 4, "ListShared must stay variant index 4");

        // And the version must move with the wire, or an old peer pairs and
        // then dies on the first frame it cannot decode.
        assert!(PROTO_VERSION >= 2, "ListShared requires PROTO_VERSION >= 2");
    }

    #[test]
    fn req_and_res_round_trip_through_postcard() {
        let reqs = vec![
            Req::Hello { proto: PROTO_VERSION, device: "Mac Studio".into() },
            Req::GetArtifact { path: "/w/project/report.html".into() },
            Req::ListShared,
        ];
        for req in reqs {
            let bytes = encode_frame(&req).expect("encode");
            let len = frame_len(bytes[..4].try_into().unwrap()).expect("length prefix");
            assert_eq!(len, bytes.len() - 4);
            let back: Req = decode_frame(&bytes[4..]).expect("decode");
            assert_eq!(back, req);
        }
        let ress = vec![
            Res::Hello(HelloAck { proto: PROTO_VERSION, device: "MacBook".into() }),
            Res::Artifact(ArtifactMeta {
                hash: "ab".repeat(32),
                size: 42,
                mtime: 1_786_752_000,
                warn: false,
            }),
            Res::Denied("path not found or out of root".into()),
            Res::Shared(SharedPage {
                entries: vec![SharedEntry {
                    path: "/w/project/report.html".into(),
                    name: "report.html".into(),
                    shared_at: 1_786_752_000,
                }],
                truncated: false,
            }),
        ];
        for res in ress {
            let bytes = encode_frame(&res).expect("encode");
            let back: Res = decode_frame(&bytes[4..]).expect("decode");
            assert_eq!(back, res);
        }
    }

    #[test]
    fn the_alpns_name_the_single_tier_protocol() {
        // A `/0` peer speaks the three-tier protocol; the trailing integer is
        // what keeps it from ever decoding a frame of this one.
        assert_eq!(SCOPE_ALPN, b"skypie/scope/1");
        assert_eq!(PAIR_ALPN, b"skypie/pair/1");
    }

    #[test]
    fn a_hello_from_another_protocol_version_is_distinguishable() {
        // The version rejection the server performs: same bytes decode, the
        // carried number is what refuses the session.
        let future = Req::Hello { proto: PROTO_VERSION + 1, device: "x".into() };
        let bytes = encode_frame(&future).unwrap();
        match decode_frame::<Req>(&bytes[4..]).unwrap() {
            Req::Hello { proto, .. } => assert_ne!(proto, PROTO_VERSION),
            other => panic!("expected Hello, got {other:?}"),
        }
    }

    #[test]
    fn oversized_and_zero_length_prefixes_are_refused() {
        assert!(frame_len((MAX_FRAME_BYTES as u32 + 1).to_le_bytes()).is_err());
        assert!(frame_len(u32::MAX.to_le_bytes()).is_err());
        assert!(frame_len(0u32.to_le_bytes()).is_err());
        assert!(frame_len(1u32.to_le_bytes()).is_ok());
    }

    #[test]
    fn garbage_bodies_fail_to_decode_instead_of_panicking() {
        assert!(decode_frame::<Req>(&[0xff, 0xff, 0xff]).is_err());
        assert!(decode_frame::<Res>(&[]).is_err());
    }

    #[test]
    fn oversized_payloads_are_refused_at_encode_time() {
        let huge = Req::GetArtifact { path: "x".repeat(MAX_FRAME_BYTES + 1) };
        assert!(encode_frame(&huge).is_err());
    }

    #[test]
    fn device_names_are_sanitized_like_beam_name_hints() {
        assert_eq!(sanitize_device("Mac Studio"), "Mac Studio");
        assert_eq!(sanitize_device("Mac\u{202E}Studio"), "MacStudio");
        assert_eq!(sanitize_device("a\0b"), "ab");
        assert_eq!(sanitize_device("   "), "unknown device");
        assert_eq!(sanitize_device(&"x".repeat(500)).chars().count(), MAX_DEVICE_CHARS);
    }
}

#[cfg(test)]
mod annotation_frame_tests {
    use super::*;

    fn entry(n: usize) -> String {
        format!(r#"{{"id":"{n}","body":{{"value":"hi"}}}}"#)
    }

    #[test]
    fn a_reasonable_review_pass_is_accepted() {
        let entries: Vec<String> = (0..40).map(entry).collect();
        assert!(check_entries(&entries).is_ok());
    }

    #[test]
    fn an_empty_message_is_refused_rather_than_sent() {
        assert!(check_entries(&[]).is_err());
    }

    #[test]
    fn a_flood_is_capped() {
        let entries: Vec<String> = (0..MAX_ANNOTATION_ENTRIES + 1).map(entry).collect();
        let err = check_entries(&entries).unwrap_err();
        assert!(err.contains("too many"), "{err}");
    }

    #[test]
    fn one_oversized_entry_is_refused() {
        let huge = format!("{{\"body\":\"{}\"}}", "x".repeat(MAX_ANNOTATION_BYTES));
        assert!(check_entries(&[huge]).is_err());
    }

    #[test]
    fn an_embedded_newline_is_refused_because_it_would_split_the_entry() {
        // One entry per line is the store's whole framing on the far side.
        let torn = r#"{"id":"a","body":"first
second"}"#
            .to_string();
        let err = check_entries(&[torn]).unwrap_err();
        assert!(err.contains("line break"), "{err}");
    }

    #[test]
    fn the_new_variants_are_appended_so_old_frames_still_decode() {
        // postcard identifies a variant by DECLARATION ORDER. The two frames
        // that existed before annotations must keep their discriminants, or
        // every peer on the old build misreads every frame.
        let hello = postcard::to_allocvec(&Req::Hello {
            proto: PROTO_VERSION,
            device: "Mac".into(),
        })
        .unwrap();
        assert_eq!(hello[0], 0, "Hello must stay variant 0");

        let get = postcard::to_allocvec(&Req::GetArtifact { path: "/a".into() }).unwrap();
        assert_eq!(get[0], 1, "GetArtifact must stay variant 1");

        let res = postcard::to_allocvec(&Res::Denied("no".into())).unwrap();
        assert_eq!(res[0], 2, "Denied must stay variant 2");
    }

    #[test]
    fn an_annotation_page_round_trips_over_postcard() {
        let page = AnnotationPage { entries: vec![entry(1), entry(2)], truncated: true };
        let bytes = postcard::to_allocvec(&Res::Annotations(page.clone())).unwrap();
        match postcard::from_bytes::<Res>(&bytes).unwrap() {
            Res::Annotations(back) => assert_eq!(back, page),
            other => panic!("decoded as {other:?}"),
        }
    }

    #[test]
    fn a_put_frame_round_trips_over_postcard() {
        let req = Req::PutAnnotations { path: "/w/a.md".into(), entries: vec![entry(1)] };
        let bytes = postcard::to_allocvec(&req).unwrap();
        assert_eq!(postcard::from_bytes::<Req>(&bytes).unwrap(), req);
    }
}
