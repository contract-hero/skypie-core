import { describe, expect, it } from "vitest";
import {
  CONTEXT_CHARS,
  FUZZY_FLOOR,
  NEAR_WINDOW,
  findFuzzy,
  lineAt,
  lineOfOffset,
  lineStarts,
  offsetOfLine,
  pinAtPercent,
  pinSelector,
  reanchor,
  reanchorAll,
  selectorsForLine,
  selectorsForRange,
  similarity,
} from "./anchor";
import type { Annotation, Selector, TextPositionSelector, TextQuoteSelector } from "./types";

function annotationFor(text: string, start: number, end: number, hash?: string): Annotation {
  return {
    id: "0192c6f1-8f2e-7c1a-9d3b-4e5f6a7b8c9d",
    type: "Annotation",
    motivation: "commenting",
    created: "2026-09-13T10:42:11Z",
    creator: { id: "node:3f9a", name: "Alvaro's iPhone" },
    status: "open",
    body: { type: "TextualBody", value: "This table needs the Q3 numbers." },
    target: {
      source: "/tmp/audit.md",
      hash: hash ?? "blake3:aaaa",
      selector: selectorsForRange(text, start, end),
    },
  };
}

const quoteOf = (a: Annotation) =>
  a.target.selector.find((s): s is TextQuoteSelector => s.type === "TextQuoteSelector")!;
const positionOf = (a: Annotation) =>
  a.target.selector.find((s): s is TextPositionSelector => s.type === "TextPositionSelector")!;

describe("selectorsForRange", () => {
  const text = "line one\nline two has Total revenue in it\nline three\n";
  const start = text.indexOf("Total revenue");
  const end = start + "Total revenue".length;

  it("always stores a quote, a position and a line", () => {
    const kinds = selectorsForRange(text, start, end).map((s: Selector) => s.type);
    expect(kinds).toEqual(["TextQuoteSelector", "TextPositionSelector", "FragmentSelector"]);
  });

  it("captures context on both sides of the quote", () => {
    const q = selectorsForRange(text, start, end)[0] as TextQuoteSelector;
    expect(q.exact).toBe("Total revenue");
    expect(q.prefix).toBe(text.slice(Math.max(0, start - CONTEXT_CHARS), start));
    expect(q.suffix).toBe(text.slice(end, end + CONTEXT_CHARS));
  });

  it("records the line the selection starts on", () => {
    const frag = selectorsForRange(text, start, end)[2] as { value: string };
    expect(frag.value).toBe("line=2");
  });

  it("clamps a range past the end of the text instead of producing undefined", () => {
    const q = selectorsForRange("short", 3, 9999)[0] as TextQuoteSelector;
    expect(q.exact).toBe("rt");
  });

  it("survives an inverted range", () => {
    const p = selectorsForRange("abcdef", 4, 1)[1] as TextPositionSelector;
    expect(p.start).toBe(4);
    expect(p.end).toBe(4);
  });
});

describe("line arithmetic", () => {
  const text = "a\nbb\nccc\n";

  it("counts lines from one", () => {
    expect(lineAt(text, 0)).toBe(1);
    expect(lineAt(text, 2)).toBe(2);
    expect(lineAt(text, 5)).toBe(3);
  });

  it("round-trips a line to its offset", () => {
    for (const line of [1, 2, 3]) expect(lineAt(text, offsetOfLine(text, line))).toBe(line);
  });

  it("clamps a line past the end", () => {
    expect(offsetOfLine(text, 99)).toBe(text.length);
  });
});

