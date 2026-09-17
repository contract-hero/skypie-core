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
import { shareLabel } from "../state/derived-pies";
import type { DerivedPie, DerivedPieFile } from "../state/derived-pies";
import { mtimeAgo, pieRows } from "../state/ios-pies";
import { basename } from "../utils/path";
import { nowSecs } from "../utils/beam-format";
import { useTabsDispatch } from "../state/TabsProvider";

export interface PhonePieSheetProps {
  pie: DerivedPie;
  onClose: () => void;
}

export default function PhonePieSheet({ pie, onClose }: PhonePieSheetProps): React.ReactElement {
  const dispatch = useTabsDispatch();

  // Newest first — the same order PiePlate.tsx's own layer list uses, so
  // the row a beam or a share just added is always on top. The sort itself
  // moved to ios-pies.ts (review: PhonePieSheet.tsx:43, minor) — this stays
  // the only place that needs the RESULT.
  const rows = React.useMemo(() => pieRows(pie), [pie]);

  // M6 review (major): the list declared role="listbox"/role="option" but
  // implemented no roving tabindex and no arrow-key handling — every row
  // stayed in the tab order and ArrowUp/ArrowDown/Home/End did nothing.
  // Spec line 154 says the layer list is the SAME on iOS as on macOS, and
  // spec line 134 defines that as role="listbox", roving tabindex,
  // arrow/Home/End — mirrored here from PiePlate.tsx's own
  // onLayerKeyDown, minus the folder-header/tree branch this flat,
  // folder-less list never needs.
  const [focusedRow, setFocusedRow] = React.useState(0);
  const rowRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const setRowRef = (i: number) => (el: HTMLButtonElement | null) => {
    rowRefs.current[i] = el;
  };
  React.useEffect(() => {
    setFocusedRow((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);
  const focusRow = (index: number): void => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    setFocusedRow(clamped);
    rowRefs.current[clamped]?.focus();
  };
  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (rows.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(focusedRow + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRow(focusedRow - 1);
        break;
      case "Home":
        e.preventDefault();
        focusRow(0);
        break;
      case "End":
        e.preventDefault();
        focusRow(rows.length - 1);
        break;
      default:
        break;
    }
  };

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

  return (
    <PhoneSheet label={pie.name} title={pie.name} tall onClose={onClose}>
      <div className="phone-sheet-pie">
        <Pie pie={pie} size={200} interactive={false} />
        <div className="phone-sheet-pie-readout">{shareLabel(pie.files)}</div>
      </div>
      <div role="listbox" aria-label="Files" data-testid="pie-sheet" onKeyDown={onListKeyDown}>
        {rows.map((file, i) => {
          // The sender-supplied name (ios-pies.ts's `name`) when there is
          // one, matching the "Received" list directly below on the same
          // start page — a beam's landed path can carry a `-2`/`-3`
          // collision suffix `basename(file.path)` alone would surface
          // (review: PhonePieSheet.tsx:70, minor).
          const name = file.name ?? basename(file.path);
          return (
            <button
              key={file.path}
              ref={setRowRef(i)}
              type="button"
              role="option"
              aria-selected={i === focusedRow}
              className="start-row"
              title={file.path}
              tabIndex={i === focusedRow ? 0 : -1}
              onFocus={() => setFocusedRow(i)}
              onClick={() => openRow(file)}
            >
              <span className="start-row-icon">
                <FileGlyph name={name} size={15} />
              </span>
              <span className="start-row-name">{name}</span>
              <span className="start-row-mtime">{mtimeAgo(file.mtime, nowSecs())}</span>
            </button>
          );
        })}
      </div>
    </PhoneSheet>
  );
}
