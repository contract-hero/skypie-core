// useDeepLink — subscribes to skypie://open-file (Backend canonicalizes the
// path against RootSet before emitting) and skypie://deep-link-error.
import * as React from "react";
import { listen } from "@tauri-apps/api/event";

export type DeepLinkIntent = "open" | "reveal";

export interface OpenFilePayload {
  path: string;
  intent: DeepLinkIntent;
  /**
   * True when the canonicalized path falls outside every configured root.
   * Emitted by `dispatch_deep_link` in src-tauri/src/lib.rs. Older payloads
   * (pre this change) do not include this field; readers must treat it as
   * optional and default to false.
   */
  out_of_root?: boolean;
}

export interface DeepLinkErrorPayload {
  url: string;
  reason: string;
  /** Set when the link comes from a device this app is not paired with:
   * that device's short id. The one rejection the UI can fix. */
  unpaired_from?: string;
}

export interface UseDeepLinkDeps {
  onIntent: (payload: OpenFilePayload) => void;
  onError?: (payload: DeepLinkErrorPayload) => void;
}

export function useDeepLink({ onIntent, onError }: UseDeepLinkDeps): void {
  // Handlers in refs, subscription keyed on `[]` — the same shape
  // `useTauriEvent`/`useFinderDrop` use. A deep link is a rare, one-shot
  // event, so tearing the listener down and re-adding it every time a
  // caller re-identifies its handler is pure risk: an event arriving
  // during that window reaches no listener at all. Callers therefore do
  // not have to memoize what they pass.
  const onIntentRef = React.useRef(onIntent);
  onIntentRef.current = onIntent;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  React.useEffect(() => {
    // `cancelled` guards the async `listen()` resolve from racing the
    // cleanup function — under React 18 StrictMode the cleanup runs
    // before `.then()` resolves, so a naive `unlisten = fn` assignment
    // would orphan the unlisten and leak duplicate listeners on remount.
    let cancelled = false;
    let unlistenOpen: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    try {
      listen("skypie://open-file", (event) => {
        onIntentRef.current(event.payload as OpenFilePayload);
      }).then((fn) => {
        if (cancelled) fn();
        else unlistenOpen = fn;
      }).catch(() => {
        // If Tauri events aren't available, ignore.
      });

      listen("skypie://deep-link-error", (event) => {
        onErrorRef.current?.(event.payload as DeepLinkErrorPayload);
      }).then((fn) => {
        if (cancelled) fn();
        else unlistenError = fn;
      }).catch(() => {
        // ignore
      });
    } catch {
      // Synchronous throw (non-Tauri environment), ignore.
    }
    return () => {
      cancelled = true;
      if (unlistenOpen) unlistenOpen();
      if (unlistenError) unlistenError();
    };
  }, []);
}
