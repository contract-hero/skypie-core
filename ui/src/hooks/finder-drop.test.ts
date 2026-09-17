// finder-drop.test.ts — vitest over the PURE half of useFinderDrop.ts only
// (this project's vitest run has no jsdom and no testing-library, so the
// React half — the actual Tauri subscription — is exercised end to end
// instead, by ui/e2e/m4.e2e.ts against the real app).
import { describe, expect, it } from "vitest";
import {
  FALLBACK_DROP_PIE_NAME,
  dropPieName,
  hitTestPieId,
  nextOverState,
  sameDropTarget,
} from "./useFinderDrop";
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
    expect(hitTestPieId(doc, 200, 100, 2)).toEqual({ kind: "pie", id: "builtin:pinned" });
  });

  it("resolves a hit on any descendant of the tile (disc SVG, freshness pill span, ...) to the owning tile's id", () => {
    // `closest()` on any descendant of the tile bubbles to the same match —
    // this fixture stands in for `elementFromPoint` returning the <svg>
    // or the pill <span> rather than the <button data-pie-id> that wraps
    // it. `tile()`'s stub `closest()` ignores which element it was called
    // on, so a second fixture asserting the identical inputs/outputs (one
    // per descendant) would not exercise any different code path — one
    // case stands for all of them (review finding on this test).
    const doc = docAt(10, 10, tile({ "data-pie-id": "0199-fixture" }));
    expect(hitTestPieId(doc, 10, 10, 1)).toEqual({ kind: "pie", id: "0199-fixture" });
  });

  it("returns the tin target for a match carrying data-pie-tin instead of data-pie-id", () => {
    const doc = docAt(10, 10, tile({ "data-pie-tin": "true" }));
    expect(hitTestPieId(doc, 10, 10, 1)).toEqual({ kind: "tin" });
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

describe("dropPieName degenerate inputs", () => {
  it("falls back to a non-empty name for an empty drop", () => {
    // A pie whose name is "" renders as a blank label nothing can be typed
    // over — the fallback is pinned rather than left to produce one.
    expect(dropPieName([])).toBe(FALLBACK_DROP_PIE_NAME);
  });

  it("names a folder dropped with a trailing slash after the folder itself", () => {
    // POSIX basename of "/Users/x/ideas/" is the empty string.
    expect(dropPieName(["/Users/x/ideas/"])).toBe("ideas");
    expect(dropPieName(["/Users/x/ideas///"])).toBe("ideas");
  });

  it("falls back when the path is nothing but slashes", () => {
    expect(dropPieName(["/"])).toBe(FALLBACK_DROP_PIE_NAME);
    expect(dropPieName([""])).toBe(FALLBACK_DROP_PIE_NAME);
  });
});

describe("sameDropTarget", () => {
  it("compares by VALUE — each hit test mints a fresh object", () => {
    expect(sameDropTarget({ kind: "pie", id: "u1" }, { kind: "pie", id: "u1" })).toBe(true);
    expect(sameDropTarget({ kind: "pie", id: "u1" }, { kind: "pie", id: "u2" })).toBe(false);
    expect(sameDropTarget({ kind: "tin" }, { kind: "tin" })).toBe(true);
    expect(sameDropTarget({ kind: "tin" }, { kind: "pie", id: "tin" })).toBe(false);
    expect(sameDropTarget(null, null)).toBe(true);
    expect(sameDropTarget(null, { kind: "tin" })).toBe(false);
  });
});

describe("nextOverState", () => {
  it("hit-tests the first over of a drag", () => {
    expect(nextOverState(null, { x: 10, y: 20, dpr: 2 })).toEqual({
      hitTest: true,
      last: { x: 10, y: 20, dpr: 2 },
    });
  });

  it("skips an over at the same physical point under the same ratio", () => {
    const last = { x: 10, y: 20, dpr: 2 };
    expect(nextOverState(last, { x: 10, y: 20, dpr: 2 }).hitTest).toBe(false);
  });

  it("hit-tests again when the pointer moves", () => {
    const last = { x: 10, y: 20, dpr: 2 };
    expect(nextOverState(last, { x: 11, y: 20, dpr: 2 }).hitTest).toBe(true);
    expect(nextOverState(last, { x: 10, y: 21, dpr: 2 }).hitTest).toBe(true);
  });

  it("hit-tests again when only the device pixel ratio changed", () => {
    // A window dragged to a different-DPI display mid-drag with the pointer
    // completely still: the PHYSICAL point is unchanged, but it now lands on
    // a different CSS pixel, so the ring would otherwise stay on the tile
    // computed for the old ratio.
    const last = { x: 200, y: 100, dpr: 2 };
    expect(nextOverState(last, { x: 200, y: 100, dpr: 1 }).hitTest).toBe(true);
  });

  it("always returns the new position as the one to remember", () => {
    const last = { x: 10, y: 20, dpr: 2 };
    expect(nextOverState(last, { x: 10, y: 20, dpr: 2 }).last).toEqual(last);
    expect(nextOverState(last, { x: 33, y: 44, dpr: 1 }).last).toEqual({ x: 33, y: 44, dpr: 1 });
  });
});
