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
import { pickerPathPlan } from "./pies";
import { basename } from "../utils/path";
import { messageOf } from "../utils/error-message";
import type { AppNoticeAction } from "../App";

export type NoticeFn = (text: string, action?: AppNoticeAction, durationMs?: number) => void;

export interface PiesContextValue extends UsePiesResult {
  openPicker: (path: string) => void;
  /** "Locate…" on a pie member that no longer resolves: pick a replacement
   *  folder, re-point the member at it, and report a refusal. Lives here,
   *  beside `openPicker`, for the same reason `openPicker` does — it needs
   *  `ipc.pickDirectory` AND the notice channel AND a pie write, and
   *  `PiePlate` (its only caller today) would otherwise take `ipc` and
   *  `onNotice` as props purely to hand them straight back down into one.
   *  Resolves when the flow ends, whichever way it ends — including a
   *  cancelled picker, and including an IPC surface with no
   *  `pickDirectory` at all (a test double), where there is nothing to
   *  pick with and nothing to report. */
  locateMember: (pieId: string, oldPath: string) => Promise<void>;
  /** The provider's own notice channel, re-exposed so a consumer deep in the
   *  tree can report a refused pie op without prop-drilling `onNotice` down
   *  to it (`PiePlate`'s "Remove from pie" is the first such caller).
   *  Optional for the same reason the prop is: a bare test double renders
   *  without one. */
  notice?: NoticeFn;
}

// `null`, not a silent no-op default: with no-op defaults a consumer
// rendered outside `PiesProvider` looked like an app with zero pies whose
// every op quietly did nothing, which is a bug that shows up as "the button
// does nothing" rather than as an error.
const PiesContext = React.createContext<PiesContextValue | null>(null);

export function usePiesContext(): PiesContextValue {
  const ctx = React.useContext(PiesContext);
  if (!ctx) throw new Error("usePiesContext must be used inside a <PiesProvider>");
  return ctx;
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
  // `usePies` raises the store's own "this document cannot be read"
  // warning through this same channel — one notice per distinct warning.
  const pies = usePies(ipc, onNotice);
  const [pickerPath, setPickerPath] = React.useState<string | null>(null);

  // Canonicalizes `path` before opening the picker so `holdsPath`'s
  // exact-string compare (pies.ts) lines up with the canonical member paths
  // `pies::add_member` stores — a picker path like /tmp/x must resolve to
  // /private/tmp/x BEFORE the picker ever renders a checkmark, or the
  // checkmark (and the toggle's add-vs-remove branch) is wrong for any
  // non-canonical input (`holdsPath`). A path that
  // can't be resolved (missing file, or a `skypie-remote://` address — M2
  // has no remote pie members) is refused with a notice instead of opening
  // a picker with nothing usable in it (spec section 6). Centralized here rather than at each of ⌘D / the
  // tile's right-click / useFileMenu / the plate's "Add to another pie…" —
  // every one of them already calls this same `openPicker`.
  const openPicker = React.useCallback(
    (path: string) => {
      const plan = pickerPathPlan(path, Boolean(ipc.canonicalizePath), isRemoteAddress);
      if (plan.action === "refuse") {
        onNotice?.(plan.reason);
        return;
      }
      if (plan.action === "open") {
        setPickerPath(plan.path);
        return;
      }
      // `plan.action === "canonicalize"` only when the method exists.
      ipc
        .canonicalizePath?.(plan.path)
        .then(setPickerPath)
        // Show the io error the command actually returned: EACCES, ELOOP,
        // ENOTDIR and a transport failure are not "the file is missing",
        // and reporting them all that way sent the user looking for a file
        // that is there.
        .catch((err: unknown) => onNotice?.(`Can't add "${basename(path)}" — ${messageOf(err, "the path could not be resolved")}`));
    },
    [ipc, onNotice],
  );
  const closePicker = React.useCallback(() => setPickerPath(null), []);

  const relocatePieMember = pies.relocatePieMember;
  const locateMember = React.useCallback(
    async (pieId: string, oldPath: string) => {
      if (!ipc.pickDirectory) return;
      const picked = await ipc.pickDirectory();
      // The user cancelled the native picker — not a refusal, nothing to say.
      if (!picked) return;
      try {
        await relocatePieMember(pieId, oldPath, picked);
      } catch (err: unknown) {
        onNotice?.(
          `Couldn't use that folder — ${messageOf(err, "the member could not be re-pointed")}`,
        );
      }
    },
    [ipc, relocatePieMember, onNotice],
  );

  const value = React.useMemo<PiesContextValue>(
    () => ({ ...pies, openPicker, locateMember, notice: onNotice }),
    [pies, openPicker, locateMember, onNotice],
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
