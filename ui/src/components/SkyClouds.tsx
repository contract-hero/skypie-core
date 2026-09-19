// SkyClouds — the Sky band's two static cumulus, lifted out of Sky.tsx (M1)
// so the macOS band (Sky.tsx) and the phone band (IosStartPage.tsx, M6)
// render the exact same markup instead of two copies that can drift.
//
// Each cloud is its own fixed-size SVG, positioned by CSS `left` percentage
// (22% / 71% of the band width — `.sky-cloud-1` / `.sky-cloud-2`,
// styles.css). A single SVG spanning the whole band with
// `preserveAspectRatio="none"` used to stretch every ellipse horizontally
// by paneWidth/100 while its vertical scale stayed 1, turning each cumulus
// into a flat smear at any pane wider than the 100-unit viewBox. Only the
// CENTRE tracks the band width now; the shapes themselves stay a fixed size
// at every pane width.
import * as React from "react";

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

export default function SkyClouds(): React.ReactElement {
  return (
    <>
      <Cloud className="sky-cloud-1" />
      <Cloud className="sky-cloud-2" />
    </>
  );
}
