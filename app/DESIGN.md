# Design tokens and components (use the same names in Figma)

All values live in `tokens.css` (`:root`, with a `prefers-color-scheme: dark` override). `style.css` only references these.

## Colours (light / dark)
| token | light | dark |
|---|---|---|
| --color-bg | #f4f2ee | #17171a |
| --color-surface | #fbfaf7 | #1f1f24 |
| --color-surface-2 | #e9e6df | #26262c |
| --color-fg | #1e1d1a | #ecebe6 |
| --color-muted | #7a766e | #9a978f |
| --color-line | #d9d5cc | #34343b |
| --color-accent | #2f6df6 | same |
| --color-accent-fg | #ffffff | same |
| --color-danger | #c8322b | same |
| --color-warning-bg / --color-warning-line | #fff4e5 / #f2d6a2 | #3a2f1a / #6b5426 |
| --color-error-bg / --color-error-line | #fdecec / #f0b4b4 | #3a1e1e / #6b2f2f |
| --color-overlay | rgba(244,242,238,.9) | rgba(23,23,26,.9) |
| --color-note-bg / --color-note-fg | #1e1d1a / #f4f2ee | #ecebe6 / #17171a |

Peer colours (cursor dots, brush preview, stroke labels) are per user, not tokens: `#e6194b #3cb44b #4363d8 #f58231 #911eb4 #42d4f4 #f032e6 #9a6324 #800000 #469990`.

## Type
--font-family (system sans) · --font-mono · --font-size-xs 12 · -sm 13 · -md 15 · -lg 18 · -xl 28 · --line-height 1.45 · --font-weight-strong 600

## Spacing
--space-1 4 · --space-2 8 · --space-3 12 · --space-4 16 · --space-5 20 · --space-6 28

## Shape and depth
--radius-sm 6 · --radius-md 8 · --radius-lg 12 · --radius-pill 999 · --border (1px line) · --shadow-1 · --shadow-2

## Controls and layout
--control-height 36 · --control-padding 8px 14px · --panel-width 300 (100% on phones) · --progress-height 6 · --transition .15s

## Canvas overlay
--brush-alpha .35 (own brush preview) · --painting-alpha .15 (strokes in progress) · --cursor-size 6 · --z-overlay 5 · --z-note 10

## Components (`app/components/`, plain DOM, one `mountX(el, props)` each)
- **topbar** — title, room id, Invite button, peer chips (dot + name, ✎ when painting), activity line ("Ann is painting … for Bob"), connection status.
- **panel** — Note/prompt textarea, Brush size segmented control (4×4 / 6×6 / 8×8), Effort segmented control (quick 5s / normal 10s / long 20s), Undo my stroke, Stop, Export PNG + notes, Clear canvas, progress bar, status line, stats line.
- **canvas** — the painting canvas + overlay (peer cursors with names, own brush blob, in-progress stroke masks with labels). Desktop: drag paints, hover reads. Touch: drag paints, tap reads.
- **note** — popover over the canvas: author dot + name · time, then the note text.
- **loading** — overlay on the canvas: headline, progress bar, sub line (MB, "from cache", WebGPU warning).
- **landing** (`index.html`) — title, one-line description, WebGPU notice, "Create a room" card (name field + button), "Join a room" card (link/id field + button), footer line.

## Screens
1. Landing (`index.html`).  2. Room (`room.html`): topbar / stage (canvas) / panel; on phones the panel comes first and the page scrolls.
