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

/** What the hit test found under the pointer. A UNION, not a string with a
 *  `"tin"` sentinel compared by `===`: the tin is a different KIND of drop
 *  target (it creates a pie), not a pie whose id happens to read "tin", and
 *  a sentinel string was one `uniqueName` collision away from a user pie
 *  named after it. It also keeps the tin out of `[data-pie-id]`: the tin
 *  carries `data-pie-tin="true"` deliberately, since `m3.e2e.ts`'s
 *  `.sky-pies [data-pie-id]` count asserts exactly the built-ins plus the
 *  one created user pie. */
export type DropTarget = { kind: "pie"; id: string } | { kind: "tin" };

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
): DropTarget | null {
  const el = doc.elementFromPoint(physicalX / dpr, physicalY / dpr);
  const match = el?.closest("[data-pie-id],[data-pie-tin]") ?? null;
  if (!match) return null;
  const pieId = match.getAttribute("data-pie-id");
  if (pieId !== null) return { kind: "pie", id: pieId };
  return match.getAttribute("data-pie-tin") !== null ? { kind: "tin" } : null;
}

/** Whether two `DropTarget`s name the same thing — the ring's own "did the
 *  target change?" test, which a union cannot answer with `===` (each hit
 *  test mints a fresh object). */
export function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === "pie" && b.kind === "pie" ? a.id === b.id : true;
}

/** Fallback name for a tin drop whose paths yield nothing usable. */
export const FALLBACK_DROP_PIE_NAME = "Dropped";

/** The new pie's name for a tin drop (M4 decision): the dropped path's
 *  EXACT basename — a folder's own name, or a file's name with its
 *  extension — unchanged. The caller (Sky.tsx) is the one that runs this
 *  through `uniqueName` (state/pies.ts) before creating the pie; only the
 *  first path names it, though every dropped path still becomes a member.
 *
 *  Two degenerate inputs are PINNED to a non-empty answer rather than left
 *  to produce a pie with an empty name (which the band renders as a blank
 *  label nothing can be typed over): an empty `paths` array, and a path
 *  with a trailing slash (`/Users/x/ideas/`), whose POSIX basename is the
 *  empty string. Both fall back to `FALLBACK_DROP_PIE_NAME`. Refusing the
 *  drop instead was the alternative and was NOT taken: the user dropped
 *  real files, and a pie they can rename beats an error they cannot act
 *  on. */
export function dropPieName(paths: string[]): string {
  const first = paths[0] ?? "";
  // A trailing slash names the same folder, so strip it before taking the
  // basename rather than reporting the empty tail as the name.
  const trimmed = first.replace(/\/+$/, "");
  const name = trimmed === "" ? "" : basename(trimmed).trim();
  return name === "" ? FALLBACK_DROP_PIE_NAME : name;
}

/** The last physical position an `over` was hit-tested at, INCLUDING the
 *  device pixel ratio it was tested under. */
export interface OverPosition {
  x: number;
  y: number;
  dpr: number;
}

/**
 * Whether an `over` at `next` needs a fresh hit test, and the position to
 * remember either way. macOS delivers `over` continuously while a drag
 * hovers, including while the pointer is completely still, and
 * `elementFromPoint` forces a layout flush — so a motionless drag over the
 * band used to pay for one flush per event. Skipping the repeats is exact,
 * not an approximation: the same point under the same layout resolves to
 * the same tile.
 *
 * `dpr` is part of the identity, not just the position. The window can move
 * to a different-DPI display mid-drag with the pointer still: the physical
 * point is unchanged but it now lands on a DIFFERENT CSS pixel, so a guard
 * on `(x, y)` alone skipped the test and left the ring on the tile computed
 * for the old ratio.
 *
 * (Coalescing into one rAF was the alternative and was not taken: it delays
 * the ring by a frame and still flushes layout for a pointer that never
 * moved.)
 */
