// useRemoteCommentSync — keeps the comments on a PULLED tab in step with the
// host Mac's store.
//
// The provider hands in the active tab's source. When that source is a
// `skypie-remote://` address, this hook runs one reconcile pass on mount,
// one after every local write (the returned function), one whenever the
// window becomes visible or regains focus, and one on a timer while the
// window is visible. Every pass is the same idempotent backend command, so a
// failed pass is safe to repeat. It is not always a no-op: a pass that fails
// on the push has already landed the pull.
//
// Visibility, not focus, is the gate. In a WKWebView `document.hasFocus()`
// is false whenever the web view is not the first responder, which on the
// phone would make the timer a permanent no-op; focus stays a wake trigger.
//
// A local tab has nothing to reconcile: the hook is inert for it.

import * as React from "react";
import type { IpcSurface, LoadErrorKind, RemoteGetCause } from "../ipc";
import { parseRemoteAddress } from "../utils/remote-address";
import { WAKE_GAP_MS, nextSyncDelayMs } from "../annotations/sync";
import { readErrorTitle } from "../utils/read-error";
import { messageOf } from "../utils/error-message";

/** The one cause a failed pass may stay quiet about: the host is asleep or
 * away, and the next pass that reaches it carries everything. Every other
 * cause is permanent — unpaired, refused, a store failure here — and the
 * rail must say so, or comments stop crossing with no sign. */
const TRANSIENT: ReadonlySet<string> = new Set<RemoteGetCause>(["unreachable"]);

function causeOf(e: unknown): string {
  return typeof e === "object" && e !== null && "cause" in e && typeof e.cause === "string"
    ? e.cause
    : "unknown";
}

/**
 * Returns the function that starts one pass. Fire-and-forget for callers:
 * it never throws, and a call while a pass is in flight is queued as ONE
 * catch-up pass (a comment written mid-dial must not wait a full backoff).
 *
 * `onError` receives a title for a permanent failure and `null` once a pass
 * succeeds again.
 */
export function useRemoteCommentSync(
  ipc: IpcSurface,
  source: string | null,
  onError: (title: string | null) => void,
): () => void {
  const target = source ? parseRemoteAddress(source) : null;
  const peer = target?.peer ?? null;
  const path = target?.path ?? null;

  const failures = React.useRef(0);
  // The source whose pass is running. Keyed, not boolean: the provider is
  // mounted once for every tab, so a tab switch must neither wait for the
  // previous tab's dial nor let that dial's completion clear this tab's.
  const inFlight = React.useRef<string | null>(null);
  const pending = React.useRef(false);
  const lastPassAt = React.useRef(0);

  const pass = React.useCallback((): Promise<void> => {
    if (!peer || !path || !source || !ipc.remoteSyncAnnotations) return Promise.resolve();
    // One pass at a time. A slow dial and a timer tick must not stack; a
    // write during a pass is remembered and runs once the pass ends.
    if (inFlight.current === source) {
      pending.current = true;
      return Promise.resolve();
    }
    inFlight.current = source;
    lastPassAt.current = Date.now();
    return ipc
      .remoteSyncAnnotations(peer, path, source)
      .then(() => {
        failures.current = 0;
        onError(null);
      })
      .catch((e: unknown) => {
        failures.current += 1;
        const cause = causeOf(e);
        if (TRANSIENT.has(cause)) {
          // Local-first: the comment is already on disk here, and the next
          // pass that reaches the host carries it. Once per streak.
          if (failures.current === 1) console.warn("skypie: the host did not answer", e);
          return;
        }
        console.error("skypie: comment sync refused", e);
        onError(readErrorTitle(`remote-${cause}` as LoadErrorKind, messageOf(e, "")));
      })
      .finally(() => {
        if (inFlight.current === source) inFlight.current = null;
        if (pending.current) {
          pending.current = false;
          void pass();
        }
      });
  }, [ipc, peer, path, source, onError]);

  React.useEffect(() => {
    if (!peer || !path) return;
    // A new tab starts clean: the previous tab's backoff is not this host's.
    failures.current = 0;
    lastPassAt.current = 0;
    pending.current = false;
    let stopped = false;
    let timer: number | null = null;
    const visible = (): boolean => document.visibilityState === "visible";

    // The timer runs only while the window is visible: a hidden window
    // arms nothing, and the wake below re-arms it. Zero work in the
    // background, not just zero traffic. The next delay is chosen AFTER the
    // pass settles, so it reflects the pass that just ran, not the one
    // before it.
    const schedule = (): void => {
      if (stopped || !visible()) return;
      timer = window.setTimeout(() => {
        timer = null;
        const run = visible() ? pass() : Promise.resolve();
        void run.then(schedule);
      }, nextSyncDelayMs(failures.current));
    };
    // `visibilitychange` and `focus` fire together on an app switch; the
    // gap collapses them into one pass.
    const onWake = (): void => {
      if (!visible()) return;
      if (Date.now() - lastPassAt.current >= WAKE_GAP_MS) void pass();
      if (timer === null) schedule();
    };

    void pass();
    schedule();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [peer, path, pass]);

  return React.useCallback(() => {
    void pass();
  }, [pass]);
}
