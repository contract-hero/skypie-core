import { describe, expect, it } from "vitest";
import { labelForTag, readBridgeMessage } from "./bridge";
import type { BridgeSelection } from "./bridge";
import type { CssSelector, FragmentSelector, TextQuoteSelector } from "./types";

/** Narrow to a pick, failing the test with a useful message if it is not. */
function selectionOf(data: unknown): BridgeSelection {
  const got = readBridgeMessage(data);
  if (got === null || !("pending" in got)) {
    throw new Error(`expected a selection, got ${JSON.stringify(got)}`);
  }
  return got;
}

const TEXT = "intro line\nTotal revenue was 41\noutro\n";
const START = TEXT.indexOf("Total revenue");

function pick(over: Record<string, unknown> = {}): unknown {
  return {
    type: "skypie:elementPick",
    css: "main > p:nth-of-type(2)",
    tag: "P",
    exact: "Total revenue was 41",
    start: START,
    text: TEXT,
    ...over,
  };
}

describe("readBridgeMessage — element picks", () => {
  it("turns a pick into the full anchor set, CSS path first", () => {
    const got = selectionOf(pick());
    expect(got.pending.exact).toBe("Total revenue was 41");
    expect(got.pending.label).toBe("Paragraph");
    expect(got.text).toBe(TEXT);
    expect(got.pending.selector.map((s) => s.type)).toEqual([
      "CssSelector",
      "TextQuoteSelector",
      "TextPositionSelector",
      "FragmentSelector",
    ]);
    expect((got.pending.selector[0] as CssSelector).value).toBe("main > p:nth-of-type(2)");
  });

  it("stores context around the quote, so the fourth Total is not the first", () => {
    const got = selectionOf(pick());
    const quote = got.pending.selector[1] as TextQuoteSelector;
    expect(quote.prefix).toBe("intro line\n");
    expect(quote.suffix).toBe("\noutro\n");
  });

  it("records the line the element's text starts on", () => {
    const got = selectionOf(pick());
    const frag = got.pending.selector[3] as FragmentSelector;
    expect(frag.value).toBe("line=2");
  });

  it("tolerates a missing start offset by anchoring at the top", () => {
    const got = selectionOf(pick({ start: undefined }));
    expect(got.pending.selector.map((s) => s.type)).toContain("TextQuoteSelector");
  });

  it("refuses a pick without a path or a document", () => {
    expect(readBridgeMessage(pick({ css: "" }))).toBeNull();
    expect(readBridgeMessage(pick({ text: undefined }))).toBeNull();
    expect(readBridgeMessage(pick({ exact: 7 }))).toBeNull();
  });

  it("no longer reads the retired selection message", () => {
    expect(
      readBridgeMessage({ type: "skypie:selection", exact: "x", start: 0, text: "x" }),
    ).toBeNull();
  });
});

describe("labelForTag", () => {
  it("names the kinds a reader recognises", () => {
    expect(labelForTag("H2")).toBe("Heading");
    expect(labelForTag("li")).toBe("List item");
    expect(labelForTag("div")).toBe("Block");
  });
});

describe("readBridgeMessage — image pins", () => {
  const pin = (over: Record<string, unknown> = {}): unknown => ({
    type: "skypie:imagePin",
    x: 31,
    y: 18,
    alt: "Revenue chart",
    ...over,
  });

  it("stores a pin as a percent region", () => {
    const got = selectionOf(pin());
    const frag = got.pending.selector[0] as FragmentSelector;
    expect(frag.value).toBe("xywh=percent:31,18,0,0");
    expect(frag.conformsTo).toBe("http://www.w3.org/TR/media-frags/");
  });

  it("names the image so the composer says what is being pinned", () => {
    const got = selectionOf(pin());
    expect(got.pending.exact).toBe("Revenue chart");
    expect(got.pending.label).toBe("Pin on image");

    const unnamed = selectionOf(pin({ alt: "" }));
    expect(unnamed.pending.exact).toBe("image");
  });

  it("keeps the image's CSS path ahead of the region when the frame sent one", () => {
    const got = selectionOf(pin({ css: "figure:nth-of-type(1) > img:nth-of-type(1)" }));
    expect(got.pending.selector.map((s) => s.type)).toEqual(["CssSelector", "FragmentSelector"]);
  });

  it("clamps a pin reported outside the image", () => {
    // Both shells had lost this clamp when they each hand-rolled the
    // fragment; a click just outside a rotated image stored a negative
    // percentage that `regionOf` would then read back as off-canvas.
    const got = selectionOf(pin({ x: -12, y: 140 }));
    expect((got.pending.selector[0] as FragmentSelector).value).toBe("xywh=percent:0,100,0,0");
  });

  it("carries no text, because a pin has nothing to re-anchor against", () => {
    const got = selectionOf(pin());
    expect(got.text).toBe("");
  });

  it("refuses a pin with non-numeric coordinates", () => {
    expect(readBridgeMessage(pin({ x: "31" }))).toBeNull();
    expect(readBridgeMessage(pin({ y: Number.NaN }))).toBeNull();
  });
});

describe("readBridgeMessage — the document text report", () => {
  it("carries the text with no pending selection", () => {
    // Sent once the artifact has laid out. Without it the host re-anchors
    // every stored comment against an empty string and reports them all as
    // detached — a false claim of data loss on every open.
    const got = readBridgeMessage({ type: "skypie:documentText", text: TEXT });
    expect(got).toEqual({ text: TEXT });
    expect(got !== null && "pending" in got).toBe(false);
  });

  it("accepts an empty document rather than discarding the report", () => {
    expect(readBridgeMessage({ type: "skypie:documentText", text: "" })).toEqual({ text: "" });
  });

  it("refuses a report with no usable text", () => {
    expect(readBridgeMessage({ type: "skypie:documentText" })).toBeNull();
    expect(readBridgeMessage({ type: "skypie:documentText", text: 42 })).toBeNull();
  });
});

describe("readBridgeMessage — located anchors", () => {
  it("reads each item, keeping a null top for an anchor the frame did not find", () => {
    const got = readBridgeMessage({
      type: "skypie:located",
      items: [
        { id: "a", top: 120.5 },
        { id: "b", top: null },
        { id: 3, top: 1 },
        "junk",
      ],
    });
    expect(got).toEqual({
      located: [
        { id: "a", top: 120.5 },
        { id: "b", top: null },
      ],
    });
  });

  it("refuses a report whose items are not a list", () => {
    expect(readBridgeMessage({ type: "skypie:located", items: "x" })).toBeNull();
  });
});

describe("readBridgeMessage — everything else", () => {
  it("ignores unrelated and malformed messages", () => {
    // Artifact content is untrusted and can post any shape it likes.
    for (const junk of [
      null,
      undefined,
      "a string",
      42,
      {},
      { type: "skypie:scroll", x: 0, y: 0 },
      { type: "skypie:keydown", code: "KeyT" },
    ]) {
      expect(readBridgeMessage(junk)).toBeNull();
    }
  });
});
