// Sky — the pies band: a 120px strip between the toolbar and the tab view,
// toggled by the toolbar tile / ⌘⇧B and gone by default (panes.sky_visible).
// M1 shipped the two derived built-ins, Pinned and Recent. M2 adds the
// persisted user pies, the tin (create), inline rename, delete with a
// 5-second undo, and each user pie's own right-click menu (DESIGN.md, "Sky
// band"). M3 adds the freshness pill (+N, one-click-open-newest, ⌘Enter)
// and folder census refresh-on-show — see PieCensusProvider (pie-census.ts)
// and PiePlate.tsx for the folder layers themselves. M4 adds Finder drop
// (onto a pie or the tin), the drop-target ring, the passive active-file
// mark, and deep-link reveal's plate target (App.tsx arms `revealTarget`).
import * as React from "react";
import { FolderPlus, Pencil, Trash2 } from "lucide-react";
import { useBookmarksContext } from "../state/bookmarks-context";
import { useRecentsContext } from "../state/recents-context";
import { usePiesContext } from "../state/pies-context";
import { usePieCensus, newestPath } from "../state/pie-census";
import { labelOfWedges, pinnedPie, recentPie, wedgesOf } from "../state/derived-pies";
import type { DerivedPie } from "../state/derived-pies";
import { bandOrder, isUserPieId, uniqueName } from "../state/pies";
import { messageOf } from "../utils/error-message";
import Pie from "./Pie";
import PiePlate from "./PiePlate";
import Tooltip from "./Tooltip";
import { useContextMenu } from "./ContextMenu";
import type { IpcSurface } from "../ipc";
import type { AppNoticeAction } from "../App";
import { openOptsFromClick, useActiveTab } from "../state/TabsProvider";
import type { OpenFileOptions } from "../state/TabsProvider";
import { currentEntry } from "../state/tabs";
import { isRemoteAddress } from "../utils/remote-address";
import { basename } from "../utils/path";
import { dropPieName, TIN_DROP_ID, useFinderDrop } from "../hooks/useFinderDrop";

/** How long a deleted user pie stays undoable before the removal actually
 *  reaches the backend (spec section 2, "Delete... 5-second AppNotice
 *  undo"). The notice itself is shown for exactly this long too, so the
 *  action disappears the instant it stops working. */
const UNDO_MS = 5000;

/** M4: what a deep-link reveal (App.tsx's `revealRoute === "plate"`) arms
 *  Sky with — which pie's plate to open and, inside it, which row to
 *  focus. `nonce` (not `path`/`pieId` identity) is the effect trigger
 *  below: a SECOND reveal of the exact same path must still re-open/
 *  re-focus even though `pieId`/`path` would otherwise look unchanged to
 *  React. Not persisted anywhere — a one-off routing decision, spec line
 *  148, "not persisted". */
export interface SkyRevealTarget {
  pieId: string;
  path: string;
  nonce: number;
}

export interface SkyProps {
  ipc: IpcSurface;
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
  /** Surfaces the delete-undo toast through `AppShell`'s own `AppNotice` —
   *  Sky.tsx owns no notice UI of its own (App.tsx, "Add an optional
   *  action... Do not add a notice context"). */
  onNotice: (text: string, action?: AppNoticeAction, durationMs?: number) => void;
  /** M4: see `SkyRevealTarget`. `null`/omitted whenever the last deep link
   *  (if any) didn't route to the plate. */
  revealTarget?: SkyRevealTarget | null;
  /** M4: fired once PiePlate has actually consumed `revealTarget` (its
   *  focus effect ran, whether or not it found the target row) — App.tsx's
   *  `clearRevealTarget`. `revealTarget` is a ONE-SHOT routing decision
   *  (spec line 148, "not persisted"); without this callback nothing ever
   *  cleared it, so it kept steering every later open of the same pie's
   *  plate and re-fired on every fresh Sky mount (review: App.tsx:466). */
  onRevealConsumed?: () => void;
}

