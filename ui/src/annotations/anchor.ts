// Re-anchoring — finding a comment's place again after the file changed.
//
// Live reload is this app's headline feature, which means the document under
// a comment changes CONSTANTLY: an agent rewrites the report, the watcher
// fires, the tab reloads, and every stored offset is now pointing at the
// wrong words. A comment surface that loses its comments on the first reload
// is worse than no comment surface.
//
// The strategy is a ladder, cheapest and most certain first:
//
//   1. The stored content hash equals the file's hash  -> nothing moved.
//      `TextPositionSelector` is exact. No searching at all.
//   2. Otherwise, look for the `TextQuoteSelector`'s exact text WITH its
//      prefix and suffix. Context is what disambiguates the fourth "Total"
//      in a table from the first.
//   3. Otherwise, look for the exact text alone, nearest to where it used to
//      be. Ties broken by distance, because an edit usually moves text a
//      little, not to the other end of the document.
//   4. Otherwise, fuzzy. Text the agent partly rewrote is still the text the
//      comment is about.
//   5. Otherwise, DETACHED — sorted to the top of the surface, greyed,
//      never silently deleted. This is what Hypothesis does, and it is the
//      reason the quote selector is stored even when line numbers are
//      available: a user must see the comment they wrote and decide.
//
// Everything here is pure string work on the file's text, so it is unit
// testable without a DOM and runs identically for the iOS sheet and the
// desktop margin notes.

import type { Annotation, Selector, TextPositionSelector, TextQuoteSelector } from "./types";
import { MEDIA_FRAGMENTS, RFC5147, lineOf, regionOf } from "./types";

/** How much context is stored on each side of a quote. */
export const CONTEXT_CHARS = 32;

/**
 * The most text an element or line anchor quotes.
 *
 * A comment on a whole `<section>` must not store the section: the quote is
 * a key to find the place again, and the first few hundred characters are
 * as good a key as the whole thing — better, because a rewrite of the tail
 * then leaves the key intact.
 */
const MAX_QUOTE_CHARS = 240;

/** How far the exact-text search will look around the old position. */
export const NEAR_WINDOW = 2000;

export type AnchorQuality =
  | "exact"
  | "context"
  | "nearest"
  | "fuzzy"
  /** Placed by line number alone: the anchor quoted nothing (a blank line). */
  | "line"
  /**
   * A pin on an image. It never had text, and it never will.
   *
   * Distinct from `detached` for the same reason `unknown` is: a pin's
   * percentages ARE its anchor, so searching the document for words it never
   * carried and then reporting "your text is gone" is a false data-loss
   * report on a comment made one second ago. The renderers place a pin from
   * its region and say nothing about lost text.
   */
  | "region"
  | "detached"
  /**
   * There was no document to search.
   *
   * Distinct from `detached` on purpose. "Your text is gone" and "we have not
   * read the file yet" look identical to a placing algorithm and could not be
   * less alike to a person: the first is data loss, the second is a frame that
   * has not laid out. Collapsing them told every user their comments were lost
   * every time they opened a file.
   */
  | "unknown";

export interface Anchored {
  annotation: Annotation;
  /** Character range in the current text. `null` when not placed. */
  range: { start: number; end: number } | null;
  /** 1-based line the range starts on. `null` when not placed. */
  line: number | null;
  quality: AnchorQuality;
}

// ────────────────────────────────────────────────────────────────────────────
// Building selectors from a live selection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the selector set for a character range in `text`.
 *
 * Always emits quote AND position AND line, never one of them. Position is
 * fast when the file has not changed, the quote is what survives when it has,
 * and the line is what a human and an agent both read. Storing only the cheap
 * one is how comments get lost.
 */
