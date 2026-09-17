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
import { isUnderRoot } from "../utils/path";
import { usePiesContext } from "./pies-context";
import { useWorkspace } from "./workspace";
import { useWatcherBus } from "./watcher-bus";
import type { FsChange } from "./watcher-bus";

// ── Pure ─────────────────────────────────────────────────────────────────

/** Both now live in `derived-pies.ts`, beside the `DerivedPieFile` they
 *  build. This module needs `toDerivedPie` from `pies.ts`, and `pies.ts`
 *  needed these two from here, so the two modules imported each other —
 *  safe only while every use stayed at call time. Re-exported so every
 *  existing importer keeps working unchanged. */
export { censusToFiles, freshCount } from "./derived-pies";

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

/** The path of the single most-recently-modified file, or `null` for an
 *  empty pie — what the freshness pill's one-click-open and the band's
 *  ⌘Enter both open. The file with the globally greatest mtime is always
 *  itself "fresh" whenever `freshCount` is nonzero (nothing can exceed the
 *  max), so this needs no `seenAt` of its own. */
export function newestPath(files: DerivedPieFile[]): string | null {
  if (files.length === 0) return null;
  return files.reduce((best, f) => (f.mtime > best.mtime ? f : best)).path;
}

/** What both layer shapes share. */
interface PieLayerBase {
  /** The member's own path for a folder layer, or the literal `"files"`
   *  for the trailing direct-files layer — stable across renders, used as
   *  the React key and the row `data-testid` scoping. */
  id: string;
  /** Ready-to-render text: the member's own path for a folder layer (the
   *  component renders it workspace-relative via `displayPath` — this
   *  function has no `root` to do that itself), or `"Files"`. */
  label: string;
  rows: DerivedPieFile[];
}

/**
 * One layer of the plate's list, as a DISCRIMINATED UNION on `kind`. The
 * member-state fields belong to a FOLDER layer only: the trailing "Files"
 * layer has no one member behind it, so it can have no member path, no
 * "folder not found" and no "not live". Modelled as one flat interface,
 * those fields were `memberPath: string | null` plus two booleans pinned to
 * `false`/`true` by construction, and every reader carried a null check
 * that could not fire. Narrowing on `layer.kind === "folder"` deletes them.
 *
 * A missing or unreadable FILE member is a per-ROW state
 * (`DerivedPieFile.missing`), never a layer one — `PiePlate.tsx` builds
 * those rows from `census.missing` against `members` directly.
 */
