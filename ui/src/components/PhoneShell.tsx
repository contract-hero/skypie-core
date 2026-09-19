// PhoneShell — the iOS layout. One column: a slim title band, the artifact
// full-bleed, and a bottom bar at the thumb. The desktop's sidebar / tab
// strip / toolbar stack never mounts here; Library (Remote + Received) and
// the open-tab list are bottom sheets summoned from the bar and dismissed
// by the scrim. Same tokens, same components inside the sheets — the phone
// changes the architecture, not the language. A tab pulled from a paired
// Mac says so under its title: the phone has no toolbar to wear a badge.
import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  LibraryBig,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import type { IpcSurface } from "../ipc";
import TabView from "./TabView";
import PhoneSheet from "./PhoneSheet";
import PhonePieSheet from "./PhonePieSheet";
import ReceivedDrawer from "./ReceivedDrawer";
import { useActiveTab, useTabs, useTabsDispatch } from "../state/TabsProvider";
import type { OpenFileOptions } from "../state/TabsProvider";
import { useRemoteActions } from "../state/remote";
import { IosPiesProvider } from "../state/ios-pies-context";
import { canGoBack, canGoForward, currentEntry } from "../state/tabs";
import { basename } from "../utils/path";
import { parseRemoteAddress } from "../utils/remote-address";
import CommentRail from "./CommentRail";
import { useAnnotations } from "../state/annotations-context";
import { readBridgeMessage } from "../annotations/bridge";
import type { PendingSelection } from "../annotations/bridge";
import type { Anchored } from "../annotations/anchor";
import { revealAnchor } from "../annotations/locate";
import { useCommentTool } from "../hooks/useCommentTool";

export interface PhoneShellProps {
  ipc: IpcSurface;
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
  onOpenSettings: () => void;
  onPickFile: () => void;
  onPickWorkspace: () => void;
  workspaceRoot: string | null;
}

/** Exactly one sheet is open at a time, and this is the only thing that
 *  says which — `PhoneSheet` owns the one scrim beneath it. The Sky band's
 *  pie sheet is a MEMBER of this union rather than a second piece of state
 *  beside it: as two states mirrored by an effect, opening Library while a
 *  pie sheet was up could stack two sheets and two scrims, and every
 *  open-a-sheet path had to remember to reset the other one by hand. A
 *  union makes that unrepresentable — one `setSheet` closes whatever was
 *  open, whichever kind it was. The open pie is carried by ID, never as a
 *  snapshotted `DerivedPie`; `PhonePieSheet` looks it up fresh, so a beam
 *  landing while the sheet is open updates its rows with no re-tap. */
type Sheet = null | "library" | "tabs" | "comments" | { kind: "pie"; id: string };

