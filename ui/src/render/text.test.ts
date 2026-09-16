import { describe, expect, it } from "vitest";
import { lineSpans } from "./text";

// `lineSpans` defines the line numbering for every comment on a code or
// plain-text file: `lineIndexOf` maps a click on the Nth `.line` span to
// source line N, so one span too many or too few shifts every comment in
// the file by a line. The trailing-newline case is exactly that risk.
describe("lineSpans", () => {
  it("does not count a trailing newline as one more line", () => {
    expect(lineSpans("a\nb\n")).toHaveLength(2);
  });

  it("counts the last line when the file does not end in a newline", () => {
    expect(lineSpans("a\nb")).toHaveLength(2);
  });

  it("keeps a genuinely blank final line", () => {
    expect(lineSpans("a\n\n")).toHaveLength(2);
  });

  it("handles the degenerate files", () => {
    expect(lineSpans("\n")).toHaveLength(1);
    expect(lineSpans("")).toHaveLength(1);
  });
});
