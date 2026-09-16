// The Tauri surface over `annotations.rs`.
//
// Same discipline as `remote.rs`: every `#[tauri::command]` is a thin wrapper
// over a `pub(crate) …_for(&AppHandle, …)`, so the Unix socket the Claude Code
// hook and the MCP server drive can call the SAME implementation. One
// operation, one body — the app and the agent can never disagree about what
// "resolve this comment" does.
//
// The store module is deliberately free of Tauri and of any notion of who the
// user is. Authorship is decided here, from the identity the remote subsystem
// already owns, because that is where an `AppHandle` exists.

use std::path::Path;

use tauri::{Emitter, Manager};

use crate::annotations::{self, Annotation, Creator, Selector, Status};

/// Emitted after any write, so a comment rail, the sidebar badges and a second
/// window all refresh from one broadcast instead of polling.
pub const CHANGED_EVENT: &str = "skypie://annotations-changed";

/// Who this device is, in annotation terms.
///
/// The iroh node id and the sanitized device name that `peers.json` already
/// carries — the plan's "no accounts needed". An install whose identity key
/// has not been read yet still gets a stable-enough author (`local`) rather
/// than failing the write: losing a comment because the network stack has not
/// booted would be absurd for a feature that works offline.
pub(crate) fn creator_for(app: &tauri::AppHandle) -> Creator {
    let remote = app.state::<crate::remote::RemoteState>();
    Creator {
        id: remote
            .self_id()
            .map(|id| format!("node:{id}"))
            .unwrap_or_else(|| "local".to_string()),
        name: Some(remote.device_name().to_string()),
    }
}

/// The one broadcast every writer sends: the rail, the sheet and the badges
/// all refresh from it.
pub(crate) fn notify(app: &tauri::AppHandle, source: &str) {
    let _ = app.emit(CHANGED_EVENT, source);
}

// ────────────────────────────────────────────────────────────────────────────
// Read
// ────────────────────────────────────────────────────────────────────────────

pub(crate) fn list_for(source: &str) -> Vec<Annotation> {
    annotations::list(&crate::state_store::state_dir(), source)
}

/// Every comment on one file, replies included, each folded to its current
/// status. Ordered oldest-first (UUIDv7 order), which is the order a thread
/// reads in.
#[tauri::command]
pub fn annotations_list(source: String) -> Vec<Annotation> {
    list_for(&source)
}

pub(crate) fn index_for() -> Vec<annotations::IndexEntry> {
    annotations::index(&crate::state_store::state_dir())
}

/// Every file that has comments, newest activity first. What the sidebar
/// badges from, and what the `UserPromptSubmit` hook reads to name the files
/// that are waiting.
#[tauri::command]
pub fn annotations_index() -> Vec<annotations::IndexEntry> {
    index_for()
}

// ────────────────────────────────────────────────────────────────────────────
// Write
// ────────────────────────────────────────────────────────────────────────────

pub(crate) fn add_for(
    app: &tauri::AppHandle,
    source: &str,
    body: String,
    selector: Vec<Selector>,
    session: Option<String>,
) -> Result<Annotation, String> {
    let entry = annotations::comment(source, body, selector, creator_for(app), session);
    annotations::append(&crate::state_store::state_dir(), &entry)?;
    notify(app, source);
    Ok(entry)
}

/// Create a root comment (or, with an empty body, a bare highlight).
#[tauri::command]
pub fn annotations_add(
    app: tauri::AppHandle,
    source: String,
    body: String,
    selector: Vec<Selector>,
    session: Option<String>,
) -> Result<Annotation, String> {
    add_for(&app, &source, body, selector, session)
}

pub(crate) fn reply_for(
    app: &tauri::AppHandle,
    source: &str,
    parent_id: &str,
    body: String,
) -> Result<Annotation, String> {
    if body.trim().is_empty() {
        return Err("a reply needs text".to_string());
    }
    let entry = annotations::reply(source, parent_id, body, creator_for(app));
    annotations::append(&crate::state_store::state_dir(), &entry)?;
    notify(app, source);
    Ok(entry)
}

