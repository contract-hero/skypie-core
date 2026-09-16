// The MCP surface: eleven tools over `AppClient`, described for a language
// model rather than for a person reading a manual.
//
// Every handler is the same three steps — validate, ask the app, render —
// so the interesting behavior stays in `core.rs` where the integration test
// can reach it without a transport.
//
// Failure convention, per the MCP spec's two failure modes:
//   * a malformed ARGUMENT is a protocol error (`Err(ErrorData)`) — the caller
//     sent something this server cannot route;
//   * a device that is offline or unpaired, an app that cannot be launched,
//     is a TOOL error (`Ok(CallToolResult::error(…))`) — the call was valid,
//     it just did not work, and the model must read the reason to fix it.

use std::sync::Arc;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo,
};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde::Serialize;

use crate::args::{
    BeamArtifactArgs, ConfirmPairingArgs, ForgetDeviceArgs, ListDevicesArgs, ListFeedbackArgs,
    ResolveFeedbackArgs, ShareLinkArgs, StopBeamArgs,
};
use skypie_ipc::{human_bytes, now_unix};

use crate::core::{AppClient, Feedback, Forgotten, Resolved, ServerStatus};

/// The rmcp handler. Holds the client behind an `Arc` because rmcp clones
/// the service per connection.
#[derive(Clone)]
pub struct SkyPieMcp {
    app: Arc<AppClient>,
}

impl SkyPieMcp {
    pub fn new(app: Arc<AppClient>) -> Self {
        Self { app }
    }
}

