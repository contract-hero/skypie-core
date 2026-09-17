// usePies — list + mutate user pies via the pies.rs-backed Tauri commands.
// Mirrors useBookmarks.ts: initial listPies(), a skypie://pies-updated
// subscription for cross-window/cross-writer reconciliation (useTauriEvent,
// which — unlike useBookmarks's own hand-rolled `listen()` call — carries
// the StrictMode cancelled guard so a listener never gets orphaned by a
// cleanup that runs before `listen()` resolves), and optimistic local
// updates ahead of each IPC await.
//
// The 5-second delete undo lives here too (`removePieWithUndo`) rather than
// in Sky.tsx, because it needs to survive a reconciliation: see that
// function's own doc comment.
import * as React from "react";
import { defaultIpc } from "../ipc";
import type { Pie, PieMemberSource } from "../ipc";
import { subtractPending } from "../state/pies";
import { useTauriEvent } from "./useTauriEvent";

const NO_PENDING: ReadonlySet<string> = new Set<string>();

export interface UsePiesResult {
  pies: Pie[];
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
   *  nothing. */
  removePieWithUndo: (id: string, undoMs: number) => () => void;
}

export function usePies(ipc = defaultIpc): UsePiesResult {
  const [rawPies, setPies] = React.useState<Pie[]>([]);
  // Ids whose delete is still inside its undo window. They are subtracted
  // from EVERY list this hook publishes, not just from the one the delete
  // itself produced — that is the whole point (see `removePieWithUndo`).
  const [pendingDeletes, setPendingDeletes] = React.useState<ReadonlySet<string>>(NO_PENDING);
  const pies = React.useMemo(() => subtractPending(rawPies, pendingDeletes), [rawPies, pendingDeletes]);

  React.useEffect(() => {
    if (ipc.listPies) {
      ipc.listPies().then(setPies).catch(() => {
        // Ignore: backend may not be wired (older builds, tests with a
        // partial IpcSurface).
      });
    }
  }, [ipc]);

  // The backend echoes the full document on every write (add_bookmark's own
  // convention) — from any writer: this window's own optimistic call, a
  // touch_seen elsewhere, or (M5) the agent socket. Reconciling off this one
  // event is what keeps every subscriber consistent without each op having
  // to broadcast its own delta.
  useTauriEvent<Pie[]>("skypie://pies-updated", setPies);

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
      setPies((prev) => prev.filter((p) => p.id !== id));
      if (ipc.removePie) await ipc.removePie(id);
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
      setPies((prev) =>
        prev.map((p) => (p.id === id ? { ...p, members: p.members.filter((m) => m.path !== path) } : p)),
      );
      if (ipc.removePieMember) await ipc.removePieMember(id, path);
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
    (id: string, undoMs: number): (() => void) => {
      const unhide = () =>
        setPendingDeletes((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      setPendingDeletes((prev) => new Set(prev).add(id));

      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        // Remove for real FIRST: `removePie` filters `rawPies`
        // synchronously, so the pie never flashes back between dropping it
        // from `pendingDeletes` and the list catching up.
        void removePie(id);
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
    upsertPie,
    removePie,
    addPieMember,
    removePieMember,
    relocatePieMember,
    touchPieSeen,
    removePieWithUndo,
  };
}
