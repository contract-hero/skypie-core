// Sky — the pies band: a 120px strip between the toolbar and the tab view,
// toggled by the toolbar tile / ⌘⇧B and gone by default (panes.sky_visible).
// M1 shipped the two derived built-ins, Pinned and Recent. M2 adds the
// persisted user pies, the tin (create), inline rename, delete with a
// 5-second undo, and each user pie's own right-click menu (DESIGN.md, "Sky
// band"). Finder drop and folder census are M3/M4.
import * as React from "react";
import { FolderPlus, Pencil, Trash2 } from "lucide-react";
import { useBookmarksContext } from "../state/bookmarks-context";
import { useRecentsContext } from "../state/recents-context";
import { usePiesContext } from "../state/pies-context";
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
import type { OpenFileOptions } from "../state/TabsProvider";

/** How long a deleted user pie stays undoable before the removal actually
 *  reaches the backend (spec section 2, "Delete... 5-second AppNotice
 *  undo"). The notice itself is shown for exactly this long too, so the
 *  action disappears the instant it stops working. */
const UNDO_MS = 5000;

export interface SkyProps {
  ipc: IpcSurface;
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
  /** Surfaces the delete-undo toast through `AppShell`'s own `AppNotice` —
   *  Sky.tsx owns no notice UI of its own (App.tsx, "Add an optional
   *  action... Do not add a notice context"). */
  onNotice: (text: string, action?: AppNoticeAction, durationMs?: number) => void;
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

export default function Sky({ ipc, onOpenFile, onNotice }: SkyProps): React.ReactElement {
  const { bookmarks } = useBookmarksContext();
  const { recents } = useRecentsContext();
  const piesCtx = usePiesContext();
  const contextMenu = useContextMenu();

  const pies = React.useMemo<DerivedPie[]>(
    () => bandOrder([pinnedPie(bookmarks), recentPie(recents)], piesCtx.pies),
    [bookmarks, recents, piesCtx.pies],
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
        if (pie) setOpenPieId(pie.id);
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
            void ipc.pickDirectory().then((picked) => {
              if (!picked) return;
              // A bare `void` here used to swallow `add_member`'s own
              // rejection (a folder that stops resolving between the
              // native picker and this call)
              // with no feedback at all.
              piesCtx.addPieMember(pie.id, picked, "folder", "menu").catch((err: unknown) => {
                onNotice(`Couldn't add that folder — ${messageOf(err, "the folder could not be added")}`);
              });
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
                tabIndex={i === focusedIndex ? 0 : -1}
                onFocus={handlers[i]?.onFocus}
                onOpen={handlers[i]?.onOpen}
                onContextMenu={isUser ? (e) => openPieContextMenu(e, pie) : undefined}
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
        <PiePlate pie={openPie} onClose={closePlate} onOpenFile={onOpenFile} />
      ) : null}
    </div>
  );
}
