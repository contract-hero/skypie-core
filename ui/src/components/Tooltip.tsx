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
// and no wrapper either. It portals to `document.body` rather than
// rendering as a sibling of `children`: an earlier version rendered inline,
// which (for a band tile) put a non-`option` node inside `.sky-pies`'s
// `role="listbox"` while open.
import * as React from "react";
import { createPortal } from "react-dom";
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

/** `cloneElement(el, { ref })` REPLACES whatever ref `el` already carried —
 *  it does not merge them (React 18: `cloneElement(el, {ref: mine}).ref ===
 *  mine`, the original dropped). Sky.tsx puts its own roving-tabindex ref
 *  (`setItemRef(i)`) on every band `<Pie>` and then wraps it in `<Tooltip>`,
 *  so the old single-`ref` clone silently zeroed out `itemRefs.current` for
 *  every pie tile — `focusTile()` moved `focusedIndex`/`tabIndex` but never
 *  real DOM focus.
 *  This calls BOTH the child's own ref and this component's anchor callback
 *  from one merged callback ref instead of overwriting either. */
function mergeRefs<T>(...refs: Array<React.Ref<T> | null | undefined>): (instance: T | null) => void {
  return (instance: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(instance);
      else if (ref) (ref as React.MutableRefObject<T | null>).current = instance;
    }
  };
}

export default function Tooltip({ content, children }: TooltipProps): React.ReactElement {
  const [rect, setRect] = React.useState<{ left: number; top: number } | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const anchorRef = React.useRef<HTMLElement | null>(null);
  const bubbleId = React.useId();

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

  // `children`'s own ref (if any) lives on the element itself, not in
  // `.props` — `cloneElement` below must forward it alongside this
  // component's anchor callback (see `mergeRefs`'s doc comment).
  const child = children as React.ReactElement<AnchorHandlers> & { ref?: React.Ref<HTMLElement> | null };
  const childRef = child.ref ?? null;
  const setAnchor = React.useCallback((el: HTMLElement | null) => {
    anchorRef.current = el;
  }, []);
  // Memoized on the CHILD'S OWN ref identity: a fresh merged callback ref
  // every render makes React detach (call with null) and re-attach the
  // anchor on every single render, which for a band tile ran on every
  // recents/bookmarks tick.
  const mergedRef = React.useMemo(
    () => mergeRefs<HTMLElement>(setAnchor, childRef),
    [setAnchor, childRef],
  );

  const cloned = React.cloneElement(child, {
    ref: mergedRef,
    "aria-describedby": rect ? bubbleId : undefined,
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
  } as AnchorHandlers & { ref: React.Ref<HTMLElement>; "aria-describedby"?: string });

  return (
    <>
      {cloned}
      {rect
        ? createPortal(
            <span
              id={bubbleId}
              role="tooltip"
              className="sky-tooltip"
              style={{ left: rect.left, top: rect.top }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
