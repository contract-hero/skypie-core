// Tooltip — a custom hover/focus tooltip: role="tooltip", --z-popover,
// 400ms open delay, closes on leave/blur/Esc (spec section 3). A native
// `title` attribute in WKWebView opens after about 1s and can't be styled,
// which is the whole reason this exists.
//
// Renders no wrapper element of its own — `children` is cloned with the
// hover/focus handlers attached directly to it. A `<span>` wrapper around a
// band tile would stop that tile from being a DIRECT flex item of
// `.sky-pies`, breaking its 72px pitch (`.sky-pie { flex: 0 0 72px }` only
// applies to an element that IS a flex item). The bubble is `position:
// fixed`, placed from the anchor's own `getBoundingClientRect()` in
// viewport coordinates once, on open — so it needs no positioned ancestor
// and no wrapper either.
import * as React from "react";
import { useEscape } from "../hooks/useEscape";

export interface TooltipProps {
  content: string;
  children: React.ReactElement;
}

const OPEN_DELAY_MS = 400;

type AnchorHandlers = {
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  onFocus?: (e: React.FocusEvent) => void;
  onBlur?: (e: React.FocusEvent) => void;
};

export default function Tooltip({ content, children }: TooltipProps): React.ReactElement {
  const [rect, setRect] = React.useState<{ left: number; top: number } | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const anchorRef = React.useRef<HTMLElement | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = React.useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setRect({ left: r.left + r.width / 2, top: r.bottom + 6 });
    }, OPEN_DELAY_MS);
  }, []);

  const hide = React.useCallback(() => {
    clearTimer();
    setRect(null);
  }, []);

  useEscape(hide, rect !== null);
  React.useEffect(() => clearTimer, []);

  const child = children as React.ReactElement<AnchorHandlers>;
  const cloned = React.cloneElement(child, {
    ref: (el: HTMLElement | null) => {
      anchorRef.current = el;
    },
    onMouseEnter: (e: React.MouseEvent) => {
      child.props.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: React.MouseEvent) => {
      child.props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      child.props.onFocus?.(e);
      show();
    },
    onBlur: (e: React.FocusEvent) => {
      child.props.onBlur?.(e);
      hide();
    },
  } as AnchorHandlers & { ref: React.Ref<HTMLElement> });

  return (
    <>
      {cloned}
      {rect ? (
        <span
          role="tooltip"
          className="sky-tooltip"
          style={{ left: rect.left, top: rect.top }}
        >
          {content}
        </span>
      ) : null}
    </>
  );
}