#[tool_router]
impl SkyPieMcp {
    #[tool(
        name = "share_link",
        description = "Make a skypie:// link for a local file that opens on any of the user's OWN \
                       devices paired with this Mac (their iPhone, their other Mac). Use this \
                       when the user wants to read a file they produced here on another device \
                       of theirs. The device that opens the link pulls the file straight from \
                       this Mac, peer-to-peer and end-to-end encrypted — nothing is uploaded — \
                       so Sky Pie must be running here when the link is opened. The link \
                       does nothing on a device that is not paired; for those use beam_artifact. \
                       Two forms come back: put the https one in chat (only http(s) is \
                       clickable in Claude Desktop and on iOS); the raw skypie:// one is for \
                       the app's address bar, QR codes and the share sheet."
    )]
    async fn share_link(
        &self,
        Parameters(args): Parameters<ShareLinkArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        render(self.app.share_link(&args.path).await, |link| {
            format!(
                "Link for the user's paired devices ({}, {}):\nWeb link, put this in chat:\n{}\nRaw skypie:// form:\n{}\n\
                 Opens on any device paired with {} while Sky Pie is running here.",
                link.name,
                human_bytes(link.size),
                link.web_link,
                link.link,
                link.device
            )
        })
    }

    #[tool(
        name = "beam_artifact",
        description = "Publish a local file as a skypie:// link that ANYONE running Sky Pie \
                       can open — a colleague, a device that is not paired. Use this when the \
                       user wants to SHARE a file (report, chart, HTML page) with somebody else; \
                       for the user's own paired devices prefer share_link. The file is served \
                       peer-to-peer, end-to-end encrypted, straight from this Mac — nothing is \
                       uploaded anywhere — so the link works only while Sky Pie keeps \
                       running here and only until it expires. Anyone holding the link can \
                       fetch the file until then. Give the returned link to the user."
    )]
    async fn beam_artifact(
        &self,
        Parameters(args): Parameters<BeamArtifactArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        render(self.app.beam_artifact(&args.path, args.ttl_hours).await, |link| {
            format!(
                "{} ({}) is now beamable. Give the user this link:\n{}\nIt expires in {}, and it \
                 stops working when Sky Pie quits.",
                link.name,
                human_bytes(link.size),
                link.link,
                human_hours(link.expires_at)
            )
        })
    }

    #[tool(
        name = "stop_beam",
        description = "Revoke a link minted by beam_artifact, immediately, before it expires. A \
                       beam link is a capability: anyone who holds the string can fetch the file \
                       until the link expires. Call this as soon as a link went to the wrong \
                       person, named the wrong file, or is simply finished with — the next fetch \
                       is then refused. Pass the hash of one link (beam_artifact and \
                       server_status both report it), or no argument at all to revoke every link \
                       still being served."
    )]
    async fn stop_beam(
        &self,
        Parameters(args): Parameters<StopBeamArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let stopped = match self.app.stop_beam(args.hash.as_deref()).await {
            Ok(stopped) => stopped,
            Err(message) => return tool_failure(message),
        };
        let summary = if stopped.is_empty() {
            "No beam link was live, so nothing had to be revoked.".to_string()
        } else {
            let names: Vec<&str> = stopped.iter().map(|o| o.name.as_str()).collect();
            format!(
                "Revoked {} beam link(s): {}. Any further fetch is refused, even from somebody \
                 who still holds the link.",
                stopped.len(),
                names.join(", ")
            )
        };
        ok(summary, &serde_json::json!({ "stopped": stopped }))
    }

    #[tool(
        name = "list_devices",
        description = "List the user's devices paired with this Mac, with their names and node \
                       ids. Call this when the user asks which devices are available, or before \
                       forget_device to learn the exact name. Presence is reported as \"unknown\" \
                       unless probe is true, which dials each device once. A probed device reads \
                       \"online\", \"offline\" (it did not answer), \"refused\" (it answered and \
                       would not open a session — a version mismatch does this too) or \
                       \"unpaired\" (it answered and no longer lists this Mac as paired). Never \
                       tell the user to check the network of a device reported \"refused\" or \
                       \"unpaired\"."
    )]
    async fn list_devices(
        &self,
        Parameters(args): Parameters<ListDevicesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let devices = match self.app.list_devices(args.probe).await {
            Ok(devices) => devices,
            Err(e) => return tool_failure(e),
        };
        let summary = if devices.is_empty() {
            "No devices are paired with this Mac yet. Call pair_device to pair one.".to_string()
        } else {
            let rows: Vec<String> = devices
                .iter()
                .map(|d| {
                    format!("- {} ({}) — presence: {}", d.device, d.node_id_short, d.presence)
                })
                .collect();
            format!("{} paired device(s):\n{}", devices.len(), rows.join("\n"))
        };
        ok(summary, &serde_json::json!({ "devices": devices }))
    }

    #[tool(
        name = "pair_device",
        description = "Begin pairing a new device with this Mac. Returns a skypie://pair link for \
                       the human to open on the device they want to pair (the Mac's Settings → \
                       Devices shows the same invite as a QR code). Pairing is mutual and needs \
                       a person: after the device opens the link, six words appear on BOTH \
                       screens, the human compares them, and confirm_pairing finishes it. Show \
                       the link and the instructions to the user, then call pair_status."
    )]
    async fn pair_device(&self) -> Result<CallToolResult, ErrorData> {
        render(self.app.pair_device().await, |invite| {
            format!(
                "Pairing is open for 10 minutes. Ask the user to open this link on the device \
                 they want to pair:\n{}\n\n{}\n\nNext: {}",
                invite.link,
                invite.instructions.join("\n"),
                invite.fingerprint_hint
            )
        })
    }

    #[tool(
        name = "pair_status",
        description = "Show pairings waiting for confirmation, each with the six fingerprint \
                       words. ALWAYS show these words to the user verbatim and ask them to check \
                       that the same six words, in the same order, are on the other device's \
                       screen. If the words differ, a machine is in the middle: call \
                       confirm_pairing with accept false."
    )]
    async fn pair_status(&self) -> Result<CallToolResult, ErrorData> {
        let pending = match self.app.pair_status().await {
            Ok(pending) => pending,
            Err(e) => return tool_failure(e),
        };
        let summary = if pending.is_empty() {
            "No pairing is waiting for confirmation. Call pair_device, then have the user open \
             the link on the other device."
                .to_string()
        } else {
            let rows: Vec<String> = pending
                .iter()
                .map(|p| {
                    format!(
                        "- {} ({}) — fingerprint: {}",
                        p.device,
                        p.node_id_short,
                        p.fingerprint.join(" ")
                    )
                })
                .collect();
            format!(
                "{} pairing(s) waiting. Read the six words to the user and have them compare with \
                 the other screen:\n{}",
                pending.len(),
                rows.join("\n")
            )
        };
        ok(summary, &serde_json::json!({ "pending": pending }))
    }

    #[tool(
        name = "confirm_pairing",
        description = "Finish or reject a pending pairing after the human confirmed that the six \
                       fingerprint words match on both screens. Never call this with accept true \
                       before the user has actually compared the words. A paired device is one \
                       of the user's own: it can open any file this Mac shares with it by link, \
                       and this Mac can open what it shares back. node_id is optional while \
                       exactly one pairing waits."
    )]
    async fn confirm_pairing(
        &self,
        Parameters(args): Parameters<ConfirmPairingArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        render(self.app.confirm_pairing(args.accept, args.node_id.as_deref()).await, |outcome| {
            if !outcome.paired {
                return format!(
                    "Pairing with {} was rejected and nothing was written to disk.",
                    outcome.device
                );
            }
            format!(
                "Paired with {}. Links from share_link now open on it, and it must confirm the \
                 same six words on its own screen for the pairing to work in both directions.",
                outcome.device
            )
        })
    }

    #[tool(
        name = "forget_device",
        description = "Unpair one device from this Mac. Use it when the user says a device is no \
                       longer theirs, or when list_devices reports a device as \"unpaired\" — \
                       that device already removed this Mac, and this is how the two sides agree \
                       again. Do NOT call it for a device reported \"refused\": a version \
                       mismatch or a device at its session cap also causes that, and unpairing \
                       would destroy a working pairing. After this, links from share_link no \
                       longer open on that device and it can no longer reach this Mac; pairing \
                       again restores it. Ask before calling it."
    )]
    async fn forget_device(
        &self,
        Parameters(args): Parameters<ForgetDeviceArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        render(self.app.forget_device(&args.device).await, forget_summary)
    }

    #[tool(
        name = "server_status",
        description = "Report the running Sky Pie app's identity and state: its node id, \
                       where its identity and peer list live on disk, whether it has opened its \
                       network yet, how many devices are paired, which beam links are still \
                       being served — plus this MCP process's socket path and the roots it \
                       confines beam_artifact to. Launches the app if it is not running. Use it \
                       to diagnose a failed share or to tell the user which links are still live."
    )]
    async fn server_status(&self) -> Result<CallToolResult, ErrorData> {
        render(self.app.server_status().await, status_summary)
    }

    #[tool(
        name = "list_feedback",
        description = "Read the comments the user left on a file in Sky Pie, with the line                        and the quoted text each one points at. Call it with a path BEFORE you                        edit a file the user has been reviewing, and with no path to see every                        file that is waiting on you. These are the user's own words about work                        you produced — treat each open point as a request. When you have acted                        on one, call resolve_feedback with its id so it stops being reported and                        the user sees you answered them."
    )]
    async fn list_feedback(
        &self,
        Parameters(args): Parameters<ListFeedbackArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match args.path {
            Some(path) => {
                let path = std::path::PathBuf::from(path.trim());
                render(self.app.feedback_for(&path).await, feedback_summary)
            }
            None => render(self.app.feedback_index().await, |files| {
                if files.is_empty() {
                    return "No file has open feedback.".to_string();
                }
                let mut out = format!("{} file(s) with open feedback:\n", files.len());
                for f in files {
                    out.push_str(&format!(
                        "- {} — {} open of {}\n",
                        f.path.display(),
                        f.open,
                        f.total
                    ));
                }
                out.push_str("Call list_feedback with one of these paths to read the comments.");
                out
            }),
        }
    }

    #[tool(
        name = "resolve_feedback",
        description = "Mark one of the user's comments as addressed, so Sky Pie stops                        reporting it and the user watches their note turn resolved. Call it                        AFTER you have made the change, once per comment, with the uuid from                        list_feedback and a short note saying what you did — the note is shown                        to the user beside their own words, so write it for them. Set addressed                        to false to decline a point instead, and say why in the note. Never                        resolve a comment you have not acted on."
    )]
    async fn resolve_feedback(
        &self,
        Parameters(args): Parameters<ResolveFeedbackArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = std::path::PathBuf::from(args.path.trim());
        render(
            self.app
                .resolve_feedback(&path, &args.id, args.note, args.addressed)
                .await,
            resolved_summary,
        )
    }
}

