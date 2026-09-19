import { describe, expect, it } from "vitest";
import { clampFocus, rangeOfCount, rovingTarget } from "./useRovingFocus";

describe("rovingTarget", () => {
  it("moves along the orientation's own two arrow keys", () => {
    expect(rovingTarget("ArrowRight", 0, rangeOfCount(3), "horizontal")).toBe(1);
    expect(rovingTarget("ArrowLeft", 2, rangeOfCount(3), "horizontal")).toBe(1);
    expect(rovingTarget("ArrowDown", 0, rangeOfCount(3), "vertical")).toBe(1);
    expect(rovingTarget("ArrowUp", 2, rangeOfCount(3), "vertical")).toBe(1);
  });

  it("ignores the other axis's arrows, so the page keeps its own scrolling", () => {
    expect(rovingTarget("ArrowDown", 0, rangeOfCount(3), "horizontal")).toBeNull();
    expect(rovingTarget("ArrowUp", 1, rangeOfCount(3), "horizontal")).toBeNull();
    expect(rovingTarget("ArrowRight", 0, rangeOfCount(3), "vertical")).toBeNull();
    expect(rovingTarget("ArrowLeft", 1, rangeOfCount(3), "vertical")).toBeNull();
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(rovingTarget("ArrowRight", 2, rangeOfCount(3), "horizontal")).toBe(2);
    expect(rovingTarget("ArrowLeft", 0, rangeOfCount(3), "horizontal")).toBe(0);
  });

  it("Home and End jump to the ends on either orientation", () => {
    expect(rovingTarget("Home", 2, rangeOfCount(3), "horizontal")).toBe(0);
    expect(rovingTarget("End", 0, rangeOfCount(3), "horizontal")).toBe(2);
    expect(rovingTarget("Home", 2, rangeOfCount(3), "vertical")).toBe(0);
    expect(rovingTarget("End", 0, rangeOfCount(3), "vertical")).toBe(2);
  });

  it("claims no other key — Enter and Escape stay the caller's to handle", () => {
    expect(rovingTarget("Enter", 0, rangeOfCount(3), "horizontal")).toBeNull();
    expect(rovingTarget(" ", 0, rangeOfCount(3), "horizontal")).toBeNull();
    expect(rovingTarget("Escape", 0, rangeOfCount(3), "vertical")).toBeNull();
    expect(rovingTarget("Tab", 0, rangeOfCount(3), "vertical")).toBeNull();
  });

  it("claims nothing at all for an empty list", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(rovingTarget(key, 0, rangeOfCount(0), "horizontal")).toBeNull();
      expect(rovingTarget(key, 0, rangeOfCount(0), "vertical")).toBeNull();
    }
  });

  it("clamps a stale focused index that is already past the end", () => {
    // The list shrank between the render that set the index and the keypress.
    expect(rovingTarget("ArrowRight", 9, rangeOfCount(3), "horizontal")).toBe(2);
    expect(rovingTarget("ArrowLeft", 9, rangeOfCount(3), "horizontal")).toBe(2);
  });

  it("a one-item list stays on its single item", () => {
    expect(rovingTarget("ArrowRight", 0, rangeOfCount(1), "horizontal")).toBe(0);
    expect(rovingTarget("End", 0, rangeOfCount(1), "horizontal")).toBe(0);
    expect(rovingTarget("Home", 0, rangeOfCount(1), "horizontal")).toBe(0);
  });

  it("honours a range whose min is below 0 — Sky/PiePlate's tin slot", () => {
    // The tin sits one step before the first pie, reachable by the same
    // arrows; a bare count cannot describe that span.
    const withTin = { min: -1, max: 2 };
    expect(rovingTarget("ArrowLeft", 0, withTin, "horizontal")).toBe(-1);
    expect(rovingTarget("ArrowLeft", -1, withTin, "horizontal")).toBe(-1);
    expect(rovingTarget("Home", 2, withTin, "horizontal")).toBe(-1);
    expect(rovingTarget("End", -1, withTin, "horizontal")).toBe(2);
  });
});

describe("clampFocus", () => {
  it("leaves an index the list still holds alone", () => {
    expect(clampFocus(0, 3)).toBe(0);
    expect(clampFocus(2, 3)).toBe(2);
  });

  it("pulls a stale index back to the last item after the list shrank", () => {
    expect(clampFocus(9, 3)).toBe(2);
  });

  it("answers 0 for an empty list — there is no item to put in the tab order", () => {
    expect(clampFocus(3, 0)).toBe(0);
    expect(clampFocus(0, 0)).toBe(0);
  });
});
