# Sky Pie for Claude Code

Hand a report to the device the user actually reads on, and read what they say
about it.

```
/plugin marketplace add contract-hero/skypie-plugin
/plugin install skypie@skypie
```

Sky Pie.app must be installed on the same Mac. The plugin talks to it
over a local Unix socket; nothing is uploaded anywhere.

## What it adds

**Tools.** `share_link` puts a file on one of the user's own paired devices,
pulled peer-to-peer straight from this Mac. `beam_artifact` makes a link
anyone can fetch. `list_feedback` and `resolve_feedback` are the other
direction: the comments the user left on an artifact, and the way to mark one
addressed. Plus `list_devices`, `pair_device`, `pair_status`,
`confirm_pairing`, `forget_device`, `stop_beam`, `server_status`.

**Hooks.** After a `Read` or a `Write`, any open comments on that file are
injected into the session. On each prompt, one line names files that are
waiting.

Both hooks are silent when there is nothing to say, and neither ever launches
the app — a hook fires on every `Read` in every session, and neither noise nor
a GUI opening by surprise is acceptable there. Nothing listening means
silence.

## The loop this closes

1. Your agent writes `audit.html` and gives the user a `skypie://` link.
2. They read it on their phone, select a paragraph, and say what is wrong.
3. Next time any agent reads that file, your comment is in its context, with
   the line and the quoted text.
4. The agent fixes it and calls `resolve_feedback`. The user watches their own
   note resolve.

## Building the bundle

```
./scripts/build-plugin.sh
claude plugin install dist/plugin
```

Produces a universal (arm64 + x86_64) binary and asserts the hook's silence
before it ships.

## Publishing

This directory is the bundle. The marketplace repository is separate and
public. Copy `dist/plugin` into it, tag, push.

Copyright (c) 2026 Contract Hero. Licensed under Apache-2.0; see the LICENSE
in the application repository.