export type PieLayer =
  | (PieLayerBase & {
      kind: "folder";
      /** The underlying folder member's path. */
      memberPath: string;
      /** True when this member is in `census.missing` — a folder that no
       *  longer resolves (deleted, or renamed: the watcher reports a
       *  rename as `Remove` for the old path only, so the two are
       *  indistinguishable here). */
      missing: boolean;
      /** True when this member is in `census.unreadable` — it is there,
       *  but the census could not read it, so "empty folder" would be a
       *  lie. Only Forget is offered: there is nothing to re-point a
       *  folder that has not moved. */
      unreadable: boolean;
      /** False when this member is in `census.outside_root` — "not live"
       *  in the plate. Defaults `true` (assume live) before the first
       *  census resolves, rather than flashing the caption on every
       *  open. */
      live: boolean;
    })
  | (PieLayerBase & { kind: "files" });

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
 * member, in STORED member order, each with the workspace-relative mono
 * header; every row with no `folder` (a direct FILE member) shares one
 * trailing `"Files"` layer. `census` is optional so a pie whose first
 * census hasn't resolved yet still renders folder headers (with
 * `missing`/`unreadable`/`live` defaulted, see `PieLayer`'s own doc
 * comments) rather
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
  const unreadable = new Set(census?.unreadable ?? []);
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
      unreadable: unreadable.has(m.path),
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
      kind: "files",
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
export function sameMembers(a: PieMember[] | undefined, b: PieMember[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((m, i) => m.path === b[i].path && m.kind === b[i].kind);
}

/** One pie's cached census, plus the derived lookup that would otherwise
 *  be rebuilt on every read: `outside_root` arrives as an array (it is a
 *  wire shape), and the bus subscriber asks "does it contain this member"
 *  once per filesystem event, so it is turned into a Set once per fetch
 *  instead of being scanned linearly per event. */
interface CacheEntry {
  census: PieCensus;
  outsideRoot: Set<string>;
}

export interface PieCensusValue {
  /** `toDerivedPie(pie, <that pie's cached census>)`, memoized per pie id:
   *  the same `DerivedPie` object comes back until either the `Pie` or its
   *  census changes identity. Without it, one census response — which
   *  replaces the whole cache Map — re-ran `censusToFiles` for EVERY user
   *  pie in the band, not just the one that answered.
   *
   *  A pie with no census yet derives to exactly M2's pre-census shape
   *  (`toDerivedPie`'s own no-census branch), so "not fetched yet" and
   *  "fetched, empty pie" stay distinguishable inside without exposing a
   *  second, raw door onto the cache. */
  derive(pie: Pie): DerivedPie;
  /** Force a re-fetch for one pie — called on plate open. */
  refresh(pieId: string): void;
  /** Force a re-fetch for every USER pie — called on Sky mount (sky show).
   *  NOT called when a pie's members change: that is handled per pie, by
   *  the members effect below, so one pie gaining a folder does not re-walk
   *  the whole band. */
  refreshAll(): void;
}

const PieCensusContext = React.createContext<PieCensusValue>({
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
  // Per-pie request counter, beside the `rootRef` guard: THREE independent
  // triggers can have a census for the same pie in flight at once (plate
  // open, a members change, a debounced watcher refresh), and IPC replies
  // are not ordered. Without this, a slow earlier response landing after a
  // fast later one overwrote fresh rows with stale ones, and nothing said
  // so. A response is written only when its own ticket is still the latest
  // one issued for that pie.
  const seqRef = React.useRef(new Map<string, number>());

  const fetchCensus = React.useCallback(
    (pieId: string) => {
      if (!ipc.pieCensus) return;
      // Captured at call time: `census.outside_root` was classified against
      // THIS root. If the workspace root changes while the request is in
      // flight, the flush effect below already empties the cache for the
      // new root — writing a response classified against the OLD root back
      // in would silently reintroduce stale "not live" captions until the
      // next refresh.
      const requestRoot = root;
      const seq = (seqRef.current.get(pieId) ?? 0) + 1;
      seqRef.current.set(pieId, seq);
      ipc
        .pieCensus(pieId, root)
        .then((census) => {
          if (rootRef.current !== requestRoot) return;
          if (seqRef.current.get(pieId) !== seq) return; // a later request won
          setCache((prev) => {
            const next = new Map(prev);
            next.set(pieId, { census, outsideRoot: new Set(census.outside_root) });
            return next;
          });
        })
        .catch((err: unknown) => {
          // No toast, deliberately: a census is derived, never persisted,
          // and `pie_census_for` already answers an unknown id (a pie
          // deleted mid-flight) with an EMPTY census rather than an Err, so
          // nothing here is the user's to act on. But swallowing it in
          // silence hid a transport failure, a wire-shape drift and a
          // poisoned mutex alike — the pie just stayed in its M2 shape with
          // no rows and no explanation. A missing `ipc.pieCensus` is the
          // one EXPECTED case (a test double, an older build), and the
          // guard at the top of this callback already returned for it.
          console.warn(`skypie: pie_census failed for ${pieId}`, err);
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
  //
  // This effect is also where a DELETED pie is evicted. Nothing else ever
  // removed an entry: a deleted pie's census, its `outsideRoot` Set and its
  // memoized `DerivedPie` (which pins the whole `Pie` object) stayed in
  // memory for the rest of the session, and a new pie that somehow reused
  // the id would have read the dead one's rows.
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

    for (const pieId of derivedRef.current.keys()) {
      if (!next.has(pieId)) derivedRef.current.delete(pieId);
    }
    for (const pieId of seqRef.current.keys()) {
      if (!next.has(pieId)) seqRef.current.delete(pieId);
    }
    for (const [pieId, handle] of timersRef.current) {
      if (next.has(pieId)) continue;
      window.clearTimeout(handle);
      timersRef.current.delete(pieId);
    }
    setCache((prevCache) => {
      let dropped = false;
      const nextCache = new Map(prevCache);
      for (const pieId of nextCache.keys()) {
        if (next.has(pieId)) continue;
        nextCache.delete(pieId);
        dropped = true;
      }
      // Same identity back when nothing was pruned — a new Map here would
      // re-identify `derive` and re-render every band tile on every
      // `pies-updated` event.
      return dropped ? nextCache : prevCache;
    });
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
  // against the new root. Every PENDING debounced refresh dies with it: it
  // was scheduled for the old root and would write a census classified
  // against it straight back into the cache this effect just emptied.
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
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
    setCache(new Map());
  }, [root]);

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
    () => ({ derive, refresh, refreshAll }),
    [derive, refresh, refreshAll],
  );

  // `React.createElement`, not JSX — this file is `.ts`, not `.tsx` (the
  // brief's own filename), so vite's esbuild loader parses it without JSX
  // support; this is the one line in the whole file that needs an element,
  // so a build-config change for the sake of it isn't worth it.
  return React.createElement(PieCensusContext.Provider, { value }, children);
}
