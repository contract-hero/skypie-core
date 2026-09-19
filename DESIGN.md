---
name: Sky Pie
description: A near-black artifact reading room in the Linear idiom — a four-step surface ladder, hairline borders instead of shadows, one lavender-blue accent spent on brand, focus, links and the current-object marker, and SF Pro display type at 500–600 with negative tracking. The chrome is a dark frame; the artifact is the protagonist.
colors:
  accent: "#5e6ad2"
  accent-strong: "#828fff"
  accent-focus: "#5e69d1"
  bg: "#010102"
  bg-chrome: "#0f1011"
  bg-row-hover: "#141516"
  bg-elevated: "#18191a"
  bg-row-selected: "#191a1b"
  fg: "#f7f8f8"
  heading-fg: "#f7f8f8"
  fg-strong: "#d0d6e0"
  fg-muted: "#8a8f98"
  fg-dim: "#62666d"
  fg-path: "#8a8f98"
  label-active-fg: "#ffffff"
  on-accent: "#ffffff"
  border: "#23252a"
  border-strong: "#34343a"
  border-tertiary: "#3e3e44"
  error-fg: "#eb5757"
  code-bg: "#141516"
  code-fg: "#d0d6e0"
  pre-bg: "#0f1011"
  button-hover-bg: "#23252a"
  badge-bg: "#18191a"
  badge-fg: "#d0d6e0"
  empty-fg: "#8a8f98"
  input-bg: "#0f1011"
  input-border: "#23252a"
  input-border-focus: "#34343a"
  resizer-hover: "#5e6ad2"
  star-active: "#5e6ad2"
  star-idle: "#3e3e44"
  scrollbar-thumb: "#2c2e33"
  scrollbar-thumb-hover: "#3e3e44"
  overlay-scrim: "rgba(0, 0, 0, 0.6)"
typography:
  display-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Display\", Inter, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Display\", Inter, system-ui, sans-serif"
    fontSize: "2em"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  card-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Display\", Inter, system-ui, sans-serif"
    fontSize: "1.5em"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.003em"
  body-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.003em"
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "-0.003em"
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "-0.003em"
  eyebrow:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.4px"
  button:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0"
  mono:
    fontFamily: "\"SF Mono\", ui-monospace, SFMono-Regular, \"JetBrains Mono\", Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
components:
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.fg-muted}"
    typography: "{typography.ui}"
    padding: "0 8px 0 12px"
    height: "40px"
  tab-active:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    typography: "{typography.ui}"
    padding: "0 8px 0 12px"
    height: "40px"
  toolbar-button:
    backgroundColor: "transparent"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.sm}"
    height: "28px"
    width: "28px"
  toolbar-button-hover:
    backgroundColor: "{colors.button-hover-bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    height: "28px"
    width: "28px"
  address-input:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.fg}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: "5px 12px"
  status-badge:
    backgroundColor: "{colors.badge-bg}"
    textColor: "{colors.badge-fg}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  explorer-row:
    backgroundColor: "transparent"
    textColor: "{colors.fg-strong}"
    typography: "{typography.body-sm}"
    padding: "0 12px 0 0"
    height: "30px"
  explorer-row-selected:
    backgroundColor: "{colors.bg-row-selected}"
    textColor: "{colors.label-active-fg}"
    typography: "{typography.body-sm}"
    padding: "0 12px 0 0"
    height: "30px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-secondary:
    backgroundColor: "{colors.bg-chrome}"
    textColor: "{colors.fg}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  brand-mark:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "34px"
    width: "34px"
  eyebrow:
    backgroundColor: "transparent"
    textColor: "{colors.fg-muted}"
    typography: "{typography.eyebrow}"
  quick-open:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0"
  context-menu:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.fg-strong}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: "4px"
  context-menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.fg-strong}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  app-notice:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.error-fg}"
    typography: "{typography.ui}"
    rounded: "{rounded.lg}"
    padding: "8px 8px 8px 12px"
  code-block:
    backgroundColor: "{colors.pre-bg}"
    textColor: "{colors.fg-strong}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
  kbd-chip:
    backgroundColor: "{colors.badge-bg}"
    textColor: "{colors.fg-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "1px 5px"
---

## Overview

Sky Pie is a macOS reading room for local HTML and Markdown artifacts.
Its design language is Linear's: a near-black canvas, a four-step surface
ladder, 1px hairline borders in place of shadows, and one lavender-blue accent
spent scarcely.

The system's whole argument is that **the chrome is a dark frame and the
artifact is the protagonist**. Linear's marketing pages make that argument with
product screenshots framed in charcoal panels. This app makes it literally: an
artifact rendered in the iframe IS the screenshot, and the chrome around it is
the panel.

**Plane order, deepest first.** The reading field (`{colors.bg}`) sits at canvas
depth and the chrome (`{colors.bg-chrome}`) lifts one step above it. This
inverts the previous system on purpose. Putting the artifact on the deepest
surface means a self-contained HTML page — which almost always paints its own
background — reads as a lifted panel inside a dark frame, exactly the
relationship Linear builds between a page and a product screenshot.