export default function PhoneShell({
  ipc,
  onOpenFile,
  onOpenSettings,
  onPickFile,
  onPickWorkspace,
  workspaceRoot,
}: PhoneShellProps): React.ReactElement {
  const { tabs, activeTabId } = useTabs();
  const dispatch = useTabsDispatch();
  const active = useActiveTab();
  const entry = currentEntry(active);
  const [sheet, setSheet] = React.useState<Sheet>(null);

  // The band's own selection mark, and the id `PhonePieSheet` resolves.
  const openPieId = typeof sheet === "object" && sheet !== null ? sheet.id : null;
  const openPie = React.useCallback((id: string) => setSheet({ kind: "pie", id }), []);

  const closeSheet = React.useCallback(() => setSheet(null), []);

  // The three toggle buttons below all want the same "open this, or close it
  // if it's already open" shape. Assigning over `sheet` is what drops a live
  // pie sheet — there is nothing else to reset.
  const toggleSheet = React.useCallback((kind: "library" | "tabs" | "comments") => {
    setSheet((s) => (s === kind ? null : kind));
  }, []);

  const [renderedText, setRenderedText] = React.useState("");
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const { openCountFor } = useAnnotations();

  const activePath = entry?.path ?? null;
  // `basename` also does the right thing for a `skypie-remote://<peer>/abs/path`
  // address: its strip is greedy, so what survives is the host-side filename.
  const title = activePath ? basename(activePath) : null;
  const { deviceLabel } = useRemoteActions();
  const remote = activePath ? parseRemoteAddress(activePath) : null;
  const from = remote ? deviceLabel(remote.peer) : null;

  const openSheet = React.useCallback(() => setSheet("comments"), []);

  // The tool's rules are shared with the desktop shell — see the hook. On a
  // phone a rail cannot sit beside the document, so the pick IS the entry
  // point: it opens the sheet straight at the composer, with no second tap.
  const {
    on: tool,
    setOn: setTool,
    isFrame,
    docText,
    pending,
    setPending,
    onToolClick,
  } = useCommentTool({
    containerRef: contentRef,
    path: activePath,
    payload: active.payload,
    renderedText,
    onPick: openSheet,
  });

  const openComments = React.useCallback(
    (sel: PendingSelection | null, text: string) => {
      if (sel) setPending(sel);
      if (text) setRenderedText(text);
      setSheet("comments");
    },
    [setPending],
  );

  // A pick inside the artifact opens the comments sheet straight at the
  // composer. On a phone a rail cannot sit beside the document, so the pick
  // IS the entry point — there is no second tap to find it.
  React.useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      // Same adapter the desktop shell uses — see `annotations/bridge`.
      const got = readBridgeMessage(e.data);
      if (got === null || "located" in got) return;
      // The load-time text report has no target: record the text so the
      // file's existing comments can re-anchor, but do not open the sheet.
      if (!("pending" in got)) {
        setRenderedText(got.text);
        return;
      }
      openComments(got.pending, got.text);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openComments]);

  // A thread tapped in the sheet: dismiss it and show the anchor.
  const showAnchor = React.useCallback(
    (anchored: Anchored) => revealAnchor(contentRef.current, anchored, isFrame),
    [isFrame],
  );

  // Switching files drops the text the last document reported. The hook
  // drops the half-made comment on the same change.
  React.useEffect(() => {
    setRenderedText("");
  }, [activePath]);

  const openCount = activePath ? openCountFor(activePath) : 0;

  const openFromSheet = React.useCallback(
    (path: string, opts?: OpenFileOptions) => {
      onOpenFile(path, opts);
      closeSheet();
    },
    [onOpenFile, closeSheet],
  );

  return (
    // M6: `IosPiesProvider` wraps this file's own tree and NEVER App.tsx's
    // ProviderShell, which mounts on macOS too. This component consumes
    // nothing from it — the band reads it through `IosStartPage.tsx` and
    // the sheet through `PhonePieSheet.tsx`, both descendants — so there is
    // no "a component cannot consume the context it provides" split here.
    <IosPiesProvider ipc={ipc}>
      <div className="phone-shell">
        <header className="phone-titlebar">
          <span className={"phone-title" + (title ? "" : " phone-title-brand")}>
            {title ?? "Sky Pie"}
          </span>
          {from ? <span className="phone-title-from">from {from}</span> : null}
        </header>

        <div
          ref={contentRef}
          className={"phone-content" + (tool && !isFrame ? " comment-tool-on" : "")}
          id="tab-panel"
          role="tabpanel"
          aria-labelledby={`tab-${active.id}`}
          onClickCapture={onToolClick}
        >
          {/* `onOpenPie`/`openPieId` are forwarded down to `IosStartPage`'s
              Sky band (through `TabView` and `StartPage`, which only pass
              them on). The band cannot reach `sheet` any other way: it is
              mounted inside the empty tab, not by this file. */}
          <TabView
            onOpenFile={onOpenFile}
            onPickFile={onPickFile}
            onPickWorkspace={onPickWorkspace}
            workspaceRoot={workspaceRoot}
            onOpenSettings={onOpenSettings}
            onOpenPie={openPie}
            openPieId={openPieId}
          />
        </div>

        <nav className="phone-bar" aria-label="Reader controls">
          <button
            type="button"
            className="phone-bar-button"
            aria-label="Library"
            onClick={() => toggleSheet("library")}
          >
            <LibraryBig size={20} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="phone-bar-button"
            aria-label="Back"
            disabled={!canGoBack(active)}
            onClick={() => dispatch({ type: "GO_BACK" })}
          >
            <ChevronLeft size={22} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="phone-bar-button"
            aria-label="Forward"
            disabled={!canGoForward(active)}
            onClick={() => dispatch({ type: "GO_FORWARD" })}
          >
            <ChevronRight size={22} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="phone-bar-button"
            aria-label={
              openCount > 0 ? `Comments (${openCount} open)` : "Comments"
            }
            disabled={!activePath}
            onClick={() => toggleSheet("comments")}
          >
            <MessageSquare size={20} strokeWidth={1.8} />
            {openCount > 0 ? <span className="phone-bar-badge">{openCount}</span> : null}
          </button>
          <button
            type="button"
            className={"phone-bar-button" + (tool ? " phone-bar-button-tool" : "")}
            aria-label={tool ? "Put the comment tool down" : "Comment tool"}
            aria-pressed={tool}
            disabled={!activePath}
            onClick={() => setTool((v) => !v)}
          >
            <MessageSquarePlus size={20} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="phone-bar-button"
            aria-label={`Open tabs (${tabs.length})`}
            onClick={() => toggleSheet("tabs")}
          >
            <span className="phone-tab-count">{tabs.length}</span>
          </button>
        </nav>

        {sheet === "library" ? (
          <PhoneSheet
            label="Library"
            title="Library"
            onClose={closeSheet}
            actions={
              <button
                type="button"
                className="phone-sheet-action"
                aria-label="Settings"
                onClick={() => {
                  closeSheet();
                  onOpenSettings();
                }}
              >
                <SettingsIcon size={17} strokeWidth={1.8} />
              </button>
            }
          >
            <ReceivedDrawer onOpen={closeSheet} />
          </PhoneSheet>
        ) : null}

        {sheet === "comments" ? (
          <PhoneSheet label="Comments" title="Comments" tall onClose={closeSheet}>
            <CommentRail
              text={docText}
              contentHash={null}
              pending={pending}
              onClearPending={() => setPending(null)}
              // The phone has no rail beside the document to scroll INTO, so
              // selecting a thread dismisses the sheet and shows the anchor.
              onSelectAnchor={(anchored) => {
                showAnchor(anchored);
                closeSheet();
              }}
            />
          </PhoneSheet>
        ) : null}

        {sheet === "tabs" ? (
          <PhoneSheet
            label="Open tabs"
            title="Tabs"
            onClose={closeSheet}
            actions={
              <button
                type="button"
                className="phone-sheet-action"
                aria-label="New tab"
                onClick={() => {
                  dispatch({ type: "OPEN_NEW_TAB" });
                  closeSheet();
                }}
              >
                <Plus size={17} strokeWidth={1.8} />
              </button>
            }
          >
            <ul className="phone-tab-list">
              {tabs.map((tab) => {
                const tabEntry = currentEntry(tab);
                const label = tabEntry ? basename(tabEntry.path) : "New tab";
                return (
                  <li
                    key={tab.id}
                    className={
                      "phone-tab-row" + (tab.id === activeTabId ? " is-active" : "")
                    }
                  >
                    <button
                      type="button"
                      className="phone-tab-row-label"
                      onClick={() => {
                        dispatch({ type: "ACTIVATE_TAB", tabId: tab.id });
                        closeSheet();
                      }}
                    >
                      <span className="phone-tab-row-name">{label}</span>
                      {tabEntry ? (
                        <span className="phone-tab-row-path">{tabEntry.path}</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="phone-sheet-action"
                      aria-label={`Close ${label}`}
                      onClick={() => dispatch({ type: "CLOSE_TAB", tabId: tab.id })}
                    >
                      <X size={15} strokeWidth={1.8} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </PhoneSheet>
        ) : null}

        {/* M6: the Sky band's own pie sheet. It resolves `pieId` against the
            provider's live list on every render, so a beam landing while it
            is open updates its rows without a re-tap — and it renders
            nothing at all once that pie is gone. */}
        {openPieId !== null ? <PhonePieSheet pieId={openPieId} onClose={closeSheet} /> : null}
      </div>
    </IosPiesProvider>
  );
}
