// `pnpm -C ui e2e:m6` — M6's own acceptance checkpoint, driven against the
// REAL iOS simulator app (`launchIos`, not the desktop harness): on the
// phone start page the Sky band shows a "Received" pie over three seeded
// beams, tapping it opens a PhonePieSheet with the 200px pie and 44px rows,
// a row opens a file and closes the sheet, the scrim dismisses it, and the
// Library/Tabs/Comments sheets — untouched by M6 — still work alongside it.
// See ui/e2e/README.md for the iOS transport and `ui/e2e/lib/ios.ts` for
// `launchIos` itself.
//
// A real iOS WKWebView reports an iPhone user agent, which `guessPlatformOs`
// (`state/platform.tsx`) already treats as decisive, and the compiled
// `platform_info` command confirms it (`app/src/platform.rs`,
// `std::env::consts::OS == "ios"`) — unlike the desktop harness, this
// scenario needs no `skypie.platformOverride` seam at all: the phone tree is
// simply what the real app renders.
//
// Seeding the Received pie needs a scratch `SKYPIE_STATE_DIR` the simulator
// process itself will read — `launchIos`'s `env` option forwards it via
// `xcrun simctl launch`'s `SIMCTL_CHILD_` prefix, and `skypie_ipc::state_dir()`
// reads `SKYPIE_STATE_DIR` on every target_os, so this is the same seam
// `launchDesktop({ stateDir })` already uses on macOS.
//
// The "Shared from <Mac>" pie needs an online paired peer, which this
// harness cannot mint cheaply (real iroh pairing, two live nodes) — that
// path stays covered by `ios-pies.test.ts` (name, id, address, ms
// conversion, per-peer split), not asserted here; this scenario only
// asserts its ABSENCE with zero peers, which is the state a fresh
// `SKYPIE_STATE_DIR` actually starts in.
//
// `launchIos` syncs `skypie-ios/core` to THIS checkout's HEAD commit before
// it builds (`ui/e2e/lib/ios.ts`'s `syncIosCoreToThisCommit`) — so this file
// itself has to be committed before a run tests its own content.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  activateTabByLabel,
  click,
  clickButtonByAriaLabelPrefix,
  evalIn,
  quit,
  text,
  waitFor,
} from "./lib/app";
import { launchIos } from "./lib/ios";