describe("reanchor", () => {
  const original = "intro\n\n| Total revenue | 41 |\n\noutro\n";
  const start = original.indexOf("Total revenue");
  const end = start + "Total revenue".length;

  it("trusts stored offsets when the content hash is unchanged", () => {
    const a = annotationFor(original, start, end, "blake3:same");
    const got = reanchor(a, original, "blake3:same");
    expect(got.quality).toBe("exact");
    expect(got.range).toEqual({ start, end });
  });

  it("re-finds the quote after an edit above it moved every offset", () => {
    const a = annotationFor(original, start, end, "blake3:old");
    const edited = "a new first paragraph the agent added\n\n" + original;
    const got = reanchor(a, edited, "blake3:new");

    expect(got.quality).toBe("context");
    expect(edited.slice(got.range!.start, got.range!.end)).toBe("Total revenue");
    expect(got.line).toBe(lineAt(edited, edited.indexOf("Total revenue")));
  });

  it("uses context to pick the right occurrence among duplicates", () => {
    const table = "| Total | 1 |\n| Total | 2 |\n| Total | 3 |\n";
    const third = table.lastIndexOf("Total");
    const a = annotationFor(table, third, third + 5, "blake3:old");

    const edited = "header\n" + table;
    const got = reanchor(a, edited, "blake3:new");
    expect(got.range!.start).toBe(edited.lastIndexOf("Total"));
  });

  it("falls back to the nearest bare occurrence when the context is gone", () => {
    const a = annotationFor(original, start, end, "blake3:old");
    // Both the prefix ("| ") and the suffix (" | 41 |") are rewritten.
    const edited = "intro\n\nTotal revenue was 55 this quarter\n\noutro\n";
    const got = reanchor(a, edited, "blake3:new");

    expect(got.quality).toBe("nearest");
    expect(edited.slice(got.range!.start, got.range!.end)).toBe("Total revenue");
  });

  it("prefers the occurrence closest to where the comment used to be", () => {
    const far = "Total revenue\n" + "filler\n".repeat(400);
    const a = annotationFor(far + "Total revenue\n", far.length, far.length + 13, "blake3:old");
    const got = reanchor(a, far + "Total revenue\n", "blake3:new");
    expect(got.range!.start).toBe(far.length);
  });

  it("detaches rather than guessing when the text is gone", () => {
    const a = annotationFor(original, start, end, "blake3:old");
    const got = reanchor(a, "the agent replaced the whole document\n", "blake3:new");

    expect(got.quality).toBe("detached");
    expect(got.range).toBeNull();
    expect(got.annotation.body?.value).toBe("This table needs the Q3 numbers.");
  });

  it("does not trust stale offsets when the hash changed", () => {
    const a = annotationFor(original, start, end, "blake3:old");
    // Same length, different content at the stored offsets.
    const edited = original.replace("Total revenue", "Gross margins");
    const got = reanchor(a, edited, "blake3:new");
    expect(got.quality).not.toBe("exact");
  });

  it("detaches an annotation carrying no quote once the hash changed", () => {
    const a = annotationFor(original, start, end, "blake3:old");
    a.target.selector = [positionOf(a)];
    expect(reanchor(a, original, "blake3:new").quality).toBe("detached");
  });

  it("re-anchors with no hash available at all", () => {
    const a = annotationFor(original, start, end, "blake3:old");
    const got = reanchor(a, original, null);
    // No hash to compare, so the quote search runs and still lands right.
    expect(got.quality).toBe("context");
    expect(original.slice(got.range!.start, got.range!.end)).toBe("Total revenue");
  });

  it("keeps the quote it was built with", () => {
    const a = annotationFor(original, start, end);
    expect(quoteOf(a).exact).toBe("Total revenue");
  });
});

describe("reanchorAll", () => {
  const text = "alpha\nbravo\ncharlie\n";

  it("sorts by position with detached comments first", () => {
    const charlie = annotationFor(text, text.indexOf("charlie"), text.indexOf("charlie") + 7);
    const alpha = { ...annotationFor(text, 0, 5), id: "alpha" };
    const lost = { ...annotationFor("gone forever", 0, 4), id: "lost" };

    const got = reanchorAll([charlie, alpha, lost], text, "blake3:new");
    expect(got.map((g) => g.annotation.id)).toEqual(["lost", "alpha", charlie.id]);
    expect(got[0].quality).toBe("detached");
  });

  it("never drops an annotation", () => {
    const all = [annotationFor(text, 0, 5), annotationFor("elsewhere", 0, 4)];
    expect(reanchorAll(all, text, "blake3:new")).toHaveLength(2);
  });
});

