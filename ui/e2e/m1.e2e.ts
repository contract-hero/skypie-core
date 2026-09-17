// `pnpm -C ui e2e:m1` — the M1 milestone's own acceptance checkpoint, driven
// as one continuous user session against the REAL debug macOS app: ⌘⇧B, open
// the Recent plate, slice to HTML, open the newest HTML file from the layer
// list, hide the band again, confirm the posture survives a relaunch, and
// confirm reader mode still strips it. See ui/e2e/README.md.
//
// Scope note: the task that produced this scenario listed a "New pie tin"
// as part of step 1. M1 does not build the tin — the M1 implementation
// brief ("Cut to M2/M3 (do not build): the tin, user pies, ...") and
// DESIGN.md's "Sky band" section and STATUS.md's "Sky (M1)" entry (both
// updated by the same PR) all agree, and the spec's own M1 milestone row
// (`/tmp/skypie-spec.txt`, "M1 — Sky with built-in pies") gives the
// checkpoint as "press ⌘⇧B, see two pies, click Recent, click the HTML
// legend row, open a file" — no tin. The spec's M2 row is the one that adds
// the tin's create flow ("Tin, rename, delete with undo"). The built app
// has no tin anywhere (confirmed against Sky.tsx, DESIGN.md, STATUS.md), so
// this scenario asserts exactly the two built-in pies and does not look for
// one; see the tail of this file for how that is reported.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { click, evalIn, keys, launchDesktop, quit, text, waitFor } from "./lib/app";
import type { LaunchedApp } from "./lib/app";
import { cleanupFixtureWorkspace, makeFixtureWorkspace, setWorkspaceRoot } from "./lib/fixtureWorkspace";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Open a file through the app's own ⌘P palette — same technique as
 *  smoke.ts/sky.e2e.ts, repeated here rather than shared so each scenario
 *  stays a single, independently-readable file (this directory's existing
 *  convention). */
async function openViaQuickOpen(app: LaunchedApp, absPath: string): Promise<void> {
  await keys(app, "mod+p");
  await waitFor(app, `document.querySelector('[data-testid="quick-open"]') !== null`, 10_000);
  const rowSelector = `li[title=${JSON.stringify(absPath)}]`;
  await waitFor(app, `document.querySelector(${JSON.stringify(rowSelector)}) !== null`, 10_000);
  await click(app, rowSelector);
  await waitFor(app, `document.querySelector(".tab.active .tab-label") !== null`, 10_000);
}

/** Read the real `state.json` off disk (NOT through the app) — the only way
 *  to know the debounced writer (`app/src/state_store.rs`, a ~250ms quiet
 *  window) has actually landed a write before this process kills the app
 *  out from under it and relaunches. */
