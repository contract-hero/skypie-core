// The iframe bridge, on the host side.
//
// A rendered artifact runs in a sandboxed iframe, so the host cannot read into
// it. Everything the comment feature needs from the page crosses here as a
// message: the rendered text (which only the frame can see), the element the
// comment tool picked (with a CSS path only the frame can compute), a spot on
// an image (as a percentage of the rendered box, which only the frame can
// measure), and — for the margin notes — where each stored anchor sits on
// screen right now, which the frame re-reports as it scrolls.
//
// It exists because the desktop shell and the phone shell BOTH consume the
// bridge, and they each had their own copy of this parsing. One producer
// beside the parsers (`regionOf`, `lineOf`, `cssOf`) keeps the anchor
// vocabulary in one module, and every payload is validated here: it crosses
// from a frame running untrusted artifact content, which can post this shape
// deliberately. The worst it can achieve is a comment anchored where it did
// not mean, but the host must not read `undefined` as a number on the way.

import { pinAtPercent, selectorsForElement } from "./anchor";
import { cssOf, regionOf, selectorOf } from "./types";
import type { Selector, Target } from "./types";

/** What the frame needs to find an anchor: an id to answer with, a target. */
export interface AnchorRef {
  id: string;
  target: Target;
}

/** A target waiting for a comment body. */
export interface PendingSelection {
  /** What the composer shows as the quoted target. */
  exact: string;
  /** "Line 42", "Paragraph", "Pin on chart.png" — the target's kind. */
  label: string;
  selector: Selector[];
}

/** What a pick produced, and the text it was measured in. */
export interface BridgeSelection {
  pending: PendingSelection;
  /**
   * The artifact's rendered text, for re-anchoring. Empty for an image pin,
   * which has no text to search.
   */
  text: string;
}

/** Where one anchor sits, in the frame's viewport. `top` null = not found. */
export interface LocatedAnchor {
  id: string;
  top: number | null;
}

export type BridgeMessage =
  | BridgeSelection
  | { text: string }
  | { located: LocatedAnchor[] };

/** The element kinds the frame reports, as a reader would name them. */
export function labelForTag(tag: string): string {
  const t = tag.toLowerCase();
  if (/^h[1-6]$/.test(t)) return "Heading";
  const names: Record<string, string> = {
    p: "Paragraph",
    li: "List item",
    pre: "Code block",
    table: "Table",
    tr: "Table row",
    td: "Table cell",
    th: "Table cell",
    blockquote: "Quote",
    figure: "Figure",
    img: "Image",
    svg: "Drawing",
    section: "Section",
    article: "Article",
    aside: "Aside",
    dt: "Term",
    dd: "Definition",
    summary: "Summary",
    details: "Details",
    button: "Button",
  };
  return names[t] ?? "Block";
}

/**
 * Read one `postMessage` from a preview iframe.
 *
 * Returns a `BridgeSelection` when the tool picked something, the rendered
 * text alone when the page reported it on load, the anchor positions when
 * the frame located them, or `null` for a message this module does not
 * handle.
 */
export function readBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  // The rendered text, reported once the artifact has laid out. Carries no
  // pending target — it exists so the host can re-anchor the comments a
  // file ALREADY has, which otherwise search an empty string and all come
  // back detached.
  if (d.type === "skypie:documentText") {
    return typeof d.text === "string" ? { text: d.text } : null;
  }

  if (d.type === "skypie:elementPick") {
    if (typeof d.css !== "string" || d.css.length === 0) return null;
    if (typeof d.text !== "string" || typeof d.exact !== "string") return null;
    const start = typeof d.start === "number" && Number.isFinite(d.start) ? d.start : 0;
    const tag = typeof d.tag === "string" ? d.tag : "";
    return {
      pending: {
        exact: d.exact,
        label: labelForTag(tag),
        selector: selectorsForElement(d.css, d.text, start, d.exact),
      },
      text: d.text,
    };
  }

  if (d.type === "skypie:imagePin") {
    if (typeof d.x !== "number" || typeof d.y !== "number") return null;
    const region = pinAtPercent(d.x, d.y);
    if (region.length === 0) return null;
    const label = typeof d.alt === "string" && d.alt ? d.alt : "image";
    // Inside an HTML artifact the pin also carries the image's CSS path, so
    // the frame can find the right image again on a page with several.
    const selector: Selector[] =
      typeof d.css === "string" && d.css ? [{ type: "CssSelector", value: d.css }, ...region] : region;
    // An image pin carries no text: there is nothing for a re-anchor pass to
    // search, and the pin's percentages survive on their own.
    return { pending: { exact: label, label: "Pin on image", selector }, text: "" };
  }

  if (d.type === "skypie:located") {
    if (!Array.isArray(d.items)) return null;
    const located: LocatedAnchor[] = [];
    for (const item of d.items) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (typeof it.id !== "string") continue;
      const top = typeof it.top === "number" && Number.isFinite(it.top) ? it.top : null;
      located.push({ id: it.id, top });
    }
    return { located };
  }

  return null;
}

