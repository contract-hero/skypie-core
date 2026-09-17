import { describe, expect, it } from "vitest";
import { pinnedPie, recentPie, wedgesOf } from "./derived-pies";
import { BEARINGS } from "../render/kind";
import type { BookmarkEntry, RecentEntry } from "../ipc";

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
