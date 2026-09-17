// `pnpm -C ui e2e:m6` — M6's own acceptance checkpoint: on the phone start
// page the Sky band shows a "Received" pie over three seeded beams, tapping
// it opens a PhonePieSheet with the 200px pie and 44px rows, the rows open
// a file and close the sheet, the scrim dismisses it, and none of this
// leaks onto the macOS tree once the phone-platform override is cleared.
// Driven against the REAL debug desktop app — see ui/e2e/README.md.
//
// The desktop harness has no iPhone UA and no `platform_info` override to
// lean on, so it reaches the phone tree the way the M6 brief prescribes:
// `localStorage.setItem("skypie.platformOverride", "ios")` (the dev-only
// seam in `state/platform.tsx`) followed by a reload. A reload mid-flight
// can tear the page down before the e2e bridge's own report round-trip
// finishes, so `reloadAs` below tolerates `evalIn` rejecting and instead
// treats the NEXT `waitFor` as the source of truth for whether the reload
// actually landed on the tree it asked for.
//
// The "Shared from <Mac>" pie needs an online paired peer, which this
// harness cannot mint cheaply (real iroh pairing, two live nodes) — that
// path is covered in `ios-pies.test.ts` (name, id, address, ms conversion,
// per-peer split) instead, and can be eyeballed through the screenshot
// `pnpm -C ui e2e:ios-smoke` takes on a simulator that IS paired.
//
// launchDesktop({ skipBuild: true }): M6 made no Rust change.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { click, evalIn, launchDesktop, quit, text, waitFor } from "./lib/app";
import type { LaunchedApp } from "./lib/app";

const PLATFORM_OVERRIDE_KEY = "skypie.platformOverride";

/** Flips `state/platform.tsx`'s dev-only e2e seam and reloads — see this
 *  file's own header comment for why `evalIn` rejecting here is tolerated
 *  rather than treated as a failure. `override === null` clears the key
 *  (restores the macOS tree), matching the brief's own "clear the key and
 *  reload in finally" instruction. */
async function reloadAs(app: LaunchedApp, override: "ios" | "macos" | null): Promise<void> {
  const js = override
    ? `(function(){ localStorage.setItem(${JSON.stringify(PLATFORM_OVERRIDE_KEY)}, ${JSON.stringify(override)}); location.reload(); return true; })()`
    : `(function(){ localStorage.removeItem(${JSON.stringify(PLATFORM_OVERRIDE_KEY)}); location.reload(); return true; })()`;
  try {
    await evalIn(app, js);
  } catch {
    // The reload itself still happened; the caller's own waitFor is what
    // actually confirms the new tree rendered.
  }
}

/** `element.click()` via a JS predicate rather than a CSS selector — for
 *  the two phone-bar buttons whose `aria-label` is dynamic (a live count)
 *  or shared with no stable class of its own. Repeated from m2/m5.e2e.ts's
 *  own small-helper convention (ui/e2e/README.md: each scenario stays a
 *  single, independently-readable file). */
async function clickButtonByAriaLabelPrefix(app: LaunchedApp, prefix: string): Promise<void> {
  const js = `(function(){
    var buttons = Array.from(document.querySelectorAll("button"));
    var btn = buttons.find(function(b){
      var label = b.getAttribute("aria-label") || "";
      return label.indexOf(${JSON.stringify(prefix)}) === 0;
    });
    if (!btn) return false;
    btn.click();
    return true;
  })()`;
  const ok = await evalIn(app, js);
  if (!ok) throw new Error(`clickButtonByAriaLabelPrefix: no button with aria-label starting ${JSON.stringify(prefix)}`);
}

/** Activates the phone Tabs sheet's row whose visible name is `label` —
 *  used to get back to the (now second) empty tab so the start page (and
 *  its Sky band) remounts after opening a file. */