export function selectorsForRange(
  text: string,
  start: number,
  end: number,
): Selector[] {
  const clampedStart = Math.max(0, Math.min(text.length, start));
  const clampedEnd = Math.max(clampedStart, Math.min(text.length, end));

  const quote: TextQuoteSelector = {
    type: "TextQuoteSelector",
    exact: text.slice(clampedStart, clampedEnd),
    prefix: text.slice(Math.max(0, clampedStart - CONTEXT_CHARS), clampedStart),
    suffix: text.slice(clampedEnd, Math.min(text.length, clampedEnd + CONTEXT_CHARS)),
  };
  const position: TextPositionSelector = {
    type: "TextPositionSelector",
    start: clampedStart,
    end: clampedEnd,
  };
  return [
    quote,
    position,
    { type: "FragmentSelector", conformsTo: RFC5147, value: `line=${lineAt(text, clampedStart)}` },
  ];
}

/**
 * The selector set for one whole 1-based line of `text` — what the comment
 * tool stores for a click on a line number.
 *
 * The quote is the line's content (capped), so the ladder finds the line
 * again after everything above it moved. A blank line quotes nothing and is
 * placed by its number alone — see the `line` rung in `reanchor`.
 */
export function selectorsForLine(text: string, line: number): Selector[] {
  const start = offsetOfLine(text, line);
  let end = offsetOfLine(text, line + 1);
  if (end > start && text.charCodeAt(end - 1) === 10) end--;
  end = Math.min(end, start + MAX_QUOTE_CHARS);
  const set = selectorsForRange(text, start, end);
  // `selectorsForRange` derives the line from the offset; for a line past the
  // end of the text that would be the last line, not the one asked for.
  return set.map((s) =>
    s.type === "FragmentSelector" ? { ...s, value: `line=${line}` } : s,
  );
}

/**
 * The selector set for an element of a rendered HTML artifact.
 *
 * The CSS path comes first because it is the cheapest and most exact key
 * while the artifact's structure holds; the quote behind it is what survives
 * when an agent regenerates the page with different markup.
 */
export function selectorsForElement(
  css: string,
  text: string,
  start: number,
  exact: string,
): Selector[] {
  const capped = exact.slice(0, MAX_QUOTE_CHARS);
  const from = Math.max(0, Math.min(text.length, start));
  const range = selectorsForRange(text, from, from + capped.length);
  return [{ type: "CssSelector", value: css }, ...range];
}

/** The 1-based line number containing character offset `at`. */
export function lineAt(text: string, at: number): number {
  let line = 1;
  const stop = Math.min(at, text.length);
  for (let i = 0; i < stop; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Offsets at which each line starts, `starts[0] === 0`.
 *
 * One O(length) scan that a whole re-anchor pass shares, instead of one scan
 * per annotation.
 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** The 1-based line containing `offset`, by binary search over `starts`. */
export function lineOfOffset(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Character offset where 1-based `line` starts, clamped to the text. */
export function offsetOfLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      seen++;
      if (seen === line) return i + 1;
    }
  }
  return text.length;
}

// ────────────────────────────────────────────────────────────────────────────
// Finding a selector again
// ────────────────────────────────────────────────────────────────────────────

function quoteOf(a: Annotation): TextQuoteSelector | undefined {
  return a.target.selector.find(
    (s): s is TextQuoteSelector => s.type === "TextQuoteSelector",
  );
}

function positionOf(a: Annotation): TextPositionSelector | undefined {
  return a.target.selector.find(
    (s): s is TextPositionSelector => s.type === "TextPositionSelector",
  );
}

/**
 * Place one annotation in `text`.
 *
 * `currentHash` is the file's `blake3:<hex>` right now, when the caller knows
 * it. Equal to the annotation's stored hash means step 1 applies and no
 * searching happens — which is the common case, because most reloads of most
 * files do not touch the paragraph a comment is on.
 */
