import { describe, expect, it } from "vitest";
import { dominantWedge, lastOpenedLabel, mtimeAgo, readoutLabel } from "./PiePlate";
import type { DerivedPie, Wedge } from "../state/derived-pies";

const pie = (id: string, mtimes: number[]): DerivedPie => ({
  id,
  name: id === "builtin:pinned" ? "Pinned" : "Recent",
  files: mtimes.map((mtime, i) => ({ path: `/w/f${i}.html`, kind: "html", mtime })),
});

describe("mtimeAgo", () => {
  it("says 'just now' without appending ' ago'", () => {
    expect(mtimeAgo(Date.now())).toBe("just now");
    expect(mtimeAgo(Date.now() - 10_000)).toBe("just now");
  });

  it("appends ' ago' to every longer phrase", () => {
    expect(mtimeAgo(Date.now() - 5 * 60_000)).toMatch(/ ago$/);
    expect(mtimeAgo(Date.now() - 3 * 3_600_000)).toMatch(/ ago$/);
  });
});

describe("lastOpenedLabel", () => {
  it("says 'Never pinned' for an empty Pinned pie and 'Never opened' for Recent", () => {
    expect(lastOpenedLabel(pie("builtin:pinned", []))).toBe("Never pinned");
    expect(lastOpenedLabel(pie("builtin:recent", []))).toBe("Never opened");
  });

  it("uses the pinning verb for Pinned — its mtime is bookmarked_at, not an open", () => {
    expect(lastOpenedLabel(pie("builtin:pinned", [Date.now()]))).toBe("Last pinned just now");
    expect(lastOpenedLabel(pie("builtin:recent", [Date.now()]))).toBe("Last opened just now");
  });

  it("reports the NEWEST file, not the first", () => {
    const now = Date.now();
    const label = lastOpenedLabel(pie("builtin:recent", [now - 86_400_000 * 3, now]));
    expect(label).toBe("Last opened just now");
  });
});

describe("dominantWedge", () => {
  const wedge = (kind: Wedge["kind"], count: number, share: number): Wedge => ({ kind, count, share });

  it("returns null for a pie with no wedges", () => {
    expect(dominantWedge([])).toBeNull();
  });

  it("picks the biggest share", () => {
    const wedges = [wedge("html", 3, 0.3), wedge("md", 6, 0.6), wedge("data", 1, 0.1)];
    expect(dominantWedge(wedges)?.kind).toBe("md");
  });

  it("breaks a 50/50 tie by bearing order — the wedge nearer north wins", () => {
    // wedgesOfGroups returns BEARINGS order, so the first of a tie is the
    // one earlier on the compass.
    const wedges = [wedge("html", 5, 0.5), wedge("image", 5, 0.5)];
    expect(dominantWedge(wedges)?.kind).toBe("html");
  });
});

describe("readoutLabel", () => {
  it("formats the spec's own example", () => {
    expect(readoutLabel({ kind: "html", count: 9, share: 0.6 })).toBe("HTML · 60% · 9 files");
  });

  it("uses the singular for one file and says 'No files' for nothing", () => {
    expect(readoutLabel({ kind: "md", count: 1, share: 1 })).toBe("Markdown · 100% · 1 file");
    expect(readoutLabel(null)).toBe("No files");
  });
});