export function nextOverState(
  last: OverPosition | null,
  next: OverPosition,
): { hitTest: boolean; last: OverPosition } {
  const same = last !== null && last.x === next.x && last.y === next.y && last.dpr === next.dpr;
  return { hitTest: !same, last: next };
}

// ── React ────────────────────────────────────────────────────────────────

export interface UseFinderDropOptions {
  /** Fired when the hit-tested target may have CHANGED — NOT on every
   *  `over` the OS delivers. macOS sends `over` continuously while a drag
   *  hovers, including for a completely still pointer; this hook drops the
   *  repeats (`nextOverState`), so a motionless drag over one tile fires
   *  this once, not once per event. It fires with the target under the
   *  pointer (a pie, the tin, or `null` for no hit) and on `leave` (always
   *  `null`, since a `leave` payload carries no position to hit-test) —
   *  Sky.tsx's `dropTarget` state is fed directly off this one stream,
   *  cleared by the same `null` a `leave` produces. */
  onOver: (target: DropTarget | null) => void;
  /** Fired on `drop`, with the SAME hit test result plus the dropped
   *  paths. A `null` target (nothing under the drop point) is still
   *  reported here — the M4 decision to ignore it silently is Sky.tsx's
   *  call, not this hook's. */
  onDrop: (target: DropTarget | null, paths: string[]) => void;
  /** Reports a subscription this hook could NOT establish inside a running
   *  app — see the `.catch()` below for why that is not the same thing as
   *  "we are not in Tauri". Sky.tsx wires it to its own notice channel, so
   *  a dead Finder drop says so instead of just never ringing. */
  onError?: (err: unknown) => void;
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
export function useFinderDrop({ onOver, onDrop, onError }: UseFinderDropOptions): void {
  // Refs, not deps, for the same reason `useTauriEvent` keeps its handler
  // in a ref: the subscription must not re-identify on every render a
  // caller passes a fresh inline callback.
  const onOverRef = React.useRef(onOver);
  onOverRef.current = onOver;
  const onDropRef = React.useRef(onDrop);
  onDropRef.current = onDrop;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  // See `nextOverState` for why this is kept and why `dpr` is part of it.
  const lastOverRef = React.useRef<OverPosition | null>(null);

  React.useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // `Promise.resolve().then(...)`, not a bare `getCurrentWebview()` call —
    // `getCurrentWebview()` itself throws SYNCHRONOUSLY outside Tauri (it
    // dereferences `window.__TAURI_INTERNALS__`), which the `.catch()`
    // below can't see if it's the first thing this effect calls (review
    // finding on this effect). Deferring it into the promise chain routes
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
              const step = nextOverState(lastOverRef.current, { x, y, dpr });
              lastOverRef.current = step.last;
              if (!step.hitTest) break;
              onOverRef.current(hitTestPieId(document, x, y, dpr));
              break;
            }
            case "drop": {
              const { x, y } = e.payload.position;
              lastOverRef.current = null;
              onDropRef.current(hitTestPieId(document, x, y, dpr), e.payload.paths);
              break;
            }
            case "leave":
              // The ring is cleared, so the next `over` must hit-test
              // again even if the pointer is back at the same point.
              lastOverRef.current = null;
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
      .catch((err: unknown) => {
        // This catch covers the WHOLE chain, not only "we are not inside
        // Tauri": the synchronous `getCurrentWebview()` throw, each of the
        // four internal `listen()` calls, a missing `drag-drop` capability,
        // a webview label mismatch. Inside the shipped app any of those
        // means the entire M4 feature is dead — no ring, no drop, and
        // nothing said. So the silent branch is kept for exactly one case,
        // the one it was written for: `__TAURI_INTERNALS__` absent, which
        // is a browser/vitest run where there is no drag stream to have.
        if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
          console.error("skypie: Finder drop is not listening", err);
          onErrorRef.current?.(err);
        }
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
