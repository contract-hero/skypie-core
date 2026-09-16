import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { blockLines } from "./md-blocks";

const md = new Marked();

describe("blockLines", () => {
  it("numbers each rendering block by its source line", () => {
    const src = "# Title\n\nFirst para\nstill first\n\n- a\n- b\n\n```ts\ncode\n```\n";
    const got = blockLines(md.lexer(src), src);
    expect(got.map((b) => [b.token.type, b.line])).toEqual([
      ["heading", 1],
      ["paragraph", 3],
      ["list", 6],
      ["code", 9],
    ]);
  });

  it("skips blank-line and definition tokens", () => {
    const src = "[ref]: https://x\n\nUses [ref].\n";
    const got = blockLines(md.lexer(src), src);
    expect(got.map((b) => [b.token.type, b.line])).toEqual([["paragraph", 3]]);
  });

  it("keeps counting correctly after a swallowed definition", () => {
    const src = "intro\n\n[ref]: https://x\n\nUses [ref].\n\nlast\n";
    const got = blockLines(md.lexer(src), src);
    expect(got.map((b) => [b.token.type, b.line])).toEqual([
      ["paragraph", 1],
      ["paragraph", 5],
      ["paragraph", 7],
    ]);
  });

  it("numbers a CRLF source the same as an LF one", () => {
    // marked normalises CRLF inside every `raw`, so a lookup against the
    // unnormalised source can never match. Before this was handled, every
    // block in a Windows-authored file drifted one line per blank line.
    const lf = "# Title\n\nFirst para\n\n- a\n- b\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    const expected = [
      ["heading", 1],
      ["paragraph", 3],
      ["list", 5],
    ];
    expect(blockLines(md.lexer(lf), lf).map((b) => [b.token.type, b.line])).toEqual(expected);
    expect(blockLines(md.lexer(crlf), crlf).map((b) => [b.token.type, b.line])).toEqual(expected);
  });

  it("numbers tables and quotes", () => {
    const src = "para\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n";
    const got = blockLines(md.lexer(src), src);
    expect(got.map((b) => [b.token.type, b.line])).toEqual([
      ["paragraph", 1],
      ["table", 3],
      ["blockquote", 7],
    ]);
  });
});
