import { describe, expect, it } from "vitest";
import { appBindings, IFRAME_DENIED, IFRAME_FORWARDABLE } from "./app-bindings";
import type { AppBindingActions, AppBindingFlags } from "./app-bindings";

/** Every action is the same no-op: this suite is about the TABLE, not about
 *  what a chord does. */
const noopActions: AppBindingActions = {
  openNewTab: () => {},
  closeActiveTab: () => {},
  reopenClosedTab: () => {},
  activateDelta: () => {},
  activateIndex: () => {},
  goBack: () => {},
  goForward: () => {},
  refreshActive: () => {},
  focusAddressBar: () => {},
  pickFile: () => {},
  toggleQuickOpen: () => {},
  copyDeviceLinkForActive: () => {},
  addActiveFileToPie: () => {},
  toggleSidebar: () => {},
  toggleSky: () => {},
  toggleReaderMode: () => {},
  toggleComments: () => {},
  toggleCommentTool: () => {},
  putCommentToolDown: () => {},
  leaveReaderMode: () => {},
  zoomBy: () => {},
  resetZoom: () => {},
};

/** All eight flag combinations — a chord that only exists on macOS, or only
 *  while reader mode or the comment tool is up, must be classified too. */
const allFlags: AppBindingFlags[] = [false, true].flatMap((isMacos) =>
  [false, true].flatMap((commentTool) =>
    [false, true].map((readerMode) => ({ isMacos, commentTool, readerMode })),
  ),
);

function combosFor(flags: AppBindingFlags): string[] {
  return appBindings(noopActions, flags, 0.1).map((b) => b.combo);
}

describe("IFRAME_FORWARDABLE coverage", () => {
  it("classifies every app chord as forwardable or explicitly denied", () => {
    for (const flags of allFlags) {
      for (const combo of combosFor(flags)) {
        const classified = IFRAME_FORWARDABLE.has(combo) || combo in IFRAME_DENIED;
        expect(classified, `${combo} is in neither IFRAME_FORWARDABLE nor IFRAME_DENIED`).toBe(true);
      }
    }
  });

  it("never lists the same chord as both forwardable and denied", () => {
    for (const combo of Object.keys(IFRAME_DENIED)) {
      expect(IFRAME_FORWARDABLE.has(combo), combo).toBe(false);
    }
  });

  it("keeps the dialog, focus and clipboard chords out of the forwardable set", () => {
    // Rendered artifact content can postMessage a `skypie:keydown` of any
    // shape, so these four are the ones that must never be honored.
    for (const combo of ["mod+o", "mod+p", "mod+l", "mod+shift+c"]) {
      expect(IFRAME_FORWARDABLE.has(combo), combo).toBe(false);
      expect(IFRAME_DENIED[combo], combo).toBeTruthy();
    }
  });

  it("every denied chord is a chord the app actually binds", () => {
    const bound = new Set(allFlags.flatMap(combosFor));
    for (const combo of Object.keys(IFRAME_DENIED)) {
      expect(bound.has(combo), `${combo} is denied but no longer bound`).toBe(true);
    }
  });
});

describe("appBindings", () => {
  it("binds the workspace chords on macOS only", () => {
    const mac = combosFor({ isMacos: true, commentTool: false, readerMode: false });
    const phone = combosFor({ isMacos: false, commentTool: false, readerMode: false });
    for (const combo of ["mod+o", "mod+p", "mod+shift+c", "mod+d"]) {
      expect(mac).toContain(combo);
      expect(phone).not.toContain(combo);
    }
  });

  it("binds Escape only while reader mode or the comment tool is on", () => {
    const off = combosFor({ isMacos: true, commentTool: false, readerMode: false });
    expect(off).not.toContain("escape");
    expect(combosFor({ isMacos: true, commentTool: true, readerMode: false })).toContain("escape");
    expect(combosFor({ isMacos: true, commentTool: false, readerMode: true })).toContain("escape");
  });

  it("binds no chord twice in one state", () => {
    for (const flags of allFlags) {
      const combos = combosFor(flags);
      // Escape is the deliberate exception: the comment tool's binding is
      // registered before reader mode's, and the registry runs the first
      // match, so the tool goes down first when both are on.
      const withoutEscape = combos.filter((c) => c !== "escape");
      expect(new Set(withoutEscape).size, JSON.stringify(flags)).toBe(withoutEscape.length);
    }
  });
});

describe("mod+d", () => {
  it("invokes addActiveFileToPie and nothing else", () => {
    // The pie picker's only keyboard entry point (spec section 2/6). A
    // binding table edit that pointed ⌘D at a neighbouring action would
    // otherwise still satisfy every coverage test above.
    const fired: string[] = [];
    const actions: AppBindingActions = Object.fromEntries(
      Object.keys(noopActions).map((name) => [name, () => fired.push(name)]),
    ) as unknown as AppBindingActions;
    const binding = appBindings(actions, { isMacos: true, commentTool: false, readerMode: false }, 0.1).find(
      (b) => b.combo === "mod+d",
    );
    expect(binding, "mod+d is bound on macOS").toBeDefined();
    binding?.handler({ key: "d", code: "KeyD", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    expect(fired).toEqual(["addActiveFileToPie"]);
  });
});
