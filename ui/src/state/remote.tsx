// RemoteProvider — the user's paired devices: the peer list, presence, the
// pairing flow (both faces), and the one thing a paired device does for the
// UI — a `skypie://open?…&from=<peer>` link arriving here opens a tab whose
// loader pulls the file from that device. Networking stays in the Rust core;
// this provider only sequences IPC commands and `skypie://remote-*` events.
//
// Mounted INSIDE TabsProvider (see App.tsx): the `open-remote` event lands
// in the tabs reducer.
import * as React from "react";
import type {
  IpcSurface,
  RemoteEvent,
  RemotePairInvite,
  RemotePeer,
  RemotePendingPair,
  RemotePresenceEvent,
} from "../ipc";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { nowSecs } from "../utils/beam-format";
import { formatRemoteAddress } from "../utils/remote-address";
import { shortId } from "../utils/short-id";
import { dialsEveryPeer } from "./remote-reconnect";
import type { ReconnectReason } from "./remote-reconnect";
import { useTabsDispatch } from "./TabsProvider";

/** A `skypie://pair` deep link that arrived on this machine. Nothing is
 * dialed until the user proceeds — see `completePairing`. */
export interface RemotePairLinkArrival {
  peer: string;
  peer_short: string;
  device: string;
  ticket: string;
}

export interface RemoteStateValue {
  peers: RemotePeer[];
  /** Keyed by NodeId. Absent = never connected this session (not "offline"
   * — a peer can be perfectly reachable but simply not dialed yet). */
  presence: Record<string, RemotePresenceEvent>;
  /** Host face: the link + this instance's identity, shown until dismissed. */
  invite: RemotePairInvite | null;
  /** Fingerprint step, on EITHER side (`role` tells them apart). */
  pendingConfirm: RemotePendingPair | null;
  /** A `skypie://pair` link arrived; shows an inviting device before dialing. */
  pairLinkArrival: RemotePairLinkArrival | null;
  pairingBusy: boolean;
  pairingError: string | null;
}

export interface RemoteActionsValue {
  refreshPeers(): void;
  beginPairing(): void;
  dismissInvite(): void;
  /** Dial a ticket (from the address bar, a pasted link, or a `pair-link`
   * arrival) and park at the fingerprint step. */
  completePairing(ticket: string): void;
  dismissPairLink(): void;
  /** Resolve the parked pairing after the human compares the six words. */
  confirmPairing(accept: boolean): void;
  unpair(nodeId: string): void;
  /** Dial one device so its presence dot tells the truth. Idempotent. */
  connectPeer(peer: string): void;
  /** Dial every paired device — the Devices pane's "check who's online". */
  connectAll(): void;
  /** The device name behind a node id, or its short id when this app does
   * not know the device — for badges, titles and error states. */
  deviceLabel(peer: string): string;
}

const RemoteStateContext = React.createContext<RemoteStateValue | null>(null);
const RemoteActionsContext = React.createContext<RemoteActionsValue | null>(null);

export function useRemoteState(): RemoteStateValue {
  const ctx = React.useContext(RemoteStateContext);
  if (!ctx) throw new Error("useRemoteState must be used within RemoteProvider");
  return ctx;
}

export function useRemoteActions(): RemoteActionsValue {
  const ctx = React.useContext(RemoteActionsContext);
  if (!ctx) throw new Error("useRemoteActions must be used within RemoteProvider");
  return ctx;
}

