// Anchors in the HOST DOM — Markdown, code, plain text and image files.
//
// Those renderers paint into the app's own document, so the host can walk
// them directly; an HTML artifact lives in a frame and answers the same
// questions over the bridge instead:
//
//   1. `pickInHost`      — the tool was clicked here; what did it mean?
//   2. `pendingForPick`  — turn that into the selectors a comment stores.
//   3. `locateInHost`    — where is each stored anchor on screen right now?
//   4. `revealAnchor`    — scroll one into view.
//
// The last of those is the one place that also speaks for the frame: the
// host cannot scroll inside a sandbox, so it asks the frame to do it. Every
// other function here is host-only.
//
// Placement works in terms of SOURCE lines. A code file's lines are `.line`
// spans (shiki's shape, which the plain fallback copies); a Markdown block
// carries the source line it starts on as `data-source-line` (see
// md-blocks.ts). Both can be present at once — shiki highlights fences
// inside rendered Markdown — and the blocks win when they are.

import { pinAtPercent, selectorsForLine } from "./anchor";
import type { Anchored } from "./anchor";
import { showAnchorInPreview } from "./bridge";
import type { PendingSelection } from "./bridge";
import { cssOf, regionOf, selectorOf } from "./types";
import type { Target } from "./types";

export type HostPick =
  | { kind: "line"; line: number; element: Element }
  | { kind: "block"; line: number; element: Element }
  | { kind: "image"; element: HTMLImageElement; x: number; y: number };

/**
 * What a click at `target` inside `container` points at, or null when it
 * landed on nothing a comment can be about.
 */
export function pickInHost(
  container: HTMLElement,
  target: Element,
  clientX: number,
  clientY: number,
): HostPick | null {
  const img = target.closest("img");
  if (img && container.contains(img)) {
    const box = img.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return {
      kind: "image",
      element: img,
      x: ((clientX - box.left) / box.width) * 100,
      y: ((clientY - box.top) / box.height) * 100,
    };
  }
  // A rendered Markdown BLOCK wins over a `.line` inside it. Shiki puts a
  // `.line` span on every row of a highlighted code fence, and a fence is one
  // top-level block of the Markdown source — so a click on row 3 of a fence
  // that starts at source line 200 means line 200, not line 3.
  const block = target.closest("[data-source-line]");
  if (block && container.contains(block)) {
    const n = Number.parseInt(block.getAttribute("data-source-line") ?? "", 10);
    return Number.isFinite(n) && n > 0 ? { kind: "block", line: n, element: block } : null;
  }
  const line = target.closest(".line");
  if (line && container.contains(line)) {
    const n = lineIndexOf(line);
    return n === null ? null : { kind: "line", line: n, element: line };
  }
  return null;
}

/**
 * The target a pick becomes, ready for the composer.
 *
 * THE one place a host-side pick is turned into stored selectors, so the
 * desktop shell and the phone shell cannot drift in what they store or in
 * what the composer calls it. The frame's side of the same job lives in
 * `readBridgeMessage`.
 */
export function pendingForPick(pick: HostPick, docText: string): PendingSelection | null {
  if (pick.kind === "image") {
    const region = pinAtPercent(pick.x, pick.y);
    // No usable coordinates, no anchor. A target with an empty selector set
    // would re-anchor as detached for ever; `readBridgeMessage` refuses the
    // same input on the frame's side, and the two must agree.
    if (region.length === 0) return null;
    // WHICH image, not just where on it. A report with three charts resolved
    // every pin to the first one, and because the identity was never written
    // the mis-attachment could not be recovered afterwards.
    const css = cssPathOf(pick.element);
    const alt = pick.element.getAttribute("alt") ?? "";
    return {
      exact: alt,
      label: "Pin on image",
      selector: css ? [{ type: "CssSelector", value: css }, ...region] : region,
    };
  }
  const selector = selectorsForLine(docText, pick.line);
  const quote = selectorOf({ source: "", selector }, "TextQuoteSelector");
  return {
    exact: quote?.exact ?? "",
    label: pick.kind === "line" ? `Line ${pick.line}` : `Block at line ${pick.line}`,
    selector,
  };
}

/**
 * A CSS path from the rendered document down to `el`.
 *
 * The host's counterpart to the frame's `cssPath` — same vocabulary, same
 * `tag:nth-of-type(n)` steps, so an anchor reads the same whichever side
 * wrote it. It stops at the render container rather than at `<body>`,
 * because everything above that is app chrome the artifact does not own.
 */
