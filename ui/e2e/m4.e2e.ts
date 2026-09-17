// `pnpm -C ui e2e:m4` — M4's own acceptance checkpoint, driven against the
// REAL debug macOS app: the drop-target ring over a live drag (and its
// clearing on drag-leave), a Finder drop of a folder onto the tin creating
// a named pie with a canonical "finder"-sourced folder member, zooming
// that pie's plate and reading the folder layer's header, the passive
// active-file mark on the band tile for an open file, and — sidebar
// hidden — a deep-link reveal that opens the sky and the plate on the
// right pie with the row focused. See ui/e2e/README.md.
//
// The harness only evaluates JS INSIDE the webview (`evalIn`) — there is
// no OS-level drag to synthesize from Node, and no real `skypie://` URL
// dispatch to trigger from outside the app either. Both are synthesized by
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
// launchDesktop({ skipBuild: true }): no Rust change in M4 — same binary.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { click, evalIn, keys, launchDesktop, quit, text, waitFor } from "./lib/app";
import type { LaunchedApp } from "./lib/app";
import { cleanupFixtureWorkspace, makeFixtureWorkspace, setWorkspaceRoot } from "./lib/fixtureWorkspace";

// ── Small helpers, repeated from m1/m2/m3.e2e.ts rather than shared — this
//    directory's own convention (each scenario stays a single,
//    independently-readable file; ui/e2e/README.md). ──────────────────────

async function openViaQuickOpen(app: LaunchedApp, absPath: string): Promise<void> {
  await keys(app, "mod+p");
  await waitFor(app, `document.querySelector('[data-testid="quick-open"]') !== null`, 10_000);
  const rowSelector = `li[title=${JSON.stringify(absPath)}]`;
  await waitFor(app, `document.querySelector(${JSON.stringify(rowSelector)}) !== null`, 10_000);
  await click(app, rowSelector);
  await waitFor(app, `document.querySelector(".tab.active .tab-label") !== null`, 10_000);
}

interface OnDiskPies {
  pies?: {
    v?: number;
    pies?: {
      id: string;
      name: string;
      seen_at?: number;
      members: { path: string; kind: string; source?: string }[];
    }[];
  };
}

function readStateJson(stateDir: string): OnDiskPies | null {
  const p = path.join(stateDir, "state.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPersistedPies(
  stateDir: string,
  predicate: (doc: NonNullable<OnDiskPies["pies"]>) => boolean,
  timeoutMs = 10_000,
): Promise<NonNullable<OnDiskPies["pies"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const doc = readStateJson(stateDir)?.pies;
    if (doc && predicate(doc)) return doc;
    if (Date.now() > deadline) {
      throw new Error(`state.json's "pies" key never matched within ${timeoutMs}ms (last: ${JSON.stringify(doc)})`);
    }
    await sleep(150);
  }
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
 * with its own member (review: m4.e2e.ts:151/169). By the time this is
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

  let app: LaunchedApp = await launchDesktop({ stateDir, skipBuild: true });
  try {
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
    // surviving into `state.json` (review: m4.e2e.ts:151/169).
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

    // `handleDeepLinkIntent` reads `sidebarVisible` through a ref, not a
    // dep, so `mod+b` above does not tear down/re-subscribe `useDeepLink`'s
    // `skypie://open-file` listener (review fix, App.tsx:485) — this
    // `emitAndVerify` is just the ordinary startup-registration retry
    // every other `emitTauriEvent` caller in this file gets for free, and
    // it stays safe to re-emit here (unlike `tauri://drag-drop` above):
    // repeating a reveal just re-arms the same, idempotent routing
    // decision.
    await emitAndVerify(
      app,
      "skypie://open-file",
      { path: canonicalDroppedFile, intent: "reveal" },
      `document.querySelector('[data-testid="pie-plate"]') !== null`,
    );
    const focusedIsStartRow = await evalIn(
      app,
      `document.activeElement != null && document.activeElement.classList.contains("start-row")`,
    );
    if (!focusedIsStartRow) {
      throw new Error(
        `expected document.activeElement to carry .start-row, got ${JSON.stringify(
          (await evalIn(app, `document.activeElement ? document.activeElement.outerHTML.slice(0, 200) : null`)),
        )}`,
      );
    }
    console.log("ok: reveal with the sidebar hidden opened the plate with a .start-row focused");

    console.log("PASS");
  } finally {
    await quit(app);
    await cleanupFixtureWorkspace(fixture);
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error("FAIL", err);
  process.exitCode = 1;
});
