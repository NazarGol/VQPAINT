# VQPAINT UI design (Nazar, 2026-09-30). No images — this description is the design. Keep it this minimal.

LOOK
- Whole screen = the canvas. Background: dark grey #404040.
- Font: Inter, small (about 14px). Text colour on pills: near-black #1A1A1A.
- Pills and buttons: rounded rectangles, radius ~10px, no borders, no shadows.
- Colours:
  - light lilac #E3D0E6 = normal pills and buttons
  - strong lilac #D6A5DC = active tool, active note box
  - muted grey-lilac #857B84 = finished (saved) notes
  - white #FFFFFF = the shape while it is being drawn
- Lots of empty space. No sidebars, no panels.

LAYOUT
- Top-left: room name in a small light-lilac pill.
- Bottom centre: two small square tool buttons side by side:
  1. cursor (look / hover)
  2. brush (paint)
  Dark icons. The active tool uses strong lilac.

HOW IT WORKS
1. Brush tool: the user draws ANY free shape (lasso), not squares.
   While drawing, the shape is solid white.
2. When the shape is closed, a note box (strong lilac) appears next to it.
   The user types the note. The box grows for long text.
3. On submit, the shape fills with the VQGAN painting. The note box turns
   muted grey-lilac and stays attached next to the shape.
4. Cursor tool: hovering a painted shape shows its full note.
   On phone: tap. Finished notes can be hidden when not hovered if the
   canvas gets crowded — your call.

ENGINE CHANGE
- Painting must fill arbitrary free-form masks, not rectangles.
- Where shapes touch, blend softly (no hard borders). The outer edge of a
  shape on empty canvas can stay clean.

ALSO NEEDED (same style, small and quiet)
- Next to the room name: invite (copy link) and small dots for people
  in the room.
- Painting progress: subtle, on the shape itself.
- Export PNG + notes: in a small menu.
- Home page (create room / join by link) and phone layout: design them
  yourself in this style.
- Message when there's no WebGPU, in this style.

Don't change how rooms work.

---
Implementation notes (Claude): tokens in `web/app/tokens.css`, components in `web/app/components/`.
My calls: finished notes show as short pills next to their shape while there are at most 10 on screen; beyond that they appear only on hover/tap. The blank canvas token is the codebook tile closest to #404040 so canvas and page read as one surface. Effort (quick/normal/long) lives in the small menu. Others' strokes in progress show as faint white shapes with a tiny name pill.
