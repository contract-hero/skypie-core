// The frontend half of the E2E harness's Rust→JS channel
// (app/src/e2e.rs::eval_in_webview). Rust cannot reliably run script in this
// app's webview and read a result back on its own (see that file's doc
// comment for why `WebviewWindow::eval` doesn't work here), so instead it
// emits `skypie://e2e-eval` — the same event-based channel
// `skypie://tree-changed` etc. already use — and this hook runs the JS and
// reports the outcome back through the `e2e_report` command.
//
// SAFE TO MOUNT UNCONDITIONALLY. This file ships in every build (the
// frontend bundle is not rebuilt per Rust profile), but the listener it
// attaches — the one thing that could make `new Function` below reachable —
// survives only if `e2e_ready` accepts the call right after. That command
// exists only in a debug / `e2e-hooks` Rust build (app/src/e2e.rs); a
// release build has no such command, `invoke` rejects, the listener is torn
// down and the bridge stays off for the life of the process. Nothing running
// IN the page — including same-origin content in a non-isolated preview
// iframe — can forge that answer: it is this build's own compiled-in `cfg`,
// not a value carried on any wire.
//
// The order matters and is why this does not reuse `useTauriEvent`: the
// listener has to be attached BEFORE `e2e_ready` is invoked, or Rust would
// release a request that the page is not yet listening for. `useTauriEvent`
// only subscribes; it has no "and then run this command" step.
import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { messageOf } from "../utils/error-message";

interface E2eEvalPayload {
  id: string;
  js: string;
}

/** Compiled predicates, keyed by source. `waitFor` re-evaluates the SAME
 *  expression every 150 ms for up to a minute, so compiling it once per
 *  string turns a poll loop's cost into a map lookup. Bounded, because the
 *  keys are driver-supplied and a run may use many distinct expressions. */
const COMPILED = new Map<string, () => Promise<unknown>>();
const COMPILED_LIMIT = 64;

function compile(js: string): () => Promise<unknown> {
  const hit = COMPILED.get(js);
  if (hit) return hit;
  // The E2E driver's own expression, by design — this is the whole point
  // of the harness (drive the real app instead of a stand-in), and it is
  // unreachable outside a debug build; see the module comment above.
  // eslint-disable-next-line no-new-func
  const run = new Function(`return (async () => (${js}))()`) as () => Promise<unknown>;
  // Plain FIFO eviction: Map iterates in insertion order, so the oldest
  // entry is the first key. A predicate evicted mid-poll simply recompiles.
  if (COMPILED.size >= COMPILED_LIMIT) {
    const oldest = COMPILED.keys().next();
    if (!oldest.done) COMPILED.delete(oldest.value);
  }
  COMPILED.set(js, run);
  return run;
}

/** Report one outcome. The payload mirrors Rust's `E2eReport` (app/src/e2e.rs):
 *  tagged by `status`, carrying a value or a message, never both. */
function report(id: string, report: { status: "ok"; value: unknown } | { status: "err"; message: string }) {
  return invoke("e2e_report", { id, report });
}

async function runOne(payload: E2eEvalPayload): Promise<void> {
  const { id, js } = payload;
  try {
    const value = await compile(js)();
    try {
      await report(id, { status: "ok", value: value === undefined ? null : value });
    } catch (e) {
      // The value does not survive the IPC boundary (a DOM node, a BigInt).
      // Discarding this rejection would leave Rust waiting out its whole
      // timeout and then blaming the page for being unresponsive, so say
      // what actually happened instead.
      await report(id, { status: "err", message: messageOf(e, "the result is not serialisable") });
    }
  } catch (e) {
    await report(id, { status: "err", message: messageOf(e, "the expression threw") });
  }
}

/** Mount once at the app root (see App.tsx). Resolves true once the bridge
 *  is armed, so the root can publish the harness's seams only then. */
export function useE2eBridge(): boolean {
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    // Attach first, announce second: see the ordering note above.
    listen<E2eEvalPayload>("skypie://e2e-eval", (event) => {
      void runOne(event.payload);
    })
      .then(async (fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
        // The gate. A release build has no `e2e_ready`, so this rejects.
        await invoke("e2e_ready");
        if (!cancelled) setReady(true);
      })
      .catch((e: unknown) => {
        // The expected case is "no such command" — a release build, where
        // this hook is meant to stay quiet. Anything else (a listener that
        // could not attach, a command that exists and threw) is a real
        // fault that would otherwise vanish, so it is logged before the
        // same teardown runs.
        const message = messageOf(e, "the e2e bridge could not arm");
        if (!/not found|not allowed|unknown command/i.test(message)) {
          console.warn(`skypie: e2e bridge: ${message}`);
        }
        // Undo the listener so the bridge is not merely idle but genuinely
        // unreachable.
        unlisten?.();
        unlisten = null;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return ready;
}
