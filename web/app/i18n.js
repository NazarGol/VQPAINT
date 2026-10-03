// UI strings in English and Ukrainian. Language: ?lang=, then localStorage 'vqpaint.lang', then the browser language.
// Notes are never translated here: they stay in the language they were written in (translation for CLIP is lib/translate.js).
const STRINGS = {
  en: {
    'note.placeholder': 'Write the note for this shape…', 'note.reply.placeholder': 'Write your reply…',
    'note.hint': 'Enter to paint · Shift+Enter for a new line', 'note.hint.phone': '',
    'note.abstract': 'abstract', 'note.realistic': 'realistic', 'note.reply': 'reply', 'note.replyingTo': 'replying to {name}',
    'note.inReplyTo': 'in reply to {name}', 'note.replies': '{n} replies', 'note.reply1': '1 reply', 'note.photo': 'add photo', 'note.photo.remove': 'remove photo',
    'note.photo.reading': 'reading the photo…', 'note.reply.draw': 'Draw a shape touching “{text}”', 'note.reply.mustTouch': 'A reply must touch the shape it replies to. Draw it again.',
    'note.writeFirst': 'Write the note first.', 'sheet.close': 'close', 'setup.book': 'New book', 'setup.meeting': 'New meeting', 'setup.diary': 'New diary', 'setup.bookTitle': 'title', 'setup.bookAuthor': 'author', 'setup.chapters': 'chapters', 'setup.chaptersHint': 'one per line (optional)', 'setup.meetingTitle': 'what is the meeting about?', 'setup.anon': 'notes are anonymous (names hidden, also in exports)', 'setup.diaryTitle': 'a name for this diary (optional)', 'setup.go': 'start',
    'menu.notes': 'all notes', 'menu.calendar': 'calendar', 'menu.import': 'import highlights', 'menu.paste': 'paste notes or transcript', 'menu.finish': 'finish meeting', 'menu.postcard': 'make a postcard', 'menu.print': 'print: bookplate 10×15', 'menu.printA4': 'print: A4 poster', 'menu.printA3': 'print: A3 poster', 'menu.invites': 'allow invites: {state}',
    'list.noChapter': 'no chapter', 'list.empty': 'nothing written yet', 'diary.exportMonth': 'export this month', 'diary.exportYear': 'export the year', 'diary.noEntry': 'no entry that day', 'note.chapter': 'chapter', 'note.noChapter': '— no chapter —', 'note.sign': 'sign with my name', 'note.today': 'today, {date}',
    'import.title': 'Import highlights', 'import.hint': 'Kindle "My Clippings.txt", or plain text / Markdown (a # heading names the chapter, each line or paragraph becomes a note).', 'import.placeholder': 'paste here, or pick a file', 'import.pickFile': 'pick a file', 'import.go': 'add to the painting', 'import.added': '{n} notes queued; they paint one after another', 'import.none': 'nothing found to import',
    'paste.title': 'Paste notes or transcript', 'paste.hint': 'One point per line. "Name: text" keeps the name; long lines are split into sentences.',
    'finish.done': 'meeting painting and PDF exported', 'postcard.period': 'period', 'postcard.all': 'everything', 'postcard.pick': 'notes on the back (up to 3)', 'postcard.names': 'names on the back', 'postcard.make': 'make the PDF', 'postcard.none': 'no notes in that period', 'status.exportedPostcard': 'postcard PDF exported (A6, 3 mm bleed)', 'status.exportedPrint': 'print PNG exported ({w}×{h} px, 300 dpi)', 'home.kind': 'what for?', 'home.kind.default': 'a painting', 'home.kind.book': 'a book', 'home.kind.meeting': 'a meeting', 'home.kind.diary': 'a diary',
    'note.paint': 'paint', 'note.merge': '{a} × {b}', 'note.mergeHint': 'where two notes overlap, the painting blends both', 'react.fire': 'warmer', 'react.ice': 'colder', 'react.grow': 'grow a little', 'react.done': 'you already did that here', 'react.working': 'changing the painting…', 'react.grew': 'grew into its neighbours', 'tg.openBrowser': 'Telegram can show the painting but cannot paint here. Open it in your browser to add a note.', 'tg.openBrowserBtn': 'open in browser', 'note.queued': 'painting after the current one…', 'hint.empty': 'tap anywhere and write a thought', 'untitled': 'untitled', 'msg.noGpuShort': 'no WebGPU here: painting is slow on this device, a laptop in the room will paint for it', 'note.yourName': 'your name', 'mine.pill': 'my paintings', 'mine.title': 'my paintings', 'mine.new': 'new painting', 'mine.empty': 'nothing yet — tap the canvas and write', 'mine.notes': '{n} notes', 'menu.chapters': 'add chapters', 'menu.anon': 'anonymous notes: {state}', 'menu.daily': 'one note a day + calendar: {state}', 'menu.source': 'source code', 'chapters.title': 'Chapters', 'chapters.hint': 'one per line; notes then pick a chapter and the PDF groups by it', 'chapters.save': 'save', 'load.brushFirst': 'preparing the brush… downloaded once ({pct}%)', 'status.waitingDevice': 'will paint as soon as a computer joins', 'status.cannotPaint': 'will paint as soon as a computer joins', 'name.ask': 'What should we call you?', 'name.placeholder': 'your name', 'name.go': 'continue', 'bar.share': 'invite', 'note.translated': 'translated for the painting: “{text}”',
    'menu.undo': 'undo my last stroke', 'menu.png': 'export PNG', 'menu.pdf': 'export PDF (painting + notes)', 'menu.replay': 'replay', 'menu.video': 'export replay video',
    'menu.helpers.phone': 'let other devices paint for me: {state}', 'menu.helpers.desktop': 'help other devices paint: {state}', 'on': 'on', 'off': 'off',
    'menu.lang': 'мова: українська', 'menu.title': 'Menu',
    'bar.invite': 'invite', 'bar.copied': 'link copied', 'bar.inviteTitle': 'Copy the invite link', 'bar.copyPrompt': 'Copy this link',
    'tool.cursor': 'Look: hover or tap a shape to read its note', 'tool.brush': 'Brush: draw a shape, then write the note',
    'load.painting': 'loading the painting…', 'load.paintingN': 'loading the painting… {done}/{total}', 'load.brush': 'preparing the brush… {pct}%', 'load.models': 'loading models {loaded} / {total} MB', 'load.cached': ' · cached',
    'load.photoModel': 'preparing the photo reader… {pct}%', 'load.translator': 'preparing the translator… {pct}%', 'translating': 'translating the note…',
    'status.notConnected': 'Not connected.', 'status.noPaint': 'will paint as soon as a computer joins', 'status.brushFailed': 'could not prepare the brush: {error}', 'status.noWebgl': 'this browser has no WebGL2 — the note will paint as soon as a computer joins',
    'status.paintFailed': 'painting failed: {error}', 'status.helperWill': '{name} will paint this for you…', 'status.helperIs': '{name} is painting this for you…', 'status.helperFailed': 'the helper could not paint it; try again.',
    'status.chunks': '{n} text chunks blended', 'status.chunksSplit': ' ({n} split mid-sentence)', 'status.rendering': 'rendering…', 'status.pdf': 'building the PDF…', 'status.recording': 'recording the replay…',
    'status.exportedPng': 'exported PNG', 'status.exportedPdf': 'exported PDF', 'status.exportedVideo': 'exported replay video', 'status.failed': '{what} failed: {error}',
    'status.painting': '{name} is painting “{text}”', 'status.paintingFor': ' for {name}', 'activity.sep': ' · ',
    'msg.safeMode': 'Safari reloaded this page last time, so it is in low-memory mode: viewing only.', 'msg.safeMode.size': 'Painting loads about 105 MB of models.', 'msg.tryPaint': 'try painting anyway', 'msg.keepViewing': 'keep viewing',
    'msg.noGpu': 'This browser has no WebGPU: painting runs on the CPU and takes a few minutes per stroke.', 'msg.noGpu.hint': 'Chrome or Edge 113+, or Safari 26+, paint in seconds.', 'ok': 'ok',
    'msg.modelsFailed': 'Could not load the models.', 'someone': 'someone', 'me': 'me',
    'menu.invite': 'invite', 'menu.mine': 'my paintings', 'menu.save': 'save…', 'menu.options': 'room options…', 'menu.langShort': 'українська', 'menu.sourceShort': 'source',
    'sheet.save': 'save', 'sheet.options': 'room options', 'save.png': 'PNG', 'save.pdf': 'PDF with notes', 'save.postcard': 'postcard', 'save.print': 'print: bookplate 10×15', 'save.printA4': 'print: A4', 'save.printA3': 'print: A3', 'save.video': 'replay video',
    'status.willPaint': 'will paint as soon as a computer joins', 'status.archiveSoon': 'this painting will be archived soon — save it',
    'home.name': 'your name (optional)', 'home.create': 'create a room', 'home.join': 'join', 'home.joinPlaceholder': 'paste an invite link or room id',
    'home.note': 'Watching downloads only small previews. Painting loads about 105 MB of models once (kept in the browser cache). Chrome, Edge or Safari 26+.', 'home.source': 'source',
    'export.notes': '{n} notes', 'export.note1': '1 note', 'export.replyTo': 'reply to {name}',
  },
  uk: {
    'note.placeholder': 'Напишіть нотатку для цієї фігури…', 'note.reply.placeholder': 'Напишіть відповідь…',
    'note.hint': 'Enter — малювати · Shift+Enter — новий рядок', 'note.hint.phone': '',
    'note.abstract': 'абстрактно', 'note.realistic': 'реалістично', 'note.reply': 'відповісти', 'note.replyingTo': 'відповідь для {name}',
    'note.inReplyTo': 'у відповідь {name}', 'note.replies': 'відповідей: {n}', 'note.reply1': '1 відповідь', 'note.photo': 'додати фото', 'note.photo.remove': 'прибрати фото',
    'note.photo.reading': 'читаю фото…', 'note.reply.draw': 'Намалюйте фігуру, що торкається «{text}»', 'note.reply.mustTouch': 'Відповідь має торкатися фігури, на яку відповідає. Намалюйте ще раз.',
    'note.writeFirst': 'Спочатку напишіть нотатку.', 'sheet.close': 'закрити', 'setup.book': 'Нова книга', 'setup.meeting': 'Нова зустріч', 'setup.diary': 'Новий щоденник', 'setup.bookTitle': 'назва', 'setup.bookAuthor': 'автор', 'setup.chapters': 'розділи', 'setup.chaptersHint': 'по одному в рядку (необов’язково)', 'setup.meetingTitle': 'про що зустріч?', 'setup.anon': 'нотатки анонімні (імена приховано, і в експорті теж)', 'setup.diaryTitle': 'назва щоденника (необов’язково)', 'setup.go': 'почати',
    'menu.notes': 'усі нотатки', 'menu.calendar': 'календар', 'menu.import': 'імпорт виділень', 'menu.paste': 'вставити нотатки чи стенограму', 'menu.finish': 'завершити зустріч', 'menu.postcard': 'зробити листівку', 'menu.print': 'друк: екслібрис 10×15', 'menu.printA4': 'друк: плакат A4', 'menu.printA3': 'друк: плакат A3', 'menu.invites': 'дозволити запрошення: {state}',
    'list.noChapter': 'без розділу', 'list.empty': 'ще нічого не написано', 'diary.exportMonth': 'експорт цього місяця', 'diary.exportYear': 'експорт року', 'diary.noEntry': 'того дня запису немає', 'note.chapter': 'розділ', 'note.noChapter': '— без розділу —', 'note.sign': 'підписати моїм ім’ям', 'note.today': 'сьогодні, {date}',
    'import.title': 'Імпорт виділень', 'import.hint': 'Kindle «My Clippings.txt» або простий текст / Markdown (заголовок # називає розділ, кожен рядок чи абзац стає нотаткою).', 'import.placeholder': 'вставте сюди або виберіть файл', 'import.pickFile': 'вибрати файл', 'import.go': 'додати до картини', 'import.added': 'у черзі нотаток: {n}; вони малюються одна за одною', 'import.none': 'нічого не знайдено для імпорту',
    'paste.title': 'Вставити нотатки чи стенограму', 'paste.hint': 'Один пункт у рядку. «Ім’я: текст» зберігає ім’я; довгі рядки діляться на речення.',
    'finish.done': 'картину зустрічі й PDF експортовано', 'postcard.period': 'період', 'postcard.all': 'усе', 'postcard.pick': 'нотатки на звороті (до 3)', 'postcard.names': 'імена на звороті', 'postcard.make': 'зробити PDF', 'postcard.none': 'за цей період нотаток немає', 'status.exportedPostcard': 'PDF листівки експортовано (A6, 3 мм під обріз)', 'status.exportedPrint': 'PNG для друку експортовано ({w}×{h} px, 300 dpi)', 'home.kind': 'для чого?', 'home.kind.default': 'картина', 'home.kind.book': 'книга', 'home.kind.meeting': 'зустріч', 'home.kind.diary': 'щоденник',
    'note.paint': 'малювати', 'note.merge': '{a} × {b}', 'note.mergeHint': 'де дві нотатки накладаються, картина змішує обидві', 'react.fire': 'тепліше', 'react.ice': 'холодніше', 'react.grow': 'трохи виростити', 'react.done': 'ви вже робили це тут', 'react.working': 'змінюю картину…', 'react.grew': 'виросло в сусідів', 'tg.openBrowser': 'Telegram показує картину, але малювати тут не може. Відкрийте її в браузері, щоб додати нотатку.', 'tg.openBrowserBtn': 'відкрити в браузері', 'note.queued': 'намалюю після поточного…', 'hint.empty': 'торкніться будь-де і напишіть думку', 'untitled': 'без назви', 'msg.noGpuShort': 'тут немає WebGPU: малювання на цьому пристрої повільне, ноутбук у кімнаті намалює за нього', 'note.yourName': 'ваше ім’я', 'mine.pill': 'мої картини', 'mine.title': 'мої картини', 'mine.new': 'нова картина', 'mine.empty': 'поки нічого — торкніться полотна й напишіть', 'mine.notes': 'нотаток: {n}', 'menu.chapters': 'додати розділи', 'menu.anon': 'анонімні нотатки: {state}', 'menu.daily': 'одна нотатка на день + календар: {state}', 'menu.source': 'вихідний код', 'chapters.title': 'Розділи', 'chapters.hint': 'по одному в рядку; нотатки потім обирають розділ, а PDF групує за ним', 'chapters.save': 'зберегти', 'load.brushFirst': 'готую пензель… завантажується один раз ({pct}%)', 'status.waitingDevice': 'намалюється, щойно приєднається комп’ютер', 'status.cannotPaint': 'намалюється, щойно приєднається комп’ютер', 'name.ask': 'Як вас називати?', 'name.placeholder': 'ваше ім’я', 'name.go': 'далі', 'bar.share': 'запросити', 'note.translated': 'для картини перекладено: «{text}»',
    'menu.undo': 'скасувати мій останній мазок', 'menu.png': 'експорт PNG', 'menu.pdf': 'експорт PDF (картина + нотатки)', 'menu.replay': 'відтворити', 'menu.video': 'експорт відео відтворення',
    'menu.helpers.phone': 'нехай інші пристрої малюють за мене: {state}', 'menu.helpers.desktop': 'допомагати іншим пристроям малювати: {state}', 'on': 'увімк.', 'off': 'вимк.',
    'menu.lang': 'language: English', 'menu.title': 'Меню',
    'bar.invite': 'запросити', 'bar.copied': 'посилання скопійовано', 'bar.inviteTitle': 'Скопіювати посилання-запрошення', 'bar.copyPrompt': 'Скопіюйте це посилання',
    'tool.cursor': 'Дивитися: наведіть або торкніться фігури, щоб прочитати нотатку', 'tool.brush': 'Пензель: намалюйте фігуру, потім напишіть нотатку',
    'load.painting': 'завантажую картину…', 'load.paintingN': 'завантажую картину… {done}/{total}', 'load.brush': 'готую пензель… {pct}%', 'load.models': 'завантажую моделі {loaded} / {total} МБ', 'load.cached': ' · з кешу',
    'load.photoModel': 'готую читач фото… {pct}%', 'load.translator': 'готую перекладач… {pct}%', 'translating': 'перекладаю нотатку…',
    'status.notConnected': 'Немає з’єднання.', 'status.noPaint': 'намалюється, щойно приєднається комп’ютер', 'status.brushFailed': 'не вдалося підготувати пензель: {error}', 'status.noWebgl': 'у цьому браузері немає WebGL2 — нотатка намалюється, щойно приєднається комп’ютер',
    'status.paintFailed': 'малювання не вдалося: {error}', 'status.helperWill': '{name} намалює це для вас…', 'status.helperIs': '{name} малює це для вас…', 'status.helperFailed': 'помічник не зміг намалювати; спробуйте ще раз.',
    'status.chunks': 'змішано частин тексту: {n}', 'status.chunksSplit': ' ({n} розділено посеред речення)', 'status.rendering': 'рендерю…', 'status.pdf': 'збираю PDF…', 'status.recording': 'записую відтворення…',
    'status.exportedPng': 'PNG експортовано', 'status.exportedPdf': 'PDF експортовано', 'status.exportedVideo': 'відео відтворення експортовано', 'status.failed': '{what}: помилка: {error}',
    'status.painting': '{name} малює «{text}»', 'status.paintingFor': ' для {name}', 'activity.sep': ' · ',
    'msg.safeMode': 'Минулого разу Safari перезавантажив цю сторінку, тому зараз режим малої пам’яті: лише перегляд.', 'msg.safeMode.size': 'Малювання завантажує близько 105 МБ моделей.', 'msg.tryPaint': 'все одно спробувати малювати', 'msg.keepViewing': 'лише дивитися',
    'msg.noGpu': 'У цьому браузері немає WebGPU: малювання йде на процесорі й займає кілька хвилин на мазок.', 'msg.noGpu.hint': 'Chrome чи Edge 113+ або Safari 26+ малюють за секунди.', 'ok': 'добре',
    'msg.modelsFailed': 'Не вдалося завантажити моделі.', 'someone': 'хтось', 'me': 'я',
    'menu.invite': 'запросити', 'menu.mine': 'мої картини', 'menu.save': 'зберегти…', 'menu.options': 'налаштування кімнати…', 'menu.langShort': 'English', 'menu.sourceShort': 'код',
    'sheet.save': 'зберегти', 'sheet.options': 'налаштування кімнати', 'save.png': 'PNG', 'save.pdf': 'PDF з нотатками', 'save.postcard': 'листівка', 'save.print': 'друк: екслібрис 10×15', 'save.printA4': 'друк: A4', 'save.printA3': 'друк: A3', 'save.video': 'відео відтворення',
    'status.willPaint': 'намалюється, щойно приєднається комп’ютер', 'status.archiveSoon': 'цю картину скоро буде архівовано — збережіть її',
    'home.name': 'ваше ім’я (необов’язково)', 'home.create': 'створити кімнату', 'home.join': 'приєднатися', 'home.joinPlaceholder': 'вставте посилання-запрошення або код кімнати',
    'home.note': 'Перегляд завантажує лише маленькі прев’ю. Малювання один раз завантажує близько 105 МБ моделей (лишаються в кеші браузера). Chrome, Edge або Safari 26+.', 'home.source': 'код',
    'export.notes': 'нотаток: {n}', 'export.note1': '1 нотатка', 'export.replyTo': 'відповідь для {name}',
  },
};
const params = new URLSearchParams(location.search);
export let lang = 'en';
export function detectLang() {
  const q = params.get('lang'); if (q === 'uk' || q === 'en') return q;
  try { const s = localStorage.getItem('vqpaint.lang'); if (s === 'uk' || s === 'en') return s; } catch (_) {}
  const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  return langs.some((l) => /^(uk|ru)\b/i.test(l)) ? 'uk' : 'en';   // Ukrainian UI also for browsers set to Russian (many Ukrainian phones are)
}
lang = detectLang();
document.documentElement.lang = lang;
export function setLang(l) { lang = l === 'uk' ? 'uk' : 'en'; try { localStorage.setItem('vqpaint.lang', lang); } catch (_) {} document.documentElement.lang = lang; }
export function t(key, vars = null) {
  let s = (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS.en[key] ?? key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}
/** fill [data-i18n], [data-i18n-placeholder] and [data-i18n-title] in a subtree */
export function applyTo(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}
