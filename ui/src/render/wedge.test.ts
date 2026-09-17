import { describe, expect, it } from "vitest";
import { CENTER, polar, RADIUS, wedgePath } from "./wedge";

/** The path commands as numbers, so an assertion can talk about coordinates
 *  instead of string formatting. */
function numbersIn(d: string): number[] {
  return (d.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number);
}

describe("polar", () => {
  it("puts 0° at north and 90° at east", () => {
    const [nx, ny] = polar(0);
    expect(nx).toBeCloseTo(CENTER, 6);
    expect(ny).toBeCloseTo(CENTER - RADIUS, 6);
    const [ex, ey] = polar(90);
    expect(ex).toBeCloseTo(CENTER + RADIUS, 6);
    expect(ey).toBeCloseTo(CENTER, 6);
  });

  it("turns clockwise: 180° is south, 270° is west", () => {
    const [sx, sy] = polar(180);
    expect(sx).toBeCloseTo(CENTER, 6);
    expect(sy).toBeCloseTo(CENTER + RADIUS, 6);
    const [wx, wy] = polar(270);
    expect(wx).toBeCloseTo(CENTER - RADIUS, 6);
    expect(wy).toBeCloseTo(CENTER, 6);
  });
});

describe("wedgePath", () => {
  it("draws a single-kind disc as two arcs, never one 360° arc", () => {
    const d = wedgePath(0, 360, true);
    const arcs = d.match(/A /g) ?? [];
    expect(arcs).toHaveLength(2);
    // No "L" to the centre: a full disc is a ring, not a pie slice.
    expect(d).not.toContain("L ");
    // Both arcs run between north and south (floating-point sin(π) leaves
    // the south x a hair off centre, so compare the numbers, not the text).
    expect(d.startsWith(`M ${CENTER},${CENTER - RADIUS}`)).toBe(true);
    const [, , , , , southX, southY] = numbersIn(d.split("A ")[1] ?? "");
    expect(southX).toBeCloseTo(CENTER, 6);
    expect(southY).toBeCloseTo(CENTER + RADIUS, 6);
  });

  it("draws a partial wedge from the centre with one arc", () => {
    const d = wedgePath(0, 90, false);
    expect(d.startsWith(`M ${CENTER},${CENTER} L`)).toBe(true);
    expect(d.match(/A /g) ?? []).toHaveLength(1);
    expect(d.endsWith(" Z")).toBe(true);
  });

  it("keeps largeArc at 0 up to 180° and flips it above", () => {
    // The flag is the 5th number after the two radii and the x-rotation in
    // the "A rx,ry rot largeArc sweep x,y" command.
    const flagOf = (sweep: number): number => {
      const arc = wedgePath(0, sweep, false).split("A ")[1] ?? "";
      const [, , , largeArc] = numbersIn(arc);
      return largeArc;
    };
    expect(flagOf(179)).toBe(0);
    expect(flagOf(180)).toBe(0);
    expect(flagOf(181)).toBe(1);
    expect(flagOf(359)).toBe(1);
  });

  it("chains cumulative start angles for [0.5, 0.25, 0.25]", () => {
    // The same accumulation Pie.tsx runs: each wedge starts where the last
    // one ended, so the shares tile the disc exactly once.
    const shares = [0.5, 0.25, 0.25];
    let angle = 0;
    const starts: number[] = [];
    for (const share of shares) {
      starts.push(angle);
      angle += share * 360;
    }
    expect(starts).toEqual([0, 180, 270]);
    expect(angle).toBe(360);

    // The first wedge's leading edge is north, the second's is south, the
    // third's is west — and the last one closes back on north.
    const edgeOf = (d: string): [number, number] => {
      const [, , x, y] = numbersIn(d);
      return [x, y];
    };
    const [x0, y0] = edgeOf(wedgePath(starts[0], shares[0] * 360, false));
    expect([x0, y0]).toEqual(polar(0));
    const [x1, y1] = edgeOf(wedgePath(starts[1], shares[1] * 360, false));
    expect(x1).toBeCloseTo(CENTER, 6);
    expect(y1).toBeCloseTo(CENTER + RADIUS, 6);
    const [x2, y2] = edgeOf(wedgePath(starts[2], shares[2] * 360, false));
    expect(x2).toBeCloseTo(CENTER - RADIUS, 6);
    expect(y2).toBeCloseTo(CENTER, 6);
  });
});
