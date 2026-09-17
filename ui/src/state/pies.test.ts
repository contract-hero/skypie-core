import { describe, expect, it } from "vitest";
import {
  bandOrder,
  holdsPath,
  isUserPieId,
  pieFiles,
  pickerPathPlan,
  pieHoldingPath,
  revealRoute,
  subtractPending,
  toDerivedPie,
  uniqueName,
  withPending,
  withoutPending,
} from "./pies";
import type { Pie, PieCensus } from "../ipc";
import type { DerivedPie } from "./derived-pies";

function pie(overrides: Partial<Pie> = {}): Pie {
  return {
    id: "0199-fixture",
    name: "Fixture",
    created_at: 0,
    seen_at: 0,
    members: [],
    ...overrides,
  };
}

describe("pieFiles / toDerivedPie", () => {
  it("adapts file members to DerivedPieFile, using added_at as mtime", () => {
    const p = pie({
      members: [
        { kind: "file", path: "/w/a.html", added_at: 1000 },
        { kind: "file", path: "/w/b.json", added_at: 2000 },
      ],
    });
    expect(pieFiles(p)).toEqual([
      { path: "/w/a.html", kind: "html", mtime: 1000 },
      { path: "/w/b.json", kind: "data", mtime: 2000 },
    ]);
  });

  it("drops folder members — no file list until the M3 census", () => {
    const p = pie({ members: [{ kind: "folder", path: "/w/dir", added_at: 1000 }] });
    expect(pieFiles(p)).toEqual([]);
  });

  it("toDerivedPie keeps id and name, adapting members to files", () => {
    const p = pie({ id: "abc", name: "Pricing", members: [{ kind: "file", path: "/w/a.md", added_at: 5 }] });
    expect(toDerivedPie(p)).toEqual({
      id: "abc",
      name: "Pricing",
      files: [{ path: "/w/a.md", kind: "md", mtime: 5 }],
    });
  });

  it("toDerivedPie's census branch replaces the added_at fallback files with the census's real files", () => {
    const p = pie({
      id: "abc",
      name: "Pricing",
      seen_at: 0,
      members: [{ kind: "file", path: "/w/a.md", added_at: 5 }],
    });
    const c: PieCensus = {
      files: [{ path: "/w/a.md", mtime: 999, size: 10 }],
      missing: [],
      outside_root: [],
      skipped: 0,
      truncated: false,
    };
    const derived = toDerivedPie(p, c);
    expect(derived.files).toEqual([{ path: "/w/a.md", kind: "md", mtime: 999, folder: undefined }]);
    expect(derived.census).toBe(c);
  });

  it("toDerivedPie's fresh follows the pie's seen_at", () => {
    const p = pie({
      id: "abc",
      name: "Pricing",
      seen_at: 500,
      members: [{ kind: "file", path: "/w/a.md", added_at: 0 }],
    });
    const c: PieCensus = {
      files: [
        { path: "/w/old.md", mtime: 100, size: 1 },
        { path: "/w/new.md", mtime: 900, size: 1 },
      ],
      missing: [],
      outside_root: [],
      skipped: 0,
      truncated: false,
    };
    const derived = toDerivedPie(p, c);
    expect(derived.fresh).toBe(1);
  });

  it("toDerivedPie: seen_at === 0 (never opened) yields fresh 0", () => {
    const p = pie({ id: "abc", name: "Pricing", seen_at: 0, members: [] });
    const c: PieCensus = {
      files: [{ path: "/w/a.md", mtime: 1_700_000_000_000, size: 1 }],
      missing: [],
      outside_root: [],
      skipped: 0,
      truncated: false,
    };
    const derived = toDerivedPie(p, c);
    expect(derived.fresh).toBe(0);
  });
});

describe("bandOrder with a census", () => {
  it("applies the census per id and leaves built-ins without a census-derived fresh", () => {
    const derived: DerivedPie[] = [
      { id: "builtin:pinned", name: "Pinned", files: [] },
      { id: "builtin:recent", name: "Recent", files: [] },
    ];
    const userPies = [pie({ id: "u1", name: "Pricing", seen_at: 0 })];
    const c: PieCensus = {
      files: [{ path: "/w/a.md", mtime: 1, size: 1 }],
      missing: [],
      outside_root: [],
      skipped: 0,
      truncated: false,
    };
    const order = bandOrder(derived, userPies, (p) => toDerivedPie(p, p.id === "u1" ? c : undefined));
    expect(order[0].fresh).toBeUndefined();
    expect(order[1].fresh).toBeUndefined();
    expect(order.find((p) => p.id === "u1")?.census).toBe(c);
  });

  it("calls `derive` exactly once per USER pie, and never for a built-in", () => {
    // `derive` is the memoized door onto the census cache
    // (`usePieCensus().derive`). Calling it twice for one pie would derive
    // the same pie twice per band render; calling it for a built-in would
    // try to census a pie that is not persisted at all.
    const derived: DerivedPie[] = [
      { id: "builtin:pinned", name: "Pinned", files: [] },
      { id: "builtin:recent", name: "Recent", files: [] },
    ];
    const userPies = [pie({ id: "u1", name: "Pricing" }), pie({ id: "u2", name: "Roadmap" })];
    const seen: string[] = [];
    bandOrder(derived, userPies, (p) => {
      seen.push(p.id);
      return toDerivedPie(p);
    });
    expect(seen).toEqual(["u1", "u2"]);
  });
});

