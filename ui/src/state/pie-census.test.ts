import { describe, expect, it } from "vitest";
import {
  affectsPie,
  censusToFiles,
  freshCount,
  layersOf,
  newestPath,
  sameMembers,
} from "./pie-census";
import type { PieLayer } from "./pie-census";
import type { PieCensus, PieMember } from "../ipc";
import type { DerivedPieFile } from "./derived-pies";
import type { FsChange } from "./watcher-bus";

function census(overrides: Partial<PieCensus> = {}): PieCensus {
  return {
    files: [],
    missing: [],
    outside_root: [],
    skipped: 0,
    truncated: false,
    ...overrides,
  };
}

function file(path: string, overrides: Partial<DerivedPieFile> = {}): DerivedPieFile {
  return { path, kind: "html", mtime: 0, ...overrides };
}

describe("censusToFiles", () => {
  it("adapts census files to DerivedPieFile, adding kind from the path", () => {
    const c = census({
      files: [
        { path: "/w/dir/a.html", mtime: 1000, size: 5, folder: "/w/dir" },
        { path: "/w/b.md", mtime: 2000, size: 7 },
      ],
    });
    const members: PieMember[] = [{ kind: "folder", path: "/w/dir", added_at: 0 }];
    expect(censusToFiles(c, members)).toEqual([
      { path: "/w/dir/a.html", kind: "html", mtime: 1000, folder: "/w/dir" },
      { path: "/w/b.md", kind: "md", mtime: 2000, folder: undefined },
    ]);
  });

  it("drops a row whose folder is no longer a current member (a stale in-flight census)", () => {
    const c = census({
      files: [{ path: "/w/gone/a.html", mtime: 1000, size: 5, folder: "/w/gone" }],
    });
    expect(censusToFiles(c, [])).toEqual([]);
  });

  it("keeps a direct file row (no folder) regardless of members", () => {
    const c = census({ files: [{ path: "/w/a.md", mtime: 1, size: 1 }] });
    expect(censusToFiles(c, [])).toEqual([{ path: "/w/a.md", kind: "md", mtime: 1, folder: undefined }]);
  });

});

/** `layersOf`'s folder layer for `id` — narrowed, so a test reads
 *  `missing`/`live` without a cast the discriminated union would reject. */
function folderLayer(layers: PieLayer[], id: string): Extract<PieLayer, { kind: "folder" }> {
  const layer = layers.find((l) => l.id === id);
  if (!layer || layer.kind !== "folder") throw new Error(`no folder layer ${id}`);
  return layer;
}

function treeChange(path: string): FsChange {
  return { kind: "modify", path, source: "tree" };
}

describe("affectsPie", () => {
  const members: PieMember[] = [
    { kind: "folder", path: "/w/dir", added_at: 0 },
    { kind: "file", path: "/w/direct.md", added_at: 0 },
  ];

  it("returns the folder member a tree change falls under", () => {
    expect(affectsPie(treeChange("/w/dir/new.html"), members)).toBe(members[0]);
  });

  it("matches on a SEGMENT boundary, not a bare string prefix", () => {
    expect(affectsPie(treeChange("/w/dir-other/a.txt"), members)).toBeNull();
    expect(affectsPie(treeChange("/w/dir"), members)).toBe(members[0]);
  });

  it("is null for a change outside every folder member", () => {
    expect(affectsPie(treeChange("/w/elsewhere/new.html"), members)).toBeNull();
  });

  it("is null for a change on a direct FILE member's own path", () => {
    // A FILE member's own mtime change is out of scope for M3's live
    // refresh (see the function's own doc comment) — only folder members
    // trigger a bus-driven refresh.
    expect(affectsPie(treeChange("/w/direct.md"), members)).toBeNull();
  });

  it("is null for an EXTERNAL-source change even under a folder member", () => {
    expect(
      affectsPie({ kind: "modify", path: "/w/dir/new.html", source: "external" }, members),
    ).toBeNull();
  });
});

describe("freshCount", () => {
  it("counts files strictly newer than seenAt", () => {
    const files = [file("/a", { mtime: 100 }), file("/b", { mtime: 200 }), file("/c", { mtime: 300 })];
    expect(freshCount(files, 150)).toBe(2);
  });

  it("is 0 when seenAt is 0 (never opened) even if every file is 'new'", () => {
    const files = [file("/a", { mtime: 100 }), file("/b", { mtime: 200 })];
    expect(freshCount(files, 0)).toBe(0);
  });

  it("is 0 for an empty pie", () => {
    expect(freshCount([], 100)).toBe(0);
  });

  it("does not count a file whose mtime EQUALS seenAt", () => {
    // Strictly newer: a file last written at the exact moment the plate
    // was opened was already on screen then, so it is not new. This is the
    // boundary the per-row "new" dot in PiePlate.tsx uses too.
    expect(freshCount([file("/a", { mtime: 100 })], 100)).toBe(0);
  });
});

