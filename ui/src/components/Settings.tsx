// Settings panel — workspace roots / ignore-set / drag-out / Slack share
// target / Devices (the user's own paired devices).
//
// One panel, two shapes. The markup is a flat list of `.settings-section`
// cards with label-left / control-right rows, which is the grammar the phone
// needs and the desktop reads fine in; `body.platform-ios` in styles.css
// grows the rows to `--tap-min` and stacks the peer actions. The content is
// what differs: the phone owns no files (PRODUCT.md — the iOS build is a
// read-only companion), so workspace roots, the ignore set, drag-out and the
// Slack target are desktop-only. Devices is the section the phone actually
// came for, and it is the whole panel there.
import * as React from "react";
import { RotateCw } from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import type { UseSettingsState } from "../hooks/useSettings";
import { defaultIpc } from "../ipc";
import type { RemotePeer, RemotePresenceEvent } from "../ipc";
import { useRemoteActions, useRemoteState } from "../state/remote";
import { usePlatform } from "../state/platform";
import CopyLinkButton from "./CopyLinkButton";
import ShareLinkButton from "./ShareLinkButton";
import QrCode from "./QrCode";
import { expiresIn, formatLastSeen, nowSecs } from "../utils/beam-format";
import { shortId } from "../utils/short-id";

export interface SettingsProps {
  ipc?: typeof defaultIpc;
}

/** The status caption under a device's name. Presence wins while it is
 *  known; otherwise the last time the two machines spoke. */
export function deviceStatus(
  presence: RemotePresenceEvent["state"] | undefined,
  peer: Pick<RemotePeer, "last_seen">,
  now: number,
): string {
  if (presence === "online") return "Online";
  if (presence === "connecting") return "Connecting…";
  return formatLastSeen(peer.last_seen, now);
}

