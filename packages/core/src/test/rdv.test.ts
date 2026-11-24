// Rendez-vous: off until an administrator turns it on (Management › Modules); the owner adds the sessions, the website
// books seats (one per number and session, never more than are free, a black-listed number kept apart), the team calls
// and confirms, and the person's ticket follows.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { algiersParts, algiersTime } from '@pilotix/shared';
import { call as rawCall, Ctx, Db, seedRdv } from '../index';
import { EMAILS, setup } from './harness';

/** the actions' answers, read freely in the checks */
const call = (name: string, ctx: Ctx, input: unknown) => rawCall(name, ctx, input) as Promise<any>;

let db: Db;
let admin: Ctx;
let vendeur: Ctx;
let samira: Ctx;
let karim: Ctx;

before(async () => {
  const s = await setup(40);
  db = s.db;
  admin = await s.as(EMAILS.admin);
  vendeur = await s.as(EMAILS.vendeur);
  samira = await s.as(EMAILS.conf);
  karim = await s.as(EMAILS.depot);
});

/** A day from now, in Algiers (YYYY-MM-DD). */
const inDays = (n: number) => algiersParts(new Date(Date.now() + n * 86_400_000).toISOString()).date;
const session = (over: Record<string, unknown> = {}) => ({ title: 'E-commerce de zéro', city: 'Alger', place: 'Hydra, salle 2', date: inDays(10), start: '09:00', end: '16:00', seats: 4, price: 6000, note: '', open: true, ...over });
const book = (sessionId: number, phone: string, seats = 1, name = 'Amine Belkacem') => call('site.book', admin, { sessionId, name, phone, seats, lang: 'ar', ip: '197.200.1.1' }) as Promise<any>;

test('a day and an hour in Algiers', () => {
  assert.equal(algiersTime('2026-12-05', '09:00'), '2026-12-05T08:00:00.000Z');
  assert.equal(algiersTime('2026-02-31', '09:00'), null);
  assert.equal(algiersTime('2026-12-05', '25:00'), null);
  assert.deepEqual(algiersParts('2026-12-05T23:30:00.000Z'), { date: '2026-12-06', time: '00:30' });
});

test('off until an administrator turns it on: the page refuses, the website takes no booking', async () => {
  await assert.rejects(call('rdv.overview', samira, {}), /Rendez-vous sont éteints/);
  await assert.rejects(call('rdv.sessionSave', vendeur, session()), /éteints/);
  assert.deepEqual(await book(1, '0550123456'), { ok: false, reason: 'closed' });
  await assert.rejects(call('modules.set', vendeur, { module: 'rdv', on: true }), /Accès refusé/);
  assert.deepEqual(await call('modules.set', admin, { module: 'rdv', on: true }), { pos: false, rdv: true });
});

test('the owner adds the sessions; the team sees them, the depot does not', async () => {
  await assert.rejects(call('rdv.sessionSave', samira, session()), /Accès refusé/);
  await assert.rejects(call('rdv.overview', karim, {}), /Accès refusé/);
  await assert.rejects(call('rdv.sessionSave', vendeur, session({ end: '08:00' })), /fin vient après/);
  const s: any = await call('rdv.sessionSave', vendeur, session());
  assert.equal(s.startsAt, algiersTime(inDays(10), '09:00'));
  assert.deepEqual([s.seats, s.free, s.todo, s.confirmed, s.past], [4, 4, 0, 0, false]);
  const o: any = await call('rdv.overview', samira, {});
  assert.deepEqual(o.sessions.map((x: any) => x.id), [s.id]);
  assert.deepEqual(o.counts, { attente: 0, confirmes: 0, annules: 0 });
});

test('the website: a mobile number, one booking per number, never more seats than are free', async () => {
  const s: any = await call('rdv.sessionSave', vendeur, session({ city: 'Oran', seats: 3 }));
  assert.deepEqual(await book(s.id, '021 23 45 67'), { ok: false, reason: 'phone' });
  assert.deepEqual(await book(s.id, '0550123456', 1, ' a '), { ok: false, reason: 'name' });
  assert.deepEqual(await book(s.id, '0550123456', 9), { ok: false, reason: 'seats' });
  const a = await book(s.id, '+213 550 12 34 56', 2);
  assert.equal(a.ok, true);
  assert.match(a.token, /^[a-f0-9]{32}$/);
  // pressed twice (or came back): the same ticket, no second booking
  assert.deepEqual(await book(s.id, '0550123456', 2), a);
  assert.deepEqual(await book(s.id, '0661482017', 2), { ok: false, reason: 'full' });
  const b = await book(s.id, '0661482017', 1, 'Sarah Hadjadj');
  assert.equal(b.ok, true);
  assert.deepEqual(await book(s.id, '0772059341', 1), { ok: false, reason: 'full' });
  const left: any = (await call('rdv.overview', samira, {})).sessions.find((x: any) => x.id === s.id);
  assert.deepEqual([left.todo, left.free], [3, 0]);
  // its ticket: the person, the session, « to confirm », its door code
  const t: any = (await call('site.ticket', admin, { token: a.token })).ticket;
  assert.equal(t.status, 'todo');
  assert.equal(t.seats, 2);
  assert.equal(t.price, 6000);
  assert.equal(t.session.city, 'Oran');
  assert.match(t.code, /^RDV-\d{4,}$/);
  assert.deepEqual(await call('site.ticket', admin, { token: 'f'.repeat(32) }), { ticket: null });
  assert.deepEqual(await call('site.ticket', admin, { token: '../x' }), { ticket: null });
});

