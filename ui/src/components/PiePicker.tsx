// PiePicker — the "add this path to a pie" popover (spec section 6).
// Decision: a centred popover over a TRANSPARENT backdrop, like QuickOpen's
// shell but not its scrim — MenuItem.onSelect (ContextMenu.tsx) carries no
// event, so a right-click-menu-driven open ("Add to pie…", the tile's own
// right-click) has no anchor rect to pop the picker OVER; centring sidesteps
// needing one at all. Reached from ⌘D, "Add to pie…" in every file menu,
// and the Sky tile's own right-click (Sky.tsx / App.tsx / useFileMenu.tsx /
// Toolbar.tsx) — every one of those calls `usePiesContext().openPicker`.
import * as React from "react";
import { Check, Plus } from "lucide-react";
import type { Pie, PieMemberSource } from "../ipc";
import { holdsPath, uniqueName } from "../state/pies";
import { useEscape } from "../hooks/useEscape";
import type { NoticeFn } from "../state/pies-context";
import { messageOf } from "../utils/error-message";

export interface PiePickerProps {
  /** The path being added — already canonicalized by `PiesProvider.openPicker`
   *  before this component ever mounts, so `holdsPath`'s exact-string
   *  compare lines up with the canonical member paths `pies::add_member`
   *  stores. A file today; M4's Finder drop is the
   *  only other add path, and it goes straight through `addPieMember`, not
   *  this component. */
  path: string;
  pies: Pie[];
  addPieMember: (
    id: string,
    path: string,
    kind: "file" | "folder",
    source?: PieMemberSource,
  ) => Promise<void>;
  removePieMember: (id: string, path: string) => Promise<void>;
  upsertPie: (id: string | null, name: string) => Promise<Pie | null>;
  /** Cleans up a pie `commitCreate` just minted when the follow-up
   *  `addPieMember` for it fails, so a refused add never leaves an empty
   *  pie behind. */
  removePie: (id: string) => Promise<void>;
  onNotice?: NoticeFn;
  onClose: () => void;
}

/** Tauri surfaces a rejected command as the `Err` string itself, not an
 *  `Error`; `messageOf` is this codebase's one reading of either shape, and
 *  unlike `String(err)` it never renders "[object Object]" or "undefined"
 *  at the user. */
function errorMessage(err: unknown): string {
  return messageOf(err, "that didn't work");
}

export default function PiePicker({
  path,
  pies,
  addPieMember,
  removePieMember,
  upsertPie,
  removePie,
  onNotice,
  onClose,
}: PiePickerProps): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const filterRef = React.useRef<HTMLInputElement | null>(null);
  const newNameRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    filterRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (creating) newNameRef.current?.focus();
  }, [creating]);

  // Save + restore focus across the picker's whole lifetime (PiePlate's
  // own open effect does the same) — `role="dialog"` with `aria-modal="false"`
  // here traps no Tab, so without this a keyboard user who opened the
  // picker from a tree row or a tab lost their place in the tree/tab strip
  // on close, landing on <body> instead.
  React.useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  // One press: cancel the inline "New pie…" field if it's open, else close
  // the whole picker — never both at once (useEscape's capture-phase
  // self-stop is what makes that true).
  useEscape(() => {
    if (creating) {
      setCreating(false);
      return;
    }
    onClose();
  });

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pies;
    return pies.filter((p) => p.name.toLowerCase().includes(q));
  }, [pies, query]);

  // A row click both toggles membership AND closes the picker — ⌘D /
  // "Add to pie…" is a one-shot action per spec section 6's own examples
  // ("⌘D three tabs into it" reads as three separate ⌘D presses, one
  // picker open+close each), not a multi-select session. `add_member`/
  // `remove_member` can both reject (a path that stopped resolving between
  // ⌘D and the click) — the picker used to `await` those bare, so a
  // rejection skipped `onClose()` and left the picker open with no
  // explanation; `finally` guarantees the close
  // happens either way, and the catch surfaces WHY through the notice
  // channel `Sky.tsx`'s own delete-undo already uses.
  const toggle = async (pie: Pie): Promise<void> => {
    try {
      if (holdsPath(pie, path)) {
        await removePieMember(pie.id, path);
      } else {
        await addPieMember(pie.id, path, "file", "picker");
      }
    } catch (err) {
      onNotice?.(`Couldn't update "${pie.name}" — ${errorMessage(err)}`);
    } finally {
      onClose();
    }
  };

  const commitCreate = async (): Promise<void> => {
    const name = uniqueName(pies, newName.trim() || "New pie");
    let created: Pie | null = null;
    try {
      created = await upsertPie(null, name);
      // `upsertPie` resolves `null` when the backend has no `upsert_pie`
      // command at all. Closing the picker on that looked exactly like a
      // successful create, so say so instead of silently doing nothing.
      if (!created) throw new Error("this build cannot create pies");
      await addPieMember(created.id, path, "file", "picker");
    } catch (err) {
      // The create step itself succeeded but the add failed — undo the
      // create rather than leaving an empty, unreachable pie behind. AWAIT
      // the rollback: fire-and-forget left the empty pie behind whenever
      // the rollback itself was refused, with nothing said about it.
      if (created) {
        try {
          await removePie(created.id);
        } catch (rollbackErr) {
          onNotice?.(
            `Couldn't clean up the empty pie "${name}" — ${errorMessage(rollbackErr)}`,
          );
        }
      }
      onNotice?.(`Couldn't add this file to a new pie — ${errorMessage(err)}`);
    } finally {
      onClose();
    }
  };

  return (
    <div className="pie-picker-backdrop" onMouseDown={onClose} data-testid="pie-picker-backdrop">
      <div
        className="pie-picker"
        role="dialog"
        // Not a real trap — Tab can still walk out into the toolbar/tab
        // strip behind it — so this is explicitly "false" rather than a
        // claim `aria-modal="true"` doesn't back up, the same call
        // `PiePlate.tsx` makes for its own non-trapping dialog.
        aria-modal="false"
        aria-label="Add to pie"
        data-testid="pie-picker"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={filterRef}
          type="text"
          className="pie-picker-filter"
          placeholder="Filter pies…"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Filter pies"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="pie-picker-list" role="group" aria-label="Pies">
          {filtered.map((pie) => {
            const checked = holdsPath(pie, path);
            return (
              <button
                key={pie.id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                data-pie-picker-row
                data-id={pie.id}
                className="pie-picker-row"
                onClick={() => void toggle(pie)}
              >
                <span className="pie-picker-check">
                  {checked ? <Check size={13} strokeWidth={2.5} /> : null}
                </span>
                <span className="pie-picker-name">{pie.name}</span>
              </button>
            );
          })}
          {filtered.length === 0 ? <p className="pie-picker-empty">No pies match</p> : null}
          {creating ? (
            <div className="pie-picker-row pie-picker-row-creating">
              <span className="pie-picker-check" aria-hidden>
                <Plus size={13} strokeWidth={2} />
              </span>
              <input
                ref={newNameRef}
                type="text"
                className="pie-picker-new-input"
                placeholder="Pie name"
                data-testid="pie-picker-new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitCreate();
                  }
                  // Escape is handled by the picker's own useEscape above —
                  // its capture-phase listener stops the event before this
                  // bubble-phase handler would ever see it.
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              data-pie-picker-row
              data-id="__new__"
              className="pie-picker-row pie-picker-new"
              onClick={() => setCreating(true)}
            >
              <span className="pie-picker-check" aria-hidden>
                <Plus size={13} strokeWidth={2} />
              </span>
              <span className="pie-picker-name">New pie…</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
