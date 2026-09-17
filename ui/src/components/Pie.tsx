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

// Tones are steps of ink between --sky-ink and --sky, not hues — the spec's
// exact seven-step ramp, one slot per BEARINGS kind. Day and dusk are the
// same steps reversed. A CSS custom property can't be sampled into an SVG
// `fill` attribute without a JS round trip, so this reads `<html
// data-theme>` directly — useTheme()'s own doc comment names that attribute
// as the thing a consumer may read instead of re-subscribing to the theme.
const TONE_RAMP_DAY = ["#1f2f4d", "#3a4f75", "#5b729a", "#7f95b8", "#a6b8d1", "#c2d0e2", "#dbe4ef"];
const TONE_RAMP_DUSK = [...TONE_RAMP_DAY].reverse();
const CRUST = "#c89a5c";

function useDomTheme(): "dark" | "light" {
  const [theme, setTheme] = React.useState<"dark" | "light">(() =>
    typeof document !== "undefined" && document.documentElement.dataset.theme === "light"
      ? "light"
      : "dark",
  );
  React.useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(el.dataset.theme === "light" ? "light" : "dark");
    });
    observer.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

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
  onOpen: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Disc + button diameter in px. 48 in the band, 200 (or 120 under a
   *  480px pane) in the plate. */
  size?: number;
  /** Roving-tabindex slot; the host (Sky, PiePlate) owns the roving index. */
  tabIndex?: number;
  onFocus?: () => void;
}

export default function Pie({
  pie,
  selected,
  onOpen,
  size = 48,
  tabIndex,
  onFocus,
}: PieProps): React.ReactElement {
  const theme = useDomTheme();
  const ramp = theme === "light" ? TONE_RAMP_DAY : TONE_RAMP_DUSK;
  const wedges = React.useMemo(() => wedgesOf(pie.files), [pie.files]);

  const shareLabel = wedges.length
    ? wedges.map((w) => `${w.kind} ${Math.round(w.share * 100)}%`).join(" · ")
    : "No files";

  let angle = 0;
  const paths = wedges.map((w) => {
    const sweep = w.share * 360;
    const fill = ramp[BEARINGS.indexOf(w.kind)] ?? CRUST;
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
        fill={fill}
        stroke="var(--sky)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    );
  });

  return (
    <button
      type="button"
      className={"sky-pie" + (selected ? " selected" : "")}
      role="option"
      aria-selected={Boolean(selected)}
      data-pie-id={pie.id}
      aria-label={shareLabel}
      title={shareLabel}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onOpen}
    >
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
      <span className="sky-pie-label">{pie.name}</span>
    </button>
  );
}
