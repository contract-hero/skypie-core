import { describe, expect, it } from "vitest";
import { BEARINGS, HAZE_THRESHOLD, kindOf } from "./kind";

// router.tsx's own tables (kept independent here on purpose — if they ever
// drift, this test is what notices the gap).
const TEXT_EXTS = [
  ".txt", ".md", ".markdown", ".ts", ".tsx", ".js", ".jsx", ".json",
  ".move", ".rs", ".toml", ".yml", ".yaml", ".css", ".sh", ".py", ".go",
  ".html", ".xml", ".svg",
];
const IMAGE_EXTS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
];

describe("kindOf", () => {
  it("maps every ext in TEXT_EXTS ∪ IMAGE_EXTS to a kind other than 'other'", () => {
    const all = new Set([...TEXT_EXTS, ...IMAGE_EXTS]);
    for (const ext of all) {
      expect(kindOf(`file${ext}`), ext).not.toBe("other");
    }
  });

  it("maps .svg to image, not text — the router.tsx trap", () => {
    expect(kindOf("a.svg")).toBe("image");
  });

  it("maps .htm to html — isHtmlPath accepts it though TEXT_EXTS never did", () => {
    expect(kindOf("index.htm")).toBe("html");
  });

  it("maps every extension to exactly one kind (BEARINGS covers all of them)", () => {
    const cases: Array<[string, string]> = [
      [".html", "html"], [".htm", "html"],
      [".md", "md"], [".markdown", "md"],
      [".ts", "code"], [".tsx", "code"], [".js", "code"], [".jsx", "code"],
      [".move", "code"], [".rs", "code"], [".css", "code"], [".sh", "code"],
      [".py", "code"], [".go", "code"],
      [".txt", "text"],
      [".png", "image"], [".jpg", "image"], [".jpeg", "image"], [".gif", "image"],
      [".webp", "image"], [".svg", "image"], [".bmp", "image"], [".ico", "image"],
      [".avif", "image"],
      [".json", "data"], [".yml", "data"], [".yaml", "data"], [".toml", "data"],
      [".xml", "data"],
    ];
    for (const [ext, kind] of cases) {
      expect(kindOf(`f${ext}`), ext).toBe(kind);
    }
    expect(new Set(cases.map(([, kind]) => kind)).size).toBeLessThanOrEqual(BEARINGS.length);
  });

  it("maps an unknown extension to 'other'", () => {
    expect(kindOf("a.foobar")).toBe("other");
    expect(kindOf("archive.zip")).toBe("other");
  });

  it("maps an extension-less path to 'other' and never throws", () => {
    expect(kindOf("Makefile")).toBe("other");
    expect(kindOf("")).toBe("other");
    expect(() => kindOf("no-dot-at-all")).not.toThrow();
  });

  it("BEARINGS starts at html and lists every kind exactly once", () => {
    expect(BEARINGS[0]).toBe("html");
    expect(new Set(BEARINGS).size).toBe(BEARINGS.length);
    expect(BEARINGS).toContain("other");
  });

  it("HAZE_THRESHOLD is 4%", () => {
    expect(HAZE_THRESHOLD).toBe(0.04);
  });
});