function frames(): Window[] {
  const out: Window[] = [];
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    if (frame.contentWindow) out.push(frame.contentWindow);
  }
  return out;
}

/** What the frame needs to find one anchor again. */
function keyOf({ id, target }: AnchorRef): {
  id: string;
  css: string | null;
  exact: string | null;
  region: { x: number; y: number } | null;
} {
  const quote = selectorOf(target, "TextQuoteSelector");
  const region = regionOf(target);
  return {
    id,
    css: cssOf(target),
    exact: quote?.exact || null,
    region: region ? { x: region.x, y: region.y } : null,
  };
}

/**
 * Ask every preview iframe to scroll to a thread's anchor and paint it.
 *
 * The frame does the work because only it has the layout. Broadcasting to all
 * frames rather than tracking the active one is deliberate: exactly one
 * preview is mounted at a time, and a frame that does not hold the anchor
 * simply finds nothing.
 */
export function showAnchorInPreview(ref: AnchorRef, scroll = true): void {
  const key = keyOf(ref);
  if (!key.css && !key.exact && !key.region) return;
  for (const win of frames()) {
    win.postMessage({ type: "skypie:showAnchor", ...key, scroll }, "*");
  }
}

/** Take the painted anchor off the page. */
export function clearAnchorInPreview(): void {
  for (const win of frames()) win.postMessage({ type: "skypie:showAnchor", clear: true }, "*");
}

/** Turn the comment tool on or off inside the frame. */
export function setToolInPreview(on: boolean): void {
  for (const win of frames()) win.postMessage({ type: "skypie:tool", on }, "*");
}

/**
 * Hand the frame the anchors to keep located. It answers with
 * `skypie:located` now and again on every scroll and resize, so the margin
 * notes follow the document.
 */
export function locateInPreview(anchors: AnchorRef[]): void {
  const items = anchors.map(keyOf);
  for (const win of frames()) win.postMessage({ type: "skypie:locate", items }, "*");
}

/**
 * Run `cb` whenever a preview frame finishes loading, and once now.
 *
 * Every message above is fire-and-forget into a frame that may not exist yet,
 * and a frame that reloads (live reload rewrites the artifact constantly)
 * comes back with none of the state the host sent it. Each caller used to
 * carry its own copy of this listener; one subscription is what keeps a new
 * frame-facing call from forgetting the second half. Returns an unsubscribe.
 */
export function onPreviewLoad(cb: () => void): () => void {
  cb();
  // Listened for on the DOCUMENT, in capture phase, not on the iframe that
  // happens to exist right now. A tab shows "Loading…" until its payload
  // arrives, so there is always a commit where the path is set and no frame
  // is mounted yet — a listener bound to `querySelector("iframe")` then
  // binds to nothing, never fires, and the tool stays dead inside the frame
  // until the user toggles it off and on. `load` does not bubble, but it
  // does capture, and this catches a replacement frame too.
  const onLoad = (e: Event): void => {
    if ((e.target as Element | null)?.tagName === "IFRAME") cb();
  };
  document.addEventListener("load", onLoad, true);
  return () => document.removeEventListener("load", onLoad, true);
}
