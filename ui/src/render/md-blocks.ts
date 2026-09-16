// Source lines for rendered Markdown blocks.
//
// Markdown renders to HTML, so "line 42" has no pixel until something maps
// the source back onto the rendered tree. marked's block lexer consumes the
// source token by token and each token keeps its `raw` text, so a block is
// located by finding its `raw` in the source — see `blockLines` for why
// finding it beats summing the lengths before it.
//
// Only TOP-LEVEL blocks are numbered: a paragraph, a heading, a list, a code
// fence, a table. That is the unit a reader points at in a rendered page, and
// the unit an agent can find again from a line number.

import type { Token, TokensList } from "marked";

export interface BlockLine {
  token: Token;
  /** 1-based source line where the block starts. */
  line: number;
}

/** Tokens that render to nothing and must not take a line number. */
const SILENT = new Set(["space", "def"]);

/**
 * Pair each rendering block token with the source line it starts on.
 *
 * Each token's `raw` is looked up in `source` from where the previous one
 * ended, rather than summing raw lengths: the lexer swallows link reference
 * definitions (and the blank line after them) without emitting a token, so
 * the raws do not tile the source and a sum would drift after every `[ref]:`.
 *
 * The source is normalised first because the lexer normalises too: marked
 * rewrites CRLF to LF inside every `raw`, so against a Windows-authored file
 * the lookup below could never match. It fell back to the running offset,
 * which advances by fewer characters than the source actually spans, and
 * every newline inside a `raw` was then counted a second time in the next
 * gap — one line of drift per blank line, for the whole document.
 */
export function blockLines(tokens: TokensList, rawSource: string): BlockLine[] {
  const source = rawSource.replace(/\r\n?/g, "\n");
  const out: BlockLine[] = [];
  let offset = 0;
  let line = 1;
  for (const token of tokens) {
    const raw = token.raw ?? "";
    const at = raw.length > 0 ? source.indexOf(raw, offset) : -1;
    const start = at >= 0 ? at : offset;
    for (let i = offset; i < start; i++) if (source.charCodeAt(i) === 10) line++;
    if (!SILENT.has(token.type)) out.push({ token, line });
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) line++;
    offset = start + raw.length;
  }
  return out;
}
