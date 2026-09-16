// skypie-mcp — an MCP server that lets a coding agent hand artifacts to the
// Sky Pie devices a person actually reads them on.
//
// The agent produces a report, a chart, an HTML explainer; the person wants it
// on their phone or their other Mac. This server is the bridge: it speaks MCP
// over stdio to the agent, and a Unix socket to the Sky Pie app running
// on this Mac — which is the ONLY iroh node on the machine. No identity, no
// peer list and no transport live here; the app owns them, and it is launched
// when it is not running.
//
// Layout:
//   * `args`   — the tool schemas and the pure argument validation;
//   * `core`   — the socket client, the launch-and-retry, the roots gate;
//   * `server` — the rmcp handler that wraps `core` in eleven tools;
//   * `hook`   — the `skypie-mcp hook <event>` subcommand the Claude Code
//                plugin runs, which reuses the same socket client.

pub mod args;
pub mod core;
pub mod hook;
pub mod server;

pub use core::AppClient;
pub use server::SkyPieMcp;