**Key characteristics:**

- **Near-black canvas.** `{colors.bg}` is #010102, not `#000000`. The faint
  blue tint is intentional and is what keeps the surface from reading as a hole.
- **Four-step surface ladder** carries every hierarchy: canvas → chrome →
  row-hover → elevated → row-selected. No level is skipped.
- **Hairlines, not shadows.** Every boundary in the layout is a 1px border.
  Shadow survives only on floating overlays, which have no surface to lift
  against.
- **One lavender accent**, `{colors.accent}` #5e6ad2, with exactly four jobs.
- **Negative tracking on display, positive on the eyebrow.** The reversal is
  what marks a label as taxonomy rather than voice.
- **Two themes.** Linear ships no light marketing surface; this app must,
  because macOS system appearance is a design surface (PRODUCT.md).

## The One Lavender Rule

`{colors.accent}` does four jobs and no others:

1. **Brand and primary fill** — the monogram tile on the start page, and
   `{components.button-primary}`, the one filled button in the product.
2. **Focus ring** — every `:focus-visible` outline, and the address bar's
   focused border.
3. **Link emphasis** — Markdown links, in the lighter step.
4. **Current-object marker** — the 2px rule on the active tab, the 2px inset
   edge on the selected explorer row and the selected Quick Open row, drop
   targets during a drag, and the pulsing dot on a tab whose file is still
   loading.

Three in-product roles extend job 4 rather than adding a fifth: the bookmark
star (`{colors.star-active}`), the sidebar resizer on hover
(`{colors.resizer-hover}`), and the loading dot — each marks an object the
user singled out or the app is currently acting on.

Everything else — a quotation rule, a separator, a hover state, a badge, a
count, a file glyph — is ink or hairline. A blockquote edge takes
`{colors.border-strong}`, not the accent.

### Accent steps

- `{colors.accent}` #5e6ad2 — structural markers and filled CTAs. Holds 4.4:1
  on canvas, which clears the 3:1 a non-text marker needs.
- `{colors.accent-strong}` #828fff — hover on a filled CTA, and **all body-text
  links**. #5e6ad2 lands at 4.4:1 on canvas, just under the 4.5:1 text has to
  hold; #828fff clears 7.2:1.
- `{colors.accent-focus}` #5e69d1 — the focus ring and the pressed CTA.

## Colors

### Surface ladder

| Token | Value | Role |
|---|---|---|
| `{colors.bg}` | #010102 | Reading field, active tab, iframe backdrop |
| `{colors.bg-chrome}` | #0f1011 | Sidebar, toolbar, tab strip, table headers, code blocks |
| `{colors.bg-row-hover}` | #141516 | Row hover, inline code |
| `{colors.bg-elevated}` | #18191a | Quick Open, context menu, toast, badges |
| `{colors.bg-row-selected}` | #191a1b | Selected row, selected menu item |

### Hairlines

| Token | Value | Role |
|---|---|---|
| `{colors.border}` | #23252a | Every boundary in the layout — pane seams, band rules, table cells, code-block edges |
| `{colors.border-strong}` | #34343a | Floating-overlay edges, hovered button edges, blockquote rule, focused input |
| `{colors.border-tertiary}` | #3e3e44 | Idle bookmark star, scrollbar thumb on hover |

### Ink ladder

| Token | Value | Role | Floor |
|---|---|---|---|
| `{colors.fg}` | #f7f8f8 | Headings, active labels, primary chrome text | — |
| `{colors.fg-strong}` | #d0d6e0 | Reading-field body, explorer file labels, menu items | — |
| `{colors.fg-muted}` | #8a8f98 | Secondary chrome, eyebrows, captions, hints | 5.4:1 on the lightest surface |
| `{colors.fg-dim}` | #62666d | Decoration and disabled only — chevrons, close/remove buttons, file glyphs, disabled buttons | 3.1:1 — never carries text a user must read |
| `{colors.fg-path}` | #8a8f98 | Directory paths | 4.5:1 everywhere, by definition |

`{colors.fg-path}` holds the same value as `{colors.fg-muted}`. It stays a
separate token because paths are the information that tells two same-named
artifacts apart, so their contrast floor is a constraint worth naming and
checking. In the previous palette that constraint forced a distinct value; on
this ladder `{colors.fg-muted}` already satisfies it.

`{colors.fg-dim}` is the one token that does not clear 4.5:1. It is allowed on
decoration and disabled states only. Informational micro-text — the Quick Open
footer, the bookmarks empty hint, the start-page subtitle, section eyebrows —
uses `{colors.fg-muted}`, whose light value is set by the tightest pairing it
has to survive: a path on a hovered or selected row (4.52:1 on
`{colors.bg-row-selected}`).

### Semantic

- Linear's one documented semantic, success green (#27a644), has **no role in
  this product yet**, so it is recorded here and not declared in the stylesheet.
