// useFinderDrop — M4: Finder drops onto a pie or the tin (spec section 6,
// "Finder drop (M4)"). Tauri's own drag-drop event, not DOM `dragover`/
// `drop` (which never fire for an OS-level drag), carries PHYSICAL pixel
// positions — the hit test below divides by devicePixelRatio before
// calling `elementFromPoint`, exactly the spec's own "the hit-test divides
// physical pixels by devicePixelRatio, calls elementFromPoint and walks up
// to the nearest [data-pie-id]".
//
// Same two-half shape `state/pie-census.ts` / `state/pies.ts` already use:
// PURE helpers first (no React — this file's vitest run has no jsdom and
// no testing-library, so `finder-drop.test.ts` only ever touches a plain
// function over plain data), then the REACT hook that owns the Tauri
// subscription.
import * as React from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { basename } from "../utils/path";

// ── Pure ─────────────────────────────────────────────────────────────────

/** The tin's own hit-test result. The tin carries `data-pie-tin="true"`,
 *  deliberately NOT `data-pie-id` (M4 decision) — giving it a real pie id
 *  would make it a THIRD match for `ui/e2e/m3.e2e.ts:112`'s
 *  `.sky-pies [data-pie-id]` count, which asserts exactly the built-ins
 *  plus the one created user pie. */
export const TIN_DROP_ID = "tin";

/** Structural, not `Element`/`Document` — `finder-drop.test.ts` (no jsdom
 *  in this project's vitest config, `pie-census.ts`'s own doc comment)
 *  stubs exactly these two calls without constructing a real DOM. */
export interface HitTestElement {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}
export interface HitTestDocument {
  elementFromPoint(x: number, y: number): HitTestElement | null;
}

/**
 * Physical pixels (what a Tauri `over`/`drop` event carries) → the pie
 * tile or tin under the pointer, or `null` for a miss. Divides by `dpr` to
 * reach CSS pixel space (`elementFromPoint` is CSS, not physical), then
 * walks up from whatever's there — a wedge path, the freshness pill span,
 * any descendant — to the nearest `[data-pie-id]`/`[data-pie-tin]`, so a
 * hit anywhere inside a tile still resolves to the tile's own id.
 */
export function hitTestPieId(
  doc: HitTestDocument,
  physicalX: number,
  physicalY: number,
  dpr: number,
): string | null {
  const el = doc.elementFromPoint(physicalX / dpr, physicalY / dpr);
  const match = el?.closest("[data-pie-id],[data-pie-tin]") ?? null;
  if (!match) return null;
  const pieId = match.getAttribute("data-pie-id");
  if (pieId !== null) return pieId;
  return match.getAttribute("data-pie-tin") !== null ? TIN_DROP_ID : null;
}

/** The new pie's name for a tin drop (M4 decision): the dropped path's
 *  EXACT basename — a folder's own name, or a file's name with its
 *  extension — unchanged. The caller (Sky.tsx) is the one that runs this
 *  through `uniqueName` (state/pies.ts) before creating the pie; only the
 *  first path names it, though every dropped path still becomes a member. */
export function dropPieName(paths: string[]): string {
  return basename(paths[0] ?? "");
}

// ── React ────────────────────────────────────────────────────────────────

export interface UseFinderDropOptions {
  /** Sky.tsx always passes `true` (its own mount condition,
   *  `skyVisible && !readerMode`, already gates the listener for free —
   *  App.tsx) — kept as an explicit option anyway so this hook matches
   *  `useTauriEvent`'s own shape and stays usable by a future caller that
   *  needs to pause the subscription without unmounting. */
  enabled: boolean;
  /** Fired on every `over`, with the hit-tested id (a pie's own id,
   *  `TIN_DROP_ID`, or `null` for no hit), AND on `leave` (always `null`,
   *  since a `leave` payload carries no position to hit-test) — Sky.tsx's
   *  `dropTargetId` state is fed directly off this one stream, cleared by
   *  the same `null` a `leave` produces. */
  onOver: (id: string | null) => void;
  /** Fired on `drop`, with the SAME hit test result plus the dropped
   *  paths. A `null` id (nothing under the drop point) is still reported
   *  here — the M4 decision to ignore it silently is Sky.tsx's call, not
   *  this hook's. */
  onDrop: (id: string | null, paths: string[]) => void;
}

/**
 * Subscribes to the webview's native drag-drop stream via
 * `getCurrentWebview().onDragDropEvent()`. Copies the cancelled-guard
 * shape of `useTauriEvent.ts` verbatim: `onDragDropEvent` itself returns a
 * Promise (it awaits FOUR internal `listen()` calls, one per event
 * variant), and under StrictMode a remount's cleanup can run before that
 * promise resolves — a naive `unlisten = fn` assignment would then leak
 * the subscription instead of tearing it down.
 */
export function useFinderDrop({ enabled, onOver, onDrop }: UseFinderDropOptions): void {
  // Refs, not deps, for the same reason `useTauriEvent` keeps its handler
  // in a ref: the subscription only needs to know `enabled`, not
  // re-identify on every render a caller passes a fresh inline callback.
  const onOverRef = React.useRef(onOver);
  onOverRef.current = onOver;
  const onDropRef = React.useRef(onDrop);
  onDropRef.current = onDrop;

  React.useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // `Promise.resolve().then(...)`, not a bare `getCurrentWebview()` call —
    // `getCurrentWebview()` itself throws SYNCHRONOUSLY outside Tauri (it
    // dereferences `window.__TAURI_INTERNALS__`), which the `.catch()`
    // below can't see if it's the first thing this effect calls (review:
    // useFinderDrop.ts:112). Deferring it into the promise chain routes
    // that throw through the same `.catch()` as every other Tauri-missing
    // case here, matching `useTheme.ts`'s try/catch around the equivalent
    // `getCurrentWindow()` call.
    Promise.resolve()
      .then(() => getCurrentWebview())
      .then((webview) =>
        webview.onDragDropEvent((e) => {
          // `window.devicePixelRatio` AT EVENT TIME, not at mount — the
          // window can move to a different-DPI display between mount and a
          // drop landing.
          const dpr = window.devicePixelRatio || 1;
          switch (e.payload.type) {
            case "enter":
            case "over": {
              const { x, y } = e.payload.position;
              onOverRef.current(hitTestPieId(document, x, y, dpr));
              break;
            }
            case "drop": {
              const { x, y } = e.payload.position;
              onDropRef.current(hitTestPieId(document, x, y, dpr), e.payload.paths);
              break;
            }
            case "leave":
              onOverRef.current(null);
              break;
            default:
              break;
          }
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Tauri events unavailable (non-Tauri environment); ignore, same
        // as useTauriEvent/useDeepLink.
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [enabled]);
}
