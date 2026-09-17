// `pnpm -C ui e2e:m5` — M5's own acceptance checkpoint: a Claude Code
// session's own transport, `Request::AddToPie` over `app.sock`, adds a file it
// just wrote to "Pricing" WHILE the plate is open — the pill ticks, the row
// lands on top, and the write is not lost against a concurrent UI
// `touch_seen` — driven against the REAL debug macOS app. This harness
// speaks the exact same socket `crates/skypie-mcp` speaks (`lib/protocol.ts`'s
// `request()`), so the scenario below IS the agent path, not a stand-in for
// it. See ui/e2e/README.md.
//
// launchDesktop({ skipBuild: false }): M5 changed Rust (skypie-ipc's
// `Request::AddToPie`, app.rs's `add_to_pie_for`, ipc_server.rs's dispatch
// arm). The DOM-input and state.json helpers come from `lib/state`, shared
// with m2/m3; only the helpers this scenario alone needs live below.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { click, evalIn, keys, launchDesktop, quit, waitFor } from "./lib/app";
import type { LaunchedApp } from "./lib/app";
import { cleanupFixtureWorkspace, makeFixtureWorkspace, setWorkspaceRoot } from "./lib/fixtureWorkspace";
import { request } from "./lib/protocol";
import { keyOnActiveElement, typeIntoInput, waitForPersistedPies } from "./lib/state";

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

