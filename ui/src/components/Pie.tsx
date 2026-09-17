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

const CENTER = 100;
const RADIUS = 92;

/** The slice cut distance, in SVG user units (viewBox 0 0 200 200) — spec
 *  section 5's "12px cut" is 12 units in THIS coordinate space, not 12 CSS
 *  px, so the cut is proportionally the same distance whether the disc
 *  renders at 48px (band), 120px (short plate) or 200px (plate). */
const CUT_OFFSET = 12;

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
  /** M3: the freshness pill's click handler — opens `pie.newestFreshPath`
   *  in one click, no zoom. Only rendered (and only meaningful) when
   *  `interactive && pie.fresh > 0` — a built-in pie's `fresh` is always
   *  `undefined`, so it never gets a pill regardless of whether this is
   *  passed. */
  onOpenNewest?: (e: React.MouseEvent) => void;
  /** M4: a Finder drag is currently over this tile (`useFinderDrop`'s
   *  `over` stream, hit-tested in Sky.tsx — NOT DOM `dragover`, which never
   *  fires for an OS-level drag). Renders `data-drop-target="true"`, which
   *  `styles.css` gives the same ring `:focus-visible` already draws.
   *  Interactive-branch only: the plate's inert portrait copy of the open
   *  pie is never a drop target of its own. */
  dropTarget?: boolean;
  /** M4: the pie holding the ACTIVE tab's file (spec section 3, "passive
   *  auto-reveal") — Sky.tsx computes this per tile from the canonicalized
   *  active path. Renders `data-active-file="true"`, a decoration only (no
   *  ARIA change: `role="option"` already strips presentational children,
   *  same reasoning `onOpenNewest`'s pill span uses). */
  active?: boolean;
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
    onOpenNewest,
    dropTarget,
    active,
  }: PieProps,
  ref,
) {
  const theme = useDomTheme();
  const ramp = theme === "light" ? TONE_RAMP_DAY : TONE_RAMP_DUSK;
  const wedges = React.useMemo(() => wedgesOf(pie.files), [pie.files]);
  const label = pieShareLabel(pie.files);
  const fresh = pie.fresh ?? 0;

  // A 160ms --sky tone flash on the disc when `fresh` RISES (a new file
  // landed) — not on every render, and not on a drop back to 0 (opening the
  // pill/plate clears the pill instantly; flashing on the way out would
  // read as a second, contradictory event). `prevFresh` starts at the
  // CURRENT value so mounting a pie that already has a pill never flashes.
  const prevFreshRef = React.useRef(fresh);
  const [flash, setFlash] = React.useState(false);
  React.useEffect(() => {
    if (fresh > prevFreshRef.current) {
      setFlash(true);
      const t = window.setTimeout(() => setFlash(false), 160);
      prevFreshRef.current = fresh;
      return () => window.clearTimeout(t);
    }
    prevFreshRef.current = fresh;
  }, [fresh]);

  let angle = 0;
  const paths = wedges.map((w) => {
    const sweep = w.share * 360;
    const bisector = angle + sweep / 2;
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
        fill={fill}
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
      className={"sky-pie-disc" + (flash ? " sky-pie-flash" : "")}
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
      data-drop-target={dropTarget ? "true" : undefined}
      data-active-file={active ? "true" : undefined}
      // The visible label span must stay part of the accessible name (WCAG
      // 2.5.3 Label in Name) — aria-label alone as just the shares string
      // used to replace it, so VoiceOver never said which pie this was. The
      // freshness count is folded in here too (rather than living on the
      // pill span's own aria-label below): `role="option"` is an ARIA
      // "presentational children" role, so a nested `role="button"` and its
      // aria-label are stripped from the accessibility tree and a
      // screen-reader user was never told a pie had new files (review:
      // Pie.tsx:264).
      aria-label={`${pie.name} — ${label}${fresh > 0 ? ` — ${fresh} new file${fresh === 1 ? "" : "s"}` : ""}`}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onBlur={onBlur}
      onClick={onOpen}
      onContextMenu={onContextMenu}
    >
      {disc}
      {fresh > 0 ? (
        // A nested <button> is invalid HTML and its click would bubble
        // into the tile's own onOpen (zoom) — a plain <span> instead,
        // stopPropagation before calling onOpenNewest so a pill click never
        // also opens the plate. No `role`/`aria-label` here: the tile's own
        // `aria-label` above already announces the count once — a second
        // one on this span would either be silently dropped (role="option"
        // hides presentational children) or, if it weren't, announced
        // twice. `aria-hidden`: pointer-only affordance, ⌘Enter already
        // reaches the same action from the keyboard (Sky.tsx).
        <span
          data-testid="pie-fresh-pill"
          className="sky-pie-fresh"
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation();
            onOpenNewest?.(e);
          }}
        >
          +{fresh}
        </span>
      ) : null}
      <span className="sky-pie-label">{pie.name}</span>
    </button>
  );
});

export default Pie;