/** A titled card. Every section in the panel is one, so the phone gets a
 *  predictable rhythm instead of a wall of headings and bare controls. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="settings-section">
      <h3 className="settings-section-title">{title}</h3>
      {hint ? <p className="settings-section-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

/** Label (plus optional second line) on the left, one control on the right.
 *  The whole row is the hit target, which is what makes a 44pt tap work. */
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  return (
    <label className="settings-row">
      <span className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        {hint ? <span className="settings-row-hint">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        className="settings-switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function DevicesSettings({
  ipc,
  state,
  setStateField,
}: {
  ipc: typeof defaultIpc;
  state: UseSettingsState;
  setStateField: (key: string, value: unknown) => Promise<void>;
}): React.ReactElement {
  const { peers, presence, invite, pairingBusy, pairingError } = useRemoteState();
  const { beginPairing, dismissInvite, unpair, connectPeer, connectAll } = useRemoteActions();
  const { isMacos } = usePlatform();
  const listenOn = state.preferences?.remote_listen ?? true;
  const now = nowSecs();

  // The dots should be live when the user looks — but a device this session
  // has already dialed keeps its answer, so opening the pane again costs no
  // second connect timeout per sleeping phone. "Check who's online" is the
  // explicit re-dial.
  React.useEffect(() => {
    peers.filter((p) => !(p.node_id in presence)).forEach((p) => connectPeer(p.node_id));
    // Once per mount, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Section
      title="Devices"
      hint={
        <>
          Your own devices, paired once. A link you copy for them opens the
          file straight from this machine — peer-to-peer, end-to-end
          encrypted, nothing uploaded.
        </>
      }
    >
      <div className="settings-block">
        {invite ? (
          <>
            {isMacos ? (
              <div className="settings-qr">
                <QrCode text={invite.link} />
              </div>
            ) : null}
            <input
              className="beam-link-input"
              readOnly
              value={invite.link}
              onFocus={(e) => e.currentTarget.select()}
              data-testid="remote-pair-link"
            />
            <p className="beam-hint">
              Open this link{isMacos ? " — or scan the code — " : " "}on the other device.
              Both screens will show the same six words; confirm they match
              before accepting. Expires in {expiresIn(invite.expires_at, now)}.
            </p>
            <div className="settings-actions">
              <CopyLinkButton link={invite.link} />
              <ShareLinkButton ipc={ipc} link={invite.link} sheetTitle="Sky Pie pairing link" />
              <button type="button" className="button button-secondary" onClick={dismissInvite}>
                Done
              </button>
            </div>
          </>
        ) : (
          <div className="settings-actions">
            <button type="button" className="button" disabled={pairingBusy} onClick={beginPairing}>
              {pairingBusy ? "Starting…" : "Pair a device…"}
            </button>
            {peers.length > 0 ? (
              <button
                type="button"
                className="button button-secondary"
                title="Check who's online"
                aria-label="Check who's online"
                onClick={connectAll}
              >
                <RotateCw size={13} strokeWidth={2} /> Check who's online
              </button>
            ) : null}
          </div>
        )}
        {pairingError ? <p className="beam-error" role="alert">{pairingError}</p> : null}
      </div>

      {peers.length === 0 ? (
        <p className="settings-empty">No devices paired yet.</p>
      ) : (
        <ul className="settings-list">
          {peers.map((peer) => {
            const peerPresence = presence[peer.node_id]?.state;
            const dot = peerPresence ?? "offline";
            return (
              <li key={peer.node_id} className="settings-peer" data-testid="settings-device">
                <div className="settings-peer-info">
                  <span className="settings-peer-name">
                    <span className={`remote-presence-dot remote-presence-${dot}`} aria-hidden />
                    <span className="settings-peer-label">{peer.device}</span>
                  </span>
                  {/* The dot alone carries presence only in a tooltip, which
                      a touch device never shows — so the words are here too. */}
                  <span className="settings-peer-meta" title={peer.node_id}>
                    {deviceStatus(peerPresence, peer, now)} ·{" "}
                    <code>{shortId(peer.node_id)}</code>
                  </span>
                </div>
                <div className="settings-peer-actions">
                  <button
                    type="button"
                    className="button button-secondary button-danger"
                    onClick={() => unpair(peer.node_id)}
                  >
                    Unpair
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="settings-block">
        <ToggleRow
          label="Listen at launch"
          hint="Accept your paired devices as soon as the app opens. Off, this machine stays silent until you share or open a link."
          checked={listenOn}
          onChange={(next) => void setStateField("preferences.remote_listen", next)}
        />
      </div>
    </Section>
  );
}

/** Roots, ignore set, drag-out and the Slack target. All four act on a local
 *  workspace and a macOS share sheet, so none of them mount on the phone. */
function DesktopSettings({
  state,
  setStateField,
  ipc,
}: {
  state: UseSettingsState;
  setStateField: (key: string, value: unknown) => Promise<void>;
  ipc: typeof defaultIpc;
}): React.ReactElement {
  const [newGlob, setNewGlob] = React.useState("");
  // Last committed Slack target; null = nothing committed this session yet.
  // Tracked in a ref (not from `state`) because the hook state doesn't
  // refresh after a write, and Enter-then-blur would double-commit.
  const lastSlackTarget = React.useRef<string | null>(null);

  const roots: string[] = state.roots ?? [];
  const ignoreGlobs: string[] = state.preferences?.ignore_globs ?? [];
  const dragOutMode: string = state.preferences?.drag_out_mode ?? "file";

  const handleAddRoot = async () => {
    if (ipc.pickDirectory) {
      const picked = await ipc.pickDirectory();
      if (picked) {
        await setStateField("roots", [...roots, picked]);
      }
    }
  };

  const handleRemoveRoot = async (root: string) => {
    await setStateField("roots", roots.filter((r) => r !== root));
  };

  const handleGlobCommit = async () => {
    const trimmed = newGlob.trim();
    if (trimmed) {
      await setStateField("preferences.ignore_globs", [...ignoreGlobs, trimmed]);
      setNewGlob("");
    }
  };

  const handleGlobKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      await handleGlobCommit();
    }
  };

  const handleGlobBlur = async () => {
    if (newGlob.trim()) {
      await handleGlobCommit();
    }
  };

  const handleDragModeChange = async (mode: "file" | "url") => {
    await setStateField("preferences.drag_out_mode", mode);
  };

  const handleSlackTargetCommit = async (value: string) => {
    const trimmed = value.trim();
    // Enter-then-blur fires this twice; skip the redundant IPC write.
    const previous = lastSlackTarget.current ?? (state.preferences?.slack_target ?? "");
    if (trimmed === previous) return;
    lastSlackTarget.current = trimmed;
    try {
      await setStateField("preferences.slack_target", trimmed.length > 0 ? trimmed : null);
    } catch {
      // Roll back so a retry with the same value isn't silently skipped.
      lastSlackTarget.current = previous;
    }
  };

  return (
    <>
      <Section title="Workspace Roots">
        {roots.length === 0 ? (
          <p className="settings-empty">No roots yet.</p>
        ) : (
          <ul className="settings-list">
            {roots.map((root) => (
              <li key={root} className="settings-list-row">
                <span className="settings-path" title={root}>{root}</span>
                <button
                  type="button"
                  className="button button-secondary button-danger"
                  aria-label={`remove ${root}`}
                  data-action="remove-root"
                  data-path={root}
                  onClick={() => void handleRemoveRoot(root)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="settings-actions">
          <button type="button" className="button" onClick={() => void handleAddRoot()}>
            Add root…
          </button>
        </div>
      </Section>

      <Section title="Ignore Set" hint="Saved, but not applied yet — the tree still filters on the built-in set.">
        {ignoreGlobs.length === 0 ? (
          <p className="settings-empty">Nothing ignored beyond the built-in set.</p>
        ) : (
          <ul className="settings-list">
            {ignoreGlobs.map((glob) => (
              <li key={glob} className="settings-list-row">
                <span className="settings-path">{glob}</span>
              </li>
            ))}
          </ul>
        )}
        <input
          type="text"
          className="settings-input"
          data-field="ignore-globs"
          aria-label="Add ignore glob"
          value={newGlob}
          onChange={(e) => setNewGlob(e.target.value)}
          onKeyDown={(e) => void handleGlobKeyDown(e)}
          onBlur={() => void handleGlobBlur()}
          placeholder="*.tmp"
        />
      </Section>

      <Section title="Drag-out Preference">
        <label className="settings-choice">
          <input
            type="radio"
            name="drag-out-mode"
            value="file"
            checked={dragOutMode === "file"}
            onChange={() => void handleDragModeChange("file")}
          />
          Drag a file (Finder-friendly)
        </label>
        <label className="settings-choice">
          <input
            type="radio"
            name="drag-out-mode"
            value="url"
            checked={dragOutMode === "url"}
            onChange={() => void handleDragModeChange("url")}
          />
          Drag a URL (Slack-friendly)
        </label>
      </Section>

      <Section
        title="Slack Share Target"
        hint={
          <>
            Slack has no macOS share-sheet extension, so Sky Pie opens
            your channel via a deep link instead — drag the file in from
            there. Accepts <code>TEAMID/CHANNELID</code> (e.g.{" "}
            <code>T0123ABCD/C0456EFGH</code>) or a full <code>slack://</code>{" "}
            URL.
          </>
        }
      >
        <input
          type="text"
          className="settings-input"
          data-field="slack-target"
          aria-label="Slack share target"
          defaultValue={state.preferences?.slack_target ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void handleSlackTargetCommit(e.currentTarget.value);
            }
          }}
          onBlur={(e) => void handleSlackTargetCommit(e.currentTarget.value)}
          placeholder="T0123ABCD/C0456EFGH"
        />
      </Section>
    </>
  );
}

export default function Settings({ ipc = defaultIpc }: SettingsProps): React.ReactElement {
  const { state, setStateField } = useSettings(ipc);
  const { isMacos } = usePlatform();

  if (!state) {
    return <div className="settings-panel" data-testid="settings-panel">Loading…</div>;
  }

  return (
    <div className="settings-panel" data-testid="settings-panel">
      {isMacos ? (
        <DesktopSettings ipc={ipc} state={state} setStateField={setStateField} />
      ) : null}
      <DevicesSettings ipc={ipc} state={state} setStateField={setStateField} />
    </div>
  );
}