/// Reply inside a thread.
#[tauri::command]
pub fn annotations_reply(
    app: tauri::AppHandle,
    source: String,
    parent_id: String,
    body: String,
) -> Result<Annotation, String> {
    reply_for(&app, &source, &parent_id, body)
}

pub(crate) fn set_status_for(
    app: &tauri::AppHandle,
    source: &str,
    id: &str,
    status: Status,
    note: Option<String>,
) -> Result<Annotation, String> {
    let entry = annotations::set_status(
        &crate::state_store::state_dir(),
        source,
        id,
        status,
        note,
        creator_for(app),
    )?;
    notify(app, source);
    Ok(entry)
}

/// Mark a thread addressed, reopened, or won't-fix. This is also the MCP
/// `resolve_feedback` tool: when an agent calls it, the pin the user dropped
/// turns green in the UI and they watch the agent answer them.
#[tauri::command]
pub fn annotations_set_status(
    app: tauri::AppHandle,
    source: String,
    id: String,
    status: Status,
    note: Option<String>,
) -> Result<Annotation, String> {
    set_status_for(&app, &source, &id, status, note)
}

pub(crate) fn export_for(source: &str) -> Result<String, String> {
    annotations::export_sidecar(&crate::state_store::state_dir(), source)
        .map(|p| p.to_string_lossy().into_owned())
}

/// "Export feedback next to file" — the one action that writes into the
/// user's own tree, and only because they asked for it by name.
#[tauri::command]
pub fn annotations_export(source: String) -> Result<String, String> {
    export_for(&source)
}

// ────────────────────────────────────────────────────────────────────────────
// Agent-facing text
// ────────────────────────────────────────────────────────────────────────────

/// The block the Claude Code `PostToolUse` hook returns as
/// `hookSpecificOutput.additionalContext` after a `Read`.
///
/// Empty string when the file has no open feedback, which the hook turns into
/// "exit 0, print nothing". Silence is the contract: a hook that speaks on
/// every `Read` would poison every agent session with noise.
///
/// Written as prose rather than JSON because the consumer is a language
/// model: line numbers and quoted anchors are what let it find the spot, and
/// the closing instruction is what makes it call back when it is done.
pub fn hook_context(source: &str) -> String {
    hook_feedback(source).1
}

/// `(open thread count, context block)` from ONE read of the store.
///
/// The socket dispatcher needs both, and asking for them separately meant two
/// full reads and two full parses of the same `.jsonl` on every `Read` an
/// agent performs — the highest-frequency path in the product.
pub fn hook_feedback(source: &str) -> (usize, String) {
    let open: Vec<Annotation> = list_for(source)
        .into_iter()
        .filter(annotations::is_open_root)
        .collect();
    if open.is_empty() {
        return (0, String::new());
    }

    let name = Path::new(source)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| source.to_string());

    let mut out = format!(
        "SkyPie feedback on {source} ({} open):\n",
        open.len()
    );
    for (n, a) in open.iter().enumerate() {
        let anchor = describe_anchor(&a.target.selector);
        let who = a.creator.name.clone().unwrap_or_else(|| a.creator.id.clone());
        let text = a.body.as_ref().map(|b| b.value.as_str()).unwrap_or("(highlight, no text)");
        out.push_str(&format!(
            "{}. [{anchor}] {who}, {} — {text}\n   id: {}\n",
            n + 1,
            a.created,
            a.id
        ));
    }
    out.push_str(&format!(
        "Call skypie.resolve_feedback(id) when a point is addressed, so {name} stops reporting it.",
    ));
    (open.len(), out)
}

/// A human-readable location from the stored selectors, best anchor first.
///
/// Prefers the line fragment, then the quote, then the character range —
/// which is the order of usefulness to a reader, not the order of precision.
/// "line 142" points at a place; "chars 3100-3116" does not.
fn describe_anchor(selectors: &[Selector]) -> String {
    let mut quote = None;
    let mut fragment = None;
    let mut position = None;

    for s in selectors {
        match s {
            Selector::FragmentSelector { value, .. } if fragment.is_none() => {
                fragment = Some(value.clone());
            }
            Selector::TextQuoteSelector { exact, .. } if quote.is_none() => {
                quote = Some(truncate(exact, 60));
            }
            Selector::TextPositionSelector { start, end } if position.is_none() => {
                position = Some(format!("chars {start}-{end}"));
            }
            _ => {}
        }
    }

    match (fragment, quote) {
        (Some(f), Some(q)) => format!("{}, \"{q}\"", pretty_fragment(&f)),
        (Some(f), None) => pretty_fragment(&f),
        (None, Some(q)) => format!("\"{q}\""),
        (None, None) => position.unwrap_or_else(|| "whole file".to_string()),
    }
}

