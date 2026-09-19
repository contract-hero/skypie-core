// PhonePieSheet — M6: the phone's zoom-in for a Sky band pie. Deliberately
// NOT PiePlate.tsx: that component needs `usePieCensus`, `usePiesContext`,
// `useWorkspace` and `useFileMenu`, calls `ipc.pickDirectory`, and carries
// its own `role="dialog"` — none of the first four exist on a read-only
// phone with no workspace, and nesting PiePlate's dialog inside
// `PhoneSheet`'s own dialog would be two dialogs deep for nothing (M6
// brief). This is instead a small, phone-only sheet body: the 200px
// portrait pie, a one-line readout, and a plain listbox of rows at the
// platform's own 44px tap target (`body.platform-ios .start-row`,
// styles.css).
import * as React from "react";
import PhoneSheet from "./PhoneSheet";
import Pie from "./Pie";
import { FileGlyph } from "./FileIcon";
import { labelOfWedges, wedgesOf } from "../state/derived-pies";
import type { DerivedPieFile } from "../state/derived-pies";
import { pieRows } from "../state/ios-pies";
import { useIosPies } from "../state/ios-pies-context";
import { mtimeAgo, nowSecs } from "../utils/beam-format";
import { useRovingFocus } from "../hooks/useRovingFocus";
import { useTabsDispatch } from "../state/TabsProvider";

export interface PhonePieSheetProps {
  /** The pie is taken by ID and resolved below against the provider's LIVE
   *  list, never handed in as a snapshotted object: a beam landing while
   *  this sheet is open has to change what it shows, with no re-tap. */
  pieId: string;
  onClose: () => void;
}

export default function PhonePieSheet({
  pieId,
  onClose,
}: PhonePieSheetProps): React.ReactElement | null {
  const dispatch = useTabsDispatch();
  const { pies } = useIosPies();
  const pie = pies.find((p) => p.id === pieId) ?? null;

  // Newest first — `pie-census.ts`'s own `byRow`, the comparator the desktop
  // plate's layer list already uses, so the row a beam or a share just added
  // is on top for the same reason on both platforms.
  const rows = React.useMemo(() => (pie ? pieRows(pie) : []), [pie]);

  // Grouped ONCE for this render, then handed to both consumers. `Pie`
  // groups `pie.files` itself when no `wedges` prop arrives, and the readout
  // (`shareLabel`) grouped the identical list a second time — two full
  // passes over every file, per render, for one disc and one string.
  const wedges = React.useMemo(() => wedgesOf(pie?.files ?? []), [pie]);

  // M6 review (major): the list declared role="listbox"/role="option" but
  // implemented no roving tabindex and no arrow-key handling — every row
  // stayed in the tab order and ArrowUp/ArrowDown/Home/End did nothing.
  // Spec line 154 says the layer list is the SAME on iOS as on macOS, and
  // spec line 134 defines that as role="listbox", roving tabindex,
  // arrow/Home/End. No `onEscape`: Escape inside a sheet belongs to the
  // sheet, which closes itself.
  const list = useRovingFocus({ count: rows.length, orientation: "vertical" });

  const openRow = (file: DerivedPieFile): void => {
    // A member's path is either a real local path (the Received pie) or a
    // `skypie-remote://peer/path` address (a Shared-from-<Mac> pie); both
    // are handled by the exact same FOCUS_OR_OPEN dispatch — `useBeamState`'s
    // `openReceived` was only ever that same dispatch under another name
    // (review: PhonePieSheet.tsx:51, minor), so this calls it directly
    // rather than branching on `isRemoteAddress` to reach it.
    dispatch({ type: "FOCUS_OR_OPEN", path: file.path, external: true });
    // Spec section 8 / the M6 brief: a tap opens the file AND closes the
    // sheet, the same "click closes the plate" convention PiePlate.tsx's
    // own row click uses on macOS.
    onClose();
  };

  // The pie went out from under the open sheet — its last beam/offer is
  // gone, or the peer that held it dropped offline. Rendering nothing IS the
  // whole guard: there is no stale copy to clamp, because this component
  // never took one.
  if (!pie) return null;

  // One clock for every row in this pass, rather than a `Date.now()` per row.
  const now = nowSecs();

  return (
    <PhoneSheet label={pie.name} title={pie.name} tall onClose={onClose}>
      <div className="phone-sheet-pie">
        <Pie pie={pie} size={200} interactive={false} wedges={wedges} />
        <div className="phone-sheet-pie-readout">{labelOfWedges(wedges)}</div>
      </div>
      <div role="listbox" aria-label="Files" data-testid="pie-sheet" onKeyDown={list.onKeyDown}>
        {rows.map((file, i) => (
          <button
            key={file.path}
            ref={list.setItemRef(i)}
            type="button"
            role="option"
            aria-selected={i === list.focusedIndex}
            className="start-row"
            title={file.path}
            tabIndex={i === list.focusedIndex ? 0 : -1}
            onFocus={() => list.setFocusedIndex(i)}
            onClick={() => openRow(file)}
          >
            <span className="start-row-icon">
              <FileGlyph name={file.name} size={15} />
            </span>
            {/* `file.name` is the SENDER's own filename, which is what the
                "Received" list on the same start page shows — a beam's
                landed path can carry a `-2`/`-3` collision suffix that
                `basename(file.path)` would surface instead. */}
            <span className="start-row-name">{file.name}</span>
            <span className="start-row-mtime">{mtimeAgo(file.mtime, now)}</span>
          </button>
        ))}
      </div>
    </PhoneSheet>
  );
}
