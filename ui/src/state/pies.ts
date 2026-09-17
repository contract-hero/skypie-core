// pies.ts — pure helpers over user pies (M2). No React, no IPC: usePies.ts
// and Sky.tsx own the side effects; everything testable without a webview
// lives here (vitest here has no jsdom, no testing-library — every export
// below is a plain function over plain data).
import type { Pie } from "../ipc";
import { BUILTIN_PINNED_ID, BUILTIN_RECENT_ID } from "./derived-pies";
import type { DerivedPie, DerivedPieFile } from "./derived-pies";
import { kindOf } from "../render/kind";

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
 *  `Pie.tsx`/`PiePlate.tsx` already render against (M1). */
export function toDerivedPie(pie: Pie): DerivedPie {
  return { id: pie.id, name: pie.name, files: pieFiles(pie) };
}

/** Band order (spec section 3, "Resting"): built-in pies first, then user
 *  pies in their stored order — `userPies` arrives already in that order
 *  (`pies::list()` never sorts), so this is a plain concatenation, not a
 *  sort. The tin is NOT part of this list; Sky.tsx appends it as its own
 *  trailing element. */
export function bandOrder(derived: DerivedPie[], userPies: Pie[]): DerivedPie[] {
  return [...derived, ...userPies.map(toDerivedPie)];
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

/** True for a user pie's id — the built-in pies are exactly the two fixed
 *  ids `derived-pies.ts` exports, and no user pie can ever carry one
 *  (`uuid::Uuid::now_v7()` never produces them). */
export function isUserPieId(id: string): boolean {
  return id !== BUILTIN_PINNED_ID && id !== BUILTIN_RECENT_ID;
}
