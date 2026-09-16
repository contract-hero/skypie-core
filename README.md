# Sky Pie

A distraction-free macOS viewer for local HTML artifacts — a native reading room for the reports, plans and pages your tools generate. Browser-style tabs and history over a read-only workspace tree, full-fidelity HTML/Markdown rendering with live reload, native file drag-out, peer-to-peer sharing — a link that opens on **your own paired devices**, or a **Beam** link for anyone — and a `skypie://` URL scheme for deep-linking from Claude Code or any other tool.

Built with Tauri 2 + React + TypeScript. Ships as a small native `.app` (no Node runtime needed once built).

## Install

```bash
./scripts/build-app.sh
cp -R target/release/bundle/macos/Sky Pie.app /Applications/
```

First launch: right-click → Open (Gatekeeper prompt — the app isn't notarized).

## Use

### Tabs & navigation

- **Tabs**: `⌘T` new tab, `⌘W` close, `⌃Tab` / `⌘⇧[` `⌘⇧]` switch, `⌘1–9` jump, drag to reorder. `⌘-click` or middle-click any file row, bookmark, or link inside a preview to open it in a background tab (`⌘⇧-click` foregrounds it).
- **History**: every tab has its own back/forward stack — `⌘[` / `⌘]` or the toolbar arrows.
- **Address bar**: shows the open file's path; type or paste an absolute path / `file://` URL / `skypie://open?path=…` URL and hit Enter. `⌘L` focuses it, Esc reverts.
- **Reload**: `⌘R` or the toolbar button reloads the current file.
- **Quick open**: `⌘P` fuzzy-searches every file in the workspace.
- **Start page**: an empty tab shows your bookmarks and recent files.

### Live reload

Files open in tabs **auto-reload when they change on disk** — edit an artifact (or let Claude regenerate it) and the preview updates in place, preserving your scroll position. Works for workspace files and for external files open in tabs (their parent dirs are watched individually, surviving atomic saves). Deleted files show a notice and come back automatically if re-created.

### Browsing

- **Pick workspace**: first launch shows "Choose workspace folder…" — pick any directory; it's remembered.
- **Tree**: chevron-expand folders inline; full keyboard navigation (arrows, Enter, Home/End) with VoiceOver-friendly ARIA. The active tab's file auto-reveals in the tree.
- **Right-click** any file row, bookmark, or tab: Open in New Tab, Reveal in Finder, Copy Path, Bookmark. (No "Open in Default App" — that would need an arbitrary-program-launch capability grant; use Reveal in Finder instead.)
- **Bookmarks**: ☆ on a file row or the toolbar star. Drag to reorder, hover ✕ to remove. Persists across restarts.
- **Open any file**: `⌘O` → file picker. Out-of-workspace files render with an "external" badge.
- **Drag files out**: drag any file row into Finder, Slack, Mail, upload zones — a real macOS `kUTTypeFileURL` drop.
- **Zoom**: `⌘+` / `⌘−` / `⌘0`, per tab.
- **Share ▾**: one toolbar menu. *Copy link for my devices* (⌘⇧C), *Share link…* (native sheet with that link), *Beam to anyone…*, *Share file…* (the raw file, for Mail and Messages attachments), and *Open in Slack* when a target is configured.

### Sharing — your devices, and everyone else

Both routes are peer-to-peer over [iroh](https://iroh.computer): a direct, hole-punched, end-to-end encrypted QUIC connection, with an encrypted relay as fallback. No account, no upload, no VPN. The app opens no sockets until you share or pair something (or, once paired, at launch — *Listen at launch* in Settings → Devices).

**Your own devices — pair once, then links just work.** Settings → Devices → *Pair a device…* shows an invite as a link and a QR code. Open it on the other device (scan it with the iPhone camera, AirDrop it, paste it), and both screens show the same six words; confirm they match and the devices are paired. From then on, **Share ▾ → Copy link for my devices** produces a `skypie://open?path=…&from=…` link for the file you are reading. Open that link on any paired device and the file opens there — pulled straight from this machine, verified, with a **from &lt;Device&gt;** badge. If the origin is asleep the tab says *Device unreachable* with a *Try again*; if the devices are not paired, the toast points you at Devices. Nothing is copied ahead of time and nothing is queued. A paired device is trusted in full: any file you share with it by link, it can open.

**Anyone else — Beam.** *Share ▾ → Beam to anyone…* (or right-click a file → **Beam to Anyone…**) stages the file and mints a `skypie://receive?ticket=…` link. Send it over any channel; the link is a capability, not the content. Clicking it on the other machine raises the app and shows a confirm dialog — file name, size, the sender's identity fingerprint. **Nothing transfers until they accept**; the stream is integrity-verified (BLAKE3), lands in the app's own `received/` folder, and opens in a tab with a **beamed** badge. Received HTML renders in a hardened, origin-isolated iframe. While the app runs it serves the offer (default 24 h); the ⚡ indicator lists active beams with fetch counts and a **Stop** that revokes the link instantly.

Both machines need Sky Pie running. First inbound connection may trigger the macOS firewall prompt on the serving side.

**From Claude Code**: `skypie-mcp` drives the same features through the running app — see `README-MCP.md`.

### Rendering

- `.html` → full inline CSS/JS/SVG render (browser fidelity) in a sandboxed iframe; `<base href>` injected so relative resources resolve. Links to local files navigate in-app (with tab history); `http(s)` links open in the OS browser. **Beamed** (received) HTML renders in a hardened iframe — an opaque origin with no reach into the app and no `<base href>` — since its author is remote and untrusted.
- `.md` → marked + shiki + mermaid + **KaTeX math**, centered, theme-aware.
- Code/text → shiki-highlighted, theme-aware.
- Images → PNG/JPEG/GIF/WebP/BMP/ICO/AVIF render natively (base64 pipeline, 20 MiB cap); SVG renders inline (scripts stripped).

### Chrome

- **Theme**: warm ink (dark) / paper (light), following the macOS system appearance automatically. Artifact iframes and code highlighting swap with it.
- **Native overlay title bar**: the tab strip sits flush with the traffic lights.
- Window size/position, sidebar width, bookmarks and recents all persist across restarts.
- **Deep links foreground the app**: `skypie://…` arrivals raise + focus the window; if the file is already open its tab is focused instead of duplicating.

## CLI

```bash
cd cli && cargo build --release
./target/release/skypie open ~/workspace/some-project/README.md
```

`skypie open <path>` shells `open skypie://open?path=<encoded>` — the running app catches the deep link and opens the file. `skypie reveal <path>` expands + highlights it in the tree without switching the preview.

`skypie beam <path>` opens the send dialog for that file (mint a Beam link); `skypie receive <ticket>` (or a full `skypie://receive?…` link) opens the confirm-and-fetch dialog. Both only hand an intent to the app — nothing is staged or fetched without your click.

## Stack

- Tauri 2 (Rust shell + WKWebView), React 18 + TS + Vite
- Plugins: `tauri-plugin-deep-link`, `tauri-plugin-dialog`, `tauri-plugin-drag`, `tauri-plugin-opener`, `tauri-plugin-window-state`
- Render libs: `marked` (+ `marked-katex-extension`), `shiki`, `mermaid`, `katex`
- P2P transport: `iroh` + `iroh-blobs` (QUIC, hole-punched, content-addressed), exact-version pinned; pairing QR via `uqr`

## Develop

```bash
pnpm install
pnpm tauri dev     # app with hot reload
pnpm test          # vitest (tabs reducer, fuzzy matcher, explorer utils, badges, beam formatting)
cargo test --workspace       # Rust: app, iroh core (incl. two-endpoint pair + pull and Beam transfer proofs), MCP thin client, IPC contract
```

## Status / next steps

See `STATUS.md` for the current state and open items.