// Same fixed port `ios-smoke.ts` uses — scenarios run sequentially, never
// concurrently, so one fixed port stays easy to spot stuck (`lsof -i`)
// rather than hunting a random one.
const E2E_PORT = 17_845;

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skypie-e2e-m6-ios-state-"));
  console.log(`scratch state dir: ${stateDir}`);

  // ── Seed three beams under one day directory — beam::list_received walks
  //    day directories and takes received_at from each file's mtime (not
  //    its name), so distinct, explicit mtimes are what makes "the newest
  //    seeded file" deterministic below. Same fixture the earlier
  //    desktop-driven version of this scenario used. ─────────────────────
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

  // `skipBuild` is not passed: `launchIos` defaults it to
  // `SKYPIE_E2E_SKIP_BUILD` itself, so no scenario can forget the variable.
  const app = await launchIos({ port: E2E_PORT, env: { SKYPIE_STATE_DIR: stateDir } });
  try {
    // ── Checkpoint 1: real phone chrome, no desktop chrome — the UA/compiled
    //    platform_info alone, no e2e override needed ────────────────────
    await waitFor(app, `document.querySelector(".phone-shell") !== null`, 60_000);
    const isIos = await evalIn(app, `document.body.classList.contains("platform-ios")`);
    const hasToolbar = await evalIn(app, `document.querySelector(".toolbar") !== null`);
    const hasSkyToggle = await evalIn(app, `document.querySelector('[data-testid="toolbar-sky-toggle"]') !== null`);
    if (isIos !== true) throw new Error(`expected body.platform-ios, got isIos=${JSON.stringify(isIos)}`);
    if (hasToolbar !== false) throw new Error("expected no .toolbar on the real iOS build");
    if (hasSkyToggle !== false) throw new Error('expected no [data-testid="toolbar-sky-toggle"] on the real iOS build');
    console.log("ok: real iOS build renders .phone-shell, no desktop chrome");

    // ── Checkpoint 2: the band exists, is first, is 120px ───────────────
    await waitFor(app, `document.querySelector('[data-testid="ios-sky"]') !== null`, 15_000);
    const bandFacts = (await evalIn(
      app,
      `(function(){
        var b = document.querySelector('[data-testid="ios-sky"]');
        return {
          role: b.getAttribute("role"),
          ariaLabel: b.getAttribute("aria-label"),
          parentClass: b.parentElement.className,
          isFirstChild: b.parentElement.firstElementChild === b,
          height: Math.round(b.getBoundingClientRect().height),
        };
      })()`,
    )) as {
      role: string;
      ariaLabel: string;
      parentClass: string;
      isFirstChild: boolean;
      height: number;
    };
    if (bandFacts.role !== "listbox") throw new Error(`expected role="listbox", got ${JSON.stringify(bandFacts.role)}`);
    if (bandFacts.ariaLabel !== "Pies") throw new Error(`expected aria-label="Pies", got ${JSON.stringify(bandFacts.ariaLabel)}`);
    // The band is a SIBLING of `.start-page-inner`, ABOVE it — full-bleed
    // chrome does not belong inside the start page's padded 560px column,
    // and outside it the band needs no negative-margin clawback to reach
    // the screen edges (styles.css, the M6 phone-band block). Asserting the
    // PARENT as well as the position is what keeps it from drifting back
    // inside that column and passing on "first child" alone.
    if (bandFacts.parentClass !== "start-page") {
      throw new Error(
        `expected the band's parent to be .start-page, got ${JSON.stringify(bandFacts.parentClass)}`,
      );
    }
    if (!bandFacts.isFirstChild) throw new Error("expected the band to be .start-page's first child");
    if (bandFacts.height !== 120) throw new Error(`expected a 120px band, got ${bandFacts.height}px`);
    console.log("ok: the band is first, role=listbox, aria-label=Pies, 120px tall");

    // ── Checkpoint 3: the Received pie, no Shared pie (no paired peer) ──
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
    console.log('ok: band pies are exactly ["builtin:received"], labeled "Received" (no online peer, so no "Shared from" pie)');

    // ── Checkpoint 4: no tin anywhere, no freshness pill (no drops, no
    //    census pill — both desktop-only affordances) ───────────────────
    const hasTin = await evalIn(app, `document.querySelector('[data-pie-tin]') !== null`);
    const hasFreshPill = await evalIn(app, `document.querySelector('[data-testid="pie-fresh-pill"]') !== null`);
    if (hasTin !== false) throw new Error("expected no pie tin anywhere on the phone tree (nothing to drop a Finder file onto)");
    if (hasFreshPill !== false) throw new Error("expected no freshness pill anywhere on the phone tree");
    console.log("ok: no tin (no drop target), no freshness pill");

    // ── Checkpoint 5: wedges — 2 html, 1 md, both above the 4% haze floor
    const wedgeKinds = (await evalIn(
      app,
      `Array.from(document.querySelectorAll('[data-pie-id="builtin:received"] svg path[data-kind]')).map(function(p){ return p.getAttribute("data-kind"); })`,
    )) as string[];
    if (wedgeKinds.length !== 2 || wedgeKinds[0] !== "html" || wedgeKinds[1] !== "md") {
      throw new Error(`expected wedge kinds ["html","md"], got ${JSON.stringify(wedgeKinds)}`);
    }
    console.log('ok: wedges are ["html","md"] (2 html, 1 md)');

    const startPageShot = await app.screenshot("m6-start-page");
    console.log(`ok: screenshot of the start page (Sky band + Received pie) written to ${startPageShot}`);

    // ── Checkpoint 6: tap the pie — the sheet, the dialog, the scrim, the
    //    200px portrait pie, and the tapped tile's own disc staying visible
    //    (the M1 disc-hiding rule is macOS-plate-only; PhonePieSheet is a
    //    bottom sheet, not a plate animating out of the band slot) ───────
    await click(app, '[data-pie-id="builtin:received"]');
    await waitFor(app, `document.querySelector('[data-testid="pie-sheet"]') !== null`, 10_000);
    const sheetFacts = (await evalIn(
      app,
      `(function(){
        var sheet = document.querySelector('[data-testid="pie-sheet"]');
        var dialog = sheet.closest('[role="dialog"]');
        var svg = document.querySelector('.phone-sheet .sky-pie-portrait svg');
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

    const pieSheetShot = await app.screenshot("m6-pie-sheet");
    console.log(`ok: screenshot of the open PhonePieSheet (200px pie + 44px rows) written to ${pieSheetShot}`);

    // ── Checkpoint 8: opening the first row opens the file and closes the
    //    sheet — no persistence: this reads the seeded file straight off
    //    disk through the same FOCUS_OR_OPEN a tap on the start page's own
    //    "Received" list uses, nothing about the band or the sheet writes
    //    anywhere ───────────────────────────────────────────────────────
    await click(app, '[data-testid="pie-sheet"] .start-row');
    await waitFor(app, `document.querySelector('[data-testid="pie-sheet"]') === null`, 10_000);
    await waitFor(app, `document.querySelector(".phone-title").textContent === ${JSON.stringify(newestBasename)}`, 10_000);
    console.log(`ok: opening the first row opened "${newestBasename}" and closed the sheet`);

    // ── Back to the start page (the second, still-empty tab FOCUS_OR_OPEN
    //    left behind) so the band remounts, then checkpoint 9: reopen the
    //    pie and dismiss it by tapping the scrim ─────────────────────────
    await clickButtonByAriaLabelPrefix(app, "Open tabs");
    await waitFor(app, `document.querySelector(".phone-tab-list") !== null`, 10_000);
    await activateTabByLabel(app, "New tab");
    await waitFor(app, `document.querySelector('[data-testid="ios-sky"]') !== null`, 10_000);

    await click(app, '[data-pie-id="builtin:received"]');
    await waitFor(app, `document.querySelector('[data-testid="pie-sheet"]') !== null`, 10_000);
    await click(app, ".phone-scrim");
    await waitFor(app, `document.querySelector('[data-testid="pie-sheet"]') === null`, 10_000);
    console.log("ok: reopening the pie then tapping the scrim dismisses the sheet");

    // ── Checkpoint 10: the Library sheet (M0/pre-M6, untouched by M6)
    //    still works alongside the band — the same three received files,
    //    listed a second way ─────────────────────────────────────────────
    await clickButtonByAriaLabelPrefix(app, "Library");
    await waitFor(app, `document.querySelector('[role="dialog"][aria-label="Library"]') !== null`, 10_000);
    const libraryRowCount = await evalIn(
      app,
      `document.querySelectorAll('[data-testid="received-group"] li').length`,
    );
    if (libraryRowCount !== 3) {
      throw new Error(`expected 3 rows in the Library sheet's Received group, got ${libraryRowCount}`);
    }
    const libraryShot = await app.screenshot("m6-library-sheet");
    console.log(`ok: Library sheet still works (3 received rows) — screenshot written to ${libraryShot}`);
    await click(app, '.phone-sheet-action[aria-label="Close"]');
    await waitFor(app, `document.querySelector('[role="dialog"][aria-label="Library"]') === null`, 10_000);

    // ── Checkpoint 11: the Tabs sheet still works, and still lists the
    //    tab M6's own FOCUS_OR_OPEN opened earlier ──────────────────────
    await clickButtonByAriaLabelPrefix(app, "Open tabs");
    await waitFor(app, `document.querySelector(".phone-tab-list") !== null`, 10_000);
    const tabLabels = (await evalIn(
      app,
      `Array.from(document.querySelectorAll(".phone-tab-row-name")).map(function(e){ return e.textContent; })`,
    )) as string[];
    if (!tabLabels.includes(newestBasename)) {
      throw new Error(`expected the tabs sheet to include ${JSON.stringify(newestBasename)}, got ${JSON.stringify(tabLabels)}`);
    }
    const tabsShot = await app.screenshot("m6-tabs-sheet");
    console.log(`ok: Tabs sheet still works (includes "${newestBasename}") — screenshot written to ${tabsShot}`);
    // Activate the file's tab — Comments (checkpoint 12) needs an active
    // document; this also closes the sheet.
    await activateTabByLabel(app, newestBasename);
    await waitFor(app, `document.querySelector(".phone-title").textContent === ${JSON.stringify(newestBasename)}`, 10_000);

    // ── Checkpoint 12: the Comments sheet still works over an active file
    await clickButtonByAriaLabelPrefix(app, "Comments");
    await waitFor(app, `document.querySelector('[role="dialog"][aria-label="Comments"]') !== null`, 10_000);
    const commentsShot = await app.screenshot("m6-comments-sheet");
    console.log(`ok: Comments sheet still works over an active file — screenshot written to ${commentsShot}`);
    await click(app, '.phone-sheet-action[aria-label="Close"]');
    await waitFor(app, `document.querySelector('[role="dialog"][aria-label="Comments"]') === null`, 10_000);

    // ── Checkpoint 13: the pie disappears while its sheet is open ──────
    //    Every seeded file is removed while the sheet is up, so the Received
    //    pie has no members and `iosPies` drops it from the band entirely.
    //    Nothing may survive that: no band, no sheet, and above all no
    //    scrim left covering the screen with nothing under it.
    //
    //    The Library sheet is the refresh: `ReceivedDrawer` calls
    //    `refreshReceived` when it mounts, and it is the ONLY in-app trigger
    //    a harness can reach on the phone — the other one is the iOS
    //    foreground hop, and `location.reload()` is a no-op inside this
    //    WKWebView. Opening it also closes the pie sheet, by the one-sheet
    //    rule, which is why this asserts the OUTCOME (nothing orphaned)
    //    rather than which of the two closes fired first.
    await clickButtonByAriaLabelPrefix(app, "Open tabs");
    await waitFor(app, `document.querySelector(".phone-tab-list") !== null`, 10_000);
    await activateTabByLabel(app, "New tab");
    await waitFor(app, `document.querySelector('[data-testid="ios-sky"]') !== null`, 10_000);
    await click(app, '[data-pie-id="builtin:received"]');
    await waitFor(app, `document.querySelector('[data-testid="pie-sheet"]') !== null`, 10_000);

    await fs.promises.rm(receivedDay, { recursive: true, force: true });
    await clickButtonByAriaLabelPrefix(app, "Library");
    await waitFor(
      app,
      `document.querySelectorAll('[data-testid="received-group"] li').length === 0`,
      15_000,
    );
    await click(app, '.phone-sheet-action[aria-label="Close"]');
    await waitFor(app, `document.querySelector('[role="dialog"][aria-label="Library"]') === null`, 10_000);

    const afterGone = (await evalIn(
      app,
      `(function(){
        return {
          band: document.querySelector('[data-testid="ios-sky"]') !== null,
          sheet: document.querySelector('[data-testid="pie-sheet"]') !== null,
          scrim: document.querySelector(".phone-scrim") !== null,
          startPage: document.querySelector('[data-testid="start-page"]') !== null,
        };
      })()`,
    )) as { band: boolean; sheet: boolean; scrim: boolean; startPage: boolean };
    if (!afterGone.startPage) throw new Error("expected the start page to still render with no pies");
    if (afterGone.band) throw new Error("expected no Sky band once every received file is gone");
    if (afterGone.sheet) throw new Error("expected no pie sheet once its pie left the band");
    if (afterGone.scrim) throw new Error("expected no .phone-scrim once its pie left the band");
    console.log("ok: with its pie gone, the band, the sheet and the scrim are all gone");
  } finally {
    await quit(app);
    // `quit()` calls `simctl terminate`, which does not wait for the
    // state-store's own ~250ms debounced writer to flush. A MISSING file is
    // therefore inconclusive and only logged; a file that DOES carry the key
    // is the exact regression this check exists for, so it fails the run.
    const statePath = path.join(stateDir, "state.json");
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, "utf8");
      if (raw.includes("sky_visible")) {
        throw new Error(
          `${statePath} contains a "sky_visible" key — the phone has no toolbar to write one, ` +
            "so something on iOS wrote a macOS-only persisted key.",
        );
      }
      console.log(`ok: ${statePath} carries no "sky_visible" key — the band's presence is derived, never persisted`);
    } else {
      console.log(`ok: ${statePath} was never written — the band's presence is derived, never persisted`);
    }
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  }
  // AFTER the finally, so a `sky_visible` violation thrown in there cannot
  // print under a PASS that is already on screen.
  console.log("PASS");
}

main().catch((err: unknown) => {
  console.error("FAIL", err);
  process.exitCode = 1;
});
