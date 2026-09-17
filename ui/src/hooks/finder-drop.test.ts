// finder-drop.test.ts — vitest over the PURE half of useFinderDrop.ts only
// (this project's vitest run has no jsdom and no testing-library, so the
// React half — the actual Tauri subscription — is exercised end to end
// instead, by ui/e2e/m4.e2e.ts against the real app).
import { describe, expect, it } from "vitest";
import { dropPieName, hitTestPieId, TIN_DROP_ID } from "./useFinderDrop";
import type { HitTestDocument, HitTestElement } from "./useFinderDrop";

/** A document stub whose `elementFromPoint` only answers for ONE exact
 *  (x, y) pair — anything else is a miss (`null`), which is also how a
 *  real `elementFromPoint` behaves for a point with nothing under it. */
function docAt(x: number, y: number, hit: HitTestElement | null): HitTestDocument {
  return {
    elementFromPoint(px, py) {
      return px === x && py === y ? hit : null;
    },
  };
}

/** A fake DOM node whose `closest()` resolves straight to the tile it
 *  "belongs to" — standing in for a real `Element.closest()` bubbling up
 *  from some descendant (a wedge path, the freshness pill span) to the
 *  tile carrying `[data-pie-id]`/`[data-pie-tin]`. One fixture covers both
 *  "the tile itself was hit" and "a child of the tile was hit": a real
 *  `closest()` call on the tile element itself also just returns the tile. */
function tile(attrs: Record<string, string>): HitTestElement {
  return {
    closest: (selector) =>
      selector === "[data-pie-id],[data-pie-tin]" ? { getAttribute: (n) => attrs[n] ?? null } : null,
  };
}

describe("hitTestPieId", () => {
  it("divides physical pixels by the device pixel ratio before hit-testing", () => {
    // Physical (200, 100) at dpr 2 → CSS (100, 50) is where the stub
    // actually has something.
    const doc = docAt(100, 50, tile({ "data-pie-id": "builtin:pinned" }));
    expect(hitTestPieId(doc, 200, 100, 2)).toBe("builtin:pinned");
  });

  it("resolves a hit on any descendant of the tile (disc SVG, freshness pill span, ...) to the owning tile's id", () => {
    // `closest()` on any descendant of the tile bubbles to the same match —
    // this fixture stands in for `elementFromPoint` returning the <svg>
    // or the pill <span> rather than the <button data-pie-id> that wraps
    // it. `tile()`'s stub `closest()` ignores which element it was called
    // on, so a second fixture asserting the identical inputs/outputs (one
    // per descendant) would not exercise any different code path — one
    // case stands for all of them (review: finder-drop.test.ts:49).
    const doc = docAt(10, 10, tile({ "data-pie-id": "0199-fixture" }));
    expect(hitTestPieId(doc, 10, 10, 1)).toBe("0199-fixture");
  });

  it("returns TIN_DROP_ID for a match carrying data-pie-tin instead of data-pie-id", () => {
    const doc = docAt(10, 10, tile({ "data-pie-tin": "true" }));
    expect(hitTestPieId(doc, 10, 10, 1)).toBe(TIN_DROP_ID);
  });

  it("returns null when elementFromPoint finds nothing", () => {
    const doc = docAt(10, 10, null);
    expect(hitTestPieId(doc, 999, 999, 1)).toBeNull();
  });

  it("returns null when the hit element has no [data-pie-id]/[data-pie-tin] ancestor", () => {
    const doc = docAt(10, 10, { closest: () => null });
    expect(hitTestPieId(doc, 10, 10, 1)).toBeNull();
  });
});

describe("dropPieName", () => {
  it("is the basename of the first dropped path", () => {
    expect(dropPieName(["/Users/x/ideas/pricing"])).toBe("pricing");
    expect(dropPieName(["/Users/x/notes/report.html", "/Users/x/notes/other.md"])).toBe("report.html");
  });
});
