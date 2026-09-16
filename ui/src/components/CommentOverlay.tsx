// CommentOverlay — the desktop's comments, as margin notes.
//
// Each thread is a card floating over the right edge of the preview, level
// with the line or element it is about, the way a note sits in the margin of
// a printed draft. The document does not reflow around them: the artifact is
// the protagonist and the notes are pencil in its margin. Cards that would
// collide are pushed apart (`layoutNotes`); the ACTIVE card — the one being
// read or answered — keeps its place and its neighbours give way.
//
// Positions come from two sources. Markdown, code and images render into the
// host DOM, so this component measures them directly (`locateInHost`). An
// HTML artifact renders in a sandboxed frame the host cannot read, so the
// frame is handed the anchors and reports where they are, again on every
// scroll (`locateInPreview` / `skypie:located`). Either way the answer is a
// top per anchor in this overlay's own coordinates.
//
// The overlay reads the provider and asks it to write, like the rail: a
// comment made here, one pushed by a paired phone and a thread an agent
// resolved through the MCP tool all arrive through the same broadcast.

import * as React from "react";
import type { Anchored } from "../annotations/anchor";
import {
  clearAnchorInPreview,
  locateInPreview,
  onPreviewLoad,
  readBridgeMessage,
  showAnchorInPreview,
} from "../annotations/bridge";
import type { PendingSelection } from "../annotations/bridge";
import { layoutNotes } from "../annotations/layout";
import { locateInHost, revealAnchor } from "../annotations/locate";
import type { LocatableAnchor } from "../annotations/locate";
import { isOpen, lineOf, toThreads } from "../annotations/types";
import type { Thread } from "../annotations/types";
import { useAnnotations } from "../state/annotations-context";
import CommentComposer from "./CommentComposer";
import { paywallVisible, railOrder } from "./CommentRail";
import CommentThread, { anchorLabel, authorOf, shortTime } from "./CommentThread";
import Paywall from "./Paywall";

/** The id the pending composer is located under, beside the real threads. */
const PENDING_ID = "pending";

/** Anchor id → its top in overlay coordinates. Absent = not on this page. */
type Tops = Map<string, number>;

/**
 * Where one card sits.
 *
 * `translateY`, not `top`: the layout is re-targeted on every scroll frame,
 * and `top` is a layout property — each write costs a reflow of the whole
 * overlay, and a transition on it never settles because the next frame moves
 * the target again. A transform is composited and tracks the document exactly.
 */
function noteStyle(top: number | undefined): React.CSSProperties | undefined {
  return top === undefined ? undefined : { transform: `translateY(${Math.round(top)}px)` };
}

/** Equal maps mean no re-render: the measure runs on every scroll frame. */
function sameTops(a: Tops, b: Tops): boolean {
  if (a.size !== b.size) return false;
  for (const [id, top] of b) if (a.get(id) !== top) return false;
  return true;
}

export interface CommentOverlayProps {
  /** The element the overlay is positioned within: the tab view. */
  containerRef: React.RefObject<HTMLElement>;
  /** True when the document is an HTML artifact in a frame. */
  isFrame: boolean;
  /** The document's current text, for re-anchoring. Empty for an image. */
  text: string;
  contentHash: string | null;
  pending: PendingSelection | null;
  onClearPending: () => void;
  activeId: string | null;
  onActivate: (id: string | null) => void;
}

interface Placed {
  thread: Thread;
  anchored: Anchored;
}

/**
 * A card's measured height, kept in a map the layout reads.
 *
 * The ref callback for a card is created ONCE per id and reused: a fresh
 * callback every render makes React detach and re-attach the ref on every
 * commit, and a state update from inside that attach — even one that
 * resolves to the same value — re-renders, which mints a fresh callback,
 * which re-attaches. That was an update loop that blacked out the window.
 * Heights are read only from the ResizeObserver, never synchronously in
 * the attach.
 *
 * A detach must therefore NOT drop the cached callback. A card detaches on
 * an ordinary path — moving from the unplaced stack to a placed note is a
 * different parent, so React remounts the host element — and dropping the
 * cache there means the next render mints a new callback, which detaches
 * again, which drops the cache again: the same loop, reached from the code
 * meant to bound the map's growth. Ids are pruned by `forget` instead, from
 * the caller, which is the only place that knows an id is gone for good.
 */
