// The comment tool — the rules both shells obey.
//
// The tool is a mode: while it is in hand, a click on a line, a Markdown
// block, an element or a spot on an image is a comment, not a navigation.
// The desktop shell and the phone shell each render their own button and
// their own surface for the result, but everything between the click and the
// pending target is the same on both, and was copied between them until this
// hook existed. `bridge.ts` was extracted for exactly this reason one layer
// down; this is that lesson applied to the layer above it.
//
// What the caller still owns: where the button lives, what the target opens
// (a margin note on the desktop, a bottom sheet on the phone), and whether
// picking up the tool should also reveal the threads.

import * as React from "react";
import { onPreviewLoad, setToolInPreview } from "../annotations/bridge";
import type { PendingSelection } from "../annotations/bridge";
import { pendingForPick, pickInHost } from "../annotations/locate";
import type { TabContent } from "../state/tabs";
import { isHtmlPath } from "../render/router";

export interface CommentTool {
  /** True while the tool is in hand. */
  on: boolean;
  setOn: React.Dispatch<React.SetStateAction<boolean>>;
  /** True when the document is an HTML artifact, which renders in a frame. */
  isFrame: boolean;
  /** What a comment on this document quotes and re-anchors against. */
  docText: string;
  /** The target waiting for a comment body, or null. */
  pending: PendingSelection | null;
  setPending: React.Dispatch<React.SetStateAction<PendingSelection | null>>;
  /** Attach to the element wrapping the document, as `onClickCapture`. */
  onToolClick: (e: React.MouseEvent<HTMLElement>) => void;
}

export interface CommentToolOptions {
  /** The element wrapping the rendered document. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** The active tab's path, or null. Switching it drops a half-made comment. */
  path: string | null;
  /** The active tab's payload, for the source text of a host-rendered file. */
  payload: TabContent;
  /**
   * The rendered text an HTML artifact reported. Only a frame can read it,
   * so it arrives over the bridge rather than from the payload.
   */
  renderedText: string;
  /** Called when a pick lands, after the target is set. */
  onPick?: () => void;
}

/**
 * The text a comment on this document quotes.
 *
 * An HTML artifact answers with what it RENDERED, which only the frame can
 * see; everything the host renders is anchored to its source, which is what
 * a line number in a stored comment means. An image has neither.
 */
export function sourceTextOf(payload: CommentToolOptions["payload"]): string {
  if (!payload || !("content" in payload)) return "";
  if (payload.is_binary || payload.encoding === "base64") return "";
  return payload.content ?? "";
}

export function useCommentTool({
  containerRef,
  path,
  payload,
  renderedText,
  onPick,
}: CommentToolOptions): CommentTool {
  const [on, setOn] = React.useState(false);
  const [pending, setPending] = React.useState<PendingSelection | null>(null);

  const isFrame = Boolean(path && isHtmlPath(path));
  const docText = isFrame ? renderedText : sourceTextOf(payload);

  // The tool inside the frame follows the tool out here — and follows it
  // again on every reload of the frame, which starts with the tool off.
  React.useEffect(() => {
    if (!isFrame) return;
    return onPreviewLoad(() => setToolInPreview(on));
  }, [on, isFrame, path]);

  // Switching files drops a half-made comment: it belongs to the document
  // that was open.
  React.useEffect(() => {
    setPending(null);
  }, [path]);

  // The tool over the host DOM. Capture phase, so a link inside the block
  // that was clicked is a comment on the block, not a navigation.
  const onToolClick = React.useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!on || isFrame) return;
      const container = containerRef.current;
      const target = e.target as Element | null;
      if (!container || !target) return;
      // The notes float over the document; a click on one is not a pick.
      if (target.closest(".comment-overlay")) return;
      e.preventDefault();
      e.stopPropagation();
      const pick = pickInHost(container, target, e.clientX, e.clientY);
      if (!pick) return;
      const next = pendingForPick(pick, docText);
      if (!next) return;
      setPending(next);
      onPick?.();
    },
    [on, isFrame, docText, containerRef, onPick],
  );

  return { on, setOn, isFrame, docText, pending, setPending, onToolClick };
}
