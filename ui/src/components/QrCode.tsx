// QrCode — a pairing invite the phone's camera can read. `uqr` encodes the
// text into a boolean module matrix; the SVG is drawn here so nothing else
// is pulled in. A QR needs a light quiet zone whatever the theme, so the
// modules sit on a white square with a four-module margin.
import * as React from "react";
import { encode } from "uqr";

const QUIET_ZONE = 4;

function QrCode({
  text,
  size = 176,
  label = "Pairing QR code",
}: {
  text: string;
  /** Rendered size in CSS pixels; the drawing scales with `viewBox`. */
  size?: number;
  label?: string;
}): React.ReactElement {
  // Memoized as a whole: the parent re-renders on every presence event, and
  // a pairing link is ~800 modules.
  const { rects, side } = React.useMemo(() => {
    const { data, size: modules } = encode(text);
    const rects: React.ReactElement[] = [];
    data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) {
          rects.push(
            <rect key={`${x}-${y}`} x={x + QUIET_ZONE} y={y + QUIET_ZONE} width={1} height={1} />,
          );
        }
      });
    });
    return { rects, side: modules + QUIET_ZONE * 2 };
  }, [text]);
  return (
    <svg
      className="qr-code"
      viewBox={`0 0 ${side} ${side}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      data-testid="pair-qr"
    >
      <rect x={0} y={0} width={side} height={side} fill="#fff" />
      <g fill="#000">{rects}</g>
    </svg>
  );
}

export default React.memo(QrCode);
