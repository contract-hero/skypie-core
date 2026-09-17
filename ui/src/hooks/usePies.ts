// usePies — list + mutate user pies via the pies.rs-backed Tauri commands.
// Mirrors useBookmarks.ts: initial listPies(), a skypie://pies-updated
// subscription for cross-window/cross-writer reconciliation (useTauriEvent,
// which — unlike useBookmarks's own hand-rolled `listen()` call — carries
// the StrictMode cancelled guard so a listener never gets orphaned by a
// cleanup that runs before `listen()` resolves), and optimistic local
// updates ahead of each IPC await.
//
// `setPies` is exposed (useBookmarks doesn't expose an equivalent) because
// Sky.tsx's 5-second delete undo needs to hide a pie locally WITHOUT calling
// `removePie` yet — see pies.ts's `withoutPie`/`insertPieAt` doc comments
// for why the undo pair operates directly on this state instead of through
// an op.
import * as React from "react";
import { defaultIpc } from "../ipc";
import type { Pie, PieMemberSource } from "../ipc";
import { useTauriEvent } from "./useTauriEvent";

export interface UsePiesResult {
  pies: Pie[];
  setPies: React.Dispatch<React.SetStateAction<Pie[]>>;
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
}

export function usePies(ipc = defaultIpc): UsePiesResult {
  const [pies, setPies] = React.useState<Pie[]>([]);

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

  return {
    pies,
    setPies,
    upsertPie,
    removePie,
    addPieMember,
    removePieMember,
    relocatePieMember,
    touchPieSeen,
  };
}