/// What `list_feedback` returns for one file. The app already rendered the
/// block — the same one the hook injects — so a comment read through the tool
/// and a comment injected by the hook can never be worded differently.
fn feedback_summary(feedback: &Feedback) -> String {
    if feedback.open == 0 {
        return format!("No open feedback on {}.", feedback.path.display());
    }
    feedback.context.clone()
}

/// The sentence `resolve_feedback` returns.
fn resolved_summary(resolved: &Resolved) -> String {
    let tail = if resolved.remaining == 0 {
        "Nothing else is open on this file.".to_string()
    } else {
        format!("{} comment(s) still open on this file.", resolved.remaining)
    };
    format!(
        "Marked {} as {} on {}. {tail}",
        resolved.id,
        resolved.resolution,
        resolved.path.display()
    )
}

/// The sentence `forget_device` returns.
fn forget_summary(forgotten: &Forgotten) -> String {
    format!(
        "{} ({}) is no longer paired with this Mac. Links no longer open on it, and it can no \
         longer reach this Mac. Pairing again restores it.",
        forgotten.device, forgotten.node_id_short
    )
}

/// The sentence `server_status` returns. A free function so a test can
/// assert its shape without a socket.
fn status_summary(status: &ServerStatus) -> String {
    // "booted: false" reads as "idle" unless the refusal is named beside it.
    let booted = match &status.app.boot_error {
        Some(e) => format!("false — the last boot failed: {e}"),
        None => status.app.booted.to_string(),
    };
    let roots: Vec<String> = status.roots.iter().map(|r| r.display().to_string()).collect();
    format!(
        "{} — node {}\nstate directory: {}\nnetwork booted: {}\napp uptime: {}s\npaired devices: \
         {}\nactive beam links: {}\nsocket: {}\nbeam_artifact roots: {}\nlaunched by this \
         session: {}",
        status.app.device,
        status.node_id_short,
        status.app.state_dir.display(),
        booted,
        status.app.uptime_secs,
        status.app.paired_devices,
        status.app.active_offers.len(),
        status.socket_path.display(),
        roots.join(", "),
        status.launched_app
    )
}

