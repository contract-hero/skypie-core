# End-to-end harness

Drives the **real** app, on macOS and in the iOS simulator, the way a person
does: the scenarios launch the built app, dispatch the same keyboard chords
and clicks the UI listens for, and read the DOM back. Nothing in the UI is
mocked.

## How a scenario reaches the app

Every app build already speaks one JSON-line protocol on a socket
(`crates/skypie-ipc`). A debug build adds one request to it, `e2e_eval`:
"evaluate this JavaScript expression in the main webview and return the
result". The Rust side (`app/src/e2e.rs`) emits the expression to the page as
a `skypie://e2e-eval` event; `ui/src/hooks/useE2eBridge.ts` runs it as an
async expression and reports the value back through the `e2e_report`
command.

| Platform | Transport | Started by |
|---|---|---|
| macOS | `<state dir>/app.sock`, the socket `skypie-mcp` also uses | always, in every build |
| iOS simulator | `127.0.0.1:<port>` TCP, `e2e_eval` and `status` only | only when `SKYPIE_E2E_PORT` is set; the simulator has no unix socket peer |

## What is gated, and how

`e2e_eval`, the `e2e_report` / `e2e_bridge_enabled` commands and the TCP
listener exist only under `cfg(any(feature = "e2e-hooks", debug_assertions))`.
A release build without the feature has none of them: the socket line fails
to parse, the commands are not registered, and the bridge hook in the page
turns itself off because `e2e_bridge_enabled` does not exist to answer.

## Running

```bash
pnpm -C ui e2e:smoke        # macOS: launch, set a fixture workspace, ⌘P, open a file
pnpm -C ui e2e:ios-smoke    # simulator: build, install, launch, read document.title, screenshot
```

The desktop launcher runs `cargo build` on the shell (dev profile) and starts
the Vite dev server if nothing answers on port 1420. A dev-profile Tauri
binary loads `build.devUrl`, not the embedded bundle, so UI changes are live
on the next launch with no build step. Screenshots of macOS windows are not
available on this machine; macOS assertions are DOM-based. The iOS launcher
checks `skypie-ios/core` out at this checkout's HEAD commit (over the `local`
git remote) before it builds, so commit first.

Scenarios live beside this file (`*.e2e.ts`, `smoke.ts`, `ios-smoke.ts`); the
helpers in `lib/` (`launchDesktop`, `launchIos`, `evalIn`, `keys`, `click`,
`text`, `waitFor`, `quit`, `makeFixtureWorkspace`, `setWorkspaceRoot`) are the
whole API. `out/` holds screenshots and is not tracked.