function cssPathOf(el: Element): string | null {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.tagName !== "BODY") {
    if (node.hasAttribute("data-source-line") || node.classList.contains("image-renderer")) break;
    const tag = node.tagName.toLowerCase();
    let n = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) n++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${tag}:nth-of-type(${n})`);
    node = node.parentElement;
  }
  return parts.length > 0 ? parts.join(" > ") : null;
}

/** The 1-based index of a `.line` span among its siblings. */
function lineIndexOf(line: Element): number | null {
  const parent = line.parentElement;
  if (!parent) return null;
  const all = parent.querySelectorAll(":scope > .line");
  for (let i = 0; i < all.length; i++) if (all[i] === line) return i + 1;
  return null;
}

/**
 * The document's lines, collected ONCE.
 *
 * `locateInHost` runs on every scroll frame, so a per-anchor `querySelectorAll`
 * would cost (comments × lines) element collections per frame — on a 5000-line
 * file with 20 comments, 100k per frame. One scan serves every anchor instead.
 */
interface LineIndex {
  /** `.line` spans, in document order: line N is `lines[N - 1]`. */
  lines: NodeListOf<Element> | null;
  /** Markdown blocks with the source line each one starts on, ascending. */
  blocks: { line: number; el: Element }[] | null;
  /** The first image or drawing, which is where an image pin lands. */
  image: Element | null;
}

function indexOf(container: HTMLElement): LineIndex {
  // Markdown FIRST. A `.line` span means "this document is code" only when
  // the document has no source-line blocks: shiki puts `.line` on every row
  // of a highlighted fence, so a Markdown file with one code block has both,
  // and answering with the fence's rows sent every note in the file into it.
  const marked = container.querySelectorAll("[data-source-line]");
  if (marked.length > 0) {
    const blocks: { line: number; el: Element }[] = [];
    for (const el of Array.from(marked)) {
      const line = Number.parseInt(el.getAttribute("data-source-line") ?? "", 10);
      if (Number.isFinite(line)) blocks.push({ line, el });
    }
    return { lines: null, blocks, image: container.querySelector("img, svg") };
  }
  const lines = container.querySelectorAll(".line");
  if (lines.length > 0) return { lines, blocks: null, image: null };
  return { lines: null, blocks: [], image: container.querySelector("img, svg") };
}

/** The element that stands for source line `line`, when the DOM has one. */
function elementForLine(index: LineIndex, line: number): Element | null {
  if (index.lines) return index.lines[Math.min(index.lines.length, line) - 1] ?? null;
  // Markdown: the block that starts at or nearest above the line.
  let best: Element | null = null;
  let bestLine = 0;
  for (const block of index.blocks ?? []) {
    if (block.line <= line && block.line >= bestLine) {
      best = block.el;
      bestLine = block.line;
    }
  }
  return best;
}

/** What `locateInHost` needs of an anchor — an id, where it points, its line. */
export interface LocatableAnchor {
  id: string;
  target: Target;
  line: number | null;
}

/** The locatable view of a placed annotation. */
export function locatable(a: Anchored): LocatableAnchor {
  return { id: a.annotation.id, target: a.annotation.target, line: a.line };
}

/**
 * Scroll a thread's anchor into view, wherever the document lives.
 *
 * THE one place that choice is made. The frame does it itself, because only
 * it has the layout inside the sandbox; the host walks its own DOM. Both
 * shells call this rather than each branching on `isFrame` again.
 */
export function revealAnchor(
  container: HTMLElement | null,
  anchored: Anchored,
  isFrame: boolean,
  behavior: ScrollBehavior = "auto",
): void {
  if (isFrame) {
    showAnchorInPreview(locatable(anchored), true);
    return;
  }
  if (!container) return;
  locateInHost(container, [locatable(anchored)])[0]?.element?.scrollIntoView({
    block: "center",
    behavior,
  });
}

export interface HostLocation {
  id: string;
  /** Client-space top of the anchor, or null when it is not on this page. */
  top: number | null;
  element: Element | null;
}

/** Where each placed anchor sits on screen, in client coordinates. */
export function locateInHost(
  container: HTMLElement,
  anchors: LocatableAnchor[],
): HostLocation[] {
  if (anchors.length === 0) return [];
  const index = indexOf(container);
  return anchors.map((a) => {
    const region = regionOf(a.target);
    if (region) {
      // The stored path names WHICH image; the first one in the document is
      // only the fallback for a pin made before paths were recorded.
      const css = cssOf(a.target);
      let img: Element | null = null;
      if (css) {
        try {
          img = container.querySelector(css);
        } catch {
          img = null;
        }
      }
      img = img ?? index.image ?? container.querySelector("img, svg");
      if (!img) return { id: a.id, top: null, element: null };
      const box = img.getBoundingClientRect();
      // A pin is a point: the note sits level with it, not with the image.
      return { id: a.id, top: box.top + box.height * (region.y / 100) - 6, element: img };
    }
    if (a.line === null) return { id: a.id, top: null, element: null };
    const el = elementForLine(index, a.line);
    if (!el) return { id: a.id, top: null, element: null };
    return { id: a.id, top: el.getBoundingClientRect().top, element: el };
  });
}
