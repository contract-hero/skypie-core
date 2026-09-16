// The annotation shapes, mirroring `src-tauri/src/annotations.rs`.
//
// A W3C Web Annotation subset in plain JSON: the property names are the
// recommendation's, the JSON-LD machinery is not. Keep these in step with the
// Rust structs — serde writes exactly these keys.

export type Status = "open" | "addressed" | "wontfix";

export type Motivation = "commenting" | "replying" | "highlighting" | "assessing";

export interface Creator {
  /** `node:<hex>` — the iroh node id this device already owns. */
  id: string;
  name?: string | null;
}

export interface Body {
  type: string;
  value: string;
}

/** Exact text plus context. The anchor that survives an edit above it. */
export interface TextQuoteSelector {
  type: "TextQuoteSelector";
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
}

/** Character offsets. Fast, and stale the moment anything above changes. */
export interface TextPositionSelector {
  type: "TextPositionSelector";
  start: number;
  end: number;
}

/**
 * `line=142` (RFC 5147) for text, `xywh=percent:31,18,4,4` (Media Fragments)
 * for an image region. Percent, never pixels: a pin dropped on a phone has to
 * land in the same place on a 27" display.
 */
export interface FragmentSelector {
  type: "FragmentSelector";
  conformsTo?: string | null;
  value: string;
}

/**
 * A CSS path to the element a comment is about, as
 * `main:nth-of-type(1) > p:nth-of-type(3)` — every step carries its
 * `nth-of-type`, cut short at the nearest unique id. It holds only while the
 * structure does; the quote stored beside it is what finds the words again
 * after a rewrite. An HTML artifact's path is resolved inside its frame; a
 * pin on an image the host rendered names the image the same way.
 */
export interface CssSelector {
  type: "CssSelector";
  value: string;
}

export type Selector =
  | TextQuoteSelector
  | TextPositionSelector
  | FragmentSelector
  | CssSelector
  /** A selector kind this build does not understand. Preserved, not dropped. */
  | { type: string; [k: string]: unknown };

export const RFC5147 = "http://tools.ietf.org/rfc/rfc5147";
export const MEDIA_FRAGMENTS = "http://www.w3.org/TR/media-frags/";

export interface Target {
  /** Absolute path, or `skypie-remote://<peer><path>` for a pulled file. */
  source: string;
  /** `blake3:<hex>` of the file when the comment was made. */
  hash?: string | null;
  selector: Selector[];
}

export interface Annotation {
  /** UUIDv7 — sorting by id is sorting by time. */
  id: string;
  type: string;
  motivation: Motivation;
  /** RFC 3339, UTC. */
  created: string;
  creator: Creator;
  session?: string | null;
  inReplyTo?: string | null;
  status: Status;
  body?: Body | null;
  target: Target;
}

/** One row of the annotations index — what the sidebar badges from. */
export interface AnnotationIndexEntry {
  source: string;
  open: number;
  total: number;
  updated_at: number;
}

/** A root comment with its replies, which is the unit the UI renders. */
export interface Thread {
  root: Annotation;
  replies: Annotation[];
}

/**
 * Group a flat annotation list into threads, preserving file order.
 *
 * A reply whose parent is missing — possible when a peer pushed the reply but
 * not the root — is promoted to a root of its own rather than dropped. Losing
 * someone's words because a different line did not arrive is the worse bug.
 */
export function toThreads(all: Annotation[]): Thread[] {
  const roots = new Map<string, Thread>();
  const orphans: Annotation[] = [];

  for (const a of all) {
    if (!a.inReplyTo) roots.set(a.id, { root: a, replies: [] });
  }
  for (const a of all) {
    if (!a.inReplyTo) continue;
    const parent = roots.get(a.inReplyTo);
    if (parent) parent.replies.push(a);
    else orphans.push(a);
  }

  return [...roots.values(), ...orphans.map((root) => ({ root, replies: [] }))];
}

export function isOpen(thread: Thread): boolean {
  return thread.root.status === "open";
}

/** The first selector of a given kind, or undefined. */
export function selectorOf<T extends Selector["type"]>(
  target: Target,
  type: T,
): Extract<Selector, { type: T }> | undefined {
  return target.selector.find((s) => s.type === type) as
    | Extract<Selector, { type: T }>
    | undefined;
}

/** The 1-based line a text anchor points at, when it carries one. */
export function lineOf(target: Target): number | null {
  const frag = target.selector.find(
    (s): s is FragmentSelector =>
      s.type === "FragmentSelector" && typeof s.value === "string" && s.value.startsWith("line="),
  );
  if (!frag) return null;
  const n = Number.parseInt(frag.value.slice("line=".length), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The CSS path of an element anchor, when the target carries one. */
export function cssOf(target: Target): string | null {
  const css = target.selector.find(
    (s): s is CssSelector => s.type === "CssSelector" && typeof s.value === "string",
  );
  return css && css.value ? css.value : null;
}

/** `{ x, y, w, h }` in percent for an image pin, when the anchor is one. */
export function regionOf(
  target: Target,
): { x: number; y: number; w: number; h: number } | null {
  const frag = target.selector.find(
    (s): s is FragmentSelector =>
      s.type === "FragmentSelector" &&
      typeof s.value === "string" &&
      s.value.startsWith("xywh=percent:"),
  );
  if (!frag) return null;
  const nums = frag.value.slice("xywh=percent:".length).split(",").map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums as [number, number, number, number];
  return { x, y, w, h };
}
