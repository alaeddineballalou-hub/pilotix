// The customer who does not answer (the owner's rule, 24 Nov 2026): the first message at the try the shop chose, the
// shop's own texts with the order's values, and the orders already at the shop's limit or above cancelled with no
// message (old orders, or the limit lowered), counted as « Pas de réponse » attacks.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DEFAULT_CALL_SETTINGS, DEFAULT_CUSTOMER_MESSAGES, fillCustomerMessage, withReactivationLink } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { attackOf } from '../modules/confirmation';
import { reorderPageHtml } from '../modules/noanswer';
import { reactivateByCode, reorderHash } from '../modules/orders';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(160));
});

const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p))[0];
const calls = (extra: Record<string, unknown>) =>
  db.query(`INSERT INTO settings (key, value) VALUES ('calls', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ...DEFAULT_CALL_SETTINGS, ...extra })]);
/** free orders waiting for their first call */
const freeNew = async (n: number) =>
  (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL AND follow_status IS NULL AND NOT is_exchange ORDER BY id DESC LIMIT $1`, [n])).map((r: any) => Number(r.id));

test('the shop chooses the try of the first message; an order already past it is not asked again', async () => {
  const admin = await as(EMAILS.admin);
  await calls({ messageAtTry: 2, cancelAfterNoAnswer: 0 });
  assert.equal(((await call('orders.uiMeta', admin, {})) as any).messageAtTry, 2);
  const [id, old] = await freeNew(2);
  await call('orders.setConf', admin, { ids: [id], status: 'no_answer' });
  await assert.rejects(call('orders.setConf', admin, { ids: [id], status: 'no_answer' }), /tentative 2/);
  const m: any = await call('orders.customerMessage', admin, { id, kind: 'attempt' });
  assert.equal(m.token, null);
  await call('orders.setConf', admin, { ids: [id], status: 'no_answer', note: m.text, messageSentVia: 'whatsapp' });
  // the 3rd try: no message any more
  await call('orders.setConf', admin, { ids: [id], status: 'no_answer' });
  assert.equal(Number((await one('SELECT attempts FROM orders WHERE id = $1', [id])).attempts), 3);
  // an order from before the rule, already at 4 tries: never asked the first message
  await db.query(`UPDATE orders SET conf_status = 'no_answer', attempts = 4 WHERE id = $1`, [old]);
  await call('orders.setConf', admin, { ids: [old], status: 'no_answer' });
  assert.equal(Number((await one('SELECT attempts FROM orders WHERE id = $1', [old])).attempts), 5);
  await db.query(`DELETE FROM settings WHERE key = 'calls'`);
});

test('the shop’s texts, with the order’s values; the cancel one carries the reactivation link', async () => {
  const admin = await as(EMAILS.admin);
  const [id] = await freeNew(1);
  const o = await one('SELECT ref, total FROM orders WHERE id = $1', [id]);
  const first: any = await call('orders.customerMessage', admin, { id, kind: 'attempt' });
  assert.ok(first.text.includes(o.ref), 'the order number');
  assert.ok(first.text.includes(`${Number(o.total)} دج`), 'the total in dinars');
  assert.ok(!/\{[^}]+\}/.test(first.text), 'no {…} left for the customer');
  // the shop writes its own; a link written in the first message is left out
  await call('confirmation.messages.save', admin, { attempt: 'سلام {الاسم} {رقم_الطلب} {رابط_إعادة_التفعيل}', cancel: 'تم إلغاء {رقم_الطلب}' });
  const mine: any = await call('orders.customerMessage', admin, { id, kind: 'attempt' });
  assert.ok(mine.text.endsWith(o.ref));
  const cancel: any = await call('orders.customerMessage', admin, { id, kind: 'cancel' });
  // the short link (25 Nov 2026): 10 letters and digits, kept as its sha256 with its order
  assert.match(cancel.token, /^[A-Za-z0-9]{10}$/);
  assert.ok(cancel.path.endsWith(`/r/${cancel.token}`));
  assert.equal(cancel.url, null, 'no public address here (the preview): the screen puts its own in front of the path');
  assert.equal(Number((await one('SELECT order_id FROM reorder_links WHERE hash = $1', [await reorderHash(cancel.token)])).order_id), id);
  // a text without {رابط_إعادة_التفعيل}: the link goes on a line of its own at the end
  const url = `https://pilotix.online${cancel.path}`;
  assert.equal(withReactivationLink(cancel.text, url), `${cancel.text}\n${url}`);
  assert.equal(withReactivationLink(fillCustomerMessage(DEFAULT_CUSTOMER_MESSAGES.cancel, {}), url).split(url).length, 2, 'the link once');
  const got: any = await call('confirmation.messages.get', admin, {});
  assert.equal(got.attempt, 'سلام {الاسم} {رقم_الطلب} {رابط_إعادة_التفعيل}');
  assert.equal(got.defaults.cancel, DEFAULT_CUSTOMER_MESSAGES.cancel);
  await assert.rejects(call('confirmation.messages.save', admin, { attempt: ' ', cancel: 'x' }));
  // an agent reads his order's message; the shop's texts are the owner's
  const agent = await as(EMAILS.conf);
  await assert.rejects(call('confirmation.messages.save', agent, { attempt: 'a', cancel: 'b' }));
  await db.query(`DELETE FROM settings WHERE key = 'customerMessages'`);
});

