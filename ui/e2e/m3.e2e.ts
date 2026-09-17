// `pnpm -C ui e2e:m3` — M3's own acceptance checkpoint, the "10-second
// demo" (spec section 1) driven end to end against the REAL debug macOS
// app: create "Pricing", add a fixture folder to it, write a new file into
// that folder and watch the +N pill tick within the watcher+census
// debounce window, click the pill to open the newest file in one click
// (no zoom), zoom the plate and read the folder layer tree (role="tree",
// the member-relative header, the new-file marker), confirm seen_at
// clears the pill and persists, then rename the folder on disk and use
// Locate…/Forget on the resulting "folder not found" layer. See
// ui/e2e/README.md.
//
// launchDesktop({ skipBuild: false }): M3 changed Rust (workspace.rs's
// pie_census, app.rs's pie_census command).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { click, evalIn, keys, launchDesktop, quit, text, waitFor } from "./lib/app";
import type { LaunchedApp } from "./lib/app";
import { cleanupFixtureWorkspace, makeFixtureWorkspace, setWorkspaceRoot } from "./lib/fixtureWorkspace";

// ── Small helpers, repeated from m2.e2e.ts rather than shared — this
//    directory's own convention (each scenario stays a single,
//    independently-readable file; ui/e2e/README.md). ──────────────────────

/** Type into a React-controlled `<input>` the native-setter way — a bare
 *  `el.value = "…"` never fires React's own change handler. */
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

