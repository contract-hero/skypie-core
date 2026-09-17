// pies.ts — pure helpers over user pies (M2). No React, no IPC: usePies.ts
// and Sky.tsx own the side effects; everything testable without a webview
// lives here (vitest here has no jsdom, no testing-library — every export
// below is a plain function over plain data).
import type { Pie, PieCensus } from "../ipc";
import type { DerivedPie, DerivedPieFile } from "./derived-pies";
import { kindOf } from "../render/kind";
import { censusToFiles, freshCount, newestPath } from "./pie-census";

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
 *  contents plus real mtimes) and adds `fresh`/`newestFreshPath`/`census`;
 *  omitted (or before the pie's first census resolves), this is exactly
 *  M2's behavior — `added_at`-keyed direct-file members only, no pill. */
export function toDerivedPie(pie: Pie, census?: PieCensus): DerivedPie {
  if (!census) {
    return { id: pie.id, name: pie.name, files: pieFiles(pie) };
  }
  const files = censusToFiles(census, pie.members);
  const fresh = freshCount(files, pie.seen_at);
  return {
    id: pie.id,
    name: pie.name,
    files,
    fresh,
    newestFreshPath: fresh > 0 ? newestPath(files) ?? undefined : undefined,
    census,
  };
}

/** Band order (spec section 3, "Resting"): built-in pies first, then user
 *  pies in their stored order — `userPies` arrives already in that order
 *  (`pies::list()` never sorts), so this is a plain concatenation, not a
 *  sort. The tin is NOT part of this list; Sky.tsx appends it as its own
 *  trailing element. `censusFor` (M3, `usePieCensus().censusFor`) is
 *  optional — omitted, every user pie falls back to `toDerivedPie`'s own
 *  pre-census behavior, which is what lets a bare `IpcSurface` test double
 *  or an older `bandOrder(derived, userPies)` call site keep compiling. */
export function bandOrder(
  derived: DerivedPie[],
  userPies: Pie[],
  censusFor?: (id: string) => PieCensus | undefined,
): DerivedPie[] {
  return [...derived, ...userPies.map((p) => toDerivedPie(p, censusFor?.(p.id)))];
}

/** Pairs with `insertPieAt` for the 5-second delete undo (Sky.tsx):
 *  removing a pie from local state is optimistic and does NOT itself call
 *  `removePie` — the caller defers that IPC call until the undo window
 *  closes, so undoing never has to reconstruct a pie the backend already
 *  forgot. */
export function withoutPie(pies: Pie[], id: string): Pie[] {
  return pies.filter((p) => p.id !== id);
}

/** The undo half of `withoutPie`: re-insert `pie` at `index` (clamped into
 *  range), restoring the exact array shape a delete removed it from. */
export function insertPieAt(pies: Pie[], pie: Pie, index: number): Pie[] {
  const next = pies.slice();
  const at = Math.max(0, Math.min(next.length, index));
  next.splice(at, 0, pie);
  return next;
}

/** Whether `pie` already holds `path` as a member — the picker's check
 *  mark (spec section 6). */
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

/** True for a user pie's id — every built-in pie's id is a fixed
 *  `"builtin:…"` literal (`derived-pies.ts`), and no user pie can ever be
 *  minted with that prefix (`uuid::Uuid::now_v7()` never produces one). */
export function isUserPieId(id: string): boolean {
  return !id.startsWith("builtin:");
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
