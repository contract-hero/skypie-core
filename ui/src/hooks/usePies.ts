// usePies — list + mutate user pies via the pies.rs-backed Tauri commands.
// Mirrors useBookmarks.ts: initial listPies(), a skypie://pies-updated
// subscription for cross-window/cross-writer reconciliation (useTauriEvent,
// which — unlike useBookmarks's own hand-rolled `listen()` call — carries
// the StrictMode cancelled guard so a listener never gets orphaned by a
// cleanup that runs before `listen()` resolves), and optimistic local
// updates ahead of each IPC await. Optimistic ops (`removePie`,
// `removePieMember`, `touchPieSeen`) roll their local edit BACK and rethrow
// when the IPC call rejects, so a refused write never leaves the band
// showing a change the store does not have.
//
// The 5-second delete undo lives here too (`removePieWithUndo`) rather than
// in Sky.tsx, because it needs to survive a reconciliation: see that
// function's own doc comment.
import * as React from "react";
import { defaultIpc } from "../ipc";
import type { Pie, PieMemberSource, PiesList } from "../ipc";
import { subtractPending, withPending, withoutPending } from "../state/pies";
import { useTauriEvent } from "./useTauriEvent";

const NO_PENDING: ReadonlySet<string> = new Set<string>();

export interface UsePiesResult {
  pies: Pie[];
  /** Why the band is empty when the document could not be read at all
   *  (`PiesList.warning`), or `null`. Raised once as a notice by the
   *  provider; exposed here so a consumer can also render it inline. */
  warning: string | null;
  upsertPie: (id: string | null, name: string) => Promise<Pie | null>;
  removePie: (id: string) => Promise<void>;
  addPieMember: (
    id: string,
    path: string,
    kind: "file" | "folder",
    source?: PieMemberSource,
  ) => Promise<void>;
  removePieMember: (id: string, path: string) => Promise<void>;
  relocatePieMember: (id: string, oldPath: string, newPath: string) => Promise<void>;
  touchPieSeen: (id: string) => Promise<void>;
  /** Deletes `id` after `undoMs`, hiding it immediately. Returns the undo:
   *  call it inside the window to cancel the delete, after it to do
   *  nothing. `onError` reports a delete that the backend refused once the
   *  window closed — by then the toast already said "Deleted", so silence
   *  left the user believing a pie was gone that is still on disk. */
  removePieWithUndo: (id: string, undoMs: number, onError?: (err: unknown) => void) => () => void;
}

