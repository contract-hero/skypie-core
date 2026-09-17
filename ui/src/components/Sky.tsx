// Sky — the pies band: a 120px strip between the toolbar and the tab view,
// toggled by the toolbar tile / ⌘⇧B and gone by default (panes.sky_visible).
// M1 ships the two derived built-ins, Pinned and Recent; user pies, the tin
// and Finder drop land in M2+ (DESIGN.md, "Sky band").
import * as React from "react";
import { useBookmarksContext } from "../state/bookmarks-context";
import { useRecentsContext } from "../state/recents-context";
import { pinnedPie, recentPie } from "../state/derived-pies";
import type { DerivedPie } from "../state/derived-pies";
import Pie from "./Pie";
import PiePlate from "./PiePlate";
import type { OpenFileOptions } from "../state/TabsProvider";

export interface SkyProps {
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
}

/** One cumulus: three overlapping ellipses on a fixed 37×22 viewBox. The
 *  band's two clouds differ only in where CSS puts them, so this renders
 *  once and is placed twice — `className` carries the position. */
function Cloud({ className }: { className: string }): React.ReactElement {
  return (
    <svg
      className={`sky-cloud ${className}`}
      viewBox="0 0 37 22"
      aria-hidden
      focusable="false"
    >
      <ellipse cx="10" cy="16" rx="10" ry="7" />
      <ellipse cx="19" cy="9" rx="13" ry="9" />
      <ellipse cx="28" cy="17" rx="9" ry="6" />
    </svg>
  );
}

export default function Sky({ onOpenFile }: SkyProps): React.ReactElement {
  const { bookmarks } = useBookmarksContext();
  const { recents } = useRecentsContext();

  const pies = React.useMemo<DerivedPie[]>(
    () => [pinnedPie(bookmarks), recentPie(recents)],
    [bookmarks, recents],
  );

  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const [openPieId, setOpenPieId] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // Keep the roving index in range as pies come and go — always exactly two
  // built-ins in M1, but this stays correct once user pies (and the tin)
  // join the band.
  React.useEffect(() => {
    setFocusedIndex((i) => Math.min(i, Math.max(0, pies.length - 1)));
  }, [pies.length]);

  // Drop the open plate if its pie disappeared from under it (a bookmark
  // removed while its plate is open, say).
  React.useEffect(() => {
    if (openPieId && !pies.some((p) => p.id === openPieId)) setOpenPieId(null);
  }, [pies, openPieId]);

  const focusTile = (index: number) => {
    if (pies.length === 0) return;
    const clamped = Math.max(0, Math.min(pies.length - 1, index));
    setFocusedIndex(clamped);
    const el = listRef.current?.querySelectorAll<HTMLElement>("[data-pie-id]")[clamped];
    el?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusTile(focusedIndex + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusTile(focusedIndex - 1);
        break;
      case "Home":
        e.preventDefault();
        focusTile(0);
        break;
      case "End":
        e.preventDefault();
        focusTile(pies.length - 1);
        break;
      case "Enter": {
        e.preventDefault();
        const pie = pies[focusedIndex];
        if (pie) setOpenPieId(pie.id);
        break;
      }
      case "Escape":
        // Leaves the band (blurs the focused tile) without closing it — the
        // plate owns its own Esc (useEscape) to close itself first. Stop
        // here so this bubble-phase handler cannot ALSO trigger whatever
        // else in the tree is listening for a bare Escape (e.g. the reader
        // mode / comment tool bindings in App.tsx) — the same one-press,
        // one-effect rule useEscape enforces for the plate itself.
        e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur();
        break;
      default:
        break;
    }
  };

  const openPie = pies.find((p) => p.id === openPieId) ?? null;

  // Stable identities: PiePlate subscribes window `pointerdown`/`blur` in an
  // effect keyed on [onClose], so a fresh closure on every band render (one
  // per recents/bookmarks tick) would tear down and re-add those listeners
  // each time.
  const closePlate = React.useCallback(() => setOpenPieId(null), []);
  // One handler pair per pie, rebuilt only when the pie list itself changes
  // — an inline arrow in the map below is a new function on every render,
  // which is what a later `React.memo(Pie)` would trip over.
  const handlers = React.useMemo(
    () =>
      pies.map((pie, i) => ({
        onFocus: () => setFocusedIndex(i),
        onOpen: () => setOpenPieId(pie.id),
      })),
    [pies],
  );

  return (
    // The plate is a sibling of the listbox, not a DOM child of it: a
    // role="dialog" (with its own nested role="listbox" layer list) is not
    // a valid listbox child, and it used to make the band's option count
    // depend on whether a plate happened to be open (review: Sky.tsx:138).
    // This shell only exists to give the plate's `position: absolute; top:
    // 100%` the same containing block `.sky-band` used to provide.
    <div className="sky-band-shell">
      {/* The band IS the listbox — role/aria-label live on the same element
          the 120px surface styling does, not on an inner wrapper, so a
          query for ".sky-band[role=listbox]" finds one element. */}
      <div
        ref={listRef}
        className="sky-band"
        role="listbox"
        aria-label="Pies"
        onKeyDown={onKeyDown}
      >
        <div className="sky-glaze" aria-hidden />
        {/* Two separate fixed-size SVGs, positioned by CSS `left` percentage
            (22% / 71% of the band width — DESIGN.md, "Sky band"). A single
            SVG spanning the whole band with `preserveAspectRatio="none"`
            used to stretch every ellipse horizontally by paneWidth/100
            while its vertical scale stayed 1, turning each cumulus into a
            flat smear at any pane wider than the 100-unit viewBox (review:
            Sky.tsx:104). Only the CENTRE tracks the band width now; the
            shapes themselves stay a fixed size at every pane width. */}
        <Cloud className="sky-cloud-1" />
        <Cloud className="sky-cloud-2" />
        {/* role="presentation": the listbox's real options are this div's
            CHILDREN in the DOM, but an ARIA listbox only owns options that
            are its own accessible children — nesting them one div deeper
            with no role in between used to make AT report the listbox as
            empty (review, Sky.tsx minor). Presentation removes this div
            from the accessibility tree, so the Pie options attach straight
            to the listbox above it. */}
        <div className="sky-pies" role="presentation">
          {pies.map((pie, i) => (
            <Pie
              key={pie.id}
              pie={pie}
              selected={pie.id === openPieId}
              tabIndex={i === focusedIndex ? 0 : -1}
              onFocus={handlers[i]?.onFocus}
              onOpen={handlers[i]?.onOpen}
            />
          ))}
        </div>
      </div>
      {openPie ? (
        <PiePlate pie={openPie} onClose={closePlate} onOpenFile={onOpenFile} />
      ) : null}
    </div>
  );
}
