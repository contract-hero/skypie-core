// Toolbar — browser-style navigation row above the preview: back/forward/
// reload, an editable address bar showing the active tab's path, bookmark
// star, copy-path, the Share menu, the provenance badge, and zoom controls.
import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  MessageSquare,
  MessageSquarePlus,
  PanelLeft,
  RotateCw,
  Star,
} from "lucide-react";
import { useActiveTab, useTabsDispatch } from "../state/TabsProvider";
import { canGoBack, canGoForward, currentEntry } from "../state/tabs";
import { useBookmarksContext } from "../state/bookmarks-context";
import { useWorkspace } from "../state/workspace";
import { useBeamActions } from "../state/beam";
import { usePlatform } from "../state/platform";
import { BeamIndicator } from "./BeamDialog";
import ShareMenu from "./ShareMenu";
import { useRemoteActions } from "../state/remote";
import { displayPath, normalizePathBarInput } from "../utils/path";
import { slackUrlFromTarget } from "../utils/slack";
import { tabBadge } from "../utils/tab-badge";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { useSettings } from "../hooks/useSettings";
import { tauriIpc } from "../ipc";

export interface ToolbarProps {
  addressBarRef: React.MutableRefObject<HTMLInputElement | null>;
  onSubmitPath: (path: string) => void;
  /**
   * Whether the sidebar is currently shown. Picks the toggle button's title
   * and aria-label only — the button carries no pressed state.
   */
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  /** Whether the Sky band is shown. */
  skyVisible: boolean;
  onToggleSky: () => void;
  onEnterReaderMode: () => void;
  /** Whether the margin notes are shown (⇧⌘M). */
  commentsVisible: boolean;
  onToggleComments: () => void;
  /** Whether the comment tool is picked up (⇧⌘K): clicks make comments. */
  commentTool: boolean;
  onToggleCommentTool: () => void;
  /** Open threads on the active file, for the badge. */
  openComments: number;
}

function IconButton({
  title,
  label,
  disabled,
  pressed,
  testId,
  onClick,
  children,
}: {
  title: string;
  /** Accessible name, when it differs from the tooltip — a toggle's title
   *  names the shortcut, its label names the action. Defaults to `title`. */
  label?: string;
  disabled?: boolean;
  /** A toggle button: renders `aria-pressed` and the pressed-state class.
   *  Left undefined for a plain action button, which has no pressed state
   *  and must not advertise one. */
  pressed?: boolean;
  testId?: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`toolbar-button${pressed ? " toolbar-button-pressed" : ""}`}
      title={title}
      aria-label={label ?? title}
      aria-pressed={pressed}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A hairline circle with one wedge lifted 1px along its bisector — the
 *  tile's own glyph, not from lucide (spec section 2). No fill on the
 *  circle: the wedge is the only filled shape, currentColor throughout so
 *  it follows the button's own hover/pressed color like every other
 *  toolbar glyph. */
function SkyGlyph(): React.ReactElement {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M 8 8 L 8 2 A 6 6 0 0 1 14 8 Z" fill="currentColor" transform="translate(0.7 -0.7)" />
    </svg>
  );
}

function CopyPathButton({ path }: { path: string }): React.ReactElement {
  const { copied, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      className="toolbar-button"
      data-testid="preview-copy-path"
      title={copied ? "Copied!" : "Copy path"}
      aria-label="Copy file path"
      onClick={() => copy(path)}
    >
      {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={2} />}
    </button>
  );
}