describe("bandOrder", () => {
  it("puts built-ins first, then user pies in their given (stored) order", () => {
    const derived: DerivedPie[] = [
      { id: "builtin:pinned", name: "Pinned", files: [] },
      { id: "builtin:recent", name: "Recent", files: [] },
    ];
    const userPies = [pie({ id: "u1", name: "Pricing" }), pie({ id: "u2", name: "Roadmap" })];
    const order = bandOrder(derived, userPies, (p) => toDerivedPie(p)).map((p) => p.id);
    expect(order).toEqual(["builtin:pinned", "builtin:recent", "u1", "u2"]);
  });

  it("is a plain concatenation — it does not re-sort user pies", () => {
    const userPies = [pie({ id: "z" }), pie({ id: "a" })];
    const order = bandOrder([], userPies, (p) => toDerivedPie(p)).map((p) => p.id);
    expect(order).toEqual(["z", "a"]);
  });
});

describe("subtractPending — the delete-undo filter", () => {
  it("returns the SAME array when nothing is pending", () => {
    const pies = [pie({ id: "a" }), pie({ id: "b" })];
    expect(subtractPending(pies, new Set())).toBe(pies);
  });

  it("hides every pending id and keeps the rest in order", () => {
    const pies = [pie({ id: "a" }), pie({ id: "b" }), pie({ id: "c" })];
    expect(subtractPending(pies, new Set(["b"])).map((p) => p.id)).toEqual(["a", "c"]);
    expect(subtractPending(pies, new Set(["a", "c"])).map((p) => p.id)).toEqual(["b"]);
  });

  it("keeps a pie hidden in a list that arrived from an unrelated write", () => {
    // The bug this exists for: a `skypie://pies-updated` event during the
    // 5s undo window carries the server's document, which still holds the
    // deleted pie.
    const fromServer = [pie({ id: "a" }), pie({ id: "b" })];
    expect(subtractPending(fromServer, new Set(["b"])).map((p) => p.id)).toEqual(["a"]);
  });

  it("ignores a pending id that is not in the list", () => {
    const pies = [pie({ id: "a" })];
    expect(subtractPending(pies, new Set(["gone"])).map((p) => p.id)).toEqual(["a"]);
  });
});

describe("holdsPath", () => {
  it("is true when a member's path matches exactly", () => {
    const p = pie({ members: [{ kind: "file", path: "/w/a.md", added_at: 0 }] });
    expect(holdsPath(p, "/w/a.md")).toBe(true);
    expect(holdsPath(p, "/w/b.md")).toBe(false);
  });

  it("is true for a folder member's own path (not a file it contains)", () => {
    const p = pie({ members: [{ kind: "folder", path: "/w/dir", added_at: 0 }] });
    expect(holdsPath(p, "/w/dir")).toBe(true);
    expect(holdsPath(p, "/w/dir/inner.md")).toBe(false);
  });
});

describe("uniqueName", () => {
  it("returns the wanted name unchanged when nothing collides", () => {
    expect(uniqueName([pie({ name: "Roadmap" })], "Pricing")).toBe("Pricing");
  });

  it("appends ' 2' on a collision, then increments past further collisions", () => {
    const pies = [pie({ name: "Pricing" }), pie({ name: "Pricing 2" })];
    expect(uniqueName(pies, "Pricing")).toBe("Pricing 3");
  });

  it("trims the wanted name before comparing", () => {
    expect(uniqueName([pie({ name: "Pricing" })], "  Pricing  ")).toBe("Pricing 2");
  });
});

describe("isUserPieId", () => {
  it("is false for the fixed builtin ids and true for anything else", () => {
    expect(isUserPieId("builtin:pinned")).toBe(false);
    expect(isUserPieId("builtin:recent")).toBe(false);
    expect(isUserPieId("0199018c-fixture-uuid")).toBe(true);
  });
});

