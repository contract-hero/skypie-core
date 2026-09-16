// IosStartPage — the iOS companion's empty-tab surface (PRODUCT.md §
// Operating Context: read-only companion, the phone owns no files). There
// is no workspace to open here, so this replaces StartPage's file/workspace
// actions with the two things that actually matter on iOS: getting paired,
// and reading what has already arrived. Reuses the
// same start-page/start-list/start-row classes as the macOS StartPage —
// same visual language, different content.
import * as React from "react";
import { MonitorSmartphone } from "lucide-react";
import { useRemoteState } from "../state/remote";
import { useBeamActions, useBeamState } from "../state/beam";
import { useTabsDispatch } from "../state/TabsProvider";
import { tauriIpc, type SharedEntry } from "../ipc";
import { formatRemoteAddress } from "../utils/remote-address";
import { FileGlyph } from "./FileIcon";
import { formatAgo, humanBytes, nowSecs } from "../utils/beam-format";

export interface IosStartPageProps {
  /** Opens the Settings modal, which mounts the Remote pane (pairing UI is
   * reused as-is — see PRODUCT.md). */
  onOpenSettings?: () => void;
}

export default function IosStartPage({ onOpenSettings }: IosStartPageProps): React.ReactElement {
  const { peers, presence } = useRemoteState();
  const { received } = useBeamState();
  const { openReceived, refreshReceived } = useBeamActions();
  const dispatch = useTabsDispatch();

  React.useEffect(() => {
    refreshReceived();
  }, [refreshReceived]);

  // What each paired Mac has offered this phone. There is no push and no
  // notification: the Mac records an offer when the user shares a link, and
  // this asks for the list. The right moment to ask is whenever presence
  // changes, because the iOS foreground hop drops every session and rewrites
  // presence — so a resume refreshes this without a second signal.
  const [shared, setShared] = React.useState<Array<SharedEntry & { peer: string }>>([]);
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
        (tauriIpc.remoteListShared?.(peer) ?? Promise.resolve([]))
          .then((entries) => entries.map((e) => ({ ...e, peer })))
          // One unreachable device must not blank the whole list.
          .catch(() => [] as Array<SharedEntry & { peer: string }>),
      ),
    ).then((lists) => {
      if (cancelled) return;
      setShared(lists.flat().sort((a, b) => b.shared_at - a.shared_at));
    });
    return () => {
      cancelled = true;
    };
  }, [onlineKey]);

  const openShared = React.useCallback(
    (peer: string, path: string) => {
      // Same route the `open-remote` deep link takes: a remote address whose
      // loader calls `remote_get`. Tapping is what moves the bytes — listing
      // moved none.
      dispatch({
        type: "FOCUS_OR_OPEN",
        path: formatRemoteAddress(peer, path),
        external: true,
      });
    },
    [dispatch],
  );

  const hasPeers = peers.length > 0;

  return (
    <div className="start-page" data-testid="start-page">
      <div className="start-page-inner">
        <div className="start-brand">
          <span className="start-mark" aria-hidden>V</span>
          <h1 className="start-title">Sky Pie</h1>
        </div>

        {!hasPeers ? (
          <>
            <p className="start-subtitle">
              Open what your Mac is showing, on your phone.
            </p>
            <div className="start-actions">
              <button
                type="button"
                className="start-action"
                data-testid="ios-pair-cta"
                onClick={onOpenSettings}
              >
                <MonitorSmartphone size={15} strokeWidth={2} /> Pair with a Mac…
              </button>
            </div>
            <p className="start-empty">
              Pairing is one-time and end-to-end encrypted, direct between
              this phone and your Mac — no account, no server.
            </p>
          </>
        ) : (
          <>
            <section className="start-section">
              <h2>
                <MonitorSmartphone size={13} strokeWidth={2} /> Paired Macs
              </h2>
              <ul className="start-list">
                {peers.map((peer) => {
                  const state = presence[peer.node_id]?.state ?? "offline";
                  return (
                    <li key={peer.node_id}>
                      <div className="start-row" data-testid="ios-peer-row">
                        <span
                          className={`remote-presence-dot remote-presence-${state}`}
                          title={state}
                          aria-hidden
                        />
                        <span className="start-row-name">{peer.device}</span>
                        <span className="start-row-dir">{state}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <button type="button" className="start-action" onClick={onOpenSettings}>
                Devices…
              </button>
            </section>

            {shared.length > 0 ? (
              <section className="start-section">
                <h2>Shared with you</h2>
                <ul className="start-list">
                  {shared.map((entry) => (
                    <li key={`${entry.peer}:${entry.path}`}>
                      <button
                        type="button"
                        className="start-row"
                        title={`${entry.path} — from ${
                          peers.find((p) => p.node_id === entry.peer)?.device ?? "a device"
                        }`}
                        onClick={() => openShared(entry.peer, entry.path)}
                      >
                        <span className="start-row-icon">
                          <FileGlyph name={entry.name} size={15} />
                        </span>
                        <span className="start-row-name">{entry.name}</span>
                        {/* An age, not the device name: `.start-row-dir` grows
                            to fill and truncates its head, which is right for
                            a path but ate the filename when it held a device
                            name. The device is in the title, and the list is
                            almost always one Mac anyway. */}
                        <span className="start-row-dir">{formatAgo(entry.shared_at, nowSecs())}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {received.length > 0 ? (
              <section className="start-section">
                <h2>Received</h2>
                <ul className="start-list">
                  {received.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className="start-row"
                        title={entry.path}
                        onClick={() => openReceived(entry.path)}
                      >
                        <span className="start-row-icon">
                          <FileGlyph name={entry.name} size={15} />
                        </span>
                        <span className="start-row-name">{entry.name}</span>
                        <span className="start-row-dir">{humanBytes(entry.size)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {shared.length === 0 && received.length === 0 ? (
              <p className="start-empty">
                Nothing here yet. On your Mac, choose Share → Copy link for my
                devices — the file shows up here — or beam a file to this phone.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
