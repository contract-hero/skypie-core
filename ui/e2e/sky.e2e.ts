// `pnpm -C ui e2e:sky` — drives the REAL debug macOS app through M1's own
// checkpoint: ⌘⇧B shows the band with the two built-in pies, opening the
// Recent plate and slicing to HTML surfaces the fixture's one HTML file,
// and opening it from the layer list closes the plate and switches tabs.
// See ui/e2e/README.md.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { click, evalIn, keys, launchDesktop, quit, text, waitFor } from "./lib/app";
import { cleanupFixtureWorkspace, makeFixtureWorkspace, setWorkspaceRoot } from "./lib/fixtureWorkspace";

/** Open a file through the app's own ⌘P palette — same technique as
 *  smoke.ts, repeated here to populate Recents with more than one file. */
async function openViaQuickOpen(app: Awaited<ReturnType<typeof launchDesktop>>, absPath: string): Promise<void> {
  await keys(app, "mod+p");
  await waitFor(app, `document.querySelector('[data-testid="quick-open"]') !== null`, 10_000);
  const rowSelector = `li[title=${JSON.stringify(absPath)}]`;
  await waitFor(app, `document.querySelector(${JSON.stringify(rowSelector)}) !== null`, 10_000);
  await click(app, rowSelector);
  await waitFor(app, `document.querySelector(".tab.active .tab-label") !== null`, 10_000);
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skypie-e2e-sky-state-"));
  const fixture = makeFixtureWorkspace("skypie-e2e-sky-");
  console.log(`fixture workspace: ${fixture.dir}`);
  console.log(`scratch state dir: ${stateDir}`);

  const app = await launchDesktop({ stateDir });
  try {
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    console.log("ok: toolbar renders");

    // Checkpoint 1: the tile exists and starts unpressed.
    const initialPressed = await evalIn(
      app,
      `document.querySelector('[data-testid="toolbar-sky-toggle"]')?.getAttribute("aria-pressed")`,
    );
    if (initialPressed !== "false") {
      throw new Error(`expected the sky tile to start aria-pressed="false", got ${JSON.stringify(initialPressed)}`);
    }
    console.log("ok: sky toggle starts unpressed");

    await setWorkspaceRoot(app, fixture.dir);

    // Populate Recent with three opens; only report.html is kind "html".
    // Opened last, so it sorts newest in the pie's file list too.
    await openViaQuickOpen(app, fixture.files.md);
    await openViaQuickOpen(app, fixture.files.json);
    await openViaQuickOpen(app, fixture.files.html);
    console.log("ok: opened three fixture files (Recent now holds them)");

    // Bookmark the active tab (report.html) — the only path to a Pinned
    // member in M1 (PiePicker/⌘D are M2).
    await click(app, '[data-testid="preview-bookmark-toggle"]');
    await waitFor(app, `document.querySelector('[data-testid="preview-bookmark-toggle"]')?.getAttribute("aria-pressed") === "true"`, 10_000);
    console.log("ok: bookmarked report.html (Pinned now holds it)");

    // Checkpoint 2: ⌘⇧B shows the band with exactly two pies, tile pressed.
    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector('.sky-band[role="listbox"][aria-label="Pies"]') !== null`, 10_000);
    await waitFor(app, `document.querySelector('[data-testid="toolbar-sky-toggle"]')?.getAttribute("aria-pressed") === "true"`, 10_000);
    await waitFor(app, `document.querySelectorAll(".sky-band [data-pie-id]").length === 2`, 10_000);
    console.log("ok: ⌘⇧B shows the band with two pies, tile pressed");

    // Checkpoint 3: both built-ins exist and carry a real disc (>=1 file
    // each, from the bookmark and the three opens above).
    await waitFor(
      app,
      `(function(){
        var pinned = document.querySelector('[data-pie-id="builtin:pinned"] svg path');
        var recent = document.querySelector('[data-pie-id="builtin:recent"] svg path');
        return pinned !== null && recent !== null;
      })()`,
      10_000,
    );
    console.log("ok: Pinned and Recent both render at least one wedge");

    // Checkpoint 4: clicking Recent opens the plate and neuters the preview.
    await click(app, '[data-pie-id="builtin:recent"]');
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    await waitFor(
      app,
      `document.querySelector(".tab-view")?.style.pointerEvents === "none"`,
      10_000,
    );
    console.log("ok: clicking Recent drops the plate and disables the preview's pointer events");

    // Checkpoint 5: click the HTML legend row; the layer list narrows to it.
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
    await waitFor(
      app,
      `(function(){
        var list = document.querySelector('[data-testid="pie-layers"][role="listbox"]');
        return list !== null && list.children.length > 0;
      })()`,
      10_000,
    );
    console.log("ok: clicking the HTML legend row leaves the layer list non-empty");

    // report.html should be the only (and therefore first) row now.
    const firstRowName = await text(app, '[data-testid="pie-layers"] .start-row .start-row-name');
    if (firstRowName !== "report.html") {
      throw new Error(`expected the HTML-filtered layer list's first row to be "report.html", got ${JSON.stringify(firstRowName)}`);
    }
    console.log(`ok: the HTML-filtered layer list's first row is "${firstRowName}"`);

    // Checkpoint 6: opening it closes the plate and switches the active tab.
    await click(app, '[data-testid="pie-layers"] .start-row');
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);
    await waitFor(
      app,
      `document.querySelector(".tab-view")?.style.pointerEvents !== "none"`,
      10_000,
    );
    const activeLabel = await text(app, ".tab.active .tab-label");
    if (activeLabel !== "report.html") {
      throw new Error(`expected the active tab's title to be "report.html", got ${JSON.stringify(activeLabel)}`);
    }
    console.log("ok: opening the row closes the plate, restores pointer events, and switches tabs");

    // Checkpoint 7: reader mode strips the band with the toolbar, and
    // leaving it restores both.
    await keys(app, "mod+shift+f");
    await waitFor(
      app,
      `document.querySelector(".toolbar") === null && document.querySelector(".sky-band") === null`,
      10_000,
    );
    console.log("ok: reader mode removes both the toolbar and the sky band");

    await keys(app, "mod+shift+f");
    await waitFor(
      app,
      `document.querySelector(".toolbar") !== null && document.querySelector(".sky-band") !== null`,
      10_000,
    );
    console.log("ok: leaving reader mode restores both");

    // ⌘⇧B hides the band again, and the toggle un-presses.
    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector(".sky-band") === null`, 10_000);
    await waitFor(app, `document.querySelector('[data-testid="toolbar-sky-toggle"]')?.getAttribute("aria-pressed") === "false"`, 10_000);
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
