// `pnpm -C ui e2e:m5` — M5's own acceptance checkpoint: a Claude Code
// session's own transport, `Req::AddToPie` over `app.sock`, adds a file it
// just wrote to "Pricing" WHILE the plate is open — the pill ticks, the row
// lands on top, and the write is not lost against a concurrent UI
// `touch_seen` — driven against the REAL debug macOS app. This harness
// speaks the exact same socket `crates/skypie-mcp` speaks (`lib/protocol.ts`'s
// `request()`), so the scenario below IS the agent path, not a stand-in for
// it. See ui/e2e/README.md.
//
// launchDesktop({ skipBuild: false }): M5 changed Rust (skypie-ipc's
// `Request::AddToPie`, app.rs's `add_to_pie_for`, ipc_server.rs's dispatch
// arm).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { click, evalIn, keys, launchDesktop, quit, waitFor } from "./lib/app";
import type { LaunchedApp } from "./lib/app";
import { cleanupFixtureWorkspace, makeFixtureWorkspace, setWorkspaceRoot } from "./lib/fixtureWorkspace";
import { request } from "./lib/protocol";

// ── Small helpers, repeated from m2/m3.e2e.ts rather than shared — this
//    directory's own convention (each scenario stays a single,
//    independently-readable file; ui/e2e/README.md). ──────────────────────

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

