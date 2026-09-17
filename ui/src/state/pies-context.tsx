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
  children,
}: {
  ipc: IpcSurface;
  children: React.ReactNode;
}): React.ReactElement {
  const pies = usePies(ipc);
  const [pickerPath, setPickerPath] = React.useState<string | null>(null);

  const openPicker = React.useCallback((path: string) => setPickerPath(path), []);
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
          onClose={closePicker}
        />
      ) : null}
    </PiesContext.Provider>
  );
}
