# What VQPAINT is for

VQPAINT is a keepsake that grows out of a process. Words collect over time, a painting grows from them, and the painting
stays afterwards: on a screen, as a PDF, as a print, as a postcard. Nobody "draws". People write, and the writing paints.

Four main uses. Each line says who, when, what they do, what they get, and what the app needs for it. Kept current as we build.

## 1. A book
- **Who / when**: one reader, over the weeks of reading a book; sometimes a reading group.
- **What they do**: open a "book" room (title, author, chapters); after each chapter add a note or a quote, picking the chapter; import Kindle highlights (My Clippings.txt) or a text/Markdown file of highlights.
- **What they get**: a painting that grew with the book; a PDF with the notes grouped by chapter; a bookplate-sized print (10×15 cm) for the inside cover; a poster.
- **Needs**: room kinds + chapters, chapter picker in the writer, grouping in the note view and the PDF, highlight import → the queue, auto-placement (chapters follow each other), print export at 300 dpi.

## 2. A boring work meeting
- **Who / when**: the people in a meeting, during the meeting (secretly) or right after it.
- **What they do**: open a "meeting" room from the invite; write what they really think, anonymously by default (a name is optional); or paste the notes/transcript afterwards and let the app split it into points.
- **What they get**: a painting the meeting left behind; "finish meeting" → an image + a short PDF that drops into the work chat.
- **Needs**: room kind with anonymity (author hidden everywhere, exports included), paste-and-split → the queue, finish button → image + PDF, share.

## 3. Friends at a distance
- **Who / when**: a group of friends in different countries, over months; mostly in Telegram.
- **What they do**: add the bot to the group; reply `/paint` to a message (or react 🎨) to send it to the painting; open the room in Telegram to watch it; once a month a postcard goes out.
- **What they get**: a shared painting that only holds what they chose; the bot posts the picture weekly; a printed postcard with the month's painting and a few of the lines.
- **Needs**: Telegram bot (webhook on Cloudflare, `/start` with the privacy rule, `/paint`, `/show`, weekly post, Mini App link), one room per group, auto-placement, postcard export, (later) print-and-mail.

## 4. A diary
- **Who / when**: one person, one note a day, for months.
- **What they do**: open a private "diary" room; write today's entry (or answer the bot's evening question in a DM); tap a day in the small calendar to see that entry and its part of the painting.
- **What they get**: a painting of their year that grew day by day, with "my October" / "my year" as image + PDF.
- **Needs**: private room kind (no invite link unless turned on), one-entry-a-day rhythm, placement that follows time (a path / rings), calendar view, month + year exports, optional Telegram reminder (off by default) feeding the queue.

## Common to all
Auto-placement and the paint queue (anything can submit a note: a tap, an import, a bot); the organic ink reveal; overlap merging; reactions (🔥 🧊 🌱) as real edits; replies; photos; Ukrainian + English; exports (PNG, PDF, print sizes, postcard); rooms kept on Cloudflare; models in the browser.
