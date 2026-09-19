// ios-pies-context.tsx — M6: the phone Sky band's own data source.
// `IosPiesProvider` owns exactly two things: the `remote_list_shared` fan-out
// (moved here from IosStartPage.tsx, which read a second local copy of the
// same fetch before M6) and the derived pie array (`ios-pies.ts`'s
// `iosPies`, memoized). It holds DATA ONLY — which pie's sheet is open is
// `PhoneShell.tsx`'s own `sheet` state, the one place a phone sheet of any
// kind is decided, so there is no second copy of that to keep in step.
//
// Mounted ONLY inside PhoneShell.tsx — NEVER in App.tsx's ProviderShell,
// which is the ancestor tree macOS renders too. A provider fetching
// `remote_list_shared` unconditionally there would cost every desktop
// launch a wasted round trip through every online peer for a band that
// macOS never shows.
import * as React from "react";
import type { IpcSurface, SharedEntry } from "../ipc";
import { useBeamActions, useBeamState } from "./beam";
import { useRemoteState } from "./remote";
import { iosPies } from "./ios-pies";
import type { DerivedPie } from "./derived-pies";
import { shortId } from "../utils/short-id";

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
}

const IosPiesContext = React.createContext<IosPiesContextValue | null>(null);

export function useIosPies(): IosPiesContextValue {
  const ctx = React.useContext(IosPiesContext);
  if (!ctx) throw new Error("useIosPies must be used within IosPiesProvider");
  return ctx;
}

/** What each online peer has offered this phone, keyed by node id. A RECORD
 *  rather than an array: `PeerShares` below writes one peer's slot without
 *  reading any other's, which is what lets one device's fetch land — or one
 *  device drop off — without disturbing the rest. */
type SharedByPeer = Record<string, SharedEntry[]>;

/**
 * One peer's `remote_list_shared` call, as a component so that REACT's own
 * keyed mount/unmount decides when to ask — not a dependency array over a
 * joined list of every online peer.
 *
 * That is the whole reason this is a component and not a loop inside one
 * effect: with one shared effect, a single device coming online re-ran the
 * fetch for EVERY device, and blanked the whole list in between. Keyed by
 * node id, a peer appearing mounts exactly one of these and asks exactly
 * once, and a peer going offline unmounts its own and drops only its own
 * rows.
 *
 * There is no push and no notification for this data: the Mac records an
 * offer when the user shares a link, and this asks for the list. Presence is
 * the right moment to ask, because the iOS foreground hop drops every
 * session and rewrites presence — so a resume refreshes this without a
 * second signal (no timer, no poll).
 *
 * Renders nothing.
 */
function PeerShares({
  peer,
  ipc,
  onEntries,
  onDrop,
}: {
  peer: string;
  ipc: Pick<IpcSurface, "remoteListShared">;
  onEntries: (peer: string, entries: SharedEntry[]) => void;
  onDrop: (peer: string) => void;
}): null {
  React.useEffect(() => {
    let cancelled = false;
    (ipc.remoteListShared?.(peer) ?? Promise.resolve([]))
      // One unreachable device must not blank the whole list — and now
      // cannot even blank its own neighbours' rows.
      .catch(() => [] as SharedEntry[])
      .then((entries) => {
        if (!cancelled) onEntries(peer, entries);
      });
    return () => {
      cancelled = true;
      onDrop(peer);
    };
  }, [peer, ipc, onEntries, onDrop]);
  return null;
}

export function IosPiesProvider({
  ipc,
  children,
}: {
  ipc: Pick<IpcSurface, "remoteListShared">;
  children: React.ReactNode;
}): React.ReactElement {
  const { peers, presence } = useRemoteState();
  const { received } = useBeamState();
  const { refreshReceived } = useBeamActions();

  React.useEffect(() => {
    refreshReceived();
  }, [refreshReceived]);

  const [shared, setShared] = React.useState<SharedByPeer>({});

  const online = React.useMemo(
    () => peers.filter((p) => presence[p.node_id]?.state === "online").map((p) => p.node_id),
    [peers, presence],
  );

  // Both callbacks are stable for the provider's lifetime, so a `PeerShares`
  // effect depends on nothing but its own `peer` and never re-fires for a
  // neighbour's change. Functional updates keep them off `shared` itself.
  const onEntries = React.useCallback((peer: string, entries: SharedEntry[]) => {
    setShared((prev) => ({ ...prev, [peer]: entries }));
  }, []);
  const onDrop = React.useCallback((peer: string) => {
    setShared((prev) => {
      if (!(peer in prev)) return prev;
      const next = { ...prev };
      delete next[peer];
      return next;
    });
  }, []);

  const sharedEntries = React.useMemo(
    () =>
      Object.entries(shared)
        .flatMap(([peer, entries]) => entries.map((e) => ({ ...e, peer })))
        .sort((a, b) => b.shared_at - a.shared_at),
    [shared],
  );

  // The device LABEL is resolved from `peers` inside this memo rather than
  // through `useRemoteActions().deviceLabel`. That function is rebuilt
  // whenever `presence` changes — which is every presence heartbeat — so
  // depending on its identity rebuilt every pie in the band, and handed
  // `Pie` a brand-new `files` array, several times a minute for data that
  // had not moved. `peers` only changes when the paired-device list really
  // does. The label is the same string either way: every peer in `shared`
  // came from `peers` in the first place (`online` above), so the
  // `presence[peer].device` fallback `deviceLabel` carries for an unknown
  // node is unreachable from here.
  const pies = React.useMemo(() => {
    const deviceOf = new Map(peers.map((p) => [p.node_id, p.device]));
    return iosPies(
      received,
      Object.entries(shared).map(([peer, entries]) => ({
        peer,
        device: deviceOf.get(peer) ?? shortId(peer),
        entries,
      })),
    );
  }, [received, shared, peers]);

  const value = React.useMemo<IosPiesContextValue>(
    () => ({ pies, sharedEntries }),
    [pies, sharedEntries],
  );

  return (
    <IosPiesContext.Provider value={value}>
      {online.map((peer) => (
        <PeerShares key={peer} peer={peer} ipc={ipc} onEntries={onEntries} onDrop={onDrop} />
      ))}
      {children}
    </IosPiesContext.Provider>
  );
}
