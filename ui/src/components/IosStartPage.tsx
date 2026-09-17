// IosStartPage — the iOS companion's empty-tab surface (PRODUCT.md §
// Operating Context: read-only companion, the phone owns no files). There
// is no workspace to open here, so this replaces StartPage's file/workspace
// actions with the two things that actually matter on iOS: getting paired,
// and reading what has already arrived. Reuses the
// same start-page/start-list/start-row classes as the macOS StartPage —
// same visual language, different content.
//
// M6 adds the Sky band at the top: a "Received" pie plus one
// "Shared from <Mac>" pie per online peer, both derived and owned by
// `IosPiesProvider` (mounted in PhoneShell.tsx) — see `state/ios-pies.ts`
// and `state/ios-pies-context.tsx`. Tapping a pie sets `openPieId`, which
// PhoneShell.tsx turns into an open `PhonePieSheet`.
import * as React from "react";
import { MonitorSmartphone } from "lucide-react";
import { useRemoteState } from "../state/remote";
import { useBeamActions, useBeamState } from "../state/beam";
import { useTabsDispatch } from "../state/TabsProvider";
import { formatRemoteAddress } from "../utils/remote-address";
import { FileGlyph } from "./FileIcon";
import { formatAgo, humanBytes, nowSecs } from "../utils/beam-format";
import { useIosPies } from "../state/ios-pies-context";
import Pie from "./Pie";
import SkyClouds from "./SkyClouds";

export interface IosStartPageProps {
  /** Opens the Settings modal, which mounts the Remote pane (pairing UI is
   * reused as-is — see PRODUCT.md). */
  onOpenSettings?: () => void;
}

export default function IosStartPage({ onOpenSettings }: IosStartPageProps): React.ReactElement {
  const { peers, presence } = useRemoteState();
  const { received } = useBeamState();
  const { openReceived } = useBeamActions();
  const dispatch = useTabsDispatch();

  // M6: `IosPiesProvider` (an ancestor, PhoneShell.tsx) owns the
  // `remoteListShared` fan-out and the `refreshReceived` call this
  // component used to do on its own — `sharedEntries` is the exact flat,
  // per-file shape the "Shared with you" section below already rendered
  // before M6, now sourced from that one fetch instead of a second copy of
  // it here.
  const { pies, sharedEntries, openPieId, setOpenPieId } = useIosPies();

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
        {pies.length > 0 ? (
          // M6: the same band markup Sky.tsx renders on macOS — role, the
          // glaze, the two clouds, `.sky-pies` as `role="presentation"` so
          // the tiles stay the listbox's own accessible children (Sky.tsx's
          // own comment on that trap) — minus the tin and the plate: iOS
          // writes nothing, so there is nothing to create and nowhere to
          // drop a folder. Omitted entirely (not just left empty) when it
          // would hold no pie — a bare 120px strip with nothing in it earns
          // no place on a screen this small, and it must appear whether or
          // not the phone has ever been paired (Received needs no peer).
          <div data-testid="ios-sky" className="sky-band" role="listbox" aria-label="Pies">
            <div className="sky-glaze" aria-hidden />
            <SkyClouds />
            <div className="sky-pies" role="presentation">
              {pies.map((pie) => (
                <Pie
                  key={pie.id}
                  pie={pie}
                  selected={pie.id === openPieId}
                  onOpen={() => setOpenPieId(pie.id)}
                />
              ))}
            </div>
          </div>
        ) : null}

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

            {sharedEntries.length > 0 ? (
              <section className="start-section">
                <h2>Shared with you</h2>
                <ul className="start-list">
                  {sharedEntries.map((entry) => (
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

            {sharedEntries.length === 0 && received.length === 0 ? (
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
