// derived-pies.ts — builds the two M1 built-in pies (Pinned, Recent) over the
// existing bookmarks and recents stores. Pure, no React: Sky.tsx wraps these
// calls in useMemo, so nothing here needs to know about rendering.
//
// Derived pies are never persisted (spec section 9): there is no `seen_at`,
// so they never show a freshness pill, and no `id` beyond the fixed
// "builtin:*" ones below.
import type { BookmarkEntry, PieCensus, PieMember, RecentEntry } from "../ipc";
import { BEARINGS, HAZE_THRESHOLD, kindOf } from "../render/kind";
import type { FileKind } from "../render/kind";
import { isRemoteAddress } from "../utils/remote-address";

/** The two built-in pies' fixed ids. Exported because other modules
 *  (`PiePlate.tsx`'s Pinned wording) branch on them — a bare
 *  `"builtin:pinned"` literal repeated per call site drifts the moment one
 *  of them is renamed. */
export const BUILTIN_PINNED_ID = "builtin:pinned";
export const BUILTIN_RECENT_ID = "builtin:recent";

/** True for a user pie's id — the built-in pies are exactly the two fixed
 *  ids above, and no user pie can ever carry one (`uuid::Uuid::now_v7()`
 *  never produces them). Lives HERE, beside the two ids it tests against.
 *  `pies.ts` re-exports it for its existing callers. */
export function isUserPieId(id: string): boolean {
  return id !== BUILTIN_PINNED_ID && id !== BUILTIN_RECENT_ID;
}

export interface DerivedPieFile {
  path: string;
  kind: FileKind;
  mtime: number; // ms epoch — see the *1000 conversions below
  /** M6: the SENDER-supplied filename (`ios-pies.ts`'s `receivedPie`/
   *  `sharedPie`), when it differs from `path`'s own basename — a beam's
   *  landed path can carry a disambiguating `-2`/`-3` suffix (`beam.rs`'s
   *  `unique_name`) that the "Received" list above `PhonePieSheet.tsx` on
   *  the same start page does not show, so the row would otherwise read a
   *  different name for the same file (review: PhonePieSheet.tsx:70,
   *  minor). Absent for every non-iOS pie, which has no such rename step. */
  name?: string;
  /** M3: the folder MEMBER this file was found under (a census file) —
   *  absent for a direct file member, a built-in pie's file, or any file
   *  from before the census resolves. `pie-census.ts`'s `layersOf` groups
   *  rows by this field. */
  folder?: string;
  /** M3: this row stands for a MEMBER that no longer resolves on disk
   *  (`census.missing`), not for a real file — it renders dimmed, with
   *  "not found" and a Forget button, and cannot be opened. Modelling it
   *  as a row rather than as a second list is what keeps the plate to ONE
   *  row list, one slice filter and one keyboard-navigation sequence. */
  missing?: true;
}

export interface DerivedPie {
  id: string;
  name: string;
  files: DerivedPieFile[];
  /** M3: count of `files` newer than the pie's `seen_at` — `undefined` for
   *  a built-in pie (Pinned/Recent have no `seen_at` at all, spec section
   *  9) or a user pie whose census hasn't resolved yet. `Pie.tsx` renders
   *  the freshness pill only when this is a positive number, so a built-in
   *  pie keeps having no pill exactly as it did before M3. */
  fresh?: number;
  /** M3: the resolved census behind `files`, when there is one — carried
   *  through so `PiePlate.tsx` can build folder layers (`layersOf`) and the
   *  truncated/not-live captions without a second lookup by id. */
  census?: PieCensus;
}

export interface Wedge {
  kind: FileKind;
  count: number;
  /** 0..1 — share of the pie's total file count. */
  share: number;
}

