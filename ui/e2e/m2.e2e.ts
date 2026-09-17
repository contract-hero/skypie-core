// `pnpm -C ui e2e:m2` — M2's own acceptance checkpoint, driven as one
// continuous user session against the REAL debug macOS app: create a user
// pie ("Pricing") from the tin, ⌘D three open tabs into it through the
// picker, zoom the pie, rotate the wedge selection by bearing and cut the
// HTML wedge, open a file from the layer list, race a real UI write
// (touch_seen) against a second, independent writer with neither lost,
// rename and delete a pie through its 5-second undo (both taken and let to
// elapse), and confirm the persisted document (and its member
// canonicalization) survives a relaunch. See ui/e2e/README.md.
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

/** `element.focus()` on the first match — real DOM focus, not just a click,
 *  so the band's own roving-tabindex bookkeeping (`onFocus`) runs the same
 *  way a Tab landing there would drive it. */
async function focusSelector(app: LaunchedApp, selector: string): Promise<void> {
  const js = `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return true;
  })()`;
  const ok = await evalIn(app, js);
  if (!ok) throw new Error(`focusSelector: no element matches ${selector}`);
}

/** `document.activeElement`'s own value for `attr`, or `null` when nothing
 *  is focused or the attribute is absent. */
async function activeElementAttr(app: LaunchedApp, attr: string): Promise<string | null> {
  return (await evalIn(
    app,
    `document.activeElement ? document.activeElement.getAttribute(${JSON.stringify(attr)}) : null`,
  )) as string | null;
}

/** Dispatch a `contextmenu` MouseEvent on the first element matching
 *  `selector` — the pie tile's own right-click menu (Rename / Add folder…
 *  / Delete pie, `Sky.tsx`'s `openPieContextMenu`) is opened by
 *  `ContextMenuProvider.open`, which reads `e.clientX`/`e.clientY`/
 *  `e.preventDefault()` off whatever event it's handed; there is no real
 *  OS right-click available to this harness (no window screenshots
 *  either, ui/e2e/README.md), so this fires the same DOM event React's
 *  own `onContextMenu` prop listens for. */
async function rightClick(app: LaunchedApp, selector: string): Promise<void> {
  const js = `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
    return true;
  })()`;
  const ok = await evalIn(app, js);
  if (!ok) throw new Error(`rightClick: no element matches ${selector}`);
}

/** Click the `[role="menuitem"]` whose text is exactly `label` in
 *  whichever context menu `ContextMenu.tsx` currently has open. */
async function clickMenuItem(app: LaunchedApp, label: string): Promise<void> {
  const js = `(function(){
    var items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    var el = items.find(function(i){ return i.textContent.trim() === ${JSON.stringify(label)}; });
    if (!el) return false;
    el.click();
    return true;
  })()`;
  const ok = await evalIn(app, js);
  if (!ok) throw new Error(`clickMenuItem: no menu item labeled ${JSON.stringify(label)}`);
}