export function RemoteProvider({
  ipc,
  children,
}: {
  ipc: IpcSurface;
  children: React.ReactNode;
}): React.ReactElement {
  const dispatch = useTabsDispatch();

  const [peers, setPeers] = React.useState<RemotePeer[]>([]);
  const [presence, setPresence] = React.useState<Record<string, RemotePresenceEvent>>({});
  const [invite, setInvite] = React.useState<RemotePairInvite | null>(null);
  const [pendingConfirm, setPendingConfirm] = React.useState<RemotePendingPair | null>(null);
  const [pairLinkArrival, setPairLinkArrival] = React.useState<RemotePairLinkArrival | null>(null);
  const [pairingBusy, setPairingBusy] = React.useState(false);
  const [pairingError, setPairingError] = React.useState<string | null>(null);

  // ── Peers ──────────────────────────────────────────────────────────────
  const refreshPeers = React.useCallback(() => {
    ipc.remoteListPeers?.()
      .then((list) => {
        setPeers(list);
        // A pairing that completed by another route — the fingerprint face
        // on the other screen, a test hook — leaves the "Pairing request"
        // face with nothing left to ask. Drop it once its device is paired.
        setPairLinkArrival((cur) =>
          cur && list.some((p) => p.node_id === cur.peer) ? null : cur,
        );
      })
      .catch((e: unknown) => {
        console.error("skypie: failed to list peers", e);
      });
  }, [ipc]);

  // False once the provider is gone, so a reconnect still in flight stops
  // writing state into a tree that unmounted under it. Re-armed on mount
  // because a StrictMode double-mount runs the cleanup before the second
  // mount.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const connectPeer = React.useCallback(
    (peer: string) => {
      ipc.remoteConnect?.(peer).catch((e: unknown) => {
        // Presence already went offline through the backend's own event;
        // this is only the log line.
        console.warn("skypie: could not reach", peer, e);
      });
    },
    [ipc],
  );

  // Refresh the peer list and, when `dialsEveryPeer` allows it, dial every
  // paired peer. Two callers: the mount effect ("launch"), and the `resumed`
  // arm for the iOS foreground hop ("resume") — a resume is exactly when
  // every session this side held has already died.
  const reconnectAll = React.useCallback(
    (reason: ReconnectReason) => {
      if (!ipc.remoteListPeers) return;
      const settingsRead =
        reason === "resume"
          ? undefined
          : ipc.getState?.().catch(() => undefined);
      Promise.all([ipc.remoteListPeers(), settingsRead])
        .then(([list, settings]) => {
          if (!mountedRef.current) return;
          setPeers(list);
          if (!dialsEveryPeer(reason, settings?.preferences?.remote_listen ?? true)) return;
          list.forEach((p) => connectPeer(p.node_id));
        })
        .catch((e: unknown) => {
          console.error("skypie: failed to list peers", e);
        });
    },
    [ipc, connectPeer],
  );

  const connectAll = React.useCallback(() => {
    peers.forEach((p) => connectPeer(p.node_id));
  }, [peers, connectPeer]);

  // Mount: ONE peer fetch feeds both the list and the launch-time reconnect.
  React.useEffect(() => {
    reconnectAll("launch");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ipc]);

  useTauriEvent<RemotePresenceEvent>("skypie://remote-presence", (p) => {
    setPresence((prev) => ({ ...prev, [p.peer]: p }));
  });

  useTauriEvent<RemoteEvent>("skypie://remote-event", (event) => {
    switch (event.kind) {
      case "peers-updated":
        refreshPeers();
        break;
      case "resumed":
        // iOS froze this app, and the backend has just dropped every session
        // it held. Every presence entry is stale; the reconnect rewrites it.
        setPresence({});
        reconnectAll("resume");
        break;
      case "open-remote":
        // The whole pull model, from the UI's side: open a tab at the remote
        // address. Its loader (`ipc.readFile`) calls `remote_get`, which
        // dials the device and fetches the file into the cache. A remote
        // address is always external — it is not under any local root.
        dispatch({
          type: "FOCUS_OR_OPEN",
          path: formatRemoteAddress(event.peer, event.path),
          external: true,
        });
        break;
      case "pair-pending":
        setPairingBusy(false);
        // The fingerprint step supersedes the link-arrival face for the same
        // device: the dial it was asking permission for has happened.
        setPairLinkArrival((cur) => (cur && cur.peer === event.peer ? null : cur));
        // A new pairing starts clean. `pairingError` is shared by both faces
        // of the dialog, so a leftover from an earlier failed dial would
        // otherwise render above this fingerprint as if it belonged to it.
        setPairingError(null);
        setPendingConfirm({
          node_id: event.peer,
          device: event.device,
          fingerprint: event.fingerprint,
          role: event.role,
          created_at: nowSecs(),
        });
        break;
      case "pair-link":
        setPairLinkArrival({
          peer: event.peer,
          peer_short: event.peer_short,
          device: event.device,
          ticket: event.ticket,
        });
        break;
      default:
        break;
    }
  });

  // ── Pairing ────────────────────────────────────────────────────────────
  const beginPairing = React.useCallback(() => {
    setPairingError(null);
    setPairingBusy(true);
    const pending = ipc.remotePairBegin?.();
    if (!pending) {
      setPairingBusy(false);
      setPairingError("Pairing is not available in this build.");
      return;
    }
    pending
      .then((inv) => {
        setInvite(inv);
        setPairingBusy(false);
      })
      .catch((e: unknown) => {
        setPairingBusy(false);
        setPairingError(String(e));
      });
  }, [ipc]);

  const dismissInvite = React.useCallback(() => setInvite(null), []);

  const completePairing = React.useCallback(
    (ticket: string) => {
      setPairingError(null);
      setPairingBusy(true);
      const pending = ipc.remotePairComplete?.(ticket);
      if (!pending) {
        setPairingBusy(false);
        setPairingError("Pairing is not available in this build.");
        return;
      }
      pending
        .then((p) => {
          setPendingConfirm(p);
          setPairingBusy(false);
          setPairLinkArrival(null);
        })
        .catch((e: unknown) => {
          setPairingBusy(false);
          setPairingError(String(e));
        });
    },
    [ipc],
  );

  const dismissPairLink = React.useCallback(() => {
    setPairLinkArrival(null);
    // Clear the error with the dialog that owns it, or it reappears on the
    // next pairing surface.
    setPairingError(null);
  }, []);

  const confirmPairing = React.useCallback(
    (accept: boolean) => {
      if (!pendingConfirm) return;
      const call = ipc.remotePairConfirm?.(pendingConfirm.node_id, accept);
      if (!call) {
        setPairingError("Pairing is not available in this build.");
        return;
      }
      // Keep the dialog mounted until the call settles — it is the only
      // surface that renders `pairingError`, so clearing it up front would
      // hide a failed confirm and read as success while nothing was paired.
      setPairingBusy(true);
      call
        .then(() => {
          setPendingConfirm(null);
          setPairingBusy(false);
          refreshPeers();
          // A freshly paired device is one the user is about to use: dial
          // it now so its dot is live before they look.
          if (accept) connectPeer(pendingConfirm.node_id);
        })
        .catch((e: unknown) => {
          setPairingBusy(false);
          setPairingError(`Pairing did not complete: ${String(e)}. The device is NOT paired.`);
        });
    },
    [ipc, pendingConfirm, refreshPeers, connectPeer],
  );

  const unpair = React.useCallback(
    (nodeId: string) => {
      // Optimistic: revocation is immediate on the backend too.
      setPeers((list) => list.filter((p) => p.node_id !== nodeId));
      ipc.remoteUnpair?.(nodeId).catch((e: unknown) => {
        console.error("skypie: failed to unpair", nodeId, e);
        refreshPeers();
      });
    },
    [ipc, refreshPeers],
  );

  const deviceLabel = React.useCallback(
    (peer: string): string =>
      peers.find((p) => p.node_id === peer)?.device ?? presence[peer]?.device ?? shortId(peer),
    [peers, presence],
  );

  const stateValue = React.useMemo(
    (): RemoteStateValue => ({
      peers,
      presence,
      invite,
      pendingConfirm,
      pairLinkArrival,
      pairingBusy,
      pairingError,
    }),
    [peers, presence, invite, pendingConfirm, pairLinkArrival, pairingBusy, pairingError],
  );

  const actionsValue = React.useMemo(
    (): RemoteActionsValue => ({
      refreshPeers,
      beginPairing,
      dismissInvite,
      completePairing,
      dismissPairLink,
      confirmPairing,
      unpair,
      connectPeer,
      connectAll,
      deviceLabel,
    }),
    [
      refreshPeers, beginPairing, dismissInvite, completePairing, dismissPairLink,
      confirmPairing, unpair, connectPeer, connectAll, deviceLabel,
    ],
  );

  return (
    <RemoteActionsContext.Provider value={actionsValue}>
      <RemoteStateContext.Provider value={stateValue}>{children}</RemoteStateContext.Provider>
    </RemoteActionsContext.Provider>
  );
}
