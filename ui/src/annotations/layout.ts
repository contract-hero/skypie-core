// Margin-note layout — where each comment card sits beside its anchor.
//
// A card wants to sit level with the line or element it is about. Two cards
// about neighbouring lines want the same pixels, so they are pushed apart:
// downward by default, the way Google Docs does it, and around the ACTIVE
// card when there is one — the card the user is reading stays level with its
// anchor and its neighbours give way, above and below.
//
// Pure arithmetic over measured heights, so the desktop overlay is testable
// without a DOM and the same pass could lay out a phone's markers.

export interface NoteBox {
  id: string;
  /** Where the anchor sits, in the overlay's coordinate space. */
  anchorTop: number;
  /** The card's measured height. */
  height: number;
}

export interface LayoutOptions {
  /** Vertical space kept between two cards. */
  gap?: number;
  /** Nothing is placed above this. */
  minTop?: number;
}

/**
 * Lay out `boxes`, returning each card's top.
 *
 * Order is by anchor, ties by input order, so two comments on one line keep
 * the order they were made in. `activeId` names the card that must stay level
 * with its anchor; cards above it move up to make room, then everything is
 * pushed back down from `minTop` if that sent the first card off the top.
 */
export function layoutNotes(
  boxes: NoteBox[],
  activeId: string | null,
  { gap = 8, minTop = 0 }: LayoutOptions = {},
): Map<string, number> {
  const sorted = boxes
    .map((b, i) => ({ ...b, i }))
    .sort((a, b) => a.anchorTop - b.anchorTop || a.i - b.i);
  const tops = new Array<number>(sorted.length);

  // 1. Downward pass: each card at its anchor, or just under the one before.
  let floor = minTop;
  for (let i = 0; i < sorted.length; i++) {
    tops[i] = Math.max(sorted[i].anchorTop, floor);
    floor = tops[i] + sorted[i].height + gap;
  }

  // 2. The active card takes its anchor back and pushes its predecessors up.
  const active = activeId === null ? -1 : sorted.findIndex((b) => b.id === activeId);
  if (active >= 0 && tops[active] > sorted[active].anchorTop) {
    tops[active] = Math.max(minTop, sorted[active].anchorTop);
    for (let i = active - 1; i >= 0; i--) {
      const ceiling = tops[i + 1] - gap - sorted[i].height;
      tops[i] = Math.min(tops[i], ceiling);
    }
    // 3. If that pushed the first card off the top, settle back down. The
    //    active card may move again here; the top edge wins over it.
    //
    //    Only the cards up to the active one need this. Step 2 moved cards
    //    UP and never down, so every card after the active one still sits at
    //    its step-1 position, which already respects the step-1 floor — and
    //    this pass cannot raise the floor above that. Re-running it over the
    //    tail is a no-op (checked over 400k random layouts).
    if (tops[0] < minTop) {
      floor = minTop;
      for (let i = 0; i <= active; i++) {
        tops[i] = Math.max(tops[i], floor);
        floor = tops[i] + sorted[i].height + gap;
      }
    }
  }

  return new Map(sorted.map((b, i) => [b.id, tops[i]]));
}