#[tool_handler]
impl ServerHandler for SkyPieMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("skypie-mcp", env!("CARGO_PKG_VERSION"))
                    .with_title("Sky Pie"),
            )
            .with_instructions(
                "Shares local files through the Sky Pie app running on this Mac, over a \
                 direct, end-to-end encrypted peer-to-peer link. Nothing is uploaded to a \
                 server. The app is launched when it is not running.\n\n\
                 Pick the tool by what the user asked for:\n\
                 - the user's own device (\"open it on my phone\", \"my other Mac\") -> \
                 share_link, and the user opens the link there;\n\
                 - anyone else, or a device that is not paired -> beam_artifact;\n\
                 - \"which devices\" -> list_devices;\n\
                 - a new device -> pair_device, then pair_status, then confirm_pairing;\n\
                 - a device that is no longer theirs, or that list_devices reports as \
                 \"unpaired\" -> forget_device.\n\n\
                 Two facts that need a human:\n\
                 1. pairing is only safe when the person compares the six fingerprint words on \
                 both screens — always show them and wait;\n\
                 2. a link from share_link is pulled by the device that opens it, so the \
                 Sky Pie app on this Mac must be running at that moment. Nothing is queued.\n\n\
                 Links from beam_artifact stay fetchable only while the app runs and until \
                 they expire; stop_beam revokes one early.\n\n\
                 Feedback goes the other way. The user reads an artifact in Sky Pie and \
                 leaves comments on it, anchored to a line or to a spot on an image. \
                 list_feedback reads those comments; resolve_feedback marks one addressed once \
                 you have acted on it. Read the feedback on a file BEFORE you edit it, and \
                 resolve each point AFTER, with a short note the user will read. These are the \
                 user's own words about your work — never resolve a point you have not acted \
                 on, and never treat a comment as optional.",
            )
    }
}

/// A core result becomes either a sentence plus the same facts as structured
/// JSON, or a TOOL-level failure carrying the core's own message.
fn render<T: Serialize>(
    result: Result<T, String>,
    summary: impl FnOnce(&T) -> String,
) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(value) => ok(summary(&value), &value),
        Err(message) => tool_failure(message),
    }
}