async function activeElementAttr(app: LaunchedApp, attr: string): Promise<string | null> {
  return (await evalIn(
    app,
    `document.activeElement ? document.activeElement.getAttribute(${JSON.stringify(attr)}) : null`,
  )) as string | null;
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

  // Inside the try, and nullable: launched BEFORE it, a failing
  // `launchDesktop` — this scenario builds Rust — skips the `finally`
  // entirely and leaks both temp trees. Same shape m1/m2/m3/m4 use.
  let app: LaunchedApp | null = null;
  try {
    app = await launchDesktop({ stateDir, skipBuild: false });
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

    // ── Open the plate, once — the literal brief order: create "Pricing",
    //    click the tile, then write + add. PiePlate.tsx freezes
    //    `seenAtAtOpen` at mount from `rawPie.seen_at || rawPie.created_at`,
    //    so a pie's very FIRST-ever open already has a nonzero baseline
    //    (the pie's own `created_at`) — no open/close/reopen preamble is
    //    needed to get a working "new" dot on checkpoint 4 below. ────────
    await click(app, tileSelector);
    await waitFor(app, `document.querySelector('[data-testid="pie-plate"]') !== null`, 10_000);
    console.log('ok: opened the "Pricing" plate');

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
    if (added.status !== "ok" || added.kind !== "added_to_pie") {
      throw new Error(`unexpected add_to_pie reply: ${JSON.stringify(added)}`);
    }
    if (added.created !== false || added.added !== true || added.members !== 1) {
      throw new Error(`unexpected add_to_pie reply: ${JSON.stringify(added)}`);
    }
    console.log(`ok: add_to_pie over app.sock replied ${JSON.stringify(added)}`);

    // ── Checkpoint 2b: re-sending the IDENTICAL request is idempotent and
    //     reports it — the brief's own "an existing member is left
    //     untouched (report `added: false`)" outcome ────────────────────────
    const reAdded = await request(app.connect, {
      op: "add_to_pie",
      pie: "Pricing",
      path: absNewFile,
      origin: { session_id: "e2e-session", prompt_id: "e2e-prompt", cwd: root },
    });
    if (reAdded.status !== "ok" || reAdded.kind !== "added_to_pie") {
      throw new Error(`unexpected re-add reply: ${JSON.stringify(reAdded)}`);
    }
    if (reAdded.created !== false || reAdded.added !== false || reAdded.members !== 1) {
      throw new Error(`expected an idempotent re-add (added: false, members: 1), got ${JSON.stringify(reAdded)}`);
    }
    console.log(`ok: re-adding the same path is idempotent, replied ${JSON.stringify(reAdded)}`);

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

    // The dot itself is `aria-hidden` — the row's accessible name (built
    // from its own text content, no `aria-label`) must still carry a
    // "new" marker a screen reader actually announces.
    const firstRowText = await evalIn(
      app,
      `document.querySelector('[data-testid="pie-layers"] .start-row')?.textContent ?? null`,
    );
    if (typeof firstRowText !== "string" || !firstRowText.trim().endsWith("— new")) {
      throw new Error(`expected the new row's accessible text to end with "— new", got ${JSON.stringify(firstRowText)}`);
    }
    console.log("ok: the new row's accessible name (text content) ends with \"— new\"");

    // ── Checkpoint 5: the band pill reads +1 ────────────────────────────────
    await waitFor(
      app,
      `document.querySelector('[data-pie-id=${JSON.stringify(pricingId)}] [data-testid="pie-fresh-pill"]')?.textContent.trim() === "+1"`,
      5_000,
    );
    console.log("ok: the band pill reads +1");

    // The pill itself is `aria-hidden` by design (Pie.tsx) — the only
    // accessible signal of the same outcome is the tile's own `aria-label`,
    // which folds the count in. Assistive tech never reads the pill, so
    // this is the assertion that actually matters for a screen-reader user.
    const tileAriaLabel = await evalIn(
      app,
      `document.querySelector('[data-pie-id=${JSON.stringify(pricingId)}]').getAttribute("aria-label")`,
    );
    if (typeof tileAriaLabel !== "string" || !tileAriaLabel.endsWith("— 1 new file")) {
      throw new Error(`expected the tile's aria-label to end with "— 1 new file", got ${JSON.stringify(tileAriaLabel)}`);
    }
    console.log(`ok: the tile's aria-label reports the new file too: ${JSON.stringify(tileAriaLabel)}`);

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
    // Reuses `persisted` from checkpoint 6 (already a SETTLED read, pinned
    // by `waitForPersistedPies`'s own predicate) rather than a fresh
    // `readStateJson` here — a fresh read races the debounced writer with
    // no predicate to wait on, so it could still catch the FIRST open's
    // `touch_seen` before it flushes and hand back a stale baseline that
    // the "no write lost" assertion below would then satisfy for free.
    const priorSeenAt = persisted.pies?.find((p) => p.id === pricingId)?.seen_at ?? 0;
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
    if (freshReply.status !== "ok" || freshReply.kind !== "added_to_pie" || !freshReply.created) {
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

    // ── Checkpoint 9b: a missing path with an UNKNOWN pie name still errors
    //     and leaves no orphan pie behind — checkpoint 9 above only ever
    //     named an EXISTING pie ("Pricing"), so it could not tell whether
    //     `add_to_pie_for` really stats the path BEFORE touching the pies
    //     document (app.rs: `canonicalize` runs ahead of `pies::add_to_pie`)
    //     or would leave a pie named "Orphan Pie" behind for a path that
    //     was never written ────────────────────────────────────────────────
    const countBeforeOrphan = await pieCount(app);
    const orphanReply = await request(app.connect, { op: "add_to_pie", pie: "Orphan Pie", path: missingPath });
    if (orphanReply.status !== "err" || typeof orphanReply.message !== "string" || !orphanReply.message.includes(missingPath)) {
      throw new Error(`expected an err naming ${missingPath}, got ${JSON.stringify(orphanReply)}`);
    }
    const countAfterOrphan = await pieCount(app);
    if (countAfterOrphan !== countBeforeOrphan) {
      throw new Error(`expected the pie count to stay ${countBeforeOrphan}, got ${countAfterOrphan}`);
    }
    const orphanTileExists = await evalIn(
      app,
      `Array.from(document.querySelectorAll(".sky-pies .sky-pie-label")).some(function(el){ return el.textContent === "Orphan Pie"; })`,
    );
    if (orphanTileExists) throw new Error('expected no "Orphan Pie" tile to appear for a path that was never written');
    console.log(`ok: a missing path with an unknown pie name left no orphan pie behind (count stayed ${countBeforeOrphan})`);

    // ── Checkpoint 10: an `add_to_pie` that mints a pie while the tin holds
    //     keyboard focus must not desync the band's roving tabindex from
    //     real DOM focus: focus the tin (End),
    //     let a socket add insert a pie ahead of it, then confirm exactly
    //     ONE option is both `tabindex="0"` and the live
    //     `document.activeElement`, and that it is STILL the tin ─────────
    await focusSelector(app, tileSelector);
    await keyOnActiveElement(app, "End");
    let activeTestId = await activeElementAttr(app, "data-testid");
    if (activeTestId !== "sky-new-pie") {
      throw new Error(`End: expected DOM focus on the tin, got ${JSON.stringify(activeTestId)}`);
    }
    const raceFile = path.join(root, "race-note.txt");
    fs.writeFileSync(raceFile, "a racing note\n");
    const absRaceFile = fs.realpathSync(raceFile);
    const priorTileCount = await pieCount(app);
    const raceReply = await request(app.connect, { op: "add_to_pie", pie: "Race Pie", path: absRaceFile });
    if (raceReply.status !== "ok" || raceReply.kind !== "added_to_pie" || !raceReply.created) {
      throw new Error(`expected a freshly-created pie, got ${JSON.stringify(raceReply)}`);
    }
    await waitFor(app, `document.querySelectorAll('.sky-pies [data-pie-id]').length === ${priorTileCount + 1}`, 10_000);
    const tabbableCount = await evalIn(
      app,
      `document.querySelectorAll('.sky-band [role="option"][tabindex="0"]').length`,
    );
    if (tabbableCount !== 1) {
      throw new Error(`expected exactly one roving-tabindex option, found ${tabbableCount}`);
    }
    activeTestId = await activeElementAttr(app, "data-testid");
    const activeIsSoleTabbable = await evalIn(
      app,
      `document.activeElement === document.querySelector('.sky-band [role="option"][tabindex="0"]')`,
    );
    if (!activeIsSoleTabbable || activeTestId !== "sky-new-pie") {
      throw new Error(
        `expected DOM focus to stay on the tin after the race-y insert, got activeTestId=${JSON.stringify(
          activeTestId,
        )} activeIsSoleTabbable=${JSON.stringify(activeIsSoleTabbable)}`,
      );
    }
    console.log("ok: an add_to_pie that inserts a pie while the tin is focused does not desync the roving tabindex");

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
