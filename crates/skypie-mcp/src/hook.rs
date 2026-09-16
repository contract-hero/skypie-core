// `skypie-mcp hook <event>` — the Claude Code hook half of the plugin.
//
// One binary, not two. A hook that shelled out to Node or Python would add a
// runtime to every install and a second implementation of the socket client;
// a subcommand of the MCP server reuses the client, the state-directory rule
// and the wire contract exactly as they already are.
//
// ── The contract with Claude Code ──────────────────────────────────────────
//
// A hook reads ONE JSON object on stdin and writes at most one on stdout:
//
//   in   { "session_id": "...", "cwd": "...", "tool_name": "Read",
//          "tool_input": { "file_path": "/abs/path" }, ... }
//   out  { "hookSpecificOutput": { "hookEventName": "PostToolUse",
//                                  "additionalContext": "..." } }
//
// ── Two rules this must never break ────────────────────────────────────────
//
// SILENCE IS THE DEFAULT. The hook fires on every `Read` of every file in
// every session. A file with no feedback produces no output at all. A hook
// that spoke every time would poison an agent's context with noise and the
// user would turn the plugin off within a day.
//
// IT NEVER LAUNCHES THE APP. The MCP tools launch Sky Pie because a
// person asked for a share and expects the app. A hook firing because an
// agent happened to read a file has no such mandate — popping a GUI open
// would be indefensible. Nothing listening means no feedback, which means
// silence.
//
// Exit code is always 0. A non-zero exit from a `PostToolUse` hook is a
// message to the model, and "the comment app is not running" is not something
// the model can act on.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use crate::core::AppClient;

/// Hook events this build answers to. Anything else exits silently, so a
/// hooks.json from a newer plugin cannot make an older binary fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// `PostToolUse` with matcher `Read` — inject the file's open feedback.
    Read,
    /// `PostToolUse` with matcher `Write|Edit|MultiEdit` — remind the agent of
    /// feedback on a file it just changed.
    ///
    /// The same code path as `Read`; the two names exist so `hooks.json` reads
    /// as what it matches. (An earlier draft of this doc also promised
    /// provenance recording, which was never implemented — smart collections
    /// are a later plan item.)
    Wrote,
    /// `UserPromptSubmit` — one line naming files that are waiting.
    Prompt,
}

impl Event {
    pub fn parse(raw: &str) -> Option<Event> {
        match raw {
            "read" => Some(Event::Read),
            "wrote" => Some(Event::Wrote),
            "prompt" => Some(Event::Prompt),
            _ => None,
        }
    }

    /// The `hookEventName` the reply must echo back.
    fn hook_event_name(self) -> &'static str {
        match self {
            Event::Read | Event::Wrote => "PostToolUse",
            Event::Prompt => "UserPromptSubmit",
        }
    }
}

/// The subset of a hook's stdin payload this binary reads.
///
/// Deliberately permissive: every field is optional, unknown fields are
/// ignored, and a payload that does not parse at all is silence rather than
/// an error. A hook is not the place to be strict about a host's evolving
/// schema.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct HookInput {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<ToolInput>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ToolInput {
    /// `Read`, `Write` and `Edit` all name it `file_path`.
    pub file_path: Option<String>,
}

impl HookInput {
    /// The absolute path the tool touched, when there is one.
    ///
    /// A relative `file_path` is resolved against the session's `cwd`, which
    /// is the only way the hook can key the annotations store the same way
    /// the app did when the comment was made.
    pub fn target(&self) -> Option<PathBuf> {
        let raw = self.tool_input.as_ref()?.file_path.as_ref()?;
        if raw.is_empty() {
            return None;
        }
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            return Some(path);
        }
        Some(PathBuf::from(self.cwd.as_deref()?).join(path))
    }
}

/// Render the one line a hook writes to stdout, or `None` for silence.
///
/// Pure, so the whole decision is unit-testable without a socket: given the
/// event and what the app said, either there is something worth telling the
/// model or there is not.
pub fn render(event: Event, context: &str) -> Option<String> {
    let trimmed = context.trim();
    if trimmed.is_empty() {
        return None;
    }
    let payload = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": event.hook_event_name(),
            "additionalContext": trimmed,
        }
    });
    Some(payload.to_string())
}

/// The line a `UserPromptSubmit` hook adds when files are waiting.
///
/// One sentence, never a listing: this runs on EVERY turn, and a wall of
/// paths at every prompt is how a useful signal becomes something the model
/// learns to skip. Three names, then a count.
pub fn prompt_summary(files: &[skypie_ipc::FeedbackFile]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let total: usize = files.iter().map(|f| f.open).sum();
    let named: Vec<String> = files
        .iter()
        .take(3)
        .map(|f| {
            f.path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| f.path.to_string_lossy().into_owned())
        })
        .collect();
    let rest = files.len().saturating_sub(named.len());
    let where_ = if rest > 0 {
        format!("{} and {rest} more", named.join(", "))
    } else {
        named.join(", ")
    };
    format!(
        "The user has {total} open comment(s) in Sky Pie on {where_}. \
         Call list_feedback before working on those files."
    )
}