export function usePies(ipc = defaultIpc, onNotice?: (text: string) => void): UsePiesResult {
  const [rawPies, setPies] = React.useState<Pie[]>([]);
  // Ids whose delete is still inside its undo window. They are subtracted
  // from EVERY list this hook publishes, not just from the one the delete
  // itself produced — that is the whole point (see `removePieWithUndo`).
  const [pendingDeletes, setPendingDeletes] = React.useState<ReadonlySet<string>>(NO_PENDING);
  const pies = React.useMemo(() => subtractPending(rawPies, pendingDeletes), [rawPies, pendingDeletes]);
  const [warning, setWarning] = React.useState<string | null>(null);

  // One notice per DISTINCT warning text, not one per event: the backend
  // echoes the whole list (warning included) on every write, so raising it
  // unconditionally would toast on every keystroke-driven op.
  const lastNotified = React.useRef<string | null>(null);
  const acceptList = React.useCallback(
    (list: PiesList) => {
      setPies(list.pies);
      const next = list.warning ?? null;
      setWarning(next);
      if (next && next !== lastNotified.current) onNotice?.(next);
      lastNotified.current = next;
    },
    [onNotice],
  );

  React.useEffect(() => {
    if (ipc.listPies) {
      ipc.listPies().then(acceptList).catch(() => {
        // Ignore: backend may not be wired (older builds, tests with a
        // partial IpcSurface).
      });
    }
  }, [ipc, acceptList]);

  // The backend echoes the full document on every write (add_bookmark's own
  // convention) — from any writer: this window's own optimistic call, a
  // touch_seen elsewhere, or (M5) the agent socket. Reconciling off this one
  // event is what keeps every subscriber consistent without each op having
  // to broadcast its own delta.
  useTauriEvent<PiesList>("skypie://pies-updated", acceptList);

  const upsertPie = React.useCallback(
    async (id: string | null, name: string): Promise<Pie | null> => {
      if (!ipc.upsertPie) return null;
      const pie = await ipc.upsertPie(id, name);
      setPies((prev) => {
        const at = prev.findIndex((p) => p.id === pie.id);
        if (at < 0) return [...prev, pie];
        const next = prev.slice();
        next[at] = pie;
        return next;
      });
      return pie;
    },
    [ipc],
  );

  const removePie = React.useCallback(
    async (id: string): Promise<void> => {
      if (!ipc.removePie) {
        setPies((prev) => prev.filter((p) => p.id !== id));
        return;
      }
      // Snapshot BEFORE the optimistic filter, so a refused delete puts the
      // pie back exactly where it was instead of leaving the band claiming
      // a removal that never landed (it would reappear on the next
      // unrelated event anyway, which reads as a ghost).
      let snapshot: Pie[] = [];
      setPies((prev) => {
        snapshot = prev;
        return prev.filter((p) => p.id !== id);
      });
      try {
        await ipc.removePie(id);
      } catch (err) {
        setPies(snapshot);
        throw err;
      }
    },
    [ipc],
  );

  const addPieMember = React.useCallback(
    async (
      id: string,
      path: string,
      kind: "file" | "folder",
      source?: PieMemberSource,
    ): Promise<void> => {
      if (!ipc.addPieMember) return;
      await ipc.addPieMember(id, path, kind, source);
      // No optimistic member insert here — canonicalization happens on the
      // Rust side (`fs::canonicalize`), so the local path string may not be
      // the one that ends up stored; the pies-updated event above carries
      // the real, canonical result.
    },
    [ipc],
  );

  const removePieMember = React.useCallback(
    async (id: string, path: string): Promise<void> => {
      if (!ipc.removePieMember) return;
      // Same rollback contract as `removePie` — the plate's own row vanishes
      // optimistically, so a refused removal has to put it back.
      let snapshot: Pie[] = [];
      setPies((prev) => {
        snapshot = prev;
        return prev.map((p) =>
          p.id === id ? { ...p, members: p.members.filter((m) => m.path !== path) } : p,
        );
      });
      try {
        await ipc.removePieMember(id, path);
      } catch (err) {
        setPies(snapshot);
        throw err;
      }
    },
    [ipc],
  );

  const relocatePieMember = React.useCallback(
    async (id: string, oldPath: string, newPath: string): Promise<void> => {
      if (!ipc.relocatePieMember) return;
      await ipc.relocatePieMember(id, oldPath, newPath);
    },
    [ipc],
  );

  const touchPieSeen = React.useCallback(
    async (id: string): Promise<void> => {
      const now = Date.now();
      setPies((prev) => prev.map((p) => (p.id === id ? { ...p, seen_at: now } : p)));
      if (ipc.touchPieSeen) await ipc.touchPieSeen(id);
    },
    [ipc],
  );

  /** Optimistically hides the pie and defers the real `removePie` IPC call
   *  until the undo window closes, so undoing never has to reconstruct
   *  anything the backend already forgot.
   *
   *  The pending-delete SET is what makes this correct. Hiding the pie by
   *  filtering local state alone was undone by any
   *  `skypie://pies-updated` event that landed during the window from an
   *  UNRELATED write (another window's `touch_seen`, M5's agent socket):
   *  that event replaces the whole local list with the server's document,
   *  which still has the pie, so the deleted pie reappeared mid-undo. A set
   *  the published list is always filtered through cannot be overwritten by
   *  an incoming list.
   */
  const removePieWithUndo = React.useCallback(
    (id: string, undoMs: number, onError?: (err: unknown) => void): (() => void) => {
      const unhide = () => setPendingDeletes((prev) => withoutPending(prev, id));
      setPendingDeletes((prev) => withPending(prev, id));

      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        // Remove for real FIRST: `removePie` applies its local filter
        // before it awaits, so the pie never flashes back between dropping
        // it from `pendingDeletes` and the list catching up.
        removePie(id).catch((err: unknown) => onError?.(err));
        unhide();
      }, undoMs);

      return () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        unhide();
      };
    },
    [removePie],
  );

  return {
    pies,
    warning,
    upsertPie,
    removePie,
    addPieMember,
    removePieMember,
    relocatePieMember,
    touchPieSeen,
    removePieWithUndo,
  };
}
