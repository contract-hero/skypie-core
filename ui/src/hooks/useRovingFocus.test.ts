import { describe, expect, it } from "vitest";
import { rovingTarget } from "./useRovingFocus";

describe("rovingTarget", () => {
  it("moves along the orientation's own two arrow keys", () => {
    expect(rovingTarget("ArrowRight", 0, 3, "horizontal")).toBe(1);
    expect(rovingTarget("ArrowLeft", 2, 3, "horizontal")).toBe(1);
    expect(rovingTarget("ArrowDown", 0, 3, "vertical")).toBe(1);
    expect(rovingTarget("ArrowUp", 2, 3, "vertical")).toBe(1);
  });

  it("ignores the other axis's arrows, so the page keeps its own scrolling", () => {
    expect(rovingTarget("ArrowDown", 0, 3, "horizontal")).toBeNull();
    expect(rovingTarget("ArrowUp", 1, 3, "horizontal")).toBeNull();
    expect(rovingTarget("ArrowRight", 0, 3, "vertical")).toBeNull();
    expect(rovingTarget("ArrowLeft", 1, 3, "vertical")).toBeNull();
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(rovingTarget("ArrowRight", 2, 3, "horizontal")).toBe(2);
    expect(rovingTarget("ArrowLeft", 0, 3, "horizontal")).toBe(0);
  });

  it("Home and End jump to the ends on either orientation", () => {
    expect(rovingTarget("Home", 2, 3, "horizontal")).toBe(0);
    expect(rovingTarget("End", 0, 3, "horizontal")).toBe(2);
    expect(rovingTarget("Home", 2, 3, "vertical")).toBe(0);
    expect(rovingTarget("End", 0, 3, "vertical")).toBe(2);
  });

  it("claims no other key — Enter and Escape stay the caller's to handle", () => {
    expect(rovingTarget("Enter", 0, 3, "horizontal")).toBeNull();
    expect(rovingTarget(" ", 0, 3, "horizontal")).toBeNull();
    expect(rovingTarget("Escape", 0, 3, "vertical")).toBeNull();
    expect(rovingTarget("Tab", 0, 3, "vertical")).toBeNull();
  });

  it("claims nothing at all for an empty list", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(rovingTarget(key, 0, 0, "horizontal")).toBeNull();
      expect(rovingTarget(key, 0, 0, "vertical")).toBeNull();
    }
  });

  it("clamps a stale focused index that is already past the end", () => {
    // The list shrank between the render that set the index and the keypress.
    expect(rovingTarget("ArrowRight", 9, 3, "horizontal")).toBe(2);
    expect(rovingTarget("ArrowLeft", 9, 3, "horizontal")).toBe(2);
  });

  it("a one-item list stays on its single item", () => {
    expect(rovingTarget("ArrowRight", 0, 1, "horizontal")).toBe(0);
    expect(rovingTarget("End", 0, 1, "horizontal")).toBe(0);
    expect(rovingTarget("Home", 0, 1, "horizontal")).toBe(0);
  });
});