/// Run one hook invocation. Always `Ok(())`: see the module header.
pub async fn run(event: Event, app: Arc<AppClient>) -> Result<(), Box<dyn std::error::Error>> {
    let mut raw = String::new();
    // A host that closed stdin, or sent something unreadable, gets silence.
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        return Ok(());
    }
    let input: HookInput = serde_json::from_str(&raw).unwrap_or_default();

    let context = match event {
        Event::Read | Event::Wrote => {
            let Some(target) = input.target() else { return Ok(()) };
            match app.feedback_if_running(&target).await {
                Some(feedback) if feedback.open > 0 => feedback.context,
                _ => String::new(),
            }
        }
        Event::Prompt => match app.feedback_index_if_running().await {
            Some(files) => prompt_summary(&files),
            None => String::new(),
        },
    };

    if let Some(line) = render(event, &context) {
        println!("{line}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(json: &str) -> HookInput {
        serde_json::from_str(json).unwrap_or_default()
    }

    #[test]
    fn an_absolute_file_path_is_the_target() {
        let i = input(r#"{"tool_name":"Read","tool_input":{"file_path":"/tmp/a.md"}}"#);
        assert_eq!(i.target(), Some(PathBuf::from("/tmp/a.md")));
    }

    #[test]
    fn a_relative_file_path_resolves_against_the_session_cwd() {
        let i = input(r#"{"cwd":"/work/proj","tool_input":{"file_path":"docs/a.md"}}"#);
        assert_eq!(i.target(), Some(PathBuf::from("/work/proj/docs/a.md")));
    }

    #[test]
    fn a_relative_path_with_no_cwd_has_no_target() {
        // Guessing a working directory would key the wrong annotations store
        // and report another file's comments.
        let i = input(r#"{"tool_input":{"file_path":"docs/a.md"}}"#);
        assert_eq!(i.target(), None);
    }

    #[test]
    fn a_tool_with_no_file_path_has_no_target() {
        assert_eq!(input(r#"{"tool_name":"Bash"}"#).target(), None);
        assert_eq!(input(r#"{"tool_input":{"file_path":""}}"#).target(), None);
    }

    #[test]
    fn unknown_fields_and_malformed_input_never_fail() {
        let i = input(r#"{"tool_input":{"file_path":"/a"},"future_field":{"x":1}}"#);
        assert_eq!(i.target(), Some(PathBuf::from("/a")));
        assert_eq!(input("not json at all").target(), None);
    }

    #[test]
    fn no_feedback_means_no_output_at_all() {
        assert_eq!(render(Event::Read, ""), None);
        assert_eq!(render(Event::Read, "   \n  "), None);
    }

    #[test]
    fn feedback_is_wrapped_in_the_documented_shape() {
        let out = render(Event::Read, "SkyPie feedback on /a (1 open):\n1. …").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PostToolUse");
        assert!(v["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap()
            .starts_with("SkyPie feedback"));
    }

    #[test]
    fn a_prompt_hook_echoes_its_own_event_name() {
        let out = render(Event::Prompt, "2 files are waiting").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit");
    }

    #[test]
    fn the_output_is_exactly_one_line() {
        // The host reads one JSON object; an embedded newline from a comment
        // body would split it into two unparseable halves.
        let out = render(Event::Read, "first line\nsecond line").unwrap();
        assert!(!out.contains('\n'), "{out}");
    }

    fn file(path: &str, open: usize) -> skypie_ipc::FeedbackFile {
        skypie_ipc::FeedbackFile {
            path: PathBuf::from(path),
            open,
            total: open,
            updated_at: 0,
        }
    }

    #[test]
    fn the_prompt_summary_is_silent_with_nothing_waiting() {
        assert_eq!(prompt_summary(&[]), "");
    }

    #[test]
    fn the_prompt_summary_names_files_and_totals_the_comments() {
        let out = prompt_summary(&[file("/a/report.html", 2), file("/b/plan.md", 1)]);
        assert!(out.contains("3 open comment"), "{out}");
        assert!(out.contains("report.html, plan.md"), "{out}");
    }

    #[test]
    fn the_prompt_summary_caps_the_listing_rather_than_growing_with_the_backlog() {
        let files: Vec<_> = (0..9).map(|i| file(&format!("/x/f{i}.md"), 1)).collect();
        let out = prompt_summary(&files);
        assert!(out.contains("and 6 more"), "{out}");
        assert!(out.matches(".md").count() <= 3, "{out}");
    }

    #[test]
    fn an_unknown_event_name_is_not_an_event() {
        assert_eq!(Event::parse("read"), Some(Event::Read));
        assert_eq!(Event::parse("wrote"), Some(Event::Wrote));
        assert_eq!(Event::parse("prompt"), Some(Event::Prompt));
        assert_eq!(Event::parse("SessionStart"), None);
    }
}
