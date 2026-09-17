// Pie — the disc: one <path> per present file kind, drawn from the tone
// ramp between --sky-ink and --sky, plus the 1px warm crust ring (the one
// warm stroke in the product — DESIGN.md, "Sky band"). Used at 48px in the
// band and at 200px/120px in the plate; every size draws the same
// `viewBox="0 0 200 200"` SVG and only the rendered width/height change, so
// the paths stay sharp at every size instead of being rasterized and
// upscaled.
import * as React from "react";
import { BEARINGS } from "../render/kind";
import type { FileKind } from "../render/kind";
import { shareLabel as pieShareLabel, wedgesOf } from "../state/derived-pies";
import type { DerivedPie } from "../state/derived-pies";
// The angle arithmetic lives in render/wedge.ts so it can be tested without
// a renderer (wedge.test.ts); this file only chooses tones and elements.
import { CENTER, RADIUS, wedgePath } from "../render/wedge";

/** The slice cut distance, in SVG user units (viewBox 0 0 200 200) — spec
 *  section 5's "12px cut" is 12 units in THIS coordinate space, not 12 CSS
 *  px, so the cut is proportionally the same distance whether the disc
 *  renders at 48px (band), 120px (short plate) or 200px (plate). */
const CUT_OFFSET = 12;

// The one warm stroke in the product (DESIGN.md, "Sky band"). Wedge tones
// themselves are CSS custom properties (`--sky-tone-1` … `--sky-tone-7`,
// declared per theme in styles.css) rather than hex ramps in JS: a custom
// property resolves inside an SVG `fill` exactly as it does in `stroke`,
// which the wedge separators below already rely on. So the day/dusk swap is
// a pure CSS re-resolve with no theme subscription and no MutationObserver.
const CRUST = "#c89a5c";

