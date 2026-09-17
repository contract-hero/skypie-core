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
        // plate owns its own Esc (useEscape) to close itself first.
        (document.activeElement as HTMLElement | null)?.blur();
        break;
      default:
        break;
    }
  };

  const openPie = pies.find((p) => p.id === openPieId) ?? null;

  return (
    // The band IS the listbox — role/aria-label live on the same element the
    // 120px surface styling does, not on an inner wrapper, so a query for
    // ".sky-band[role=listbox]" finds one element.
    <div
      ref={listRef}
      className="sky-band"
      role="listbox"
      aria-label="Pies"
      onKeyDown={onKeyDown}
    >
      <div className="sky-glaze" aria-hidden />
      <svg
        className="sky-clouds"
        viewBox="0 0 100 120"
        preserveAspectRatio="none"
        aria-hidden
        focusable="false"
      >
        <clipPath id="sky-cloud-base-1">
          <rect x="0" y="0" width="100" height="96" />
        </clipPath>
        <clipPath id="sky-cloud-base-2">
          <rect x="0" y="0" width="100" height="88" />
        </clipPath>
        {/* Centres at 22% and 71% of the band width — DESIGN.md, "Sky band". */}
        <g clipPath="url(#sky-cloud-base-1)">
          <ellipse cx="13" cy="90" rx="10" ry="7" />
          <ellipse cx="22" cy="83" rx="13" ry="9" />
          <ellipse cx="31" cy="91" rx="9" ry="6" />
        </g>
        <g clipPath="url(#sky-cloud-base-2)">
          <ellipse cx="62" cy="82" rx="9" ry="6" />
          <ellipse cx="71" cy="75" rx="12" ry="8" />
          <ellipse cx="80" cy="83" rx="8" ry="5" />
        </g>
      </svg>
      <div className="sky-pies">
        {pies.map((pie, i) => (
          <Pie
            key={pie.id}
            pie={pie}
            selected={pie.id === openPieId}
            tabIndex={i === focusedIndex ? 0 : -1}
            onFocus={() => setFocusedIndex(i)}
            onOpen={() => setOpenPieId(pie.id)}
          />
        ))}
      </div>
      {openPie ? (
        <PiePlate pie={openPie} onClose={() => setOpenPieId(null)} onOpenFile={onOpenFile} />
      ) : null}
    </div>
  );
}