test('orders already at the limit or above are cancelled with no message, when the limit is saved and by the job', async () => {
  const admin = await as(EMAILS.admin);
  const [over, at, under, held, busy, confirmed] = await freeNew(6);
  await db.query(`UPDATE orders SET conf_status = 'no_answer', attempts = 8 WHERE id = $1`, [over]);
  await db.query(`UPDATE orders SET conf_status = 'no_answer', attempts = 6 WHERE id = $1`, [at]);
  await db.query(`UPDATE orders SET conf_status = 'no_answer', attempts = 5 WHERE id = $1`, [under]);
  // an agent has this one open right now: the next round takes it
  await db.query(`UPDATE orders SET conf_status = 'no_answer', attempts = 9, locked_by = $2, locked_until = now() + interval '10 minutes' WHERE id = $1`, [held, admin.session.profile.id]);
  // « Occupé » counted as a try before 24 Nov 2026
  await db.query(`UPDATE orders SET conf_status = 'busy', attempts = 7 WHERE id = $1`, [busy]);
  // a confirmed order is never touched
  await db.query(`UPDATE orders SET conf_status = 'confirmed', attempts = 7 WHERE id = $1`, [confirmed]);
  // no limit: nothing happens
  await calls({ cancelAfterNoAnswer: 0 });
  assert.equal(((await call('confirmation.noAnswerSweep', admin, {})) as any).cancelled, 0);
  // the owner saves 6: those at 6 or more go at once (with any such order of the demo data)
  const others = Number((await one(`SELECT count(*)::int AS n FROM orders WHERE conf_status IN ('no_answer', 'busy') AND attempts >= 6
    AND shipped_at IS NULL AND NOT is_exchange AND (follow_status IS NULL OR follow_status = 'cancelled')
    AND (locked_until IS NULL OR locked_until < now()) AND id <> ALL($1)`, [[over, at, busy]])).n);
  const saved: any = await call('admin.calls.save', admin, { ...DEFAULT_CALL_SETTINGS, cancelAfterNoAnswer: 6 });
  assert.equal(saved.cancelled, 3 + others);
  const status = async (id: number) => (await one('SELECT conf_status FROM orders WHERE id = $1', [id])).conf_status;
  assert.deepEqual([await status(over), await status(at), await status(under), await status(held), await status(busy), await status(confirmed)],
    ['cancelled', 'cancelled', 'no_answer', 'no_answer', 'cancelled', 'confirmed']);
  const ev = await one(`SELECT user_id, from_value, note FROM order_events WHERE order_id = $1 AND kind = 'conf_status' ORDER BY id DESC LIMIT 1`, [over]);
  assert.equal(ev.user_id, null, 'nobody: Pilotix did it');
  assert.equal(ev.from_value, 'no_answer');
  assert.match(ev.note, /^Pas de réponse — Annulée automatiquement après 8 appels sans réponse/);
  assert.equal(attackOf('cancelled', ev.note), 'noAnswer', 'counted as an attack, never against the team');
  assert.equal((await one(`SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND kind = 'chat'`, [over])).n, 0, 'no message');
  // the agent closes it: the job of the next 10 minutes takes it
  await db.query(`UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1`, [held]);
  const job: any = await call('confirmation.noAnswerSweep', admin, {});
  assert.deepEqual(job.refs, [(await one('SELECT ref FROM orders WHERE id = $1', [held])).ref]);
  assert.equal(await status(held), 'cancelled');
  // the order under the limit goes on as usual: its 6th call asks the cancel message with the link
  await assert.rejects(call('orders.setConf', admin, { ids: [under], status: 'no_answer' }), /message d’annulation/);
  // the saved settings keep the first message's try
  assert.equal(((await call('orders.uiMeta', admin, {})) as any).messageAtTry, 3);
  await db.query(`DELETE FROM settings WHERE key = 'calls'`);
});

