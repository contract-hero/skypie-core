// app-bindings.ts — the desktop shell's keyboard table, and the rule for
// which of its chords a focused HTML preview iframe may forward.
//
// It lives here rather than inside App.tsx so the table is a PURE value a
// test can enumerate: `IFRAME_FORWARDABLE` is a security boundary (rendered
// artifact content can postMessage a `skypie:keydown` of any shape), and a
// binding added to App.tsx must be a deliberate member of exactly one of the
// two lists below. App.tsx supplies the handlers and the flags; nothing
// about the runtime behaviour changes here.
import type { Binding } from "./shortcuts";

// Chords honored when forwarded from a preview iframe: tab, nav, zoom and
// view-mode chords, plus bare Escape (bound only while reader mode or the
// comment tool is on, and only to leave that mode) — nothing that opens
// native dialogs, steals focus, or discards something the user typed. Must
// stay in sync with the FORWARD map in the injected script in
// src/render/html.tsx.
export const IFRAME_FORWARDABLE = new Set([
  "mod+t", "mod+w", "mod+shift+t", "ctrl+tab", "ctrl+shift+tab",
  "mod+shift+bracketright", "mod+shift+bracketleft",
  "mod+bracketleft", "mod+bracketright", "mod+r",
  "mod+equal", "mod+shift+equal", "mod+minus",
  "mod+b", "mod+shift+f", "mod+shift+b", "escape",
  ...Array.from({ length: 10 }, (_, i) => `mod+digit${i}`),
]);

/** The other half of the boundary: every app chord deliberately kept OUT of
 *  `IFRAME_FORWARDABLE`, each with the reason. A chord in neither list is a
 *  binding nobody classified — `app-bindings.test.ts` fails on it. */
export const IFRAME_DENIED: Record<string, string> = {
  "mod+o": "opens the native file picker — a rendered artifact must not summon an OS dialog",
  "mod+p": "pops the quick-open overlay over the artifact that asked for it",
  "mod+l": "seizes the address bar, i.e. the host's own text input",
  "mod+shift+c": "mints a device link for the active tab onto the clipboard",
  "mod+shift+m": "toggles the comment overlay the artifact is being annotated in",
  "mod+shift+k": "picks up the comment tool, which changes what a click in the artifact means",
  "mod+d": "opens the pie picker, a focus-stealing dialog \u2014 same rule as \u2318O/\u2318P (spec section 2/6); the Sky tile's own right-click covers the mouse path from inside a preview",
};

/** Everything App.tsx's bindings do, as one handler per action. Passing the
 *  actions in (rather than exporting a table of strings App.tsx repeats)
 *  keeps a single source of truth for the combos. */
export interface AppBindingActions {
  openNewTab: () => void;
  closeActiveTab: () => void;
  reopenClosedTab: () => void;
  /** ±1 only: the tab strip's own action type is `1 | -1`. */
  activateDelta: (delta: 1 | -1) => void;
  activateIndex: (index: number) => void;
  goBack: () => void;
  goForward: () => void;
  refreshActive: () => void;
  focusAddressBar: () => void;
  pickFile: () => void;
  toggleQuickOpen: () => void;
  copyDeviceLinkForActive: () => void;
  /** ⌘D: opens the pie picker on the active tab's file. A no-op when the
   *  active tab holds no file. */
  addActiveFileToPie: () => void;
  toggleSidebar: () => void;
  toggleSky: () => void;
  toggleReaderMode: () => void;
  toggleComments: () => void;
  toggleCommentTool: () => void;
  putCommentToolDown: () => void;
  leaveReaderMode: () => void;
  zoomBy: (delta: number) => void;
  resetZoom: () => void;
}

export interface AppBindingFlags {
  /** The workspace chords (⌘O, ⌘P) and device links exist on macOS only —
   *  the phone owns no files (PRODUCT.md). */
  isMacos: boolean;
  /** Escape is bound only while the comment tool is up. */
  commentTool: boolean;
  /** Escape is bound only while reader mode is on. */
  readerMode: boolean;
}

