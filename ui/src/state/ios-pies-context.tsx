// ios-pies-context.tsx — M6: the phone Sky band's own data source.
// `IosPiesProvider` owns three things: the `remoteListShared` fan-out
// (moved here verbatim from IosStartPage.tsx, which read a second local
// copy of the same fetch before M6), the derived pie array (`ios-pies.ts`'s
// `iosPies`, memoized), and which pie's `PhonePieSheet` is open.
//
// Mounted ONLY inside PhoneShell.tsx — NEVER in App.tsx's ProviderShell,
// which is the ancestor tree macOS renders too. A provider fetching
// `remote_list_shared` unconditionally there would cost every desktop
// launch a wasted round trip through every online peer for a band that
// macOS never shows.
import * as React from "react";
import type { IpcSurface, SharedEntry } from "../ipc";
import { useBeamActions, useBeamState } from "./beam";
import { useRemoteActions, useRemoteState } from "./remote";
import { iosPies } from "./ios-pies";
import type { DerivedPie } from "./derived-pies";

export interface IosPiesContextValue {
  /** Received first, then one Shared-from-<Mac> pie per online peer, empty
   *  ones already dropped (`ios-pies.ts`'s `iosPies`) — `IosStartPage.tsx`
   *  renders this list directly, with no filtering of its own. */
  pies: DerivedPie[];
  /** The flat, per-file listing across every online peer, newest-shared
   *  first — the exact shape `IosStartPage.tsx`'s own "Shared with you"
   *  section rendered before M6, now sourced from the one fetch this
   *  provider owns instead of a second copy of it in that component. */
  sharedEntries: Array<SharedEntry & { peer: string }>;
  /** The pie whose `PhonePieSheet` is open, or `null`. `PhoneShell.tsx`
   *  looks this id up against `pies` FRESH on every render — never
   *  snapshots the `DerivedPie` object — so a beam landing mid-sheet
   *  updates it live. */
  openPieId: string | null;
  setOpenPieId: (id: string | null) => void;
}

const IosPiesContext = React.createContext<IosPiesContextValue | null>(null);

export function useIosPies(): IosPiesContextValue {
  const ctx = React.useContext(IosPiesContext);
  if (!ctx) throw new Error("useIosPies must be used within IosPiesProvider");
  return ctx;
}

export function IosPiesProvider({
  ipc,
  children,
}: {
  ipc: Pick<IpcSurface, "remoteListShared">;
  children: React.ReactNode;
}): React.ReactElement {
  const { peers, presence } = useRemoteState();
  const { deviceLabel } = useRemoteActions();
  const { received } = useBeamState();
  const { refreshReceived } = useBeamActions();

  React.useEffect(() => {
    refreshReceived();
  }, [refreshReceived]);

  // What each paired Mac has offered this phone. There is no push and no
  // notification: the Mac records an offer when the user shares a link,
  // and this asks for the list. The right moment to ask is whenever
  // presence changes, because the iOS foreground hop drops every session
  // and rewrites presence — so a resume refreshes this without a second
  // signal (no timer, no poll).
  const [shared, setShared] = React.useState<Array<{ peer: string; entries: SharedEntry[] }>>([]);
  const onlineKey = peers
    .filter((p) => presence[p.node_id]?.state === "online")
    .map((p) => p.node_id)
    .join(",");

  React.useEffect(() => {
    const online = onlineKey ? onlineKey.split(",") : [];
    if (online.length === 0) {
      setShared([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      online.map((peer) =>
        (ipc.remoteListShared?.(peer) ?? Promise.resolve([]))
          .then((entries) => ({ peer, entries }))
          // One unreachable device must not blank the whole list.
          .catch(() => ({ peer, entries: [] as SharedEntry[] })),
      ),
    ).then((lists) => {
      if (!cancelled) setShared(lists);
    });
    return () => {
      cancelled = true;
    };
    // `ipc` is a stable prop for the app's lifetime (PhoneShell forwards
    // the same instance App.tsx was given); keeping the dep list to just
    // `onlineKey`, IosStartPage.tsx's own original shape, means a presence
    // flip is the only thing that re-fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineKey]);

  const sharedEntries = React.useMemo(
    () =>
      shared
        .flatMap(({ peer, entries }) => entries.map((e) => ({ ...e, peer })))
        .sort((a, b) => b.shared_at - a.shared_at),
    [shared],
  );

  const pies = React.useMemo(
    () =>
      iosPies(
        received,
        shared.map(({ peer, entries }) => ({ peer, device: deviceLabel(peer), entries })),
      ),
    [received, shared, deviceLabel],
  );

  const [openPieId, setOpenPieId] = React.useState<string | null>(null);

  // A pie can disappear from under an open sheet (its last offer/beam is
  // gone, or the peer that held it went offline) — the same guard Sky.tsx's
  // own plate uses for a pie deleted out from under it.
  React.useEffect(() => {
    if (openPieId && !pies.some((p) => p.id === openPieId)) setOpenPieId(null);
  }, [pies, openPieId]);

  const value = React.useMemo<IosPiesContextValue>(
    () => ({ pies, sharedEntries, openPieId, setOpenPieId }),
    [pies, sharedEntries, openPieId],
  );

  return <IosPiesContext.Provider value={value}>{children}</IosPiesContext.Provider>;
}
