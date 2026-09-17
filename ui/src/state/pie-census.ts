// pie-census.ts — M3, spec sections 6/9. Two halves in one file, same split
// derived-pies.ts/pies.ts already use: PURE helpers first (no React — this
// file's vitest run has no jsdom and no testing-library, so every exported
// unit a test touches must be a plain function over plain data), then the
// REACT provider that owns the live cache and its refresh triggers.
import * as React from "react";
import type { IpcSurface, Pie, PieCensus, PieMember } from "../ipc";
import type { DerivedPie, DerivedPieFile } from "./derived-pies";
import { isUserPieId } from "./derived-pies";
import { toDerivedPie } from "./pies";
import { kindOf } from "../render/kind";
import { isUnderRoot } from "../utils/path";
import { usePiesContext } from "./pies-context";
import { useWorkspace } from "./workspace";
import { useWatcherBus } from "./watcher-bus";
import type { FsChange } from "./watcher-bus";

// ── Pure ─────────────────────────────────────────────────────────────────

/**
 * Adapts a resolved `PieCensus` into the `DerivedPieFile[]` shape every
 * other pie surface (`wedgesOf`, `Pie.tsx`, the flat layer list) already
 * renders against — `kindOf` is applied here, once, so the Rust side never
 * needs its own copy of the kind table (the M3 decision recorded in
 * workspace.rs's own doc comment).
 *
 * `members` filters rather than trusts `census.files` verbatim: a folder
 * member can be removed from the pie WHILE an in-flight `pie_census` call
 * is still resolving (the request reads `pies::list()` at the moment it
 * runs; the removal is a separate, later write). Without this filter a
 * census that lands after the removal would still carry rows tagged with
 * the now-gone member's path — `layersOf` below never builds a LAYER for a
 * member that no longer exists, so those rows would silently vanish from
 * every folder layer, but a direct-file row (`folder` absent) needs no such
 * check, since a removed FILE member has nothing else to match against.
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

/**
 * The FOLDER member `change` falls under, or `null` when the change does
 * not touch this pie at all. Returns the member rather than a bare boolean
 * because every caller needs it next: the bus subscriber has to ask whether
 * THAT member is outside the workspace root before it schedules a refresh,
 * and finding it a second time is a search the match already did.
 *
 * Only a workspace-TREE event counts (the external watcher covers
 * individually opened out-of-root tabs, not a pie's folder members). A
 * direct FILE member's own mtime change is deliberately not "affecting":
 * M3's live-refresh budget goes to folder census (the milestone's own
 * name), and a file member's freshness still updates on the next
 * sky-show/plate-open census, same as before M3.
 */
export function affectsPie(change: FsChange, members: PieMember[]): PieMember | null {
  if (change.source !== "tree") return null;
  return members.find((m) => m.kind === "folder" && isUnderRoot(change.path, m.path)) ?? null;
}

/** Freshness recomputed CLIENT-SIDE against the pie's CURRENT `seenAt`,
 *  rather than trusting `census.fresh` — `usePies.touchPieSeen` bumps a
 *  pie's `seen_at` to `Date.now()` OPTIMISTICALLY (before the backend echo
 *  lands), which is what clears the pill the instant the plate opens (every
 *  real mtime is now behind "now"); `census.fresh` was computed against
 *  whatever `seen_at` was true at the moment the LAST census resolved,
 *  which can already be stale by the time this renders. `seenAt === 0`
 *  (never opened) always reads 0, the same "don't show every file as new"
 *  rule the Rust side applies. */
export function freshCount(files: DerivedPieFile[], seenAt: number): number {
  if (seenAt === 0) return 0;
  return files.reduce((n, f) => (f.mtime > seenAt ? n + 1 : n), 0);
}

/** The path of the single most-recently-modified file, or `null` for an
 *  empty pie — what the freshness pill's one-click-open and the band's
 *  ⌘Enter both open. The file with the globally greatest mtime is always
 *  itself "fresh" whenever `freshCount` is nonzero (nothing can exceed the
 *  max), so this needs no `seenAt` of its own. */
export function newestPath(files: DerivedPieFile[]): string | null {
  if (files.length === 0) return null;
  return files.reduce((best, f) => (f.mtime > best.mtime ? f : best)).path;
}