export function appBindings(
  a: AppBindingActions,
  flags: AppBindingFlags,
  zoomStep: number,
): Binding[] {
  return [
    { combo: "mod+t", allowInInput: true, handler: () => a.openNewTab() },
    { combo: "mod+w", allowInInput: true, handler: () => a.closeActiveTab() },
    { combo: "mod+shift+t", allowInInput: true, handler: () => a.reopenClosedTab() },
    { combo: "ctrl+tab", allowInInput: true, handler: () => a.activateDelta(1) },
    { combo: "ctrl+shift+tab", allowInInput: true, handler: () => a.activateDelta(-1) },
    { combo: "mod+shift+bracketright", allowInInput: true, handler: () => a.activateDelta(1) },
    { combo: "mod+shift+bracketleft", allowInInput: true, handler: () => a.activateDelta(-1) },
    ...Array.from({ length: 8 }, (_, i): Binding => ({
      combo: `mod+digit${i + 1}`,
      allowInInput: true,
      handler: () => a.activateIndex(i),
    })),
    // ⌘9 is "the last tab", the browser convention.
    { combo: "mod+digit9", allowInInput: true, handler: () => a.activateIndex(-1) },
    { combo: "mod+bracketleft", handler: () => a.goBack() },
    { combo: "mod+bracketright", handler: () => a.goForward() },
    { combo: "mod+r", allowInInput: true, handler: () => a.refreshActive() },
    { combo: "mod+l", allowInInput: true, handler: () => a.focusAddressBar() },
    // File picker (⌘O) and quick-open (⌘P) both act on a local workspace,
    // which doesn't exist on iOS (PRODUCT.md: the phone owns no files) — the
    // Sidebar and TabView hide their entry points there too.
    ...(flags.isMacos
      ? [
          { combo: "mod+o", allowInInput: true, handler: () => a.pickFile() } satisfies Binding,
          { combo: "mod+p", allowInInput: true, handler: () => a.toggleQuickOpen() } satisfies Binding,
          // Never in IFRAME_FORWARDABLE: rendered content must not be able to
          // mint a link to itself onto the clipboard.
          { combo: "mod+shift+c", handler: () => a.copyDeviceLinkForActive() } satisfies Binding,
          // ⌘D — the pie picker. Not forwarded from a preview iframe either
          // (same owner decision as ⌘O/⌘P: it opens a dialog and steals
          // focus — spec section 2/6). The tile's own right-click covers
          // the mouse path from inside a preview.
          { combo: "mod+d", allowInInput: true, handler: () => a.addActiveFileToPie() } satisfies Binding,
        ]
      : []),
    { combo: "mod+b", allowInInput: true, handler: () => a.toggleSidebar() },
    { combo: "mod+shift+b", allowInInput: true, handler: () => a.toggleSky() },
    { combo: "mod+shift+f", allowInInput: true, handler: () => a.toggleReaderMode() },
    { combo: "mod+shift+m", allowInInput: true, handler: () => a.toggleComments() },
    { combo: "mod+shift+k", allowInInput: true, handler: () => a.toggleCommentTool() },
    // Esc puts the comment tool down. Bound only while the tool is on, like
    // the reader-mode Esc below.
    //
    // It deliberately does NOT drop the pending target: `escape` is in
    // IFRAME_FORWARDABLE, so a rendered artifact can synthesize it, and
    // clearing `pending` unmounts the composer with whatever the user had
    // typed inside it. The composer owns its own Esc for cancelling.
    ...(flags.commentTool
      ? [{ combo: "escape", allowInInput: true, handler: () => a.putCommentToolDown() } satisfies Binding]
      : []),
    // Esc leaves reader mode. Registered only while the mode is on, so plain
    // Escape keeps its meaning everywhere else (QuickOpen, address bar). An
    // open context menu still owns Esc — it closes itself on the same window
    // event, and one keypress must not do both.
    ...(flags.readerMode
      ? [{ combo: "escape", handler: () => a.leaveReaderMode() } satisfies Binding]
      : []),
    { combo: "mod+equal", handler: () => a.zoomBy(zoomStep) },
    { combo: "mod+shift+equal", handler: () => a.zoomBy(zoomStep) },
    { combo: "mod+minus", handler: () => a.zoomBy(-zoomStep) },
    { combo: "mod+digit0", handler: () => a.resetZoom() },
  ];
}
