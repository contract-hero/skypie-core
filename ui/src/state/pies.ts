// pies.ts — pure helpers over user pies (M2). No React, no IPC: usePies.ts
// and Sky.tsx own the side effects; everything testable without a webview
// lives here (vitest here has no jsdom, no testing-library — every export
// below is a plain function over plain data).
import type { Pie, PieCensus } from "../ipc";
import type { DerivedPie, DerivedPieFile } from "./derived-pies";
import { basename } from "../utils/path";
import { kindOf } from "../render/kind";
import { censusToFiles, freshCount, isUserPieId } from "./derived-pies";
// `DropTarget` is what the hit test produces and `dropPieName` is the name
// rule for a tin drop; both belong beside the hook that owns the drag
// stream, so `dropPlan` below imports them rather than restating either.
// `finder-drop.test.ts` already imports that module under the same
// jsdom-free vitest run, so this costs this file's own tests nothing.
import { dropPieName } from "../hooks/useFinderDrop";
import type { DropTarget } from "../hooks/useFinderDrop";

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
    .map((m) => ({ path: m.path, name: basename(m.path), kind: kindOf(m.path), mtime: m.added_at }));
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

/** Raises each pie's `seen_at` to its own floor, when it has one — the
 *  optimistic half of `touchPieSeen` (usePies.ts), applied to EVERY list the
 *  hook reconciles rather than only to the one the touch itself produced.
 *
 *  The floor exists because the two writers are not ordered. `touchPieSeen`
 *  stamps `seen_at` locally and then awaits the IPC call; a
 *  `skypie://pies-updated` event from an unrelated writer — M5's agent
 *  socket, which emits at arbitrary times — can land inside that window
 *  carrying the pie's OLD `seen_at`. Accepting it verbatim reverted the
 *  stamp, so the fresh-file pill and the plate's "new" dots fired for the
 *  very pie the user is looking at. Shaped like `pendingDeletes`: a per-id
 *  value, applied on the way out, cleared once the write it stands for has
 *  settled.
 *
 *  Only ever RAISES a value (`Math.max` by another name), so a server
 *  document that is already newer than the floor — a `touch_seen` from
 *  another window — still wins. Returns the SAME array when no floor
 *  applies, so the common case adds no new identity for React to
 *  re-render on. */
export function applySeenFloors(pies: Pie[], floors: ReadonlyMap<string, number>): Pie[] {
  if (floors.size === 0) return pies;
  let raised = false;
  const next = pies.map((p) => {
    const floor = floors.get(p.id);
    if (floor === undefined || p.seen_at >= floor) return p;
    raised = true;
    return { ...p, seen_at: floor };
  });
  return raised ? next : pies;
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
/** Whether `pie`'s (census-resolved) files include `path` exactly. The one
 *  membership test M4's two "which pie holds this file?" call sites share
 *  — the band's passive active-file mark (Sky.tsx) and deep-link reveal
 *  routing (`pieHoldingPath` below) — so the ring and the route can never
 *  disagree about the same file. An EXACT compare: both callers hand it a
 *  canonicalized path, because stored member paths are always canonical
 *  (`pies::add_member`).
 *
 *  Deliberately NOT `holdsPath` above: that one tests a persisted `Pie`'s
 *  MEMBERS (what the picker's check mark means), this one tests a
 *  `DerivedPie`'s resolved FILES, which a folder member expands into. */
export function holdsFilePath(pie: DerivedPie, path: string): boolean {
  return pie.files.some((f) => f.path === path);
}

/** M4, deep-link reveal (spec section 7, "What happens to the old
 *  sidebar" / "Deep-link reveal"): the first USER pie holding `path`, or
 *  `null`. Built-ins are excluded — only a user pie has persisted MEMBERS,
 *  which is the thing "the path is a pie member" means; Pinned/Recent are
 *  a live view over the bookmarks/recents stores, not membership. The
 *  active-file MARK keeps the opposite scope (any pie, built-ins
 *  included): a mark only says "this file is in here", which is true of
 *  Pinned and Recent, while a reveal must land somewhere the user can act
 *  on. Exported on its own (not inlined into `revealRoute` below) so
 *  `App.tsx` can reuse the SAME lookup to learn WHICH pie to arm the plate
 *  on, instead of computing it a second, possibly different way. */
export function pieHoldingPath(pies: DerivedPie[], path: string): DerivedPie | null {
  return pies.find((p) => isUserPieId(p.id) && holdsFilePath(p, path)) ?? null;
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
 * silent no-op until the user left reader mode by hand (review fix on
 * `handleDeepLinkIntent`).
 *
 * The two booleans arrive as ONE named posture object, not as two adjacent
 * positional flags: `revealRoute(true, false, …)` and `revealRoute(false,
 * true, …)` are both type-correct and mean opposite things, and nothing at
 * the call site said which was which.
 */
export interface RevealPosture {
  sidebarVisible: boolean;
  readerMode: boolean;
}

export function revealRoute(
  posture: RevealPosture,
  pies: DerivedPie[],
  path: string,
): "tree" | "plate" | "show-sidebar" {
  if (posture.sidebarVisible && !posture.readerMode) return "tree";
  return pieHoldingPath(pies, path) ? "plate" : "show-sidebar";
}

/** What a Finder drop on `target` MEANS (M4, spec section 6), decided
 *  without React, IPC or a DOM so all five outcomes are testable directly.
 *  `Sky.tsx`'s `handleFinderDrop` is the effects half: it executes one of
 *  these and holds no target branching of its own.
 *
 *  - `ignore`: nothing under the drop point. Silent by decision — no ring
 *    was showing over anything either, so there is nothing to explain.
 *  - `create`: the tin. `name` still needs `uniqueName` from the caller,
 *    which is the one holding the current pie list.
 *  - `refuse`: Pinned or Recent — derived views, they hold no members.
 *  - `vanished`: a pie id no longer in the band (another window deleted it
 *    between the ring and the release). The user saw a ring and let go, so
 *    this is REPORTED, not dropped silently.
 *  - `add`: the ordinary case. */
export type DropPlan =
  | { action: "ignore" }
  | { action: "create"; name: string }
  | { action: "refuse"; reason: string }
  | { action: "vanished"; reason: string }
  | { action: "add"; pieId: string };

export function dropPlan(target: DropTarget | null, pies: DerivedPie[], paths: string[]): DropPlan {
  if (!target) return { action: "ignore" };
  if (target.kind === "tin") return { action: "create", name: dropPieName(paths) };
  const pie = pies.find((p) => p.id === target.id);
  if (!pie) return { action: "vanished", reason: "That pie is gone — nothing was added" };
  if (!isUserPieId(pie.id)) return { action: "refuse", reason: "Pinned and Recent are built for you" };
  return { action: "add", pieId: pie.id };
}
