// SkyClouds — the Sky band's two static cumulus, lifted verbatim out of
// Sky.tsx (M1) so the macOS band (Sky.tsx) and the phone band
// (IosStartPage.tsx, M6) render the exact same markup instead of two copies
// that can drift. Purely a move: same viewBoxes, same clipPath ids, same
// classes.
//
// Two separate fixed-size SVGs, positioned by CSS `left` percentage (22% /
// 71% of the band width — DESIGN.md, "Sky band"). A single SVG spanning the
// whole band with `preserveAspectRatio="none"` used to stretch every
// ellipse horizontally by paneWidth/100 while its vertical scale stayed 1,
// turning each cumulus into a flat smear at any pane wider than the
// 100-unit viewBox (review: Sky.tsx:104). Only the CENTRE tracks the band
// width now; the shapes themselves stay a fixed size at every pane width.
import * as React from "react";

export default function SkyClouds(): React.ReactElement {
  return (
    <>
      <svg className="sky-cloud sky-cloud-1" viewBox="0 0 37 22" aria-hidden focusable="false">
        <clipPath id="sky-cloud-base-1">
          <rect x="0" y="0" width="37" height="22" />
        </clipPath>
        <g clipPath="url(#sky-cloud-base-1)">
          <ellipse cx="10" cy="16" rx="10" ry="7" />
          <ellipse cx="19" cy="9" rx="13" ry="9" />
          <ellipse cx="28" cy="17" rx="9" ry="6" />
        </g>
      </svg>
      <svg className="sky-cloud sky-cloud-2" viewBox="0 0 35 21" aria-hidden focusable="false">
        <clipPath id="sky-cloud-base-2">
          <rect x="0" y="0" width="35" height="21" />
        </clipPath>
        <g clipPath="url(#sky-cloud-base-2)">
          <ellipse cx="9" cy="15" rx="9" ry="6" />
          <ellipse cx="18" cy="8" rx="12" ry="8" />
          <ellipse cx="27" cy="16" rx="8" ry="5" />
        </g>
      </svg>
    </>
  );
}
