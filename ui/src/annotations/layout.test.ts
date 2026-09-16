import { describe, expect, it } from "vitest";
import { layoutNotes } from "./layout";

const box = (id: string, anchorTop: number, height = 40) => ({ id, anchorTop, height });

describe("layoutNotes", () => {
  it("leaves cards that do not collide at their anchors", () => {
    const got = layoutNotes([box("a", 10), box("b", 200)], null);
    expect(got.get("a")).toBe(10);
    expect(got.get("b")).toBe(200);
  });

  it("pushes a colliding card down, keeping the gap", () => {
    const got = layoutNotes([box("a", 10), box("b", 20)], null, { gap: 8 });
    expect(got.get("a")).toBe(10);
    expect(got.get("b")).toBe(10 + 40 + 8);
  });

  it("orders by anchor, then by input order", () => {
    const got = layoutNotes([box("late", 100), box("early", 0), box("late2", 100)], null);
    expect(got.get("early")).toBe(0);
    expect(got.get("late")).toBe(100);
    expect(got.get("late2")).toBe(148);
  });

  it("keeps the active card level with its anchor and moves the others up", () => {
    const got = layoutNotes([box("a", 100), box("b", 110), box("c", 120)], "c");
    expect(got.get("c")).toBe(120);
    expect(got.get("b")).toBe(120 - 8 - 40);
    expect(got.get("a")).toBe(120 - 8 - 40 - 8 - 40);
  });

  it("never places a card above minTop, even for the active one", () => {
    const got = layoutNotes([box("a", 0), box("b", 10), box("c", 20)], "c", { minTop: 0 });
    expect(got.get("a")).toBe(0);
    expect(got.get("b")).toBe(48);
    expect(got.get("c")).toBe(96);
  });

  it("does not move cards below the active one when it takes its anchor back", () => {
    const got = layoutNotes([box("a", 100), box("b", 110), box("d", 400)], "b");
    expect(got.get("b")).toBe(110);
    expect(got.get("d")).toBe(400);
  });

  it("handles an empty set", () => {
    expect(layoutNotes([], null).size).toBe(0);
  });

  // The suite reached pass 3 only with the active card LAST, so the tail was
  // never laid out after that pass — which is exactly the loop that was
  // removed as inert. These two pin the tail so the claim stays checked.
  it("leaves the tail alone when the active card is pushed back off the top", () => {
    const got = layoutNotes(
      [box("a", -100), box("b", -95), box("c", -90), box("d", 152)],
      "c",
      { gap: 8, minTop: 8 },
    );
    expect(got.get("a")).toBe(8);
    expect(got.get("b")).toBe(56);
    expect(got.get("c")).toBe(104);
    // Sits exactly on the recomputed floor: the boundary the removal claims.
    expect(got.get("d")).toBe(152);
  });

  it("never overlaps and never rises above minTop, over random layouts", () => {
    let seed = 42;
    const rand = (n: number): number => {
      // Deterministic: a failure has to be reproducible from the source.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 5000; round++) {
      const count = 1 + rand(6);
      const boxes = Array.from({ length: count }, (_, i) => ({
        id: `b${i}`,
        anchorTop: rand(600) - 300,
        height: rand(120),
      }));
      const gap = rand(20);
      const minTop = rand(30);
      const ids: (string | null)[] = [null, ...boxes.map((b) => b.id)];
      const activeId = ids[rand(ids.length)];
      const got = layoutNotes(boxes, activeId, { gap, minTop });

      const order = boxes
        .map((b, i) => ({ ...b, i }))
        .sort((a, b) => a.anchorTop - b.anchorTop || a.i - b.i);
      for (let i = 0; i < order.length; i++) {
        const top = got.get(order[i].id) as number;
        expect(top).toBeGreaterThanOrEqual(minTop);
        if (i + 1 < order.length) {
          const next = got.get(order[i + 1].id) as number;
          expect(next).toBeGreaterThanOrEqual(top + order[i].height + gap);
        }
      }
    }
  });
});
