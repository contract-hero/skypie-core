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
| macOS | `<state dir>/app.sock`, the socket `skypie-mcp` also uses | always, in every build — but `e2e_eval` itself exists only in a debug or `e2e-hooks` build |
| iOS simulator | `127.0.0.1:<port>` TCP | only when `SKYPIE_E2E_PORT` is set; the simulator has no unix socket peer |

Both transports run the same connection handler and the same dispatcher
(`app/src/ipc_server.rs`), so a verb answers identically on either — with one
deliberate difference. Each listener declares a capability: the unix socket
is `Transport::Trusted` (0600 in the state directory, so whoever reaches it
is already this user), the loopback TCP port is `Transport::E2eOnly` and the
dispatcher refuses the sharing and pairing verbs on it, because any process
on the machine can dial a loopback port. The MCP verbs are macOS-only on top
of that, because the code behind them is; on iOS they answer an error.

## What is gated, and how

`e2e_eval`, the `e2e_ready` / `e2e_report` commands and the TCP listener
exist only under `cfg(any(feature = "e2e-hooks", debug_assertions))`. A
release build without the feature has none of them: the socket line fails to
parse and the commands are not registered. `ui/src/hooks/useE2eBridge.ts`
ships in every build, but it attaches its listener and then invokes
`e2e_ready`; in a release build that call rejects, the hook removes the
listener again, and the bridge stays off for the life of the process.

The one thing the harness needs that no DOM primitive offers — moving the
workspace root, which lives in React context — is published as
`window.__skypieE2e.setWorkspaceRoot` by `App.tsx`'s `E2eSeam`, which
renders only after the bridge reported ready. Production renders nothing.

## Running

```bash
pnpm -C ui e2e:smoke        # macOS: launch, set a fixture workspace, ⌘P, open a file
pnpm -C ui e2e:m1           # macOS: the M1 Sky checkpoint — ⌘⇧B, the Recent plate, a slice, a relaunch
pnpm -C ui e2e:ios-smoke    # simulator: build, install, launch, read document.title, screenshot
```

The desktop launcher runs `cargo build` on the shell (dev profile) and starts
the Vite dev server if nothing answers on port 1420. A dev-profile Tauri
binary loads `build.devUrl`, not the embedded bundle, so UI changes are live
on the next launch with no build step. Screenshots of macOS windows are not
available on this machine; macOS assertions are DOM-based. The iOS launcher
checks `skypie-ios/core` out at this checkout's HEAD commit (over the `local`
git remote) before it builds, so commit first. It targets the simulator named
`iPhone 17 Pro`; `SKYPIE_E2E_SIM` names another, and `SKYPIE_IOS_SHELL` points
at an `skypie-ios` checkout kept somewhere other than beside this one.

Scenarios live beside this file (`smoke.ts`, `ios-smoke.ts`, and one
`<milestone>.e2e.ts` per feature milestone); each is an explicit `pnpm`
script in `ui/package.json`, there is no glob — a file nothing references
runs nowhere. The helpers in `lib/` (`launchDesktop`, `launchIos`, `evalIn`, `keys`, `click`,
`text`, `waitFor`, `quit`, `makeFixtureWorkspace`, `setWorkspaceRoot`,
`cleanupFixtureWorkspace`, and the iOS handle's `screenshot`) are the whole
API. `out/` holds screenshots and is not tracked.

## Verifying a change to the harness

`scripts/verify.sh` (in the repo root) runs everything that has to pass. One
line there cannot be replaced by `cargo test --workspace`: `cargo test -p
skypie-ipc --release` is the only build with `debug_assertions` off, and so
the only one where the "a release build cannot even parse an `e2e_eval` line"
test compiles at all. `pnpm -C ui e2e:ios-smoke` builds against HEAD, so run
it after committing.