describe("pinSelector", () => {
  const box = { left: 100, top: 50, width: 400, height: 200 };

  it("stores a pin as a percentage of the rendered box", () => {
    const [sel] = pinSelector(200, 100, box) as unknown as [{ value: string }];
    expect(sel.value).toBe("xywh=percent:25,25,0,0");
  });

  it("clamps a click outside the image", () => {
    const [sel] = pinSelector(-500, 9999, box) as unknown as [{ value: string }];
    expect(sel.value).toBe("xywh=percent:0,100,0,0");
  });

  it("emits nothing rather than NaN before the image has laid out", () => {
    expect(pinSelector(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual([]);
  });

  it("is resolution independent: the same click maps to the same percent", () => {
    const small = pinSelector(200, 100, box) as unknown as [{ value: string }];
    const large = pinSelector(300, 150, {
      left: 100,
      top: 50,
      width: 800,
      height: 400,
    }) as unknown as [{ value: string }];
    expect(small[0].value).toBe(large[0].value);
  });
});

describe("findFuzzy", () => {
  const doc = [
    "# Quarterly report",
    "",
    "Revenue grew by eleven percent across the three main regions.",
    "",
    "Costs were flat.",
    "",
  ].join("\n");

  const quoted = "Revenue grew by eleven percent across the three main regions.";
  const hint = doc.indexOf(quoted);

  it("re-attaches to a passage the agent reworded", () => {
    const edited = doc.replace(
      quoted,
      "Revenue grew by twelve percent across the three main regions.",
    );
    const got = findFuzzy(edited, quoted, hint);
    expect(got).not.toBeNull();
    expect(edited.slice(got!.start, got!.end)).toContain("twelve percent");
  });

  it("ignores reformatting: collapsed whitespace and case are not a change", () => {
    const edited = doc.replace(
      quoted,
      "REVENUE   grew  by eleven percent  across the three main regions.",
    );
    expect(findFuzzy(edited, quoted, hint)).not.toBeNull();
  });

  it("detaches when the passage was replaced rather than edited", () => {
    const edited = doc.replace(quoted, "Headcount fell sharply in the Berlin office.");
    expect(findFuzzy(edited, quoted, hint)).toBeNull();
  });

  it("detaches when the passage is simply gone", () => {
    expect(findFuzzy("nothing like it here at all\n", quoted, 0)).toBeNull();
  });

  it("does not jump to a similar paragraph far outside the window", () => {
    // The real text is pushed well past NEAR_WINDOW from the old offset.
    const filler = "filler line\n".repeat(NEAR_WINDOW / 4);
    const far = filler + quoted.replace("eleven", "twelve") + "\n";
    expect(findFuzzy(far, quoted, 0)).toBeNull();
  });

  it("prefers the nearer of two equally good candidates", () => {
    const variant = quoted.replace("eleven", "twelve");
    const text = `${variant}\n${"pad\n".repeat(40)}${variant}\n`;
    const near = text.lastIndexOf(variant);
    const got = findFuzzy(text, quoted, near);
    expect(got!.start).toBe(near);
  });

  it("matches a multi-line quote against the same number of lines", () => {
    const twoLines = "Costs were flat.\n";
    const source = `${doc}${twoLines}`;
    const edited = source.replace("Costs were flat.", "Costs were nearly flat.");
    const got = findFuzzy(edited, "Costs were flat.", edited.indexOf("Costs"));
    expect(got).not.toBeNull();
    expect(edited.slice(got!.start, got!.end)).not.toContain("\n");
  });

  it("refuses an empty needle rather than matching everything", () => {
    expect(findFuzzy(doc, "", 0)).toBeNull();
    expect(findFuzzy(doc, "   \n ", 0)).toBeNull();
  });
});

describe("similarity", () => {
  it("is 1 for identical strings and 0 for nothing in common", () => {
    expect(similarity("total revenue", "total revenue")).toBe(1);
    expect(similarity("aaaa", "bbbb")).toBe(0);
  });

  it("is symmetric", () => {
    const a = "revenue grew by eleven percent";
    const b = "revenue grew by twelve percent";
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10);
  });

  it("rates a small edit above the floor and a rewrite below it", () => {
    expect(similarity("revenue grew by eleven percent", "revenue grew by twelve percent"))
      .toBeGreaterThan(FUZZY_FLOOR);
    expect(similarity("revenue grew by eleven percent", "headcount fell in berlin"))
      .toBeLessThan(FUZZY_FLOOR);
  });

  it("answers 0 for a string too short to have bigrams", () => {
    expect(similarity("a", "a b c")).toBe(0);
    expect(similarity("", "")).toBe(1);
  });

  it("does not double-count a repeated bigram", () => {
    // "aa" appears once in the left string; a right string full of "aa"
    // must not score as a perfect match by consuming it repeatedly.
    expect(similarity("aab", "aaaaaa")).toBeLessThan(1);
  });
});

describe("an unread document is not data loss", () => {
  const text = "alpha bravo charlie";

  it("answers `unknown`, not `detached`, when there is no text yet", () => {
    // The preview reports its rendered text asynchronously. Before that
    // arrives every comment searched "" and came back `detached`, so opening
    // any commented file told the user every comment had lost its text.
    const a = annotationFor(text, 0, 5);
    const got = reanchor(a, "", null);
    expect(got.quality).toBe("unknown");
    expect(got.range).toBeNull();
  });

  it("places the same comment normally once the text arrives", () => {
    const a = annotationFor(text, 0, 5);
    expect(reanchor(a, text, null).quality).not.toBe("unknown");
  });

  it("reports `unknown` for every comment in a batch, never `detached`", () => {
    const all = [annotationFor(text, 0, 5), annotationFor(text, 6, 11)];
    for (const got of reanchorAll(all, "", null)) {
      expect(got.quality).toBe("unknown");
    }
  });
});

describe("the fuzzy rung is reachable through the ladder", () => {
  const doc = "# Report\\n\\nRevenue grew by eleven percent across the three main regions.\\n";
  const quoted = "Revenue grew by eleven percent across the three main regions.";

  it("re-attaches a passage the agent reworded", () => {
    // Rung 4. Without this the call site could be deleted and every other
    // test would still pass, because the detach test expects `detached`
    // either way.
    const at = doc.indexOf(quoted);
    const a = annotationFor(doc, at, at + quoted.length);
    const edited = doc.replace("eleven", "twelve");
    const got = reanchor(a, edited, "blake3:new");
    expect(got.quality).toBe("fuzzy");
    expect(edited.slice(got.range!.start, got.range!.end)).toContain("twelve percent");
  });
});

describe("batch and single line lookup agree", () => {
  const text = "one\\ntwo\\n\\nfour\\nfive\\n";

  it("matches lineAt at every offset", () => {
    // `reanchorAll` swapped `lineAt` for a binary search over precomputed
    // starts. An off-by-one there mislabels every line shown in the rail.
    const starts = lineStarts(text);
    for (let i = 0; i <= text.length; i++) {
      expect(lineOfOffset(starts, i)).toBe(lineAt(text, i));
    }
  });

  it("agrees for a one-line document and for an empty one", () => {
    expect(lineOfOffset(lineStarts("no newlines"), 5)).toBe(lineAt("no newlines", 5));
    expect(lineOfOffset(lineStarts(""), 0)).toBe(lineAt("", 0));
  });
});

describe("selectorsForLine", () => {
  const TEXT = "alpha\n\nbravo\n";

  it("quotes the line's own text, without its newline", () => {
    const quote = selectorsForLine(TEXT, 3).find(
      (s): s is TextQuoteSelector => s.type === "TextQuoteSelector",
    );
    expect(quote?.exact).toBe("bravo");
  });

  it("quotes nothing for a blank line, so the ladder places it by number", () => {
    const set = selectorsForLine(TEXT, 2);
    const quote = set.find((s): s is TextQuoteSelector => s.type === "TextQuoteSelector");
    expect(quote?.exact).toBe("");
    expect(set.find((s) => s.type === "FragmentSelector")).toMatchObject({ value: "line=2" });
  });

  it("keeps the line asked for, not the line the offset lands on", () => {
    // A line past the end of the file clamps to the last offset, which would
    // otherwise be recorded as the LAST line — a silently different anchor.
    const frag = selectorsForLine(TEXT, 99).find((s) => s.type === "FragmentSelector");
    expect(frag).toMatchObject({ value: "line=99" });
  });

  it("caps the quote, so a comment on a long line does not store the line", () => {
    const quote = selectorsForLine("x".repeat(500) + "\nnext\n", 1).find(
      (s): s is TextQuoteSelector => s.type === "TextQuoteSelector",
    );
    expect(quote?.exact.length).toBe(240);
  });
});

describe("reanchor — the line and region rungs", () => {
  /** An annotation carrying exactly `selector`, with a now-stale hash. */
  function withSelectors(selector: Selector[]): Annotation {
    return {
      id: "a",
      type: "Annotation",
      motivation: "commenting",
      created: "2026-09-15T00:00:00Z",
      creator: { id: "node:test" },
      status: "open",
      target: { source: "/tmp/a.md", hash: "blake3:old", selector },
    };
  }

  it("places a blank-line comment by its number while the file is long enough", () => {
    const text = "a\n\n\n\n\nb\n";
    const got = reanchor(withSelectors(selectorsForLine(text, 5)), text, "blake3:new");
    expect(got.quality).toBe("line");
    expect(got.line).toBe(5);
  });

  it("detaches a blank-line comment once the file no longer has that line", () => {
    const got = reanchor(
      withSelectors(selectorsForLine("a\n\n\n\n\nb\n", 5)),
      "short\n",
      "blake3:new",
    );
    expect(got.quality).toBe("detached");
    expect(got.range).toBeNull();
  });

  it("never calls a pin detached: its region is its anchor, not any text", () => {
    // A pin quotes nothing by construction. Running it down the text ladder
    // reported "your text is gone" on a comment one second old.
    const got = reanchor(withSelectors(pinAtPercent(31, 18)), "some document text\n", "blake3:new");
    expect(got.quality).toBe("region");
  });
});
