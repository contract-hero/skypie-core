// `pnpm -C ui e2e:m2` — M2's own acceptance checkpoint, driven as one
// continuous user session against the REAL debug macOS app: create a user
// pie ("Pricing") from the tin, ⌘D three open tabs into it through the
// picker, zoom the pie, rotate the wedge selection by bearing and cut the
// HTML wedge, open a file from the layer list, and confirm the persisted
// document (and its member canonicalization) survives a relaunch. See
// ui/e2e/README.md.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { click, evalIn, keys, launchDesktop, quit, text, waitFor } from "./lib/app";
import type { LaunchedApp } from "./lib/app";
import { cleanupFixtureWorkspace, makeFixtureWorkspace, setWorkspaceRoot } from "./lib/fixtureWorkspace";

/** Open a file through the app's own ⌘P palette — same technique as
 *  smoke.ts/sky.e2e.ts/m1.e2e.ts, repeated here rather than shared so each
 *  scenario stays a single, independently-readable file (this directory's
 *  existing convention). */
async function openViaQuickOpen(app: LaunchedApp, absPath: string): Promise<void> {
  await keys(app, "mod+p");
  await waitFor(app, `document.querySelector('[data-testid="quick-open"]') !== null`, 10_000);
  const rowSelector = `li[title=${JSON.stringify(absPath)}]`;
  await waitFor(app, `document.querySelector(${JSON.stringify(rowSelector)}) !== null`, 10_000);
  await click(app, rowSelector);
  await waitFor(app, `document.querySelector(".tab.active .tab-label") !== null`, 10_000);
}

/** Type into a React-controlled `<input>` the native-setter way — a bare
 *  `el.value = "…"` never fires React's own change handler, since React
 *  patches the DOM property setter itself (`ui/e2e/README.md`'s own
 *  documented technique, also in the M2 brief). */