export default function Toolbar({
  addressBarRef,
  onSubmitPath,
  sidebarVisible,
  onToggleSidebar,
  skyVisible,
  onToggleSky,
  onEnterReaderMode,
  commentsVisible,
  onToggleComments,
  commentTool,
  onToggleCommentTool,
  openComments,
}: ToolbarProps): React.ReactElement {
  const tab = useActiveTab();
  const dispatch = useTabsDispatch();
  const { root } = useWorkspace();
  const { receivedDir } = useBeamActions();
  const { deviceLabel } = useRemoteActions();
  const { isBookmarked, toggle } = useBookmarksContext();
  // Sharing is a macOS/desktop affordance (PRODUCT.md: iOS is a read-only
  // companion that owns no files to hand off).
  const { isMacos } = usePlatform();
  // One settings subscription for the toolbar; the Slack affordance stays
  // hidden until a target is configured.
  const { state: settings } = useSettings(tauriIpc);
  const slackTarget = settings?.preferences?.slack_target;
  const slackUrl = isMacos && slackTarget ? slackUrlFromTarget(slackTarget) : null;

  const entry = currentEntry(tab);
  const currentPath = entry?.path ?? "";

  // The input is controlled locally; it resyncs to the tab's path whenever
  // the tab or its current entry changes, and tracks user edits in between.
  const [draft, setDraft] = React.useState(currentPath);
  const [editing, setEditing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!editing) {
      setDraft(currentPath);
      setError(null);
    }
  }, [currentPath, tab.id, editing]);

  const submit = () => {
    const result = normalizePathBarInput(draft);
    if (result.kind === "error") {
      setError(result.reason);
      return;
    }
    setError(null);
    setEditing(false);
    onSubmitPath(result.path);
    addressBarRef.current?.blur();
  };

  const bookmarked = entry ? isBookmarked(entry.path) : false;
  const zoomPct = Math.round(tab.zoom * 100);

  return (
    <div className="toolbar">
      <IconButton
        title={sidebarVisible ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
        onClick={onToggleSidebar}
      >
        <PanelLeft size={14.5} strokeWidth={2} />
      </IconButton>

      {/* No right-click menu in M1 ("Add current file to pie…" is M2). */}
      <IconButton
        title="Sky (⌘⇧B)"
        label={skyVisible ? "Hide sky" : "Show sky"}
        pressed={skyVisible}
        testId="toolbar-sky-toggle"
        onClick={onToggleSky}
      >
        <SkyGlyph />
      </IconButton>

      <span className="toolbar-sep" aria-hidden />

      <IconButton
        title="Back (⌘[)"
        disabled={!canGoBack(tab)}
        onClick={() => dispatch({ type: "GO_BACK" })}
      >
        <ArrowLeft size={15} strokeWidth={2} />
      </IconButton>
      <IconButton
        title="Forward (⌘])"
        disabled={!canGoForward(tab)}
        onClick={() => dispatch({ type: "GO_FORWARD" })}
      >
        <ArrowRight size={15} strokeWidth={2} />
      </IconButton>
      <IconButton
        title="Reload this file (⌘R)"
        disabled={!entry}
        onClick={() => dispatch({ type: "RELOAD" })}
      >
        <RotateCw size={13.5} strokeWidth={2} />
      </IconButton>

      <span className="toolbar-sep" aria-hidden />

      <div className="address-bar" data-error={error ? "true" : undefined}>
        <input
          ref={addressBarRef}
          type="text"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Enter a file path, file:// or skypie:// URL  (⌘L)"
          // Idle, the bar shows the workspace-relative path — the absolute
          // prefix is the same on every row and says nothing. Focus swaps in
          // the full path (draft) for editing and selects it, so the swap is
          // never mistaken for a caret jump.
          value={editing ? draft : displayPath(currentPath, root)}
          data-testid="path-bar-input"
          onFocus={(e) => {
            setEditing(true);
            // Select after the value swaps from relative to absolute (next
            // commit), not the soon-to-be-replaced display text.
            const input = e.currentTarget;
            window.setTimeout(() => input.select(), 0);
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(currentPath);
              setError(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {error ? (
          <span className="address-bar-error" role="alert">
            {error}
          </span>
        ) : null}
        {entry
          ? (() => {
              const badge = tabBadge(entry.path, entry.external, receivedDir, deviceLabel);
              return badge ? (
                <span
                  className="preview-badge-external"
                  data-testid={`preview-${badge.kind}-badge`}
                  title={badge.title}
                >
                  {badge.label}
                </span>
              ) : null;
            })()
          : null}
        {/* The zoom chip lives INSIDE the address bar so that showing it
            shrinks the input instead of pushing the whole action cluster
            left every time you press ⌘+. */}
        {zoomPct !== 100 ? (
          <button
            type="button"
            className="toolbar-zoom"
            title="Reset zoom (⌘0)"
            aria-label={`Zoom ${zoomPct} percent. Reset zoom`}
            onClick={() => dispatch({ type: "SET_ZOOM", tabId: tab.id, zoom: 1 })}
          >
            {zoomPct}%
          </button>
        ) : null}
      </div>

      {entry ? (
        <>
          <button
            type="button"
            className={`toolbar-button${bookmarked ? " star-active" : ""}`}
            data-testid="preview-bookmark-toggle"
            title={bookmarked ? "Remove bookmark" : "Bookmark this file"}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark this file"}
            aria-pressed={bookmarked}
            onClick={() => void toggle(entry.path)}
          >
            <Star size={13.5} strokeWidth={2} fill={bookmarked ? "currentColor" : "none"} />
          </button>
          {/* Keep (star) and hand over (copy / share) are different jobs;
              the rule between them is the grouping cue. */}
          <span className="toolbar-sep" aria-hidden />
          <CopyPathButton path={entry.path} />
          {isMacos ? <ShareMenu path={entry.path} ipc={tauriIpc} slackUrl={slackUrl} /> : null}
        </>
      ) : null}

      <BeamIndicator />

      <span className="toolbar-sep" aria-hidden />

      {/* Feedback is its own job: see the notes, and make one. The two sit
          together, and the tool lights up while it is in hand — the one
          object the app is acting on, which is the accent's marker role. */}
      <IconButton
        title={commentsVisible ? "Hide comments (⇧⌘M)" : "Show comments (⇧⌘M)"}
        label={commentsVisible ? "Hide comments" : "Show comments"}
        pressed={commentsVisible}
        testId="toolbar-comments-toggle"
        disabled={!entry}
        onClick={onToggleComments}
      >
        <MessageSquare size={14} strokeWidth={2} />
        {openComments > 0 ? (
          <span className="toolbar-badge" aria-label={`${openComments} open`}>
            {openComments > 99 ? "99+" : openComments}
          </span>
        ) : null}
      </IconButton>
      <button
        type="button"
        className={`toolbar-button${commentTool ? " toolbar-button-tool" : ""}`}
        data-testid="toolbar-comment-tool"
        title={commentTool ? "Put the comment tool down (Esc)" : "Comment tool (⇧⌘K): click a line, block or image"}
        aria-label={commentTool ? "Put the comment tool down" : "Comment tool"}
        aria-pressed={commentTool}
        disabled={!entry}
        onClick={onToggleCommentTool}
      >
        <MessageSquarePlus size={14.5} strokeWidth={2} />
      </button>

      <span className="toolbar-sep" aria-hidden />

      <IconButton
        title="Reader mode (⇧⌘F — Esc to leave)"
        onClick={onEnterReaderMode}
      >
        <BookOpen size={14} strokeWidth={2} />
      </IconButton>
    </div>
  );
}
