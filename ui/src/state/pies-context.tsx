// PiesProvider — ONE usePies instance for the whole app (BookmarksProvider's
// own reasoning: every consumer sharing one subscription instead of each
// firing its own listPies + registering its own event listener), and the
// owner of the picker: ⌘D, "Add to pie…" (useFileMenu.tsx) and the Sky
// tile's right-click (Toolbar.tsx) all need to open the SAME popover from
// completely different places in the tree, so `openPicker(path)` lives on
// this context instead of being prop-drilled — the same shape
// ContextMenuProvider (ContextMenu.tsx) uses for `useContextMenu().open`.
import * as React from "react";
import type { IpcSurface } from "../ipc";
import { usePies } from "../hooks/usePies";
import type { UsePiesResult } from "../hooks/usePies";
import PiePicker from "../components/PiePicker";
import { isRemoteAddress } from "../utils/remote-address";
import { basename } from "../utils/path";
import type { AppNoticeAction } from "../App";

export type NoticeFn = (text: string, action?: AppNoticeAction, durationMs?: number) => void;

export interface PiesContextValue extends UsePiesResult {
  openPicker: (path: string) => void;
}

const noopPies: UsePiesResult = {
  pies: [],
  setPies: () => {},
  upsertPie: async () => null,
  removePie: async () => {},
  addPieMember: async () => {},
  removePieMember: async () => {},
  relocatePieMember: async () => {},
  touchPieSeen: async () => {},
};

const PiesContext = React.createContext<PiesContextValue>({
  ...noopPies,
  openPicker: () => {},
});

export function usePiesContext(): PiesContextValue {
  return React.useContext(PiesContext);
}

export function PiesProvider({
  ipc,
  onNotice,
  children,
}: {
  ipc: IpcSurface;
  /** Surfaces a refused add through `AppShell`'s own `AppNotice` (App.tsx,
   *  "Do not add a notice context" — same convention `Sky.tsx` follows).
   *  Optional so a bare test double for `IpcSurface`/`PiesProvider` still
   *  renders without one. */
  onNotice?: NoticeFn;
  children: React.ReactNode;
}): React.ReactElement {
  const pies = usePies(ipc);
  const [pickerPath, setPickerPath] = React.useState<string | null>(null);

  // Canonicalizes `path` before opening the picker so `holdsPath`'s
  // exact-string compare (pies.ts) lines up with the canonical member paths
  // `pies::add_member` stores — a picker path like /tmp/x must resolve to
  // /private/tmp/x BEFORE the picker ever renders a checkmark, or the
  // checkmark (and the toggle's add-vs-remove branch) is wrong for any
  // non-canonical input (review: pies.ts:57 / pies.rs:206). A path that
  // can't be resolved (missing file, or a `skypie-remote://` address — M2
  // has no remote pie members) is refused with a notice instead of opening
  // a picker with nothing usable in it (spec section 6; review:
  // PiePicker.tsx:75). Centralized here rather than at each of ⌘D / the
  // tile's right-click / useFileMenu / the plate's "Add to another pie…" —
  // every one of them already calls this same `openPicker`.
  const openPicker = React.useCallback(
    (path: string) => {
      if (isRemoteAddress(path)) {
        onNotice?.("Can't add a pulled file to a pie yet");
        return;
      }
      if (!ipc.canonicalizePath) {
        // No-op test double — keep the old, uncanonicalized behaviour
        // rather than hanging the picker open forever on a promise that
        // will never resolve.
        setPickerPath(path);
        return;
      }
      ipc
        .canonicalizePath(path)
        .then(setPickerPath)
        .catch(() => onNotice?.(`Can't add "${basename(path)}" — the file is missing`));
    },
    [ipc, onNotice],
  );
  const closePicker = React.useCallback(() => setPickerPath(null), []);

  const value = React.useMemo<PiesContextValue>(
    () => ({ ...pies, openPicker }),
    [pies, openPicker],
  );

  return (
    <PiesContext.Provider value={value}>
      {children}
      {pickerPath !== null ? (
        <PiePicker
          path={pickerPath}
          pies={pies.pies}
          addPieMember={pies.addPieMember}
          removePieMember={pies.removePieMember}
          upsertPie={pies.upsertPie}
          removePie={pies.removePie}
          onNotice={onNotice}
          onClose={closePicker}
        />
      ) : null}
    </PiesContext.Provider>
  );
}
