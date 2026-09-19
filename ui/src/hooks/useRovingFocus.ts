// useRovingFocus — the roving-tabindex half of the ARIA listbox pattern,
// as one hook: exactly one item is in the tab order at a time, the arrows
// move which one that is, and Home/End jump to the ends.
//
// It exists because the phone grew two listboxes in M6 — the Sky band
// (`IosStartPage.tsx`, horizontal) and the pie sheet's file list
// (`PhonePieSheet.tsx`, vertical) — whose keyboard code was the same
// twenty lines twice, differing only in which two arrow keys they read.
// Both had shipped a `role="listbox"` with NO keyboard contract at all
// before that, which is the failure one shared implementation makes
// unrepeatable.
//
// NOT used by `Sky.tsx` or `PiePlate.tsx`. Those two carry the same shape
// plus things this hook deliberately has no opinion about: a tin slot
// outside the pie list to clamp against, Enter/Delete/⌘ chords, and a
// folder-header tree branch. Folding them in would mean teaching this hook
// every one of those, which is the opposite of the simplification.
import * as React from "react";

export type RovingOrientation = "horizontal" | "vertical";

/** The inclusive index span the roving slot may occupy. A RANGE rather than
 *  a bare count because the two richer surfaces this hook is meant to grow
 *  into — `Sky.tsx` and `PiePlate.tsx` — carry a TIN slot that sits outside
 *  the pie list: it is reachable by the same arrows, at an index below 0
 *  (`{ min: -1, max: count - 1 }`), so a count alone cannot describe where
 *  focus is allowed to land. `rangeOfCount` below is the plain
 *  `0..count-1` case the two current callers want. */
export interface RovingRange {
  /** Lowest index focus may hold, inclusive. */
  min: number;
  /** Highest index focus may hold, inclusive. */
  max: number;
}

/** The plain list range `0..count-1` — empty for `count <= 0`, which
 *  `rovingTarget` answers `null` for. */
export function rangeOfCount(count: number): RovingRange {
  return { min: 0, max: count - 1 };
}

/** The focused index a list of `count` items may actually render, given a
 *  possibly stale stored index. Derived AT RENDER rather than repaired by an
 *  effect: an effect runs after the paint, so for one frame after a list
 *  shrank no item carried `tabIndex={0}` and the whole list dropped out of
 *  the tab order. An empty list clamps to 0, which addresses no item — there
 *  is nothing to put in the tab order anyway. */
export function clampFocus(index: number, count: number): number {
  return Math.max(0, Math.min(index, count - 1));
}

/**
 * The whole key-to-index decision, pure: the index the focus should move
 * to, or `null` for a key this pattern does not claim (so the caller leaves
 * the event alone, and a native Enter/Space still fires the item's own
 * click).
 *
 * Split out from the hook so it is unit-testable without a renderer —
 * there is no jsdom in `ui/`, so logic left inside a component or a hook
 * body is reachable only from e2e.
 *
 * Out-of-range results are CLAMPED, not wrapped: pressing ArrowRight on the
 * last tile keeps focus there. Wrapping is also a legal listbox, but every
 * pie surface in the product already clamps and the two must agree.
 */
export function rovingTarget(
  key: string,
  focusedIndex: number,
  range: RovingRange,
  orientation: RovingOrientation,
): number | null {
  const { min, max } = range;
  if (max < min) return null;
  const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const clamp = (i: number): number => Math.max(min, Math.min(max, i));
  switch (key) {
    case next:
      return clamp(focusedIndex + 1);
    case prev:
      return clamp(focusedIndex - 1);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

export interface RovingFocus {
  /** The one index whose item carries `tabIndex={0}`; every other is `-1`. */
  focusedIndex: number;
  /** For the item's own `onFocus` — a pointer or a Tab into the list moves
   *  the roving slot to whatever the user actually reached. */
  setFocusedIndex: (index: number) => void;
  /** `ref={setItemRef(i)}` — see the callback cache in the body for why
   *  this is not a fresh arrow function per render. */
  setItemRef: (index: number) => (el: HTMLElement | null) => void;
  /** For the LIST container's `onKeyDown`, not each item's. */
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export interface UseRovingFocusOptions {
  /** How many items the list currently holds. */
  count: number;
  orientation: RovingOrientation;
  /** Escape inside the list. The band leaves the band without closing
   *  anything else; a list inside a sheet passes nothing, so Escape falls
   *  through to whatever owns the sheet. */
  onEscape?: () => void;
}

export function useRovingFocus({ count, orientation, onEscape }: UseRovingFocusOptions): RovingFocus {
  // The RAW state, which may name an index the list no longer has (a beam
  // expired, a peer went offline). What the caller reads is `clampFocus` of
  // it, computed below at render — never a repaired copy written back by an
  // effect. See `clampFocus`'s own comment for why.
  const [rawFocusedIndex, setFocusedIndex] = React.useState(0);
  const focusedIndex = clampFocus(rawFocusedIndex, count);
  const itemsRef = React.useRef<Array<HTMLElement | null>>([]);

  // One callback ref per index, created once and reused. A `(i) => (el) =>
  // {...}` written inline returns a NEW function on every render, which
  // React reads as a changed ref: it calls the old one with `null` and the
  // new one with the element, for every item, on every render — so a list
  // that merely re-rendered churned its whole ref array.
  const refSettersRef = React.useRef(new Map<number, (el: HTMLElement | null) => void>());
  const setItemRef = React.useCallback((index: number) => {
    const cached = refSettersRef.current.get(index);
    if (cached) return cached;
    const setter = (el: HTMLElement | null): void => {
      itemsRef.current[index] = el;
    };
    refSettersRef.current.set(index, setter);
    return setter;
  }, []);

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === "Escape") {
        onEscape?.();
        return;
      }
      const target = rovingTarget(e.key, focusedIndex, rangeOfCount(count), orientation);
      if (target === null) return;
      e.preventDefault();
      setFocusedIndex(target);
      itemsRef.current[target]?.focus();
    },
    [focusedIndex, count, orientation, onEscape],
  );

  return { focusedIndex, setFocusedIndex, setItemRef, onKeyDown };
}
