# skypie-mcp — hand artifacts from Claude Code to your devices

`skypie-mcp` is a stdio [MCP](https://modelcontextprotocol.io) server that gives a
coding agent one job: take a file the agent just produced and put it in front
of the person who reads it — on their iPhone, on their other Mac, or on a
colleague's machine.

It does not do any of that itself. **The Sky Pie app running on this Mac
is the only network node**; `skypie-mcp` asks it over a local Unix socket, and
launches it when it is not running. The transport between devices is
[iroh](https://iroh.computer): a direct, hole-punched, QUIC connection,
end-to-end encrypted, with an encrypted public relay as fallback. **Nothing is
uploaded to a server.** No public URL exists.

```
Claude Code ──stdio/JSON-RPC──▶ skypie-mcp ──unix socket──▶ Sky Pie.app ──direct QUIC──▶ your iPhone
                                (no identity,               (the one node:
                                 no network)                 identity, peers, blobs)
```

## Contents

- [What it is](#what-it-is)
- [Build](#build)
- [Register with Claude Code](#register-with-claude-code)
- [The tools](#the-tools)
- [Pairing an iOS device, step by step](#pairing-an-ios-device-step-by-step)
- [Where it keeps its files](#where-it-keeps-its-files)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)

## What it is

`skypie-mcp` is a **thin client of the desktop app**. It holds no identity and
no peer list: the devices paired with Sky Pie are the devices it can
address, and a device paired through it is paired with the app. Two things
happen in this process and nowhere else — argument hygiene before a byte
reaches the socket, and the roots gate on `beam_artifact` (see
[Security model](#security-model)).

Two ways a file leaves this Mac:

- **`share_link`** — a `skypie://open?path=…&from=<this Mac>` link for the
  user's **own paired devices**. The device that opens the link pulls the file
  from this Mac at that moment. Nothing is copied ahead of time and nothing is
  queued: the app must be running here when the link is opened.
- **`beam_artifact`** — a `skypie://receive?ticket=…` link **anyone** running
  Sky Pie can open, paired or not. The file is served from this Mac while
  the app runs and until the link expires or is stopped.

Registering the server costs nothing. It connects to the app at the first tool
call, and `open -b ai.skypie.SkyPie` launches the app if the socket is not
there.

## Build

```sh
cargo build --release -p skypie-mcp
```

The binary lands at `target/release/skypie-mcp`. Note the absolute path; the next
step needs it.

```sh
echo "$(pwd)/target/release/skypie-mcp"
```

## Register with Claude Code

```sh
claude mcp add skypie -- /absolute/path/to/skypie/target/release/skypie-mcp
```

Add `--scope user` to make it available in every project instead of only the
current one:

```sh
claude mcp add skypie --scope user -- /absolute/path/to/skypie/target/release/skypie-mcp
```

Check it:

```sh
claude mcp list
```

Inside Claude Code, `/mcp` shows the server and its twelve tools.

### Optional environment

| Variable | Effect |
|---|---|
| `SKYPIE_MCP_ROOTS` | Colon-separated directories `beam_artifact` may publish files from. **This is a boundary**, not a hint: a path outside every root is refused before the app is asked. Defaults to the working directory Claude Code launched the server in. `share_link` and `add_to_pie` are not gated by it — `share_link`'s links open only on the user's own paired devices, and `add_to_pie` never publishes bytes to anyone; it only stores a path reference in the user's own app. |
| `SKYPIE_STATE_DIR` | The Sky Pie state directory, where the app's socket lives. Only for dev builds that run against a separate directory; the default is the app's own. |
| `SKYPIE_APP_BUNDLE_ID` | The bundle id passed to `open -b` when the app has to be launched. Only for a dev build registered under another id. |

Pass them with `claude mcp add --env`:

```sh
claude mcp add skypie --env SKYPIE_MCP_ROOTS=/Users/me/work -- /path/to/skypie-mcp
```

## The tools

Talk to it in plain language — "open that report on my phone", "give me a link
for this chart", "pair my iPad". The tools below are what the model picks from.

### `share_link { path }`

A `skypie://open?path=…&from=<this Mac's node id>` link for one local file.
Open it on any device paired with this Mac and the file opens there, pulled
over the paired session and verified by its BLAKE3 hash. On a device that is
not paired the link says so and points at Settings → Devices.

- `path` — absolute, or relative to the server's working directory. Any
  existing regular file under the transfer cap (256 MiB).

Returns `link`, `web_link`, `node_id`, `device`, `path`, `name`, `size`.
`web_link` is the same intent as `https://skypie.ai/l#open?…`: put
that one in chat, since Claude Desktop and iOS only make `http(s)` clickable.

**The file is pulled when the link is opened**, so Sky Pie must be running
on this Mac at that moment. Nothing is copied, queued or kept.

### `beam_artifact { path, ttl_hours? }`

Publishes one local file as a `skypie://receive?…` link. Give the link to a
person over any channel you already use; they open it, confirm, and the file
streams straight from this Mac.

- `path` — absolute, or relative to the server's working directory. It must
  resolve inside `SKYPIE_MCP_ROOTS` (see [Security model](#security-model)).
- `ttl_hours` — 1 to 720, default 24.

Returns `link`, `ticket`, `name`, `size`, `expires_at`, `hash`.

**The link works only while the app runs.** Quitting Sky Pie ends every
beam; the ⚡ indicator in its toolbar lists the live ones.

### `stop_beam { hash? }`

Revokes a link before it expires. The blobs request gate reads the offer
registry on every request, so the next fetch is refused at once — even from
somebody who still holds the link string.

- `hash` — the content hash `beam_artifact` and `server_status` report, or a
  prefix of 8 characters or more. Omit it to revoke every live link.

### `list_devices { probe? }`

Every device paired with this Mac: name, node id, when it was last seen, and
presence.

- `probe` — when true, the app dials each device once for live presence.
  Without it presence is `"unknown"` unless a session is already open.

A probed device reads one of four words:

- `"online"` — a session is open, or a probe just opened one.
- `"offline"` — it did not answer at all.
- `"refused"` — it answered but would not open a session. It is awake and on
  the network; a version mismatch between the two builds or a device at its
  session cap reads this way. **Nothing about the pairing follows from it.**
- `"unpaired"` — it answered and said this Mac is not on its peer list. This
  is the one that means the pairing is gone, and the only one that justifies
  `forget_device`.

### `pair_device {}`

Mints a one-time `skypie://pair?ticket=…` link and opens pairing for ten
minutes. Returns the link plus the instructions to read to the user. The Mac's
own Settings → Devices shows the same invite as a QR code.

### `pair_status {}`

Pairings waiting for confirmation, each with its **six fingerprint words**.
These words must be shown to the human and compared with the other device's
screen.

### `confirm_pairing { accept, node_id? }`

Finishes or rejects a pending pairing.

- `accept` — `false` discards it and writes nothing to disk.
- `node_id` — only needed when more than one pairing is waiting.

A paired device is one of the user's own. There is no scope to choose: it can
open any file this Mac shares with it by link, and this Mac can open what it
shares back.

### `forget_device { device }`

Unpairs one device.

- `device` — the device name, part of one, or a prefix of its node id (4
  characters or more). An ambiguous or unknown name is an error that lists
  the valid ones.

Links no longer open on that device and it can no longer reach this Mac.
Pairing again restores it. Use it when a device is no longer the user's, or
when `list_devices` reports it as `"unpaired"`. Do **not** reach for it on a
device reported `"refused"`.

### `add_to_pie { pie, path, session_id?, prompt_id? }`

Adds a file (or folder) to one of the user's Sky Pie "pies" — the band of
small pies in the app's toolbar that collect the files a project cares
about. Call it right after you finish writing an artifact the user asked
for, naming the pie for that project.

- `pie` — a name (matched case-insensitively) or a pie id. No pie with this
  name yet? One is created for you — you never need to ask the user to make
  it first. Two existing pies share the name? The call fails and lists their
  ids; call again with one of those. The name is trimmed, must not be empty
  or carry control characters, and is refused above 200 characters — it is the
  label a person reads on the toolbar.
- `path` — absolute, or relative to the server's working directory. A
  leading `~` expands against the user's home directory.
- `session_id`, `prompt_id` — optional identifiers for this session/turn,
  stored on the member for the user's own reference. They are provenance
  only and never change what the call does. Each is trimmed, dropped when
  empty, and refused above 128 characters.

Returns `pie` (name), `pie_id`, `path` (canonical), `members` (the pie's
member count after the call), `created` and `added` (`false` when the path
was already a member — the call is idempotent and writes nothing). When the
file is newly added AND newer than the last time the user opened that pie,
the toolbar shows a fresh-file pill on it. A file joins the pie's file
layer; a folder becomes a layer of its own.

### `server_status {}`

The app's node id, its state directory, whether it has opened its network,
its uptime, how many devices are paired and which beam links are still being
served — plus this process's socket path, the roots `beam_artifact` is
confined to, and whether this session launched the app.

## Pairing an iOS device, step by step

1. **Ask for it.** In Claude Code: *"pair my iPhone"*. The model calls
   `pair_device` and shows you a `skypie://pair?ticket=…` link. Sky Pie on
   the Mac shows the same invite as a QR code under Settings → Devices.

2. **Get the link onto the phone.** Scan the QR code with the camera, AirDrop
   the link, or iMessage it to yourself. The link is a capability with a
   ten-minute life — treat it like a password for those ten minutes.

3. **Open it on the phone.** Sky Pie opens and shows an incoming pairing
   from your Mac, with **six words**.

4. **Compare the words.** Ask Claude Code for `pair_status`. It prints six
   words. They must be the same six words, in the same order, as the phone
   shows. **If they differ, stop** — something is between the two machines.
   Reject it: *"reject the pairing"* → `confirm_pairing { accept: false }`.

5. **Confirm on both sides.** Accept on the phone, and tell Claude Code
   *"the words match, confirm it"* → `confirm_pairing { accept: true }`.

6. **Share something.** *"Open /Users/me/work/report.html on my iPhone"*. The
   model calls `share_link`; open the link on the phone and the report opens
   there, pulled from the Mac.

Pairing a second Mac running Sky Pie is the same walkthrough.

## Where it keeps its files

Nothing. Every file below belongs to the app, under
`~/Library/Application Support/SkyPie/`:

| Path | Content |
|---|---|
| `app.sock` | The socket this server talks to. Created by the app at launch, `0600`, removed at quit. |
| `remote/identity.key` | The ed25519 secret key that IS this Mac's identity. Written `0600`. Deleting it changes the node id and orphans every pairing. |
| `remote/peers.json` | The devices this Mac trusts. Deleting an entry revokes it on the next request. |
| `remote/blobs/` | The content-addressed store staged files are served from. |
| `received/<date>/` | Files this Mac accepted from a beam link. |

An older build kept its own tree under `SkyPie/mcp/`; it is unused now and can
be deleted.

## Security model

**Paired means yours.** A paired device may read any file this Mac shares
with it by link — there is no narrower grant. The trust decision is made once,
at pairing, by comparing the six words. A device that is not yours does not
get paired; it gets a beam link.

**The fingerprint is the whole point of pairing.** The six words derive from
both node ids, so a machine in the middle — which necessarily holds a different
key on each leg — cannot make the two screens agree. Skipping the comparison
skips the security.

**A share link is not a capability.** `skypie://open?…&from=` carries a path and
a node id, nothing more. Opening it on an unpaired device does nothing; opening
it on a paired one makes THAT device ask this Mac, over a session the peer
list admits, for the bytes of that one file. Learning the hash of a file never
makes it fetchable: the blob gate admits a hash only to the NodeId that asked
for it through a session.

**A beam link IS a capability, and it is gated here.** Every `beam_artifact`
path passes the roots gate over `SKYPIE_MCP_ROOTS` before the app is asked, and
then the app's own offer policy: a real file, under the transfer size cap. This
is stricter than the desktop share sheet on purpose. There, a human picks the
file in a dialog. Here the caller is a language model, and its arguments can be
steered by text it merely read — a repository file, a fetched page, another
tool's output. Narrowing `SKYPIE_MCP_ROOTS` narrows what such a caller can ever
publish to a stranger.

**`add_to_pie` is not gated by `SKYPIE_MCP_ROOTS` either, for a different
reason than `share_link`.** It never sends a byte to anyone — it only writes
a path reference into a pie the user already sees in their own toolbar, the
same app-local record a Finder drag onto that pie would produce. There is no
stranger it could publish to, so the roots gate (which exists to bound what
a model-steered caller can offer to a THIRD PARTY) does not apply.

**A link is revocable, not just expiring.** `stop_beam` drops the offer from
the registry the request gate consults, so revocation takes effect on the next
fetch. The TTL is the backstop for a link nobody remembered to stop.

**Received bytes are verified, not trusted.** A pulled or beamed artifact is
BLAKE3-checked chunk by chunk against the announced content address, capped on
real measured bytes, staged as `.partial` and only then moved into place.

**The socket is this user's.** `app.sock` is `0600` inside a `0700`
directory; any process running as this user can drive the app through it —
the same boundary `identity.key` already draws.

**No stdout.** Stdout is the JSON-RPC channel. Every log line goes to stderr.

## Troubleshooting

**"Sky Pie is not running and could not be launched"** — `open -b
ai.skypie.SkyPie` failed: the app is not installed, or a dev build is
registered under another id (`SKYPIE_APP_BUNDLE_ID`). Open the app by hand and
try again.

**"Sky Pie was launched but its socket … did not come up"** — the app
started but did not bind `app.sock` within 15 s. A second copy of the app
over the same state directory does not bind it; check for one.

**"no paired device matches …"** — the error lists the names that do exist. Use
one of those, or a node-id prefix.

**"path not found or out of root"** — one message for "does not exist" and "not
allowed", on purpose: a refusal must not tell a caller what exists. Check the
path, and check `SKYPIE_MCP_ROOTS` if you set it.

**A share link says "Device unreachable" on the phone** — the app on this Mac
is not running, or the Mac is asleep. The link is not a copy of the file; the
phone pulls it at open time. Wake the Mac, open Sky Pie, tap **Try
again**.

**A share link says "Not a paired device"** — the phone is not paired with
this Mac (or was unpaired). Settings → Devices → Pair a device… on the Mac,
then open the link again.

**The macOS firewall prompts on first use** — the app binds a UDP socket to
accept direct connections. Allow it, or the transfer falls back to a relay and
gets slower.

**A beam link stopped working** — the app quit or the TTL expired. Mint a new
one.

**"another Sky Pie is already using the blob store"** — one state
directory serves one copy of the app at a time; a dev build (`pnpm tauri dev`)
and the installed `.app` share one unless `SKYPIE_STATE_DIR` says otherwise.
Close the other one.

**Nothing appears in `/mcp`** — check `claude mcp list`, and confirm the path
you registered is absolute and the binary is executable. Run it by hand: it
should print one line naming the socket to stderr and then wait.
