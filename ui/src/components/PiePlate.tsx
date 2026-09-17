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
// M3: the layer list is ALWAYS built from `layersOf` (`state/pie-census.ts`)
// — one layer per folder member in stored order, plus a trailing "Files"
// layer for direct file members. It is DRAWN two ways: with folder headers
// as a `role="tree"` (`treeitem` at `aria-level="1"` over rows at
// `aria-level="2"`, spec section 5), or — when the only layer is the
// unnamed "Files" one, which is every pie with no folder members — with no
// headers at all, as the flat `role="listbox"` M1/M2 already shipped. One
// list, one row renderer, one keyboard sequence; only the headers and the
// container role differ. A list holding a MISSING row takes the tree roles
// even with no headers: `role="option"` would strip that row's own Forget
// button from the accessibility tree (see `treeRoles` below).
import * as React from "react";
import { FileCode, FileText, FileImage, FileJson, File as FileIconGlyph, MessageSquare, PieChart, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Pie from "./Pie";
import { BUILTIN_PINNED_ID, groupByWedge, wedgesOfGroups } from "../state/derived-pies";
import type { DerivedPie, DerivedPieFile, Wedge } from "../state/derived-pies";
import { isUserPieId } from "../state/pies";
import { kindOf } from "../render/kind";
import type { FileKind } from "../render/kind";
import { layersOf, usePieCensus } from "../state/pie-census";
import type { PieLayer } from "../state/pie-census";
import type { PieMember } from "../ipc";
import { FileGlyph } from "./FileIcon";
import { basename, displayDir, displayPath } from "../utils/path";
import { messageOf } from "../utils/error-message";
import { formatAgo } from "../utils/beam-format";
import { useEscape } from "../hooks/useEscape";
import { useContextMenu } from "./ContextMenu";
import { useFileMenu } from "../hooks/useFileMenu";
import { usePiesContext } from "../state/pies-context";
import { useWorkspace } from "../state/workspace";
import { useAnnotations } from "../state/annotations-context";
import { openOptsFromClick } from "../state/TabsProvider";
import type { OpenFileOptions } from "../state/TabsProvider";

/** One entry in the layer list, in DOM order — a folder layer's header, or
 *  a single file row. Its INDEX in the array IS its roving-tabindex slot,
 *  so nothing has to look one up: the render loop below walks this array
 *  once and hands each item the index it is already at. */
type NavItem =
  | { type: "header"; key: string; layer: PieLayer }
  | { type: "file"; key: string; file: DerivedPieFile };

/** The member list of a pie that has none (or of a derived Pinned/Recent
 *  pie, which has no `members` field at all). Hoisted so it keeps ONE
 *  identity: a fresh `[]` per render re-ran every `useMemo` keyed on
 *  `members` on every render of a pie with no members. */
const NO_MEMBERS: PieMember[] = [];

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

/** pane height < 480px is the spec's "short window" floor (section 4): the
 *  plate pie drops to 120px. The subtraction is the plate's own space model
 *  — pane = window − 40 tab strip − 40 toolbar − 120 sky band − 32 margin —
 *  the same 232px `.pie-plate`'s `clamp(280px, calc(100vh - 232px), 440px)`
 *  uses (styles.css). Counting only the two 40px chrome bars engaged the
 *  floor about 120px too late. Tracking window height directly, with no DOM
 *  measurement, keeps the two in step. */
const SHORT_PANE_WINDOW_H = 480 + 232;

function usePaneShort(): boolean {
  const [short, setShort] = React.useState(
    () => typeof window !== "undefined" && window.innerHeight < SHORT_PANE_WINDOW_H,
  );
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(`(max-height: ${SHORT_PANE_WINDOW_H - 1}px)`);
    // No eager `onChange()`: the lazy initializer above already read the
    // same window height with the same threshold, so calling it on mount
    // only set the state it was already in.
    const onChange = () => setShort(mql.matches);
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
 *  for the normal case of a file opened or bookmarked in the last minute.
 *  One helper, both call sites below. */
export function mtimeAgo(mtimeMs: number): string {
  const ago = formatAgo(Math.floor(mtimeMs / 1000), Math.floor(Date.now() / 1000));
  return ago === "just now" ? ago : `${ago} ago`;
}

export function lastOpenedLabel(pie: DerivedPie): string {
  const { files } = pie;
  // Pinned's mtime is bookmarked_at (derived-pies.ts), i.e. when the file
  // was starred, not when it was opened — "Last opened" claimed something
  // the data does not support. Before a user
  // pie's first M3 census resolves, `mtime` is still `added_at` (pies.ts's
  // `pieFiles` fallback) — when the file was ADDED, not when it changed,
  // the same category of mislabel; once `pie.census` is set, `mtime` is a
  // REAL file mtime (`toDerivedPie`'s census branch), so the label
  // graduates from "Last added" to "Last changed" the moment that first
  // census lands.
  const isPinned = pie.id === BUILTIN_PINNED_ID;
  const isUser = isUserPieId(pie.id);
  if (files.length === 0) return isPinned ? "Never pinned" : isUser ? "No files added" : "Never opened";
  const newest = Math.max(...files.map((f) => f.mtime));
  const verb = isPinned ? "Last pinned" : isUser ? (pie.census ? "Last changed" : "Last added") : "Last opened";
  return `${verb} ${mtimeAgo(newest)}`;
}

/** The pie's dominant wedge — the biggest share. A tie keeps the FIRST
 *  wedge, and `wedgesOfGroups` returns them in BEARINGS order, so a 50/50
 *  pie reads out the kind nearer north (strict `>`, never `>=`). */
export function dominantWedge(wedges: Wedge[]): Wedge | null {
  return wedges.reduce<Wedge | null>(
    (best, w) => (best === null || w.share > best.share ? w : best),
    null,
  );
}

/** The mono readout, e.g. `HTML · 60% · 9 files`. The count is the READOUT
 *  KIND's file count, not the pie's total — the spec's own example only
 *  works if 9 is the count behind the 60% (9/15, say); the pie total made
 *  the two figures disagree for any pie that is not 100% one kind. */
export function readoutLabel(wedge: Wedge | null): string {
  if (!wedge) return "No files";
  const files = `${wedge.count} file${wedge.count === 1 ? "" : "s"}`;
  return `${KIND_LABELS[wedge.kind]} · ${Math.round(wedge.share * 100)}% · ${files}`;
}

export interface PiePlateProps {
  pie: DerivedPie;
  onClose: () => void;
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
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
  const members = rawPie?.members ?? NO_MEMBERS;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seenAtAtOpen = React.useMemo(() => rawPie?.seen_at ?? 0, [pie.id]);

  // Stamp seen_at on open (only meaningful for a persisted pie — a derived
  // Pinned/Recent pie has no such field and `touchPieSeen` on an unknown id
  // is a harmless no-op on the Rust side, but there is nothing to stamp for
  // it, so this skips the call entirely rather than relying on that). Also
  // triggers this pie's "plate open" census refresh (spec section 6) — the
  // same open/switch moment, so one effect covers both.
  React.useEffect(() => {
    if (isUserPie) {
      // Nothing to show the user for a failed stamp — `seen_at` drives the
      // M3 freshness pill, not anything on screen now — but a dropped
      // rejection here would hide a store that refuses every write.
      piesCtx.touchPieSeen(pie.id).catch((err: unknown) => {
        console.warn("skypie: touchPieSeen failed", err);
      });
      pieCensusCtx.refresh(pie.id);
    }
    // Only on open (mount) / when the plate switches to a different pie —
    // not on every render, which would hammer the debounced writer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pie.id]);

  // One grouping pass per file list; the wedges are derived from it rather
  // than regrouping the same files a second time.
  const groups = React.useMemo(() => groupByWedge(pie.files), [pie.files]);
  const wedges = React.useMemo(() => wedgesOfGroups(groups), [groups]);

  // The wedge the readout describes: the filtered kind while a slice is on,
  // otherwise the pie's dominant kind.
  const readoutWedge = React.useMemo<Wedge | null>(() => {
    if (filterKind) return wedges.find((w) => w.kind === filterKind) ?? null;
    return dominantWedge(wedges);
  }, [filterKind, wedges]);
  const readoutKind = filterKind ?? readoutWedge?.kind ?? null;
  // The cursor can point at a kind that just disappeared from `wedges` —
  // removing the last file of the focused kind through a layer row's
  // "Remove from pie" left `focusedKindState` naming a kind with no radio
  // at all, so `checked` was false for every row, every radio got
  // `tabIndex={-1}`, and the radiogroup fell out of the tab order entirely
  //. Validating the cursor HERE, at render, is
  // the same correction without the extra state round trip an effect
  // needed — the bad frame that effect had to repair never renders.
  const focusedKind =
    focusedKindState && wedges.some((w) => w.kind === focusedKindState)
      ? focusedKindState
      : readoutKind;
  const readout = React.useMemo(() => readoutLabel(readoutWedge), [readoutWedge]);
  const lastOpened = React.useMemo(() => lastOpenedLabel(pie), [pie]);

  // Per-kind legend facts, scanned once per (files, comment state) change
  // instead of once per legend row per render.
  const legendFacts = React.useMemo(() => {
    const facts = new Map<FileKind, { newest: number; openComments: number }>();
    for (const [kind, kindFiles] of groups) {
      let newest = Number.NEGATIVE_INFINITY;
      let openComments = 0;
      for (const f of kindFiles) {
        if (f.mtime > newest) newest = f.mtime;
        openComments += openCountFor(f.path);
      }
      facts.set(kind, { newest, openComments });
    }
    return facts;
  }, [groups, openCountFor]);

  // A direct FILE member that no longer resolves — one ROW like any other
  // (spec section 5 dims it and offers Forget), so it joins the same list
  // the live rows are in rather than trailing behind as a second one.
  // `kindOf` works on the path string alone, so a missing file still
  // respects the current slice filter even though it never reached
  // `pie.files`/`pie.census`. `mtime: 0` is never rendered — `byRow`
  // (pie-census.ts) sorts `missing` rows last, and the row itself shows
  // "not found" where a live row shows its age.
  const missingFileRows = React.useMemo<DerivedPieFile[]>(() => {
    const missing = new Set(pie.census?.missing ?? []);
    return members
      .filter((m) => m.kind === "file" && missing.has(m.path))
      .map((m) => ({ path: m.path, kind: kindOf(m.path), mtime: 0, missing: true as const }));
  }, [members, pie.census]);

  // ONE row list: the slice filter narrows the live rows through `groups`
  // (which the legend and the readout already share) and the missing rows
  // by the same kind test, and `layersOf` buckets and sorts whatever comes
  // out. `groups`/`wedges` deliberately do NOT see the missing rows — a
  // member with no file behind it must not weigh a wedge or the readout.
  const layerFiles = React.useMemo(() => {
    const live = filterKind ? groups.get(filterKind) ?? [] : pie.files;
    const gone = filterKind ? missingFileRows.filter((f) => f.kind === filterKind) : missingFileRows;
    return [...live, ...gone];
  }, [filterKind, groups, pie.files, missingFileRows]);

  const layers = React.useMemo(
    () => layersOf(layerFiles, members, pie.census),
    [layerFiles, members, pie.census],
  );

  // Headers are worth drawing only when they SAY something: a lone
  // unnamed "Files" layer is the whole list, and labelling it "Files"
  // above itself is noise — that case is exactly the M1/M2 flat listbox.
  // The container role follows the same rule, so the role and the children
  // it permits can never disagree.
  const showHeaders = layers.length > 1 || layers[0]?.kind === "folder";

  // `role="option"` is an ARIA "presentational children" role: it strips
  // everything nested inside it from the accessibility tree, including a
  // missing row's own Forget button — so in FLAT mode that button existed
  // on screen and nowhere for a screen-reader user. `treeitem` has no such
  // rule. A list holding a missing row is therefore a tree even with no
  // headers drawn, and the ROW role follows the container, so the two can
  // never disagree. Headers stay tied to `showHeaders` alone — a lone
  // "Files" layer still paints no header, and `aria-level` still appears
  // only when there is a level hierarchy to describe.
  //
  // (The alternative — folding Forget into the row's own `aria-label` plus
  // a Backspace binding — is not taken: Backspace already clears the slice
  // filter in this very list, `onLayerKeyDown`, and one key cannot mean two
  // things in one list.)
  const hasMissingRow = React.useMemo(
    () => layers.some((layer) => layer.rows.some((f) => f.missing)),
    [layers],
  );
  const treeRoles = showHeaders || hasMissingRow;

  // Headers + rows in DOM order; each item's INDEX is its roving-tabindex
  // slot. `key` is carried here rather than derived at render because a
  // row's path is unique only within its layer.
  const navItems = React.useMemo<NavItem[]>(() => {
    const items: NavItem[] = [];
    for (const layer of layers) {
      if (showHeaders) items.push({ type: "header", key: `h:${layer.id}`, layer });
      for (const file of layer.rows) {
        items.push({ type: "file", key: `f:${layer.id}:${file.path}`, file });
      }
    }
    return items;
  }, [layers, showHeaders]);

  // Both Forget buttons (a folder header's, and a missing FILE row's) go
  // through this. `removePieMember` removes the layer OPTIMISTICALLY and
  // rolls back on a refusal, so a dropped rejection read as success: the
  // layer vanished, the member stayed on disk, and it came back on the next
  // unrelated `pies-updated` event. Same handling the row context menu's
  // "Remove from pie" already has.
  const handleForget = (path: string) => {
    piesCtx.removePieMember(pie.id, path).catch((err: unknown) => {
      piesCtx.notice?.(
        `Couldn't forget "${basename(path)}" — ${messageOf(err, "the member could not be removed")}`,
      );
    });
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
  React.useEffect(() => {
    setFocusedLayer((i) => Math.min(i, Math.max(0, navItems.length - 1)));
  }, [navItems.length]);

  // Close on Esc — capture-phase and self-stopping (useEscape), so this
  // press does not ALSO leave reader mode the way a plain `escape` binding
  // in the global registry would. Guarded the same way App.tsx's reader-mode
  // Esc binding is: an open context menu (a layer row's "Copy Path" /
  // "Bookmark" / ...) still owns Esc and closes itself on the same window
  // event, so one keypress must not ALSO close the plate underneath it.
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
      // closes the plate the menu belongs to.
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
    if (!tabView) {
      // Without this element the iframe keeps swallowing the outside click,
      // so the plate cannot be dismissed by pointer — say why.
      console.error("skypie: .tab-view missing — the plate cannot block pointer events under it");
      return;
    }
    tabView.style.pointerEvents = "none";
    return () => {
      tabView.style.pointerEvents = "";
    };
  }, []);

  // role="dialog" with no focus move, no aria-modal and no focus restore
  // meant a screen-reader user heard nothing open on Enter (the tile stayed
  // focused) and the layer list's own ↑/↓/Home/End did nothing until several
  // Tabs landed inside. The plate does not trap
  // focus — Tab can still leave it — so aria-modal is explicitly "false"
  // rather than dropping role="dialog": that is what the attribute already
  // defaults to, made non-ambiguous here.
  // Focusing the PLATE CONTAINER here used to leave real DOM focus stranded
  // one level above every key handler that matters: `onLegendKeyDown` is
  // bound on `.pie-legend`, `onLayerKeyDown` on `.pie-layers`, and a keydown
  // whose target is the plate div reaches neither — ←/→ did nothing on
  // open, until a Tab (or several) landed inside. Focus the CHECKED
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
      // The tile that opened the plate can be gone by the time it closes (a
      // bookmark unpinned while it was open). Focus would then fall to
      // <body> and keyboard navigation would be lost with nothing to say so
      // — fall back to the first tile (the band element itself is not focusable).
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      else document.querySelector<HTMLElement>(".sky-band [data-pie-id]")?.focus();
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
    // A `missing` row names a member with no file behind it — there is
    // nothing to open, and asking would raise a "file not found" error the
    // row itself already states.
    if (file.missing) return;
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
      case "ArrowLeft": {
        e.preventDefault();
        const delta = e.key === "ArrowRight" ? 1 : -1;
        focusRadio(kinds[(current + delta + kinds.length) % kinds.length]);
        break;
      }
      case "Enter":
        e.preventDefault();
        // Same path a click on the row takes, so keyboard and pointer
        // cannot drift apart.
        if (focusedKind) activateRadio(focusedKind);
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
    >
      <div className="pie-plate-left">
        {/* A static portrait of the pie already open — non-interactive
            (Pie.tsx), so it is not a second role="option"/data-pie-id for
            this pie inside the band's listbox. Its wedge paths are still
            pointer PROXIES for the radiogroup on the right (`onWedgeClick`)
            — see the ARIA-ownership note on `onWedgeClick` in Pie.tsx. */}
        <Pie
          pie={pie}
          // The plate already grouped these files for the legend and the
          // layer filter; handing the wedges down stops the portrait from
          // regrouping the very same list.
          wedges={wedges}
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
          // AFTER the recency line.
          // A plain count would keep moving as later folders are skipped,
          // so the label names the CAP instead of a number that would be
          // wrong the moment it's read.
          <div className="pie-plate-truncated" data-testid="pie-truncated">
            truncated · 20,000+
          </div>
        ) : null}
        {pie.census?.skipped ? (
          // Beside the truncated caption, and for the same reason: the
          // wedges, the readout and the freshness count are all short by
          // this many files, and only this line says so. A COUNT, not a
          // list — the paths are in the log, and a plate is not a place to
          // read a few thousand of them.
          <div className="pie-plate-truncated" data-testid="pie-skipped">
            {pie.census.skipped} file{pie.census.skipped === 1 ? "" : "s"} couldn&apos;t be read
          </div>
        ) : null}
        <div className="pie-plate-recency">{lastOpened}</div>
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
              const { newest, openComments } = legendFacts.get(w.kind) ?? {
                newest: Number.NEGATIVE_INFINITY,
                openComments: 0,
              };
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
          // before, so nothing told the user how to leave the filtered view.
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
          role={treeRoles ? "tree" : "listbox"}
          aria-label={filterKind ? `${KIND_LABELS[filterKind]} files` : "All files"}
          data-testid="pie-layers"
          onKeyDown={onLayerKeyDown}
        >
          {navItems.length === 0 ? (
            <p className="pie-layers-empty">No files.</p>
          ) : (
            // The index IS the nav slot — one loop, no lookup table, and no
            // way for a row's rendered slot to drift from the one the
            // keyboard handler moves to.
            navItems.map((item, i) =>
              item.type === "header"
                ? renderLayerHeader(item.layer, i, item.key)
                : renderFileRow(item.file, i, item.key),
            )
          )}
        </div>
      </div>
    </div>
  );

  /** One layer's header row (spec section 5): the workspace-relative mono
   *  path, plus whichever of "folder not found" (Locate…/Forget), "can't
   *  read this folder" (Forget only — the folder has not MOVED, so there
   *  is nothing to re-point it at) or "not live" applies.
   *  `role="treeitem" aria-level="1"` participates in the SAME
   *  roving-tabindex sequence `onLayerKeyDown` drives — `navIndex` is its
   *  slot in `navItems`, exactly like a file row's. */
  function renderLayerHeader(layer: PieLayer, navIndex: number, key: string): React.ReactElement {
    // The trailing "Files" layer carries no member state at all — that is
    // what `PieLayer`'s discriminant buys, so there is nothing to null-check.
    const folder = layer.kind === "folder" ? layer : null;
    const label = folder ? displayPath(folder.memberPath, root) : layer.label;
    const suffix = folder?.missing
      ? " — folder not found"
      : folder?.unreadable
        ? " — can't read this folder"
        : "";
    return (
      <div
        key={key}
        className="pie-layer-header"
        data-testid="pie-layer-header"
        role="treeitem"
        aria-level={1}
        aria-selected={navIndex === focusedLayer}
        tabIndex={navIndex === focusedLayer ? 0 : -1}
        onFocus={() => setFocusedLayer(navIndex)}
      >
        <span className="pie-layer-header-path">
          <bdi>{`${label}${suffix}`}</bdi>
        </span>
        {folder?.missing || folder?.unreadable ? (
          <span className="pie-layer-caption pie-layer-missing">
            {folder.missing ? (
              // Locate… only for a member that is GONE. An unreadable
              // folder is still where it was, so re-pointing it at a
              // replacement would quietly lose the original.
              <button
                type="button"
                className="pie-mini-button"
                data-testid="pie-locate"
                onClick={(e) => {
                  e.stopPropagation();
                  void piesCtx.locateMember(pie.id, folder.memberPath);
                }}
              >
                Locate…
              </button>
            ) : null}
            <button
              type="button"
              className="pie-mini-button"
              data-testid="pie-forget"
              onClick={(e) => {
                e.stopPropagation();
                handleForget(folder.memberPath);
              }}
            >
              Forget
            </button>
          </span>
        ) : folder && !folder.live ? (
          <span className="pie-layer-caption">not live</span>
        ) : null}
      </div>
    );
  }

  /** A single row — a live file, or (the `file.missing` branch) a direct
   *  FILE member whose path no longer resolves: dimmed, "not found", and
   *  Forget only, with no Locate… since there is nothing to re-point a
   *  single file at. Both shapes are the SAME row in the same list, so
   *  both take the same `role`/`aria-level`/roving-tabindex treatment and
   *  a missing row cannot fall out of the keyboard sequence. `role` always
   *  matches the container (`treeRoles`), which only permits one or the
   *  other; `aria-level` appears only when headers are drawn, since that is
   *  the only case with a level hierarchy to describe. `navIndex` is this
   *  row's slot in `navItems`. */
  function renderFileRow(file: DerivedPieFile, navIndex: number, key: string): React.ReactElement {
    const selected = navIndex === focusedLayer;
    const ariaLevel = showHeaders ? (2 as const) : undefined;
    const role = treeRoles ? "treeitem" : "option";
    if (file.missing) {
      return (
        <div
          key={key}
          className="start-row start-row-missing"
          title={file.path}
          role={role}
          aria-level={ariaLevel}
          aria-selected={selected}
          aria-disabled="true"
          tabIndex={selected ? 0 : -1}
          onFocus={() => setFocusedLayer(navIndex)}
        >
          <span className="start-row-icon">
            <FileGlyph name={basename(file.path)} size={15} />
          </span>
          <span className="start-row-name">{basename(file.path)}</span>
          <span className="start-row-dir">
            <bdi>{displayDir(file.path, root)} — not found</bdi>
          </span>
          <button
            type="button"
            className="pie-mini-button"
            data-testid="pie-forget"
            onClick={() => handleForget(file.path)}
          >
            Forget
          </button>
        </div>
      );
    }
    return (
      <button
        key={key}
        type="button"
        role={role}
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
        // behaviour as ⌘-click.
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
                // `removePieMember` removes the row optimistically and
                // rolls back on a refusal; without this catch the
                // rejection was dropped, so the row vanished, the removal
                // never landed, and the row came back on the next
                // unrelated event.
                onSelect: () => {
                  piesCtx.removePieMember(pie.id, file.path).catch((err: unknown) => {
                    piesCtx.notice?.(
                      `Couldn't remove "${basename(file.path)}" — ${messageOf(err, "the member could not be removed")}`,
                    );
                  });
                },
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
          // marked EVERY row "new" in both of those cases. It is the same
          // `seen_at == 0` rule `freshCount` (derived-pies.ts) enforces for
          // the pill — and `freshCount` is the ONLY place that enforces it:
          // the census serves no freshness at all.
          <span className="start-row-new" data-testid="pie-row-new" aria-hidden />
        ) : null}
      </button>
    );
  }
}
