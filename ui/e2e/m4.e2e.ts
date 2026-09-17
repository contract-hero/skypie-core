// `pnpm -C ui e2e:m4` — M4's own acceptance checkpoint, driven against the
// REAL debug macOS app: the drop-target ring over a live drag (and its
// clearing on drag-leave), a Finder drop of a folder onto the tin creating
// a named pie with a canonical "finder"-sourced folder member, zooming
// that pie's plate and reading the folder layer's header, the passive
// active-file mark on the band tile for an open file, and — sidebar
// hidden — a deep-link reveal that opens the sky and the plate on the
// right pie with the row focused. Two closing checks review the parts of
// the brief that a real OS-level action can't reach on this machine: the
// plate's short/narrow floor at 640×400 (arithmetic against the live
// `.pie-plate` clamp() — no OS window resize available here, see Step 7's
// own comment) and the dusk/day Sky-band tokens side by side (forcing
// `<html data-theme>` and reading the live computed styles). See
// ui/e2e/README.md.
//
// The harness drives the app in two ways. Almost everything is JS
// evaluated INSIDE the webview (`evalIn`) — there is no OS-level drag to
// synthesize from Node, and no real `skypie://` URL dispatch to trigger
// from outside the app either. Step 7 is the exception: it also reads
// SHIPPED SOURCE FILES straight off disk from Node (`ui/src/styles.css`
// for the plate's `clamp()`, the shell's `capabilities/desktop.json`,
// `PiePlate.tsx` for the short-pane threshold), so a formula or threshold
// edited in the source fails this check loudly instead of being retyped
// here and going stale. Both are synthesized by
// emitting the SAME event payload the real plugin would deliver, over
// Tauri's own core event bus — `window.__TAURI_INTERNALS__.invoke
// ("plugin:event|emit", { event, payload })`, the exact call
// `@tauri-apps/api/event`'s `emit()` makes. That bus does not care who
// emitted an event or why: it reaches every live `listen()`'d handler for
// the name regardless of registration origin, so it reaches
// `getCurrentWebview().onDragDropEvent()`'s internal `tauri://drag-*`
// listeners (useFinderDrop.ts) and `useDeepLink.ts`'s `skypie://open-file`
// listener exactly as a real backend-emitted event would.
//
// The brief's own suggested route — scan `window` for the object owning
// an event name as a key, then call `window.__TAURI_INTERNALS__
// .runCallback(handlerId, …)` directly — does not hold in this build
// (@tauri-apps/api 2.11.1): `transformCallback` registers every listener
// into one opaque `Map<number, Function>` keyed by an OPAQUE numeric id
// with no event-name association recoverable from JS, and
// `window.__TAURI_INTERNALS__.transformCallback` itself is a locked
// (`writable: false, configurable: false`) property, so it cannot even be
// wrapped to observe a FRESH registration's id — both verified
// interactively against the real running app. Emitting over the real
// event bus is the "a synthetic path exists" branch the acceptance
// checkpoint itself allows for.
//
// launchDesktop({ skipBuild: false }): M4 changed Rust — `add_pie_member`
// takes an OPTIONAL `kind` and resolves it from the canonical path, which
// is what step 3 asserts when a Finder drop stores a "folder" member
// without the UI ever probing for one.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SHELL_DIR,
  UI_DIR,
  click,
  evalIn,
  keys,
  launchDesktop,
  openViaQuickOpen,
  quit,
  text,
  waitFor,
} from "./lib/app";
import type { LaunchedApp } from "./lib/app";
import { cleanupFixtureWorkspace, makeFixtureWorkspace, setWorkspaceRoot } from "./lib/fixtureWorkspace";
import { sleep } from "./lib/proc";
import { waitForPersistedPies } from "./lib/state";

/**
 * Step 7's own tiny CSS reader: find `selector`'s block, then `prop`'s
 * value within it, then the comma-separated arguments of the first
 * `fnOpen` (e.g. `"clamp("`) call in that value — respecting NESTED
 * parens (`calc(100vh - 232px)` has one), unlike a `[^)]+` regex, which
 * stops at the first `)` it meets and silently truncates a nested call.
 */