export interface PieLayer {
  /** The member's own path for a folder layer, or the literal `"files"`
   *  for the trailing direct-files layer — stable across renders, used as
   *  the React key and the row `data-testid` scoping. */
  id: string;
  /** Ready-to-render text: the member's own path for a folder layer (the
   *  component renders it workspace-relative via `displayPath` — this
   *  function has no `root` to do that itself), or `"Files"`. */
  label: string;
  /** The underlying folder member's path; `null` for the trailing
   *  direct-files layer, which has no one member behind it. */
  memberPath: string | null;
  kind: "folder" | "files";
  /** True when this layer's member is in `census.missing` — a folder that
   *  no longer resolves (deleted, or renamed: the watcher reports a rename
   *  as `Remove` for the old path only, so the two are indistinguishable
   *  here). Always `false` for the trailing "Files" layer — a missing FILE
   *  member is a per-ROW state (`PiePlate.tsx` cross-references
   *  `census.missing` against `members` directly for that), not a
   *  per-layer one. */
  missing: boolean;
  /** False when this layer's member is in `census.outside_root` — "not
   *  live" in the plate. Defaults `true` (assume live) before the first
   *  census resolves, rather than flashing the caption on every open. */
  live: boolean;
  rows: DerivedPieFile[];
}

/** Newest file first — the agent's last write on top, the same order the
 *  flat M1/M2 layer list used. A `missing: true` row stands for a member
 *  with no file behind it and therefore no meaningful mtime, so those sink
 *  to the bottom of their layer instead of sorting as "1970". */
function byRow(a: DerivedPieFile, b: DerivedPieFile): number {
  if (Boolean(a.missing) !== Boolean(b.missing)) return a.missing ? 1 : -1;
  return b.mtime - a.mtime;
}

/**
 * Groups a pie's rows into ordered layers (spec section 5): one per FOLDER
 * member, in STORED member order, each with the member-relative mono
 * header; every row with no `folder` (a direct FILE member) shares one
 * trailing `"Files"` layer. `census` is optional so a pie whose first
 * census hasn't resolved yet still renders folder headers (with
 * `missing`/`live` defaulted, see `PieLayer`'s own doc comments) rather
 * than nothing at all.
 *
 * ALWAYS returns at least one layer: a pie with no folder members — and
 * even a pie with no members at all — gets the single `"files"` layer. The
 * plate then has exactly one shape to render, and decides separately
 * whether to PAINT the headers (it does not, for a lone `"files"` layer),
 * which is what keeps the M1/M2 flat list and the M3 tree as one code path
 * instead of two.
 */
export function layersOf(
  files: DerivedPieFile[],
  members: PieMember[],
  census: PieCensus | undefined,
): PieLayer[] {
  const missing = new Set(census?.missing ?? []);
  const outsideRoot = new Set(census?.outside_root ?? []);

  // One pass over the rows, not one filter pass per layer: a pie with many
  // folder members used to re-scan the whole row list once per member.
  // `undefined` is the bucket key for the trailing "Files" layer.
  const buckets = new Map<string | undefined, DerivedPieFile[]>();
  for (const f of files) {
    const bucket = buckets.get(f.folder);
    if (bucket) bucket.push(f);
    else buckets.set(f.folder, [f]);
  }
  for (const rows of buckets.values()) rows.sort(byRow);

  const layers: PieLayer[] = [];
  for (const m of members) {
    if (m.kind !== "folder") continue;
    layers.push({
      id: m.path,
      label: m.path,
      memberPath: m.path,
      kind: "folder",
      missing: missing.has(m.path),
      live: !outsideRoot.has(m.path),
      rows: buckets.get(m.path) ?? [],
    });
  }

  // The trailing "Files" layer is worth a header only when it holds
  // something; `layers.length === 0` is the pie with no folder members at
  // all, where it IS the whole list (and where the plate paints no header
  // for it — see this function's own doc comment).
  const fileRows = buckets.get(undefined) ?? [];
  if (fileRows.length > 0 || layers.length === 0) {
    layers.push({
      id: "files",
      label: "Files",
      memberPath: null,
      kind: "files",
      missing: false,
      live: true,
      rows: fileRows,
    });
  }

  return layers;
}

// ── React ────────────────────────────────────────────────────────────────

/** Per-pie debounce, mirroring `QuickOpen.tsx`'s stale-flag+timer shape —
 *  but a Map keyed by pie id here, since many pies can each have their own
 *  folder churn in flight at once, where QuickOpen only ever has one index
 *  open. 500ms (spec section 6), on top of the watcher's own 250ms
 *  debounce (`watcher.rs`) — an e2e wait for a census refresh needs to
 *  clear both. */
const REFRESH_DEBOUNCE_MS = 500;

/** Whether two member lists name the same members, in the same order, with
 *  the same kinds — the only difference between two `Pie` snapshots that
 *  can change what a census reports. `added_at`/`source`/`origin` are
 *  metadata about the ADD, not about what is on disk, so they are
 *  deliberately not compared. `undefined` (a pie seen for the first time)
 *  never matches. */