- `{colors.error-fg}` #eb5757 — Linear's source lists error styling as a known
  gap. This is Linear's in-product red; it clears 5.9:1 on canvas. It is not a
  second accent: it appears only on failure text (unreadable file, rejected
  deep link, destructive menu item, bookmark removal on hover).

### Light theme

Derived from Linear's documented inverse tokens (`inverse-canvas`,
`inverse-surface-1/2`, `inverse-ink`). The plane relationship is preserved: the
reading field is the extreme (`#ffffff`), the chrome one step in (`#f0f1f3`).

The source's `inverse-surface-1` is `#f5f6f6`, only 2% off white. Across a full
window that reads as one flat field rather than as two planes, so the chrome and
the hairlines each take one extra step: chrome `#f0f1f3`, hairline `#dcdee3`.
This is a documented deviation, taken because the dark theme's plane separation
has to survive the theme switch.

| Token | Dark | Light |
|---|---|---|
| `{colors.bg}` | #010102 | #ffffff |
| `{colors.bg-chrome}` | #0f1011 | #f0f1f3 |
| `{colors.bg-row-hover}` | #141516 | #e5e7eb |
| `{colors.bg-row-selected}` | #191a1b | #dcdfe6 |
| `{colors.border}` | #23252a | #dcdee3 |
| `{colors.border-strong}` | #34343a | #c5c8d0 |
| `{colors.fg-muted}` | #8a8f98 | #5f636b |

The accent does not change hue across themes — #5e6ad2 holds 4.7:1 on white.
Only the emphasis step darkens, to `#4a55b8`.

## Typography

### Families

| Token | Stack | Role |
|---|---|---|
| display | `-apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, system-ui` | Wordmark, brand mark, Markdown headings, file-notice title |
| ui | `-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui` | Everything else |
| mono | `"SF Mono", ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo` | Paths, address bar, code, kbd chips, metadata |

Linear Display and Linear Text are proprietary. On macOS the documented
substitute is SF Pro, which `-apple-system` resolves to exactly; Inter is the
cross-platform fallback the source names. Display and Text are treated as one
continuous voice — the family change is silent.

There is **no serif anywhere**. The previous system spent New York on the
wordmark; this one carries the wordmark with the display cut at weight 600 and
tracking pulled to -0.025em. Weight and tracking are the whole gesture.

### Scale

Linear's published scale is a marketing scale. The chrome of a dense desktop app
lives one step below its body size, so the ramp is anchored differently: the
**reading field** takes Linear's `body`, and the **chrome** takes a 13px step
between `caption` and `body-sm`.

| Token | Size | Weight | Tracking | Use |
|---|---|---|---|---|
| `{typography.display-md}` | 40px | 600 | -0.025em | The wordmark. One instance in the product. |
| `{typography.headline}` | 2em | 600 | -0.03em | Markdown `h1` |
| `{typography.card-title}` | 1.5em | 600 | -0.02em | Markdown `h2` |
| `{typography.body}` | 16px | 400 | -0.003em | Reading field, Quick Open input, file-notice title |
| `{typography.body-sm}` | 14px | 400 | -0.003em | Explorer rows, start rows, menu items, bookmarks, tables |
| `{typography.ui}` | 13px | 400 | -0.003em | Chrome default — tabs, sidebar header, toolbar, address bar |
| `{typography.caption}` | 12px | 400 | -0.003em | Paths, badges, hints, footers, kbd chips |
| `{typography.eyebrow}` | 12px | 500 | **+0.4px** | Section labels |
| `{typography.button}` | 14px | 500 | 0 | All button labels |
| `{typography.mono}` | 13px | 400 | 0 | Code, plain text, metadata |

### The eyebrow reversal

Every other step in the ramp tracks negative. The eyebrow tracks **positive**,
at +0.4px, weight 500, sentence case. That reversal is the whole signal — it is
what marks "Bookmarks" or "Recent" as taxonomy rather than voice.

It replaces the uppercase 10–11px/700 micro-caps of the previous system. Do not
reintroduce `text-transform: uppercase`; the tracking carries the job.

## Layout

### Spacing

Base unit 4px. Tokens: 4 · 8 · 12 · 16 · 24 · 32.

### Fixed bands

The window is a row: a full-height sidebar, then the preview column. Band
heights are structural and do not scale:

- **40px** — the sidebar header and the tab strip. Equal by requirement: they
  sit side by side at the very top of the window, so their bottom borders
  must form one unbroken rule rather than a 1px step at the sidebar seam.
  The sidebar header is the overlay title bar on the left: it carries
  `data-tauri-drag-region` and a **78px left inset** that keeps the macOS
  traffic lights clear. The tab strip belongs to the preview column only —
  tabs align with the reading field and never cross into the sidebar. (A
  full-window strip was tried; it pushed the sidebar header down and left a
  dead 78px gutter as the strip's only occupant before the first tab.)
- **40px** — the toolbar, under the tab strip.
- **30px** — an explorer row.

When the sidebar is hidden (see View modes), the tab strip is the leftmost
band and takes the 78px traffic-light gutter back as a sticky, opaque spacer
before the first tab.

### View modes

Two subtractive modes serve the product's north star — distraction-free
reading of local artifacts. Both are keyboard-first with a toolbar affordance:

- **⌘B** hides/shows the sidebar (PanelLeft button, far left of the toolbar).
  Persisted (`panes.sidebar_visible`) — a workspace posture.
- **⇧⌘F** is reader mode: sidebar AND toolbar gone, tabs + document only
  (BookOpen button, far right). Esc, ⇧⌘F, ⌘L, or ⌘B leaves it — all but ⌘L
  also cross the iframe bridge, so they work with focus inside a preview
  (⌘L is deliberately not forwardable). Deliberately transient — a reading
  posture, never persisted.

Chrome is only removed, never re-flowed: the reading field keeps its position
and the tab strip keeps its shape, except for the traffic-light gutter the
strip inherits while the sidebar is gone. ⌘B from reader mode is the one
intentional exception to "restore the prior layout" — it exits with the
sidebar on, because that is what the key asks for.

### Panes

The sidebar is the only elastic axis: 200px minimum, 480px maximum. The reading
field takes the rest.

The sidebar stacks a fixed header over three collapsible drawers of one
shape (SidebarSection: eyebrow header, chevron, optional count): **Bookmarks**
(pinned), **Recent** (last 8 opened — the self-maintaining working set), and
**Files** (the whole workspace tree, folded by default: a project root is a
directory listing, not a reading list). Retrieval order is Bookmarks → Recent
→ ⌘P; the tree is for walking a project. Collapse state persists per-drawer
in localStorage. Empty sections degrade: Bookmarks shows a static heading and
a hint, Recent hides itself until a file is opened. Only the drawers scroll;
the header — which owns the traffic-light inset and the drag region — stays
pinned.

The resizer is an **overlay, not a column**. It takes zero width in the layout
and carries its 6px pointer target in a pseudo-element straddling the seam,
painting `{colors.resizer-hover}` at 60% opacity while hovered or dragging. As a
6px flex item it opened a transparent gap that ran the full height of the
window — including straight through the chrome bands, where it broke the very
rule those band heights exist to produce.

There are no responsive breakpoints. This is a macOS window on one machine, not
a page. (The planned read-only iOS companion is a separate surface: it inherits
the visual language — tokens, type, the artifact-as-protagonist stance — but
will need its own touch-and-narrow layout rules, out of scope for this desktop
system.)

### Reading measure

The start page holds a 560px column. The reading field imposes no measure — an
artifact controls its own layout, and clamping it would break the fidelity the
product exists to deliver.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 | No border, no shadow | Reading field, body text |
| 1 | `{colors.bg-chrome}` + 1px `{colors.border}` | Sidebar, toolbar, tab strip, code blocks |
| 2 | `{colors.bg-row-hover}` | Hovered rows |
| 3 | `{colors.bg-elevated}` + 1px `{colors.border-strong}` + shadow + edge highlight | Quick Open, context menu, toast |
| 4 | 2px `{colors.accent-focus}` outline, -2px offset | Focus |

### The edge highlight

Lifted panels carry `inset 0 1px 0 rgba(255, 255, 255, 0.06)` on their top
edge. It is a single hairline of white light and it is the system's signature
detail — the thing that makes a dark panel read as rendered rather than as an
absence. Apply it to floating overlays only.

### On shadows

Linear resists drop shadows on dark almost entirely, and so does this system.
The three floating overlays keep one because they have no surface below them to
lift against. Their shadow is **pure black** — a tinted shadow would introduce a
hue the palette does not contain.

Nothing that sits inside the layout gets a resting shadow.

### On the focus ring

Linear specifies a 2px `primary-focus` ring at 50% opacity. At 50% over a
#010102 canvas that lands near 1.9:1 against the surface it marks — below the
3:1 a focus indicator has to hold. **The ring ships solid.** The size, color and
role are the source's; the alpha is a documented deviation, taken for
accessibility.

## Shapes

| Token | Value | Use |
|---|---|---|
| `{rounded.xs}` | 4px | kbd chips, tab close, notice dismiss, bookmark remove, sidebar header change, inline code, focus-ring radius |
| `{rounded.sm}` | 6px | Toolbar buttons, menu items, list rows, Quick Open rows |
| `{rounded.md}` | 8px | All buttons, all inputs, code blocks, the brand mark |
| `{rounded.lg}` | 12px | Floating overlays — Quick Open, context menu, toast |
| `{rounded.pill}` | 9999px | Status badges, the zoom control, the loading dot, scrollbar thumbs |

Pills are for **status**, never for actions. A CTA is 8px, always — Linear's
"don't pill-round CTAs" holds here.

## Components

### Tabs

The active tab drops to `{colors.bg}` — canvas depth — and carries the 2px
lavender rule on its top edge. Because the 40px toolbar band sits between the
strip and the reading field, the active tab does not physically join the
field; the canvas fill and the lavender rule carry the state on their own
(and keep carrying it in reader mode, where the toolbar is gone).

An inactive tab is transparent over `{colors.bg-chrome}` and lifts to
`{colors.bg-row-hover}` on hover. A tab loading its file shows a 6px lavender
dot pulsing between 25% and 100% opacity.

The close button sits at `opacity: 0` until the tab is hovered, active, or the
button itself holds focus. A focusable control must be visible when focused —
an invisible button in the tab order is a target the keyboard reaches and the
eye cannot find.

### Explorer rows

30px, 14px type, `{colors.fg-strong}`. Folders take `{colors.fg}` at weight 500;
files take `{colors.fg-strong}` at 400 and step to `{colors.label-active-fg}` on
hover.

Selection is **a surface lift plus the current-object marker** — a single step
on this ladder cannot carry the state alone, so `{colors.bg-row-selected}` pairs
with a 2px lavender inset edge. Never fill a row with the accent.

File glyphs carry shape, never hue. Two tones only: `is-subject` marks the
artifacts this app exists to read (`.html`, `.md`) and sits one ink step
brighter; everything else recedes. Both step up together on hover so the glyph
follows its row instead of competing with it.

### Buttons

`{components.button-primary}` is the one filled button in the product — the
first-run workspace picker and the actions on a file notice. Lavender fill,
white label, 8px corners, 8px/14px padding, label at 14px weight 500. Hover
lifts to `{colors.accent-strong}`; pressed drops to `{colors.accent-focus}`.

`{components.button-secondary}` is charcoal: `{colors.bg-chrome}` fill,
`{colors.border}` hairline, ink label. Its hairline strengthens on hover.

### Address bar

Mono type on `{colors.input-bg}`, 8px corners, hairline border that strengthens
to `{colors.input-border-focus}` on focus. A path is machine text; it is set in
mono everywhere it appears — address bar, explorer path column, Quick Open
directory, metadata renderer, file-notice path.

Idle, the bar shows the **workspace-relative** path — the absolute prefix is
identical on every workspace file and says nothing. Focus swaps in the full
absolute path and selects it, so editing always operates on the real path and
the swap is never mistaken for a caret jump. Out-of-root files stay absolute
and keep the `external` badge.

### Floating overlays

Quick Open, the context menu and the toast share one shape: `{colors.bg-elevated}`
fill, 12px corners, `{colors.border-strong}` hairline, shadow, edge highlight.
The scrim behind Quick Open is pure black — 60% in dark, 25% in light.

Their order is a scale, not a set of numbers: `--z-sheet` (the iOS bottom
sheets) → `--z-overlay` (app-modal: Quick Open, Settings) → `--z-popover`
(anchored to its trigger) → `--z-overlay-raised` (an overlay that must be
readable OVER another one — the pairing dialog, which arrives while Settings
is open) → `--z-menu`. A new overlay picks a token, never a fresh number.

Quick Open truncates paths at the **tail**; the start page truncates at the
**head**. The difference is not decoration. Quick Open paths are relative to the
workspace root, so the leading segment is the repo name — the one part that
disambiguates two files with the same name. Start-page recents can be absolute
paths sharing a long `/Users/…/workspace/` prefix, so there the head is the part
worth dropping.

### Settings

One panel, two hosts. On macOS it is a centered dialog over the scrim, opened
from the sidebar gear; on iOS it is the same bottom sheet the Library and the
tab list use, opened from the Library sheet. The markup does not fork — only
the host and the section list do — so the two shapes cannot drift apart.

Inside, every section is a hairline card with a title, an optional caption of
explanation, and rows that read label-left / control-right. Lists of roots,
globs and peers all sit in the same bordered list, so three different
collections read as one kind of object. The only new control is the switch: a
checkbox wearing the platform's affordance, because a 13px tick box is not a
touch target.

Destructive actions (Remove, Unpair) are secondary buttons in
`{colors.error-fg}`. They are the only place the error hue appears outside an
error message, and the reason is the phone: a mis-tap there costs a pairing.

The phone shows the Remote section and nothing else. Roots, the ignore set,
drag-out and the Slack target all act on a local workspace or a macOS share
sheet, and the companion has neither.

### Start page

A brand mark and a wordmark, then actions, then bookmarks and recents. The mark
is a 34px lavender tile at 8px corners carrying the monogram in the display cut.
It is the only filled lavender surface in the product besides the primary button.

### Markdown

The reading field runs `{typography.body}`: 16px, line-height 1.5. Headings step
to the display cut at weight 600 with tracking pulling negative as size grows.
`h1` and `h2` keep a hairline bottom rule — the same gesture Linear's changelog
rows use.

## Do's and Don'ts

### Do

- Keep `{colors.bg}` at #010102. The faint blue tint is the point.
- Move one step at a time on the surface ladder.
- Draw every in-layout boundary as a 1px hairline.
- Spend lavender on the four jobs in The One Lavender Rule, and count them.
- Pull tracking negative on display, positive on the eyebrow.
- Pair a surface lift with the 2px marker to say "current".
- Give floating overlays the edge highlight.
- Set paths in mono, everywhere.
- Keep `{colors.fg-dim}` off anything a user has to read.

### Don't

- **Don't** use `#000000` as the canvas.
- **Don't** introduce a second chromatic accent. Red is failure, not color;
  green is the one documented semantic and appears nowhere yet.
- **Don't** use lavender as a section background, a row fill, or a hover state.
- **Don't** fill an element with the accent to say "selected". Use the 2px
  marker and a tone step.
- **Don't** put a resting shadow on a surface that sits inside the layout.
- **Don't** tint a shadow. Pure black only.
- **Don't** reintroduce a serif, or any second display family.
- **Don't** reintroduce uppercase micro-caps. The eyebrow's positive tracking
  is the label signal.
- **Don't** pill-round an action. Pills mark status.
- **Don't** add atmospheric gradients, spotlight cards, `backdrop-filter`, or
  translucent chrome. Surfaces are opaque.
- **Don't** give file-type glyphs per-language colors. Shape carries the type.
- **Don't** let chrome grow with the window, and don't add breakpoints. The
  sidebar split is the only elastic axis.
- **Don't** put a transient message in the layout column, where its arrival and
  expiry move the artifact under the reader's eyes.
- **Don't** show a machine error kind as a headline. Name the problem, then
  offer the raw reason as detail.

## Sky band

The Sky band (⌘⇧B, `panes.sky_visible`) is a 120px strip between the toolbar
and the tab view that shows the built-in pies — Pinned and Recent in M1. It
borrows more from the surface language than any other part of the product,
so this section names every departure and the limit that keeps it from
spreading.

M2 adds the user's own pies to the same band, and they reuse the surface
above rather than introducing a second one. The **tin** — the band's last
slot, a dashed hairline circle labelled "New pie" — is the only new glyph,
and it is hand-drawn for the same reason `FileGlyph` is: no icon set carries
an "empty pie". Creating and **renaming** both happen in place, swapping the
tile's label for a text input inside the same listbox option, so the band's
roving focus and its option count never change shape mid-edit. **Delete**
is optimistic with a 5-second undo offered through the app's one notice
toast; nothing new is drawn for it. Each tile carries a **tooltip** after a
400ms delay whose content is the share summary alone ("html 58% · md 25% ·
code 17%") — the name is already the tile's visible label. The **picker**
(⌘D, "Add to pie…") is a centred popover over a transparent backdrop, not a
scrim: it is a one-shot action, and dimming the whole window for one click
would read as a modal the product does not have. `--sky-focus` does one more
job here than the bullet below states: it is also the 2px stroke on the cut
wedge in the plate, so "the thing you chose" reads the same whether it is a
focused tile or a cut slice.

- **A gradient.** The top 32px of the band is a linear gradient from
  `{colors.bg-chrome}` into `--sky` — the one exception to "Don't add
  atmospheric gradients" (line 690). The limit is exactly those 32px: below
  the glaze the band is flat, opaque `--sky`, and the pie plate that drops
  from it is flat and opaque too — no gradient, no `backdrop-filter`.
- **A warm hairline.** The crust ring on every pie (`#c89a5c`) is the one
  warm stroke in the product. The limit is the word "stroke": it is a 1px
  ring, never a fill, a text color, or a hover state, so it reads as a rim
  on a surface rather than a second chromatic accent alongside lavender.
- **Ink-step wedge tones.** A pie's wedges are steps between `--sky-ink` and
  `--sky`, not per-kind hues — the same shape-carries-meaning rule that
  keeps `FileGlyph` colorless (line 692) applies to a wedge: its kind reads
  from compass bearing and position, never from a palette.
- **A persisted posture.** Showing the band moves the reading field down by
  120px, which "Chrome is only removed, never re-flowed" (line 463) reserves
  for reader mode's transient chrome. The band is not that: like
  `panes.sidebar_visible` moving the reading field sideways, it is a layout
  choice the user sets once and the app never toggles on its own. Reader
  mode still strips it with the rest of the chrome. The phone has no
  toggle at all (M6, below): there `panes.sky_visible` is not read, and the
  band's presence follows content — it shows whenever the derived Received/
  Shared pies hold at least one file and is gone otherwise. The limit that
  matters there is narrower than "the app never toggles on its own": the
  band may come and go on its own, but it never moves an OPEN artifact —
  only the phone's own start page, which is not reading chrome.
- **A per-theme accent shade.** `--sky-focus` does the focus ring's job with
  its own value per theme (`#3b45b8` day, `#8b93e8` dusk), because
  `{colors.accent-focus}` falls under 3:1 non-text contrast on the day
  `--sky` field. Same job as the one accent's focus role, a shade chosen per
  surface rather than a second color.
- **A window-height breakpoint.** Below a 480px pane (`usePaneShort`,
  `PiePlate.tsx`) the plate's pie drops from 200px to 120px — the one
  exception to "Don't let chrome grow with the window, and don't add
  breakpoints" (line 693). The limit is ONE threshold: the pie diameter is
  the only thing it switches, and the 120px band height never changes. The
  plate's own box does track the window continuously (`width: min(720px,
  100% − 32px)`, `height: clamp(280px, 100vh − 232px, 440px)`), and its layer
  list scrolls at every height — but nothing else in the band reflows, and
  no second breakpoint is added. Owner decision: below a 480px pane the
  plate uses this floor geometry.

The plate's mono readout uses `{colors.fg-muted}`, not `{colors.fg-dim}`
(line 674's "keep fg-dim off anything a user has to read"). Two labels in
the plate are a scoped exception and do use `{colors.fg-dim}`:
`.pie-plate-recency` and the layer rows' `.start-row-mtime`. Both are
secondary timestamps beside the name they qualify, never the only text in
their row, and the exception stops there — no other Sky band text takes
`fg-dim`.

**M3 — the layer list becomes a tree.** When a pie has any folder member,
the layer list (spec section 5) switches from a flat `role="listbox"` to
`role="tree"`: one folder-member header per layer at `role="treeitem"
aria-level="1"`, its files at `aria-level="2"`, in the SAME stored member
order the band itself uses. A pie with no folder members keeps the flat
listbox unchanged — the tree is additive, not a replacement shape. This is
an accessibility floor, not a new visual language: the header is set in
`{typography.mono}` on `--sky-ink-dim`, the same ink-ladder rule
every other Sky band label already follows, and the captions next to it are
plain text. "folder not found" adds two small buttons (Locate…, Forget)
styled like every other secondary control in the product; "can't read this
folder" adds Forget alone, since a folder that has not moved has nothing to
be re-pointed at; "not live" adds no button at all — it states a refresh
policy, and there is nothing for the reader to act on. No new departure is
introduced. The one exception already
covered above stays the limit: no gradient, no fill, no per-kind hue
anywhere in the tree either.

**M4 — Finder drop, the drop ring, the active-file mark, short/narrow
plate.** Four additions, none a new departure — every color below is
`--sky-focus`, spent on a second and third job rather than a new one.

- **The drop-target ring.** While a Finder drag is over a pie or the tin
  (`useFinderDrop`'s `over` stream, hit-tested by dividing physical pixels
  by `devicePixelRatio` and walking up to `[data-pie-id]`/`[data-pie-tin]`
  — never DOM `dragover`, which does not fire for an OS-level drag),
  `data-drop-target="true"` draws the SAME rule `.sky-pie:focus-visible`
  already uses: `2px solid var(--sky-focus)`, `2px` offset, `--r-sm`
  radius. One ring, two triggers (keyboard focus, a live drag) — not a
  second departure.
- **The passive active-file mark.** The pie holding the ACTIVE tab's file
  (spec section 3's "passive auto-reveal", drawn from M1 but unbuilt until
  now) carries `data-active-file="true"`, rendered as `box-shadow: 0 2px 0
  var(--sky-focus)` under the label — an underline, not a box around the
  tile, so it reads as a mark on the NAME rather than a second selection
  state competing with `:focus-visible`/`.selected`. Remote addresses
  (`skypie-remote://…`) never match — a pie's file paths are always local.
- **Finder drop.** `getCurrentWebview().onDragDropEvent()` — a dropped
  path keeps its exact basename as the new pie's name (via `uniqueName`),
  a member's kind (file/folder) is resolved in Rust from the canonical
  path `add_pie_member` already holds (`is_dir()` — `kind` is OPTIONAL on
  that command, and only a caller that already knows its answer, the
  picker or "Add folder…", still sends one), and every member is stored
  with `source: "finder"`. That canonicalisation gate is not restricted to
  the root set, so a folder outside the workspace is a legal drop per spec
  line 217. A drop on Pinned/Recent
  is refused with a notice; a drop with no hit under it is ignored
  silently — both M4 owner decisions, not new visual language.
- **The plate's short/narrow floor.** `usePaneShort` (M3, pane height
  `< 480px`) is joined by `usePaneNarrow` (WINDOW width `<= 760px` —
  `window.innerWidth`, not the narrower pane the sidebar leaves once it is
  open; same `matchMedia` shape, a SEPARATE threshold — a short-but-wide
  window and a narrow-but-tall one overflow at different points): the
  legend scrolls in its own box instead of pushing the layer list off the
  bottom, and the left rail (pie + readout) narrows from 240px to 140px so
  the right column keeps room to read a filename. EITHER posture drops the
  plate's pie disc from 200px to 120px — `narrow`, not only `short`: the
  rail it sits in is 140px wide under `.pie-plate-narrow`, and `narrow` can
  be true while `short` is false (a narrow-but-tall window), where a 200px
  disc would overflow its own rail. Both
  are the SAME "window-height breakpoint" exception the spec already
  grants the plate's pie diameter (line 733 above) — a width axis added to
  the same one exception, not a second one. Floor verified at 640×400 (the
  window's own `minHeight`, shell `tauri.conf.json`) by arithmetic against
  the plate's existing `clamp(280px, calc(100vh - 232px), 440px)`: at
  100vh = 400px the clamp already bottoms out at 280px, unchanged by this
  milestone. Live-resize verification was not possible from the e2e
  harness — `core:window:allow-set-size` is deliberately not in this app's
  capabilities, and granting it is a shell-repo change out of scope here —
  so `ui/e2e/m4.e2e.ts`'s own geometry step reads the CSS instead of
  driving a captured screenshot: it parses the shipped `clamp(...)` off
  `styles.css` itself (not a retyped copy, so a formula edit fails the
  check), confirms it still bottoms out at 280px by 100vh = 400px, and
  cross-checks the plate's live computed height and `.pie-plate-short`/
  `.pie-plate-narrow` classes against the harness's own real window size.
- **Dusk/day reviewed side by side.** `--sky`, `--sky-ink`, `--sky-cloud`,
  `--sky-focus` all read back exactly the spec's table in both themes
  (`data-theme="dark"`: `#16212f` / `#e6edf5` / `#213040` / `#8b93e8`;
  `"light"`: `#cfe3f6` / `#1d2a3a` / `#eef5fb` / `#3b45b8`), and the new
  drop ring / active-file mark render in the theme's own `--sky-focus`
  shade in both, not the generic lavender — confirming the whole reason
  that token exists (`#5e6ad2` fails 3:1 non-text contrast on the day
  `--sky`) still holds for these two new consumers. Asserted against the
  live, running app (not just read by eye) by `ui/e2e/m4.e2e.ts`'s closing
  step, which forces `<html data-theme>` and reads the computed styles
  back for both themes.

**M6 — the phone band.** The iOS companion has no toolbar to toggle the
band with, so `IosStartPage.tsx` renders it, with no toggle, at the top of
the start page instead — SAME `.sky-band`/`.sky-glaze`/`.sky-cloud`/
`.sky-pies` markup as the macOS band (`SkyClouds.tsx` is the two cumulus,
shared verbatim between both), still exactly 120px and never elastic, just
flush under the phone's own title band rather than under a toolbar. It is a
SIBLING of `.start-page-inner`, above it, not its first child: full-bleed
chrome belongs outside the start page's padded 560px column, and put in
that parent it needs no negative margins or `100vw` clawback to reach the
screen edges. The one band rule iOS overrides is the gap before the
wordmark below it. Three
things this milestone deliberately leaves OUT, each because the phone has
no counterpart for what it would mean:

- **No tin.** The phone writes nothing — there is no folder to feed a
  user pie and nowhere to drop one — so its two pies are both derived
  (`Received`, and one `Shared from <Mac>` per ONLINE paired peer),
  never persisted, exactly like Pinned/Recent on macOS.
- **No freshness pill.** A derived pie carries no `seen_at`, so `Pie.tsx`
  never draws a `+N` — the same rule Pinned/Recent already follow, applied
  here by construction (`ios-pies.ts`'s two builders leave `fresh` unset)
  rather than a runtime check.
- **No persistence.** `panes.sky_visible` has nothing to gate on iOS —
  the band is either present (at least one non-empty derived pie) or
  entirely absent, never a user-toggled posture.

One more thing the phone does not inherit: the M1 rule that hides a band
tile's own disc while its plate is open. That rule is keyed on
`.sky-band-shell`, the wrapper that IS the plate's containing block — the
plate is `position: absolute; top: 100%` inside it — so the rule applies
exactly where a plate can exist, and the phone's band, which sits in no
such wrapper, keeps its disc visible behind the sheet. Structure, not a
`body.platform-*` class: where the band is mounted is what decides.

Tapping a pie does not drop a plate — a plate assumes a pane wide enough
to hold two columns beside the band it dropped from, which a phone is not
— it opens a `PhonePieSheet.tsx` bottom sheet instead: the pie at 200px,
a `labelOfWedges` readout, and a plain row list at the platform's own 44px
tap target (`body.platform-ios .start-row`, already the phone's rule for
every other retrieval list). No legend radiogroup, no slice filter, no
layer tree — a phone screen has room for one list, not two panes of one.

## Known Gaps

- Success green is recorded above but not declared. Nothing in the product
  reports success as a state yet.
- Framing the iframe in a 16px panel would complete Linear's product-screenshot
  idiom, but it costs reading width, so the scale stops at 12px.
- Shiki keeps `github-dark` / `github-light` for syntax highlighting, so the
  token hues inside a code block are GitHub's, not Linear's. Shiki writes an
  inline `background-color`, which beats any selector, so both paths force the
  surface back: `.shiki-block` (plain source files) to transparent, and
  rendered Markdown to `{colors.pre-bg}` with `!important`.