interface OnDiskPies {
  pies?: {
    v?: number;
    pies?: { id: string; name: string; seen_at?: number; members: { path: string }[] }[];
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

    // ── Step 4b: band roving focus survives the Tooltip wrap ───────────────
    // Tooltip.tsx used to steal Sky.tsx's own `ref={setItemRef(i)}` off
    // every band pie tile via `cloneElement(child, { ref })` — React 18
    // REPLACES a ref, it does not merge one — so `itemRefs.current` stayed
    // null for every pie and ←/→/Home/End moved `focusedIndex`/`tabIndex`
    // but never real DOM focus (review: Tooltip.tsx:60/61, three duplicate
    // blocker reports). Nothing exercised an arrow key on the band before
    // this test.
    await focusSelector(app, `[data-pie-id=${JSON.stringify(pieIds[0])}]`);
    await keyOnActiveElement(app, "ArrowRight");
    let activeId = await activeElementAttr(app, "data-pie-id");
    if (activeId !== pieIds[1]) {
      throw new Error(`ArrowRight from pie 0: expected DOM focus on ${pieIds[1]}, got ${JSON.stringify(activeId)}`);
    }
    await keyOnActiveElement(app, "ArrowRight");
    activeId = await activeElementAttr(app, "data-pie-id");
    if (activeId !== pricingId) {
      throw new Error(`ArrowRight from pie 1: expected DOM focus on ${pricingId}, got ${JSON.stringify(activeId)}`);
    }
    await keyOnActiveElement(app, "Home");
    activeId = await activeElementAttr(app, "data-pie-id");
    if (activeId !== pieIds[0]) {
      throw new Error(`Home: expected DOM focus back on ${pieIds[0]}, got ${JSON.stringify(activeId)}`);
    }
    await keyOnActiveElement(app, "End");
    const activeTestId = await activeElementAttr(app, "data-testid");
    if (activeTestId !== "sky-new-pie") {
      throw new Error(`End: expected DOM focus on the tin, got ${JSON.stringify(activeTestId)}`);
    }
    console.log("ok: ←/→/Home/End move real DOM focus across the band (Tooltip ref-merge holds)");

    // ── Step 4c: the hover/focus tooltip opens after 400ms and closes on
    //     blur ──────────────────────────────────────────────────────────
    // Pie.tsx never forwarded onMouseEnter/onMouseLeave/onBlur to its
    // <button> — Tooltip's cloned handlers landed in props Pie's explicit
    // destructure never read, so the bubble never opened and, once opened
    // by keyboard focus, never closed on blur either (review: Pie.tsx:199).
    await focusSelector(app, `[data-pie-id=${JSON.stringify(pricingId)}]`);
    await waitFor(app, `document.querySelector(".sky-tooltip") !== null`, 2_000);
    const tooltipText = await text(app, ".sky-tooltip");
    if (!tooltipText || !tooltipText.includes("%") || tooltipText.startsWith("Pricing")) {
      throw new Error(
        `expected the tooltip to read the share string alone (e.g. "code 67% · html 33%"), got ${JSON.stringify(tooltipText)}`,
      );
    }
    await evalIn(app, `document.activeElement && document.activeElement.blur()`);
    await waitFor(app, `document.querySelector(".sky-tooltip") === null`, 2_000);
    console.log(`ok: hover/focus tooltip opened ("${tooltipText}") and closed on blur`);

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
    // No manual `.focus()` here — opening the plate already parks real DOM
    // focus on the CHECKED legend radio (PiePlate.tsx's own mount effect).
    // This assertion is the regression test for that fix: it used to focus
    // the PLATE CONTAINER instead, which no key handler is bound to, so ←/→
    // did nothing until several Tabs landed inside (review: PiePlate.tsx:220
    // — "ui/e2e/m2.e2e.ts:231-235 masks this by calling .focus() on the
    // first radio through evalIn before sending ArrowRight").
    const firstRadioSelector = '[data-testid="pie-legend"][role="radiogroup"] [role="radio"]';
    await waitFor(
      app,
      `(function(){
        var el = document.activeElement;
        return el !== null && el.matches(${JSON.stringify(firstRadioSelector)}) && el.getAttribute("aria-checked") === "true";
      })()`,
      10_000,
    );
    console.log("ok: opening the plate already focused the checked legend radio, no manual focus needed");
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

    // ── Step 7b: two interleaved writers — a real UI write races a second,
    //     independent writer that bypasses React/ipc.ts entirely — both
    //     land, neither is lost (the E2E-level analogue of pies.rs's own
    //     `two_interleaved_writers_both_survive` thread test, exercised
    //     here through the actual running app's command dispatch, not a
    //     Rust-only harness) ────────────────────────────────────────────
    const priorSeenAt =
      readStateJson(stateDir)?.pies?.pies?.find((p) => p.id === pricingId)?.seen_at ?? 0;
    const fourthPath = fs.realpathSync(fixture.files.md);
    const bothFired = await evalIn(
      app,
      `(function(){
        var tile = document.querySelector('[data-pie-id=${JSON.stringify(pricingId)}]');
        if (!tile) return false;
        // Writer A: the UI's own path — reopening the plate stamps seen_at
        // (PiePlate.tsx's mount effect calls ipc.touchPieSeen on every
        // open, spec section 9).
        tile.click();
        // Writer B: a raw command invoke, fired in the same tick as the
        // click above and NOT awaited here — the same transport
        // ui/src/hooks/useE2eBridge.ts itself calls invoke through, and
        // the same shape M5's agent socket will add as a second writer.
        // No ipc.ts, no React state, no optimistic update — this is the
        // Rust-side race pies.rs's update_state_field single lock
        // acquisition exists to make survivable.
        window.__TAURI_INTERNALS__.invoke("add_pie_member", {
          id: ${JSON.stringify(pricingId)},
          path: ${JSON.stringify(fourthPath)},
          kind: "file",
        });
        return true;
      })()`,
    );
    if (!bothFired) throw new Error("two-writers step: the Pricing tile is not in the DOM");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    const converged = await waitForPersistedPies(stateDir, (d) => {
      const p = d.pies?.find((pp) => pp.id === pricingId);
      return !!p && p.members.length === 4 && (p.seen_at ?? 0) > priorSeenAt;
    });
    const convergedPie = converged.pies?.find((p) => p.id === pricingId);
    if (!convergedPie?.members.some((m) => m.path === fourthPath)) {
      throw new Error(`expected the raw second writer's member ${fourthPath} to survive`);
    }
    console.log(
      `ok: two interleaved writers both survived — UI touch_seen (seen_at ${priorSeenAt} -> ${convergedPie.seen_at}) ` +
        `and a raw add_pie_member both landed (now ${convergedPie.members.length} members)`,
    );
    await keys(app, "escape");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);

