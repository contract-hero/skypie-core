// Pie — the disc: one <path> per present file kind, drawn from the tone
// ramp between --sky-ink and --sky, plus the 1px warm crust ring (the one
// warm stroke in the product — DESIGN.md, "Sky band"). Used at 48px in the
// band and at 200px/120px in the plate; every size draws the same
// `viewBox="0 0 200 200"` SVG and only the rendered width/height change, so
// the paths stay sharp at every size instead of being rasterized and
// upscaled.
import * as React from "react";
import { BEARINGS } from "../render/kind";
import { wedgesOf } from "../state/derived-pies";
import type { DerivedPie } from "../state/derived-pies";

const CENTER = 100;
const RADIUS = 92;

// The one warm stroke in the product (DESIGN.md, "Sky band"). Wedge tones
// themselves are CSS custom properties (`--sky-tone-1` … `--sky-tone-7`,
// declared per theme in styles.css) rather than hex ramps in JS: a custom
// property resolves inside an SVG `fill` exactly as it does in `stroke`,
// which the wedge separators below already rely on. So the day/dusk swap is
// a pure CSS re-resolve with no theme subscription and no MutationObserver.
const CRUST = "#c89a5c";

/** Point on the disc at `angleDeg` clockwise from north (SVG's 0° is east,
 *  so this rotates the usual parametrization by -90°). */
function polar(angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CENTER + RADIUS * Math.sin(rad), CENTER - RADIUS * Math.cos(rad)];
}

export interface PieProps {
  pie: DerivedPie;
  /** This pie's plate is the one currently open — dims every OTHER pie in
   *  the same band to 60% (spec section 4). */
  selected?: boolean;
  /** Required when `interactive` (the default); unused for a portrait. */
  onOpen?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Disc + button diameter in px. 48 in the band, 200 (or 120 under a
   *  480px pane) in the plate. */
  size?: number;
  /** Roving-tabindex slot; the host (Sky, PiePlate) owns the roving index. */
  tabIndex?: number;
  onFocus?: () => void;
  /** false renders an inert portrait: no `<button>`, no `role="option"`,
   *  no `aria-selected`, no `data-pie-id`. PiePlate's left-column copy of
   *  the pie that is already open uses this — without it, that copy is a
   *  SECOND `role="option"` (and a second `data-pie-id={pie.id}`) inside
   *  the band's `role="listbox"` while the plate is open, which both
   *  breaks the listbox's a11y tree and gives M4's Finder-drop hit-test
   *  (which walks up to the nearest `[data-pie-id]`) two matches for one
   *  id (review: PiePlate.tsx:205, Sky.tsx:138). */
  interactive?: boolean;
}

export default function Pie({
  pie,
  selected,
  onOpen,
  size = 48,
  tabIndex,
  onFocus,
  interactive = true,
}: PieProps): React.ReactElement {
  const wedges = React.useMemo(() => wedgesOf(pie.files), [pie.files]);

  const shareLabel = wedges.length
    ? wedges.map((w) => `${w.kind} ${Math.round(w.share * 100)}%`).join(" · ")
    : "No files";

  let angle = 0;
  const paths = wedges.map((w) => {
    const sweep = w.share * 360;
    const toneIndex = BEARINGS.indexOf(w.kind);
    let d: string;
    if (wedges.length === 1) {
      // One kind = a full disc. An SVG arc of exactly 360° degenerates to
      // nothing, so the full circle is drawn as two 180° arcs instead.
      const [nx, ny] = polar(0);
      const [sx, sy] = polar(180);
      d = `M ${nx},${ny} A ${RADIUS},${RADIUS} 0 1 1 ${sx},${sy} A ${RADIUS},${RADIUS} 0 1 1 ${nx},${ny} Z`;
    } else {
      const [x1, y1] = polar(angle);
      const [x2, y2] = polar(angle + sweep);
      const largeArc = sweep > 180 ? 1 : 0;
      d = `M ${CENTER},${CENTER} L ${x1},${y1} A ${RADIUS},${RADIUS} 0 ${largeArc} 1 ${x2},${y2} Z`;
    }
    angle += sweep;
    return (
      <path
        key={w.kind}
        d={d}
        fill={toneIndex >= 0 ? `var(--sky-tone-${toneIndex + 1})` : CRUST}
        stroke="var(--sky)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
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
    return (
      <div className="sky-pie sky-pie-portrait" aria-hidden="true">
        {disc}
        <span className="sky-pie-label">{pie.name}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={"sky-pie" + (selected ? " selected" : "")}
      role="option"
      aria-selected={Boolean(selected)}
      data-pie-id={pie.id}
      // The visible label span must stay part of the accessible name (WCAG
      // 2.5.3 Label in Name) — aria-label alone as just the shares string
      // used to replace it, so VoiceOver never said which pie this was.
      aria-label={`${pie.name} — ${shareLabel}`}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onOpen}
    >
      {disc}
      <span className="sky-pie-label">{pie.name}</span>
    </button>
  );
}