describe("sameMembers", () => {
  // The predicate that decides whether a `pies-updated` event is worth a
  // re-walk. Getting it wrong either re-walks every folder of every pie on
  // every plate open, or misses a real membership change entirely.
  const base: PieMember[] = [
    { kind: "folder", path: "/w/a", added_at: 1 },
    { kind: "file", path: "/w/b.md", added_at: 2 },
  ];

  it("is false for a pie seen for the first time (no previous list)", () => {
    expect(sameMembers(undefined, base)).toBe(false);
  });

  it("is false when a member's KIND flips", () => {
    expect(sameMembers(base, [{ ...base[0], kind: "file" }, base[1]])).toBe(false);
  });

  it("is false when the same members are REORDERED", () => {
    // Stored order is what `layersOf` renders, so a reorder changes the
    // census's own output even though the set is identical.
    expect(sameMembers(base, [base[1], base[0]])).toBe(false);
  });

  it("is false when a member is added or removed", () => {
    expect(sameMembers(base, [base[0]])).toBe(false);
  });

  it("is TRUE when only added_at / source / origin differ", () => {
    // This is what makes `touch_seen` — fired on every single plate open —
    // a no-op here: those three describe the ADD, not what is on disk.
    expect(
      sameMembers(base, [
        { ...base[0], added_at: 999, source: "menu" },
        { ...base[1], added_at: 999, origin: { session_id: "s1" } },
      ]),
    ).toBe(true);
  });
});

describe("newestPath", () => {
  it("returns the path with the greatest mtime", () => {
    const files = [file("/old", { mtime: 100 }), file("/new", { mtime: 300 }), file("/mid", { mtime: 200 })];
    expect(newestPath(files)).toBe("/new");
  });

  it("returns null for an empty pie", () => {
    expect(newestPath([])).toBeNull();
  });
});

describe("layersOf", () => {
  const members: PieMember[] = [
    { kind: "folder", path: "/w/b-dir", added_at: 0 },
    { kind: "folder", path: "/w/a-dir", added_at: 0 },
    { kind: "file", path: "/w/direct.md", added_at: 0 },
  ];
  const files: DerivedPieFile[] = [
    file("/w/b-dir/old.html", { mtime: 100, folder: "/w/b-dir" }),
    file("/w/b-dir/new.html", { mtime: 300, folder: "/w/b-dir" }),
    file("/w/a-dir/x.md", { mtime: 200, folder: "/w/a-dir" }),
    file("/w/direct.md", { mtime: 50 }),
  ];

  it("orders folder layers in STORED member order, not alphabetically", () => {
    const layers = layersOf(files, members, undefined);
    expect(layers.map((l) => l.id)).toEqual(["/w/b-dir", "/w/a-dir", "files"]);
  });

  it("sorts each layer's rows newest-first", () => {
    const layers = layersOf(files, members, undefined);
    const bDir = layers.find((l) => l.id === "/w/b-dir") as PieLayer;
    expect(bDir.rows.map((r) => r.path)).toEqual(["/w/b-dir/new.html", "/w/b-dir/old.html"]);
  });

  it("puts direct file members in one trailing 'Files' layer", () => {
    const layers = layersOf(files, members, undefined);
    const filesLayer = layers.find((l) => l.id === "files") as PieLayer;
    expect(filesLayer.kind).toBe("files");
    expect(filesLayer.rows.map((r) => r.path)).toEqual(["/w/direct.md"]);
  });

  it("omits the 'Files' layer when a pie with folder members has no direct-file rows", () => {
    const folderOnly = members.filter((m) => m.kind === "folder");
    const layers = layersOf(
      files.filter((f) => f.folder !== undefined),
      folderOnly,
      undefined,
    );
    expect(layers.some((l) => l.id === "files")).toBe(false);
  });

  it("always returns at least one layer — an empty pie gets the 'files' one", () => {
    // The plate renders from `layers` alone; returning none would make an
    // empty pie a third case to handle rather than an empty list.
    expect(layersOf([], [], undefined).map((l) => l.id)).toEqual(["files"]);
  });

  it("puts a missing FILE member's row in the 'files' layer, after the live rows", () => {
    const withMissing: DerivedPieFile[] = [
      { path: "/w/gone.md", kind: "md", mtime: 0, missing: true },
      file("/w/direct.md", { mtime: 50 }),
    ];
    const layers = layersOf(withMissing, [members[2]], undefined);
    const filesLayer = layers.find((l) => l.id === "files") as PieLayer;
    expect(filesLayer.rows.map((r) => r.path)).toEqual(["/w/direct.md", "/w/gone.md"]);
  });

  it("flags a folder layer missing when its member is in census.missing", () => {
    const c = census({ missing: ["/w/a-dir"] });
    const layers = layersOf(files, members, c);
    expect(folderLayer(layers, "/w/a-dir").missing).toBe(true);
    expect(folderLayer(layers, "/w/b-dir").missing).toBe(false);
  });

  it("flags a folder layer not-live when its member is in census.outside_root", () => {
    const c = census({ outside_root: ["/w/b-dir"] });
    const layers = layersOf(files, members, c);
    expect(folderLayer(layers, "/w/b-dir").live).toBe(false);
    expect(folderLayer(layers, "/w/a-dir").live).toBe(true);
  });

  it("flags a folder layer unreadable when its member is in census.unreadable", () => {
    // Distinct from `missing`: the folder is still there, so the plate
    // offers Forget but not Locate….
    const c = census({ unreadable: ["/w/a-dir"] });
    const layers = layersOf(files, members, c);
    expect(folderLayer(layers, "/w/a-dir").unreadable).toBe(true);
    expect(folderLayer(layers, "/w/a-dir").missing).toBe(false);
    expect(folderLayer(layers, "/w/b-dir").unreadable).toBe(false);
  });

  it("defaults missing/unreadable=false and live=true before any census has resolved", () => {
    const layers = layersOf(files, members, undefined);
    for (const l of layers) {
      if (l.kind !== "folder") continue;
      expect(l.missing).toBe(false);
      expect(l.unreadable).toBe(false);
      expect(l.live).toBe(true);
    }
  });
});
