// pie-census.ts — M3, spec sections 6/9. Two halves in one file, same split
// derived-pies.ts/pies.ts already use: PURE helpers first (no React — this
// file's vitest run has no jsdom and no testing-library, so every exported
// unit a test touches must be a plain function over plain data), then the
// REACT provider that owns the live cache and its refresh triggers.
import * as React from "react";
import type { IpcSurface, PieCensus, PieMember } from "../ipc";
import type { DerivedPieFile } from "./derived-pies";
import { kindOf } from "../render/kind";
import { usePiesContext } from "./pies-context";
import { useWorkspace } from "./workspace";
import { useWatcherBus } from "./watcher-bus";
import type { FsChange } from "./watcher-bus";

// ── Pure ─────────────────────────────────────────────────────────────────

/** Same rule as `pies.ts`'s `isUserPieId` (every built-in pie's id is a
 *  fixed `"builtin:…"` literal), reimplemented here rather than imported —
 *  `pies.ts`'s own `toDerivedPie(pie, census?)` needs this module's
 *  `censusToFiles`/`freshCount`/`newestPath`, and importing `isUserPieId`
 *  back from `pies.ts` would make the two files import each other. */
function isUserPie(id: string): boolean {
  return !id.startsWith("builtin:");
}

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
 */
export function censusToFiles(census: PieCensus, members: PieMember[]): DerivedPieFile[] {
  const memberPaths = new Set(members.map((m) => m.path));
  return census.files
    .filter((f) => f.folder === undefined || memberPaths.has(f.folder))
    .map((f) => ({ path: f.path, kind: kindOf(f.path), mtime: f.mtime, folder: f.folder }));
}

/** `path` is `folder` itself, or inside it, on a SEGMENT boundary — the
 *  same rule `utils/path.ts`'s `isUnderRoot` applies to the workspace root,
 *  reimplemented here (rather than imported) because the two compare
 *  against different kinds of "root": a workspace root is never `null`
 *  once resolved, while a folder member here is always a concrete string,
 *  so `isUnderRoot`'s `null`-tolerant signature would be the wrong shape
 *  for every call site below. */