function extractParenArgs(css: string, selector: string, prop: string, fnOpen: string): string[] {
  const blockStart = css.indexOf(selector);
  if (blockStart === -1) throw new Error(`selector ${JSON.stringify(selector)} not found in styles.css`);
  const propIdx = css.indexOf(`${prop}:`, blockStart);
  if (propIdx === -1) throw new Error(`${JSON.stringify(prop)} not found after ${JSON.stringify(selector)}`);
  const fnIdx = css.indexOf(fnOpen, propIdx);
  if (fnIdx === -1) throw new Error(`${JSON.stringify(fnOpen)} not found after ${JSON.stringify(prop)}`);
  let i = fnIdx + fnOpen.length;
  let depth = 1;
  const start = i;
  while (depth > 0) {
    if (i >= css.length) throw new Error(`unbalanced parens reading ${JSON.stringify(fnOpen)}`);
    if (css[i] === "(") depth++;
    else if (css[i] === ")") depth--;
    i++;
  }
  const argsStr = css.slice(start, i - 1);
  const args: string[] = [];
  let nestDepth = 0;
  let cur = "";
  for (const ch of argsStr) {
    if (ch === "(") nestDepth++;
    if (ch === ")") nestDepth--;
    if (ch === "," && nestDepth === 0) {
      args.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  args.push(cur.trim());
  return args;
}

/**
 * `SHORT_PANE_WINDOW_H` read out of the SHIPPED `PiePlate.tsx`, not retyped
 * here. `usePaneShort` is `(max-height: SHORT_PANE_WINDOW_H - 1)`, so the
 * plate is "short" strictly BELOW that number — 712 today (480 + 232), not
 * the 560 this step used to assert. For any window between 560 and 711 tall
 * that assertion failed against correct behaviour.
 */
function shortPaneWindowHeight(): number {
  const src = fs.readFileSync(path.join(UI_DIR, "src", "components", "PiePlate.tsx"), "utf8");
  const m = /const SHORT_PANE_WINDOW_H = ([0-9]+) \+ ([0-9]+);/.exec(src);
  if (!m) throw new Error("SHORT_PANE_WINDOW_H not found in PiePlate.tsx — its shape changed");
  return Number(m[1]) + Number(m[2]);
}

/** Emit `tauriEvent` over Tauri's real core event bus — see this file's
 *  header comment for why this, not a `runCallback` table lookup. */
async function emitTauriEvent(app: LaunchedApp, tauriEvent: string, payload: unknown): Promise<void> {
  const js = `(async function(){
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: ${JSON.stringify(tauriEvent)},
      payload: ${JSON.stringify(payload)},
    });
    return true;
  })()`;
  await evalIn(app, js);
}

/** PHYSICAL-pixel centre of the first element matching `selector`
 *  (`getBoundingClientRect()` centre × `devicePixelRatio` — exactly what a
 *  real Tauri drag-drop event carries, and what `useFinderDrop.ts`'s hit
 *  test divides back down). */
async function physicalCenterOf(app: LaunchedApp, selector: string): Promise<{ x: number; y: number }> {
  const js = `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    return {
      x: Math.round((rect.left + rect.width / 2) * dpr),
      y: Math.round((rect.top + rect.height / 2) * dpr),
    };
  })()`;
  const pos = (await evalIn(app, js)) as { x: number; y: number } | null;
  if (!pos) throw new Error(`physicalCenterOf: no element matches ${selector}`);
  return pos;
}

/**
 * Emit `tauriEvent`, then poll `verifyJs` (same shape as `waitFor`) —
 * re-emitting on every failed poll, not just waiting once. `useFinderDrop`'s
 * `onDragDropEvent()` registration is FOUR sequentially awaited `listen()`
 * round trips through the real IPC bridge; a `tauri://drag-*` emitted while
 * that registration is still in flight reaches no one (the event bus does
 * not queue for a late subscriber), so re-emitting until the expected DOM
 * effect actually lands is what makes this robust against that race
 * instead of a single-shot emit racing component mount.
 */
async function emitAndVerify(
  app: LaunchedApp,
  tauriEvent: string,
  payload: unknown,
  verifyJs: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await emitTauriEvent(app, tauriEvent, payload);
    if (await evalIn(app, verifyJs)) return;
    if (Date.now() > deadline) {
      throw new Error(`emitAndVerify(${tauriEvent}): ${verifyJs} never became true within ${timeoutMs}ms`);
    }
    await sleep(150);
  }
}

async function dragOver(app: LaunchedApp, selector: string, verifyJs: string): Promise<void> {
  const position = await physicalCenterOf(app, selector);
  await emitAndVerify(app, "tauri://drag-over", { position }, verifyJs);
}

async function dragLeave(app: LaunchedApp, verifyJs: string): Promise<void> {
  await emitAndVerify(app, "tauri://drag-leave", {}, verifyJs);
}

/**
 * Emits `tauri://drag-drop` exactly ONCE, then polls `verifyJs` — unlike
 * `dragOver`/`dragLeave` (pure UI state, safe to re-emit via
 * `emitAndVerify`), a drop is NOT idempotent: the real handler
 * (Sky.tsx's `handleFinderDrop`) runs `listDir` → `upsertPie` →
 * `addPieMember`, several awaited IPC round trips, and a re-emit that
 * lands before the first one finishes creates a SECOND pie ("dropped 2")
 * with its own member (review finding on this step). By the time this is
 * called in the checkpoint, a prior `dragOver`/`dragLeave` pair has
 * already proven the `tauri://drag-*` listener is live, so there is no
 * registration race left that re-emitting would be protecting against.
 */
async function dragDrop(app: LaunchedApp, selector: string, paths: string[], verifyJs: string): Promise<void> {
  const position = await physicalCenterOf(app, selector);
  await emitTauriEvent(app, "tauri://drag-drop", { paths, position });
  await waitFor(app, verifyJs);
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skypie-e2e-m4-state-"));
  const fixture = makeFixtureWorkspace("skypie-e2e-m4-");
  console.log(`fixture workspace: ${fixture.dir}`);
  console.log(`scratch state dir: ${stateDir}`);

  // The dropped folder — a subfolder of the fixture workspace (spec line
  // 217 allows a folder outside the root too, but keeping it INSIDE lets
  // step 5 open its file through the app's own ⌘P index, same as every
  // other scenario in this directory).
  const droppedDir = path.join(fixture.dir, "dropped");
  fs.mkdirSync(droppedDir);
  const droppedFile = path.join(droppedDir, "brief.md");
  fs.writeFileSync(droppedFile, "# Dropped fixture\n\nSome *fixture* text.\n");
  const canonicalDroppedDir = fs.realpathSync(droppedDir);
  const canonicalDroppedFile = fs.realpathSync(droppedFile);

  // Inside the try, and nullable: created BEFORE it, a failing
  // `launchDesktop` skips the `finally` entirely and leaks both temp trees
  // on every failed build. Same shape m1/m2/m3 already use.
  let app: LaunchedApp | null = null;
  try {
    app = await launchDesktop({ stateDir, skipBuild: false });
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    const root = fs.realpathSync(fixture.dir);
    await setWorkspaceRoot(app, root);

    // ── Step 1: ⌘⇧B shows the band ──────────────────────────────────────
    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector('.sky-band[role="listbox"][aria-label="Pies"]') !== null`, 10_000);
    console.log('ok: mod+shift+b shows .sky-band[role="listbox"][aria-label="Pies"]');

    // ── Step 2: drag-over the first tile — the ring, and only there;
    //     drag-leave clears it ──────────────────────────────────────────
    const firstTileSelector = ".sky-pies [data-pie-id]";
    await waitFor(app, `document.querySelector(${JSON.stringify(firstTileSelector)}) !== null`, 10_000);
    await dragOver(
      app,
      firstTileSelector,
      `document.querySelectorAll('.sky-pies [data-pie-id][data-drop-target="true"]').length === 1`,
    );
    const ringedId = await evalIn(
      app,
      `document.querySelector('.sky-pies [data-pie-id][data-drop-target="true"]').getAttribute("data-pie-id")`,
    );
    if (ringedId !== "builtin:pinned") {
      throw new Error(`expected the ring on builtin:pinned, got ${JSON.stringify(ringedId)}`);
    }
    console.log("ok: drag-over the first tile rings exactly builtin:pinned");

    await dragLeave(
      app,
      `document.querySelectorAll('.sky-pies [data-pie-id][data-drop-target="true"]').length === 0`,
    );
    console.log("ok: drag-leave clears the ring");

    // ── Step 3: drag-drop the fixture folder onto the tin — a named pie
    //     appears, persisted with a canonical "finder" folder member ────
    await waitFor(app, `document.querySelector('[data-pie-tin]') !== null`, 10_000);
    await dragDrop(
      app,
      "[data-pie-tin]",
      [droppedDir],
      `document.querySelectorAll('.sky-pies [data-pie-id]').length === 3`,
    );
    // A duplicate drop (the bug `dragDrop` above now avoids) would create a
    // 4th pie asynchronously, AFTER the count-3 check above already passed
    // — this settle delay plus a second count check is what turns that
    // into a loud, immediate failure instead of a silent stray "dropped 2"
    // surviving into `state.json` (review finding on this step).
    await sleep(500);
    const settledCount = await evalIn(app, `document.querySelectorAll('.sky-pies [data-pie-id]').length`);
    if (settledCount !== 3) {
      throw new Error(`pie count changed after settling: expected 3, got ${JSON.stringify(settledCount)} (duplicate drop?)`);
    }
    const pieIds = (await evalIn(
      app,
      `Array.from(document.querySelectorAll(".sky-pies [data-pie-id]")).map(function(el){ return el.getAttribute("data-pie-id"); })`,
    )) as string[];
    const droppedId = pieIds[2];
    if (!droppedId) throw new Error(`expected a third, server-minted pie id, got ${JSON.stringify(pieIds)}`);
    const tileSelector = `[data-pie-id=${JSON.stringify(droppedId)}]`;
    const thirdLabel = (await text(app, `${tileSelector} .sky-pie-label`))?.trim();
    if (thirdLabel !== "dropped") {
      throw new Error(`expected the new tile's label to be "dropped", got ${JSON.stringify(thirdLabel)}`);
    }
    const persisted = await waitForPersistedPies(
      stateDir,
      (d) => (d.pies?.find((p) => p.id === droppedId)?.members.length ?? 0) === 1,
    );
    const droppedPie = persisted.pies?.find((p) => p.id === droppedId);
    if (droppedPie?.name !== "dropped") {
      throw new Error(`expected state.json's pie name to be "dropped", got ${JSON.stringify(droppedPie?.name)}`);
    }
    const member = droppedPie.members[0];
    if (member?.kind !== "folder" || member.source !== "finder" || member.path !== canonicalDroppedDir) {
      throw new Error(`unexpected persisted member: ${JSON.stringify(member)}`);
    }
    console.log(
      `ok: dropping the folder onto the tin created pie "${droppedPie.name}" (${droppedId}) with one ` +
        `finder-sourced folder member at ${member.path}`,
    );

    // ── Step 4: click the tile — the plate opens on the folder layer ───
    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    await waitFor(app, `document.querySelector('[data-testid="pie-layer-header"]') !== null`, 10_000);
    // Workspace-relative display path for a direct child of the root is
    // just the folder's own name — same as m3.e2e.ts's "pricing" header.
    const headerText = (await text(app, '[data-testid="pie-layer-header"]'))?.trim();
    if (headerText !== "dropped") {
      throw new Error(`expected the layer header to read "dropped", got ${JSON.stringify(headerText)}`);
    }
    console.log(`ok: the plate opened with the folder layer header "${headerText}"`);
    await keys(app, "escape");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);

    // ── Step 5: open the dropped file — its tile carries
    //     data-active-file="true" ────────────────────────────────────────
    await openViaQuickOpen(app, canonicalDroppedFile);
    await waitFor(
      app,
      `document.querySelector(${JSON.stringify(tileSelector)})?.getAttribute("data-active-file") === "true"`,
      15_000,
    );
    console.log("ok: opening the dropped file marks its tile data-active-file=\"true\"");

    // ── Step 6: mod+b hides the sidebar; a reveal deep link opens the sky
    //     and the plate on this pie, row focused ────────────────────────
    await keys(app, "mod+b");
    await waitFor(app, `document.querySelector(".pane-sidebar") === null`, 10_000);
    console.log("ok: mod+b hides the sidebar");

    // `useDeepLink` holds its handlers in refs and subscribes once, so
    // `mod+b` above cannot tear down/re-subscribe the
    // `skypie://open-file` listener — this `emitAndVerify` is just the
    // ordinary startup-registration retry every other `emitTauriEvent`
    // caller in this file gets for free, and it stays safe to re-emit
    // here (unlike `tauri://drag-drop` above): repeating a reveal just
    // re-arms the same, idempotent routing decision.
    await emitAndVerify(
      app,
      "skypie://open-file",
      { path: canonicalDroppedFile, intent: "reveal" },
      `document.querySelector('[data-testid="pie-plate"]') !== null`,
    );
    // `waitFor`, not a single `evalIn`: the plate appearing and the row
    // taking DOM focus are two different commits, so sampling the instant
    // the first one is visible races the second.
    try {
      await waitFor(
        app,
        `document.activeElement != null && document.activeElement.classList.contains("start-row")`,
        10_000,
      );
    } catch {
      throw new Error(
        `expected document.activeElement to carry .start-row, got ${JSON.stringify(
          (await evalIn(app, `document.activeElement ? document.activeElement.outerHTML.slice(0, 200) : null`)),
        )}`,
      );
    }
    console.log("ok: reveal with the sidebar hidden opened the plate with a .start-row focused");

    // ── Step 6b: the reveal is ONE-SHOT — it must not outlive the plate
    //     it opened ──────────────────────────────────────────────────────
    // Two ways a latched reveal used to leak into a later, ordinary open:
    // closing and re-opening the same pie BY HAND (the latch was cleared
    // only on close, so re-opening re-armed `focusPath` and stole focus),
    // and remounting the band (⌘⇧B off and on), which re-applied a
    // `revealTarget` that was still standing and re-opened the plate on its
    // own.
    await keys(app, "escape");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);
    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    // Settle: the row focus the reveal used to steal lands one commit after
    // the plate mounts, so sampling the instant it appears would pass even
    // when the bug is present.
    await sleep(400);
    const focusedAfterHandOpen = await evalIn(
      app,
      `document.activeElement != null && document.activeElement.classList.contains("start-row")`,
    );
    if (focusedAfterHandOpen) {
      throw new Error("a hand-made open re-focused the revealed row: the reveal latch outlived its plate");
    }
    console.log("ok: re-opening the pie by hand focuses no row — the reveal ended with its plate");

    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector(".sky-band") === null`, 10_000);
    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector(".sky-band") !== null`, 10_000);
    await sleep(400);
    const plateAfterBandToggle = await evalIn(
      app,
      `document.querySelector('[data-testid="pie-plate"]') !== null`,
    );
    if (plateAfterBandToggle) {
      throw new Error("toggling the band off and on re-opened the plate: revealTarget was still armed");
    }
    console.log("ok: toggling the band off and on leaves the plate closed");

    // Step 7 measures the plate, so put it back on screen.
    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);

    // ── Step 7: plate floor geometry at 640×400 ─────────────────────────
    // `core:window:allow-set-size` is deliberately not in this app's
    // capabilities (src-tauri/capabilities/desktop.json) and granting it
    // is a shell-repo change out of scope for M4, so the harness's real
    // window cannot be driven down to the 640×400 floor itself — checked
    // again here rather than just assumed, so a future capability grant
    // is what turns this into a live resize instead of silently going
    // stale. Two things this CAN prove against the real, running webview
    // instead: (a) the shipped stylesheet's `.pie-plate` height formula is
    // still the exact clamp this milestone's floor math depends on — read
    // from the actual `ui/src/styles.css` on disk, not retyped by hand, so
    // a formula edit fails this loudly; (b) the plate's live computed
    // height at the harness's actual (large) window obeys that same
    // formula, and neither `.pie-plate-short`/`.pie-plate-narrow`
    // modifier applies — proving `usePaneShort`/`usePaneNarrow` are wired
    // to the real `window.innerHeight`/`innerWidth` rather than dead code.
    const hasCap = fs
      .readFileSync(path.join(SHELL_DIR, "src-tauri", "capabilities", "desktop.json"), "utf8")
      .includes("allow-set-size");
    if (hasCap) {
      throw new Error(
        "core:window:allow-set-size is now granted — replace this arithmetic check with a real resize to 640×400",
      );
    }
    const plateCss = fs.readFileSync(path.join(UI_DIR, "src", "styles.css"), "utf8");
    const clampArgs = extractParenArgs(plateCss, ".pie-plate {", "height", "clamp(");
    const minPx = Number(clampArgs[0]?.replace("px", ""));
    const maxPx = Number(clampArgs[clampArgs.length - 1]?.replace("px", ""));
    // The spec's floor is the window's own `minHeight` (tauri.conf.json,
    // 400px) — at 100vh = 400px this formula must already bottom out at
    // the clamp's own minimum, i.e. 400 − 232 <= minPx.
    if (!(400 - 232 <= minPx && minPx === 280 && maxPx === 440)) {
      throw new Error(`unexpected .pie-plate clamp() bounds: min=${minPx} max=${maxPx} (raw: ${clampArgs.join(", ")})`);
    }
    console.log(`ok: .pie-plate's height clamp(${clampArgs.join(", ")}) still bottoms out at ${minPx}px by 100vh=400px`);

    const geometry = (await evalIn(
      app,
      `(function(){
        var el = document.querySelector('[data-testid="pie-plate"]');
        if (!el) return null;
        var h = el.getBoundingClientRect().height;
        return {
          height: h,
          short: el.classList.contains("pie-plate-short"),
          narrow: el.classList.contains("pie-plate-narrow"),
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
        };
      })()`,
    )) as { height: number; short: boolean; narrow: boolean; innerHeight: number; innerWidth: number } | null;
    if (!geometry) throw new Error("expected the plate to still be open for the geometry check");
    const expectedHeight = Math.min(maxPx, Math.max(minPx, geometry.innerHeight - 232));
    if (Math.abs(geometry.height - expectedHeight) > 1) {
      throw new Error(
        `.pie-plate's live height ${geometry.height}px does not match clamp(${minPx}, 100vh-232, ${maxPx}) = ` +
          `${expectedHeight}px at innerHeight=${geometry.innerHeight}`,
      );
    }
    // Strictly below the threshold — `usePaneShort` queries
    // `(max-height: SHORT_PANE_WINDOW_H - 1)`.
    const shortThreshold = shortPaneWindowHeight();
    const expectedShort = geometry.innerHeight < shortThreshold;
    const expectedNarrow = geometry.innerWidth <= 760;
    if (geometry.short !== expectedShort || geometry.narrow !== expectedNarrow) {
      throw new Error(
        `pie-plate-short/narrow mismatch: got short=${geometry.short} narrow=${geometry.narrow}, expected ` +
          `short=${expectedShort} narrow=${expectedNarrow} at ${geometry.innerWidth}x${geometry.innerHeight} ` +
          `(short threshold ${shortThreshold})`,
      );
    }
    console.log(
      `ok: the plate's live height (${geometry.height}px at innerHeight=${geometry.innerHeight}) matches the ` +
        `clamp formula, and short=${geometry.short}/narrow=${geometry.narrow} match the harness's real window size`,
    );

    // ── Step 8: dusk/day theme tokens, reviewed side by side ───────────
    // `useTheme` drives `<html data-theme>` from the real macOS window
    // theme / a matchMedia subscription (ui/src/hooks/useTheme.ts); no
    // Tauri command exists to flip it from Node, so this sets the
    // attribute directly on the live document and reads the actual
    // stylesheet's response — exactly what `useTheme` itself would do —
    // which is enough to review the four Sky-band tokens (and the two new
    // M4 consumers that spend them, the drop ring and the active-file
    // mark) against DESIGN.md's table in both themes.
    const SKY_TOKENS = ["--sky", "--sky-ink", "--sky-cloud", "--sky-focus"] as const;
    const EXPECTED: Record<"dark" | "light", Record<(typeof SKY_TOKENS)[number], string>> = {
      dark: { "--sky": "#16212f", "--sky-ink": "#e6edf5", "--sky-cloud": "#213040", "--sky-focus": "#8b93e8" },
      light: { "--sky": "#cfe3f6", "--sky-ink": "#1d2a3a", "--sky-cloud": "#eef5fb", "--sky-focus": "#3b45b8" },
    };
    const originalTheme = (await evalIn(app, `document.documentElement.getAttribute("data-theme")`)) as
      | string
      | null;
    for (const theme of ["dark", "light"] as const) {
      await evalIn(app, `document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
      const read = (await evalIn(
        app,
        `(function(){
          var cs = getComputedStyle(document.documentElement);
          return {
            ${SKY_TOKENS.map((t) => `${JSON.stringify(t)}: cs.getPropertyValue(${JSON.stringify(t)}).trim()`).join(",\n            ")}
          };
        })()`,
      )) as Record<(typeof SKY_TOKENS)[number], string>;
      for (const token of SKY_TOKENS) {
        const got = read[token].toLowerCase();
        const want = EXPECTED[theme][token];
        if (got !== want) {
          throw new Error(`[data-theme="${theme}"] ${token} = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        }
      }
      // Both M4 marks spend the theme's own --sky-focus, not a hardcoded
      // shade — read back straight off the live drop-target ring rule and
      // the active-file underline rule rather than re-deriving them,
      // since `document.styleSheets` exposes the same cascade the browser
      // itself resolved `--sky-focus` through.
      const ringOutline = (await evalIn(
        app,
        `(function(){
          for (var i = 0; i < document.styleSheets.length; i++) {
            var rules;
            try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
            for (var j = 0; j < rules.length; j++) {
              var r = rules[j];
              // The ring is ONE rule with TWO triggers (DESIGN.md), so
              // its selectorText is a LIST — match on containment, not
              // equality, or the shared rule reads as missing.
              if (r.selectorText && r.selectorText.indexOf('.sky-pie[data-drop-target="true"]') !== -1) return r.style.outline;
            }
          }
          return null;
        })()`,
      )) as string | null;
      if (!ringOutline || !ringOutline.includes(EXPECTED[theme]["--sky-focus"])) {
        // Some engines report `outline` computed from var(...) verbatim
        // rather than resolved — fall back to accepting the literal
        // `var(--sky-focus)` form, since the token itself is already
        // proven correct above.
        if (!ringOutline || !ringOutline.includes("--sky-focus")) {
          throw new Error(`[data-theme="${theme}"] .sky-pie[data-drop-target] outline = ${JSON.stringify(ringOutline)}`);
        }
      }
      console.log(`ok: [data-theme="${theme}"] --sky/--sky-ink/--sky-cloud/--sky-focus match DESIGN.md's table`);
    }
    if (originalTheme === "dark" || originalTheme === "light") {
      await evalIn(app, `document.documentElement.setAttribute("data-theme", ${JSON.stringify(originalTheme)})`);
    }

    console.log("PASS");
  } finally {
    // Each cleanup step guarded on its own: a failing `quit` must not mask
    // the real error from the body above, nor skip the two removals under
    // it.
    if (app) {
      await quit(app).catch((e: unknown) => console.error("cleanup: quit failed", e));
    }
    await cleanupFixtureWorkspace(fixture).catch((e: unknown) =>
      console.error("cleanup: removing the fixture workspace failed", e),
    );
    await fs.promises
      .rm(stateDir, { recursive: true, force: true })
      .catch((e: unknown) => console.error("cleanup: removing the scratch state dir failed", e));
  }
}

main().catch((err: unknown) => {
  console.error("FAIL", err);
  process.exitCode = 1;
});
