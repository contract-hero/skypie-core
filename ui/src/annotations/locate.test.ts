// The pure half of the host locator. Everything else in `locate.ts` needs a
// DOM, which this project does not configure a test environment for.
import { describe, expect, it } from "vitest";
import { pendingForPick } from "./locate";
import type { HostPick } from "./locate";
import type { FragmentSelector, TextQuoteSelector } from "./types";

const TEXT = "alpha\nbravo\ncharlie\n";

/** `pickInHost` hands back an element; `pendingForPick` never reads it. */
const nowhere = null as unknown as Element;

/** Narrow away the refusal case, which its own test covers. */
function pendingOf(pick: HostPick, text: string) {
  const got = pendingForPick(pick, text);
  if (!got) throw new Error("expected a pending target");
  return got;
}

describe("pendingForPick", () => {
  it("labels and quotes a line pick", () => {
    const got = pendingOf({ kind: "line", line: 2, element: nowhere }, TEXT);
    expect(got.label).toBe("Line 2");
    expect(got.exact).toBe("bravo");
  });

  it("labels a Markdown block by the source line it starts on", () => {
    const got = pendingOf({ kind: "block", line: 3, element: nowhere }, TEXT);
    expect(got.label).toBe("Block at line 3");
    expect(got.exact).toBe("charlie");
  });

  it("stores the full anchor set for a line, not just its number", () => {
    const got = pendingOf({ kind: "line", line: 1, element: nowhere }, TEXT);
    expect(got.selector.map((s) => s.type)).toEqual([
      "TextQuoteSelector",
      "TextPositionSelector",
      "FragmentSelector",
    ]);
  });

  it("clamps a pin dropped outside the image", () => {
    const pick: HostPick = {
      kind: "image",
      element: imageStub(),
      x: 10,
      y: 200,
    };
    const frag = pendingOf(pick, TEXT).selector.find(
      (s): s is FragmentSelector => s.type === "FragmentSelector",
    );
    expect(frag?.value).toBe("xywh=percent:10,100,0,0");
  });

  it("records WHICH image a pin landed on, ahead of where on it", () => {
    // Without the path every pin in a document resolved to the first image,
    // and the identity was never written so it could not be recovered.
    const got = pendingOf({ kind: "image", element: imageStub(), x: 5, y: 5 }, TEXT);
    expect(got.selector.map((s) => s.type)).toEqual(["CssSelector", "FragmentSelector"]);
    expect(got.exact).toBe("Revenue chart");
  });

  it("refuses to build an anchorless pin", () => {
    // A target with no selector would re-anchor as detached forever, and the
    // frame's entry point already rejects the same input.
    expect(
      pendingForPick({ kind: "image", element: imageStub(), x: Number.NaN, y: 0 }, TEXT),
    ).toBeNull();
  });

  it("quotes nothing for a blank line but still carries its number", () => {
    const got = pendingOf({ kind: "line", line: 2, element: nowhere }, "a\n\nb\n");
    expect(got.exact).toBe("");
    const quote = got.selector.find((s): s is TextQuoteSelector => s.type === "TextQuoteSelector");
    expect(quote?.exact).toBe("");
    expect(got.selector.find((s) => s.type === "FragmentSelector")).toMatchObject({
      value: "line=2",
    });
  });
});

/** The two things `pendingForPick` asks an image for. */
function imageStub(): HTMLImageElement {
  const el = {
    tagName: "IMG",
    previousElementSibling: null,
    parentElement: null,
    classList: { contains: () => false },
    hasAttribute: () => false,
    getAttribute: (name: string) => (name === "alt" ? "Revenue chart" : null),
  };
  return el as unknown as HTMLImageElement;
}
