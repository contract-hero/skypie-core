// pies.ts — pure helpers over user pies (M2). No React, no IPC: usePies.ts
// and Sky.tsx own the side effects; everything testable without a webview
// lives here (vitest here has no jsdom, no testing-library — every export
// below is a plain function over plain data).
import type { Pie, PieCensus } from "../ipc";
import type { DerivedPie, DerivedPieFile } from "./derived-pies";
import { kindOf } from "../render/kind";
import { censusToFiles, freshCount, isUserPieId } from "./derived-pies";

/** Re-exported from `derived-pies.ts`, where it lives beside the two
 *  built-in ids it tests against. Every import in this module now points
 *  ONE way — at `derived-pies.ts`, which imports nothing from here — so
 *  `pie-census.ts` can import `toDerivedPie` below without the two modules
 *  forming a cycle. */
export { isUserPieId } from "./derived-pies";

/** A user pie's FILE members, adapted to the same shape a derived pie's
 *  `files` already has, so `wedgesOf`/`groupByWedge` (derived-pies.ts) and
 *  `Pie`/`PiePlate` need no branch between "derived" and "user" pies.
 *  Folder members carry no files of their own until M3's census — they are
 *  dropped here, not zero-weighted, so a pie that is ALL folders reads as
 *  empty rather than as one phantom zero-share wedge. `mtime` stands in for
 *  `added_at`: there is no real file mtime without the M3 census. */
export function pieFiles(pie: Pie): DerivedPieFile[] {
  return pie.members
    .filter((m) => m.kind === "file")
    .map((m) => ({ path: m.path, kind: kindOf(m.path), mtime: m.added_at }));
}

/** Adapts a persisted `Pie` to `DerivedPie`'s shape — the one interface
 *  `Pie.tsx`/`PiePlate.tsx` already render against. `census`, when given
 *  (M3), REPLACES `pieFiles`'s pre-census fallback with real files (folder
 *  contents plus real mtimes) and adds `fresh`/`census`; omitted (or before
 *  the pie's first census resolves), this is exactly M2's behavior —
 *  `added_at`-keyed direct-file members only, no pill. */
export function toDerivedPie(pie: Pie, census?: PieCensus): DerivedPie {
  if (!census) {
    return { id: pie.id, name: pie.name, files: pieFiles(pie) };
  }
  const files = censusToFiles(census, pie.members);
  return {
    id: pie.id,
    name: pie.name,
    files,
    fresh: freshCount(files, pie.seen_at),
    census,
  };
}

/** Band order (spec section 3, "Resting"): built-in pies first, then user
 *  pies in their stored order — `userPies` arrives already in that order
 *  (`pies::list()` never sorts), so this is a plain concatenation, not a
 *  sort. The tin is NOT part of this list; Sky.tsx appends it as its own
 *  trailing element.
 *
 *  `derive` is REQUIRED, and is normally `usePieCensus().derive`: that one
 *  memoizes per pie id, so a census landing for ONE pie re-derives only
 *  that pie instead of the whole band. It used to be an optional
 *  `censusFor`, which silently fell back to the pre-census shape — a
 *  caller that forgot to pass it got a band with no freshness pills and no
 *  folder layers, and nothing said so. A caller with no census at all
 *  passes `toDerivedPie` itself. */
export function bandOrder(
  derived: DerivedPie[],
  userPies: Pie[],
  derive: (pie: Pie) => DerivedPie,
): DerivedPie[] {
  return [...derived, ...userPies.map(derive)];
}

/** Adds `id` to a pending-delete set, returning a NEW set (React state must
 *  not be mutated in place). Paired with `withoutPending` so the two
 *  overlapping-delete transitions are one testable pair rather than two
 *  inline `new Set(prev)` closures inside `usePies`. */
export function withPending(pending: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(pending);
  next.add(id);
  return next;
}

/** Removes `id` from a pending-delete set. Returns a new set, and leaves the
 *  OTHER ids alone — two deletes whose undo windows overlap must not clear
 *  each other, which is what a plain `setPendingDeletes(NO_PENDING)` did. */
export function withoutPending(pending: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(pending);
  next.delete(id);
  return next;
}

/** What `PiesProvider.openPicker` should do with a caller-supplied path,
 *  decided without touching React or the IPC surface so all three outcomes
 *  are testable directly.
 *
 *  - `refuse`: a `skypie-remote://` address — M2 has no remote pie members.
 *  - `canonicalize`: the normal path, resolved before the picker renders so
 *    `holdsPath`'s exact-string compare lines up with the stored members.
 *  - `open`: no `canonicalizePath` on this IPC surface (a test double, an
 *    older build) — open uncanonicalized rather than hang on a promise that
 *    will never resolve. */
