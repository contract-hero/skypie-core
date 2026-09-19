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
import { iosPies, sharedSourcesOf, withPeerEntries, withoutPeer } from "./ios-pies";
import type { SharedByPeer } from "./ios-pies";
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
  /** Node ids whose `remote_list_shared` call failed or timed out. The band
   *  drops those peers silently — their pie is simply absent — so the start
   *  page renders one line NAMING the device instead, which is the only
   *  difference the user can act on between "that Mac shared nothing" and
   *  "this phone could not ask that Mac". */
  failedPeers: ReadonlySet<string>;
}

/** How long one peer's `remote_list_shared` may take before this side gives
 *  up on it. Generous: a cold iroh connection to a sleeping Mac is seconds,
 *  and this deadline exists to bound a HUNG call, not to race a slow one. */
const LIST_SHARED_DEADLINE_MS = 15_000;

const IosPiesContext = React.createContext<IosPiesContextValue | null>(null);

export function useIosPies(): IosPiesContextValue {
  const ctx = React.useContext(IosPiesContext);
  if (!ctx) throw new Error("useIosPies must be used within IosPiesProvider");
  return ctx;
}

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
 * second signal: no refresh timer and no poll. (The deadline below is a
 * bound on ONE call, not a schedule.)
 *
 * Renders nothing.
 */
function PeerShares({
  peer,
  ipc,
  onEntries,
  onDrop,
  onFail,
}: {
  peer: string;
  ipc: Pick<IpcSurface, "remoteListShared">;
  onEntries: (peer: string, entries: SharedEntry[]) => void;
  onDrop: (peer: string) => void;
  onFail: (peer: string) => void;
}): null {
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (reason: string, detail?: unknown): SharedEntry[] => {
      // Reported, never swallowed. The backend already coerces an
      // UNREACHABLE peer to `Ok([])`, so anything that lands here is a
      // local fault — a missing command, a serde failure on `SharedEntry`,
      // a throw out of `onEntries` — which is exactly the class worth
      // printing.
      console.error(`skypie: remote_list_shared failed for ${peer}: ${reason}`, detail);
      if (!cancelled) onFail(peer);
      return [];
    };

    const call = ipc.remoteListShared
      ? ipc.remoteListShared(peer).catch((e: unknown) => fail("the call rejected", e))
      : Promise.resolve(fail("no remoteListShared on this IpcSurface"));

    // The wire `request()` carries no timeout of its own, so an ONLINE peer
    // that accepts the stream and then never answers would leave this pie
    // pending forever, with nothing on screen saying so. A deadline turns
    // that into the same reported failure as any other.
    const deadline = new Promise<SharedEntry[]>((resolve) => {
      timer = setTimeout(() => resolve(fail(`no answer within ${LIST_SHARED_DEADLINE_MS}ms`)), LIST_SHARED_DEADLINE_MS);
    });

    Promise.race([call, deadline]).then((entries) => {
      if (!cancelled) onEntries(peer, entries);
    });

    return () => {
      cancelled = true;
      // The timer outlives the effect otherwise, and fires `console.error`
      // for a peer this component no longer speaks for.
      if (timer !== undefined) clearTimeout(timer);
      onDrop(peer);
    };
    // `ipc` belongs here as much as `peer` does: a new `IpcSurface`
    // identity is a different backend, and this must ask it again.
    // PhoneShell.tsx therefore passes the SAME `ipc` object through
    // unchanged — rebuilding it per render would refetch every peer's list
    // on every render.
  }, [peer, ipc, onEntries, onDrop, onFail]);
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
  const [failedPeers, setFailedPeers] = React.useState<ReadonlySet<string>>(() => new Set());

  const online = React.useMemo(
    () => peers.filter((p) => presence[p.node_id]?.state === "online").map((p) => p.node_id),
    [peers, presence],
  );

  // Both callbacks are stable for the provider's lifetime, so a `PeerShares`
  // effect depends on nothing but its own `peer` and never re-fires for a
  // neighbour's change. Functional updates keep them off `shared` itself.
  const onEntries = React.useCallback((peer: string, entries: SharedEntry[]) => {
    setShared((prev) => withPeerEntries(prev, peer, entries));
  }, []);
  const onDrop = React.useCallback((peer: string) => {
    setShared((prev) => withoutPeer(prev, peer));
    setFailedPeers((prev) => {
      if (!prev.has(peer)) return prev;
      const next = new Set(prev);
      next.delete(peer);
      return next;
    });
  }, []);
  const onFail = React.useCallback((peer: string) => {
    setFailedPeers((prev) => (prev.has(peer) ? prev : new Set(prev).add(peer)));
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
  // does.
  //
  // A peer in `shared` but NOT in `peers` is dropped (`sharedSourcesOf`).
  // That state is real, for the render between a device leaving `peers` and
  // its `PeerShares` unmount clearing its rows — and a pie titled with a raw
  // node id names nothing a person recognises.
  const pies = React.useMemo(
    () => iosPies(received, sharedSourcesOf(shared, peers)),
    [received, shared, peers],
  );

  const value = React.useMemo<IosPiesContextValue>(
    () => ({ pies, sharedEntries, failedPeers }),
    [pies, sharedEntries, failedPeers],
  );

  return (
    <IosPiesContext.Provider value={value}>
      {online.map((peer) => (
        <PeerShares
          key={peer}
          peer={peer}
          ipc={ipc}
          onEntries={onEntries}
          onDrop={onDrop}
          onFail={onFail}
        />
      ))}
      {children}
    </IosPiesContext.Provider>
  );
}