export function reanchor(
  annotation: Annotation,
  text: string,
  currentHash?: string | null,
  /** Precomputed line starts, when a batch pass already built them. */
  starts?: number[],
): Anchored {
  const position = positionOf(annotation);
  const quote = quoteOf(annotation);

  // Nothing to search. Every rung below would fail against an empty string
  // and report `detached`, which reads to the user as "your text is gone" —
  // so an unread document answers `unknown` instead. The renderers show no
  // data-loss note for it.
  if (text.length === 0) {
    return { annotation, range: null, line: null, quality: "unknown" };
  }

  const place = (start: number, end: number, quality: AnchorQuality): Anchored => ({
    annotation,
    range: { start, end },
    line: starts ? lineOfOffset(starts, start) : lineAt(text, start),
    quality,
  });

  // 1. The file is byte-identical to when the comment was made.
  const storedHash = annotation.target.hash;
  if (position && storedHash && currentHash && storedHash === currentHash) {
    if (position.end <= text.length) return place(position.start, position.end, "exact");
  }

  if (!quote || quote.exact.length === 0) {
    // A pin has no text by construction; its region is the anchor, and the
    // renderers place it from that. Falling through to the text ladder would
    // report "the text this comment pointed at is no longer in the file" the
    // instant the pin was dropped.
    if (regionOf(annotation.target)) {
      return { annotation, range: null, line: null, quality: "region" };
    }
    // Nothing to search for. A position with no quote is only trustworthy
    // under an identical hash, which step 1 already ruled out — but a comment
    // on a BLANK line has a line number and nothing else, and its number is
    // a better answer than "gone" while the file still has that many lines.
    const line = lineOf(annotation.target);
    const count = starts ? starts.length : lineStarts(text).length;
    if (line !== null && line <= count) {
      const at = offsetOfLine(text, line);
      return place(at, at, "line");
    }
    return { annotation, range: null, line: null, quality: "detached" };
  }

  const hint = position?.start ?? 0;

  // 2. Exact text with its stored context.
  const withContext = findWithContext(text, quote);
  if (withContext !== null) {
    return place(withContext, withContext + quote.exact.length, "context");
  }

  // 3. Exact text alone, nearest to where it used to be.
  const nearest = findNearest(text, quote.exact, hint);
  if (nearest !== null) {
    return place(nearest, nearest + quote.exact.length, "nearest");
  }

  // 4. Fuzzy.
  const fuzzy = findFuzzy(text, quote.exact, hint);
  if (fuzzy !== null) {
    return place(fuzzy.start, fuzzy.end, "fuzzy");
  }

  // 5. Detached. Kept, shown, never deleted.
  return { annotation, range: null, line: null, quality: "detached" };
}

/**
 * Place a whole set, keeping detached ones first so they cannot be missed.
 *
 * Runs on every live reload of every commented file, so the per-annotation
 * work is kept off the file length: `lineAt` walks from 0 to the match, which
 * made a pass over N comments in a large document O(N × length). The line
 * starts are computed ONCE here and binary-searched per annotation instead.
 */
export function reanchorAll(
  annotations: Annotation[],
  text: string,
  currentHash?: string | null,
): Anchored[] {
  const starts = lineStarts(text);
  const placed = annotations.map((a) => reanchor(a, text, currentHash, starts));
  return placed.sort((a, b) => {
    if (a.range === null && b.range !== null) return -1;
    if (a.range !== null && b.range === null) return 1;
    return (a.range?.start ?? 0) - (b.range?.start ?? 0);
  });
}

/**
 * The exact text preceded by its prefix and followed by its suffix.
 *
 * Context is trimmed from the outside in: an edit right before the quote
 * kills the full prefix but usually leaves the last few characters intact, so
 * a shorter context still disambiguates where no context at all would not.
 */
function findWithContext(text: string, quote: TextQuoteSelector): number | null {
  const prefix = quote.prefix ?? "";
  const suffix = quote.suffix ?? "";
  if (!prefix && !suffix) return null;

  for (let keep = Math.max(prefix.length, suffix.length); keep >= 4; keep = Math.floor(keep / 2)) {
    const p = prefix.slice(-keep);
    const s = suffix.slice(0, keep);
    const needle = p + quote.exact + s;
    const at = text.indexOf(needle);
    if (at !== -1 && text.indexOf(needle, at + 1) === -1) {
      // Unique with this much context — trust it.
      return at + p.length;
    }
  }
  return null;
}

