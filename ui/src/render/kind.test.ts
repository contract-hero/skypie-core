import { describe, expect, it } from "vitest";
import { BEARINGS, extOf, HAZE_THRESHOLD, kindOf } from "./kind";
import type { FileKind } from "./kind";

describe("kindOf", () => {
  // One exhaustive table: every extension the kind tables claim, with the
  // kind it must map to. Every other assertion below is derived from it, so
  // adding an extension here is the only edit a new kind needs.
  const cases: Array<[string, FileKind]> = [
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

  it("maps every known extension to exactly the kind the table claims", () => {
    for (const [ext, kind] of cases) {
      expect(kindOf(`f${ext}`), ext).toBe(kind);
    }
  });

  it("maps no known extension to 'other' (.svg is image, .htm is html)", () => {
    for (const [ext, kind] of cases) {
      expect(kind, ext).not.toBe("other");
      expect(kindOf(`file${ext}`), ext).not.toBe("other");
    }
  });

  it("covers every kind it claims within BEARINGS", () => {
    for (const [, kind] of cases) {
      expect(BEARINGS, kind).toContain(kind);
    }
  });

  it("maps an unknown extension to 'other'", () => {
    expect(kindOf("a.foobar")).toBe("other");
    expect(kindOf("archive.zip")).toBe("other");
  });

  it("maps an extension-less path to 'other' and never throws", () => {
    expect(kindOf("Makefile")).toBe("other");
    expect(kindOf("")).toBe("other");
    // A leading dot is a NAME, not an extension (extOf's `dot > 0` rule).
    expect(kindOf(".gitignore")).toBe("other");
    expect(kindOf(".md")).toBe("other");
    expect(() => kindOf("no-dot-at-all")).not.toThrow();
  });

  it("BEARINGS starts at html and lists every kind exactly once", () => {
    expect(BEARINGS[0]).toBe("html");
    expect(new Set(BEARINGS).size).toBe(BEARINGS.length);
    expect(BEARINGS).toContain("other");
  });

  it("parses the BASENAME, not the whole path", () => {
    // Every caller in derived-pies.ts passes an absolute path.
    expect(extOf("/Users/me/report.HTML")).toBe(".html");
    // A leading-dot basename is a NAME, even deep in a path.
    expect(extOf("/Users/me/.md")).toBe("");
    expect(kindOf("/Users/me/.md")).toBe("other");
    expect(extOf("/Users/me/.gitignore")).toBe("");
    // A dot in a DIRECTORY segment is not the file's extension.
    expect(extOf("/Users/me/site.v2/README")).toBe("");
    expect(kindOf("/Users/me/site.v2/README")).toBe("other");
    expect(kindOf("/Users/me/site.v2/notes.md")).toBe("md");
  });

  it("HAZE_THRESHOLD is 4%", () => {
    expect(HAZE_THRESHOLD).toBe(0.04);
  });
});