/// `line=142` reads better as `line 142`; an image region reads better as
/// where on the image it is than as its raw media fragment.
fn pretty_fragment(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("line=") {
        return format!("line {rest}");
    }
    if let Some(rest) = value.strip_prefix("xywh=percent:") {
        let mut parts = rest.split(',');
        if let (Some(x), Some(y)) = (parts.next(), parts.next()) {
            return format!("image pin at {x}%,{y}%");
        }
    }
    value.to_string()
}

fn truncate(s: &str, max: usize) -> String {
    let cleaned = s.replace('\n', " ");
    if cleaned.chars().count() <= max {
        return cleaned;
    }
    let head: String = cleaned.chars().take(max).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotations::{append, comment, set_status, Creator, Target};
    use tempfile::TempDir;

    fn who() -> Creator {
        Creator { id: "node:3f9a1c".into(), name: Some("Alvaro's iPhone".into()) }
    }

    fn anchors() -> Vec<Selector> {
        vec![
            Selector::TextQuoteSelector {
                exact: "Total revenue".into(),
                prefix: Some("| ".into()),
                suffix: Some(" |".into()),
            },
            Selector::FragmentSelector {
                conforms_to: Some("http://tools.ietf.org/rfc/rfc5147".into()),
                value: "line=142".into(),
            },
        ]
    }

    // `hook_context` reads through `state_dir()`, so these drive the store
    // module directly and assert on the rendering.
    fn context_of(dir: &TempDir, source: &str) -> String {
        let open: Vec<Annotation> = annotations::list(dir.path(), source)
            .into_iter()
            .filter(|a| a.in_reply_to.is_none() && a.status == Status::Open)
            .collect();
        if open.is_empty() {
            return String::new();
        }
        let mut out = String::new();
        for a in &open {
            out.push_str(&describe_anchor(&a.target.selector));
            out.push('\n');
        }
        out
    }

    #[test]
    fn an_anchor_reads_as_a_line_and_a_quote() {
        assert_eq!(describe_anchor(&anchors()), "line 142, \"Total revenue\"");
    }

    #[test]
    fn an_image_pin_reads_as_a_place_on_the_image() {
        let sel = vec![Selector::FragmentSelector {
            conforms_to: Some("http://www.w3.org/TR/media-frags/".into()),
            value: "xywh=percent:31,18,4,4".into(),
        }];
        assert_eq!(describe_anchor(&sel), "image pin at 31%,18%");
    }

    #[test]
    fn a_position_only_anchor_still_says_something() {
        let sel = vec![Selector::TextPositionSelector { start: 3100, end: 3116 }];
        assert_eq!(describe_anchor(&sel), "chars 3100-3116");
        assert_eq!(describe_anchor(&[]), "whole file");
    }

    #[test]
    fn a_long_quote_is_truncated_so_one_comment_cannot_flood_the_context() {
        let sel = vec![Selector::TextQuoteSelector {
            exact: "x".repeat(500),
            prefix: None,
            suffix: None,
        }];
        let out = describe_anchor(&sel);
        assert!(out.chars().count() < 70, "{out}");
        assert!(out.ends_with("…\""));
    }

    #[test]
    fn a_newline_in_a_quote_never_breaks_the_context_block_into_fake_entries() {
        let sel = vec![Selector::TextQuoteSelector {
            exact: "first\nsecond".into(),
            prefix: None,
            suffix: None,
        }];
        assert_eq!(describe_anchor(&sel), "\"first second\"");
    }

    #[test]
    fn a_file_with_no_open_feedback_produces_no_context_at_all() {
        let dir = TempDir::new().unwrap();
        let a = comment("/tmp/a.md", "fix".into(), anchors(), who(), None);
        append(dir.path(), &a).unwrap();
        set_status(dir.path(), "/tmp/a.md", &a.id, Status::Addressed, None, who()).unwrap();
        assert_eq!(context_of(&dir, "/tmp/a.md"), "", "silence once everything is addressed");
    }

    // `hook_context` reads through `state_dir()`, so these drive the real
    // function over the shared test state dir. This is the exact text an
    // agent sees, and it is the product surface most likely to be broken by
    // an innocent refactor of the store.
    mod rendered_for_the_agent {
        use super::*;
        use crate::state_store;

        fn fresh_source() -> String {
            // A unique target per test: the shared state dir is process-wide
            // and these tests run in parallel.
            format!("/tmp/skypie-hook-{}.md", crate::annotations::new_id())
        }

        fn add(source: &str, body: &str, selector: Vec<Selector>) -> Annotation {
            let a = comment(source, body.to_string(), selector, who(), None);
            append(&state_store::state_dir(), &a).unwrap();
            a
        }

        #[test]
        fn a_file_with_no_comments_produces_an_empty_string() {
            state_store::ensure_shared_test_state_dir();
            assert_eq!(hook_context(&fresh_source()), "");
        }

        #[test]
        fn the_block_carries_the_anchor_the_author_and_the_id() {
            state_store::ensure_shared_test_state_dir();
            let source = fresh_source();
            let a = add(&source, "This table needs the Q3 numbers.", anchors());

            let out = hook_context(&source);
            assert!(out.starts_with(&format!("SkyPie feedback on {source} (1 open):")), "{out}");
            assert!(out.contains("line 142, \"Total revenue\""), "{out}");
            assert!(out.contains("Alvaro's iPhone"), "{out}");
            assert!(out.contains("This table needs the Q3 numbers."), "{out}");
            // Without the id the agent cannot call resolve_feedback, and the
            // loop the whole plugin exists for never closes.
            assert!(out.contains(&a.id), "{out}");
            assert!(out.contains("resolve_feedback"), "{out}");
        }

        #[test]
        fn resolving_every_thread_returns_the_hook_to_silence() {
            state_store::ensure_shared_test_state_dir();
            let source = fresh_source();
            let a = add(&source, "fix this", anchors());
            assert!(!hook_context(&source).is_empty());

            crate::annotations::set_status(
                &state_store::state_dir(),
                &source,
                &a.id,
                Status::Addressed,
                None,
                who(),
            )
            .unwrap();
            assert_eq!(hook_context(&source), "", "silence once nothing is open");
        }

        #[test]
        fn replies_are_not_counted_as_open_points() {
            state_store::ensure_shared_test_state_dir();
            let source = fresh_source();
            let a = add(&source, "one", anchors());
            append(
                &state_store::state_dir(),
                &crate::annotations::reply(&source, &a.id, "me too".into(), who()),
            )
            .unwrap();

            let out = hook_context(&source);
            assert!(out.contains("(1 open)"), "a reply is not a second request: {out}");
        }

        #[test]
        fn a_highlight_with_no_text_still_reads_as_something() {
            state_store::ensure_shared_test_state_dir();
            let source = fresh_source();
            add(&source, "   ", anchors());
            assert!(hook_context(&source).contains("(highlight, no text)"));
        }

        #[test]
        fn several_open_points_are_numbered() {
            state_store::ensure_shared_test_state_dir();
            let source = fresh_source();
            add(&source, "first", anchors());
            add(&source, "second", anchors());

            let out = hook_context(&source);
            assert!(out.contains("(2 open)"), "{out}");
            assert!(out.contains("1. "), "{out}");
            assert!(out.contains("2. "), "{out}");
        }
    }

    #[test]
    fn an_assessment_entry_has_no_anchor_to_describe() {
        // Guards the shape `set_status` writes: an assessment is about a
        // comment, not about a place, so it must carry an empty selector.
        let t = Target { source: "/tmp/a.md".into(), hash: None, selector: Vec::new() };
        assert_eq!(describe_anchor(&t.selector), "whole file");
    }
}
