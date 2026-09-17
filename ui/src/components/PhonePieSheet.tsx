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
import { basename } from "../utils/path";
import { formatAgo, nowSecs } from "../utils/beam-format";
import { isRemoteAddress } from "../utils/remote-address";
import { useBeamActions } from "../state/beam";
import { useTabsDispatch } from "../state/TabsProvider";

/** Repeats PiePlate.tsx's own `mtimeAgo` — a two-line pure function, not
 *  worth importing across a component this small. `formatAgo` already
 *  returns the whole phrase "just now" for anything under 60s, so
 *  appending " ago" unconditionally would read "just now ago". */
function mtimeAgo(mtimeMs: number): string {
  const ago = formatAgo(Math.floor(mtimeMs / 1000), nowSecs());
  return ago === "just now" ? ago : `${ago} ago`;
}

export interface PhonePieSheetProps {
  pie: DerivedPie;
  onClose: () => void;
}

export default function PhonePieSheet({ pie, onClose }: PhonePieSheetProps): React.ReactElement {
  const { openReceived } = useBeamActions();
  const dispatch = useTabsDispatch();

  // Newest first — the same order PiePlate.tsx's own layer list uses, so
  // the row a beam or a share just added is always on top.
  const rows = React.useMemo(() => [...pie.files].sort((a, b) => b.mtime - a.mtime), [pie.files]);

  const openRow = (file: DerivedPieFile): void => {
    // A member's path is either a real local path (the Received pie) or a
    // `skypie-remote://peer/path` address (a Shared-from-<Mac> pie) — the
    // exact fork IosStartPage.tsx's own openReceived/openShared already
    // drove before M6. Kept here, in a component, rather than in
    // ios-pies.ts, which stays pure with no React/dispatch of its own.
    if (isRemoteAddress(file.path)) {
      dispatch({ type: "FOCUS_OR_OPEN", path: file.path, external: true });
    } else {
      openReceived(file.path);
    }
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
      <div role="listbox" aria-label="Files" data-testid="pie-sheet">
        {rows.map((file) => {
          const name = basename(file.path);
          return (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={false}
              className="start-row"
              title={file.path}
              onClick={() => openRow(file)}
            >
              <span className="start-row-icon">
                <FileGlyph name={name} size={15} />
              </span>
              <span className="start-row-name">{name}</span>
              <span className="start-row-dir">{mtimeAgo(file.mtime)}</span>
            </button>
          );
        })}
      </div>
    </PhoneSheet>
  );
}
