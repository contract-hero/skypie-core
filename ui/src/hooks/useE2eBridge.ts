// The frontend half of the E2E harness's Rust→JS channel
// (app/src/e2e.rs::eval_in_webview). Rust cannot reliably run script in this
// app's webview and read a result back on its own (see that file's doc
// comment for why `WebviewWindow::eval` doesn't work here), so instead it
// emits `skypie://e2e-eval` — the same event-based channel
// `skypie://tree-changed` etc. already use — and this hook runs the JS and
// reports the outcome back through the `e2e_report` command.
//
// SAFE TO MOUNT UNCONDITIONALLY. This file ships in every build (the
// frontend bundle is not rebuilt per Rust profile), but it never calls
// `listen()` — the one thing that could make `new Function` below reachable
// — unless `e2e_bridge_enabled` answers true. That command exists only in a
// debug / `e2e-hooks` Rust build (app/src/e2e.rs); a release build has no
// such command, `invoke` rejects, and the bridge stays off for the life of
// the process. Nothing running IN the page — including same-origin content
// in a non-isolated preview iframe — can forge that answer: it is this
// build's own compiled-in `cfg`, not a value carried on any wire.
import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface E2eEvalPayload {
  id: string;
  js: string;
}

async function runOne(payload: E2eEvalPayload): Promise<void> {
  const { id, js } = payload;
  try {
    // The E2E driver's own expression, by design — this is the whole point
    // of the harness (drive the real app instead of a stand-in), and it is
    // unreachable outside a debug build; see the module comment above.
    // eslint-disable-next-line no-new-func
    const run = new Function(`return (async () => (${js}))()`) as () => Promise<unknown>;
    const value = await run();
    await invoke("e2e_report", { id, ok: true, value: value === undefined ? null : value });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await invoke("e2e_report", { id, ok: false, value: message });
  }
}

/** Mount once at the app root (see App.tsx). */
export function useE2eBridge(): void {
  React.useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    invoke<boolean>("e2e_bridge_enabled")
      .then((enabled) => {
        if (cancelled || !enabled) return undefined;
        return listen<E2eEvalPayload>("skypie://e2e-eval", (event) => {
          void runOne(event.payload);
        });
      })
      .then((fn) => {
        if (!fn) return;
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
        // Only now can an emitted evaluation reach us; tell Rust so it
        // stops holding early requests back.
        void invoke("e2e_ready");
      })
      .catch((e) => {
        // No such command — a release build. The bridge stays off.
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
