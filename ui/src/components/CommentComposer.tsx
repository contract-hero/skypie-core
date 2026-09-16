// The composer for a fresh target — one component for the desktop margin
// note and the iOS sheet, so "Comment" means the same thing, with the same
// keys, in both. It owns the draft; the caller owns the target and the write.

import * as React from "react";
import type { PendingSelection } from "../annotations/bridge";

export default function CommentComposer({
  pending,
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  pending: PendingSelection;
  /** Resolves true when the write landed; the draft is kept otherwise. */
  onSubmit: (body: string) => Promise<boolean>;
  onCancel: () => void;
  autoFocus?: boolean;
}): React.ReactElement {
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // A new target replaces whatever was half-typed for the previous one:
  // keeping the old draft would attach words written about one passage to a
  // different passage entirely.
  React.useEffect(() => {
    setDraft("");
  }, [pending.selector]);

  const submit = async (): Promise<void> => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      // Clear only on SUCCESS. A refused write — store full, body too long,
      // disk full — keeps the text the error is asking the user to retry
      // with.
      if (await onSubmit(body)) setDraft("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="comment-new" data-testid="comment-composer">
      <div className="comment-new-target">
        <span className="comment-new-label">{pending.label}</span>
        {pending.exact ? (
          <blockquote className="comment-quote">{pending.exact}</blockquote>
        ) : null}
      </div>
      <textarea
        className="comment-input"
        value={draft}
        autoFocus={autoFocus}
        rows={3}
        placeholder="Add a comment…"
        aria-label="Comment"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="comment-new-actions">
        <button type="button" className="comment-action" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="comment-send"
          onClick={() => void submit()}
          disabled={!draft.trim() || busy}
        >
          Comment
        </button>
      </div>
    </div>
  );
}
