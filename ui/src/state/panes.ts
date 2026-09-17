// panes.ts — the hydration rule for a persisted pane posture (the sidebar's
// `panes.sidebar_visible`, the Sky band's `panes.sky_visible`). Pure, so the
// race it guards can be tested without mounting the app.

/**
 * What a persisted pane posture should set the pane to, or `null` for "leave
 * the state alone".
 *
 * `getState()` resolves asynchronously, so a ⌘B / ⌘⇧B pressed before the
 * snapshot arrives must WIN over the stored value — otherwise the snapshot
 * clobbers the toggle the user just made (`userToggled`).
 *
 * A non-boolean `persisted` (absent key, a hand-edited state.json, an older
 * document) is not an instruction either: the caller keeps its own default.
 */
export function hydratePaneVisible(persisted: unknown, userToggled: boolean): boolean | null {
  if (userToggled) return null;
  if (typeof persisted !== "boolean") return null;
  return persisted;
}