/**
 * Adapts a resolved `PieCensus` into the `DerivedPieFile[]` shape every
 * other pie surface (`wedgesOf`, `Pie.tsx`, the flat layer list) already
 * renders against — `kindOf` is applied here, once, so the Rust side never
 * needs its own copy of the kind table (the M3 decision recorded in
 * workspace.rs's own doc comment).
 *
 * Lives HERE, beside `DerivedPieFile` itself, rather than in
 * `pie-census.ts`: `pies.ts` needs it for `toDerivedPie`, and
 * `pie-census.ts` needs `toDerivedPie` — keeping it there made those two
 * modules import each other, which only worked because every use happened
 * to be at call time. `pie-census.ts` re-exports it so its existing
 * importers are unaffected.
 *
 * `members` filters rather than trusts `census.files` verbatim: a folder
 * member can be removed from the pie WHILE an in-flight `pie_census` call
 * is still resolving (the request reads `pies::list()` at the moment it
 * runs; the removal is a separate, later write). Without this filter a
 * census that lands after the removal would still carry rows tagged with
 * the now-gone member's path — `layersOf` (`pie-census.ts`) never builds a
 * LAYER for a member that no longer exists, so those rows would silently
 * vanish from every folder layer, but a direct-file row (`folder` absent)
 * needs no such check, since a removed FILE member has nothing else to
 * match against.
 *
 * No per-path dedupe: `workspace.rs::census_with_cap` reports each path at
 * most once for the whole pie, covering both a FILE member inside a FOLDER
 * member and two OVERLAPPING folder members. A second pass here would only
 * hide a regression on that side.
 */
export function censusToFiles(census: PieCensus, members: PieMember[]): DerivedPieFile[] {
  const memberPaths = new Set(members.map((m) => m.path));
  const out: DerivedPieFile[] = [];
  for (const f of census.files) {
    if (f.folder !== undefined && !memberPaths.has(f.folder)) continue;
    out.push({ path: f.path, kind: kindOf(f.path), mtime: f.mtime, folder: f.folder });
  }
  return out;
}

/** Freshness recomputed CLIENT-SIDE against the pie's CURRENT `seenAt`:
 *  the census carries no `fresh` field at all, because `usePies.
 *  touchPieSeen` bumps a pie's `seen_at` to `Date.now()` OPTIMISTICALLY
 *  (before the backend echo lands), which is what clears the pill the
 *  instant the plate opens (every real mtime is now behind "now") — a
 *  server-side count would have been measured against whatever `seen_at`
 *  was true when the census ran, and could already be wrong by the time it
 *  rendered. `seenAt === 0` (never opened) always reads 0, so a pie nobody
 *  has looked at yet does not present every pre-existing file as new.
 *  Strictly newer: a file whose mtime EQUALS `seenAt` was already on
 *  screen at that moment and is not new. */
export function freshCount(files: DerivedPieFile[], seenAt: number): number {
  if (seenAt === 0) return 0;
  return files.reduce((n, f) => (f.mtime > seenAt ? n + 1 : n), 0);
}

/** Both `bookmarks.rs` and `recents.rs` store their timestamps in seconds
 *  (`SystemTime::as_secs`); every other timestamp in the frontend (mtime,
 *  `Date.now()`) is milliseconds. Convert once, here, so nothing downstream
 *  has to remember which store is on which clock. */
function secsToMs(secs: number): number {
  return secs * 1000;
}

/** A pie's census is a local-filesystem concept. Both stores can hold a
 *  `skypie-remote://peer/path` address — recents because `useOpenFile` pushes
 *  every address it opens (TabsProvider.tsx), bookmarks because the toolbar
 *  star bookmarks whatever the active tab holds — so ONE predicate guards
 *  both builders. Without it a remote bookmark reached `kindOf` and showed in
 *  Pinned as a phantom file. */
function isLocalFile(address: string): boolean {
  return address.startsWith("/") && !isRemoteAddress(address);
}