function sameMembers(a: PieMember[] | undefined, b: PieMember[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((m, i) => m.path === b[i].path && m.kind === b[i].kind);
}

/** One pie's cached census, plus the derived lookups that would otherwise
 *  be rebuilt on every read. `outside_root` arrives as an array (it is a
 *  wire shape) but is only ever asked "does it contain this member", once
 *  per filesystem event — a linear scan per event over an array that never
 *  changes between fetches. */
interface CacheEntry {
  census: PieCensus;
  outsideRoot: Set<string>;
}

export interface PieCensusValue {
  /** `undefined` before the first successful census for `pieId` — never a
   *  placeholder empty `PieCensus`, so a caller can tell "not fetched yet"
   *  from "fetched, empty pie" (`layersOf`'s own `missing`/`live` defaults
   *  lean on exactly this distinction). */
  censusFor(pieId: string): PieCensus | undefined;
  /** `toDerivedPie(pie, censusFor(pie.id))`, memoized per pie id: the same
   *  `DerivedPie` object comes back until either the `Pie` or its census
   *  changes identity. Without it, one census response — which replaces
   *  the whole cache Map and so re-identifies `censusFor` — re-ran
   *  `censusToFiles` for EVERY user pie in the band, not just the one that
   *  answered. */
  derive(pie: Pie): DerivedPie;
  /** Force a re-fetch for one pie — called on plate open. */
  refresh(pieId: string): void;
  /** Force a re-fetch for every USER pie — called on Sky mount (sky show)
   *  and, internally, whenever some pie's MEMBERS change. */
  refreshAll(): void;
}

const PieCensusContext = React.createContext<PieCensusValue>({
  censusFor: () => undefined,
  derive: (pie) => toDerivedPie(pie, undefined),
  refresh: () => {},
  refreshAll: () => {},
});

export function usePieCensus(): PieCensusValue {
  return React.useContext(PieCensusContext);
}

export interface PieCensusProviderProps {
  ipc: IpcSurface;
  children: React.ReactNode;
}

/**
 * Owns the `Map<pieId, PieCensus>` cache — mounted ONCE in `App.tsx`'s
 * `ProviderShell`, beside `PiesProvider`, rather than inside `Sky.tsx`.
 * `Sky.tsx` unmounts on every `skyVisible && !readerMode` flip (⌘⇧B, reader
 * mode), and a cache that lived inside it would be wiped on every hide —
 * defeating the whole point of caching a census between plate opens in the
 * same session.
 */
export function PieCensusProvider({ ipc, children }: PieCensusProviderProps): React.ReactElement {
  const { pies } = usePiesContext();
  const { root } = useWorkspace();
  const bus = useWatcherBus();

  const [cache, setCache] = React.useState<Map<string, CacheEntry>>(() => new Map());
  // Read inside the bus subscriber without making the subscribe effect
  // depend on (and therefore resubscribe on) every cache update — the same
  // "ref mirrors the latest value for an otherwise-stable callback" shape
  // `App.tsx`'s `noticeRef` uses.
  const cacheRef = React.useRef(cache);
  cacheRef.current = cache;
  const timersRef = React.useRef(new Map<string, number>());
  // Mirrors the latest `root` for the same reason `cacheRef` mirrors the
  // latest cache — read inside an already-in-flight `.then` without making
  // `fetchCensus` depend on (and therefore re-identity on) every root
  // change.
  const rootRef = React.useRef(root);
  rootRef.current = root;

  const fetchCensus = React.useCallback(
    (pieId: string) => {
      if (!ipc.pieCensus) return;
      // Captured at call time: `census.outside_root` was classified against
      // THIS root. If the workspace root changes while the request is in
      // flight, the flush effect below already empties the cache for the
      // new root — writing a response classified against the OLD root back
      // in would silently reintroduce stale "not live" captions until the
      // next refresh (review, minor: pie-census.ts:243).
      const requestRoot = root;
      ipc
        .pieCensus(pieId, root)
        .then((census) => {
          if (rootRef.current !== requestRoot) return;
          setCache((prev) => {
            const next = new Map(prev);
            next.set(pieId, { census, outsideRoot: new Set(census.outside_root) });
            return next;
          });
        })
        .catch(() => {
          // Backend not wired (a test double), or the pie vanished between
          // the call and its reply — `pie_census_for` already answers an
          // unknown id with an EMPTY census rather than an Err (so this
          // branch is mostly the "not wired" case), and a census is
          // derived, never persisted: there is nothing here worth a toast.
        });
    },
    [ipc, root],
  );

  const refresh = React.useCallback((pieId: string) => fetchCensus(pieId), [fetchCensus]);

  const refreshAll = React.useCallback(() => {
    for (const pie of pies) {
      if (isUserPieId(pie.id)) fetchCensus(pie.id);
    }
  }, [pies, fetchCensus]);

  // `usePies.ts` replaces the whole `pies` array on every
  // `skypie://pies-updated`, and MOST of those events cannot change what a
  // census would report: a rename, and above all `touch_seen` — which the
  // plate fires on every single open, and which the pill's own optimistic
  // bump fires again. Refreshing the whole band on array identity therefore
  // re-walked every folder member of every pie each time a plate opened.
  // Only a MEMBERSHIP change can change a census, so this compares the
  // previous list member by member and refetches exactly the pies whose
  // members moved. A pie that is new to the list has no previous entry and
  // so always counts as changed.
  const prevMembersRef = React.useRef(new Map<string, PieMember[]>());
  React.useEffect(() => {
    const prev = prevMembersRef.current;
    const next = new Map<string, PieMember[]>();
    for (const pie of pies) {
      next.set(pie.id, pie.members);
      if (!isUserPieId(pie.id)) continue;
      if (!sameMembers(prev.get(pie.id), pie.members)) fetchCensus(pie.id);
    }
    prevMembersRef.current = next;
  }, [pies, fetchCensus]);

  const scheduleRefresh = React.useCallback(
    (pieId: string) => {
      if (timersRef.current.has(pieId)) return; // a refresh is already pending
      const timer = window.setTimeout(() => {
        timersRef.current.delete(pieId);
        fetchCensus(pieId);
      }, REFRESH_DEBOUNCE_MS);
      timersRef.current.set(pieId, timer);
    },
    [fetchCensus],
  );

  React.useEffect(() => {
    const unsubscribe = bus.subscribe((change: FsChange) => {
      for (const pie of pies) {
        if (!isUserPieId(pie.id)) continue;
        const folderMember = affectsPie(change, pie.members);
        if (!folderMember) continue;
        // A folder OUTSIDE the workspace root never refreshes from the
        // bus — the external watcher (`watch_external_paths`) is
        // NonRecursive and does not cover it in the first place (spec
        // section 6); it only refreshes on refresh()/refreshAll() (sky
        // show, plate open).
        if (cacheRef.current.get(pie.id)?.outsideRoot.has(folderMember.path)) continue;
        scheduleRefresh(pie.id);
      }
    });
    return unsubscribe;
  }, [bus, pies, scheduleRefresh]);

  // Every pending debounce timer must die with the provider — it is
  // mounted once for the app's life, so in practice this only matters for
  // tests that mount/unmount it, but it is the same discipline
  // QuickOpen.tsx's own timer cleanup follows.
  React.useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
    };
  }, []);

  // The workspace root changing (or clearing) makes every cached
  // outside_root classification stale — a member that was outside the OLD
  // root may now be inside the new one, or vice versa. The next
  // refresh()/refreshAll() (sky show, plate open) rebuilds the cache
  // against the new root.
  //
  // Skipped on the FIRST run: the cache is already empty at mount, and
  // `setCache(new Map())` there replaced it with a second empty Map, which
  // is a fresh identity — so every consumer of `censusFor`/`derive`
  // re-rendered once for a change that did not happen. On a real root
  // change the flush still runs.
  const rootFlushedRef = React.useRef(false);
  React.useEffect(() => {
    if (!rootFlushedRef.current) {
      rootFlushedRef.current = true;
      return;
    }
    setCache(new Map());
  }, [root]);

  const censusFor = React.useCallback((pieId: string) => cache.get(pieId)?.census, [cache]);

  // Keyed by pie id, holding the inputs alongside the result so a hit can
  // prove itself still valid. A ref, not state: it is a pure cache of a
  // pure function, so writing to it must never schedule a render.
  const derivedRef = React.useRef(new Map<string, { pie: Pie; census: PieCensus | undefined; derived: DerivedPie }>());
  const derive = React.useCallback(
    (pie: Pie): DerivedPie => {
      const census = cache.get(pie.id)?.census;
      const hit = derivedRef.current.get(pie.id);
      if (hit && hit.pie === pie && hit.census === census) return hit.derived;
      const derived = toDerivedPie(pie, census);
      derivedRef.current.set(pie.id, { pie, census, derived });
      return derived;
    },
    [cache],
  );

  const value = React.useMemo<PieCensusValue>(
    () => ({ censusFor, derive, refresh, refreshAll }),
    [censusFor, derive, refresh, refreshAll],
  );

  // `React.createElement`, not JSX — this file is `.ts`, not `.tsx` (the
  // brief's own filename), so vite's esbuild loader parses it without JSX
  // support; this is the one line in the whole file that needs an element,
  // so a build-config change for the sake of it isn't worth it.
  return React.createElement(PieCensusContext.Provider, { value }, children);
}