/** A dashed hairline circle with no fill — the tin's own glyph (spec
 *  section 3: "a dashed hairline circle labelled 'New pie'"), matching
 *  `Toolbar.tsx`'s `SkyGlyph` in spirit (a hand-drawn SVG, not a lucide
 *  icon, because neither has a stock "empty pie" glyph). */
function TinGlyph(): React.ReactElement {
  return (
    <svg width={48} height={48} viewBox="0 0 48 48" aria-hidden focusable="false">
      <circle
        cx="24"
        cy="24"
        r="21"
        fill="none"
        stroke="var(--sky-ink-dim)"
        strokeWidth="1.3"
        strokeDasharray="3 4"
      />
      <path d="M24 16v16M16 24h16" stroke="var(--sky-ink-dim)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** One cumulus: three overlapping ellipses on a fixed 37×22 viewBox. The
 *  band's two clouds differ only in where CSS puts them, so this renders
 *  once and is placed twice — `className` carries the position. */
function Cloud({ className }: { className: string }): React.ReactElement {
  return (
    <svg
      className={`sky-cloud ${className}`}
      viewBox="0 0 37 22"
      aria-hidden
      focusable="false"
    >
      <ellipse cx="10" cy="16" rx="10" ry="7" />
      <ellipse cx="19" cy="9" rx="13" ry="9" />
      <ellipse cx="28" cy="17" rx="9" ry="6" />
    </svg>
  );
}

export default function Sky({
  ipc,
  onOpenFile,
  onNotice,
  revealTarget,
  onRevealConsumed,
}: SkyProps): React.ReactElement {
  const { bookmarks } = useBookmarksContext();
  const { recents } = useRecentsContext();
  const piesCtx = usePiesContext();
  const pieCensusCtx = usePieCensus();
  const contextMenu = useContextMenu();

  const pies = React.useMemo<DerivedPie[]>(
    () =>
      bandOrder([pinnedPie(bookmarks), recentPie(recents)], piesCtx.pies, pieCensusCtx.derive),
    [bookmarks, recents, piesCtx.pies, pieCensusCtx.derive],
  );
  // One tooltip label per tile, keyed on the band list — building it in the
  // map below grouped every pie's files afresh on every band render (one
  // per recents/bookmarks tick).
  const tileLabels = React.useMemo(
    () => pies.map((pie) => labelOfWedges(wedgesOf(pie.files))),
    [pies],
  );
  // Slots: every pie, then the tin — the tin's own roving-tabindex slot is
  // `pies.length`.
  const tinIndex = pies.length;

  // "sky show" (spec section 6) — refresh every user pie's census the
  // moment the band mounts. Sky.tsx only mounts when `skyVisible &&
  // !readerMode` (App.tsx), so a plain mount effect IS the "on show"
  // trigger; `pieCensusCtx.refreshAll` is intentionally left out of the
  // deps array below (PiePlate.tsx's own seen_at effect follows the same
  // "mount-only, not on every identity change" shape) — re-running it on
  // every identity change would re-walk every folder of every pie for a
  // callback that merely re-identified. A pie whose MEMBERS change is
  // refetched on its own, per pie, by `pie-census.ts`'s members effect.
  React.useEffect(() => {
    pieCensusCtx.refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const [openPieId, setOpenPieId] = React.useState<string | null>(null);
  const [creatingNew, setCreatingNew] = React.useState(false);
  const [newPieName, setNewPieName] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const itemRefs = React.useRef<Array<HTMLElement | null>>([]);
  const setItemRef = (i: number) => (el: HTMLElement | null) => {
    itemRefs.current[i] = el;
  };

  // Keep the roving index in range as pies (and the tin) come and go.
  React.useEffect(() => {
    setFocusedIndex((i) => Math.min(i, tinIndex));
  }, [tinIndex]);

  // Drop the open plate if its pie disappeared from under it (a bookmark
  // removed, or a user pie deleted, while its plate is open).
  React.useEffect(() => {
    if (openPieId && !pies.some((p) => p.id === openPieId)) setOpenPieId(null);
  }, [pies, openPieId]);

  // M4: consume a deep-link reveal's armed target (App.tsx). Keyed on
  // `nonce`, not `revealTarget` itself — a second reveal at the exact same
  // path/pie must still re-open/re-focus even though the OBJECT's other
  // fields would look unchanged, and a plain object-identity dep would
  // also refire on every App.tsx re-render that happens to recreate an
  // equal-by-value object.
  React.useEffect(() => {
    if (revealTarget) setOpenPieId(revealTarget.pieId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget?.nonce]);

  // ── Passive active-file mark (spec section 3: "the pie holding the
  // active tab's file carries a 2px --sky-focus rule under its label",
  // M4) ──────────────────────────────────────────────────────────────────
  const active = useActiveTab();
  const activeRawPath = currentEntry(active)?.path ?? null;
  // A stored member's path is always canonical (`pies::add_member` runs
  // `fs::canonicalize`) — the ACTIVE tab's path is not guaranteed to be
  // (it can come from a raw address-bar string, a dropped path, ...), so
  // this canonicalizes it ONCE per change and compares the result, rather
  // than every pie file doing its own resolution.
  const [activeCanonicalPath, setActiveCanonicalPath] = React.useState<string | null>(null);
  React.useEffect(() => {
    // A remote tab's address (`skypie-remote://peer/path`) is not a local
    // filesystem path — canonicalizing it would reject or resolve to
    // nonsense, and no pie member can ever BE a remote address anyway
    // (pies-context.tsx's own `openPicker` guard), so it never matches.
    if (!activeRawPath || isRemoteAddress(activeRawPath)) {
      setActiveCanonicalPath(null);
      return;
    }
    if (!ipc.canonicalizePath) {
      setActiveCanonicalPath(activeRawPath);
      return;
    }
    let cancelled = false;
    ipc
      .canonicalizePath(activeRawPath)
      .then((canonical) => {
        if (!cancelled) setActiveCanonicalPath(canonical);
      })
      .catch(() => {
        // Missing / unresolvable — no pie can hold it either way.
        if (!cancelled) setActiveCanonicalPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRawPath, ipc]);

  // ── Finder drop (M4, spec section 6) ────────────────────────────────────
  // `useFinderDrop` already resolves each Tauri drag event to a hit-tested
  // id (a pie's own, `TIN_DROP_ID`, or `null`) — this component only
  // decides what an id MEANS, not how to hit-test one.
  const [dropTargetId, setDropTargetId] = React.useState<string | null>(null);

  // `ipc.listDir` resolves for a directory and rejects (`NotADirectory`)
  // for a file (app/src/workspace.rs:56) — it is NOT gated by the root
  // set, which is what makes a folder OUTSIDE the workspace root a legal
  // drop (spec line 217). A path that no longer exists at all also
  // rejects here (canonicalize-and-check runs before the is-dir check) and
  // falls through to "file" below; the real reason then surfaces through
  // `addPieMember`'s own rejection and `onNotice`, which is good enough
  // for a drag target that vanished between the OS drop and this call.
  const memberKindOf = async (path: string): Promise<"file" | "folder"> => {
    try {
      await ipc.listDir(path);
      return "folder";
    } catch {
      return "file";
    }
  };

  const addDroppedPaths = async (pieId: string, paths: string[]): Promise<void> => {
    for (const path of paths) {
      const kind = await memberKindOf(path);
      // Every rejection reaches `onNotice` individually — one bad path in
      // a multi-file drop must not silently swallow the others' failures
      // (a bare `void` here is exactly the review finding this file
      // already carries at Sky.tsx:269 for a different call site).
      try {
        await piesCtx.addPieMember(pieId, path, kind, "finder");
      } catch (err: unknown) {
        onNotice(`Couldn't add "${basename(path)}" — ${String(err)}`);
      }
    }
  };

  const handleFinderDrop = async (targetId: string | null, paths: string[]): Promise<void> => {
    // A drop with no hit is ignored silently (M4 decision) — no ring was
    // showing over anything either, so there is nothing to explain.
    if (!targetId) return;
    if (targetId === TIN_DROP_ID) {
      const name = uniqueName(piesCtx.pies, dropPieName(paths));
      let created;
      try {
        created = await piesCtx.upsertPie(null, name);
      } catch (err: unknown) {
        onNotice(`Couldn't create "${name}" — ${String(err)}`);
        return;
      }
      // `upsertPie`'s own no-op fallback (a bare `IpcSurface` test double
      // with no `upsertPie` wired) — the real, SERVER-MINTED id is what
      // every member add below needs; a locally invented id would never
      // match what the backend actually stored.
      if (!created) return;
      await addDroppedPaths(created.id, paths);
      return;
    }
    const target = pies.find((p) => p.id === targetId);
    if (!target) return; // the tile disappeared between the ring and the drop
    if (!isUserPieId(target.id)) {
      onNotice("Pinned and Recent are built for you");
      return;
    }
    await addDroppedPaths(target.id, paths);
  };

  useFinderDrop({
    enabled: true,
    onOver: setDropTargetId,
    onDrop: (id, paths) => {
      setDropTargetId(null);
      void handleFinderDrop(id, paths);
    },
  });

  const focusTile = (index: number) => {
    const clamped = Math.max(0, Math.min(tinIndex, index));
    setFocusedIndex(clamped);
    itemRefs.current[clamped]?.focus();
  };

  /** Commit the tin's name field. The input is closed only AFTER the write
   *  lands: closing first and `void`-ing the promise threw away both the
   *  typed name and the refusal message, so a refused create looked exactly
   *  like a create that worked and then vanished. `upsert` can be refused
   *  for a document this build cannot read, and those messages exist
   *  precisely to be shown. Returns nothing; the caller does not wait. */
  const commitNewPie = async (): Promise<void> => {
    const name = newPieName.trim();
    if (!name) {
      setCreatingNew(false);
      setNewPieName("");
      return;
    }
    try {
      await piesCtx.upsertPie(null, uniqueName(piesCtx.pies, name));
      setCreatingNew(false);
      setNewPieName("");
    } catch (err) {
      // Keep the field open with the name still in it, so the user can
      // retry or copy it out rather than retype it.
      onNotice(`Couldn't create "${name}" — ${messageOf(err, "the pie could not be created")}`);
    }
  };

  // The hide/defer/undo mechanics live in `usePies` (`removePieWithUndo`,
  // whose doc comment explains why the pending-delete set has to be there
  // and not here). Sky owns only the toast that offers the undo.
  const deletePieWithUndo = (pie: DerivedPie) => {
    if (openPieId === pie.id) setOpenPieId(null);
    // The third argument reports a delete the backend refused after the
    // undo window closed: the toast already said "Deleted", so silence left
    // the user believing a pie was gone that is still on disk.
    const undo = piesCtx.removePieWithUndo(pie.id, UNDO_MS, (err: unknown) => {
      onNotice(`Couldn't delete "${pie.name}" — ${messageOf(err, "the pie could not be deleted")}`);
    });
    onNotice(`Deleted "${pie.name}"`, { label: "Undo", onClick: undo }, UNDO_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusTile(focusedIndex + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusTile(focusedIndex - 1);
        break;
      case "Home":
        e.preventDefault();
        focusTile(0);
        break;
      case "End":
        e.preventDefault();
        focusTile(tinIndex);
        break;
      case "Enter": {
        e.preventDefault();
        if (focusedIndex === tinIndex) {
          setCreatingNew(true);
          break;
        }
        const pie = pies[focusedIndex];
        if (!pie) break;
        // ⌘Enter opens the newest file directly (spec section 2's
        // keyboard model: "Enter zooms, ⌘Enter opens the newest file" — no
        // freshness condition) — bare Enter zooms into the plate, unchanged
        // from M1/M2. `openOptsFromClick(e)` reads the SAME modifier set a
        // mouse click on the pill would (see Pie.tsx/onOpenNewest below),
        // so ⌘Enter and a plain pill click agree on how the tab opens.
        // Deliberately keyed off `pie.files`, never off freshness: the
        // pill only exists when `fresh > 0`, which is never true for
        // Pinned/Recent and often false for a user pie, so gating ⌘Enter on
        // it used to make the chord silently zoom instead of open in the
        // common case. Only an EMPTY pie falls through to the zoom below.
        if (e.metaKey) {
          const path = newestPath(pie.files);
          if (path) {
            onOpenFile(path, openOptsFromClick(e));
            break;
          }
        }
        setOpenPieId(pie.id);
        break;
      }
      // Delete only — NOT Backspace. Backspace already means something else
      // one surface over (PiePlate.tsx's onLayerKeyDown clears the slice
      // filter on it, per spec section 5), and it is the reflex "go back"
      // key; binding it here too made an accidental destructive delete
      // easier, with a 5s toast as the only safety net.
      case "Delete": {
        const pie = focusedIndex < tinIndex ? pies[focusedIndex] : null;
        if (pie && isUserPieId(pie.id)) {
          e.preventDefault();
          deletePieWithUndo(pie);
        }
        break;
      }
      case "Escape":
        // Leaves the band: blurs the focused tile without hiding the band —
        // the plate owns its own Esc (useEscape) to close itself first.
        //
        // `stopPropagation` does NOT suppress App's `escape` bindings. The
        // shortcut registry listens in the CAPTURE phase on `window`
        // (keyboard/shortcuts.ts), so those bindings have already fired by
        // the time this bubble-phase handler runs. The call only keeps the
        // key from bubbling further up the React tree.
        e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur();
        break;
      default:
        break;
    }
  };

  const openPieContextMenu = (e: React.MouseEvent, pie: DerivedPie) => {
    if (!isUserPieId(pie.id)) return; // builtins carry no menu (nothing to rename/delete)
    contextMenu.open(e, [
      [
        {
          label: "Rename",
          icon: <Pencil size={13} strokeWidth={2} />,
          onSelect: () => setRenamingId(pie.id),
        },
        {
          label: "Add folder…",
          icon: <FolderPlus size={13} strokeWidth={2} />,
          onSelect: () => {
            if (!ipc.pickDirectory) return;
            void ipc
              .pickDirectory()
              .then((picked) => {
                if (!picked) return;
                // A bare `void` here used to swallow `add_member`'s own
                // rejection (a folder that stops resolving between the
                // native picker and this call)
                // with no feedback at all.
                piesCtx.addPieMember(pie.id, picked, "folder", "menu").catch((err: unknown) => {
                  onNotice(`Couldn't add that folder — ${messageOf(err, "the folder could not be added")}`);
                });
              })
              // The OUTER rejection, which had no handler at all:
              // `pickDirectory` itself can fail (the dialog plugin missing
              // from this build, a permission denied). The menu item then
              // did nothing — no dialog, and nothing said why.
              .catch((err: unknown) => {
                onNotice(
                  `Couldn't open the folder picker — ${messageOf(err, "the dialog could not be shown")}`,
                );
              });
          },
        },
      ],
      [
        {
          label: "Delete pie",
          danger: true,
          icon: <Trash2 size={13} strokeWidth={2} />,
          onSelect: () => deletePieWithUndo(pie),
        },
      ],
    ]);
  };

  /** Same shape as `commitNewPie`: the inline rename input stays open when
   *  the write is refused, and the refusal is shown. */
  const commitRename = async (id: string, name: string): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    try {
      await piesCtx.upsertPie(id, trimmed);
      setRenamingId(null);
    } catch (err) {
      onNotice(`Couldn't rename to "${trimmed}" — ${messageOf(err, "the pie could not be renamed")}`);
    }
  };

  const openPie = pies.find((p) => p.id === openPieId) ?? null;

  // Stable identities: PiePlate subscribes window `pointerdown`/`blur` in an
  // effect keyed on [onClose], so a fresh closure on every band render (one
  // per recents/bookmarks tick) would tear down and re-add those listeners
  // each time.
  const closePlate = React.useCallback(() => setOpenPieId(null), []);
  // One handler pair per pie, rebuilt only when the pie list itself changes
  // — an inline arrow in the map below is a new function on every render,
  // which is what a later `React.memo(Pie)` would trip over.
  const handlers = React.useMemo(
    () =>
      pies.map((pie, i) => ({
        onFocus: () => setFocusedIndex(i),
        onOpen: () => setOpenPieId(pie.id),
      })),
    [pies],
  );

  return (
    // The plate is a sibling of the listbox, not a DOM child of it: a
    // role="dialog" (with its own nested role="listbox" layer list) is not
    // a valid listbox child, and it used to make the band's option count
    // depend on whether a plate happened to be open.
    // This shell only exists to give the plate's `position: absolute; top:
    // 100%` the same containing block `.sky-band` used to provide.
    <div className="sky-band-shell">
      {/* The band IS the listbox — role/aria-label live on the same element
          the 120px surface styling does, not on an inner wrapper, so a
          query for ".sky-band[role=listbox]" finds one element. */}
      <div
        ref={listRef}
        className="sky-band"
        role="listbox"
        aria-label="Pies"
        onKeyDown={onKeyDown}
      >
        <div className="sky-glaze" aria-hidden />
        {/* Two separate fixed-size SVGs, positioned by CSS `left` percentage
            (22% / 71% of the band width — `.sky-cloud-1` / `.sky-cloud-2`,
            styles.css). A single
            SVG spanning the whole band with `preserveAspectRatio="none"`
            used to stretch every ellipse horizontally by paneWidth/100
            while its vertical scale stayed 1, turning each cumulus into a
            flat smear at any pane wider than the 100-unit viewBox. Only the
            CENTRE tracks the band width now; the
            shapes themselves stay a fixed size at every pane width. */}
        <Cloud className="sky-cloud-1" />
        <Cloud className="sky-cloud-2" />
        {/* role="presentation": the listbox's real options are this div's
            CHILDREN in the DOM, but an ARIA listbox only owns options that
            are its own accessible children — nesting them one div deeper
            with no role in between used to make AT report the listbox as
            empty. Presentation removes this div
            from the accessibility tree, so the Pie/tin options attach
            straight to the listbox above it. */}
        <div className="sky-pies" role="presentation">
          {pies.map((pie, i) => {
            const isUser = isUserPieId(pie.id);
            if (renamingId === pie.id) {
              return (
                <div
                  key={pie.id}
                  ref={setItemRef(i)}
                  className="sky-pie sky-pie-renaming"
                  // Keeps this slot an `option` (with the band's own roving
                  // tabIndex) while it's mid-edit — the swap to a plain
                  // `<div>` used to drop the pie out of the listbox's option
                  // count for the whole rename, and if it was the roving
                  // slot, out of the Tab order entirely.
                  role="option"
                  aria-selected={pie.id === openPieId}
                  tabIndex={i === focusedIndex ? 0 : -1}
                >
                  <Pie pie={pie} interactive={false} />
                  <input
                    className="sky-pie-rename-input"
                    defaultValue={pie.name}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      // Stop EVERY key here, not just Enter/Escape: the
                      // band's own onKeyDown (below) claims ArrowLeft/Right/
                      // Home/End for roving tile focus, which would hijack
                      // ordinary text-cursor movement while typing a name.
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename(pie.id, e.currentTarget.value);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    onBlur={() => setRenamingId(null)}
                  />
                </div>
              );
            }
            const tile = (
              <Pie
                key={pie.id}
                ref={setItemRef(i)}
                pie={pie}
                selected={pie.id === openPieId}
                dropTarget={pie.id === dropTargetId}
                active={activeCanonicalPath !== null && pie.files.some((f) => f.path === activeCanonicalPath)}
                tabIndex={i === focusedIndex ? 0 : -1}
                onFocus={handlers[i]?.onFocus}
                onOpen={handlers[i]?.onOpen}
                onContextMenu={isUser ? (e) => openPieContextMenu(e, pie) : undefined}
                onOpenNewest={(e) => {
                  // The SAME `newestPath(pie.files)` the ⌘Enter case above
                  // opens — the pill and the chord must never disagree about
                  // which file "the newest" is. And the same FALLBACK: a
                  // root change flushes the census cache, so the pill can
                  // still be on screen with `pie.files` back to its
                  // pre-census shape and no newest path to open. Clicking
                  // it then did nothing at all; it zooms instead, exactly
                  // as ⌘Enter does for an empty pie.
                  const path = newestPath(pie.files);
                  if (path) onOpenFile(path, openOptsFromClick(e));
                  else setOpenPieId(pie.id);
                }}
              />
            );
            // Tooltip.tsx clones its child, so this wrap costs the band's
            // flex layout nothing — see the component's own doc comment.
            // Content is the share string ALONE (spec section 3: "html 58%
            // · md 25% · code 17%") — the name is already the tile's
            // visible label and already in its own `aria-label`, so
            // prefixing it here just repeated it.
            return (
              <Tooltip key={pie.id} content={tileLabels[i] ?? ""}>
                {tile}
              </Tooltip>
            );
          })}
          {creatingNew ? (
            <div
              className="sky-pie sky-tin sky-tin-creating"
              ref={setItemRef(tinIndex)}
              role="option"
              aria-selected={false}
              tabIndex={focusedIndex === tinIndex ? 0 : -1}
            >
              <TinGlyph />
              <input
                data-testid="pie-name-input"
                className="sky-pie-rename-input"
                value={newPieName}
                autoFocus
                onChange={(e) => setNewPieName(e.target.value)}
                onKeyDown={(e) => {
                  // Same reason as the rename input above: claim every key
                  // here so the band's roving ArrowLeft/Right/Home/End never
                  // steals ordinary text-cursor movement while typing.
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitNewPie();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCreatingNew(false);
                    setNewPieName("");
                  }
                }}
                // Clicking away used to leave `creatingNew` true forever —
                // no blur handler meant the field just sat there focus-less.
                // The rename input above already
                // cancels the same way.
                onBlur={() => {
                  setCreatingNew(false);
                  setNewPieName("");
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              className="sky-pie sky-tin"
              data-testid="sky-new-pie"
              // NOT data-pie-id (M4 decision) — the hit test
              // (useFinderDrop.ts) and ui/e2e/m3.e2e.ts:112's
              // `.sky-pies [data-pie-id]` count both depend on the tin
              // never counting as a pie id.
              data-pie-tin="true"
              data-drop-target={dropTargetId === TIN_DROP_ID ? "true" : undefined}
              role="option"
              aria-selected={false}
              aria-label="New pie"
              tabIndex={focusedIndex === tinIndex ? 0 : -1}
              ref={setItemRef(tinIndex)}
              onFocus={() => setFocusedIndex(tinIndex)}
              onClick={() => setCreatingNew(true)}
            >
              <TinGlyph />
              <span className="sky-pie-label">New pie</span>
            </button>
          )}
        </div>
      </div>
      {openPie ? (
        <PiePlate
          // Keyed by the open pie's id — switching the plate to a
          // DIFFERENT pie (a reveal, or a click, while one is already
          // open) now remounts it, so its mount-only "focus something"
          // effect runs again for the new pie instead of leaving the old
          // pie's row/radio focused underneath the new content (review:
          // PiePlate.tsx:479).
          key={openPie.id}
          pie={openPie}
          onClose={closePlate}
          onOpenFile={onOpenFile}
          // Only when the CURRENTLY open pie is the one the reveal armed —
          // switching the plate to a different pie afterward (still
          // possible: nothing here locks the band) must not carry a stale
          // focus target into it.
          focusPath={revealTarget && revealTarget.pieId === openPie.id ? revealTarget.path : null}
          // A SECOND reveal of a file in a pie whose plate is ALREADY open
          // does not change `openPie.id` (no remount from the `key` above)
          // — this nonce is what re-runs PiePlate's focus effect in that
          // case, so the row is focused again instead of nothing happening
          // (review: PiePlate.tsx:479).
          focusNonce={revealTarget && revealTarget.pieId === openPie.id ? revealTarget.nonce : undefined}
          onFocusConsumed={onRevealConsumed}
        />
      ) : null}
    </div>
  );
}
