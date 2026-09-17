// Root app — provider stack + browser-style chrome: TabStrip over
// Toolbar over TabView, with the Explorer sidebar on the left.
import * as React from "react";
import { flushSync } from "react-dom";
import { X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Sidebar from "./components/Sidebar";
import SidebarResizer from "./components/SidebarResizer";
import TabStrip from "./components/TabStrip";
import Toolbar from "./components/Toolbar";
import Sky from "./components/Sky";
import TabView from "./components/TabView";
import PhoneShell from "./components/PhoneShell";
import QuickOpen from "./components/QuickOpen";
import BeamDialog from "./components/BeamDialog";
import RemotePairDialog from "./components/RemotePairDialog";
import SettingsModal from "./components/SettingsModal";
import { tauriIpc } from "./ipc";
import type { IpcSurface } from "./ipc";
import { useDeepLink } from "./hooks/useDeepLink";
import type { OpenFilePayload, DeepLinkErrorPayload } from "./hooks/useDeepLink";
import { useTheme } from "./hooks/useTheme";
import { useE2eBridge } from "./hooks/useE2eBridge";
import { WorkspaceProvider, useWorkspace } from "./state/workspace";
import { WatcherProvider } from "./state/watcher-bus";
import { BookmarksProvider } from "./state/bookmarks-context";
import { PiesProvider, usePiesContext } from "./state/pies-context";
import type { NoticeFn } from "./state/pies-context";
import { RecentsProvider } from "./state/recents-context";
import { ScrollMemoryProvider } from "./state/scroll-memory";
import { ExplorerUiProvider, useExplorerUi } from "./state/explorer-ui";
import { BeamProvider } from "./state/beam";
import { RemoteProvider } from "./state/remote";
import { PlatformProvider, usePlatform } from "./state/platform";
import { ContextMenuProvider } from "./components/ContextMenu";
import { AnnotationsProvider } from "./state/annotations-context";
import CommentOverlay from "./components/CommentOverlay";
import { readBridgeMessage } from "./annotations/bridge";
import type { PendingSelection } from "./annotations/bridge";
import { useAnnotations } from "./state/annotations-context";
import { useCommentTool } from "./hooks/useCommentTool";
import { isUnderRoot } from "./utils/path";
import { deepLinkNotice } from "./utils/deep-link-notice";
import { copyDeviceLink } from "./utils/device-link";
import {
  TabsProvider,
  useActiveTab,
  useTabsDispatch,
  useOpenFile,
} from "./state/TabsProvider";
import { currentEntry, ZOOM_STEP } from "./state/tabs";
import { dispatchChord, useShortcuts } from "./keyboard/shortcuts";
import type { Binding, ChordEvent } from "./keyboard/shortcuts";
import { appBindings, IFRAME_FORWARDABLE } from "./keyboard/app-bindings";
import { hydratePaneVisible } from "./state/panes";

interface AppProps {
  ipc?: IpcSurface;
}

const DEFAULT_SIDEBAR_PX = 280;
const MIN_SIDEBAR_PX = 200;
const MAX_SIDEBAR_PX = 480;

/** How long a transient notice stays up before it dismisses itself. */
const NOTICE_MS = 10000;

function clampSidebarPx(px: number): number {
  return Math.max(MIN_SIDEBAR_PX, Math.min(MAX_SIDEBAR_PX, px));
}

/** An optional inline action the notice offers besides dismissing — so far
 *  only the Sky band's delete-pie undo (Sky.tsx), which is exactly why this
 *  is a plain `{ label, onClick }` and not a whole notice CONTEXT: one
 *  notice, one optional action, is all any caller needs yet. */
export interface AppNoticeAction {
  label: string;
  onClick: () => void;
}

/** The transient notice toast (a rejected deep link, an undo offer).
 *  Identical on both platforms — only where it mounts differs: over the
 *  phone shell, or inside the desktop preview column under the toolbar. */
function AppNotice({
  text,
  action,
  onDismiss,
}: {
  text: string;
  action?: AppNoticeAction | null;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div className="app-notice" role="alert">
      <span className="app-notice-text">{text}</span>
      {action ? (
        <button
          type="button"
          className="app-notice-action"
          onClick={() => {
            action.onClick();
            onDismiss();
          }}
        >
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="app-notice-dismiss"
        title="Dismiss"
        aria-label="Dismiss notice"
        onClick={onDismiss}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

export default function App({ ipc: injectedIpc }: AppProps = {}): React.ReactElement {
  const ipc = injectedIpc ?? tauriIpc;
  // Drives <html data-theme="…"> via side-effect; must mount at the root.
  useTheme();
  // The E2E harness's Rust→JS channel. Inert in every build a person runs —
  // see the hook's own comment for the runtime gate that keeps it that way.
  const e2eReady = useE2eBridge();

  return (
    <PlatformProvider ipc={ipc}>
      <WorkspaceProvider ipc={ipc}>
        {e2eReady ? <E2eSeam /> : null}
        <ProviderShell ipc={ipc} />
      </WorkspaceProvider>
    </PlatformProvider>
  );
}

/**
 * The one test-only surface the harness needs that no DOM primitive can
 * reach. A `KeyboardEvent` dispatched on `document` already drives the app's
 * keyboard registry from outside, and `HTMLElement.click()` already drives
 * its handlers — but there is no such primitive for "move the workspace
 * root", which lives in React context. So this publishes `setRoot` itself,
 * and only once `useE2eBridge` reported the bridge armed, which happens only
 * in a debug build (see the hook). Production renders nothing at all, and
 * `WorkspaceProvider` stays free of any harness-shaped listener.
 */
function E2eSeam(): null {
  const { setRoot } = useWorkspace();
  React.useEffect(() => {
    const w = window as typeof window & { __skypieE2e?: { setWorkspaceRoot: (p: string) => void } };
    w.__skypieE2e = { setWorkspaceRoot: setRoot };
    return () => {
      delete w.__skypieE2e;
    };
  }, [setRoot]);
  return null;
}

function ProviderShell({ ipc }: { ipc: IpcSurface }): React.ReactElement {
  const { root } = useWorkspace();
  // A callback bridge, not a notice context: `PiesProvider` must be an
  // ANCESTOR of `AppShell` (AppShell itself reads `usePiesContext()` for
  // ⌘D), but the notice toast's actual state lives inside AppShell —
  // `AppNoticeAction`'s own doc comment is explicit that this codebase
  // does not centralize notices in a context. AppShell overwrites
  // `noticeRef.current` with its `showNotice` on every render; `PiesProvider`
  // only ever calls `.current` from an async callback (a rejected
  // `canonicalizePath`/`addPieMember`), always well after that render has
  // committed, so there is no ordering hazard.
  const noticeRef = React.useRef<NoticeFn>(() => {});
  return (
    <WatcherProvider ipc={ipc} root={root}>
      <BookmarksProvider ipc={ipc}>
        <RecentsProvider ipc={ipc}>
          <TabsProvider ipc={ipc}>
            <RemoteProvider ipc={ipc}>
              <BeamProvider ipc={ipc}>
                <ScrollMemoryProvider>
                  <ExplorerUiProvider>
                    <ContextMenuProvider>
                      <PiesProvider
                        ipc={ipc}
                        onNotice={(text, action, durationMs) => noticeRef.current(text, action, durationMs)}
                      >
                        <AnnotatedShell ipc={ipc} noticeRef={noticeRef} />
                      </PiesProvider>
                    </ContextMenuProvider>
                  </ExplorerUiProvider>
                </ScrollMemoryProvider>
              </BeamProvider>
            </RemoteProvider>
          </TabsProvider>
        </RecentsProvider>
      </BookmarksProvider>
    </WatcherProvider>
  );
}

// The annotations provider needs the path the active tab is showing, which
// only exists inside TabsProvider — and the rail, the iOS sheet and the
// sidebar badges must all read ONE subscription, so it wraps the shell rather
// than living inside it.
function AnnotatedShell({
  ipc,
  noticeRef,
}: {
  ipc: IpcSurface;
  noticeRef: React.MutableRefObject<NoticeFn>;
}): React.ReactElement {
  const active = useActiveTab();
  const source = currentEntry(active)?.path ?? null;
  return (
    <AnnotationsProvider ipc={ipc} source={source}>
      <AppShell ipc={ipc} noticeRef={noticeRef} />
    </AnnotationsProvider>
  );
}

function AppShell({
  ipc,
  noticeRef,
}: {
  ipc: IpcSurface;
  noticeRef: React.MutableRefObject<NoticeFn>;
}): React.ReactElement {
  const { root, setRoot } = useWorkspace();
  const { isMacos } = usePlatform();
  const dispatch = useTabsDispatch();
  const active = useActiveTab();
  const entry = currentEntry(active);
  const openFile = useOpenFile(ipc, root);
  const { reveal } = useExplorerUi();
  const { openPicker } = usePiesContext();

  // Auto-reveal: keep the tree pointing at the active tab's file.
  const activePath = entry?.path ?? null;
  React.useEffect(() => {
    if (activePath && root && isUnderRoot(activePath, root)) {
      reveal(activePath, root);
    }
  }, [activePath, root, reveal]);

  const [sidebarPx, setSidebarPx] = React.useState<number>(DEFAULT_SIDEBAR_PX);
  const [sidebarVisible, setSidebarVisible] = React.useState<boolean>(true);
  // Reader mode: chrome down to tabs + document. Deliberately transient —
  // a reading posture, not a workspace setting, so it never persists.
  const [readerMode, setReaderMode] = React.useState<boolean>(false);
  // The Sky band — off by default so the installed base sees nothing new
  // (panes.sky_visible, hydrated below).
  const [skyVisible, setSkyVisible] = React.useState<boolean>(false);
  const [refreshNonce, setRefreshNonce] = React.useState<number>(0);
  const [quickOpenVisible, setQuickOpenVisible] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<{ text: string; action?: AppNoticeAction | null } | null>(
    null,
  );
  // ── Comments ───────────────────────────────────────────────────────────
  // Two switches. "Show comments" (⇧⌘M) is a workspace posture: it stays
  // where the user left it across tabs, and reader mode hides the notes the
  // way it hides the sidebar. The comment TOOL (⇧⌘K) is a mode: while it is
  // on, a click on a line, a block or an image is a comment, not a
  // navigation, and Esc puts the pointer back. `pending` is the target
  // waiting for a body — one at a time, because a second pick replaces the
  // first rather than queueing.
  const [commentsVisible, setCommentsVisible] = React.useState(true);
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(null);
  // The RENDERED text of an HTML artifact, reported by its frame. This is
  // what a comment on it quotes and what a re-anchor pass searches — not the
  // HTML source, which the user never saw. Markdown, code and text anchor to
  // their SOURCE instead, which the host has in the tab payload.
  const [renderedText, setRenderedText] = React.useState("");
  const tabViewRef = React.useRef<HTMLDivElement | null>(null);
  const { openCountFor } = useAnnotations();

  const dropActiveThread = React.useCallback(() => setActiveThreadId(null), []);

  // The tool's rules are shared with the phone shell — see the hook. This
  // shell only says where the document is and what a pick should do here.
  const {
    on: commentTool,
    setOn: setCommentTool,
    isFrame,
    docText,
    pending,
    setPending,
    onToolClick,
  } = useCommentTool({
    containerRef: tabViewRef,
    path: entry?.path ?? null,
    payload: active.payload,
    renderedText,
    onPick: dropActiveThread,
  });
  const addressBarRef = React.useRef<HTMLInputElement | null>(null);
  const noticeTimer = React.useRef<number | null>(null);

  const dismissNotice = React.useCallback(() => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNotice(null);
  }, []);

  const showNotice = React.useCallback(
    (text: string, action?: AppNoticeAction, durationMs: number = NOTICE_MS) => {
      setNotice({ text, action });
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(null), durationMs);
    },
    [],
  );
  // Keep ProviderShell's bridge ref pointed at the LATEST showNotice — see
  // its own doc comment for why this is a ref and not a context.
  noticeRef.current = showNotice;

  // ── Persisted sidebar width ────────────────────────────────────────────
  React.useEffect(() => {
    if (!ipc.getState) return;
    let cancelled = false;
    ipc.getState().then((s) => {
      if (cancelled) return;
      const px = s?.panes?.sidebar_px;
      if (typeof px === "number" && px > 0) {
        setSidebarPx(clampSidebarPx(px));
      }
      // One rule for both postures (state/panes.ts): a ⌘B / ⌘⇧B pressed
      // before this snapshot resolved wins over the persisted value, and a
      // non-boolean stored value leaves the default alone.
      const sidebar = hydratePaneVisible(s?.panes?.sidebar_visible, userToggledSidebar.current);
      if (sidebar !== null) setSidebarVisible(sidebar);
      const sky = hydratePaneVisible(s?.panes?.sky_visible, userToggledSky.current);
      if (sky !== null) setSkyVisible(sky);
    }).catch(() => {
      // Backend not wired or state.json missing — keep the default width
      // and visibility.
    });
    return () => { cancelled = true; };
  }, [ipc]);

  const handleSidebarResizeCommit = React.useCallback((finalPx: number) => {
    if (ipc.setStateField) {
      void ipc.setStateField("panes.sidebar_px", clampSidebarPx(finalPx));
    }
  }, [ipc]);

  // ── View modes ─────────────────────────────────────────────────────────
  // Set true on the first ⌘B so the async getState() hydration can't clobber
  // a toggle that raced it.
  const userToggledSidebar = React.useRef(false);
  // Same race, same fix, for ⌘⇧B.
  const userToggledSky = React.useRef(false);

  // `setStateField` is optional. `ipc.setStateField?.(…).catch(…)` used to
  // short-circuit the WHOLE chain — including the `.catch` — when the
  // surface was absent: nothing was written and nothing said so, and the
  // pane silently came back in its old posture next launch. The missing
  // surface is logged, and a rejected write reaches the user through the
  // notice the shell already renders.
  const persistPaneVisible = React.useCallback((field: string, label: string, visible: boolean) => {
    if (!ipc.setStateField) {
      console.error(`skypie: no setStateField surface — ${label} visibility is not persisted`);
      return;
    }
    ipc.setStateField(field, visible).catch((e: unknown) => {
      console.error(`skypie: failed to persist ${label} visibility`, e);
      showNotice(`Couldn't save the ${label} setting — it won't survive a restart.`);
    });
  }, [ipc, showNotice]);

  const persistSidebarVisible = React.useCallback((visible: boolean) => {
    persistPaneVisible("panes.sidebar_visible", "sidebar", visible);
  }, [persistPaneVisible]);

  const persistSkyVisible = React.useCallback((visible: boolean) => {
    persistPaneVisible("panes.sky_visible", "sky band", visible);
  }, [persistPaneVisible]);

  // ⌘B. In reader mode the sidebar is already gone, so the intuitive result
  // of "show me the sidebar" is to leave reader mode with the sidebar on.
  // No functional setState here: updaters must stay pure (StrictMode
  // double-invokes them), and the IPC write is a side effect.
  const toggleSidebar = React.useCallback(() => {
    userToggledSidebar.current = true;
    if (readerMode) {
      setReaderMode(false);
      setSidebarVisible(true);
      persistSidebarVisible(true);
      return;
    }
    const next = !sidebarVisible;
    setSidebarVisible(next);
    persistSidebarVisible(next);
  }, [persistSidebarVisible, readerMode, sidebarVisible]);

  const toggleReaderMode = React.useCallback(() => {
    setReaderMode((v) => !v);
  }, []);

  // ⌘⇧B. Reader mode already unmounts the Toolbar and gates the band on
  // !readerMode, so toggling Sky from inside reader mode only flips the
  // persisted posture — the band itself reappears once the user leaves.
  // No functional setState here, for the same reason as toggleSidebar: the
  // updater must stay pure (StrictMode double-invokes it), and the IPC
  // write is a side effect.
  const toggleSky = React.useCallback(() => {
    userToggledSky.current = true;
    const next = !skyVisible;
    setSkyVisible(next);
    persistSkyVisible(next);
  }, [persistSkyVisible, skyVisible]);

  // ── Pickers ────────────────────────────────────────────────────────────
  const handlePickFile = React.useCallback(() => {
    if (!ipc.pickFile) return;
    void ipc.pickFile().then((picked) => {
      if (picked) openFile(picked);
    }).catch(() => {});
  }, [ipc, openFile]);

  const handlePickWorkspace = React.useCallback(() => {
    if (!ipc.pickDirectory) return;
    void ipc.pickDirectory().then((picked) => {
      if (picked) setRoot(picked);
    }).catch(() => {});
  }, [ipc, setRoot]);

  // Manual refresh: re-fetch every expanded tree folder AND reload the
  // active tab, without collapsing expansion state.
  const handleRefresh = React.useCallback(() => {
    setRefreshNonce((n) => n + 1);
    dispatch({ type: "RELOAD" });
  }, [dispatch]);

  // ── Deep links ─────────────────────────────────────────────────────────
  const handleDeepLinkIntent = React.useCallback(
    ({ path, intent, out_of_root }: OpenFilePayload) => {
      if (intent === "open") {
        dispatch({ type: "FOCUS_OR_OPEN", path, external: Boolean(out_of_root) });
      } else {
        // Reveal: expand + scroll to the file in the tree WITHOUT switching
        // the preview (per the deeplink.rs contract).
        reveal(path, root);
      }
    },
    [dispatch, reveal, root],
  );
  const handleDeepLinkError = React.useCallback(
    (payload: DeepLinkErrorPayload) => {
      showNotice(deepLinkNotice(payload));
    },
    [showNotice],
  );
  useDeepLink({ onIntent: handleDeepLinkIntent, onError: handleDeepLinkError });

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  // ⌘⇧C: the most common share, without opening the menu. The toast is its
  // only feedback, because the chord has no button to flash.
  const copyDeviceLinkForActive = React.useCallback(() => {
    const path = entry?.path;
    if (!path) return;
    void copyDeviceLink(ipc, path).then((ok) =>
      showNotice(ok ? "Link copied for your devices" : "Couldn't make a link for your devices"),
    );
  }, [entry?.path, ipc, showNotice]);

  const focusAddressBar = React.useCallback(() => {
    // ⌘L must work from reader mode: leave it first. flushSync, not a timer —
    // the chord can arrive via the iframe message path, where nothing
    // guarantees a macrotask lands after the commit that re-mounts the bar.
    flushSync(() => setReaderMode(false));
    const input = addressBarRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, []);

  // Picking up the tool shows the notes: a comment made into a hidden
  // overlay would land nowhere the user can see.
  const toggleCommentTool = React.useCallback(() => {
    setCommentTool((on) => {
      if (!on) setCommentsVisible(true);
      return !on;
    });
  }, []);

  // The combo table itself lives in keyboard/app-bindings.ts, beside the
  // IFRAME_FORWARDABLE / IFRAME_DENIED lists it has to agree with; this
  // shell only supplies the handlers and the three flags that gate a chord.
  const bindings: Binding[] = appBindings(
    {
      openNewTab: () => dispatch({ type: "OPEN_NEW_TAB" }),
      closeActiveTab: () => dispatch({ type: "CLOSE_TAB", tabId: active.id }),
      reopenClosedTab: () => dispatch({ type: "REOPEN_CLOSED_TAB" }),
      activateDelta: (delta) => dispatch({ type: "ACTIVATE_DELTA", delta }),
      activateIndex: (index) => dispatch({ type: "ACTIVATE_INDEX", index }),
      goBack: () => dispatch({ type: "GO_BACK" }),
      goForward: () => dispatch({ type: "GO_FORWARD" }),
      refreshActive: handleRefreshActive,
      focusAddressBar,
      pickFile: handlePickFile,
      toggleQuickOpen: () => setQuickOpenVisible((v) => !v),
      copyDeviceLinkForActive,
      addActiveFileToPie: () => {
        if (entry?.path) openPicker(entry.path);
      },
      toggleSidebar,
      toggleSky,
      toggleReaderMode,
      toggleComments: () => setCommentsVisible((v) => !v),
      toggleCommentTool,
      putCommentToolDown: () => setCommentTool(false),
      leaveReaderMode: () => {
        // An open context menu still owns Esc — it closes itself on the same
        // window event, and one keypress must not do both.
        if (document.querySelector(".context-menu")) return;
        setReaderMode(false);
      },
      zoomBy,
      resetZoom: () => dispatch({ type: "SET_ZOOM", tabId: active.id, zoom: 1 }),
    },
    { isMacos, commentTool, readerMode },
    ZOOM_STEP,
  );

  function handleRefreshActive(): void {
    dispatch({ type: "RELOAD" });
  }

  function zoomBy(delta: number): void {
    dispatch({ type: "SET_ZOOM", tabId: active.id, zoom: active.zoom + delta });
  }

  useShortcuts(bindings);

  const showSidebar = sidebarVisible && !readerMode;

  // Keep a ref for the iframe-forwarded chord path.
  const bindingsRef = React.useRef<readonly Binding[]>(bindings);
  bindingsRef.current = bindings;

  // ── postMessage routing (iframe + markdown links, forwarded chords) ────
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as unknown;
      if (!data || typeof data !== "object") return;
      const d = data as {
        type?: unknown;
        path?: unknown;
        url?: unknown;
        meta?: unknown;
        shift?: unknown;
        middle?: unknown;
      };
      if (d.type === "skypie:navigate" && typeof d.path === "string") {
        const newTab = Boolean(d.meta) || Boolean(d.middle);
        openFile(d.path, newTab ? { newTab: true, background: !d.shift } : undefined);
        return;
      }
      // External http(s) link from a rendered HTML/Markdown artifact: hand it
      // to the OS default browser. The opener plugin's capability is scoped to
      // http/https/mailto, so a malformed or unexpected scheme is rejected at
      // the Rust layer rather than silently navigating the host webview.
      if (d.type === "skypie:openExternal" && typeof d.url === "string") {
        void openUrl(d.url).catch((err: unknown) => {
          console.error("skypie: failed to open external URL", d.url, err);
        });
        return;
      }
      // Global chords forwarded from the focused HTML preview iframe. Only a
      // safe subset is honored — rendered artifact content is untrusted and
      // can postMessage this shape directly, so it must never synthesize a
      // chord that opens a native dialog (⌘O), seizes the address bar (⌘L),
      // or pops an overlay (⌘P).
      // The comment tool's pick inside a rendered artifact, or the frame's
      // report of its rendered text. Both shells read the bridge through one
      // adapter — see `annotations/bridge`. Located anchors are the
      // overlay's business and are ignored here.
      if (
        d.type === "skypie:elementPick" ||
        d.type === "skypie:imagePin" ||
        d.type === "skypie:documentText"
      ) {
        const got = readBridgeMessage(data);
        if (got === null || "located" in got) return;
        if (got.text) setRenderedText(got.text);
        // The load-time text report carries no target: it exists so the
        // comments the file already has can re-anchor, and it must not arm
        // the composer.
        if (!("pending" in got)) return;
        setPending(got.pending);
        setActiveThreadId(null);
        setCommentsVisible(true);
        return;
      }
      if (d.type === "skypie:keydown") {
        dispatchChord(
          d as unknown as ChordEvent,
          bindingsRef.current.filter((b) => IFRAME_FORWARDABLE.has(b.combo)),
          false,
        );
        return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openFile]);

  // Dialogs are summoned by events (a beam arriving, a pair link) or by a
  // gear button, never by the shell around them — so both architectures
  // mount the same set, at the same depth.
  // Reader mode hides the notes the same way it hides the sidebar, and an
  // empty tab has no file to comment on.
  const showComments = commentsVisible && !readerMode && Boolean(entry?.path);

  // Switching files drops the active thread and the text the last document
  // reported; both belong to the document that was open. The hook drops the
  // half-made comment on the same change.
  React.useEffect(() => {
    setActiveThreadId(null);
    setRenderedText("");
  }, [entry?.path]);

  const overlays = (
    <>
      <BeamDialog ipc={ipc} />
      <RemotePairDialog />
      {settingsOpen ? <SettingsModal ipc={ipc} onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );

  // The phone gets its own architecture (PhoneShell): one column, bottom
  // bar, sheets. Overlays (dialogs, notice) mount the same either way.
  if (!isMacos) {
    return (
      <div className="app-shell">
        <PhoneShell
          ipc={ipc}
          onOpenFile={openFile}
          onOpenSettings={() => setSettingsOpen(true)}
          onPickFile={handlePickFile}
          onPickWorkspace={handlePickWorkspace}
          workspaceRoot={root}
        />
        {notice ? <AppNotice text={notice.text} action={notice.action} onDismiss={dismissNotice} /> : null}
        {overlays}
      </div>
    );
  }

  return (
    // The sidebar is a full-height column; the tab strip lives inside the
    // preview pane, aligned with the reading field. On the left the sidebar
    // reserves the traffic-light space and drags the window — via its header
    // when a workspace is open, via the empty-state pane before that. The
    // strip keeps drag duty over the preview column, and takes the gutter
    // itself when the sidebar is hidden.
    <div className="app-shell">
      <div className="app">
        {showSidebar ? (
          <>
            <aside
              className="pane pane-sidebar"
              role="complementary"
              style={{ width: `${sidebarPx}px` }}
            >
              <Sidebar
                ipc={ipc}
                onOpenFile={openFile}
                selectedFile={entry?.path ?? null}
                onPickFile={handlePickFile}
                onPickWorkspace={handlePickWorkspace}
                onRefresh={handleRefresh}
                refreshNonce={refreshNonce}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            </aside>
            <SidebarResizer
              width={sidebarPx}
              onResize={setSidebarPx}
              onCommit={handleSidebarResizeCommit}
            />
          </>
        ) : null}
        <main className="pane pane-preview" role="main">
          {/* With the sidebar gone the strip is the leftmost band, so it
              takes back the traffic-light gutter. */}
          <TabStrip onOpenFile={openFile} showGutter={!showSidebar} />
          {readerMode ? null : (
            <Toolbar
              addressBarRef={addressBarRef}
              onSubmitPath={(p) => openFile(p)}
              sidebarVisible={sidebarVisible}
              onToggleSidebar={toggleSidebar}
              skyVisible={skyVisible}
              onToggleSky={toggleSky}
              onEnterReaderMode={toggleReaderMode}
              commentsVisible={commentsVisible}
              onToggleComments={() => setCommentsVisible((v) => !v)}
              commentTool={commentTool}
              onToggleCommentTool={toggleCommentTool}
              openComments={entry ? openCountFor(entry.path) : 0}
            />
          )}
          {/* Reader mode already unmounts the Toolbar on the same condition
              (see the JSX above); the band follows it down for the same
              reason — the artifact stays the protagonist. */}
          {skyVisible && !readerMode ? (
            <Sky ipc={ipc} onOpenFile={openFile} onNotice={showNotice} />
          ) : null}
          {notice ? <AppNotice text={notice.text} action={notice.action} onDismiss={dismissNotice} /> : null}
          <div
            ref={tabViewRef}
            className={"tab-view" + (commentTool && !isFrame ? " comment-tool-on" : "")}
            id="tab-panel"
            role="tabpanel"
            aria-labelledby={`tab-${active.id}`}
            onClickCapture={onToolClick}
          >
            <TabView
              onOpenFile={openFile}
              onPickFile={handlePickFile}
              onPickWorkspace={handlePickWorkspace}
              workspaceRoot={root}
              onOpenSettings={() => setSettingsOpen(true)}
            />
            {/* Reader mode strips the notes with the rest of the chrome: it
                is a reading posture, and feedback is work. */}
            {showComments ? (
              <CommentOverlay
                containerRef={tabViewRef}
                isFrame={isFrame}
                text={docText}
                contentHash={null}
                pending={pending}
                onClearPending={() => setPending(null)}
                activeId={activeThreadId}
                onActivate={setActiveThreadId}
              />
            ) : null}
          </div>
        </main>
      </div>
      {quickOpenVisible && root ? (
        <QuickOpen
          ipc={ipc}
          root={root}
          onOpenFile={openFile}
          onClose={() => setQuickOpenVisible(false)}
        />
      ) : null}
      {overlays}
    </div>
  );
}