interface Heights {
  heights: Map<string, number>;
  bind: (id: string) => (el: HTMLElement | null) => void;
  forget: (live: Set<string>) => void;
}

function useHeights(): Heights {
  const [heights, setHeights] = React.useState<Map<string, number>>(new Map());
  const callbacks = React.useRef(new Map<string, (el: HTMLElement | null) => void>());
  const observers = React.useRef(new Map<string, ResizeObserver>());
  const bind = React.useCallback((id: string) => {
    let cb = callbacks.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        observers.current.get(id)?.disconnect();
        observers.current.delete(id);
        if (!el) return;
        const ro = new ResizeObserver(() => {
          const h = el.offsetHeight;
          setHeights((m) => (m.get(id) === h ? m : new Map(m).set(id, h)));
        });
        ro.observe(el);
        observers.current.set(id, ro);
      };
      callbacks.current.set(id, cb);
    }
    return cb;
  }, []);
  const forget = React.useCallback((live: Set<string>) => {
    for (const id of Array.from(callbacks.current.keys())) {
      if (live.has(id)) continue;
      callbacks.current.delete(id);
      observers.current.get(id)?.disconnect();
      observers.current.delete(id);
    }
    setHeights((m) => {
      let next: Map<string, number> | null = null;
      for (const id of m.keys()) {
        if (live.has(id)) continue;
        next = next ?? new Map(m);
        next.delete(id);
      }
      return next ?? m;
    });
  }, []);
  React.useEffect(() => {
    const all = observers.current;
    return () => {
      for (const ro of all.values()) ro.disconnect();
    };
  }, []);
  return { heights, bind, forget };
}