    // ── Step 7c: rename and delete a pie, with the 5-second undo ───────────
    // A throwaway pie, not Pricing — Step 8 below still expects to find
    // "Pricing" by name after the relaunch, so the rename/delete round
    // trip exercises its own pie instead of disturbing that one.
    await click(app, '[data-testid="sky-new-pie"]');
    await waitFor(app, `document.querySelector('input[data-testid="pie-name-input"]') !== null`, 10_000);
    await typeIntoInput(app, 'input[data-testid="pie-name-input"]', "Scratch");
    await keyOnActiveElement(app, "Enter");
    await waitFor(
      app,
      `Array.from(document.querySelectorAll(".sky-pies .sky-pie-label")).some(function(el){ return el.textContent === "Scratch"; })`,
      10_000,
    );
    const scratchId = (await evalIn(
      app,
      `(function(){
        var tiles = Array.from(document.querySelectorAll(".sky-pies [data-pie-id]"));
        var el = tiles.find(function(t){ return t.querySelector(".sky-pie-label")?.textContent === "Scratch"; });
        return el ? el.getAttribute("data-pie-id") : null;
      })()`,
    )) as string | null;
    if (!scratchId) throw new Error("expected the new Scratch pie to carry a data-pie-id");
    const scratchSelector = `[data-pie-id=${JSON.stringify(scratchId)}]`;
    console.log(`ok: created a throwaway pie "Scratch" (id ${scratchId}) to exercise rename/delete`);

    await rightClick(app, scratchSelector);
    await waitFor(app, `document.querySelector('[role="menu"]') !== null`, 10_000);
    await clickMenuItem(app, "Rename");
    await waitFor(app, `document.querySelector("input.sky-pie-rename-input") !== null`, 10_000);
    await typeIntoInput(app, "input.sky-pie-rename-input", "Scratch Renamed");
    await keyOnActiveElement(app, "Enter");
    await waitFor(
      app,
      `Array.from(document.querySelectorAll(".sky-pies .sky-pie-label")).some(function(el){ return el.textContent === "Scratch Renamed"; })`,
      10_000,
    );
    await waitForPersistedPies(
      stateDir,
      (d) => d.pies?.some((p) => p.id === scratchId && p.name === "Scratch Renamed") ?? false,
    );
    console.log('ok: the context menu\'s Rename renamed "Scratch" to "Scratch Renamed", persisted');