async function typeIntoInput(app: LaunchedApp, selector: string, value: string): Promise<void> {
  const js = `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
  const ok = await evalIn(app, js);
  if (!ok) throw new Error(`typeIntoInput: no element matches ${selector}`);
}

/** Dispatch a keydown on `document.activeElement` — component-level arrow/
 *  Enter handling (the plate's radiogroup) is driven this way, not via
 *  `keys()`, which dispatches on `document` and only App's window-capture
 *  registry sees (M2 brief). */
async function keyOnActiveElement(app: LaunchedApp, key: string): Promise<void> {
  const js = `(function(){
    var el = document.activeElement;
    if (!el) return false;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true }));
    return true;
  })()`;
  const ok = await evalIn(app, js);
  if (!ok) throw new Error("keyOnActiveElement: document.activeElement is null");
}

interface OnDiskPies {
  pies?: { v?: number; pies?: { id: string; name: string; members: { path: string }[] }[] };
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

/** Poll the on-disk state document (the debounced writer, ~250ms) until
 *  `predicate` is true of the parsed `pies` document. */
async function waitForPersistedPies(
  stateDir: string,
  predicate: (doc: NonNullable<OnDiskPies["pies"]>) => boolean,
  timeoutMs = 5_000,
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

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skypie-e2e-m2-state-"));
  const fixture = makeFixtureWorkspace("skypie-e2e-m2-");
  // A second "code"-kind file, so the three tabs added to Pricing are 2
  // code + 1 html (67%/33%, NOT tied) rather than 3 distinct kinds tied at
  // 33% each — a tie would make "html" the dominant kind (BEARINGS' own
  // tie-break: first PRESENT kind in bearing order) from the very start,
  // and step 6 below would never actually have to press ArrowRight to
  // prove the rotation works.
  const secondTsPath = path.join(fixture.dir, "second.ts");
  fs.writeFileSync(secondTsPath, "export const another: number = 7;\n");
  console.log(`fixture workspace: ${fixture.dir}`);
  console.log(`scratch state dir: ${stateDir}`);

  let app: LaunchedApp = await launchDesktop({ stateDir });
  try {
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    // The canonical form of the fixture dir, not the literal — on macOS
    // `os.tmpdir()` goes through the `/var` → `/private/var` symlink.
    // `pies::add_member` stores CANONICAL member paths (spec section 6:
    // "so they match the watcher's own paths"), so setting a non-canonical
    // root would make every tab's `entry.path` disagree with the stored
    // member path even though both name the same file — an artifact of the
    // tmpdir symlink, not of any M2 behavior under test.
    await setWorkspaceRoot(app, fs.realpathSync(fixture.dir));

    // ── Step 1: ⌘⇧B shows the band ────────────────────────────────────────
    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector('.sky-band[role="listbox"][aria-label="Pies"]') !== null`, 10_000);
    await waitFor(
      app,
      `document.querySelector('[data-testid="toolbar-sky-toggle"]')?.getAttribute("aria-pressed") === "true"`,
      10_000,
    );
    console.log("ok: ⌘⇧B shows the band, tile pressed");

    // ── Step 2: the tin creates "Pricing" ─────────────────────────────────
    await click(app, '[data-testid="sky-new-pie"]');
    await waitFor(app, `document.querySelector('input[data-testid="pie-name-input"]') !== null`, 10_000);
    await typeIntoInput(app, 'input[data-testid="pie-name-input"]', "Pricing");
    await keyOnActiveElement(app, "Enter");

    await waitFor(app, `document.querySelectorAll('.sky-pies [data-pie-id]').length === 3`, 10_000);
    const pieIds = (await evalIn(
      app,
      `Array.from(document.querySelectorAll(".sky-pies [data-pie-id]")).map(function(el){ return el.getAttribute("data-pie-id"); })`,
    )) as string[];
    if (pieIds[0] !== "builtin:pinned" || pieIds[1] !== "builtin:recent") {
      throw new Error(`expected the two built-ins first, got ${JSON.stringify(pieIds)}`);
    }
    const pricingId = pieIds[2];
    if (!pricingId || pricingId === "builtin:pinned" || pricingId === "builtin:recent") {
      throw new Error(`expected a third, server-minted pie id, got ${JSON.stringify(pieIds)}`);
    }
    const pricingLabel = await text(app, `[data-pie-id=${JSON.stringify(pricingId)}] .sky-pie-label`);
    if (pricingLabel !== "Pricing") {
      throw new Error(`expected the new pie's label to be "Pricing", got ${JSON.stringify(pricingLabel)}`);
    }
    const lastChildIsTin = await evalIn(
      app,
      `document.querySelector(".sky-pies")?.lastElementChild?.getAttribute("data-testid") === "sky-new-pie"`,
    );
    if (!lastChildIsTin) throw new Error("expected the tin to still be the last child of .sky-pies");
    console.log(`ok: the tin created "Pricing" (id ${pricingId}); ids are ${JSON.stringify(pieIds)}; tin still last`);

    // ── Step 3: ⌘D on three open tabs, through the picker ─────────────────
    // Canonical (see the setWorkspaceRoot comment above) — the quick-open
    // rows' own `title` is `root/relPath`, so it must agree with these to
    // be found by `openViaQuickOpen`, and `entry.path` (what ⌘D reads) is
    // taken straight from that same tab entry.
    const tabs = [
      { path: fs.realpathSync(fixture.files.html), kind: "html" },
      { path: fs.realpathSync(fixture.files.ts), kind: "code" },
      { path: fs.realpathSync(secondTsPath), kind: "code" },
    ];
    for (const [i, tab] of tabs.entries()) {
      await openViaQuickOpen(app, tab.path);
      await keys(app, "mod+d");
      await waitFor(app, `document.querySelector('[data-testid="pie-picker"]') !== null`, 10_000);
      const rowSelector = `[data-pie-picker-row][data-id=${JSON.stringify(pricingId)}]`;
      await waitFor(app, `document.querySelector(${JSON.stringify(rowSelector)}) !== null`, 10_000);
      await click(app, rowSelector);
      await waitFor(app, `document.querySelector('[data-testid="pie-picker"]') === null`, 10_000);

      if (i === 0) {
        // Reopening the picker for the SAME path shows the row checked.
        await keys(app, "mod+d");
        await waitFor(app, `document.querySelector('[data-testid="pie-picker"]') !== null`, 10_000);
        await waitFor(
          app,
          `document.querySelector(${JSON.stringify(rowSelector)})?.getAttribute("aria-checked") === "true"`,
          10_000,
        );
        await keys(app, "escape");
        await waitFor(app, `document.querySelector('[data-testid="pie-picker"]') === null`, 10_000);
        console.log("ok: reopening the picker for the same path shows the row checked");
      }
    }
    console.log("ok: ⌘D added all three open tabs to Pricing through the picker");

    // ── Step 4: state.json holds the document, canonical member paths ─────
    const doc = await waitForPersistedPies(
      stateDir,
      (d) => d.v === 1 && (d.pies?.[0]?.members.length ?? 0) === 3,
    );
    if (doc.pies?.[0]?.name !== "Pricing") {
      throw new Error(`expected pies.pies[0].name === "Pricing", got ${JSON.stringify(doc.pies?.[0]?.name)}`);
    }
    const expectedCanonical = new Set(tabs.map((t) => fs.realpathSync(t.path)));
    const storedPaths = doc.pies?.[0]?.members.map((m) => m.path) ?? [];
    for (const p of storedPaths) {
      if (!path.isAbsolute(p)) throw new Error(`member path is not absolute: ${p}`);
      if (!expectedCanonical.has(p)) {
        throw new Error(`member path ${p} is not the canonical form of one of the three fixture files`);
      }
    }
    console.log(`ok: state.json's pies key holds v:1, "Pricing", 3 canonical member paths`);

    // ── Step 5: zoom the pie ───────────────────────────────────────────────
    await click(app, `[data-pie-id=${JSON.stringify(pricingId)}]`);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    await waitFor(
      app,
      `(function(){
        var readout = document.querySelector(".pie-plate-readout");
        var radios = document.querySelectorAll('[data-testid="pie-legend"][role="radiogroup"] [role="radio"]');
        return readout !== null && readout.textContent.trim().length > 0 && radios.length >= 2;
      })()`,
      10_000,
    );
    await waitFor(app, `document.querySelector(".tab-view")?.style.pointerEvents === "none"`, 10_000);
    console.log("ok: zooming Pricing drops the plate with a radiogroup legend of ≥2 kinds");

    // ── Step 6: ←/→ rotate to HTML, Enter cuts the wedge ───────────────────
    const firstRadioSelector = '[data-testid="pie-legend"][role="radiogroup"] [role="radio"]';
    await evalIn(
      app,
      `document.querySelectorAll(${JSON.stringify(firstRadioSelector)})[0]?.focus()`,
    );
    let rotations = 0;
    for (;;) {
      const checkedText = await evalIn(
        app,
        `document.querySelector(${JSON.stringify(firstRadioSelector)} + '[aria-checked="true"]')?.textContent ?? ""`,
      );
      if (typeof checkedText === "string" && checkedText.includes("HTML")) break;
      rotations += 1;
      if (rotations > 8) throw new Error("never rotated onto the HTML radio");
      await keyOnActiveElement(app, "ArrowRight");
    }
    await keyOnActiveElement(app, "Enter");
    await waitFor(app, `document.querySelector('[data-testid="pie-slice-chip"]') !== null`, 10_000);
    const chipText = await text(app, '[data-testid="pie-slice-chip"]');
    if (!chipText?.trim().startsWith("Slice · HTML")) {
      throw new Error(`expected the chip to start "Slice · HTML", got ${JSON.stringify(chipText)}`);
    }
    await waitFor(
      app,
      `document.querySelector('.pie-plate-left svg path[data-kind="html"][data-cut="true"]') !== null`,
      10_000,
    );
    const layerNames = (await evalIn(
      app,
      `Array.from(document.querySelectorAll('[data-testid="pie-layers"] .start-row-name')).map(function(el){ return el.textContent; })`,
    )) as string[];
    if (layerNames.length === 0 || !layerNames.every((n) => n.endsWith(".html"))) {
      throw new Error(`expected every layer name to end in .html, got ${JSON.stringify(layerNames)}`);
    }
    console.log(`ok: ←/→ rotated to HTML, Enter cut the wedge, chip + layers (${JSON.stringify(layerNames)}) agree`);

    // ── Step 7: open a file from the layer list ────────────────────────────
    await click(app, '[data-testid="pie-layers"] .start-row');
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);
    await waitFor(app, `document.querySelector(".tab-view")?.style.pointerEvents !== "none"`, 10_000);
    const activeLabel = await text(app, ".tab.active .tab-label");
    if (activeLabel !== "report.html") {
      throw new Error(`expected the active tab to be report.html, got ${JSON.stringify(activeLabel)}`);
    }
    console.log("ok: opening the row opened report.html and closed the plate, pointer-events restored");

    // ── Step 8: relaunch (Rust changed in M2) — Pricing is still there ─────
    await quit(app);
    app = await launchDesktop({ stateDir, skipBuild: false });
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    await waitFor(app, `document.querySelector('.sky-band[role="listbox"][aria-label="Pies"]') !== null`, 10_000);
    await waitFor(
      app,
      `Array.from(document.querySelectorAll(".sky-pies .sky-pie-label")).some(function(el){ return el.textContent === "Pricing"; })`,
      10_000,
    );
    console.log("ok: after a relaunch, the Pricing pie is present with no keypress");

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