test('a number of the black list is kept apart: it takes no seat, its ticket stays « to confirm »', async () => {
  const s: any = await call('rdv.sessionSave', vendeur, session({ city: 'Annaba', seats: 2 }));
  await db.query(`INSERT INTO customers (phone, name, blacklisted) VALUES ('0698337102', 'Faux', true)`);
  const x = await book(s.id, '0698337102', 2, 'Faux nom');
  assert.equal(x.ok, true);
  const row: any = (await call('rdv.list', samira, { list: 'annules', sessionId: s.id })).rows[0];
  assert.equal(row.status, 'blocked');
  assert.equal((await call('rdv.overview', samira, {})).sessions.find((y: any) => y.id === s.id).free, 2);
  assert.equal((await call('site.ticket', admin, { token: x.token })).ticket.status, 'todo');
  // the team may still let it in: only if the seats are free
  assert.equal(((await call('rdv.set', samira, { id: row.id, action: 'reopen' })) as any).status, 'new');
});

test('the team calls: no answer, call back, confirm; the lists, the menu count and the ticket follow', async () => {
  const s: any = await call('rdv.sessionSave', vendeur, session({ city: 'Constantine', date: inDays(12), seats: 10 }));
  const t1 = await book(s.id, '0557901264', 1, 'Walid Cherif');
  await book(s.id, '0770112233', 1, 'Lina Mansouri');
  const list = async (l: string) => ((await call('rdv.list', samira, { list: l, sessionId: s.id })) as any).rows;
  const [lina, walid] = await list('attente');
  assert.deepEqual([lina.name, walid.name], ['Lina Mansouri', 'Walid Cherif'], 'the newest first');
  const before = ((await call('orders.counts', samira, {})) as any).rdv;
  assert.ok(before >= 2);
  assert.equal(((await call('orders.counts', karim, {})) as any).rdv, undefined, 'the depot does not see the page');

  const na: any = await call('rdv.set', samira, { id: walid.id, action: 'no_answer' });
  assert.deepEqual([na.status, na.tries, na.agent], ['no_answer', 1, samira.session.profile.name]);
  await assert.rejects(call('rdv.set', samira, { id: walid.id, action: 'callback' }), /quand rappeler/);
  const at = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(((await call('rdv.set', samira, { id: walid.id, action: 'callback', callAt: at })) as any).callAt, at);
  const ok: any = await call('rdv.set', samira, { id: walid.id, action: 'confirm' });
  assert.deepEqual([ok.status, ok.callAt], ['confirmed', null]);
  assert.equal((await call('site.ticket', admin, { token: t1.token })).ticket.status, 'ok');
  assert.deepEqual((await list('confirmes')).map((r: any) => r.name), ['Walid Cherif']);
  assert.equal(((await call('orders.counts', samira, {})) as any).rdv, before - 1);
  // a booking already confirmed cannot get « no answer » (the list had changed in the meantime)
  await assert.rejects(call('rdv.set', samira, { id: walid.id, action: 'no_answer' }), /déjà changé/);
  // at the door
  assert.equal(((await call('rdv.set', samira, { id: walid.id, action: 'present' })) as any).status, 'present');
  assert.equal((await call('site.ticket', admin, { token: t1.token })).ticket.status, 'done');

  // cancelled, then back: only while the seats are free
  await call('rdv.set', samira, { id: lina.id, action: 'cancel' });
  assert.deepEqual((await list('annules')).map((r: any) => r.name), ['Lina Mansouri']);
  assert.equal((await call('site.ticket', admin, { token: (await book(s.id, '0770112233', 1, 'Lina Mansouri')).token })).ticket.status, 'todo', 'a cancelled person books again: a new booking');

  // search by name, number or code
  const code = walid.code;
  assert.deepEqual(((await call('rdv.list', samira, { list: 'confirmes', q: code })) as any).rows.map((r: any) => r.id), [walid.id]);
  assert.deepEqual(((await call('rdv.list', samira, { list: 'confirmes', q: '0557 90' })) as any).rows.map((r: any) => r.id), [walid.id]);
});

