// ShareMenu — the ONE place a file leaves this Mac from. Three routes, one
// button: a link for the user's own paired devices (the file is pulled when
// the link is opened), a beam link for anyone, and the native share sheet
// with the raw file (Mail and Messages attachments). Slack rides along when
// a target is configured, because it has no share extension of its own.
//
// The ⚡ pill next door stays a STATUS indicator (active beams), never an
// action — pills mark state, buttons do things.
import * as React from "react";
import { Check, Link2, Send, Share, Slack, Zap } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { IpcSurface } from "../ipc";
import { useBeamActions } from "../state/beam";
import { useEscape } from "../hooks/useEscape";
import { copyDeviceLink, makeDeviceLink } from "../utils/device-link";
import { shareAnchorFrom } from "../utils/share-link";

/** Long enough to read a failure, like ShareLinkButton's. */
const FAIL_RESET_MS = 2400;
const COPIED_RESET_MS = 1200;

type Feedback = null | "copied" | "failed";

/** The transient label state of the "Copy link for my devices" item. */
function useCopyFlash(): { feedback: Feedback; flash: (next: Exclude<Feedback, null>) => void } {
  const [feedback, setFeedback] = React.useState<Feedback>(null);
  const timer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const flash = React.useCallback((next: Exclude<Feedback, null>) => {
    setFeedback(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setFeedback(null),
      next === "copied" ? COPIED_RESET_MS : FAIL_RESET_MS,
    );
  }, []);
  return { feedback, flash };
}

export default function ShareMenu({
  path,
  ipc,
  slackUrl,
}: {
  path: string;
  ipc: IpcSurface;
  slackUrl: string | null;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const { beginSend } = useBeamActions();
  const { feedback, flash } = useCopyFlash();
  const close = React.useCallback(() => setOpen(false), []);
  // Only while open: this component outlives the menu, and a capture-phase
  // Escape listener that is always on would eat QuickOpen's and the address
  // bar's Escape.
  useEscape(close, open);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);

  const item = (
    label: React.ReactNode,
    icon: React.ReactNode,
    onSelect: () => void,
    testId: string,
  ) => (
    <button
      type="button"
      role="menuitem"
      className="share-menu-item"
      data-testid={testId}
      onClick={() => {
        setOpen(false);
        onSelect();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  const deviceLabel =
    feedback === "copied"
      ? "Copied"
      : feedback === "failed"
        ? "Couldn't make a link"
        : "Copy link for my devices";

  return (
    <div className="beam-indicator-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="toolbar-button"
        data-testid="preview-share"
        title="Share…"
        aria-label="Share this file"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Share size={13} strokeWidth={2} />
      </button>
      {open ? (
        <>
          <div className="beam-popover-scrim" onMouseDown={close} />
          <div className="beam-popover share-menu" role="menu" aria-label="Share">
            {item(
              deviceLabel,
              feedback === "copied" ? <Check size={13} strokeWidth={2.5} /> : <Link2 size={13} strokeWidth={2} />,
              () => void copyDeviceLink(ipc, path).then((ok) => flash(ok ? "copied" : "failed")),
              "share-copy-device-link",
            )}
            <div className="share-menu-hint">Opens on any device paired with this Mac</div>
            {item(
              "Share link…",
              <Send size={13} strokeWidth={2} />,
              () => {
                // The anchor rect must be read before any await: it goes
                // stale the moment the pane behind it scrolls.
                const anchor = buttonRef.current ? shareAnchorFrom(buttonRef.current) : null;
                void makeDeviceLink(ipc, path)
                  .then((link) => (anchor ? ipc.shareLink?.(link, anchor) : undefined))
                  .catch((e: unknown) => {
                    console.error("skypie: share link failed", e);
                    flash("failed");
                  });
              },
              "share-device-link",
            )}
            {item(
              "Beam to anyone…",
              <Zap size={13} strokeWidth={2} />,
              () => beginSend(path),
              "share-beam",
            )}
            <div className="share-menu-sep" role="separator" />
            {item(
              "Share file…",
              <Share size={13} strokeWidth={2} />,
              () => {
                const anchor = buttonRef.current ? shareAnchorFrom(buttonRef.current) : null;
                if (!anchor) return flash("failed");
                void ipc.shareFile?.([path], anchor).catch((e: unknown) => {
                  console.error("skypie: share file failed", e);
                  flash("failed");
                });
              },
              "share-file",
            )}
            {slackUrl
              ? item(
                  "Open in Slack",
                  <Slack size={13} strokeWidth={2} />,
                  () =>
                    void openUrl(slackUrl).catch((e: unknown) => {
                      console.error("skypie: could not open Slack", e);
                      flash("failed");
                    }),
                  "share-open-in-slack",
                )
              : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
