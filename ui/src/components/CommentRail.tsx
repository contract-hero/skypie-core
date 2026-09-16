// CommentRail — the list form of a file's comments: the body of the iOS
// bottom sheet. The desktop shows the same threads as margin notes beside
// their anchors instead (CommentOverlay); `railOrder` is shared by both.
//
// A reading surface first: threads sorted by where they sit in the document,
// detached ones at the top so a comment whose text vanished is the first
// thing seen rather than the last thing found.
//
// The rail owns no comment state. It reads the provider and asks it to write,
// so a comment made here, a comment pushed by a paired phone and a thread an
// agent resolved through the MCP tool all arrive through the same broadcast.

import * as React from "react";
import { MessageSquare } from "lucide-react";
import type { Anchored } from "../annotations/anchor";
import { reanchorAll } from "../annotations/anchor";
import { isOpen, toThreads } from "../annotations/types";
import type { Thread } from "../annotations/types";
import type { PendingSelection } from "../annotations/bridge";
import { useAnnotations } from "../state/annotations-context";
import CommentThread from "./CommentThread";
import CommentComposer from "./CommentComposer";

/**
 * Pair each thread with where it landed, in rail order.
 *
 * Re-anchoring runs over the ROOT comments only: a reply inherits its
 * thread's anchor rather than carrying one, so anchoring it separately would
 * search the document for text a reply never quoted.
 */
export function railOrder(
  threads: Thread[],
  text: string,
  currentHash: string | null,
): { thread: Thread; anchored: Anchored }[] {
  const placed = reanchorAll(
    threads.map((t) => t.root),
    text,
    currentHash,
  );
  const byId = new Map(threads.map((t) => [t.root.id, t]));
  return placed
    .map((anchored) => {
      const thread = byId.get(anchored.annotation.id);
      return thread ? { thread, anchored } : null;
    })
    .filter((v): v is { thread: Thread; anchored: Anchored } => v !== null);
}

export default function CommentRail({
  text,
  contentHash,
  pending,
  onClearPending,
  onSelectAnchor,
}: {
  /** The document's current text, for re-anchoring. Empty for an image. */
  text: string;
  /** `blake3:<hex>` of the file as loaded, when the reader reported one. */
  contentHash: string | null;
  /** A target waiting for a comment body, or null. */
  pending: PendingSelection | null;
  onClearPending: () => void;
  onSelectAnchor: (anchored: Anchored) => void;
}): React.ReactElement {
  const { annotations, loading, error, addComment, reply, setStatus, canWrite } =
    useAnnotations();
  const [showResolved, setShowResolved] = React.useState(false);

  const rows = React.useMemo(
    () => railOrder(toThreads(annotations), text, contentHash),
    [annotations, text, contentHash],
  );
  // One pass, not three: a re-anchor arrives on every live reload of the
  // file, and the sheet re-renders with it.
  const { visible, resolvedCount } = React.useMemo(() => {
    const open = rows.filter((r) => isOpen(r.thread));
    return {
      visible: showResolved ? rows : open,
      resolvedCount: rows.length - open.length,
    };
  }, [rows, showResolved]);

  const submit = async (body: string): Promise<boolean> => {
    if (!pending) return false;
    const made = await addComment(body, pending.selector);
    if (!made) return false;
    onClearPending();
    return true;
  };

  return (
    <aside className="comment-rail" aria-label="Comments">
      <header className="comment-rail-head">
        <MessageSquare size={14} strokeWidth={1.8} aria-hidden />
        <span className="comment-rail-title">Comments</span>
        {resolvedCount > 0 && (
          <button
            type="button"
            className="comment-rail-toggle"
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? "Hide resolved" : `Show resolved (${resolvedCount})`}
          </button>
        )}
      </header>

      {error && <p className="comment-rail-error">{error}</p>}

      {pending && canWrite && (
        <CommentComposer pending={pending} onSubmit={submit} onCancel={onClearPending} />
      )}

      {!loading && visible.length === 0 && !pending && (
        <p className="comment-rail-empty">
          Turn on the comment tool and tap a line, a block or an image to leave feedback for the agent that wrote this.
        </p>
      )}

      <div className="comment-rail-list">
        {visible.map(({ thread, anchored }) => (
          <CommentThread
            key={thread.root.id}
            thread={thread}
            anchored={anchored}
            active={false}
            onSelect={() => onSelectAnchor(anchored)}
            onReply={(body) => void reply(thread.root.id, body)}
            onSetStatus={(status) => void setStatus(thread.root.id, status)}
          />
        ))}
      </div>
    </aside>
  );
}