/** Occurrences of `needle` up to `NEAR_WINDOW` past `hint`, nearest first. */
function findNearest(text: string, needle: string, hint: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const distance = Math.abs(at - hint);
    if (distance < bestDistance) {
      best = at;
      bestDistance = distance;
    }
    if (at > hint + NEAR_WINDOW && best !== null) break;
  }
  return best;
}

/**
 * Re-attach only ABOVE this much resemblance; at or below it, detach.
 * `findFuzzy` seeds its best score with this value and accepts on `>`.
 */
export const FUZZY_FLOOR = 0.7;

/**
 * Last resort: find text that is CLOSE to `needle` but not equal to it.
 *
 * This is the step that decides whether a comment on a paragraph an agent
 * rewrote stays attached or goes grey. Three choices make it, and each one is
 * a judgement about which mistake is worse.
 *
 * HOW DIFFERENT is still the same passage: `FUZZY_FLOOR`, 0.7. Attaching
 * wrongly puts a comment on words it was never about, which is a lie.
 * Detaching wrongly makes a user think the app lost their work, which is a
 * scare. 0.7 re-attaches a reworded paragraph and lets a replaced one go.
 *
 * HOW FAR is the same place: `NEAR_WINDOW` around the old offset. Searching
 * the whole file would find a passage that moved, but it would also happily
 * jump to a similar-looking paragraph forty pages away — and on a document
 * full of repeated table rows that is the common case, not the rare one.
 *
 * WHAT IT COSTS: this runs for every comment on every live reload, and live
 * reload is the headline feature. Candidates are LINE-ALIGNED rather than
 * every substring offset, which makes it O(lines in the window) instead of
 * O(n·m). Edits respect lines, so the cheap set is also the right set.
 *
 * Whitespace is normalized and case ignored before comparing: an agent
 * reformatting a table changes a great deal of whitespace and no meaning.
 *
 * Contract:
 *   - `text`   the whole current file
 *   - `needle` the exact text stored when the comment was made
 *   - `hint`   the character offset the quote used to start at
 *   - returns  a `{ start, end }` range in `text`, or `null` to detach
 */
export function findFuzzy(
  text: string,
  needle: string,
  hint: number,
): { start: number; end: number } | null {
  const wanted = normalize(needle);
  if (wanted.length === 0) return null;

  // How many lines the stored quote spanned. A candidate is the same number
  // of lines starting at each line in the window, so a two-line quote is
  // compared against two-line candidates rather than against single lines.
  const span = Math.max(1, needle.split("\n").length);

  const starts = lineStartsNear(text, hint);
  let best: { start: number; end: number } | null = null;
  let bestScore = FUZZY_FLOOR;

  // The needle's bigrams are the same for every candidate, so they are built
  // once here rather than rebuilt inside `similarity` on each of the ~50-100
  // candidates in the window.
  const wantedGrams = bigrams(wanted);

  for (const start of starts) {
    const end = endOfLines(text, start, span);
    const candidate = normalize(text.slice(start, end));
    if (candidate.length === 0) continue;
    // Length alone rules most candidates out, and doing it first keeps the
    // expensive comparison off the ones that cannot possibly win.
    const ratio = Math.min(candidate.length, wanted.length) / Math.max(candidate.length, wanted.length);
    if (ratio < bestScore) continue;

    const score = diceWith(wantedGrams, wanted.length, candidate);
    // Strictly greater: on a tie the earlier candidate wins, and the window
    // is walked outward from `hint`, so that is the nearer one.
    if (score > bestScore) {
      bestScore = score;
      best = { start, end };
    }
  }
  return best;
}

