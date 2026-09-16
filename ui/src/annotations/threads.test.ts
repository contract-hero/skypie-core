import { describe, expect, it } from "vitest";
import { anchorLabel, authorOf, shortTime } from "../components/CommentThread";
import { railOrder } from "../components/CommentRail";
import { lineOf, regionOf, toThreads } from "./types";
import type { Annotation } from "./types";
import { selectorsForRange } from "./anchor";
import type { Anchored } from "./anchor";

function root(id: string, text = "doc text here", body = "hi"): Annotation {
  return {
    id,
    type: "Annotation",
    motivation: "commenting",
    created: "2026-09-13T10:42:11Z",
    creator: { id: "node:3f9a1c2d4e", name: "Alvaro's iPhone" },
    status: "open",
    body: { type: "TextualBody", value: body },
    target: { source: "/tmp/a.md", hash: "blake3:x", selector: selectorsForRange(text, 0, 3) },
  };
}

function replyTo(id: string, parent: string): Annotation {
  return { ...root(id), motivation: "replying", inReplyTo: parent, body: { type: "TextualBody", value: "me too" } };
}

describe("toThreads", () => {
  it("nests replies under their root", () => {
    const threads = toThreads([root("a"), replyTo("a1", "a"), root("b")]);
    expect(threads).toHaveLength(2);
    expect(threads[0].root.id).toBe("a");
    expect(threads[0].replies.map((r) => r.id)).toEqual(["a1"]);
    expect(threads[1].replies).toEqual([]);
  });

  it("promotes an orphaned reply instead of dropping it", () => {
    // A peer pushed the reply but not the root it answers. Losing someone's
    // words because a different line did not arrive is the worse bug.
    const threads = toThreads([replyTo("orphan", "never-arrived")]);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("orphan");
  });

  it("keeps replies in the order they arrived", () => {
    const threads = toThreads([root("a"), replyTo("a1", "a"), replyTo("a2", "a")]);
    expect(threads[0].replies.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("returns nothing for an empty store", () => {
    expect(toThreads([])).toEqual([]);
  });
});

describe("railOrder", () => {
  const text = "alpha bravo charlie";

  it("pairs each thread with where it landed", () => {
    const a = root("a", text);
    const rows = railOrder(toThreads([a]), text, "blake3:x");
    expect(rows).toHaveLength(1);
    expect(rows[0].thread.root.id).toBe("a");
    expect(rows[0].anchored.range).toEqual({ start: 0, end: 3 });
  });

  it("puts a detached thread first", () => {
    const here = root("here", text);
    const gone = { ...root("gone", "a completely different document"), id: "gone" };
    const rows = railOrder(toThreads([here, gone]), text, "blake3:changed");
    expect(rows[0].thread.root.id).toBe("gone");
    expect(rows[0].anchored.range).toBeNull();
  });

  it("never loses a thread to the re-anchor pass", () => {
    const all = [root("a", text), root("b", "elsewhere entirely"), root("c", text)];
    expect(railOrder(toThreads(all), text, "blake3:changed")).toHaveLength(3);
  });
});

describe("authorOf", () => {
  it("prefers the announced device name", () => {
    expect(authorOf(root("a"))).toBe("Alvaro's iPhone");
  });

  it("falls back to a short node id", () => {
    const anon = { ...root("a"), creator: { id: "node:3f9a1c2d4e5f6a7b8c" } };
    expect(authorOf(anon)).toBe("3f9a1c2d4e…");
  });

  it("does not truncate an id that is already short", () => {
    const anon = { ...root("a"), creator: { id: "local" } };
    expect(authorOf(anon)).toBe("local");
  });
});

describe("shortTime", () => {
  it("shows only the clock for a comment made today", () => {
    const now = new Date("2026-09-13T18:00:00Z");
    expect(shortTime("2026-09-13T10:42:11Z", now)).toMatch(/\d/);
    expect(shortTime("2026-09-13T10:42:11Z", now)).not.toMatch(/2026/);
  });

  it("shows the year once the comment is from another year", () => {
    const now = new Date("2026-09-13T18:00:00Z");
    expect(shortTime("2025-01-04T10:00:00Z", now)).toMatch(/2025/);
  });

  it("returns empty rather than 'Invalid Date' for a broken timestamp", () => {
    expect(shortTime("not a date")).toBe("");
  });
});

describe("anchorLabel", () => {
  it("names the line when there is one", () => {
    const a = root("a");
    expect(
      anchorLabel({ annotation: a, range: { start: 0, end: 3 }, line: 142, quality: "context" }),
    ).toBe("line 142");
  });

  it("says so plainly when the anchor is genuinely lost", () => {
    const a = root("a");
    expect(anchorLabel({ annotation: a, range: null, line: null, quality: "detached" })).toBe(
      "anchor not found",
    );
  });

  it("claims nothing before there is a document to have looked in", () => {
    // `unknown` means the preview has not reported its text yet. Saying
    // "anchor not found" then told every user, on every file, that the text
    // their comments pointed at was gone.
    const a = root("a");
    expect(anchorLabel({ annotation: a, range: null, line: null, quality: "unknown" })).toBe("");
    expect(anchorLabel(undefined)).toBe("");
  });
});

describe("reading selectors back", () => {
  it("reads the stored line", () => {
    const a = root("a", "one\ntwo\nthree");
    expect(lineOf(a.target)).toBe(1);
  });

  it("reads an image pin as percentages", () => {
    const pinned: Annotation = {
      ...root("a"),
      target: {
        source: "/tmp/x.png",
        hash: null,
        selector: [
          {
            type: "FragmentSelector",
            conformsTo: "http://www.w3.org/TR/media-frags/",
            value: "xywh=percent:31,18,4,4",
          },
        ],
      },
    };
    expect(regionOf(pinned.target)).toEqual({ x: 31, y: 18, w: 4, h: 4 });
    expect(lineOf(pinned.target)).toBeNull();
  });

  it("refuses a malformed region rather than returning NaN", () => {
    const bad: Annotation = {
      ...root("a"),
      target: {
        source: "/tmp/x.png",
        hash: null,
        selector: [{ type: "FragmentSelector", value: "xywh=percent:oops" }],
      },
    };
    expect(regionOf(bad.target)).toBeNull();
  });
});

describe("anchorLabel", () => {
  /** An `Anchored` carrying one CssSelector, placed unless told otherwise. */
  function withCss(value: string, quality: Anchored["quality"] = "context"): Anchored {
    return {
      annotation: {
        id: "a",
        type: "Annotation",
        motivation: "commenting",
        created: "2026-09-15T00:00:00Z",
        creator: { id: "node:test" },
        status: "open",
        target: { source: "/tmp/a.html", hash: null, selector: [{ type: "CssSelector", value }] },
      },
      range: quality === "detached" ? null : { start: 0, end: 1 },
      line: 7,
      quality,
    };
  }

  it("names the element a reader clicked, not a line of rendered text", () => {
    expect(anchorLabel(withCss("main > table > tr > td:nth-of-type(3)"))).toBe("Table cell");
    expect(anchorLabel(withCss("h2"))).toBe("Heading");
    expect(anchorLabel(withCss("main > div.card"))).toBe("Block");
  });

  it("falls back to Element for a path cut short at an id", () => {
    expect(anchorLabel(withCss("#app"))).toBe("Element");
  });

  it("stops naming the element once the anchor is gone", () => {
    expect(anchorLabel(withCss("main > p", "detached"))).toBe("line 7");
  });
});
