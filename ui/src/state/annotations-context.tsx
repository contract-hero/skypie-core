// AnnotationsProvider — one comment subscription for the whole app.
//
// Three consumers read from here and must never disagree: the comment rail
// beside the preview, the iOS comment sheet, and the open-comment badges in
// the sidebar. Each one polling for itself would produce three different
// answers a second apart, which on a live-reloading document is exactly the
// bug a user would report as "my comment disappeared".
//
// The backend broadcasts `skypie://annotations-changed` after every write, so
// a comment made in one window, pushed by a paired device, or resolved by an
// agent through the MCP tool all refresh the same way.
//
// It also owns the reconcile loop for a PULLED tab (`useRemoteCommentSync`),
// keyed to the active tab's source. One mount, therefore one poller: a
// second `AnnotationsProvider` would dial the host twice.

import * as React from "react";
import type { AnnotationIndexEntry, IpcSurface } from "../ipc";
import type { Annotation, Selector, Status } from "../annotations/types";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useEntitlement } from "./entitlement";
import { messageOf } from "../utils/error-message";
import { useRemoteCommentSync } from "./remote-comment-sync";

export interface AnnotationsContextValue {
  /** Comments on the file currently being read, oldest first. */
  annotations: Annotation[];
  /** Open-thread counts per file, for the sidebar badges. */
  index: AnnotationIndexEntry[];
  /** True while the first load for the current source is in flight. */
  loading: boolean;
  /** Set when a read or a write failed, so the UI says so rather than
   * rendering the failure as an empty, healthy-looking file. */
  error: string | null;
  addComment(body: string, selector: Selector[]): Promise<Annotation | null>;
  reply(parentId: string, body: string): Promise<Annotation | null>;
  setStatus(id: string, status: Status, note?: string): Promise<void>;
  exportSidecar(): Promise<string | null>;
  /** Open comments on one path, straight from the index (no file read). */
  openCountFor(path: string): number;
  /** Whether writes are allowed — what the UI renders its affordances from. */
  canWrite: boolean;
  /** True once a write was refused for want of a subscription. The paywall
   * renders from this, so it appears for ANY blocked write, not only the ones
   * a component remembered to guard. */
  blocked: boolean;
  /** Raise the paywall without attempting a write — what an affordance that
   * is visibly disabled ("Subscribe to reply") calls when tapped. */
  requestUpgrade(): void;
  dismissBlocked(): void;
}

const EMPTY: AnnotationsContextValue = {
  annotations: [],
  index: [],
  loading: false,
  error: null,
  async addComment() {
    return null;
  },
  async reply() {
    return null;
  },
  async setStatus() {},
  async exportSidecar() {
    return null;
  },
  openCountFor() {
    return 0;
  },
  canWrite: true,
  blocked: false,
  requestUpgrade() {},
  dismissBlocked() {},
};

const AnnotationsContext = React.createContext<AnnotationsContextValue>(EMPTY);

export function useAnnotations(): AnnotationsContextValue {
  return React.useContext(AnnotationsContext);
}

