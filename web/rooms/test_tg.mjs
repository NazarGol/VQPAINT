// Telegram bot handler test against a local wrangler dev server: fake updates, no real token (TG_BOT_TOKEN unset → API calls are skipped,
// but rooms are created, notes queued, and the directory is kept). Run: node test_tg.mjs [base]
const base = process.argv[2] || 'http://127.0.0.1:8787';
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
const post = (u, body) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upd = (msg) => post('/tg/webhook', { update_id: 1, message: msg });
const group = { id: -100123, type: 'supergroup', title: 'Friends' }, me = { id: 42, first_name: 'Olya' };
let r = await fetch(base + '/tg/health'); let j = await r.json(); check(j.ok === true, `tg health (configured=${j.configured})`);
r = await upd({ message_id: 1, chat: group, from: me, text: '/start' }); check(r.status === 200, '/start in a group → 200');
r = await upd({ message_id: 3, chat: group, from: me, text: '/paint', reply_to_message: { message_id: 2, from: { first_name: 'Dima' }, text: 'we should meet in Lviv in May', date: 1760000000 } });
check(r.status === 200, '/paint as a reply → 200');
r = await upd({ message_id: 4, chat: group, from: me, text: 'just chatting' }); check(r.status === 200, 'ordinary message ignored (200, nothing stored)');
// find the room the directory created for this chat
r = await post('/tg/debug_dir', {}); const dir = r.ok ? await r.json() : null;
const room = dir && dir.find((e) => String(e.chat) === String(group.id));
check(!!room && room.kind === 'group' && /^tg-/.test(room.room), `directory: chat → room ${room && room.room} (${room && room.kind})`);
if (room) {
  r = await fetch(`${base}/room/${room.room}/state?light=1`); j = await r.json();
  check(j.waiting === 1 && j.settings && j.settings.kind === 'group' && j.settings.title === 'Friends', `room has 1 queued note and settings ${JSON.stringify(j.settings)}`);
  r = await fetch(`${base}/room/${room.room}/state`); j = await r.json(); void j;
  r = await fetch(`${base}/room/${room.room}/snapshot`); check(r.status === 404, 'no snapshot yet → 404 (bot says "nothing painted yet")');
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]); r = await fetch(`${base}/room/${room.room}/snapshot`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png }); check(r.ok, 'snapshot upload accepted');
  r = await fetch(`${base}/room/${room.room}/snapshot`); check(r.ok && r.headers.get('content-type') === 'image/png', 'snapshot served');
}
// diary in a private chat
const dm = { id: 42, type: 'private', first_name: 'Olya' };
r = await upd({ message_id: 10, chat: dm, from: me, text: '/diary' }); check(r.status === 200, '/diary → 200');
r = await upd({ message_id: 11, chat: dm, from: me, text: 'walked by the river, thought about mum' }); check(r.status === 200, 'a plain DM line → entry');
r = await upd({ message_id: 12, chat: dm, from: me, text: '/remind 21:00' }); check(r.status === 200, '/remind 21:00 → 200');
r = await post('/tg/debug_dir', {}); const dir2 = r.ok ? await r.json() : []; const diary = dir2.find((e) => String(e.chat) === '42');
check(!!diary && diary.kind === 'diary' && diary.remind === 21, `diary room ${diary && diary.room}, reminder at ${diary && diary.remind}:00`);
if (diary) { r = await fetch(`${base}/room/${diary.room}/state?light=1`); j = await r.json(); check(j.waiting === 1 && j.settings.private === true && j.settings.kind === 'diary', 'diary room is private with 1 queued entry'); }
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS'); process.exit(fails.length ? 1 : 0);