test('the cancel message’s short link: the product’s main photo on its page, the order restored by the link sent only', async () => {
  const asked: any[] = [];
  const api = 'https://pilotix.online/api/s/boutique';
  const jpeg = `${api}/lp/dp/7/abcdefabcdefabcdefabcdef.jpg`;
  // the server: the shop's public address and its JPEG copies (dellal-server.ts › photoLinks)
  const server = {
    publicApi: api,
    dellal: async (action: string, args: any) => {
      if (action !== 'photoLinks') return {};
      asked.push(args);
      return { urls: [jpeg], errors: [] };
    },
  } as any;
  // (the server's hooks only where the link and its page are made: the rest as in the other tests)
  const sys = await as(EMAILS.admin, server);
  const admin = await as(EMAILS.admin);
  const [id] = await freeNew(1);
  const other = Number((await one('SELECT id FROM orders WHERE id <> $1 ORDER BY id LIMIT 1', [id])).id);
  await calls({ cancelAfterNoAnswer: 2 });
  await call('orders.setConf', admin, { ids: [id], status: 'no_answer' });
  // the product's photos: its first one is of another colour than the one ordered, the ordered colour's comes second
  const item = await one('SELECT product_id, variant_id FROM order_items WHERE order_id = $1 ORDER BY id LIMIT 1', [id]);
  const pid = Number(item.product_id);
  const otherColour = await one('SELECT id FROM product_variants WHERE product_id = $1 AND id IS DISTINCT FROM $2 ORDER BY id LIMIT 1', [pid, item.variant_id]);
  await db.query('DELETE FROM product_photos WHERE product_id = $1', [pid]);
  const photo = (v: unknown, pos: number) =>
    db.query(`INSERT INTO product_photos (product_id, variant_id, kind, store, data, thumb, position) VALUES ($1, $2, 'photo', 'local', $3, $4, $5) RETURNING id`, [pid, v, `/9j/${pos}`, 'data:,', pos]);
  const main = Number((await photo(otherColour?.id ?? null, 0))[0].id);
  await photo(item.variant_id, 1);

  const msg: any = await call('orders.customerMessage', sys, { id, kind: 'cancel' });
  assert.equal(msg.url, `${api}/r/${msg.token}`, 'no own domain: the platform’s address, short too');
  // its page, before the order is cancelled (WhatsApp reads it while the agent writes the message)
  const page: any = await call('orders.reorderPage', sys, { code: msg.token });
  assert.equal(page.found, true);
  assert.equal(page.photo, jpeg);
  assert.equal(asked[0].side, 800, 'a light copy for WhatsApp');
  assert.equal(asked[0].photos[0].src, `hd:${main}`, 'the product’s main photo (its first), never the colour’s');
  const html = reorderPageHtml(page);
  assert.ok(html.includes(`<meta property="og:image" content="${jpeg}">`), 'WhatsApp’s preview picture');
  assert.ok(html.includes(`<img src="${jpeg}"`), 'the same photo on the page');
  assert.ok(html.includes('<form method="post"'), 'its button');
  assert.ok(!reorderPageHtml({ photo: 'javascript:alert(1)' }).includes('javascript:'), 'only an https photo');
  assert.equal(((await call('orders.reorderPage', sys, { code: 'AAAAAAAAAA' })) as any).found, false);
  // only the system reads a page
  await assert.rejects(call('orders.reorderPage', await as(EMAILS.conf), { code: msg.token }));
  // not cancelled yet: the link restores nothing
  assert.equal(await reactivateByCode(db, msg.token), false);
  // another order's link, or the message without its link: refused, nothing changes
  const otherMsg: any = await call('orders.customerMessage', sys, { id: other, kind: 'cancel' });
  await assert.rejects(call('orders.setConf', admin, { ids: [id], status: 'no_answer', messageSentVia: 'whatsapp', reorderToken: otherMsg.token, note: withReactivationLink(msg.text, otherMsg.url) }), /nouveau lien/);
  await assert.rejects(call('orders.setConf', admin, { ids: [id], status: 'no_answer', messageSentVia: 'whatsapp', reorderToken: msg.token, note: msg.text }), /lien de réactivation/);
  assert.equal(Number((await one('SELECT attempts FROM orders WHERE id = $1', [id])).attempts), 1);
  // sent: cancelled, and the link is the one sent
  const r: any = await call('orders.setConf', admin, { ids: [id], status: 'no_answer', messageSentVia: 'whatsapp', reorderToken: msg.token, note: withReactivationLink(msg.text, msg.url) });
  assert.equal(r.autoCancelled[0]?.id, id);
  assert.ok((await one('SELECT sent_at FROM reorder_links WHERE hash = $1', [await reorderHash(msg.token)])).sent_at);
  // a message opened again after the cancel (never sent) does not restore it; the one sent does, once
  const later: any = await call('orders.customerMessage', sys, { id, kind: 'cancel' });
  assert.equal(await reactivateByCode(db, later.token), false);
  assert.equal(await reactivateByCode(db, 'not-a-code'), false);
  assert.equal(await reactivateByCode(db, msg.token), true);
  assert.equal(await reactivateByCode(db, msg.token), false);
  assert.equal((await one('SELECT conf_status FROM orders WHERE id = $1', [id])).conf_status, 'new');
  // a link never sent goes after 2 days, the one sent stays
  await db.query(`UPDATE reorder_links SET created_at = now() - interval '3 days'`);
  await call('orders.customerMessage', admin, { id: other, kind: 'cancel' });
  const left = async (code: string) => Number((await one('SELECT count(*)::int AS n FROM reorder_links WHERE hash = $1', [await reorderHash(code)])).n);
  assert.deepEqual([await left(msg.token), await left(later.token), await left(otherMsg.token)], [1, 0, 0]);
  await db.query(`DELETE FROM settings WHERE key = 'calls'`);
});