export function pinnedPie(bookmarks: BookmarkEntry[]): DerivedPie {
  return {
    id: BUILTIN_PINNED_ID,
    name: "Pinned",
    files: bookmarks
      .filter((b) => isLocalFile(b.path))
      .map((b) => ({
        path: b.path,
        kind: kindOf(b.path),
        mtime: secsToMs(b.bookmarked_at),
      })),
  };
}

export function recentPie(recents: RecentEntry[]): DerivedPie {
  return {
    id: BUILTIN_RECENT_ID,
    name: "Recent",
    files: recents
      .filter((r) => isLocalFile(r.path))
      .map((r) => ({
        path: r.path,
        kind: kindOf(r.path),
        mtime: secsToMs(r.opened_at),
      })),
  };
}

/**
 * Groups files by their wedge kind AFTER the haze merge — the same grouping
 * `wedgesOf` counts, exposed so a consumer (the plate's legend/layer filter)
 * can recover exactly the files one wedge represents. A haze-merged "other"
 * group includes both files that were genuinely "other" and files whose own
 * kind fell under HAZE_THRESHOLD.
 */
export function groupByWedge(files: DerivedPieFile[]): Map<FileKind, DerivedPieFile[]> {
  const total = files.length;
  const groups = new Map<FileKind, DerivedPieFile[]>();
  for (const f of files) {
    const list = groups.get(f.kind);
    if (list) list.push(f);
    else groups.set(f.kind, [f]);
  }
  if (total > 0) {
    for (const kind of BEARINGS) {
      if (kind === "other") continue;
      const list = groups.get(kind);
      if (list && list.length / total < HAZE_THRESHOLD) {
        groups.delete(kind);
        const other = groups.get("other");
        if (other) other.push(...list);
        else groups.set("other", list);
      }
    }
  }
  return groups;
}

/**
 * Per-kind wedges for a pie's files, in BEARINGS order (html at north,
 * clockwise). A kind whose share is strictly under HAZE_THRESHOLD folds into
 * "other" instead of drawing a sliver too thin to read; exactly at the
 * threshold it keeps its own wedge ("under 4%" in the spec is a strict `<`).
 */
export function wedgesOf(files: DerivedPieFile[]): Wedge[] {
  if (files.length === 0) return [];
  return wedgesOfGroups(groupByWedge(files));
}

/**
 * The wedge half of `wedgesOf`, over groups a caller already has. A consumer
 * that needs BOTH (the plate needs the groups for its legend and layer
 * filter, and the wedges for the disc) would otherwise group the same files
 * twice on every render.
 *
 * The total is DERIVED from the groups rather than passed in: `Pie` turns
 * `share` straight into geometry, so a caller-supplied total that disagreed
 * with the groups silently over- or under-filled the disc.
 */
export function wedgesOfGroups(groups: Map<FileKind, DerivedPieFile[]>): Wedge[] {
  const total = [...groups.values()].reduce((n, list) => n + list.length, 0);
  if (total === 0) return [];
  return BEARINGS.filter((kind) => (groups.get(kind)?.length ?? 0) > 0).map((kind) => {
    const count = groups.get(kind)?.length ?? 0;
    return { kind, count, share: count / total };
  });
}

/** `"html 58% · md 25% · code 17%"`, or `"No files"` — the hover tooltip's
 *  content (spec section 3) and `Pie.tsx`'s own `aria-label` share, so both
 *  read the same summary a pie's disc shows visually.
 *
 *  Takes WEDGES, not files: every caller that wants this label already has
 *  the wedges memoized for the disc it is drawing, so grouping the same
 *  files a second time just to build a string is pure waste. `shareLabel`
 *  below stays for callers that hold only files.
 */
export function labelOfWedges(wedges: Wedge[]): string {
  return wedges.length
    ? wedges.map((w) => `${w.kind} ${Math.round(w.share * 100)}%`).join(" · ")
    : "No files";
}

/** `labelOfWedges` for a caller that has files rather than wedges. */
export function shareLabel(files: DerivedPieFile[]): string {
  return labelOfWedges(wedgesOf(files));
}
