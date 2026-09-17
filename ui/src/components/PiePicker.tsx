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

export interface PiePickerProps {
  /** The path being added — a file today; M4's Finder drop is the only
   *  other add path, and it goes straight through `addPieMember`, not this
   *  component. */
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
  onClose: () => void;
}

export default function PiePicker({
  path,
  pies,
  addPieMember,
  removePieMember,
  upsertPie,
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
  // picker open+close each), not a multi-select session.
  const toggle = async (pie: Pie): Promise<void> => {
    if (holdsPath(pie, path)) {
      await removePieMember(pie.id, path);
    } else {
      await addPieMember(pie.id, path, "file", "picker");
    }
    onClose();
  };

  const commitCreate = async (): Promise<void> => {
    const name = uniqueName(pies, newName.trim() || "New pie");
    const pie = await upsertPie(null, name);
    if (pie) await addPieMember(pie.id, path, "file", "picker");
    onClose();
  };

  return (
    <div className="pie-picker-backdrop" onMouseDown={onClose} data-testid="pie-picker-backdrop">
      <div
        className="pie-picker"
        role="dialog"
        aria-modal="true"
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