interface OnDiskMember {
  path: string;
  kind: string;
  source?: string;
  origin?: { session_id?: string; prompt_id?: string; cwd?: string };
}
interface OnDiskPies {
  pies?: {
    v?: number;
    pies?: { id: string; name: string; seen_at?: number; members: OnDiskMember[] }[];
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

async function pieCount(app: LaunchedApp): Promise<number> {
  return (await evalIn(app, `document.querySelectorAll('.sky-pies [data-pie-id]').length`)) as number;
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skypie-e2e-m5-state-"));
  const fixture = makeFixtureWorkspace("skypie-e2e-m5-");
  const root = fs.realpathSync(fixture.dir);
  console.log(`fixture workspace: ${fixture.dir}`);
  console.log(`scratch state dir: ${stateDir}`);

  let app: LaunchedApp = await launchDesktop({ stateDir, skipBuild: false });
  try {
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    await setWorkspaceRoot(app, root);

    // ── Setup: ⌘⇧B, create "Pricing" from the tin ──────────────────────────
    await keys(app, "mod+shift+b");
    await waitFor(app, `document.querySelector('.sky-band[role="listbox"][aria-label="Pies"]') !== null`, 10_000);
    await click(app, '[data-testid="sky-new-pie"]');
    await waitFor(app, `document.querySelector('input[data-testid="pie-name-input"]') !== null`, 10_000);
    await typeIntoInput(app, 'input[data-testid="pie-name-input"]', "Pricing");
    await keyOnActiveElement(app, "Enter");
    await waitFor(
      app,
      `Array.from(document.querySelectorAll(".sky-pies .sky-pie-label")).some(function(el){ return el.textContent === "Pricing"; })`,
      10_000,
    );
    const pricingId = (await evalIn(
      app,
      `(function(){
        var tiles = Array.from(document.querySelectorAll(".sky-pies [data-pie-id]"));
        var el = tiles.find(function(t){ return t.querySelector(".sky-pie-label")?.textContent === "Pricing"; });
        return el ? el.getAttribute("data-pie-id") : null;
      })()`,
    )) as string | null;
    if (!pricingId) throw new Error("expected a server-minted id for the new \"Pricing\" pie");
    const tileSelector = `[data-pie-id=${JSON.stringify(pricingId)}]`;
    console.log(`ok: created "Pricing" (id ${pricingId})`);

    // ── Establish a seen_at baseline BEFORE the file under test exists —
    //    PiePlate.tsx freezes `seenAtAtOpen` at the moment the plate MOUNTS
    //    (from whatever `pie.seen_at` already is at that first render), so
    //    a pie's very FIRST-ever open freezes it to 0 (the newly-created
    //    pie's `seen_at`) and the row's own "new" dot guard
    //    (`seenAtAtOpen > 0 && mtime > seenAtAtOpen`) would never fire no
    //    matter how fresh the file is. Opening once, waiting for the
    //    resulting `touch_seen` to land, then closing and reopening is what
    //    gives the LATER open a nonzero frozen baseline — the band pill
    //    (live `freshCount`) doesn't need this, but the plate row's dot
    //    does; both are checked below, and they read different values (M5
    //    brief's own pitfall note). ─────────────────────────────────────
    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    await waitForPersistedPies(stateDir, (d) => (d.pies?.find((p) => p.id === pricingId)?.seen_at ?? 0) > 0);
    await keys(app, "escape");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);
    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    console.log("ok: established a nonzero seen_at baseline, then reopened the plate fresh");

    // ── Checkpoint 1: the plate is open, aria-label names the pie ─────────
    const ariaLabel = await evalIn(
      app,
      `document.querySelector('[data-testid="pie-plate"]').getAttribute("aria-label")`,
    );
    if (ariaLabel !== "Pricing pie") {
      throw new Error(`expected the plate's aria-label to be "Pricing pie", got ${JSON.stringify(ariaLabel)}`);
    }
    console.log('ok: the plate is open, aria-label="Pricing pie"');

    // ── Checkpoint 2: write the file (mtime now + 2s, so a same-millisecond
    //     write can't lose the strict `mtime > seen_at`), then add_to_pie
    //     over app.sock with a full origin ─────────────────────────────────
    const newFile = path.join(root, "pricing-v3.html");
    fs.writeFileSync(newFile, "<!doctype html><title>Pricing v3</title><h1>Pricing v3</h1>\n");
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(newFile, future, future);
    const absNewFile = fs.realpathSync(newFile);

    const added = await request(app.connect, {
      op: "add_to_pie",
      pie: "Pricing",
      path: absNewFile,
      origin: { session_id: "e2e-session", prompt_id: "e2e-prompt", cwd: root },
    });
    if (
      added.status !== "ok" ||
      added.kind !== "added_to_pie" ||
      added.created !== false ||
      added.added !== true ||
      added.members !== 1
    ) {
      throw new Error(`unexpected add_to_pie reply: ${JSON.stringify(added)}`);
    }
    console.log(`ok: add_to_pie over app.sock replied ${JSON.stringify(added)}`);

    // ── Checkpoint 3: the plate is still open — the add did not close or
    //     remount it ──────────────────────────────────────────────────────
    const stillOpen = await evalIn(app, `document.querySelector('[data-testid="pie-plate"]') !== null`);
    if (!stillOpen) throw new Error("expected the plate to stay open across the add");
    console.log("ok: the plate stayed open across the add");

    // ── Checkpoint 4: within ~3s, the new file is the first (mtime-desc)
    //     row and carries the "new" dot ─────────────────────────────────────
    await waitFor(
      app,
      `document.querySelector('[data-testid="pie-layers"] .start-row')?.title === ${JSON.stringify(absNewFile)}`,
      5_000,
    );
    const firstRowIsNew = await evalIn(
      app,
      `document.querySelector('[data-testid="pie-layers"] .start-row [data-testid="pie-row-new"]') !== null`,
    );
    if (!firstRowIsNew) throw new Error("expected the first row to carry the new-file marker");
    console.log("ok: pricing-v3.html is the first row and carries the new-file marker, within 3s");

    // ── Checkpoint 5: the band pill reads +1 ────────────────────────────────
    await waitFor(
      app,
      `document.querySelector('[data-pie-id=${JSON.stringify(pricingId)}] [data-testid="pie-fresh-pill"]')?.textContent.trim() === "+1"`,
      5_000,
    );
    console.log("ok: the band pill reads +1");

    // ── Checkpoint 6: state.json converges to one agent member with a
    //     canonical path and the origin we sent ────────────────────────────
    const persisted = await waitForPersistedPies(stateDir, (d) => {
      const p = d.pies?.find((pp) => pp.id === pricingId);
      return !!p && p.members.length === 1;
    });
    const member = persisted.pies?.find((p) => p.id === pricingId)?.members[0];
    if (
      member?.path !== absNewFile ||
      member.source !== "agent" ||
      member.origin?.session_id !== "e2e-session" ||
      !member.origin?.cwd
    ) {
      throw new Error(`unexpected persisted member: ${JSON.stringify(member)}`);
    }
    console.log(`ok: state.json holds one agent member with origin ${JSON.stringify(member.origin)}`);

    // ── Checkpoint 7: no write lost — a real UI write (touch_seen, via
    //     reopening the plate) races two independent socket add_to_pie
    //     calls for two other fixture files, all in one tick; both survive
    //     (the same property pies.rs's own
    //     `add_member_and_touch_seen_interleave_without_losing_either_write`
    //     proves at the Rust level, exercised here through the real running
    //     app's IPC dispatch) ────────────────────────────────────────────
    const priorSeenAt = readStateJson(stateDir)?.pies?.pies?.find((p) => p.id === pricingId)?.seen_at ?? 0;
    // A same-id click while the plate is ALREADY open is a no-op in
    // Sky.tsx (`setOpenPieId` to the value it already holds never remounts
    // `PiePlate`, so its mount effect's `touch_seen` never refires) — close
    // it first so the reopening click below is a genuine new mount.
    await keys(app, "escape");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);

    const secondFile = fs.realpathSync(fixture.files.md);
    const thirdFile = fs.realpathSync(fixture.files.ts);
    await Promise.all([
      click(app, tileSelector),
      request(app.connect, { op: "add_to_pie", pie: pricingId, path: secondFile }),
      request(app.connect, { op: "add_to_pie", pie: pricingId, path: thirdFile }),
    ]);
    const converged = await waitForPersistedPies(stateDir, (d) => {
      const p = d.pies?.find((pp) => pp.id === pricingId);
      return !!p && p.members.length === 3 && (p.seen_at ?? 0) > priorSeenAt;
    });
    const convergedPie = converged.pies?.find((p) => p.id === pricingId);
    const convergedPaths = new Set(convergedPie?.members.map((m) => m.path));
    if (!convergedPaths.has(secondFile) || !convergedPaths.has(thirdFile)) {
      throw new Error(`expected both concurrent socket members to survive: ${JSON.stringify(convergedPie)}`);
    }
    console.log(
      `ok: no write lost — the UI's touch_seen (seen_at ${priorSeenAt} -> ${convergedPie?.seen_at}) and two ` +
        `concurrent socket add_to_pie calls all survived (now ${convergedPie?.members.length} members)`,
    );
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    await keys(app, "escape");
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') === null`, 10_000);

    // ── Checkpoint 8: an unknown pie NAME creates a new pie ────────────────
    const freshFile = path.join(root, "fresh-note.txt");
    fs.writeFileSync(freshFile, "a fresh note\n");
    const absFreshFile = fs.realpathSync(freshFile);
    const priorCount = await pieCount(app);
    const freshReply = await request(app.connect, { op: "add_to_pie", pie: "Fresh Pie", path: absFreshFile });
    if (freshReply.status !== "ok" || freshReply.created !== true) {
      throw new Error(`expected a freshly-created pie, got ${JSON.stringify(freshReply)}`);
    }
    await waitFor(app, `document.querySelectorAll('.sky-pies [data-pie-id]').length === ${priorCount + 1}`, 10_000);
    const freshTileLabel = await evalIn(
      app,
      `(function(){
        var tiles = Array.from(document.querySelectorAll(".sky-pies [data-pie-id]"));
        var el = tiles.find(function(t){ return t.querySelector(".sky-pie-label")?.textContent === "Fresh Pie"; });
        return el ? el.querySelector(".sky-pie-label").textContent : null;
      })()`,
    );
    if (freshTileLabel !== "Fresh Pie") {
      throw new Error(`expected a new tile labelled "Fresh Pie", got ${JSON.stringify(freshTileLabel)}`);
    }
    console.log('ok: an unknown pie name ("Fresh Pie") created a pie and its tile appeared');

    // ── Checkpoint 9: a missing path is an error naming the path, and the
    //     pie count is unchanged ────────────────────────────────────────────
    const missingPath = path.join(root, "does-not-exist.html");
    const countBeforeMissing = await pieCount(app);
    const missingReply = await request(app.connect, { op: "add_to_pie", pie: "Pricing", path: missingPath });
    if (missingReply.status !== "err" || typeof missingReply.message !== "string" || !missingReply.message.includes(missingPath)) {
      throw new Error(`expected an err naming ${missingPath}, got ${JSON.stringify(missingReply)}`);
    }
    const countAfterMissing = await pieCount(app);
    if (countAfterMissing !== countBeforeMissing) {
      throw new Error(`expected the pie count to stay ${countBeforeMissing}, got ${countAfterMissing}`);
    }
    console.log(`ok: a missing path answered status:"err" naming the path, and the pie count stayed ${countBeforeMissing}`);

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
