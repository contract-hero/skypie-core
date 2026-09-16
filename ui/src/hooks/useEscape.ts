// Escape-to-dismiss, shared by every modal surface (Beam dialog, pairing
// dialog, Settings). Capture phase, and it stops propagation: one press must
// close exactly the dialog that mounted this hook and nothing behind it —
// App binds bare `escape` while reader mode is on, and a context menu closes
// itself on the same window event.
import * as React from "react";

/** `onEscape` carries the surface's dismiss semantics — for the pairing and
 *  Beam faces that means DECLINE, not merely close. `enabled` is for a
 *  surface that stays mounted while closed (the Share menu): while it is
 *  false no listener exists, so Escape reaches whatever else wants it. */
export function useEscape(onEscape: () => void, enabled = true): void {
  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onEscape();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onEscape, enabled]);
}