export function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * True iff `change` is a workspace-TREE event (not an external-file event —
 * the external watcher covers individually opened out-of-root tabs, not a
 * pie's folder members) whose path falls under one of `members`' FOLDER
 * paths. A direct FILE member's own mtime change is deliberately not
 * "affecting" here: M3's live-refresh budget goes to folder census
 * (the milestone's own name), and a file member's freshness still updates
 * on the next sky-show/plate-open census, same as before M3.
 */
export function affectsPie(change: FsChange, members: PieMember[]): boolean {
  if (change.source !== "tree") return false;
  return members.some((m) => m.kind === "folder" && isUnder(change.path, m.path));
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

/**
 * Groups a pie's files into ordered layers (spec section 5): one per FOLDER
 * member, in STORED member order, each with the member-relative mono
 * header; every direct FILE member's row (no `folder`) shares one trailing
 * `"Files"` layer. Rows within a layer sort newest-first — the agent's last
 * file on top, same as the flat M1/M2 layer list. `census` is optional so a
 * pie whose first census hasn't resolved yet still renders folder headers
 * (with `missing`/`live` defaulted, see `PieLayer`'s own doc comments)
 * rather than nothing at all.
 */
export function layersOf(
  files: DerivedPieFile[],
  members: PieMember[],
  census: PieCensus | undefined,
): PieLayer[] {
  const missing = new Set(census?.missing ?? []);
  const outsideRoot = new Set(census?.outside_root ?? []);
  const byMtimeDesc = (a: DerivedPieFile, b: DerivedPieFile) => b.mtime - a.mtime;

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
      rows: files.filter((f) => f.folder === m.path).sort(byMtimeDesc),
    });
  }

  // The trailing "Files" layer exists whenever the pie has at least one
  // direct FILE member — even one that currently resolves to nothing (a
  // missing file still needs a layer to render its own dimmed "not found"
  // row in), so this checks membership, not just `files.length`.
  if (members.some((m) => m.kind === "file")) {
    layers.push({
      id: "files",
      label: "Files",
      memberPath: null,
      kind: "files",
      missing: false,
      live: true,
      rows: files.filter((f) => f.folder === undefined).sort(byMtimeDesc),
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

export interface PieCensusValue {
  /** `undefined` before the first successful census for `pieId` — never a
   *  placeholder empty `PieCensus`, so a caller can tell "not fetched yet"
   *  from "fetched, empty pie" (`layersOf`'s own `missing`/`live` defaults
   *  lean on exactly this distinction). */
  censusFor(pieId: string): PieCensus | undefined;
  /** Force a re-fetch for one pie — called on plate open. */
  refresh(pieId: string): void;
  /** Force a re-fetch for every USER pie — called on Sky mount (sky show)
   *  and, internally, whenever the `pies` list's identity changes. */
  refreshAll(): void;
}

const PieCensusContext = React.createContext<PieCensusValue>({
  censusFor: () => undefined,
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

  const [cache, setCache] = React.useState<Map<string, PieCensus>>(() => new Map());
  // Read inside the bus subscriber without making the subscribe effect
  // depend on (and therefore resubscribe on) every cache update — the same
  // "ref mirrors the latest value for an otherwise-stable callback" shape
  // `App.tsx`'s `noticeRef` uses.
  const cacheRef = React.useRef(cache);
  cacheRef.current = cache;
  const timersRef = React.useRef(new Map<string, number>());

  const fetchCensus = React.useCallback(
    (pieId: string) => {
      if (!ipc.pieCensus) return;
      ipc
        .pieCensus(pieId, root)
        .then((census) => {
          setCache((prev) => {
            const next = new Map(prev);
            next.set(pieId, census);
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
      if (isUserPie(pie.id)) fetchCensus(pie.id);
    }
  }, [pies, fetchCensus]);

  // `usePies.ts` replaces the whole `pies` array on every
  // `skypie://pies-updated` (a create, a member add/remove/relocate, a
  // rename, a touch_seen from ANY writer) — array identity is exactly the
  // "something about a pie may have changed" signal, so refreshing on it
  // covers every one of those without each op having to say so itself.
  React.useEffect(() => {
    refreshAll();
    // refreshAll already depends on `pies` (see its own deps) — re-running
    // this effect on anything else would refetch without the list having
    // changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pies]);

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
        if (!isUserPie(pie.id)) continue;
        if (!affectsPie(change, pie.members)) continue;
        // `affectsPie` already proved some folder member contains
        // `change.path` — find that SAME member again (cheap; a pie holds
        // at most a handful of members) to check whether IT specifically
        // is outside the workspace root.
        const folderMember = pie.members.find(
          (m) => m.kind === "folder" && isUnder(change.path, m.path),
        );
        // A folder OUTSIDE the workspace root never refreshes from the
        // bus — the external watcher (`watch_external_paths`) is
        // NonRecursive and does not cover it in the first place (spec
        // section 6); it only refreshes on refresh()/refreshAll() (sky
        // show, plate open).
        if (folderMember && cacheRef.current.get(pie.id)?.outside_root.includes(folderMember.path)) {
          continue;
        }
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
  React.useEffect(() => {
    setCache(new Map());
  }, [root]);

  const censusFor = React.useCallback((pieId: string) => cache.get(pieId), [cache]);

  const value = React.useMemo<PieCensusValue>(
    () => ({ censusFor, refresh, refreshAll }),
    [censusFor, refresh, refreshAll],
  );

  // `React.createElement`, not JSX — this file is `.ts`, not `.tsx` (the
  // brief's own filename), so vite's esbuild loader parses it without JSX
  // support; this is the one line in the whole file that needs an element,
  // so a build-config change for the sake of it isn't worth it.
  return React.createElement(PieCensusContext.Provider, { value }, children);
}