test('a booking by hand, moving to another session, fewer seats than booked, taking a session away', async () => {
  const a: any = await call('rdv.sessionSave', vendeur, session({ city: 'Sétif', seats: 2 }));
  const b: any = await call('rdv.sessionSave', vendeur, session({ city: 'Béjaïa', seats: 5 }));
  await assert.rejects(call('rdv.add', samira, { sessionId: a.id, name: 'Omar', phone: '0550', seats: 1, confirmed: true }), /mobile algérien/);
  const h: any = await call('rdv.add', samira, { sessionId: a.id, name: 'Omar Bensalem', phone: '0550998877', seats: 2, confirmed: true });
  assert.deepEqual([h.status, h.source, h.seats], ['confirmed', 'hand', 2]);
  await assert.rejects(call('rdv.add', samira, { sessionId: a.id, name: 'Yasmine', phone: '0661000111', seats: 1, confirmed: false }), /complète/);
  await assert.rejects(call('rdv.add', samira, { sessionId: b.id, name: 'Omar', phone: '0550998877', seats: 1, confirmed: false }).then(() => call('rdv.add', samira, { sessionId: b.id, name: 'Omar', phone: '0550998877', seats: 1, confirmed: false })), /déjà une place/);
  // to Béjaïa, where one seat is already his: 4 free for this booking
  await assert.rejects(call('rdv.set', samira, { id: h.id, action: 'move', sessionId: b.id, seats: 5 }), /Il reste 4 places/);
  const moved: any = await call('rdv.set', samira, { id: h.id, action: 'move', sessionId: b.id });
  assert.equal(moved.session.city, 'Béjaïa');
  await assert.rejects(call('rdv.sessionSave', vendeur, session({ id: b.id, city: 'Béjaïa', seats: 2 })), /3 places sont déjà réservées/);
  assert.equal(((await call('rdv.sessionSave', vendeur, session({ id: b.id, city: 'Béjaïa', seats: 3 }))) as any).free, 0);
  // Sétif is empty now: it goes; Béjaïa has bookings: it is put away with them
  assert.deepEqual(await call('rdv.sessionDelete', vendeur, { id: a.id }), { ok: true, archived: false });
  assert.deepEqual(await call('rdv.sessionDelete', vendeur, { id: b.id }), { ok: true, archived: true });
  const ids = ((await call('rdv.sessions', samira, {})) as any).sessions.map((x: any) => x.id);
  assert.ok(!ids.includes(a.id) && !ids.includes(b.id));
  assert.deepEqual(await book(b.id, '0771234567'), { ok: false, reason: 'closed' });
});

test('the website: the « Académie » design shows the sessions, their seats left and the form; a ticket shows its code', async () => {
  const s: any = await call('rdv.sessionSave', vendeur, session({ city: 'Tlemcen', date: inDays(20), seats: 20, title: 'Montage vidéo' }));
  await call('site.start', admin, { design: 'academie', langs: ['ar', 'fr'], replace: true });
  await call('site.publish', admin, {});
  const html = async (more: Record<string, unknown> = {}) =>
    ((await call('site.html', admin, { imgBase: 'https://shop.dz/api/lp/img/', base: '/', url: 'https://shop.dz/', bookUrl: 'https://shop.dz/api/site/book', langHref: { ar: '/', fr: '/?lang=fr' }, ...more })) as any).html as string;
  const home = await html();
  assert.match(home, /id="sessions"/);
  assert.match(home, /action="https:\/\/shop\.dz\/api\/site\/book"/);
  assert.match(home, new RegExp(`name="session" value="${s.id}"`));
  assert.match(home, /Montage vidéo/);
  assert.match(home, /class="bkbar"/, 'phones get the « book » bar');
  assert.doesNotMatch(home, /<script/, 'the live site has no script');
  // a refused booking comes back with its reason, on the session it chose
  const back = await html({ lang: 'fr', err: 'phone', pick: s.id });
  assert.match(back, /numéro de mobile valide/);
  assert.match(back, new RegExp(`value="${s.id}" checked`));
  // the ticket
  const b = await book(s.id, '0550776655', 2, 'Rania Kaci');
  const ticket = await html({ ticket: b.token, lang: 'fr' });
  assert.match(ticket, /Votre place est réservée/);
  assert.match(ticket, /RDV-\d{4,}/);
  assert.match(ticket, /12\u00a0000\u00a0DA/, 'two seats at 6 000 DA');
  assert.match(ticket, /noindex/);
  assert.match(await html({ ticket: 'a'.repeat(32), lang: 'fr' }), /Billet introuvable/);
});

test('the preview: three sessions of the designs, five people to call', async () => {
  const s = await setup(20);
  await seedRdv(s.db);
  await seedRdv(s.db);
  const ctx = await s.as(EMAILS.conf);
  const o: any = await call('rdv.overview', ctx, {});
  assert.deepEqual(o.sessions.map((x: any) => [x.city, x.confirmed, x.todo, x.seats]), [['Alger', 12, 3, 20], ['Oran', 10, 3, 25], ['Constantine', 15, 0, 15]]);
  assert.deepEqual(o.counts, { attente: 5, confirmes: 22, annules: 2 });
  const first = ((await call('rdv.list', ctx, { list: 'attente' })) as any).rows.map((r: any) => r.name);
  // the new ones first (newest first), then the others; a call back comes first once its time has come
  assert.deepEqual(first, ['Amine Belkacem', 'Sarah Hadjadj', 'Nour El Houda Kaci', 'Yacine Merabet', 'Walid Cherif']);
});
