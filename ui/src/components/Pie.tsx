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
import { labelOfWedges, wedgesOf } from "../state/derived-pies";
import type { DerivedPie, Wedge } from "../state/derived-pies";
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

/** Every plain DOM attribute a caller may want on the tile is carried by
 *  `...rest` (below) rather than allowlisted one at a time. `Tooltip.tsx`
 *  clones its child with `onMouseEnter`/`onMouseLeave`/`onFocus`/`onBlur`
 *  AND `aria-describedby`; an allowlist dropped whatever it had not been
 *  taught about, silently. `onFocus` is the one
 *  omission: this component narrows it to a no-argument callback. */
export interface PieProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onFocus"> {
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
  /** false renders an inert portrait: no `<button>`, no `role="option"`,
   *  no `aria-selected`, no `data-pie-id`. PiePlate's left-column copy of
   *  the pie that is already open uses this — without it, that copy is a
   *  SECOND `role="option"` (and a second `data-pie-id={pie.id}`) inside
   *  the band's `role="listbox"` while the plate is open, which both
   *  breaks the listbox's a11y tree and gives M4's Finder-drop hit-test
   *  (which walks up to the nearest `[data-pie-id]`) two matches for one
   *  id. */
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
  /** M3: the freshness pill's click handler — opens the pie's newest file
   *  in one click, no zoom. Only rendered (and only meaningful) when
   *  `interactive && pie.fresh > 0` — a built-in pie's `fresh` is always
   *  `undefined`, so it never gets a pill regardless of whether this is
   *  passed. */
  onOpenNewest?: (e: React.MouseEvent) => void;
  /** Wedges the caller has ALREADY grouped for this exact file list —
   *  `PiePlate` needs the groups for its legend and layer filter anyway, so
   *  handing them down keeps the portrait from grouping the same files a
   *  second time. Omit it and the disc groups them itself. */
  wedges?: Wedge[];
}

const Pie = React.forwardRef<HTMLButtonElement | HTMLDivElement, PieProps>(function Pie(
  {
    pie,
    selected,
    onOpen,
    size = 48,
    tabIndex,
    onFocus,
    interactive = true,
    cutKind,
    onWedgeClick,
    onContextMenu,
    onOpenNewest,
    wedges: wedgesProp,
    ...rest
  }: PieProps,
  ref,
) {
  const wedges = React.useMemo(
    () => wedgesProp ?? wedgesOf(pie.files),
    [wedgesProp, pie.files],
  );
  // The label reads off the SAME wedges the disc draws — deriving it from
  // `pie.files` again grouped every file a second time on every render.
  const label = labelOfWedges(wedges);
  const fresh = pie.fresh ?? 0;

  // A 160ms BRIGHTNESS pulse on the disc (`.sky-pie-flash`, a `filter:
  // brightness` keyframe in styles.css — no tone, hue or fill changes at
  // all, so it introduces no new colour departure) when `fresh` RISES (a new file
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
      <div
        {...(rest as React.HTMLAttributes<HTMLDivElement>)}
        ref={ref as React.Ref<HTMLDivElement>}
        className="sky-pie sky-pie-portrait"
        aria-hidden="true"
      >
        {disc}
        <span className="sky-pie-label">{pie.name}</span>
      </div>
    );
  }

  return (
    <button
      {...rest}
      ref={ref as React.Ref<HTMLButtonElement>}
      type="button"
      className={"sky-pie" + (selected ? " selected" : "")}
      role="option"
      aria-selected={Boolean(selected)}
      data-pie-id={pie.id}
      // The visible label span must stay part of the accessible name (WCAG
      // 2.5.3 Label in Name) — aria-label alone as just the shares string
      // used to replace it, so VoiceOver never said which pie this was. The
      // freshness count is folded in here too (rather than living on the
      // pill span's own aria-label below): `role="option"` is an ARIA
      // "presentational children" role, so a nested `role="button"` and its
      // aria-label are stripped from the accessibility tree and a
      // screen-reader user was never told a pie had new files.
      aria-label={`${pie.name} — ${label}${fresh > 0 ? ` — ${fresh} new file${fresh === 1 ? "" : "s"}` : ""}`}
      tabIndex={tabIndex}
      onFocus={onFocus}
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
