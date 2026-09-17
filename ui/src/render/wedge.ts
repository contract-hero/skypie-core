// wedge.ts — the pie disc's geometry, extracted from Pie.tsx so the angle
// arithmetic can be tested without a renderer. Pure: it returns SVG path
// data strings and takes no React or DOM dependency.
//
// The whole disc is drawn on a fixed `viewBox="0 0 200 200"`; only the
// rendered width/height change between the 48px band tile and the 200px /
// 120px plate portrait, so every size uses these same numbers.

export const CENTER = 100;
export const RADIUS = 92;

/** Point on the disc at `angleDeg` clockwise from north (SVG's 0° is east,
 *  so this rotates the usual parametrization by -90°). */
export function polar(angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CENTER + RADIUS * Math.sin(rad), CENTER - RADIUS * Math.cos(rad)];
}

/** SVG path data for one wedge starting at `startDeg` (clockwise from north)
 *  and sweeping `sweepDeg`.
 *
 *  `fullDisc` draws the one-kind case as TWO 180° arcs: an SVG arc of
 *  exactly 360° has identical endpoints and degenerates to nothing. */
export function wedgePath(startDeg: number, sweepDeg: number, fullDisc: boolean): string {
  if (fullDisc) {
    const [nx, ny] = polar(0);
    const [sx, sy] = polar(180);
    return `M ${nx},${ny} A ${RADIUS},${RADIUS} 0 1 1 ${sx},${sy} A ${RADIUS},${RADIUS} 0 1 1 ${nx},${ny} Z`;
  }
  const [x1, y1] = polar(startDeg);
  const [x2, y2] = polar(startDeg + sweepDeg);
  // largeArc flips strictly ABOVE 180°: at exactly 180° either flag draws
  // the same half-disc, and the SVG spec's own rule is "> 180".
  const largeArc = sweepDeg > 180 ? 1 : 0;
  return `M ${CENTER},${CENTER} L ${x1},${y1} A ${RADIUS},${RADIUS} 0 ${largeArc} 1 ${x2},${y2} Z`;
}