function readStateJson(stateDir: string): { panes?: { sky_visible?: boolean } } | null {
  const p = path.join(stateDir, "state.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Poll the on-disk state document until `panes.sky_visible` matches
 *  `expected`. There is no DOM signal `waitFor` could poll instead — the
 *  write is a background Rust thread on its own timer. */
async function waitForPersistedSkyVisible(stateDir: string, expected: boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = readStateJson(stateDir);
    if (state?.panes?.sky_visible === expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `state.json never settled to panes.sky_visible=${expected} within ${timeoutMs}ms ` +
          `(last read: ${JSON.stringify(state?.panes)})`,
      );
    }
    await sleep(150);
  }
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skypie-e2e-m1-state-"));
  const fixture = makeFixtureWorkspace("skypie-e2e-m1-");
  // A second HTML file, opened well before report.html, so "newest first"
  // in the HTML-filtered layer list is a real ordering assertion (two
  // items, known relative order) rather than trivially true from a single
  // match.
  const olderHtmlPath = path.join(fixture.dir, "older.html");
  fs.writeFileSync(
    olderHtmlPath,
    "<!doctype html>\n<html><head><title>Older fixture</title></head><body><h1>Older</h1></body></html>\n",
  );
  console.log(`fixture workspace: ${fixture.dir}`);
  console.log(`scratch state dir: ${stateDir}`);

  let app: LaunchedApp = await launchDesktop({ stateDir });
  try {
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    console.log("ok: toolbar renders");

    const initialPressed = await evalIn(
      app,
      `document.querySelector('[data-testid="toolbar-sky-toggle"]')?.getAttribute("aria-pressed")`,
    );
    if (initialPressed !== "false") {
      throw new Error(`expected the sky tile to start aria-pressed="false", got ${JSON.stringify(initialPressed)}`);
    }
    console.log("ok: sky toggle starts unpressed");

    await setWorkspaceRoot(app, fixture.dir);

    // Build a Recent history: older.html, then (>1s later, since
    // recents.rs records opened_at at whole-second resolution) report.html
    // — the two HTML files, in a known order. report.html is pinned right
    // after opening it, then two more (non-HTML) opens follow so the
    // ACTIVE tab at ⌘⇧B time is neither report.html nor older.html — later,
    // opening report.html's layer row is a real tab switch, not a no-op.
    await openViaQuickOpen(app, olderHtmlPath);
    await sleep(1_100);
    await openViaQuickOpen(app, fixture.files.html); // report.html — newest of the two HTML files
    console.log("ok: opened older.html, then report.html over a second later");

    await click(app, '[data-testid="preview-bookmark-toggle"]');
    await waitFor(
      app,
      `document.querySelector('[data-testid="preview-bookmark-toggle"]')?.getAttribute("aria-pressed") === "true"`,
      10_000,
    );
    console.log("ok: pinned report.html (Pinned now holds it)");

    await openViaQuickOpen(app, fixture.files.json);
    await openViaQuickOpen(app, fixture.files.md); // active tab is now notes.md, not report.html
    console.log("ok: opened data.json and notes.md (Recent now holds four files; notes.md is active)");

    // ── Step 1: ⌘⇧B shows the 120px band with the two built-in pies ───────
    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector('.sky-band[role="listbox"][aria-label="Pies"]') !== null`, 10_000);
    await waitFor(
      app,
      `document.querySelector('[data-testid="toolbar-sky-toggle"]')?.getAttribute("aria-pressed") === "true"`,
      10_000,
    );
    const pieIds = (await evalIn(
      app,
      `Array.from(document.querySelectorAll(".sky-band [data-pie-id]")).map(function(el){ return el.getAttribute("data-pie-id"); })`,
    )) as string[];
    if (JSON.stringify([...pieIds].sort()) !== JSON.stringify(["builtin:pinned", "builtin:recent"])) {
      throw new Error(`expected exactly the two M1 built-in pies (no tin — see file header), got ${JSON.stringify(pieIds)}`);
    }
    await waitFor(
      app,
      `(function(){
        var pinned = document.querySelector('[data-pie-id="builtin:pinned"] svg path');
        var recent = document.querySelector('[data-pie-id="builtin:recent"] svg path');
        return pinned !== null && recent !== null;
      })()`,
      10_000,
    );
    const bandHeight = await evalIn(
      app,
      `(function(){ var el = document.querySelector(".sky-band"); return el ? Math.round(el.getBoundingClientRect().height) : null; })()`,
    );
    if (bandHeight !== 120) {
      throw new Error(`expected the band to render at 120px, got ${JSON.stringify(bandHeight)}`);
    }
    console.log("ok: ⌘⇧B shows the 120px band with Pinned and Recent (each with a wedge), tile pressed");

    // ── Step 2: click Recent — the plate drops with the pie, readout, legend ──
    await click(app, '[data-pie-id="builtin:recent"]');
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    // The plate's scale-in runs 240ms (--ease-emphasis); this also waits
    // for its content (readout text, legend rows) rather than racing layout.
    await waitFor(
      app,
      `(function(){
        var readout = document.querySelector(".pie-plate-readout");
        var legend = document.querySelector('[data-testid="pie-legend"]');
        return readout !== null && readout.textContent.trim().length > 0 &&
               legend !== null && legend.querySelectorAll("button").length > 0;
      })()`,
      10_000,
    );
    await waitFor(app, `document.querySelector(".tab-view")?.style.pointerEvents === "none"`, 10_000);
    console.log("ok: clicking Recent drops the plate with a pie, a readout and legend rows");

    // ── Step 3: click the HTML legend row — the layer list narrows, newest first ──
    const clickedHtml = await evalIn(
      app,
      `(function(){
        var rows = document.querySelectorAll('[data-testid="pie-legend"] button');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].textContent.indexOf("HTML") !== -1) { rows[i].click(); return true; }
        }
        return false;
      })()`,
    );
    if (!clickedHtml) throw new Error("no legend row with textContent containing 'HTML' was found");
    await waitFor(app, `document.querySelectorAll('[data-testid="pie-layers"] .start-row').length === 2`, 10_000);
    const layerNames = await evalIn(
      app,
      `Array.from(document.querySelectorAll('[data-testid="pie-layers"] .start-row-name')).map(function(el){ return el.textContent; })`,
    );
    if (JSON.stringify(layerNames) !== JSON.stringify(["report.html", "older.html"])) {
      throw new Error(`expected the HTML-filtered layer list newest first, got ${JSON.stringify(layerNames)}`);
    }
    console.log(`ok: the HTML legend row filters the layer list to ${JSON.stringify(layerNames)} (newest first)`);

    // ── Step 4: click a row — the file opens in a tab, the plate closes ──
    // The active tab is notes.md at this point (opened last, above), so
    // this is a real tab switch, not a no-op re-click of the active tab.
    await click(app, '[data-testid="pie-layers"] .start-row');
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);
    await waitFor(app, `document.querySelector(".tab-view")?.style.pointerEvents !== "none"`, 10_000);
    const activeLabel = await text(app, ".tab.active .tab-label");
    if (activeLabel !== "report.html") {
      throw new Error(`expected the active tab's title to be "report.html", got ${JSON.stringify(activeLabel)}`);
    }
    console.log("ok: opening the row opened report.html in a tab and closed the plate");

    // Reader mode strips the band (with the toolbar) — checked here, while
    // the band is still visible, ahead of the persistence step below.
    await keys(app, "mod+shift+f");
    await waitFor(
      app,
      `document.querySelector(".toolbar") === null && document.querySelector(".sky-band") === null`,
      10_000,
    );
    console.log("ok: reader mode strips both the toolbar and the sky band");
    await keys(app, "mod+shift+f");
    await waitFor(
      app,
      `document.querySelector(".toolbar") !== null && document.querySelector(".sky-band") !== null`,
      10_000,
    );
    console.log("ok: leaving reader mode restores both");

    // ── panes.sky_visible persists across relaunch ────────────────────────
    // Tested with the band SHOWN, not hidden: App.tsx's hydration effect
    // only acts `if (!userToggledSky.current && s?.panes?.sky_visible ===
    // true)` — its own default is already `false`, so relaunching after
    // HIDING the band would pass even if the hydration read were deleted
    // entirely. Wait for the debounced writer to actually land the true
    // value on disk before killing the process out from under it.
    await waitForPersistedSkyVisible(stateDir, true);
    console.log("ok: panes.sky_visible:true reached state.json on disk");

    await quit(app);
    app = await launchDesktop({ stateDir, skipBuild: true }); // no Rust change in M1 — same binary
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    await waitFor(app, `document.querySelector('.sky-band[role="listbox"][aria-label="Pies"]') !== null`, 10_000);
    await waitFor(
      app,
      `document.querySelector('[data-testid="toolbar-sky-toggle"]')?.getAttribute("aria-pressed") === "true"`,
      10_000,
    );
    console.log("ok: after a relaunch, persisted panes.sky_visible=true reopened the band with no keypress");

    // ── ⌘⇧B hides the band ────────────────────────────────────────────────
    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector(".sky-band") === null`, 10_000);
    await waitFor(
      app,
      `document.querySelector('[data-testid="toolbar-sky-toggle"]')?.getAttribute("aria-pressed") === "false"`,
      10_000,
    );
    console.log("ok: ⌘⇧B hides the band and un-presses the tile");

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
