// The `skypie-mcp` binary: one MCP server on stdio.
//
// STDOUT IS THE PROTOCOL. Everything this process wants to say to a human goes
// to stderr — a stray `println!` anywhere in the tree would corrupt the
// JSON-RPC stream and the client would drop the connection.
//
// Nothing is connected here. The app is reached (and launched if needed) by
// the first tool call, so an agent that registers this server and never
// shares a file touches nothing.

use std::sync::Arc;

use rmcp::transport::stdio;
use rmcp::ServiceExt;
use skypie_mcp::{hook, AppClient, SkyPieMcp};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `skypie-mcp hook <event>` — one shot: read stdin, write at most one
    // line, exit 0. Same binary as the server so the plugin ships one file
    // and both halves resolve the state directory identically. An event name
    // this build does not know exits silently, so a hooks.json from a newer
    // plugin cannot break an older binary.
    //
    // Dispatched before any runtime is built, because the two halves want
    // different ones: the hook does a single connect-write-read and exits,
    // and it runs on EVERY `Read` tool call in every session — a multi-thread
    // runtime would spawn one worker per core, then tear them all down, for
    // one socket message. The server keeps the multi-thread runtime it needs.
    let mut argv = std::env::args().skip(1);
    if argv.next().as_deref() == Some("hook") {
        let Some(event) = argv.next().as_deref().and_then(hook::Event::parse) else {
            return Ok(());
        };
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(hook::run(event, Arc::new(AppClient::from_env())));
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(serve())
}

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let app = Arc::new(AppClient::from_env());
    eprintln!("skypie-mcp: app socket {}", app.socket().display());

    let service = SkyPieMcp::new(app).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
