// derived-pies.ts — builds the two M1 built-in pies (Pinned, Recent) over the
// existing bookmarks and recents stores. Pure, no React: Sky.tsx wraps these
// calls in useMemo, so nothing here needs to know about rendering.
//
// Derived pies are never persisted (spec section 9): there is no `seen_at`,
// so they never show a freshness pill, and no `id` beyond the fixed
// "builtin:*" ones below.
import type { BookmarkEntry, PieCensus, RecentEntry } from "../ipc";
import { BEARINGS, HAZE_THRESHOLD, kindOf } from "../render/kind";
import type { FileKind } from "../render/kind";

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
  /** M3: the path the freshness pill / band ⌘Enter open in one click —
   *  `undefined` under the same conditions as `fresh`. */
  newestFreshPath?: string;
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

/** Both `bookmarks.rs` and `recents.rs` store their timestamps in seconds
 *  (`SystemTime::as_secs`); every other timestamp in the frontend (mtime,
 *  `Date.now()`) is milliseconds. Convert once, here, so nothing downstream
 *  has to remember which store is on which clock. */
function secsToMs(secs: number): number {
  return secs * 1000;
}

export function pinnedPie(bookmarks: BookmarkEntry[]): DerivedPie {
  return {
    id: "builtin:pinned",
    name: "Pinned",
    files: bookmarks.map((b) => ({
      path: b.path,
      kind: kindOf(b.path),
      mtime: secsToMs(b.bookmarked_at),
    })),
  };
}

export function recentPie(recents: RecentEntry[]): DerivedPie {
  return {
    id: "builtin:recent",
    name: "Recent",
    files: recents
      // useOpenFile pushes every address to recents, including
      // `skypie-remote://peer/path` (TabsProvider.tsx) — a pie's census is a
      // local-filesystem concept, so a remote address is dropped rather than
      // ever reaching a `kindOf`/mtime call meant for a real path.
      .filter((r) => r.path.startsWith("/"))
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
  const total = files.length;
  if (total === 0) return [];

  const groups = groupByWedge(files);
  return BEARINGS.filter((kind) => (groups.get(kind)?.length ?? 0) > 0).map((kind) => {
    const count = groups.get(kind)?.length ?? 0;
    return { kind, count, share: count / total };
  });
}

/** `"html 58% · md 25% · code 17%"`, or `"No files"` — the hover tooltip's
 *  content (spec section 3) and `Pie.tsx`'s own `aria-label` share, so both
 *  read the same summary a pie's disc shows visually. Pulled out of Pie.tsx
 *  (M1 computed this inline as a local `shareLabel`) so `Tooltip.tsx` can
 *  build the same string without re-deriving wedge shares itself. */
export function shareLabel(files: DerivedPieFile[]): string {
  const wedges = wedgesOf(files);
  return wedges.length
    ? wedges.map((w) => `${w.kind} ${Math.round(w.share * 100)}%`).join(" · ")
    : "No files";
}
