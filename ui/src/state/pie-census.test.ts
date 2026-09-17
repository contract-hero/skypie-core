import { describe, expect, it } from "vitest";
import {
  affectsPie,
  censusToFiles,
  freshCount,
  isUnder,
  layersOf,
  newestPath,
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
    truncated: false,
    fresh: 0,
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

  it("dedupes by path, keeping the first occurrence — two overlapping folder members", () => {
    // `pies::add_member` dedupes exact paths only, so a pie can hold both
    // `/w/dir` and its own subfolder `/w/dir/sub`; each walks the same file
    // independently and tags it with a different `folder` (review:
    // PiePlate.tsx:290/293).
    const c = census({
      files: [
        { path: "/w/dir/sub/a.html", mtime: 100, size: 1, folder: "/w/dir" },
        { path: "/w/dir/sub/a.html", mtime: 100, size: 1, folder: "/w/dir/sub" },
      ],
    });
    const members: PieMember[] = [
      { kind: "folder", path: "/w/dir", added_at: 0 },
      { kind: "folder", path: "/w/dir/sub", added_at: 0 },
    ];
    const files = censusToFiles(c, members);
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({ path: "/w/dir/sub/a.html", kind: "html", mtime: 100, folder: "/w/dir" });
  });
});

describe("isUnder", () => {
  it("is true for the folder itself and anything inside it", () => {
    expect(isUnder("/w/dir", "/w/dir")).toBe(true);
    expect(isUnder("/w/dir/a.txt", "/w/dir")).toBe(true);
    expect(isUnder("/w/dir/sub/b.txt", "/w/dir")).toBe(true);
  });

  it("is false for a sibling that merely shares the prefix string", () => {
    expect(isUnder("/w/dir-other/a.txt", "/w/dir")).toBe(false);
  });

  it("is false for a path outside the folder entirely", () => {
    expect(isUnder("/w/other/a.txt", "/w/dir")).toBe(false);
  });
});

function treeChange(path: string): FsChange {
  return { kind: "modify", path, source: "tree" };
}

describe("affectsPie", () => {
  const members: PieMember[] = [
    { kind: "folder", path: "/w/dir", added_at: 0 },
    { kind: "file", path: "/w/direct.md", added_at: 0 },
  ];

  it("is true for a tree change under a folder member", () => {
    expect(affectsPie(treeChange("/w/dir/new.html"), members)).toBe(true);
  });

  it("is false for a change outside every folder member", () => {
    expect(affectsPie(treeChange("/w/elsewhere/new.html"), members)).toBe(false);
  });

  it("is false for a change under what merely LOOKS like a direct file member's own path", () => {
    // A FILE member's own mtime change is out of scope for M3's live
    // refresh (see the function's own doc comment) — only folder members
    // trigger a bus-driven refresh.
    expect(affectsPie(treeChange("/w/direct.md"), members)).toBe(false);
  });

  it("is false for an EXTERNAL-source change even when the path is under a folder member", () => {
    expect(affectsPie({ kind: "modify", path: "/w/dir/new.html", source: "external" }, members)).toBe(
      false,
    );
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
    expect(filesLayer.memberPath).toBeNull();
    expect(filesLayer.rows.map((r) => r.path)).toEqual(["/w/direct.md"]);
  });

  it("omits the 'Files' layer entirely when the pie has no direct file members", () => {
    const folderOnly = members.filter((m) => m.kind === "folder");
    const layers = layersOf(
      files.filter((f) => f.folder !== undefined),
      folderOnly,
      undefined,
    );
    expect(layers.some((l) => l.id === "files")).toBe(false);
  });

  it("flags a folder layer missing when its member is in census.missing", () => {
    const c = census({ missing: ["/w/a-dir"] });
    const layers = layersOf(files, members, c);
    const aDir = layers.find((l) => l.id === "/w/a-dir") as PieLayer;
    const bDir = layers.find((l) => l.id === "/w/b-dir") as PieLayer;
    expect(aDir.missing).toBe(true);
    expect(bDir.missing).toBe(false);
  });

  it("flags a folder layer not-live when its member is in census.outside_root", () => {
    const c = census({ outside_root: ["/w/b-dir"] });
    const layers = layersOf(files, members, c);
    const bDir = layers.find((l) => l.id === "/w/b-dir") as PieLayer;
    const aDir = layers.find((l) => l.id === "/w/a-dir") as PieLayer;
    expect(bDir.live).toBe(false);
    expect(aDir.live).toBe(true);
  });

  it("defaults missing=false and live=true before any census has resolved", () => {
    const layers = layersOf(files, members, undefined);
    for (const l of layers.filter((l) => l.kind === "folder")) {
      expect(l.missing).toBe(false);
      expect(l.live).toBe(true);
    }
  });
});
