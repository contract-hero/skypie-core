// PiePlate — the zoom-in sheet: the pie at full size, a mono readout, and
// the legend + layer list. Opened by Enter or a click on a Pie tile; closes
// on Esc, an outside pointerdown, or window blur (spec section 4).
//
// M2: the legend is a radiogroup sharing selection with the portrait pie's
// own wedges (spec section 4, "Legend rows and wedge paths are the same
// control"), Enter/click on a radio cuts that wedge 12px and shows the
// filter chip, and — only for a USER pie — the layer rows' context menu
// gains "Remove from pie" / "Add to another pie…".
//
// M3: when the pie has any FOLDER member, the layer list becomes a tree —
// one layer per folder (in stored member order) plus a trailing "Files"
// layer for direct file members, each folder layer a `role="treeitem"`
// header at `aria-level="1"` over its rows at `aria-level="2"` (spec
// section 5). A pie with no folder members keeps the flat `role="listbox"`
// shape unchanged from M1/M2 — `layersOf`/`PieLayer` (`state/pie-census.ts`)
// only exist to feed the tree case.
import * as React from "react";
import { FileCode, FileText, FileImage, FileJson, File as FileIconGlyph, MessageSquare, PieChart, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Pie from "./Pie";
import { groupByWedge, wedgesOf } from "../state/derived-pies";
import type { DerivedPie, DerivedPieFile } from "../state/derived-pies";
import { isUserPieId } from "../state/pies";
import { kindOf } from "../render/kind";
import type { FileKind } from "../render/kind";
import { layersOf, usePieCensus } from "../state/pie-census";
import type { PieLayer } from "../state/pie-census";
import { FileGlyph } from "./FileIcon";
import { basename, displayDir, displayPath } from "../utils/path";
import { formatAgo } from "../utils/beam-format";
import { useEscape } from "../hooks/useEscape";
import { useContextMenu } from "./ContextMenu";
import { useFileMenu } from "../hooks/useFileMenu";
import { usePiesContext } from "../state/pies-context";
import { useWorkspace } from "../state/workspace";
import { useAnnotations } from "../state/annotations-context";
import { openOptsFromClick } from "../state/TabsProvider";
import type { OpenFileOptions } from "../state/TabsProvider";
import type { IpcSurface } from "../ipc";
import type { AppNoticeAction } from "../App";

/** One entry in the layer list's roving-tabindex sequence — a folder
 *  layer's header, or a single file row. Shared between tree mode (real
 *  `PieLayer`s from `layersOf`) and flat mode (every row uses the same
 *  placeholder `FLAT_LAYER` below, since flat mode renders no headers at
 *  all and the `layer` field is never read for a "file" item). */
type NavItem =
  | { type: "header"; layer: PieLayer }
  | { type: "file"; layer: PieLayer; file: DerivedPieFile };

/** Placeholder `layer` for a flat-mode "file" `NavItem` — flat mode never
 *  reads a row's `layer` field (there is no header to associate it with),
 *  so one shared constant avoids allocating a throwaway object per row. */
const FLAT_LAYER: PieLayer = {
  id: "flat",
  label: "",
  memberPath: null,
  kind: "files",
  missing: false,
  live: true,
  rows: [],
};

const KIND_LABELS: Record<FileKind, string> = {
  html: "HTML",
  md: "Markdown",
  code: "Code",
  text: "Text",
  image: "Image",
  data: "Data",
  other: "Other",
};

// Legend glyph per KIND, not per extension — FileGlyph (FileIcon.tsx) infers
// its icon from a filename, which a wedge/kind does not have.
const KIND_ICON: Record<FileKind, LucideIcon> = {
  html: FileCode,
  md: FileText,
  code: FileCode,
  text: FileText,
  image: FileImage,
  data: FileJson,
  other: FileIconGlyph,
};

/** pane height < 480px is the spec's "short window" floor (section 4):
 *  the plate pie drops to 120px. Pane height ≈ window height − 2×--band-h
 *  (tab strip + toolbar, 40px each — section 2's own "pane = window − 40
 *  tab strip − 40 toolbar"), so this tracks window height directly instead
 *  of measuring the DOM, which keeps the plate's CSS clamp() and this
 *  threshold using the same arithmetic. */
const SHORT_PANE_WINDOW_H = 480 + 80;

function usePaneShort(): boolean {
  const [short, setShort] = React.useState(
    () => typeof window !== "undefined" && window.innerHeight < SHORT_PANE_WINDOW_H,
  );
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(`(max-height: ${SHORT_PANE_WINDOW_H - 1}px)`);
    const onChange = () => setShort(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return short;
}

/** M4 polish: below a 760px WINDOW width the plate's two-column layout is
 *  the next thing to overflow after the pie/legend themselves (`usePaneShort`
 *  handles the pie diameter and legend scroll) — the left rail (pie +
 *  readout) narrows from 240px to 140px so the right column keeps enough
 *  room to read a filename. Same shape as `usePaneShort`, width instead of
 *  height; a SEPARATE threshold, since a short-but-wide window and a
 *  narrow-but-tall one hit different overflow first. Measures
 *  `window.innerWidth`, NOT the narrower pane the sidebar leaves when open
 *  (unlike the height axis, where pane height is a constant window-height
 *  offset) — a 1000px window with the default 280px sidebar has a pane
 *  narrower than this threshold implies; see the size-clamp fix on the
 *  `<Pie>` disc below, which also checks `narrow` for exactly this reason. */
const NARROW_PANE_WINDOW_W = 760;

function usePaneNarrow(): boolean {
  const [narrow, setNarrow] = React.useState(
    () => typeof window !== "undefined" && window.innerWidth <= NARROW_PANE_WINDOW_W,
  );
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(`(max-width: ${NARROW_PANE_WINDOW_W}px)`);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/** `formatAgo` already returns the complete phrase "just now" for anything
 *  under 60s — appending " ago" unconditionally used to read "just now ago"
 *  for the normal case of a file opened or bookmarked in the last minute
 *  (review: PiePlate.tsx:229). One helper, both call sites below. */
function mtimeAgo(mtimeMs: number): string {
  const ago = formatAgo(Math.floor(mtimeMs / 1000), Math.floor(Date.now() / 1000));
  return ago === "just now" ? ago : `${ago} ago`;
}

function lastOpenedLabel(pie: DerivedPie): string {
  const { files } = pie;
  // Pinned's mtime is bookmarked_at (derived-pies.ts), i.e. when the file
  // was starred, not when it was opened — "Last opened" claimed something
  // the data does not support (review: PiePlate.tsx:59). Before a user
  // pie's first M3 census resolves, `mtime` is still `added_at` (pies.ts's
  // `pieFiles` fallback) — when the file was ADDED, not when it changed,
  // the same category of mislabel (review: pies.ts:19); once `pie.census`
  // is set, `mtime` is a REAL file mtime (`toDerivedPie`'s census branch),
  // so the label graduates from "Last added" to "Last changed" the moment
  // that first census lands.
  const isPinned = pie.id === "builtin:pinned";
  const isUser = isUserPieId(pie.id);
  if (files.length === 0) return isPinned ? "Never pinned" : isUser ? "No files added" : "Never opened";
  const newest = Math.max(...files.map((f) => f.mtime));
  const verb = isPinned ? "Last pinned" : isUser ? (pie.census ? "Last changed" : "Last added") : "Last opened";
  return `${verb} ${mtimeAgo(newest)}`;
}

export interface PiePlateProps {
  pie: DerivedPie;
  onClose: () => void;
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
  /** M3: `pickDirectory` for "Locate…" on a missing folder member. */
  ipc: IpcSurface;
  /** M3: a refused "Locate…" (the picked replacement doesn't resolve)
   *  surfaces through `AppShell`'s own `AppNotice`, the same bridge
   *  `Sky.tsx`'s own folder-add failure already uses — optional so a bare
   *  test double for `PiePlateProps` still renders without one. */
  onNotice?: (text: string, action?: AppNoticeAction, durationMs?: number) => void;
  /** M4: deep-link reveal (App.tsx's `revealRoute === "plate"`) arms this
   *  with the file the reveal targeted — on mount, that row gets DOM focus
   *  and the roving-tabindex slot, INSTEAD OF the checked-legend-radio
   *  mount focus below (spec section 7: "the plate opens on that pie with
   *  the row focused"). `null`/omitted for every other way the plate opens
   *  (a band click, Enter on the band). */
  focusPath?: string | null;
  /** M4: changes identity every time a NEW reveal targets the pie already
   *  behind this open plate (Sky.tsx computes it from `revealTarget.nonce`)
   *  — the focus effect below re-runs on a change here even though
   *  `pie.id`/mount identity stay the same, so a second reveal into an
   *  already-open plate still moves focus (review: PiePlate.tsx:479).
   *  `undefined` whenever `focusPath` is also unset. */
  focusNonce?: number;
  /** M4: called once the focus effect below has used `focusPath` (found
   *  the row, or fell through to the legend-radio target) — Sky.tsx wires
   *  this to App.tsx's `clearRevealTarget`, making the deep-link reveal a
   *  true one-shot instead of re-steering every later mount focus (review:
   *  App.tsx:466). Never called when `focusPath` was never set. */
  onFocusConsumed?: () => void;
}

export default function PiePlate({
  pie,
  onClose,
  onOpenFile,
  ipc,
  onNotice,
  focusPath,
  focusNonce,
  onFocusConsumed,
}: PiePlateProps): React.ReactElement {
  const { root } = useWorkspace();
  const contextMenu = useContextMenu();
  const fileMenuFor = useFileMenu(onOpenFile);
  const piesCtx = usePiesContext();
  const pieCensusCtx = usePieCensus();
  const { openCountFor } = useAnnotations();
  const short = usePaneShort();
  const narrow = usePaneNarrow();
  const plateRef = React.useRef<HTMLDivElement | null>(null);
  const layerListRef = React.useRef<HTMLDivElement | null>(null);
  const legendRefs = React.useRef<Partial<Record<FileKind, HTMLButtonElement | null>>>({});

  const [filterKind, setFilterKind] = React.useState<FileKind | null>(null);
  // The radiogroup's own "cursor" (roving tabindex / aria-checked), distinct
  // from `filterKind` — spec section 4: ←/→ "rotate the SELECTION by
  // bearing", Enter/click then "toggles the FILTER". Arrowing to a kind
  // must not itself cut the wedge; only Enter/click does. `null` here means
  // "follow the readout kind" (below) until the user actually navigates.
  const [focusedKindState, setFocusedKindState] = React.useState<FileKind | null>(null);
  const [focusedLayer, setFocusedLayer] = React.useState(0);

  const isUserPie = isUserPieId(pie.id);
  // The raw persisted `Pie` behind this plate — `DerivedPie` (M1's shape)
  // carries `files`/`fresh`/`census` but not `members`/`seen_at` directly;
  // `piesCtx.pies` is the one live source for those, reconciled on every
  // `skypie://pies-updated`, so reading it here instead of adding
  // `members`/`seen_at` to `DerivedPie` keeps exactly one place that can go
  // stale rather than two. `undefined` for a derived Pinned/Recent pie.
  const rawPie = isUserPie ? piesCtx.pies.find((p) => p.id === pie.id) : undefined;
  const members = rawPie?.members ?? [];
  const treeMode = members.some((m) => m.kind === "folder");
  // The "new" dot's baseline is `seen_at` AS OF THE MOMENT THIS PLATE
  // OPENED, NOT the live `rawPie.seen_at` below, which the mount effect
  // right after this bumps to `Date.now()` on the very same open. Reading
  // the live value here would mean every row's mtime is compared against a
  // timestamp from AFTER it was written, so the marker this open exists to
  // SHOW would already read false before its first paint — the same bug
  // the pill itself avoids by living on the BAND tile, which is never
  // remounted by opening the plate. `useMemo`, not `useState`'s lazy
  // initializer, deliberately: Sky.tsx keys `<PiePlate key={openPie.id}>`
  // (review fix, PiePlate.tsx:479), so a pie SWITCH is always a fresh
  // mount and `pie.id` never changes under one instance — but a plain
  // `useState` initializer would still need `useMemo`'s per-mount
  // recompute semantics to stay correct if that ever changes back to an
  // in-place pie swap, and costs nothing to keep either way.
  //
  // Falls back to `created_at` when `seen_at` is still 0 (a pie's first-
  // ever open) instead of leaving the baseline at 0 — a bare `0` baseline
  // paired with the `seenAtAtOpen > 0` guard below meant a file added on a
  // brand-new pie's FIRST open could never carry the "new" dot, exactly
  // the create → open → write flow the M5 brief's own acceptance
  // checkpoint drives (review, PiePlate.tsx:256, major). `created_at` is
  // itself a meaningful "nothing has been seen before this" baseline —
  // it keeps the anti-"every row is new" property the `> 0` guard exists
  // for: a file older than the pie (mtime <= created_at) still stays
  // unmarked, only a file written after the pie was minted (or after its
  // last real open) counts as new.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seenAtAtOpen = React.useMemo(() => rawPie?.seen_at || rawPie?.created_at || 0, [pie.id]);

  // Stamp seen_at on open (only meaningful for a persisted pie — a derived
  // Pinned/Recent pie has no such field and `touchPieSeen` on an unknown id
  // is a harmless no-op on the Rust side, but there is nothing to stamp for
  // it, so this skips the call entirely rather than relying on that). Also
  // triggers this pie's "plate open" census refresh (spec section 6) — the
  // same open/switch moment, so one effect covers both.
  React.useEffect(() => {
    if (isUserPie) {
      void piesCtx.touchPieSeen(pie.id);
      pieCensusCtx.refresh(pie.id);
    }
    // Only on open (mount) / when the plate switches to a different pie —
    // not on every render, which would hammer the debounced writer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pie.id]);

  const wedges = React.useMemo(() => wedgesOf(pie.files), [pie.files]);
  const groups = React.useMemo(() => groupByWedge(pie.files), [pie.files]);

  // The cursor can point at a kind that just disappeared from `wedges` —
  // removing the last file of the focused kind through a layer row's
  // "Remove from pie" leaves `focusedKindState` naming a kind with no
  // radio at all, so `checked` is false for every row, every radio gets
  // `tabIndex={-1}`, and the radiogroup falls out of the tab order
  // entirely (review: PiePlate.tsx:119). `setFocusedLayer` already gets
  // this same reset on the layer list below; the legend needed its own.
  React.useEffect(() => {
    if (focusedKindState && !wedges.some((w) => w.kind === focusedKindState)) {
      setFocusedKindState(null);
    }
  }, [wedges, focusedKindState]);

  const dominant = wedges.reduce<typeof wedges[number] | null>(
    (best, w) => (best === null || w.share > best.share ? w : best),
    null,
  );
  const readoutKind = filterKind ?? dominant?.kind ?? null;
  const focusedKind = focusedKindState ?? readoutKind;
  const readoutWedge = readoutKind ? wedges.find((w) => w.kind === readoutKind) ?? null : null;
  // The count is the READOUT KIND's file count, not the pie's total — the
  // spec's own example (`html · 60% · 9 files`) only works if 9 is the
  // count behind the 60% (9/15, say); `pie.files.length` made the two
  // figures disagree for any pie that is not 100% one kind (review:
  // PiePlate.tsx:93).
  const readout = readoutWedge
    ? `${KIND_LABELS[readoutWedge.kind]} · ${Math.round(readoutWedge.share * 100)}% · ${readoutWedge.count} file${readoutWedge.count === 1 ? "" : "s"}`
    : "No files";

  const layerFiles = React.useMemo(() => {
    const base = filterKind ? groups.get(filterKind) ?? [] : pie.files;
    return [...base].sort((a, b) => b.mtime - a.mtime);
  }, [filterKind, groups, pie.files]);

  // M3: one layer per folder member (in stored member order) plus a
  // trailing "Files" layer — fed the SAME filtered set `layerFiles` already
  // computed above, so the slice filter narrows a tree layer's rows exactly
  // the way it narrows the flat list. Only rendered as a tree when
  // `treeMode`; a pie with no folder members never calls this.
  const layers = React.useMemo(
    () => layersOf(layerFiles, members, pie.census),
    [layerFiles, members, pie.census],
  );

  // A direct FILE member that no longer resolves — dims with "not found" +
  // Forget in the trailing "Files" layer (spec section 5). `kindOf` works
  // on the path string alone, so a missing file still respects the current
  // slice filter even though it never reached `pie.files`/`pie.census`.
  const missingFileRows = React.useMemo(() => {
    const missing = new Set(pie.census?.missing ?? []);
    return members.filter(
      (m) => m.kind === "file" && missing.has(m.path) && (!filterKind || kindOf(m.path) === filterKind),
    );
  }, [members, pie.census, filterKind]);

  // The roving-tabindex NAVIGATION model — headers + file rows, in DOM
  // order — is the same shape whether or not `treeMode` is on: in flat
  // mode every item is a "file" and there are no headers at all, which is
  // exactly the M1/M2 behavior this replaces. Missing-file rows are
  // deliberately NOT part of this list (see FLAT_LAYER/renderFileRow's own
  // notes) — they carry only a Forget button, reachable by ordinary Tab.
  const navItems = React.useMemo<NavItem[]>(() => {
    if (!treeMode) return layerFiles.map((file) => ({ type: "file", layer: FLAT_LAYER, file }));
    const items: NavItem[] = [];
    for (const layer of layers) {
      items.push({ type: "header", layer });
      for (const file of layer.rows) items.push({ type: "file", layer, file });
    }
    return items;
  }, [treeMode, layerFiles, layers]);

  // Keyed by LAYER id + path, not path alone — `censusToFiles` now dedupes
  // a path across the whole pie, but two rows in the same render can still
  // legitimately share a path across a transient state update; keying by
  // layer+path means two rows can never collide onto one nav index even if
  // they did (review: PiePlate.tsx:290/293).
  const navIndexOf = React.useMemo(() => {
    const map = new Map<string, number>();
    navItems.forEach((item, i) => {
      map.set(item.type === "header" ? `h:${item.layer.id}` : `f:${item.layer.id}:${item.file.path}`, i);
    });
    return map;
  }, [navItems]);

  const handleLocate = async (layer: PieLayer) => {
    if (!ipc.pickDirectory || !layer.memberPath) return;
    const picked = await ipc.pickDirectory();
    if (!picked) return;
    try {
      await piesCtx.relocatePieMember(pie.id, layer.memberPath, picked);
    } catch (err: unknown) {
      onNotice?.(`Couldn't use that folder — ${String(err)}`);
    }
  };

  const handleForget = (path: string) => {
    void piesCtx.removePieMember(pie.id, path);
  };

  React.useEffect(() => {
    setFocusedLayer(0);
  }, [filterKind, pie.id]);

  // Symmetric to the legend's own `wedges`-shrink clamp above: removing a
  // layer (e.g. "Remove from pie" / Forget on a folder header, the M3 flow
  // the e2e itself drives) can leave `focusedLayer` pointing past the new
  // end of `navItems` — no header or row then satisfies `navIndex ===
  // focusedLayer`, every item keeps `tabIndex={-1}`, and the whole layer
  // list drops out of the Tab order until the filter or the pie changes
  // (review, minor: PiePlate.tsx:313).
  React.useEffect(() => {
    setFocusedLayer((i) => Math.min(i, Math.max(0, navItems.length - 1)));
  }, [navItems.length]);

  // Close on Esc — capture-phase and self-stopping (useEscape), so this
  // press does not ALSO leave reader mode the way a plain `escape` binding
  // in the global registry would. Guarded the same way App.tsx's reader-mode
  // Esc binding is: an open context menu (a layer row's "Copy Path" /
  // "Bookmark" / ...) still owns Esc and closes itself on the same window
  // event, so one keypress must not ALSO close the plate underneath it
  // (review: PiePlate.tsx:108).
  useEscape(() => {
    if (document.querySelector(".context-menu")) return;
    onClose();
  });

  // Close on an outside pointerdown or window blur (spec section 4). A real
  // click dispatches pointerdown before React commits this effect, so the
  // very click that opened the plate can never immediately close it.
  React.useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (plateRef.current?.contains(target)) return;
      // ContextMenuProvider renders the row context menu at the app root,
      // outside plateRef — without this, a pointerdown on one of its own
      // items ("Copy Path", "Bookmark", ...) reads as an outside click and
      // closes the plate the menu belongs to (review: PiePlate.tsx:115).
      if (target instanceof Element && target.closest(".context-menu")) return;
      onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  // The sandboxed HTML iframe (render/html.tsx) never forwards clicks to the
  // host, so while the plate is open the document underneath must stop
  // intercepting pointer events entirely — a click on it still reaches the
  // host and closes the plate via the outside-pointerdown handler above.
  React.useEffect(() => {
    const tabView = document.querySelector<HTMLElement>(".tab-view");
    if (!tabView) return;
    tabView.style.pointerEvents = "none";
    return () => {
      tabView.style.pointerEvents = "";
    };
  }, []);

  // role="dialog" with no focus move, no aria-modal and no focus restore
  // meant a screen-reader user heard nothing open on Enter (the tile stayed
  // focused) and the layer list's own ↑/↓/Home/End did nothing until several
  // Tabs landed inside (review: PiePlate.tsx:193). The plate does not trap
  // focus — Tab can still leave it — so aria-modal is explicitly "false"
  // rather than dropping role="dialog": that is what the attribute already
  // defaults to, made non-ambiguous here.
  // Focusing the PLATE CONTAINER here used to leave real DOM focus stranded
  // one level above every key handler that matters: `onLegendKeyDown` is
  // bound on `.pie-legend`, `onLayerKeyDown` on `.pie-layers`, and a keydown
  // whose target is the plate div reaches neither — ←/→ did nothing on
  // open, until a Tab (or several) landed inside (review: PiePlate.tsx:220,
  // reported against the spec's own M2 acceptance demo). Focus the CHECKED
  // legend radio instead — `legendRefs` is already populated by the time
  // this effect runs (refs attach during commit, before effects), so the
  // radiogroup's own keydown handler is live from the very first keypress.
  // Falls back to the plate container when there is no radio to focus (an
  // empty pie).
  //
  // Split into TWO effects (review fix, PiePlate.tsx:479/App.tsx:466):
  //
  // Effect A below captures whatever had focus right before the plate's
  // OWN focus effects run, and restores it — but ONLY on UNMOUNT (`[]`
  // deps). Kept separate from the focus-choosing effect so that effect's
  // OWN re-runs (a second reveal nonce, see below) never trip this
  // restore-on-cleanup: an earlier single-effect version returned
  // `() => previouslyFocused?.focus?.()` from the SAME effect that also
  // read `focusNonce`, so consuming a reveal (which flips `focusNonce`
  // back to `undefined` once `onFocusConsumed` clears `revealTarget`
  // upstream) reran that effect, its cleanup fired FIRST, and yanked real
  // focus straight back off the row this exact effect had just set —
  // caught by `ui/e2e/m4.e2e.ts`'s own reveal step during this fix.
  React.useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  // Effect B: the actual "what should be focused right now" decision —
  // the checked legend radio (spec section 4's mount-focus fix) UNLESS
  // `focusPath` is armed (App.tsx's deep-link reveal), in which case THIS
  // effect runs the reveal's own promise — "the plate opens on that pie
  // with the row focused" (spec section 7) — instead, not in a second
  // effect after it: a second effect would fire in DOM order after this
  // one and win the race for real focus regardless of which target made
  // more sense, and there is exactly one thing to focus at a time anyway.
  //
  // Deps are `[focusNonce]`, not `[]` — a plain mount-only effect covered
  // the FIRST reveal into a freshly opened plate (Sky.tsx keys `<PiePlate>`
  // by `openPie.id`, so a reveal that switches pies remounts it), but not a
  // SECOND reveal that targets a pie whose plate is already open: `pie.id`
  // doesn't change, so nothing remounts, and a mount-only effect never
  // fires again (review: PiePlate.tsx:479). `focusNonce` is exactly the
  // reveal's own nonce (Sky.tsx), so it changes on a genuinely new reveal
  // — but ALSO reverts to `undefined` once that reveal is consumed
  // (App.tsx clears `revealTarget`), which must NOT re-run the focus
  // logic below a second time; `lastNonceRef`/`didMountRef` tell "a fresh
  // reveal nonce" apart from "the same one going away" so only the FORMER
  // re-enters the body below.
  const didMountRef = React.useRef(false);
  const lastNonceRef = React.useRef<number | undefined>(focusNonce);
  React.useEffect(() => {
    const isMount = !didMountRef.current;
    didMountRef.current = true;
    const isFreshReveal = focusNonce !== undefined && focusNonce !== lastNonceRef.current;
    lastNonceRef.current = focusNonce;
    if (!isMount && !isFreshReveal) return;
    if (focusPath) {
      const navIndex = navItems.findIndex((item) => item.type === "file" && item.file.path === focusPath);
      if (navIndex >= 0) {
        setFocusedLayer(navIndex);
        // Same query `onLayerKeyDown`'s own `focusRow` uses — headers and
        // rows share it, in the SAME DOM order `navItems` was built in, so
        // this index lines up with `navIndex` exactly.
        const row = layerListRef.current?.querySelectorAll<HTMLElement>(
          ".pie-layer-header, .start-row",
        )[navIndex];
        row?.focus();
        onFocusConsumed?.();
        return;
      }
      // `focusPath` named a file that isn't in `navItems` YET — the pie's
      // census can still be in flight even though `App.tsx`'s own
      // `revealRoute` already saw it in `pie.files` a moment earlier (a
      // folder member's census resolving between that check and this
      // mount). Falls through to the legend-radio target below rather than
      // focusing nothing. Still reported as consumed — the target was
      // acted on (unsuccessfully), and without a fresh nonce this effect
      // will not run again to retry it, so leaving it "unconsumed" would
      // just leak the same stale target App.tsx:466 was about (review).
      onFocusConsumed?.();
    }
    const target = (focusedKind && legendRefs.current[focusedKind]) || plateRef.current;
    target?.focus();
    // `focusedKind`/`legendRefs`/`navItems`/etc. deliberately excluded:
    // this is the INITIAL (or reveal-triggered) focus target, not a resync
    // on every readout change, which would steal focus back from wherever
    // the user has since moved it (e.g. into the layer list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  // Loose enough to accept either a mouse click or the Enter keydown that
  // opens the focused row — both carry the same modifier keys
  // openOptsFromClick reads.
  const openRow = (
    file: DerivedPieFile,
    e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number },
  ) => {
    const opts = openOptsFromClick(e);
    onOpenFile(file.path, opts);
    // A plain click closes the plate; a ⌘-click (or middle-click) keeps it
    // open, the same convention openOptsFromClick already encodes elsewhere.
    if (!opts) onClose();
  };

  // Moves the radiogroup's cursor to `kind` and, for a real DOM focus move
  // (not just the aria-checked flag), focuses the matching legend button —
  // used by ←/→ navigation AND by a wedge click (Pie.tsx's `onWedgeClick`),
  // which is how a mouse click on the PORTRAIT svg (aria-hidden, no radio
  // of its own) still lands real keyboard focus on the right="radio" it is
  // a pointer proxy for.
  const focusRadio = (kind: FileKind) => {
    setFocusedKindState(kind);
    legendRefs.current[kind]?.focus();
  };

  // Enter, or a click on a legend row / wedge: move the cursor there AND
  // toggle the cut (spec section 4: "Enter or click toggles the filter").
  const activateRadio = (kind: FileKind) => {
    focusRadio(kind);
    setFilterKind((k) => (k === kind ? null : kind));
  };

  const onLegendKeyDown = (e: React.KeyboardEvent) => {
    if (wedges.length === 0) return;
    const kinds = wedges.map((w) => w.kind);
    const current = focusedKind ? kinds.indexOf(focusedKind) : -1;
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusRadio(kinds[(current + 1 + kinds.length) % kinds.length]);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusRadio(kinds[(current - 1 + kinds.length) % kinds.length]);
        break;
      case "Enter":
        e.preventDefault();
        if (focusedKind) setFilterKind((k) => (k === focusedKind ? null : focusedKind));
        break;
      default:
        break;
    }
  };

  const onLayerKeyDown = (e: React.KeyboardEvent) => {
    if (navItems.length === 0) return;
    // Headers and rows share ONE query — in flat mode there are zero
    // `.pie-layer-header` elements, so this degrades to exactly the old
    // `.start-row`-only lookup; in tree mode it walks headers and rows in
    // the same DOM order `navItems` was built in.
    const focusRow = (idx: number) => {
      const clamped = Math.max(0, Math.min(navItems.length - 1, idx));
      setFocusedLayer(clamped);
      const row = layerListRef.current?.querySelectorAll<HTMLElement>(
        ".pie-layer-header, .start-row",
      )[clamped];
      row?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(focusedLayer + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRow(focusedLayer - 1);
        break;
      case "Home":
        e.preventDefault();
        focusRow(0);
        break;
      case "End":
        e.preventDefault();
        focusRow(navItems.length - 1);
        break;
      case "Enter": {
        e.preventDefault();
        // Enter on a folder HEADER is a no-op — there is no expand/collapse
        // in M3, and Locate…/Forget are their own separately-focusable
        // buttons, not reached through this roving list.
        const item = navItems[focusedLayer];
        if (item?.type === "file") openRow(item.file, e);
        break;
      }
      case "Backspace":
        // The slice filter's only documented way out besides the chip
        // (spec section 5: "pressing Backspace clears the filter").
        if (filterKind) {
          e.preventDefault();
          setFilterKind(null);
        }
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={plateRef}
      className={
        "pie-plate" + (short ? " pie-plate-short" : "") + (narrow ? " pie-plate-narrow" : "")
      }
      role="dialog"
      aria-label={`${pie.name} pie`}
      aria-modal="false"
      tabIndex={-1}
      data-testid="pie-plate"
      // The plate is a DOM descendant of the band, which is itself a
      // listbox with its own arrow/Home/End/Enter handling (Sky.tsx) — stop
      // a key the plate's own rows already handled (its layer list's
      // ↑/↓/Home/End/Enter) from also reaching the band underneath it.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="pie-plate-left">
        {/* A static portrait of the pie already open — non-interactive
            (Pie.tsx), so it is not a second role="option"/data-pie-id for
            this pie inside the band's listbox. Its wedge paths are still
            pointer PROXIES for the radiogroup on the right (`onWedgeClick`)
            — see the ARIA-ownership note on `onWedgeClick` in Pie.tsx. */}
        <Pie
          pie={pie}
          // `narrow`, not just `short` (review: styles.css:3458) — the left
          // rail only drops to 140px under `.pie-plate-narrow`, and narrow
          // can be true while short is false (a narrow-but-tall window, a
          // 640x800 desktop floor is reachable). A 200px disc in a 140px
          // rail overflows the rail's padding/border by ~14px each side;
          // checking either breakpoint keeps the disc inside its rail at
          // every supported window size.
          size={short || narrow ? 120 : 200}
          interactive={false}
          cutKind={filterKind}
          onWedgeClick={activateRadio}
        />
        <div className="pie-plate-readout">{readout}</div>
        {pie.census?.truncated ? (
          // spec section 4 fixes the left-column order as pie, readout,
          // "truncated · 20,000+", then "Last opened" — this used to render
          // AFTER pie-plate-last-opened (review, minor: PiePlate.tsx:539).
          // A plain count would keep moving as later folders are skipped,
          // so the label names the CAP instead of a number that would be
          // wrong the moment it's read.
          <div className="pie-plate-truncated" data-testid="pie-truncated">
            truncated · 20,000+
          </div>
        ) : null}
        <div className="pie-plate-last-opened">{lastOpenedLabel(pie)}</div>
      </div>
      <div className="pie-plate-right">
        {/* role="radiogroup": the legend rows AND the portrait's wedge
            paths (Pie.tsx) are one control (spec section 4). The wedges
            can't literally BE the radios — they live in an aria-hidden svg
            in the OTHER flex column, and ARIA ownership cannot span
            `.pie-plate-left`/`.pie-plate-right` without `display: contents`
            on an intervening element, which is not worth the WebKit
            rendering risk for a cosmetic a11y-tree shortcut. A wedge click
            instead calls `onWedgeClick`, which moves real focus AND
            aria-checked onto the matching legend radio here — so a
            keyboard/AT user drives the whole thing from this list, and a
            mouse user can use either the wedge or the row. */}
        <div
          className="pie-legend"
          role="radiogroup"
          aria-label="File kinds"
          data-testid="pie-legend"
          onKeyDown={onLegendKeyDown}
        >
          {wedges.length === 0 ? (
            <p className="pie-legend-empty">No files in this pie yet.</p>
          ) : (
            wedges.map((w) => {
              const kindFiles = groups.get(w.kind) ?? [];
              const newest = Math.max(...kindFiles.map((f) => f.mtime));
              const openComments = kindFiles.reduce((sum, f) => sum + openCountFor(f.path), 0);
              const cut = filterKind === w.kind;
              const checked = focusedKind === w.kind;
              const KindIcon = KIND_ICON[w.kind];
              return (
                <button
                  key={w.kind}
                  ref={(el) => {
                    legendRefs.current[w.kind] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  className={"pie-legend-row" + (cut ? " active" : "")}
                  onClick={() => activateRadio(w.kind)}
                >
                  <span className="pie-legend-glyph">
                    <KindIcon size={14} strokeWidth={1.75} aria-hidden />
                  </span>
                  <span className="pie-legend-kind">{KIND_LABELS[w.kind]}</span>
                  <span className="pie-legend-count">{w.count}</span>
                  <span className="pie-legend-share">{Math.round(w.share * 100)}%</span>
                  <span className="pie-legend-mtime">{Number.isFinite(newest) ? mtimeAgo(newest) : ""}</span>
                  {openComments > 0 ? (
                    <span className="pie-legend-comments" aria-label={`${openComments} open comments`}>
                      <MessageSquare size={12} strokeWidth={2} aria-hidden />
                      {openComments}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
        {filterKind ? (
          // The filter's only documented ways out besides re-clicking the
          // same legend row (spec section 5): this chip, or Backspace while
          // the layer list has focus (onLayerKeyDown above). Neither shipped
          // before, so nothing told the user how to leave the filtered view
          // (review: PiePlate.tsx:223).
          <button
            type="button"
            className="pie-slice-chip"
            data-testid="pie-slice-chip"
            onClick={() => setFilterKind(null)}
            aria-label={`Clear the ${KIND_LABELS[filterKind]} filter`}
          >
            Slice · {KIND_LABELS[filterKind]} <span aria-hidden>×</span>
          </button>
        ) : null}
        <div
          ref={layerListRef}
          className="pie-layers"
          role={treeMode ? "tree" : "listbox"}
          aria-label={filterKind ? `${KIND_LABELS[filterKind]} files` : "All files"}
          data-testid="pie-layers"
          onKeyDown={onLayerKeyDown}
        >
          {navItems.length === 0 && missingFileRows.length === 0 ? (
            <p className="pie-layers-empty">No files.</p>
          ) : treeMode ? (
            layers.map((layer) => (
              <React.Fragment key={layer.id}>
                {renderLayerHeader(layer)}
                {layer.rows.map((file) =>
                  renderFileRow(file, navIndexOf.get(`f:${layer.id}:${file.path}`) ?? -1, 2),
                )}
                {layer.kind === "files" ? missingFileRows.map((m) => renderMissingFileRow(m.path)) : null}
              </React.Fragment>
            ))
          ) : (
            <>
              {layerFiles.map((file, i) => renderFileRow(file, i))}
              {missingFileRows.map((m) => renderMissingFileRow(m.path))}
            </>
          )}
        </div>
      </div>
    </div>
  );

  /** One folder layer's header row (spec section 5): the member-relative
   *  mono path, plus whichever of "folder not found" (Locate…/Forget) or
   *  "not live" applies. `role="treeitem" aria-level="1"` participates in
   *  the SAME roving-tabindex sequence `onLayerKeyDown` drives — its own
   *  slot comes from `navIndexOf`, exactly like a file row's. */
  function renderLayerHeader(layer: PieLayer): React.ReactElement {
    const navIndex = navIndexOf.get(`h:${layer.id}`) ?? -1;
    const label = layer.kind === "folder" ? displayPath(layer.memberPath ?? layer.label, root) : layer.label;
    return (
      <div
        className="pie-layer-header"
        data-testid="pie-layer-header"
        role="treeitem"
        aria-level={1}
        aria-selected={navIndex === focusedLayer}
        tabIndex={navIndex === focusedLayer ? 0 : -1}
        onFocus={() => setFocusedLayer(navIndex)}
      >
        <span className="pie-layer-header-path">
          <bdi>{layer.missing ? `${label} — folder not found` : label}</bdi>
        </span>
        {layer.missing ? (
          <span className="pie-layer-caption pie-layer-missing">
            <button
              type="button"
              data-testid="pie-locate"
              onClick={(e) => {
                e.stopPropagation();
                void handleLocate(layer);
              }}
            >
              Locate…
            </button>
            <button
              type="button"
              data-testid="pie-forget"
              onClick={(e) => {
                e.stopPropagation();
                if (layer.memberPath) handleForget(layer.memberPath);
              }}
            >
              Forget
            </button>
          </span>
        ) : !layer.live ? (
          <span className="pie-layer-caption">not live</span>
        ) : null}
      </div>
    );
  }

  /** A single file row — shared by the flat listbox (`role="option"`, no
   *  `aria-level`) and a tree layer's rows (`role="treeitem"
   *  aria-level="2"`). `navIndex` is this row's slot in `navItems`; `-1`
   *  (never found) renders unselected/untabbable rather than throwing. */
  function renderFileRow(file: DerivedPieFile, navIndex: number, ariaLevel?: 2): React.ReactElement {
    const selected = navIndex === focusedLayer;
    return (
      <button
        key={file.path}
        type="button"
        role={ariaLevel ? "treeitem" : "option"}
        aria-level={ariaLevel}
        aria-selected={selected}
        className="start-row"
        title={file.path}
        tabIndex={selected ? 0 : -1}
        onFocus={() => setFocusedLayer(navIndex)}
        onClick={(e) => openRow(file, e)}
        // React's onClick never fires for the middle button — the same
        // .start-row shape in StartPage.tsx handles it this way, and spec
        // section 5 gives middle-click the same background-tab-plate-stays
        // behaviour as ⌘-click (review: PiePlate.tsx:257).
        onAuxClick={(e) => {
          if (e.button === 1) openRow(file, e);
        }}
        onContextMenu={(e) => {
          const sections = fileMenuFor(file.path);
          // Only a USER pie's own layer rows get these — a derived
          // Pinned/Recent pie has no "membership" to remove from (Pinned
          // is the bookmarks star; Recent is the recents list), and both
          // already have their own toggle in the standard file menu above.
          if (isUserPie) {
            sections.push([
              {
                label: "Remove from pie",
                icon: <XCircle size={13} strokeWidth={2} />,
                onSelect: () => void piesCtx.removePieMember(pie.id, file.path),
              },
              {
                label: "Add to another pie…",
                icon: <PieChart size={13} strokeWidth={2} />,
                onSelect: () => piesCtx.openPicker(file.path),
              },
            ]);
          }
          contextMenu.open(e, sections);
        }}
      >
        <span className="start-row-icon">
          <FileGlyph name={basename(file.path)} size={15} />
        </span>
        <span className="start-row-name">{basename(file.path)}</span>
        <span className="start-row-dir">
          <bdi>{displayDir(file.path, root)}</bdi>
        </span>
        <span className="start-row-mtime">{mtimeAgo(file.mtime)}</span>
        {seenAtAtOpen > 0 && file.mtime > seenAtAtOpen ? (
          // spec section 5: "a 'new' dot when mtime > seen_at" — against
          // the FROZEN seenAtAtOpen (see its own doc comment above), not
          // the live value this same open is in the middle of bumping.
          // The `seenAtAtOpen > 0` guard is load-bearing, not decorative:
          // `seenAtAtOpen` is 0 for a derived pie (no `seen_at` at all) AND
          // for a user pie that has never been opened, and `file.mtime > 0`
          // is true for any real timestamp — without the guard, `mtime > 0`
          // marked EVERY row "new" in both of those cases, the same
          // `seen_at == 0` rule `workspace.rs::census_with_cap` and
          // `freshCount` already enforce for the pill (review:
          // PiePlate.tsx:756/762, blocker).
          <React.Fragment>
            <span className="start-row-new" data-testid="pie-row-new" aria-hidden />
            {/* The dot itself is `aria-hidden` — a screen-reader user
                reading this row otherwise hears only name/dir/mtime and is
                never told it's the row the agent's add just produced, the
                whole outcome M5 exists to surface (the band tile's own
                `aria-label` folds its count in; this row had no
                equivalent). Visually-hidden rather than a visible label so
                the row's layout is unchanged for a sighted user — standard
                clip-to-1px, not a new global class, since this codebase has
                no existing `.sr-only` utility to reuse (review:
                PiePlate.tsx:925, minor). */}
            <span
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: "hidden",
                clip: "rect(0, 0, 0, 0)",
                whiteSpace: "nowrap",
                border: 0,
              }}
            >
              {" — new"}
            </span>
          </React.Fragment>
        ) : null}
      </button>
    );
  }

  /** A direct FILE member that no longer resolves — dimmed, "not found",
   *  Forget only (no Locate…: there is nothing to re-point a single file
   *  at, unlike a folder). Not part of the roving-tabindex sequence — its
   *  one action is the Forget button itself, reachable by ordinary Tab.
   *  `role`/`aria-disabled` match the live rows' shape (`option` in flat
   *  mode, `treeitem` at level 2 in tree mode) so the container's
   *  `role="tree"`/`role="listbox"` — which only permits `treeitem`/
   *  `option` children — announces this row as an item rather than
   *  dropping it from, or breaking, the accessibility tree (review, minor:
   *  PiePlate.tsx:772/774). It is always the LAST row of the trailing
   *  "Files" layer (or the flat list), so leaving it out of `navItems`
   *  does not put it ahead of any row the roving index still has to reach. */
  function renderMissingFileRow(path: string): React.ReactElement {
    return (
      <div
        key={path}
        className="start-row start-row-missing"
        title={path}
        role={treeMode ? "treeitem" : "option"}
        aria-level={treeMode ? 2 : undefined}
        aria-disabled="true"
      >
        <span className="start-row-icon">
          <FileGlyph name={basename(path)} size={15} />
        </span>
        <span className="start-row-name">{basename(path)}</span>
        <span className="start-row-dir">
          <bdi>{displayDir(path, root)} — not found</bdi>
        </span>
        <button
          type="button"
          data-testid="pie-forget"
          onClick={() => handleForget(path)}
        >
          Forget
        </button>
      </div>
    );
  }
}