export function AnnotationsProvider({
  ipc,
  source,
  children,
}: {
  ipc: IpcSurface;
  /** The file the active tab is showing, or null on an empty tab. */
  source: string | null;
  children: React.ReactNode;
}): React.ReactElement {
  const [annotations, setAnnotations] = React.useState<Annotation[]>([]);
  const [index, setIndex] = React.useState<AnnotationIndexEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Guards an out-of-order response: switching tabs fast can land the old
  // file's comments after the new file's, and a comment rail showing another
  // document's feedback is worse than an empty one.
  const loadSeq = React.useRef(0);

  const refreshIndex = React.useCallback(() => {
    if (!ipc.annotationsIndex) return;
    ipc
      .annotationsIndex()
      .then(setIndex)
      .catch((e: unknown) => console.error("skypie: failed to read the annotations index", e));
  }, [ipc]);

  const refreshList = React.useCallback(() => {
    if (!ipc.annotationsList || !source) {
      setAnnotations([]);
      setLoading(false);
      return;
    }
    const seq = ++loadSeq.current;
    setLoading(true);
    ipc
      .annotationsList(source)
      .then((list) => {
        if (loadSeq.current !== seq) return;
        setError(null);
        setAnnotations(list);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (loadSeq.current !== seq) return;
        console.error("skypie: failed to read comments", e);
        // Say so, and KEEP what was on screen. Replacing the list with `[]`
        // rendered a failed read as the healthy "no comments yet" state,
        // right down to the empty-state copy — which is precisely the "my
        // comment disappeared" report this provider exists to prevent. On
        // iOS the console is not reachable, so the log alone is no log.
        setError(messageOf(e, "the comments on this file could not be read"));
        setLoading(false);
      });
  }, [ipc, source]);

  React.useEffect(() => {
    refreshList();
  }, [refreshList]);

  React.useEffect(() => {
    refreshIndex();
  }, [refreshIndex]);

  // One broadcast, every consumer. The payload is the source that changed;
  // the index always refreshes (a badge somewhere else may have moved) but
  // the list only when the change was about the file on screen.
  useTauriEvent<string>("skypie://annotations-changed", (changed) => {
    refreshIndex();
    if (changed === source) refreshList();
  });

  // ── The paywall gate ───────────────────────────────────────────────────
  // It lives HERE, on the three functions that write, and not on the render
  // conditions in the rail. Every write in the app funnels through this
  // provider, so this is the only place that cannot be bypassed by a future
  // writer — a sheet composer, a keyboard shortcut, a sidebar resolve action
  // — forgetting to check first. The UI still reads `canWrite` to decide what
  // to show; it just no longer carries the rule.
  const { canComment } = useEntitlement();
  const [blocked, setBlocked] = React.useState(false);

  // A pulled tab reconciles with its host: on open, on a timer while
  // visible, and right after each write below so the host sees a comment
  // without waiting for the next tick (a write mid-pass queues one catch-up
  // pass). A permanent failure — unpaired, refused — lands in `error` so the
  // rail says so; an unreachable host stays quiet. Inert for a local file.
  const syncNow = useRemoteCommentSync(ipc, source, setError);

  const addComment = React.useCallback(
    async (body: string, selector: Selector[]): Promise<Annotation | null> => {
      if (!canComment) {
        setBlocked(true);
        return null;
      }
      if (!ipc.annotationsAdd || !source) return null;
      try {
        const made = await ipc.annotationsAdd(source, body, selector, null);
        setError(null);
        // Optimistic append so the rail shows the comment on the next frame
        // rather than after the event round trip. The broadcast that follows
        // replaces the list wholesale, so a duplicate cannot survive.
        setAnnotations((prev) => [...prev, made]);
        syncNow();
        return made;
      } catch (e: unknown) {
        setError(messageOf(e, "the comment could not be saved"));
        return null;
      }
    },
    [ipc, source, canComment, syncNow],
  );

  const reply = React.useCallback(
    async (parentId: string, body: string): Promise<Annotation | null> => {
      if (!canComment) {
        setBlocked(true);
        return null;
      }
      if (!ipc.annotationsReply || !source) return null;
      try {
        const made = await ipc.annotationsReply(source, parentId, body);
        setError(null);
        setAnnotations((prev) => [...prev, made]);
        syncNow();
        return made;
      } catch (e: unknown) {
        setError(messageOf(e, "the comment could not be saved"));
        return null;
      }
    },
    [ipc, source, canComment, syncNow],
  );

  const setStatus = React.useCallback(
    async (id: string, status: Status, note?: string): Promise<void> => {
      if (!canComment) {
        setBlocked(true);
        return;
      }
      if (!ipc.annotationsSetStatus || !source) return;
      try {
        await ipc.annotationsSetStatus(source, id, status, note ?? null);
        setError(null);
        setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
        syncNow();
      } catch (e: unknown) {
        setError(messageOf(e, "the comment could not be saved"));
      }
    },
    [ipc, source, canComment, syncNow],
  );

  const exportSidecar = React.useCallback(async (): Promise<string | null> => {
    if (!ipc.annotationsExport || !source) return null;
    try {
      const dest = await ipc.annotationsExport(source);
      setError(null);
      return dest;
    } catch (e: unknown) {
      setError(messageOf(e, "the comment could not be saved"));
      return null;
    }
  }, [ipc, source]);

  const openCountFor = React.useCallback(
    (path: string) => index.find((row) => row.source === path)?.open ?? 0,
    [index],
  );

  const dismissBlocked = React.useCallback(() => setBlocked(false), []);
  const requestUpgrade = React.useCallback(() => setBlocked(true), []);

  const value = React.useMemo(
    () => ({
      annotations,
      index,
      loading,
      error,
      addComment,
      reply,
      setStatus,
      exportSidecar,
      openCountFor,
      canWrite: canComment,
      blocked,
      requestUpgrade,
      dismissBlocked,
    }),
    [
      annotations,
      index,
      loading,
      error,
      addComment,
      reply,
      setStatus,
      exportSidecar,
      openCountFor,
      canComment,
      blocked,
      requestUpgrade,
      dismissBlocked,
    ],
  );

  return <AnnotationsContext.Provider value={value}>{children}</AnnotationsContext.Provider>;
}