export default function CommentOverlay({
  containerRef,
  isFrame,
  text,
  contentHash,
  pending,
  onClearPending,
  activeId,
  onActivate,
}: CommentOverlayProps): React.ReactElement {
  const {
    annotations,
    addComment,
    reply,
    setStatus,
    canWrite,
    blocked,
    requestUpgrade,
    dismissBlocked,
    error,
  } = useAnnotations();
  const overlayRef = React.useRef<HTMLDivElement | null>(null);
  const [showResolved, setShowResolved] = React.useState(false);
  const [hoverId, setHoverId] = React.useState<string | null>(null);

  const rows = React.useMemo<Placed[]>(
    () => railOrder(toThreads(annotations), text, contentHash),
    [annotations, text, contentHash],
  );
  // One pass, not three: this runs on every re-render of the surface, which
  // on the desktop is every scroll frame that moves an anchor.
  const { visible, resolvedCount } = React.useMemo(() => {
    const open = rows.filter((r) => isOpen(r.thread));
    return { visible: showResolved ? rows : open, resolvedCount: rows.length - open.length };
  }, [rows, showResolved]);

  // ── Where each anchor is ─────────────────────────────────────────────
  // `tops` is in overlay coordinates; an absent id means "not on this page".
  const [tops, setTops] = React.useState<Tops>(new Map());

  // The anchors to keep located. The pending target rides along under a
  // fixed id so the composer follows the document like a real card — an id
  // in the same list is all the layout and the measure passes need, so no
  // annotation is synthesised for it.
  const anchors = React.useMemo<LocatableAnchor[]>(() => {
    const out: LocatableAnchor[] = visible.map((r) => ({
      id: r.thread.root.id,
      target: r.thread.root.target,
      line: r.anchored.line,
    }));
    if (pending) {
      const target = { source: "", hash: null, selector: pending.selector };
      out.push({ id: PENDING_ID, target, line: lineOf(target) });
    }
    return out;
  }, [visible, pending]);

  // The measure pass reads this without re-subscribing. The set changes on
  // every comment, every resolve, every pick and every live reload, and
  // re-creating a subtree MutationObserver over the whole document that
  // often is its own performance problem.
  const anchorsRef = React.useRef(anchors);
  anchorsRef.current = anchors;
  /** The live measure pass, so an anchor change can ask for one. */
  const scheduleRef = React.useRef<(() => void) | null>(null);

  const overlayTop = (): number => overlayRef.current?.getBoundingClientRect().top ?? 0;

  // Host DOM: measure now, and again whenever the document scrolls, resizes
  // or mutates (shiki swaps the <pre> in after highlighting; live reload
  // replaces everything). rAF-throttled — one measure per frame.
  React.useEffect(() => {
    if (isFrame) return;
    const container = containerRef.current;
    if (!container) return;
    let scheduled = false;
    const measure = (): void => {
      scheduled = false;
      const base = overlayTop();
      const next: Tops = new Map();
      for (const loc of locateInHost(container, anchorsRef.current)) {
        if (loc.top !== null) next.set(loc.id, loc.top - base);
      }
      setTops((prev) => (sameTops(prev, next) ? prev : next));
    };
    const schedule = (): void => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(measure);
    };
    scheduleRef.current = schedule;
    schedule();
    container.addEventListener("scroll", schedule, true);
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    // The overlay lives inside the container it watches, and it paints the
    // anchor by marking an element of the document. Neither is the document
    // changing, and treating them as such would make every layout schedule
    // the measure that caused it.
    const mo = new MutationObserver((records) => {
      const own = overlayRef.current;
      const ours = records.every(
        (r) =>
          (own && own.contains(r.target)) ||
          (r.type === "attributes" && r.attributeName === "data-comment-anchor"),
      );
      if (ours) return;
      schedule();
    });
    mo.observe(container, { childList: true, subtree: true, attributes: true });
    return () => {
      scheduleRef.current = null;
      container.removeEventListener("scroll", schedule, true);
      ro.disconnect();
      mo.disconnect();
    };
  }, [isFrame, containerRef]);

  // The anchor set changed (a comment landed, the composer opened) — the
  // subscriptions above stay, only the measure re-runs.
  React.useEffect(() => {
    scheduleRef.current?.();
  }, [anchors]);

  // Frame: hand over the refs, read back the positions. The frame reports
  // again on its own scroll and resize, and on load.
  React.useEffect(() => {
    if (!isFrame) return;
    const onMessage = (e: MessageEvent): void => {
      const frame = document.querySelector("iframe");
      // Only the preview frame may say where anchors are. Without this, any
      // window — including artifact content posting to its own parent — can
      // park existing notes beside whatever line it names.
      if (!frame || e.source !== frame.contentWindow) return;
      const got = readBridgeMessage(e.data);
      if (!got || !("located" in got)) return;
      const base = frame.getBoundingClientRect().top - overlayTop();
      const next: Tops = new Map();
      for (const item of got.located) {
        if (item.top !== null) next.set(item.id, item.top + base);
      }
      setTops((prev) => (sameTops(prev, next) ? prev : next));
    };
    window.addEventListener("message", onMessage);
    // A frame that reloads (live reload rewrites the artifact constantly)
    // comes back knowing nothing, so the request is re-sent on every load.
    const stop = onPreviewLoad(() => locateInPreview(anchors));
    return () => {
      window.removeEventListener("message", onMessage);
      stop();
    };
  }, [isFrame, anchors]);

  // ── Painting the anchor under the active or hovered card ─────────────
  const paintId = hoverId ?? (pending ? PENDING_ID : activeId);
  React.useEffect(() => {
    const container = containerRef.current;
    const unpaint = (): void => {
      if (isFrame) {
        clearAnchorInPreview();
        return;
      }
      if (!container) return;
      for (const el of Array.from(container.querySelectorAll("[data-comment-anchor]"))) {
        el.removeAttribute("data-comment-anchor");
      }
    };
    unpaint();
    const anchor = anchors.find((a) => a.id === paintId) ?? null;
    if (isFrame) {
      if (anchor) showAnchorInPreview(anchor, false);
    } else if (container && anchor) {
      locateInHost(container, [anchor])[0]?.element?.setAttribute("data-comment-anchor", "");
    }
    // Hiding the notes (⇧⌘M, reader mode) unmounts the overlay; the paint
    // must go with it, or the box outlives the card it belonged to.
    return unpaint;
  }, [paintId, anchors, isFrame, containerRef]);

  // ── Layout ───────────────────────────────────────────────────────────
  const { heights, bind: bindHeight, forget: forgetHeights } = useHeights();

  // Prune measurements for cards that no longer exist. Driven by the anchor
  // set, not by a detach: a card detaches whenever it moves between the
  // placed and unplaced groups, which is not the same as being gone.
  React.useEffect(() => {
    forgetHeights(new Set(anchors.map((a) => a.id)));
  }, [anchors, forgetHeights]);
  const boxes: { id: string; anchorTop: number; height: number }[] = [];
  const placed: Placed[] = [];
  const unplaced: Placed[] = [];
  for (const row of visible) {
    const id = row.thread.root.id;
    const at = tops.get(id);
    if (at === undefined) {
      unplaced.push(row);
      continue;
    }
    placed.push(row);
    boxes.push({ id, anchorTop: at, height: heights.get(id) ?? 56 });
  }
  const pendingAt = pending ? tops.get(PENDING_ID) : undefined;
  if (pendingAt !== undefined) {
    boxes.push({ id: PENDING_ID, anchorTop: pendingAt, height: heights.get(PENDING_ID) ?? 140 });
  }
  const layout = layoutNotes(boxes, pending ? PENDING_ID : activeId, { gap: 8, minTop: 8 });

  const paywall = paywallVisible(blocked, pending !== null, canWrite);

  const submit = async (body: string): Promise<boolean> => {
    if (!pending) return false;
    const made = await addComment(body, pending.selector);
    if (!made) return false;
    onClearPending();
    onActivate(made.id);
    return true;
  };

  const jump = (row: Placed): void => {
    onActivate(row.thread.root.id);
    revealAnchor(containerRef.current, row.anchored, isFrame, "smooth");
  };

  const renderCard = (row: Placed): React.ReactElement => {
    const id = row.thread.root.id;
    const top = layout.get(id);
    const active = activeId === id;
    return (
      <div
        key={id}
        ref={bindHeight(id)}
        className={
          "comment-note" +
          (active ? " comment-note-active" : "") +
          (top === undefined ? " comment-note-unplaced" : "")
        }
        style={noteStyle(top)}
        onMouseEnter={() => setHoverId(id)}
        onMouseLeave={() => setHoverId((h) => (h === id ? null : h))}
      >
        {active ? (
          <CommentThread
            thread={row.thread}
            anchored={row.anchored}
            active
            onSelect={() => onActivate(null)}
            canWrite={canWrite}
            onRequestUpgrade={requestUpgrade}
            onReply={(body) => void reply(id, body)}
            onSetStatus={(status) => void setStatus(id, status)}
          />
        ) : (
          <CompactNote row={row} onOpen={() => jump(row)} />
        )}
      </div>
    );
  };

  return (
    <div ref={overlayRef} className="comment-overlay" aria-label="Comments">
      {error ? <p className="comment-overlay-error">{error}</p> : null}

      {paywall ? (
        <div className="comment-note comment-note-paywall">
          <Paywall
            onClose={() => {
              dismissBlocked();
              onClearPending();
            }}
          />
        </div>
      ) : null}

      {pending && canWrite ? (
        <div
          ref={bindHeight(PENDING_ID)}
          className={
            "comment-note comment-note-composer" +
            (pendingAt === undefined ? " comment-note-unplaced" : "")
          }
          style={noteStyle(layout.get(PENDING_ID))}
        >
          <CommentComposer pending={pending} onSubmit={submit} onCancel={onClearPending} />
        </div>
      ) : null}

      {unplaced.length > 0 ? (
        <div className="comment-unplaced" aria-label="Comments not placed">
          {unplaced.map(renderCard)}
        </div>
      ) : null}

      {placed.map(renderCard)}

      {resolvedCount > 0 ? (
        <button
          type="button"
          className="comment-overlay-resolved"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? "Hide resolved" : `${resolvedCount} resolved`}
        </button>
      ) : null}
    </div>
  );
}

/** The folded card: who, when, where, and the first line of what. */
function CompactNote({ row, onOpen }: { row: Placed; onOpen: () => void }): React.ReactElement {
  const { root, replies } = row.thread;
  const detached = row.anchored.quality === "detached";
  return (
    <button
      type="button"
      className={"comment-compact" + (root.status !== "open" ? " comment-compact-resolved" : "")}
      onClick={onOpen}
    >
      <span className="comment-compact-head">
        <span className="comment-author">{authorOf(root)}</span>
        <span className="comment-time" title={root.created}>
          {shortTime(root.created)}
        </span>
        <span className="comment-anchor">{anchorLabel(row.anchored)}</span>
      </span>
      <span className="comment-compact-body">
        {detached ? "Anchor not found · " : ""}
        {root.body?.value ?? "Highlight"}
      </span>
      {replies.length > 0 ? (
        <span className="comment-compact-replies">
          {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
        </span>
      ) : null}
    </button>
  );
}
