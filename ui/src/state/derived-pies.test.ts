import { describe, expect, it } from "vitest";
import { groupByWedge, pinnedPie, recentPie, shareLabel, wedgesOf } from "./derived-pies";
import { BEARINGS } from "../render/kind";
import type { BookmarkEntry, RecentEntry } from "../ipc";
import type { DerivedPieFile } from "./derived-pies";

describe("pinnedPie", () => {
  it("converts bookmarked_at seconds to ms", () => {
    const bookmarks: BookmarkEntry[] = [{ path: "/w/a.html", bookmarked_at: 1_700_000_000 }];
    const pie = pinnedPie(bookmarks);
    expect(pie.id).toBe("builtin:pinned");
    expect(pie.files).toEqual([{ path: "/w/a.html", kind: "html", mtime: 1_700_000_000_000 }]);
  });
});

describe("recentPie", () => {
  it("converts opened_at seconds to ms", () => {
    const recents: RecentEntry[] = [{ path: "/w/a.md", opened_at: 1_700_000_100 }];
    const pie = recentPie(recents);
    expect(pie.id).toBe("builtin:recent");
    expect(pie.files).toEqual([{ path: "/w/a.md", kind: "md", mtime: 1_700_000_100_000 }]);
  });

  it("skips a skypie-remote:// address — useOpenFile pushes those to recents too", () => {
    const recents: RecentEntry[] = [
      { path: "/w/local.html", opened_at: 1 },
      { path: "skypie-remote://abc123/w/other.html", opened_at: 2 },
    ];
    const pie = recentPie(recents);
    expect(pie.files.map((f) => f.path)).toEqual(["/w/local.html"]);
  });
});

describe("wedgesOf", () => {
  it("merges a kind under 4% into other", () => {
    // 3 of 100 = 3% — under the threshold, folds into "other".
    const files = [
      ...Array.from({ length: 97 }, (_, i) => ({ path: `/f${i}.html`, kind: "html" as const, mtime: 0 })),
      ...Array.from({ length: 3 }, (_, i) => ({ path: `/d${i}.json`, kind: "data" as const, mtime: 0 })),
    ];
    const wedges = wedgesOf(files);
    expect(wedges.find((w) => w.kind === "data")).toBeUndefined();
    const other = wedges.find((w) => w.kind === "other");
    expect(other?.count).toBe(3);
  });

  it("keeps a kind AT exactly 4% as its own wedge — 'under 4%' is strict", () => {
    // 4 of 100 = exactly 4%.
    const files = [
      ...Array.from({ length: 96 }, (_, i) => ({ path: `/f${i}.html`, kind: "html" as const, mtime: 0 })),
      ...Array.from({ length: 4 }, (_, i) => ({ path: `/d${i}.json`, kind: "data" as const, mtime: 0 })),
    ];
    const wedges = wedgesOf(files);
    const data = wedges.find((w) => w.kind === "data");
    expect(data).toEqual({ kind: "data", count: 4, share: 0.04 });
    expect(wedges.find((w) => w.kind === "other")).toBeUndefined();
  });

  it("returns wedges in BEARINGS order regardless of input order", () => {
    const files = [
      { path: "/a.json", kind: "data" as const, mtime: 0 },
      { path: "/a.html", kind: "html" as const, mtime: 0 },
      { path: "/a.txt", kind: "text" as const, mtime: 0 },
    ];
    const wedges = wedgesOf(files);
    const order = wedges.map((w) => w.kind);
    const expectedOrder = BEARINGS.filter((k) => order.includes(k));
    expect(order).toEqual(expectedOrder);
    expect(order).toEqual(["html", "text", "data"]);
  });

  it("returns no wedges for empty input", () => {
    expect(wedgesOf([])).toEqual([]);
  });
});

// PiePlate's legend filter and the wedge tones both rely on this grouping —
// only the e2e (sky.e2e.ts) exercised it before, which stays green even if
// the merge loop drops a file or the "other" guard regresses (review:
// derived-pies.ts:76).
describe("groupByWedge", () => {
  it("folds a haze-merged kind's files into the 'other' group", () => {
    const html: DerivedPieFile[] = Array.from({ length: 97 }, (_, i) => ({
      path: `/f${i}.html`,
      kind: "html",
      mtime: 0,
    }));
    const data: DerivedPieFile[] = Array.from({ length: 3 }, (_, i) => ({
      path: `/d${i}.json`,
      kind: "data",
      mtime: 0,
    }));
    const groups = groupByWedge([...html, ...data]);
    expect(groups.get("data")).toBeUndefined();
    expect(groups.get("other")?.map((f) => f.path).sort()).toEqual(data.map((f) => f.path).sort());
  });

  it("keeps a genuine 'other' group under 4% as its own entry, not double-merged", () => {
    const files: DerivedPieFile[] = [
      ...Array.from({ length: 99 }, (_, i) => ({ path: `/f${i}.html`, kind: "html" as const, mtime: 0 })),
      { path: "/x.bin", kind: "other", mtime: 0 },
    ];
    const groups = groupByWedge(files);
    expect(groups.get("other")).toEqual([{ path: "/x.bin", kind: "other", mtime: 0 }]);
  });

  it("returns an empty map for empty input", () => {
    expect(groupByWedge([]).size).toBe(0);
  });

  it("does not alias the same map instance across calls", () => {
    const files: DerivedPieFile[] = [{ path: "/a.html", kind: "html", mtime: 0 }];
    expect(groupByWedge(files)).not.toBe(groupByWedge(files));
  });
});

describe("shareLabel", () => {
  it("joins wedges as 'kind pct%' in BEARINGS order", () => {
    const files: DerivedPieFile[] = [
      { path: "/a.html", kind: "html", mtime: 0 },
      { path: "/b.html", kind: "html", mtime: 0 },
      { path: "/c.md", kind: "md", mtime: 0 },
    ];
    expect(shareLabel(files)).toBe("html 67% · md 33%");
  });

  it("reads 'No files' for an empty pie", () => {
    expect(shareLabel([])).toBe("No files");
  });
});
