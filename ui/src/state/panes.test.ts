import { describe, expect, it } from "vitest";
import { hydratePaneVisible } from "./panes";

describe("hydratePaneVisible", () => {
  it("applies the persisted value when the user has not toggled", () => {
    expect(hydratePaneVisible(true, false)).toBe(true);
    expect(hydratePaneVisible(false, false)).toBe(false);
  });

  it("leaves the pane alone once the user has toggled — the keypress wins the race", () => {
    expect(hydratePaneVisible(true, true)).toBeNull();
    expect(hydratePaneVisible(false, true)).toBeNull();
  });

  it("ignores a missing or non-boolean persisted value", () => {
    expect(hydratePaneVisible(undefined, false)).toBeNull();
    expect(hydratePaneVisible(null, false)).toBeNull();
    expect(hydratePaneVisible("true", false)).toBeNull();
    expect(hydratePaneVisible(1, false)).toBeNull();
  });
});