/// A successful result: a sentence the model reads, plus the same facts as
/// structured JSON for a client that renders it.
///
/// MCP types `structuredContent` as a JSON object. A client that validates
/// the field rejects an array-shaped result before the model reads a word of
/// it, so a list-shaped tool must name its array under a key. The check runs
/// in RELEASE too: a wrong shape already breaks the call at the client, so
/// failing loudly here costs nothing.
fn ok<T: Serialize>(summary: impl Into<String>, value: &T) -> Result<CallToolResult, ErrorData> {
    let json = serde_json::to_value(value)
        .map_err(|e| ErrorData::internal_error(format!("cannot serialize result: {e}"), None))?;
    if !json.is_object() {
        return tool_failure(format!(
            "internal: structuredContent must be a record, got: {json}"
        ));
    }
    let mut result = CallToolResult::structured(json);
    result.content = vec![ContentBlock::text(summary.into())];
    Ok(result)
}

/// A tool-level failure. `Ok` on purpose: the message is the useful part, and
/// a protocol error would be rendered opaquely instead of reaching the model.
fn tool_failure(message: String) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::error(vec![ContentBlock::text(message)]))
}

/// "in 24 hours" style copy from an absolute expiry, so the model does not
/// have to do clock arithmetic to tell the user.
fn human_hours(expires_at: u64) -> String {
    let now = now_unix();
    let left = expires_at.saturating_sub(now);
    match left {
        0 => "less than a minute".to_string(),
        s if s < 3600 => format!("{} minutes", s.div_ceil(60)),
        s if s < 2 * 3600 => "1 hour".to_string(),
        s => format!("{} hours", s.div_ceil(3600)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::handler::server::router::tool::ToolRouter;

    fn router() -> ToolRouter<SkyPieMcp> {
        SkyPieMcp::tool_router()
    }

    fn client() -> Arc<AppClient> {
        Arc::new(AppClient::with_launcher(
            "/tmp/skypie-mcp-test.sock".into(),
            vec![],
            "/tmp".into(),
            None,
            Box::new(|| Err("no app in a unit test".to_string())),
        ))
    }

    #[test]
    fn every_documented_tool_is_registered_exactly_once() {
        let tools = router().list_all();
        let mut names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "beam_artifact",
                "confirm_pairing",
                "forget_device",
                "list_devices",
                "list_feedback",
                "pair_device",
                "pair_status",
                "resolve_feedback",
                "server_status",
                "share_link",
                "stop_beam",
            ]
        );
    }

    #[test]
    fn every_tool_carries_a_description_written_for_a_model() {
        for tool in router().list_all() {
            let description = tool.description.as_deref().unwrap_or_default();
            assert!(
                description.len() > 80,
                "{} needs a description that says WHEN to call it",
                tool.name
            );
        }
    }

    #[test]
    fn the_required_arguments_are_exactly_the_ones_without_a_default() {
        let tools = router().list_all();
        let required = |name: &str| -> Vec<String> {
            let tool = tools.iter().find(|t| t.name == name).expect(name);
            tool.input_schema
                .get("required")
                .and_then(|r| r.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        assert_eq!(required("share_link"), ["path"]);
        assert_eq!(required("beam_artifact"), ["path"]);
        assert_eq!(required("forget_device"), ["device"]);
        assert_eq!(required("confirm_pairing"), ["accept"]);
        // `addressed` must NOT be required — it defaults to true. If that
        // default ever flipped, every model call that omits the flag would
        // mark the user's comment "wontfix": they would watch their own note
        // turn into "declined" while the agent reported it did the work.
        assert_eq!(required("resolve_feedback"), ["path", "id"]);
        for name in [
            "list_devices",
            "pair_device",
            "pair_status",
            "server_status",
            "stop_beam",
            "list_feedback",
        ] {
            assert!(required(name).is_empty(), "{name} must accept {{}}");
        }
    }

    #[test]
    fn resolve_feedback_marks_a_comment_addressed_unless_told_otherwise() {
        // The default that decides whether an agent's silence reads as "done"
        // or as "declined". Pinned here because the schema test above can only
        // prove the field is optional, not which way it falls.
        let args: crate::args::ResolveFeedbackArgs =
            serde_json::from_value(serde_json::json!({ "path": "/w/a.md", "id": "x" })).unwrap();
        assert!(args.addressed, "omitting the flag must mean addressed");

        let declined: crate::args::ResolveFeedbackArgs = serde_json::from_value(
            serde_json::json!({ "path": "/w/a.md", "id": "x", "addressed": false }),
        )
        .unwrap();
        assert!(!declined.addressed);
    }

    #[test]
    fn the_schemas_name_the_properties_a_caller_must_send() {
        let tools = router().list_all();
        let props = |name: &str| -> Vec<String> {
            let tool = tools.iter().find(|t| t.name == name).expect(name);
            let mut keys: Vec<String> = tool
                .input_schema
                .get("properties")
                .and_then(|p| p.as_object())
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            keys.sort();
            keys
        };
        assert_eq!(props("share_link"), ["path"]);
        assert_eq!(props("beam_artifact"), ["path", "ttl_hours"]);
        assert_eq!(props("list_devices"), ["probe"]);
        assert_eq!(props("confirm_pairing"), ["accept", "node_id"]);
        assert_eq!(props("stop_beam"), ["hash"]);
        assert_eq!(props("list_feedback"), ["path"]);
        assert_eq!(props("resolve_feedback"), ["addressed", "id", "note", "path"]);
    }

    #[test]
    fn the_server_info_tells_the_model_the_two_human_facts() {
        let info = SkyPieMcp::new(client()).get_info();
        let instructions = info.instructions.unwrap_or_default();
        assert!(instructions.contains("six fingerprint words"), "{instructions}");
        assert!(instructions.contains("must be running"), "{instructions}");
        assert!(instructions.contains("Nothing is queued"), "{instructions}");
        assert!(!instructions.contains("control"), "no scope talk survives: {instructions}");
        assert!(
            !instructions.contains("send_to_device"),
            "the push model is gone; the instructions must not advertise it: {instructions}"
        );
        assert!(instructions.contains("list_feedback"), "{instructions}");
        assert!(instructions.contains("resolve_feedback"), "{instructions}");
        assert_eq!(info.server_info.name, "skypie-mcp");
        assert!(info.capabilities.tools.is_some(), "the server must advertise tools");
    }

    #[test]
    fn a_tool_failure_reaches_the_model_instead_of_becoming_a_protocol_error() {
        let result = tool_failure("device is offline".to_string()).unwrap();
        assert_eq!(result.is_error, Some(true));
        match &result.content[0] {
            ContentBlock::Text(text) => assert_eq!(text.text, "device is offline"),
            other => panic!("expected text content, got {other:?}"),
        }
    }

    #[test]
    fn a_success_carries_both_prose_and_structured_facts() {
        #[derive(Serialize)]
        struct Out {
            name: String,
        }
        let result = ok("sent it", &Out { name: "report.html".into() }).unwrap();
        assert_eq!(result.is_error, Some(false));
        assert_eq!(
            result.structured_content.unwrap().get("name").and_then(|v| v.as_str()),
            Some("report.html")
        );
        match &result.content[0] {
            ContentBlock::Text(text) => assert_eq!(text.text, "sent it"),
            other => panic!("expected text content, got {other:?}"),
        }
    }

    #[test]
    fn a_status_names_what_the_app_said_and_what_this_process_adds() {
        let status = ServerStatus {
            app: skypie_ipc::AppStatus {
                ipc_proto: 1,
                app_version: "0.1.0".into(),
                node_id: "ab".repeat(32),
                device: "Mac Studio".into(),
                state_dir: "/s".into(),
                booted: false,
                boot_error: Some("port in use".into()),
                uptime_secs: 3,
                paired_devices: 2,
                active_offers: vec![],
            },
            node_id_short: "ababababab".into(),
            socket_path: "/s/app.sock".into(),
            roots: vec!["/w".into()],
            launched_app: true,
            mcp_uptime_secs: 1,
        };
        let text = status_summary(&status);
        assert!(text.contains("Mac Studio — node ababababab"), "{text}");
        assert!(text.contains("false — the last boot failed: port in use"), "{text}");
        assert!(text.contains("beam_artifact roots: /w"), "{text}");
        assert!(text.contains("launched by this session: true"), "{text}");
    }

    #[test]
    fn sizes_and_expiries_are_rendered_for_a_person() {
        assert_eq!(human_bytes(512), "1 KiB");
        assert_eq!(human_bytes(2048), "2 KiB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5 MiB");
        let now = now_unix();
        assert_eq!(human_hours(now + 24 * 3600), "24 hours");
        assert_eq!(human_hours(now + 90 * 60), "1 hour");
        assert_eq!(human_hours(now + 600), "10 minutes");
        assert_eq!(human_hours(now.saturating_sub(10)), "less than a minute");
    }
}