describe("withPending / withoutPending", () => {
  it("returns a new set rather than mutating the old one", () => {
    const empty: ReadonlySet<string> = new Set<string>();
    const one = withPending(empty, "a");
    expect(empty.has("a")).toBe(false);
    expect(one.has("a")).toBe(true);
  });

  it("keeps two overlapping deletes independent", () => {
    // Both pies are mid-undo; clearing one must not un-hide the other.
    let pending = withPending(withPending(new Set<string>(), "a"), "b");
    expect([...pending].sort()).toEqual(["a", "b"]);
    pending = withoutPending(pending, "a");
    expect([...pending]).toEqual(["b"]);
    expect(subtractPending([pie({ id: "a" }), pie({ id: "b" })], pending).map((p) => p.id)).toEqual([
      "a",
    ]);
  });

  it("removing an id that is not pending is a no-op", () => {
    const pending = withPending(new Set<string>(), "a");
    expect([...withoutPending(pending, "zzz")]).toEqual(["a"]);
  });
});

describe("pickerPathPlan", () => {
  const isRemote = (p: string) => p.startsWith("skypie-remote://");

  it("refuses a pulled file — M2 has no remote pie members", () => {
    const plan = pickerPathPlan("skypie-remote://node/x.md", true, isRemote);
    expect(plan.action).toBe("refuse");
    if (plan.action === "refuse") expect(plan.reason).toMatch(/pulled file/);
  });

  it("canonicalizes a local path when the command exists", () => {
    expect(pickerPathPlan("/tmp/x.md", true, isRemote)).toEqual({
      action: "canonicalize",
      path: "/tmp/x.md",
    });
  });

  it("opens uncanonicalized when the IPC surface has no canonicalizePath", () => {
    expect(pickerPathPlan("/tmp/x.md", false, isRemote)).toEqual({
      action: "open",
      path: "/tmp/x.md",
    });
  });
});

describe("holdsPath is an exact compare", () => {
  it("is false for a non-canonical form of a stored member", () => {
    // The stored member is always canonical (/private/var/... on macOS);
    // the /var form names the same file and must still answer false, which
    // is exactly why `openPicker` canonicalizes before the picker renders.
    const held = pie({
      members: [{ kind: "file", path: "/private/var/tmp/a.md", added_at: 1 }],
    });
    expect(holdsPath(held, "/private/var/tmp/a.md")).toBe(true);
    expect(holdsPath(held, "/var/tmp/a.md")).toBe(false);
  });
});

describe("pieHoldingPath", () => {
  it("finds the user pie whose files include the path exactly", () => {
    const pies: DerivedPie[] = [
      { id: "builtin:pinned", name: "Pinned", files: [{ path: "/w/a.md", kind: "md", mtime: 0 }] },
      { id: "u1", name: "Pricing", files: [{ path: "/w/b.html", kind: "html", mtime: 0 }] },
    ];
    expect(pieHoldingPath(pies, "/w/b.html")?.id).toBe("u1");
  });

  it("never matches a built-in pie even when its own files include the path", () => {
    const pies: DerivedPie[] = [
      { id: "builtin:pinned", name: "Pinned", files: [{ path: "/w/a.md", kind: "md", mtime: 0 }] },
    ];
    expect(pieHoldingPath(pies, "/w/a.md")).toBeNull();
  });

  it("returns null when no pie holds the path", () => {
    const pies: DerivedPie[] = [{ id: "u1", name: "Pricing", files: [] }];
    expect(pieHoldingPath(pies, "/w/missing.md")).toBeNull();
  });
});

describe("revealRoute", () => {
  const holder: DerivedPie[] = [{ id: "u1", name: "Pricing", files: [{ path: "/w/a.html", kind: "html", mtime: 0 }] }];

  it("reveals in the tree when the sidebar is visible and it's not reader mode", () => {
    expect(revealRoute(true, false, holder, "/w/a.html")).toBe("tree");
  });

  it("opens the plate when the sidebar is hidden and a user pie holds the path", () => {
    expect(revealRoute(false, false, holder, "/w/a.html")).toBe("plate");
  });

  it("shows the sidebar when the sidebar is hidden and no pie holds the path", () => {
    expect(revealRoute(false, false, holder, "/w/other.html")).toBe("show-sidebar");
  });

  it("treats reader mode as 'sidebar hidden' even when sidebarVisible is true", () => {
    expect(revealRoute(true, true, holder, "/w/a.html")).toBe("plate");
    expect(revealRoute(true, true, [], "/w/a.html")).toBe("show-sidebar");
  });
});