async function activateTabByLabel(app: LaunchedApp, label: string): Promise<void> {
  const js = `(function(){
    var rows = Array.from(document.querySelectorAll(".phone-tab-row"));
    var row = rows.find(function(r){
      var el = r.querySelector(".phone-tab-row-name");
      return el && el.textContent === ${JSON.stringify(label)};
    });
    if (!row) return false;
    row.querySelector(".phone-tab-row-label").click();
    return true;
  })()`;
  const ok = await evalIn(app, js);
  if (!ok) throw new Error(`activateTabByLabel: no tab row labeled ${JSON.stringify(label)}`);
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skypie-e2e-m6-state-"));
  console.log(`scratch state dir: ${stateDir}`);

  // ── Seed three beams under one day directory — beam::list_received walks
  //    day directories and takes received_at from each file's mtime (not
  //    its name), so distinct, explicit mtimes are what makes "the newest
  //    seeded file" deterministic below. ────────────────────────────────
  const receivedDay = path.join(stateDir, "received", "2026-09-17");
  fs.mkdirSync(receivedDay, { recursive: true });
  const now = Date.now();
  const seeds: Array<{ name: string; ageMs: number }> = [
    { name: "notes.md", ageMs: 30_000 },
    { name: "plan.html", ageMs: 20_000 },
    // Newest — this is the file every "first row" / "newest" assertion
    // below expects.
    { name: "pricing.html", ageMs: 10_000 },
  ];
  for (const seed of seeds) {
    const file = path.join(receivedDay, seed.name);
    fs.writeFileSync(file, `<!doctype html>\n<title>${seed.name}</title>\n`);
    const mtime = new Date(now - seed.ageMs);
    fs.utimesSync(file, mtime, mtime);
  }
  const newestBasename = "pricing.html";

  let app: LaunchedApp = await launchDesktop({ stateDir, skipBuild: true });
  try {
    // ── macOS tree first (the default guess for a desktop UA/window) ────
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    console.log("ok: launched on the macOS tree");

    // ── Flip to iOS via the dev-only localStorage seam and reload ───────
    await reloadAs(app, "ios");
    await waitFor(app, `document.body.classList.contains("platform-ios") === true`, 30_000);
    console.log("ok: reloaded on the platform-ios tree");

    // ── Checkpoint 1: phone chrome, no desktop chrome ───────────────────
    const isIos = await evalIn(app, `document.body.classList.contains("platform-ios")`);
    const hasPhoneShell = await evalIn(app, `document.querySelector(".phone-shell") !== null`);
    const hasToolbar = await evalIn(app, `document.querySelector(".toolbar") !== null`);
    const hasSkyToggle = await evalIn(app, `document.querySelector('[data-testid="toolbar-sky-toggle"]') !== null`);
    if (isIos !== true) throw new Error(`expected body.platform-ios, got isIos=${JSON.stringify(isIos)}`);
    if (hasPhoneShell !== true) throw new Error("expected .phone-shell to be mounted");
    if (hasToolbar !== false) throw new Error("expected no .toolbar on the phone tree");
    if (hasSkyToggle !== false) throw new Error('expected no [data-testid="toolbar-sky-toggle"] on the phone tree');
    console.log("ok: phone chrome mounted, desktop chrome absent");

    // ── Checkpoint 2: the band exists and is first ──────────────────────
    await waitFor(app, `document.querySelector('[data-testid="ios-sky"]') !== null`, 10_000);
    const bandFacts = (await evalIn(
      app,
      `(function(){
        var b = document.querySelector('[data-testid="ios-sky"]');
        return {
          role: b.getAttribute("role"),
          ariaLabel: b.getAttribute("aria-label"),
          isFirstChild: b.parentElement.firstElementChild === b,
          height: Math.round(b.getBoundingClientRect().height),
        };
      })()`,
    )) as { role: string; ariaLabel: string; isFirstChild: boolean; height: number };
    if (bandFacts.role !== "listbox") throw new Error(`expected role="listbox", got ${JSON.stringify(bandFacts.role)}`);
    if (bandFacts.ariaLabel !== "Pies") throw new Error(`expected aria-label="Pies", got ${JSON.stringify(bandFacts.ariaLabel)}`);
    if (!bandFacts.isFirstChild) throw new Error("expected the band to be .start-page-inner's first child");
    if (bandFacts.height !== 120) throw new Error(`expected a 120px band, got ${bandFacts.height}px`);
    console.log("ok: the band is first, role=listbox, aria-label=Pies, 120px tall");

    // ── Checkpoint 3: the Received pie, no Shared pie (no online peer) ──
    const pieIds = (await evalIn(
      app,
      `Array.from(document.querySelectorAll('[data-testid="ios-sky"] [data-pie-id]')).map(function(e){ return e.getAttribute("data-pie-id"); })`,
    )) as string[];
    if (!pieIds.includes("builtin:received")) {
      throw new Error(`expected "builtin:received" among band pies, got ${JSON.stringify(pieIds)}`);
    }
    if (pieIds.some((id) => id.startsWith("builtin:shared:"))) {
      throw new Error(`expected no "builtin:shared:" pie with no online peer, got ${JSON.stringify(pieIds)}`);
    }
    const receivedLabel = await text(app, '[data-pie-id="builtin:received"] .sky-pie-label');
    if (receivedLabel !== "Received") {
      throw new Error(`expected the Received tile's label to read "Received", got ${JSON.stringify(receivedLabel)}`);
    }
    console.log('ok: band pies are exactly ["builtin:received"], labeled "Received"');

    // ── Checkpoint 4: no desktop-only affordances on the band ───────────
    const hasTin = await evalIn(app, `document.querySelector('[data-testid="ios-sky"] [data-pie-tin]') !== null`);
    const hasFreshPill = await evalIn(app, `document.querySelector('[data-testid="pie-fresh-pill"]') !== null`);
    if (hasTin !== false) throw new Error("expected no tin on the phone band");
    if (hasFreshPill !== false) throw new Error("expected no freshness pill anywhere on the phone tree");
    console.log("ok: no tin, no freshness pill");

    // ── Checkpoint 5: wedges — 2 html, 1 md, both above the 4% haze floor
    const wedgeKinds = (await evalIn(
      app,
      `Array.from(document.querySelectorAll('[data-pie-id="builtin:received"] svg path[data-kind]')).map(function(p){ return p.getAttribute("data-kind"); })`,
    )) as string[];
    if (wedgeKinds.length !== 2 || wedgeKinds[0] !== "html" || wedgeKinds[1] !== "md") {
      throw new Error(`expected wedge kinds ["html","md"], got ${JSON.stringify(wedgeKinds)}`);
    }
    console.log('ok: wedges are ["html","md"] (2 html, 1 md)');

    // ── Checkpoint 6: tap the pie — the sheet, the dialog, the scrim, the
    //    200px portrait pie ──────────────────────────────────────────────
    await click(app, '[data-pie-id="builtin:received"]');
    await waitFor(app, `document.querySelector('[data-testid="pie-sheet"]') !== null`, 10_000);
    const sheetFacts = (await evalIn(
      app,
      `(function(){
        var sheet = document.querySelector('[data-testid="pie-sheet"]');
        var dialog = sheet.closest('[role="dialog"]');
        var svg = document.querySelector('.phone-sheet .sky-pie-portrait svg');
        // review (major, styles.css:3005): the M1 rule that hides the band
        // tile's OWN disc while its plate is open is desktop-only — the
        // phone has no plate animating out of that slot, so the tile the
        // user just tapped must keep its disc for as long as the sheet
        // stays open.
        var bandDisc = document.querySelector('[data-testid="ios-sky"] [data-pie-id="builtin:received"] .sky-pie-disc');
        return {
          dialogAriaLabel: dialog ? dialog.getAttribute("aria-label") : null,
          hasScrim: document.querySelector(".phone-scrim") !== null,
          portraitWidth: svg ? svg.getAttribute("width") : null,
          bandDiscVisibility: bandDisc ? getComputedStyle(bandDisc).visibility : null,
        };
      })()`,
    )) as { dialogAriaLabel: string | null; hasScrim: boolean; portraitWidth: string | null; bandDiscVisibility: string | null };
    if (sheetFacts.dialogAriaLabel !== "Received") {
      throw new Error(`expected the enclosing dialog's aria-label to be "Received", got ${JSON.stringify(sheetFacts.dialogAriaLabel)}`);
    }
    if (!sheetFacts.hasScrim) throw new Error("expected .phone-scrim while the pie sheet is open");
    if (sheetFacts.portraitWidth !== "200") {
      throw new Error(`expected the portrait pie's svg width to be "200", got ${JSON.stringify(sheetFacts.portraitWidth)}`);
    }
    if (sheetFacts.bandDiscVisibility !== "visible") {
      throw new Error(`expected the tapped band tile's disc to stay visible while the sheet is open, got ${JSON.stringify(sheetFacts.bandDiscVisibility)}`);
    }
    console.log("ok: the pie sheet is open — dialog aria-label=Received, scrim present, 200px portrait, tapped tile's disc stays visible");

    // ── Checkpoint 7: three 44px rows, newest first ─────────────────────
    const rowFacts = (await evalIn(
      app,
      `(function(){
        var rows = Array.from(document.querySelectorAll('[data-testid="pie-sheet"] .start-row'));
        return {
          count: rows.length,
          minHeight: Math.min.apply(null, rows.map(function(r){ return r.getBoundingClientRect().height; })),
          firstName: rows[0] ? rows[0].querySelector(".start-row-name").textContent : null,
        };
      })()`,
    )) as { count: number; minHeight: number; firstName: string | null };
    if (rowFacts.count !== 3) throw new Error(`expected 3 rows, got ${rowFacts.count}`);
    if (rowFacts.minHeight < 44) throw new Error(`expected every row >= 44px tall, got a minimum of ${rowFacts.minHeight}px`);
    if (rowFacts.firstName !== newestBasename) {
      throw new Error(`expected the first row to be the newest seeded file ${JSON.stringify(newestBasename)}, got ${JSON.stringify(rowFacts.firstName)}`);
    }
    console.log(`ok: 3 rows, all >= 44px, newest first (${rowFacts.firstName})`);

    // ── Checkpoint 8: opening the first row opens the file and closes the
    //    sheet ────────────────────────────────────────────────────────────
    await click(app, '[data-testid="pie-sheet"] .start-row');
    await waitFor(app, `document.querySelector('[data-testid="pie-sheet"]') === null`, 10_000);
    await waitFor(app, `document.querySelector(".phone-title").textContent === ${JSON.stringify(newestBasename)}`, 10_000);
    console.log(`ok: opening the first row opened "${newestBasename}" and closed the sheet`);

    // ── Back to the start page (the second, still-empty tab FOCUS_OR_OPEN
    //    left behind) so the band remounts, then checkpoint 9: reopen the
    //    pie and dismiss it by clicking the scrim ───────────────────────
    await clickButtonByAriaLabelPrefix(app, "Open tabs");
    await waitFor(app, `document.querySelector(".phone-tab-list") !== null`, 10_000);
    await activateTabByLabel(app, "New tab");
    await waitFor(app, `document.querySelector('[data-testid="ios-sky"]') !== null`, 10_000);

    await click(app, '[data-pie-id="builtin:received"]');
    await waitFor(app, `document.querySelector('[data-testid="pie-sheet"]') !== null`, 10_000);
    await click(app, ".phone-scrim");
    await waitFor(app, `document.querySelector('[data-testid="pie-sheet"]') === null`, 10_000);
    console.log("ok: reopening the pie then clicking the scrim dismisses the sheet");

    // ── Checkpoint 10: clearing the override restores the macOS tree,
    //    with no trace of the phone band ────────────────────────────────
    await reloadAs(app, null);
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 30_000);
    const macosFacts = (await evalIn(
      app,
      `({ toolbar: document.querySelector(".toolbar") !== null, iosSky: document.querySelector('[data-testid="ios-sky"]') !== null })`,
    )) as { toolbar: boolean; iosSky: boolean };
    if (!macosFacts.toolbar) throw new Error("expected .toolbar back once the override is cleared");
    if (macosFacts.iosSky) throw new Error('expected no [data-testid="ios-sky"] on the macOS tree');
    console.log("ok: clearing the override restores the macOS tree — no phone band leaks onto it");

    console.log("PASS");
  } finally {
    // The brief's own warning: leaving the override set would start the
    // NEXT scenario's launch on the phone tree, since localStorage
    // persists across app relaunches at the webview's own origin.
    await reloadAs(app, null);
    await quit(app);
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error("FAIL", err);
  process.exitCode = 1;
});