/** Collapse runs of whitespace and drop case, so reformatting is not a change. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Offsets of the line starts within `NEAR_WINDOW` of `hint`, ordered by
 * distance from it. Nearest-first is what makes an early tie the right one.
 */
function lineStartsNear(text: string, hint: number): number[] {
  const from = Math.max(0, hint - NEAR_WINDOW);
  const to = Math.min(text.length, hint + NEAR_WINDOW);

  const starts: number[] = [];
  // The window rarely begins at a line boundary; walk back to the one that
  // contains it so a candidate is never a mid-line fragment.
  let at = text.lastIndexOf("\n", from) + 1;
  while (at <= to) {
    starts.push(at);
    const next = text.indexOf("\n", at);
    if (next === -1) break;
    at = next + 1;
  }
  return starts.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint));
}

/** End offset of `span` lines starting at `start`. */
function endOfLines(text: string, start: number, span: number): number {
  let at = start;
  for (let i = 0; i < span; i++) {
    const next = text.indexOf("\n", at);
    if (next === -1) return text.length;
    at = next + 1;
  }
  // Exclude the trailing newline: it is a separator, not content.
  return Math.max(start, at - 1);
}

/**
 * Resemblance in 0..1, by Sørensen–Dice over character bigrams.
 *
 * Chosen over edit distance because it is O(n) rather than O(n·m) — this runs
 * per comment per reload — and because it is insensitive to a moved clause,
 * which is exactly the edit an agent rewriting prose makes. A one-character
 * string has no bigrams, so that case is answered directly.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  return diceWith(bigrams(a), a.length, b);
}

/** Character-bigram counts of `s`. */
function bigrams(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const gram = s.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Dice against a bigram map built once by the caller.
 *
 * The map is CONSUMED as it matches, which is what stops a candidate of
 * repeated characters scoring a perfect match by claiming one bigram many
 * times — so the matched counts are restored before returning, and the same
 * map can serve the next candidate.
 */
function diceWith(aGrams: Map<string, number>, aLength: number, b: string): number {
  if (aLength < 2 || b.length < 2) return 0;

  let shared = 0;
  const taken: string[] = [];
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const left = aGrams.get(gram) ?? 0;
    if (left > 0) {
      aGrams.set(gram, left - 1);
      taken.push(gram);
      shared++;
    }
  }
  for (const gram of taken) {
    aGrams.set(gram, (aGrams.get(gram) ?? 0) + 1);
  }
  return (2 * shared) / (aLength - 1 + b.length - 1);
}

// ────────────────────────────────────────────────────────────────────────────
// Image pins
// ────────────────────────────────────────────────────────────────────────────

/**
 * A click on an image, as a Media Fragments percent region.
 *
 * Percent of the RENDERED box, so the same pin lands in the same place at any
 * zoom and on any screen. The 0-size box guard keeps a pin from becoming
 * `NaN%` when the image has not laid out yet.
 */
export function pinSelector(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
): Selector[] {
  if (box.width <= 0 || box.height <= 0) return [];
  return pinAtPercent(
    ((clientX - box.left) / box.width) * 100,
    ((clientY - box.top) / box.height) * 100,
  );
}

/**
 * A pin already expressed in percent — what the iframe bridge reports, since
 * only the frame knows the rendered box.
 *
 * THE one place the Media Fragments string is built. Both shells used to
 * format it by hand and both had lost the clamp, so a click a pixel outside a
 * rotated image stored a negative percentage.
 */
export function pinAtPercent(xPercent: number, yPercent: number): Selector[] {
  if (!Number.isFinite(xPercent) || !Number.isFinite(yPercent)) return [];
  // A pin is a point; the 0×0 region says so rather than inventing a size the
  // user did not draw.
  return [
    {
      type: "FragmentSelector",
      conformsTo: MEDIA_FRAGMENTS,
      value: `xywh=percent:${round2(clampPercent(xPercent))},${round2(clampPercent(yPercent))},0,0`,
    },
  ];
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
