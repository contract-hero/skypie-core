// PiePlate — the zoom-in sheet: the pie at full size, a mono readout, and
// the legend + layer list. Opened by Enter or a click on a Pie tile; closes
// on Esc, an outside pointerdown, or window blur (spec section 4).
//
// M1 ships plain legend buttons and a flat layer listbox (role="listbox").
// The radiogroup wedges, the 12px cut animation and the removable filter
// chip are M2 — but the underlying FILTER still works here: clicking a
// legend row narrows the layer list to that kind, because the M1 checkpoint
// itself requires it ("click the HTML legend row; the layer list shows html
// files newest first").
import * as React from "react";
import { FileCode, FileText, FileImage, FileJson, File as FileIconGlyph, MessageSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Pie from "./Pie";
import { groupByWedge, wedgesOf } from "../state/derived-pies";
import type { DerivedPie, DerivedPieFile } from "../state/derived-pies";
import type { FileKind } from "../render/kind";
import { FileGlyph } from "./FileIcon";
import { basename, displayDir } from "../utils/path";
import { formatAgo } from "../utils/beam-format";
import { useEscape } from "../hooks/useEscape";
import { useContextMenu } from "./ContextMenu";
import { useFileMenu } from "../hooks/useFileMenu";
import { useWorkspace } from "../state/workspace";
import { useAnnotations } from "../state/annotations-context";
import { openOptsFromClick } from "../state/TabsProvider";
import type { OpenFileOptions } from "../state/TabsProvider";

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
  // the data does not support (review: PiePlate.tsx:59).
  const isPinned = pie.id === "builtin:pinned";
  if (files.length === 0) return isPinned ? "Never pinned" : "Never opened";
  const newest = Math.max(...files.map((f) => f.mtime));
  const verb = isPinned ? "Last pinned" : "Last opened";
  return `${verb} ${mtimeAgo(newest)}`;
}

export interface PiePlateProps {
  pie: DerivedPie;
  onClose: () => void;
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
}

export default function PiePlate({ pie, onClose, onOpenFile }: PiePlateProps): React.ReactElement {
  const { root } = useWorkspace();
  const contextMenu = useContextMenu();
  const fileMenuFor = useFileMenu(onOpenFile);
  const { openCountFor } = useAnnotations();
  const short = usePaneShort();
  const plateRef = React.useRef<HTMLDivElement | null>(null);
  const layerListRef = React.useRef<HTMLDivElement | null>(null);

  const [filterKind, setFilterKind] = React.useState<FileKind | null>(null);
  const [focusedLayer, setFocusedLayer] = React.useState(0);

  const wedges = React.useMemo(() => wedgesOf(pie.files), [pie.files]);
  const groups = React.useMemo(() => groupByWedge(pie.files), [pie.files]);

  const dominant = wedges.reduce<typeof wedges[number] | null>(
    (best, w) => (best === null || w.share > best.share ? w : best),
    null,
  );
  const readoutKind = filterKind ?? dominant?.kind ?? null;
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

  React.useEffect(() => {
    setFocusedLayer(0);
  }, [filterKind, pie.id]);

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
  React.useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    plateRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

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

  const onLayerKeyDown = (e: React.KeyboardEvent) => {
    if (layerFiles.length === 0) return;
    const focusRow = (idx: number) => {
      const clamped = Math.max(0, Math.min(layerFiles.length - 1, idx));
      setFocusedLayer(clamped);
      const row = layerListRef.current?.querySelectorAll<HTMLElement>(".start-row")[clamped];
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
        focusRow(layerFiles.length - 1);
        break;
      case "Enter": {
        e.preventDefault();
        const file = layerFiles[focusedLayer];
        if (file) openRow(file, e);
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
      className="pie-plate"
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
            this pie inside the band's listbox. */}
        <Pie pie={pie} size={short ? 120 : 200} interactive={false} />
        <div className="pie-plate-readout">{readout}</div>
        <div className="pie-plate-last-opened">{lastOpenedLabel(pie)}</div>
      </div>
      <div className="pie-plate-right">
        <div className="pie-legend" data-testid="pie-legend">
          {wedges.length === 0 ? (
            <p className="pie-legend-empty">No files in this pie yet.</p>
          ) : (
            wedges.map((w) => {
              const kindFiles = groups.get(w.kind) ?? [];
              const newest = Math.max(...kindFiles.map((f) => f.mtime));
              const openComments = kindFiles.reduce((sum, f) => sum + openCountFor(f.path), 0);
              const active = filterKind === w.kind;
              const KindIcon = KIND_ICON[w.kind];
              return (
                <button
                  key={w.kind}
                  type="button"
                  className={"pie-legend-row" + (active ? " active" : "")}
                  aria-pressed={active}
                  onClick={() => setFilterKind((k) => (k === w.kind ? null : w.kind))}
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
            onClick={() => setFilterKind(null)}
            aria-label={`Clear the ${KIND_LABELS[filterKind]} filter`}
          >
            Slice · {KIND_LABELS[filterKind]} <span aria-hidden>×</span>
          </button>
        ) : null}
        <div
          ref={layerListRef}
          className="pie-layers"
          role="listbox"
          aria-label={filterKind ? `${KIND_LABELS[filterKind]} files` : "All files"}
          data-testid="pie-layers"
          onKeyDown={onLayerKeyDown}
        >
          {layerFiles.length === 0 ? (
            <p className="pie-layers-empty">No files.</p>
          ) : (
            layerFiles.map((file, i) => (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={i === focusedLayer}
                className="start-row"
                title={file.path}
                tabIndex={i === focusedLayer ? 0 : -1}
                onFocus={() => setFocusedLayer(i)}
                onClick={(e) => openRow(file, e)}
                // React's onClick never fires for the middle button — the
                // same .start-row shape in StartPage.tsx handles it this
                // way, and spec section 5 gives middle-click the same
                // background-tab-plate-stays behaviour as ⌘-click (review:
                // PiePlate.tsx:257).
                onAuxClick={(e) => {
                  if (e.button === 1) openRow(file, e);
                }}
                onContextMenu={(e) => {
                  contextMenu.open(e, fileMenuFor(file.path));
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
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