/** Dispatch a keydown on `document.activeElement` — component-level key
 *  handling (the band's own onKeyDown) is driven this way, not via
 *  `keys()`, which dispatches on `document` and only the global window-
 *  capture registry sees. */
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

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skypie-e2e-m3-state-"));
  const fixture = makeFixtureWorkspace("skypie-e2e-m3-");
  console.log(`fixture workspace: ${fixture.dir}`);
  console.log(`scratch state dir: ${stateDir}`);

  let app: LaunchedApp = await launchDesktop({ stateDir, skipBuild: false });
  try {
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    const root = fs.realpathSync(fixture.dir);
    await setWorkspaceRoot(app, root);

    // ── Step 1: ⌘⇧B shows the band, the tin creates "Pricing" ─────────────
    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector('.sky-band[role="listbox"][aria-label="Pies"]') !== null`, 10_000);
    await click(app, '[data-testid="sky-new-pie"]');
    await waitFor(app, `document.querySelector('input[data-testid="pie-name-input"]') !== null`, 10_000);
    await typeIntoInput(app, 'input[data-testid="pie-name-input"]', "Pricing");
    await keyOnActiveElement(app, "Enter");
    await waitFor(app, `document.querySelectorAll('.sky-pies [data-pie-id]').length === 3`, 10_000);
    const pieIds = (await evalIn(
      app,
      `Array.from(document.querySelectorAll(".sky-pies [data-pie-id]")).map(function(el){ return el.getAttribute("data-pie-id"); })`,
    )) as string[];
    const pricingId = pieIds[2];
    if (!pricingId) throw new Error(`expected a third, server-minted pie id, got ${JSON.stringify(pieIds)}`);
    const tileSelector = `[data-pie-id=${JSON.stringify(pricingId)}]`;
    console.log(`ok: created "Pricing" (id ${pricingId})`);

    // ── Step 2: add a fixture SUBFOLDER as a folder member ─────────────────
    // Sky.tsx's own "Add folder…" (the tile's right-click menu) opens the
    // NATIVE macOS directory picker (`ipc.pickDirectory`) before it calls
    // `addPieMember(pie.id, picked, "folder", "menu")`. This harness has no
    // OS-level UI automation and no window screenshots (ui/e2e/README.md),
    // so a native dialog cannot be driven from here — the same limitation
    // m2.e2e.ts's own step 7b documents for a raw `add_pie_member` invoke.
    // This calls the exact same backend command "Add folder…" ultimately
    // reaches, over the identical transport `useE2eBridge.ts` itself uses,
    // skipping only the native-picker step neither test can drive.
    const subfolder = path.join(fixture.dir, "pricing");
    fs.mkdirSync(subfolder);
    const canonicalSubfolder = fs.realpathSync(subfolder);
    await evalIn(
      app,
      `window.__TAURI_INTERNALS__.invoke("add_pie_member", {
        id: ${JSON.stringify(pricingId)},
        path: ${JSON.stringify(canonicalSubfolder)},
        kind: "folder",
        source: "menu",
      })`,
    );
    await waitForPersistedPies(
      stateDir,
      (d) => (d.pies?.find((p) => p.id === pricingId)?.members.length ?? 0) === 1,
    );
    console.log(`ok: added the fixture subfolder ${canonicalSubfolder} as a folder member`);

    // ── Step 2b: establish a seen_at baseline ───────────────────────────────
    // `fresh` (workspace.rs's pie_census, mirrored in pie-census.ts's
    // freshCount) is deliberately 0 whenever `seen_at === 0` — "a
    // never-opened pie must not read every pre-existing file as new". A
    // brand-new pie's `seen_at` is 0 until its first plate open
    // (`touch_seen`), so the "+1 on a new write" checkpoint below needs one
    // real look at the empty pie first, the same way a person would
    // naturally glance at a pie right after making it — this one open/close
    // is not its own bullet in the milestone's short list, but is required
    // for consistency with that (explicit, twice-stated) seen_at==0 rule.
    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    await keys(app, "escape");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);
    await waitForPersistedPies(
      stateDir,
      (d) => (d.pies?.find((p) => p.id === pricingId)?.seen_at ?? 0) > 0,
    );
    console.log("ok: opened+closed the plate once to establish a seen_at baseline");

    // ── Step 3: Node writes a new file into the folder; the pill ticks ─────
    const newFile = path.join(subfolder, "pricing-v3.html");
    fs.writeFileSync(newFile, "<!doctype html><title>Pricing v3</title><h1>Pricing v3</h1>\n");
    // Watcher debounce (250ms, watcher.rs) + pie-census.ts's own 500ms —
    // every e2e wait on a census refresh needs a generous ceiling.
    await waitFor(
      app,
      `document.querySelector('${tileSelector} [data-testid="pie-fresh-pill"]')?.textContent.trim() === "+1"`,
      15_000,
    );
    console.log("ok: writing pricing-v3.html ticked the +1 pill within the debounce window");

    // ── Step 4: click the pill — opens the newest file in one click, no
    //     zoom ────────────────────────────────────────────────────────────
    await click(app, `${tileSelector} [data-testid="pie-fresh-pill"]`);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);
    const activeLabel = await text(app, ".tab.active .tab-label");
    if (activeLabel !== "pricing-v3.html") {
      throw new Error(`expected the active tab to be pricing-v3.html, got ${JSON.stringify(activeLabel)}`);
    }
    console.log("ok: clicking the pill opened pricing-v3.html in one click, no plate");

    // ── Step 5: zoom the plate — readout, tree, header, first row ──────────
    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    await waitFor(app, `document.querySelector('.pie-plate-readout')?.textContent.trim().length > 0`, 10_000);
    const readout = (await text(app, ".pie-plate-readout"))?.trim() ?? "";
    if (!/^HTML · \d+% · \d+ files?$/.test(readout)) {
      throw new Error(`expected the readout to match /^HTML · \\d+% · \\d+ files?$/, got ${JSON.stringify(readout)}`);
    }
    await waitFor(app, `document.querySelector('[data-testid="pie-layers"][role="tree"]') !== null`, 10_000);
    const headerSelector = '[data-testid="pie-layer-header"]';
    await waitFor(app, `document.querySelector(${JSON.stringify(headerSelector)}) !== null`, 10_000);
    const headerText = (await text(app, headerSelector))?.trim();
    if (headerText !== "pricing") {
      throw new Error(`expected the first layer header to read "pricing", got ${JSON.stringify(headerText)}`);
    }
    const firstRowSelector = '[role="treeitem"][aria-level="2"]';
    await waitFor(app, `document.querySelector(${JSON.stringify(firstRowSelector)}) !== null`, 10_000);
    const firstRowName = await text(app, `${firstRowSelector} .start-row-name`);
    if (firstRowName !== "pricing-v3.html") {
      throw new Error(`expected the first treeitem row's name to be pricing-v3.html, got ${JSON.stringify(firstRowName)}`);
    }
    const firstRowIsNew = await evalIn(
      app,
      `document.querySelector(${JSON.stringify(firstRowSelector)} + ' [data-testid="pie-row-new"]') !== null`,
    );
    if (!firstRowIsNew) throw new Error("expected the first treeitem row to carry the new-file marker");
    console.log(
      `ok: plate readout ${JSON.stringify(readout)}, tree role, header "${headerText}", ` +
        `first row "${firstRowName}" carries the new marker`,
    );

    // ── Step 6: close then reopen — the pill is gone (seen_at stamped),
    //     and persisted ─────────────────────────────────────────────────────
    await keys(app, "escape");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);
    await waitFor(app, `document.querySelector('${tileSelector} [data-testid="pie-fresh-pill"]') === null`, 10_000);
    const persisted = await waitForPersistedPies(
      stateDir,
      (d) => (d.pies?.find((p) => p.id === pricingId)?.seen_at ?? 0) > 0,
    );
    const seenAt = persisted.pies?.find((p) => p.id === pricingId)?.seen_at ?? 0;
    console.log(`ok: closing the plate cleared the pill; state.json's seen_at = ${seenAt} (> 0)`);

    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    const pillStillGone = await evalIn(
      app,
      `document.querySelector('${tileSelector} [data-testid="pie-fresh-pill"]') === null`,
    );
    if (!pillStillGone) throw new Error("expected the pill to stay gone on reopen");
    console.log("ok: reopening the plate keeps the pill gone");
    await keys(app, "escape");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);

    // ── Step 7: rename the folder on disk — "folder not found" with
    //     Locate…/Forget; Forget removes the layer ─────────────────────────
    const renamedFolder = path.join(fixture.dir, "pricing-renamed");
    fs.renameSync(subfolder, renamedFolder);
    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    await waitFor(
      app,
      `Array.from(document.querySelectorAll('[data-testid="pie-layer-header"]')).some(function(el){
        return el.textContent.indexOf("folder not found") !== -1;
      })`,
      15_000,
    );
    await waitFor(app, `document.querySelector('[data-testid="pie-locate"]') !== null`, 10_000);
    await waitFor(app, `document.querySelector('[data-testid="pie-forget"]') !== null`, 10_000);
    console.log('ok: renaming the folder on disk surfaced "folder not found" with Locate…/Forget');

    await click(app, '[data-testid="pie-forget"]');
    await waitFor(app, `document.querySelector('[data-testid="pie-layer-header"]') === null`, 10_000);
    console.log("ok: Forget removed the layer");

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