export type PickerPathPlan =
  | { action: "refuse"; reason: string }
  | { action: "canonicalize"; path: string }
  | { action: "open"; path: string };

export function pickerPathPlan(
  path: string,
  canCanonicalize: boolean,
  isRemote: (p: string) => boolean,
): PickerPathPlan {
  if (isRemote(path)) return { action: "refuse", reason: "Can't add a pulled file to a pie yet" };
  return canCanonicalize ? { action: "canonicalize", path } : { action: "open", path };
}

/** Hides every pie whose delete is still inside its undo window
 *  (`usePies`'s `pendingDeletes`). The hook applies this to EVERY list it
 *  reconciles, including one that arrives on a `skypie://pies-updated`
 *  event from an unrelated write (another window's `touch_seen`, or M5's
 *  agent socket). Without it such an event replaced the local list with the
 *  server's still-has-it document and the deleted pie reappeared mid-undo.
 *  Returns the SAME array when nothing is pending, so the common case adds
 *  no new identity for React to re-render on. */
export function subtractPending(pies: Pie[], pending: ReadonlySet<string>): Pie[] {
  if (pending.size === 0) return pies;
  return pies.filter((p) => !pending.has(p.id));
}

/** Whether `pie` already holds `path` as a member — the picker's check
 *  mark (spec section 6). An EXACT string compare against the stored
 *  (always canonical) member paths, which is why `openPicker` canonicalizes
 *  before the picker renders: a non-canonical form of the very same file
 *  answers false here. */
export function holdsPath(pie: Pie, path: string): boolean {
  return pie.members.some((m) => m.path === path);
}

/** `wanted`, or `wanted` with the lowest " N" (N ≥ 2) suffix that isn't
 *  already a pie's name — the tin's own create flow never NEEDS this (the
 *  spec's create step is "type a name, Enter", no de-dup rule stated), but
 *  a Finder-drop pie named after a folder (M4) collides far more easily
 *  than a typed name, and the rename flow benefits the same way, so the
 *  helper lives here now rather than being bolted on per call site later. */
export function uniqueName(pies: Pie[], wanted: string): string {
  const trimmed = wanted.trim();
  const taken = new Set(pies.map((p) => p.name));
  if (!taken.has(trimmed)) return trimmed;
  let n = 2;
  while (taken.has(`${trimmed} ${n}`)) n += 1;
  return `${trimmed} ${n}`;
}
/** M4, deep-link reveal (spec section 7, "What happens to the old
 *  sidebar" / "Deep-link reveal"): the first USER pie whose `files`
 *  include `path` exactly, or `null`. Built-ins are excluded — only a user
 *  pie has persisted MEMBERS, which is the thing "the path is a pie
 *  member" means; Pinned/Recent are a live view over the bookmarks/
 *  recents stores, not membership. Exported on its own (not inlined into
 *  `revealRoute` below) so `App.tsx` can reuse the SAME lookup to learn
 *  WHICH pie to arm the plate on, instead of computing it a second,
 *  possibly different way. */
export function pieHoldingPath(pies: DerivedPie[], path: string): DerivedPie | null {
  return pies.find((p) => isUserPieId(p.id) && p.files.some((f) => f.path === path)) ?? null;
}

/**
 * The deep-link reveal ROUTE (spec section 7): the sidebar visible (and
 * not reader mode, which unmounts it) reveals in the tree exactly as
 * before M4; else, when `path` is a user pie's member, the sky opens on
 * that pie's plate instead; else the sidebar itself is shown so the tree
 * can reveal. Pure so `App.tsx`'s branch is one call instead of an inline
 * if/else chain, and testable here without a webview (pies.test.ts).
 *
 * A folder member whose census hasn't resolved yet is NOT in `files` (the
 * census is what turns a folder member into individual file rows) —
 * `App.tsx`'s own comment on this exact gap explains why "show-sidebar" is
 * the acceptable fallback rather than a hard failure to reveal at all.
 *
 * Reader mode routes the SAME as sidebar-hidden ("plate", when a pie holds
 * `path`) rather than getting its own branch — reader mode already
 * unmounts the sidebar, so there is nothing left to distinguish. `App.tsx`
 * is the one that makes this route VISIBLE: it leaves reader mode
 * (`setReaderMode(false)`) in the "plate" branch, since Sky only mounts
 * when `!readerMode` — without that, a reveal received mid-read was a
 * silent no-op until the user left reader mode by hand (review fix,
 * App.tsx:454).
 */
export function revealRoute(
  sidebarVisible: boolean,
  readerMode: boolean,
  pies: DerivedPie[],
  path: string,
): "tree" | "plate" | "show-sidebar" {
  if (sidebarVisible && !readerMode) return "tree";
  return pieHoldingPath(pies, path) ? "plate" : "show-sidebar";
}
