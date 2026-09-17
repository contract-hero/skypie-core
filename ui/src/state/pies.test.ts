import { describe, expect, it } from "vitest";
import {
  bandOrder,
  holdsPath,
  insertPieAt,
  isUserPieId,
  pieFiles,
  toDerivedPie,
  uniqueName,
  withoutPie,
} from "./pies";
import type { Pie } from "../ipc";
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
});

describe("bandOrder", () => {
  it("puts built-ins first, then user pies in their given (stored) order", () => {
    const derived: DerivedPie[] = [
      { id: "builtin:pinned", name: "Pinned", files: [] },
      { id: "builtin:recent", name: "Recent", files: [] },
    ];
    const userPies = [pie({ id: "u1", name: "Pricing" }), pie({ id: "u2", name: "Roadmap" })];
    const order = bandOrder(derived, userPies).map((p) => p.id);
    expect(order).toEqual(["builtin:pinned", "builtin:recent", "u1", "u2"]);
  });

  it("is a plain concatenation — it does not re-sort user pies", () => {
    const userPies = [pie({ id: "z" }), pie({ id: "a" })];
    const order = bandOrder([], userPies).map((p) => p.id);
    expect(order).toEqual(["z", "a"]);
  });
});

describe("withoutPie / insertPieAt — the undo pair", () => {
  it("withoutPie removes exactly the named id", () => {
    const pies = [pie({ id: "a" }), pie({ id: "b" }), pie({ id: "c" })];
    expect(withoutPie(pies, "b").map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("insertPieAt restores a removed pie at its original index", () => {
    const pies = [pie({ id: "a" }), pie({ id: "c" })];
    const removed = pie({ id: "b" });
    expect(insertPieAt(pies, removed, 1).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("round-trips: insertPieAt(withoutPie(pies, id), pie, index) reconstructs the original order", () => {
    const pies = [pie({ id: "a" }), pie({ id: "b" }), pie({ id: "c" }), pie({ id: "d" })];
    const index = pies.findIndex((p) => p.id === "c");
    const removedPie = pies[index];
    const after = withoutPie(pies, "c");
    const restored = insertPieAt(after, removedPie, index);
    expect(restored.map((p) => p.id)).toEqual(pies.map((p) => p.id));
  });

  it("insertPieAt clamps an out-of-range index instead of throwing", () => {
    const pies = [pie({ id: "a" })];
    expect(insertPieAt(pies, pie({ id: "b" }), 99).map((p) => p.id)).toEqual(["a", "b"]);
    expect(insertPieAt(pies, pie({ id: "c" }), -5).map((p) => p.id)).toEqual(["c", "a"]);
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