export interface PieProps {
  pie: DerivedPie;
  /** This pie's plate is the one currently open — dims every OTHER pie in
   *  the same band to 60% (spec section 4), and hides THIS tile's own disc
   *  (`.sky-pies .sky-pie.selected .sky-pie-disc`, styles.css) for as long as
   *  the plate stays open, so the plate's portrait is the only copy of the
   *  disc on screen while it scales out of this slot. */
  selected?: boolean;
  /** Required when `interactive` (the default); unused for a portrait. */
  onOpen?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Disc + button diameter in px. 48 in the band, 200 (or 120 under a
   *  480px pane) in the plate. */
  size?: number;
  /** Roving-tabindex slot; the host (Sky, PiePlate) owns the roving index. */
  tabIndex?: number;
  onFocus?: () => void;
  /** M2: `Tooltip.tsx` clones its child with these plus `onFocus` attached
   *  (hover/focus open, leave/blur close, spec section 3). Pie destructures
   *  its props explicitly rather than spreading an unknown rest object, so
   *  without forwarding these the clone's handlers landed in `props` and
   *  were never read: the 400ms hover bubble never opened, and a bubble
   *  opened by keyboard focus never closed on blur (review: Pie.tsx:199). */
  onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLButtonElement>) => void;
  /** false renders an inert portrait: no `<button>`, no `role="option"`,
   *  no `aria-selected`, no `data-pie-id`. PiePlate's left-column copy of
   *  the pie that is already open uses this — without it, that copy is a
   *  SECOND `role="option"` (and a second `data-pie-id={pie.id}`) inside
   *  the band's `role="listbox"` while the plate is open, which both
   *  breaks the listbox's a11y tree and gives M4's Finder-drop hit-test
   *  (which walks up to the nearest `[data-pie-id]`) two matches for one
   *  id (review: PiePlate.tsx:205, Sky.tsx:138). */
  interactive?: boolean;
  /** M2: the kind whose wedge is cut 12 user-units along its bisector — the
   *  plate's active slice filter (`PiePlate.tsx`'s `filterKind`). `null`/
   *  unset draws every wedge at rest. Meaningless (silently ignored) for a
   *  kind not present in `pie.files`. */
  cutKind?: FileKind | null;
  /** M2: a click on a wedge path is a POINTER PROXY for the plate's legend
   *  radio of the same kind — the wedges live inside the portrait SVG's
   *  `aria-hidden` subtree (ARIA ownership cannot span the plate's two flex
   *  columns without `display: contents`, which risks real breakage in
   *  WebKit for a cosmetic win — not worth it here), so keyboard/AT users
   *  drive the radiogroup through the legend rows and this exists only for
   *  the mouse path (`PiePlate.tsx`). */
  onWedgeClick?: (kind: FileKind) => void;
  /** M2: the band tile's own right-click menu (Rename / Add folder… /
   *  Delete pie — `Sky.tsx`). Only meaningful with `interactive`. */
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const Pie = React.forwardRef<HTMLButtonElement | HTMLDivElement, PieProps>(function Pie(
  {
    pie,
    selected,
    onOpen,
    size = 48,
    tabIndex,
    onFocus,
    onMouseEnter,
    onMouseLeave,
    onBlur,
    interactive = true,
    cutKind,
    onWedgeClick,
    onContextMenu,
  }: PieProps,
  ref,
) {
  const wedges = React.useMemo(() => wedgesOf(pie.files), [pie.files]);
  const label = pieShareLabel(pie.files);

  let angle = 0;
  const paths = wedges.map((w) => {
    const sweep = w.share * 360;
    const bisector = angle + sweep / 2;
    const toneIndex = BEARINGS.indexOf(w.kind);
    // One kind = a full disc, drawn as two 180° arcs (see wedgePath).
    const d = wedgePath(angle, sweep, wedges.length === 1);
    angle += sweep;

    const cut = cutKind === w.kind;
    let transform: string | undefined;
    if (cut) {
      const rad = (bisector * Math.PI) / 180;
      const dx = CUT_OFFSET * Math.sin(rad);
      const dy = -CUT_OFFSET * Math.cos(rad);
      transform = `translate(${dx.toFixed(3)},${dy.toFixed(3)})`;
    }

    return (
      <path
        key={w.kind}
        d={d}
        // The crust is a STROKE and never a fill (DESIGN.md, "Sky band"), so
        // a kind missing from BEARINGS falls back to the last tone instead.
        // The branch is unreachable today — every FileKind is a bearing.
        fill={toneIndex >= 0 ? `var(--sky-tone-${toneIndex + 1})` : "var(--sky-tone-7)"}
        stroke={cut ? "var(--sky-focus)" : "var(--sky)"}
        strokeWidth={cut ? 2 : 1}
        vectorEffect="non-scaling-stroke"
        data-kind={w.kind}
        data-cut={cut ? "true" : undefined}
        transform={transform}
        style={{ transition: "transform 120ms var(--ease)" }}
        onClick={onWedgeClick ? () => onWedgeClick(w.kind) : undefined}
      />
    );
  });

  const disc = (
    <svg
      className="sky-pie-disc"
      viewBox="0 0 200 200"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
    >
      {paths}
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        fill="none"
        stroke={CRUST}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );

  if (!interactive) {
    // aria-hidden: the plate's own role="dialog" already carries
    // `${pie.name} pie` as its accessible name (PiePlate.tsx), so this
    // portrait would only be a redundant announcement, not new information.
    // The wedge paths inside stay reachable to a plain click regardless —
    // aria-hidden only removes them from the accessibility tree.
    return (
      <div ref={ref as React.Ref<HTMLDivElement>} className="sky-pie sky-pie-portrait" aria-hidden="true">
        {disc}
        <span className="sky-pie-label">{pie.name}</span>
      </div>
    );
  }

  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type="button"
      className={"sky-pie" + (selected ? " selected" : "")}
      role="option"
      aria-selected={Boolean(selected)}
      data-pie-id={pie.id}
      // The visible label span must stay part of the accessible name (WCAG
      // 2.5.3 Label in Name) — aria-label alone as just the shares string
      // used to replace it, so VoiceOver never said which pie this was.
      aria-label={`${pie.name} — ${label}`}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onBlur={onBlur}
      onClick={onOpen}
      onContextMenu={onContextMenu}
    >
      {disc}
      <span className="sky-pie-label">{pie.name}</span>
    </button>
  );
});

export default Pie;
