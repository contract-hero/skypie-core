// One comment thread — the unit both shells render.
//
// The desktop expands one of these inside the margin note the reader opened
// (the other notes stay folded — see `CompactNote`); the iOS sheet stacks
// them all in a list. Sharing the component is what keeps "resolve" in the
// same place, with the same wording and the same affordance, on both
// platforms — the phone changes the architecture around it, not the language
// inside it.

import * as React from "react";
import { Check, CornerDownRight, RotateCcw } from "lucide-react";
import type { Anchored } from "../annotations/anchor";
import type { Annotation, Thread } from "../annotations/types";
import { cssOf } from "../annotations/types";
import { labelForTag } from "../annotations/bridge";
import { SHORT_ID_CHARS, shortId } from "../utils/short-id";

/** "Alvaro's iPhone" when the device announced a name, the short id if not. */
export function authorOf(a: Annotation): string {
  if (a.creator.name) return a.creator.name;
  const id = a.creator.id.replace(/^node:/, "");
  // `shortId` owns the 10-character width, which is fixed to iroh's own
  // `fmt_short` and to `skypie_ipc::short_id` — an id shown on a comment and
  // one shown in the Devices pane must be the same string.
  return id.length > SHORT_ID_CHARS ? `${shortId(id)}…` : id;
}

/**
 * "10:42" for today, "13 Sep" for this year, "13 Sep 2025" otherwise.
 *
 * A comment rail is read next to the document, not as a log: the time is a
 * hint about recency, and a full timestamp on every row would be noise. The
 * exact instant stays in the `title` attribute for anyone who needs it.
 */
export function shortTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) {
    return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const opts: Intl.DateTimeFormatOptions =
    at.getFullYear() === now.getFullYear()
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" };
  return at.toLocaleDateString(undefined, opts);
}

/**
 * What the anchor line says under a thread's header.
 *
 * Two outcomes, not three: `Anchored.line` is a number exactly when `range`
 * is set and `null` exactly when it is not (see `reanchor`), so "placed but
 * with no line" is not a state that exists.
 */
export function anchorLabel(anchored: Anchored | undefined): string {
  // An element anchor in an HTML artifact names the element: "line 21" of
  // the rendered text means nothing to a reader of a web page, while
  // "Table cell" is what they clicked.
  // A pin is placed by its region, not by any text, so it never reads as
  // lost and never borrows the element label of the image it sits on.
  if (anchored?.quality === "region") return "pin";
  const css = anchored ? cssOf(anchored.annotation.target) : null;
  if (css && anchored?.quality !== "detached") {
    const last = css.split(">").pop()?.trim() ?? "";
    const tag = last.startsWith("#") ? "" : last.replace(/[:.[].*$/, "");
    return tag ? labelForTag(tag) : "Element";
  }
  if (anchored?.line != null) return `line ${anchored.line}`;
  // "not found" is a claim about the document; make it only once there IS a
  // document. Before the preview reports its text every thread is `unknown`.
  return anchored?.quality === "detached" ? "anchor not found" : "";
}

/**
 * Memoised because the overlay re-renders on things that change nothing
 * here: it re-measures its anchors on every scroll frame, and a card's
 * height landing re-renders the whole surface. Without this, a scroll would
 * re-render every thread on the file.
 */
export default React.memo(CommentThreadImpl);

function CommentThreadImpl({
  thread,
  anchored,
  active,
  canWrite = true,
  onRequestUpgrade,
  onSelect,
  onReply,
  onSetStatus,
}: {
  thread: Thread;
  /** Where this thread landed after the last re-anchor pass. */
  anchored?: Anchored;
  active: boolean;
  /** False without a subscription: reading a thread stays free, answering it
   * does not. Replying and resolving are both writes. */
  canWrite?: boolean;
  onRequestUpgrade?: () => void;
  onSelect: () => void;
  onReply: (body: string) => void;
  onSetStatus: (status: "open" | "addressed" | "wontfix") => void;
}): React.ReactElement {
  const [replying, setReplying] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const { root, replies } = thread;
  // Only a real placing failure greys the card and claims the text is gone.
  // `unknown` (no document read yet) must not, or every comment on every file
  // announces data loss the moment it is opened.
  const detached = anchored?.quality === "detached";
  const resolved = root.status !== "open";

  const submit = (): void => {
    const body = draft.trim();
    if (!body) return;
    onReply(body);
    setDraft("");
    setReplying(false);
  };

  return (
    <article
      className={
        "comment-thread" +
        (active ? " comment-thread-active" : "") +
        (resolved ? " comment-thread-resolved" : "") +
        (detached ? " comment-thread-detached" : "")
      }
      aria-current={active ? "true" : undefined}
    >
      {/* The whole card scrolls the document to the anchor. A button rather
          than a click handler on the article so it is reachable by keyboard
          and announced as an action. */}
      <button type="button" className="comment-thread-jump" onClick={onSelect}>
        <span className="comment-author">{authorOf(root)}</span>
        <span className="comment-time" title={root.created}>
          {shortTime(root.created)}
        </span>
        <span className="comment-anchor">{anchorLabel(anchored)}</span>
      </button>

      {detached && (
        // Never silently dropped. The user wrote this; they decide whether it
        // still matters now that the text it pointed at is gone.
        <p className="comment-detached-note">
          The text this comment pointed at is no longer in the file.
        </p>
      )}

      {root.body ? (
        <p className="comment-body">{root.body.value}</p>
      ) : (
        <p className="comment-body comment-body-empty">Highlight</p>
      )}

      {replies.map((r) => (
        <div className="comment-reply" key={r.id}>
          <CornerDownRight size={13} strokeWidth={1.8} aria-hidden />
          <div>
            <span className="comment-author">{authorOf(r)}</span>
            <span className="comment-time" title={r.created}>
              {shortTime(r.created)}
            </span>
            <p className="comment-body">{r.body?.value ?? ""}</p>
          </div>
        </div>
      ))}

      <div className="comment-actions">
        {!canWrite ? (
          <button
            type="button"
            className="comment-action"
            onClick={() => onRequestUpgrade?.()}
          >
            Subscribe to reply
          </button>
        ) : resolved ? (
          <button type="button" className="comment-action" onClick={() => onSetStatus("open")}>
            <RotateCcw size={13} strokeWidth={1.8} aria-hidden />
            Reopen
          </button>
        ) : (
          <button
            type="button"
            className="comment-action"
            onClick={() => onSetStatus("addressed")}
          >
            <Check size={13} strokeWidth={1.8} aria-hidden />
            Resolve
          </button>
        )}
        {canWrite && (
          <button type="button" className="comment-action" onClick={() => setReplying((v) => !v)}>
            Reply
          </button>
        )}
        {resolved && <span className="comment-status">{statusLabel(root.status)}</span>}
      </div>

      {replying && (
        <div className="comment-composer">
          <textarea
            className="comment-input"
            value={draft}
            autoFocus
            rows={2}
            placeholder="Reply…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // ⌘↵ sends, ↵ makes a newline: a review comment is often more
              // than one line, and losing a paragraph to a stray Enter is
              // the kind of thing that stops people commenting at all.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setReplying(false);
              }
            }}
          />
          <button type="button" className="comment-send" onClick={submit} disabled={!draft.trim()}>
            Send
          </button>
        </div>
      )}
    </article>
  );
}

function statusLabel(status: Annotation["status"]): string {
  return status === "addressed" ? "Addressed" : status === "wontfix" ? "Won't fix" : "";
}