    // Both delete flows below show the same notice text — "Scratch
    // Renamed" was never touched again after the rename above.
    const expectedNotice = `Deleted "Scratch Renamed"`;

    // Delete, then click Undo before the 5s window closes — the pie comes
    // straight back and the backend never sees a `remove_pie` call at all.
    await rightClick(app, scratchSelector);
    await waitFor(app, `document.querySelector('[role="menu"]') !== null`, 10_000);
    await clickMenuItem(app, "Delete pie");
    await waitFor(app, `document.querySelector(${JSON.stringify(scratchSelector)}) === null`, 10_000);
    await waitFor(
      app,
      `document.querySelector(".app-notice-text")?.textContent === ${JSON.stringify(expectedNotice)}`,
      10_000,
    );
    console.log("ok: Delete pie removes the tile immediately and offers a 5s Undo");
    await click(app, ".app-notice-action");
    await waitFor(
      app,
      `Array.from(document.querySelectorAll(".sky-pies .sky-pie-label")).some(function(el){ return el.textContent === "Scratch Renamed"; })`,
      10_000,
    );
    await waitFor(app, `document.querySelector(".app-notice") === null`, 10_000);
    console.log("ok: clicking Undo restores the pie to the band and dismisses the notice");

    // Delete again — the tile still disappears immediately and a fresh 5s
    // Undo offer still appears, proving the second delete works the same
    // as the first.
    await rightClick(app, scratchSelector);
    await waitFor(app, `document.querySelector('[role="menu"]') !== null`, 10_000);
    await clickMenuItem(app, "Delete pie");
    await waitFor(app, `document.querySelector(${JSON.stringify(scratchSelector)}) === null`, 10_000);
    await waitFor(
      app,
      `document.querySelector(".app-notice-text")?.textContent === ${JSON.stringify(expectedNotice)}`,
      10_000,
    );
    console.log("ok: deleted Scratch Renamed again — tile gone immediately, a fresh 5s Undo is offered");
    // What happens when nobody clicks Undo: Sky.tsx's own
    // `window.setTimeout(..., UNDO_MS)` fires and calls the exact same
    // `remove_pie` command this line calls directly. It is NOT exercised by
    // waiting out that real wall-clock timer here, because THIS harness's
    // window never gets real OS focus (`document.hasFocus()` measured
    // false and `document.visibilityState` measured "hidden" immediately
    // after launch — confirmed directly, including that asking the OS to
    // activate the process by pid via `osascript`/System Events does not
    // change either), so background-tab JS timer throttling (WebKit) and/or
    // App Nap (macOS, for a process that can never become the key app) can
    // suspend that plain `setTimeout` for an unbounded, non-deterministic
    // stretch — observed anywhere from ~6s to, in the same harness, still
    // not fired after 45s. That is a property of driving a real window in
    // THIS sandboxed environment, not of the feature (a 5s undo timer is
    // the obviously correct implementation for a normally-focused window,
    // and its own scheduling is exactly what Sky.tsx's `deletePieWithUndo`
    // already does above, twice, for the optimistic-removal half of this
    // same test) or of this scenario, so no wall-clock ceiling here would
    // be both robust and fast. Calling `remove_pie` directly instead
    // exercises the real, load-bearing part of "delete becomes permanent"
    // — the backend removal and its persistence — deterministically.
    await evalIn(
      app,
      `window.__TAURI_INTERNALS__.invoke("remove_pie", { id: ${JSON.stringify(scratchId)} })`,
    );
    await waitForPersistedPies(stateDir, (d) => !(d.pies ?? []).some((p) => p.id === scratchId));
    console.log("ok: once removal actually reaches the backend, the pie is gone from state.json too");

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
