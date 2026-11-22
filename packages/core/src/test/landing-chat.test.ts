// Meta hears about real sales from chats too (Conversions API for Business Messaging): an order taken in a Messenger or
// Instagram conversation is a Purchase for that Page / Instagram account, at the moment the shop chose for its landing
// pages, once per order, and never for one marked fake.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { queueChatEvent } from '../modules/landingquery';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let productId: number;
let variantId: number;
const PAGE = '574038229119556';
const IG = '17841400000000001';
let seq = 0;

before(async () => {
  const s = await setup(201);
  db = s.db;
  as = s.as;
  admin = await s.as(EMAILS.admin);
  productId = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-POU'`))[0].id);
  variantId = Number((await db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND title <> '' ORDER BY id LIMIT 1`, [productId]))[0].id);
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
  await db.query(`INSERT INTO settings (key, value) VALUES ('secret_dellal_page_token', '"EAApage"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
});

/** an order made in a chat of this channel (the conversation keeps the customer's PSID / IGSID and the account it came to) */
async function chatOrder(channel: 'messenger' | 'instagram' | 'whatsapp', account: string | null): Promise<any> {
  const n = ++seq;
  const conv = Number(
    (await db.query(`INSERT INTO conversations (channel, external_id, account_id) VALUES ($1, $2, $3) RETURNING id`, [channel, `${channel}-user-${n}`, account]))[0].id,
  );
  const phone = `0661${String(500000 + n).padStart(6, '0')}`;
  const o: any = await call('orders.create', admin, { customerName: 'Client Chat', phone, wilayaId: 16, commune: 'Hydra', items: [{ productId, variantId, qty: 1 }] });
  await db.query('UPDATE orders SET conversation_id = $2 WHERE id = $1', [o.id, conv]);
  return { ...o, conv, external: `${channel}-user-${n}` };
}

const events = (orderId: number) => db.query(`SELECT * FROM meta_events WHERE order_id = $1 ORDER BY id`, [orderId]);

async function confirm(ids: number[]) {
  const conf = await as(EMAILS.conf);
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = ANY($1)', [ids, conf.session.profile.id]);
  await call('orders.setConf', conf, { ids, status: 'confirmed' });
}

test('a chat’s Purchase goes with the shop’s ads key when there is one (Meta’s two doors: the Page’s key has the content rights only)', async () => {
  const o = await chatOrder('messenger', PAGE);
  await confirm([o.id]);
  await db.query(`INSERT INTO settings (key, value) VALUES ('secret_meta_token', '"EAAads"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  try {
    const sent: any[] = [];
    const server: Ctx['server'] = { courier: async () => ({}), hashPassword: async (p) => p, meta: async (action: string, args: any) => (sent.push({ action, args }), { received: args.events.length }) };
    await db.query(`UPDATE meta_events SET status = 'sent' WHERE status = 'queued' AND order_id <> $1`, [o.id]);
    const r: any = await call('landing.run', await as(EMAILS.admin, server), {});
    assert.equal(r.meta.sent, 1);
    assert.deepEqual([sent[0].action, sent[0].args.target, sent[0].args.token], ['chatCapi', `messenger:${PAGE}`, 'EAAads']);
  } finally {
    await db.query(`DELETE FROM settings WHERE key = 'secret_meta_token'`);
  }
});

test('a Messenger order confirmed by an agent: one Purchase for its Page, sent as a business-messaging event', async () => {
  const o = await chatOrder('messenger', PAGE);
  assert.equal((await events(o.id)).length, 0, 'nothing before it is confirmed');
  await confirm([o.id]);
  const q = await events(o.id);
  assert.equal(q.length, 1);
  assert.equal(q[0].platform, 'chat');
  assert.equal(q[0].pixel_id, `messenger:${PAGE}`);
  assert.equal(q[0].event_id, `chat-purchase-${o.ref}`);

  const sent: any[] = [];
  const server: Ctx['server'] = { courier: async () => ({}), hashPassword: async (p) => p, meta: async (action: string, args: any) => (sent.push({ action, args }), { received: args.events.length }) };
  await db.query(`UPDATE meta_events SET status = 'sent' WHERE status = 'queued' AND order_id <> $1`, [o.id]);
  const r: any = await call('landing.run', await as(EMAILS.admin, server), {});
  assert.equal(r.meta.sent, 1);
  assert.equal(sent[0].action, 'chatCapi');
  assert.equal(sent[0].args.target, `messenger:${PAGE}`);
  assert.equal(sent[0].args.token, 'EAApage', 'no ads key: the Page’s key');
  const e = sent[0].args.events[0];
  assert.equal(e.event_name, 'Purchase');
  assert.equal(e.action_source, 'business_messaging');
  assert.equal(e.messaging_channel, 'messenger');
  assert.deepEqual(e.user_data, { page_id: PAGE, page_scoped_user_id: o.external });
  assert.equal(e.custom_data.currency, 'DZD');
  assert.equal(e.custom_data.value, Number(o.total));
  assert.equal((await events(o.id))[0].status, 'sent');

  // confirmed again after a callback: still one event (Meta does not remove doubles for chats)
  const conf = await as(EMAILS.conf);
  await call('orders.setConf', conf, { ids: [o.id], status: 'callback', nextCallAt: new Date(Date.now() + 3600_000).toISOString() });
  await call('orders.setConf', conf, { ids: [o.id], status: 'confirmed' });
  assert.equal((await events(o.id)).length, 1);
});

test('Instagram: the Instagram account and the IGSID; a chat without its account uses the one linked in Pilot Message', async () => {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('dellal', $1) ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`,
    [JSON.stringify({ instagramId: IG, messengerPageId: PAGE })],
  );
  const o = await chatOrder('instagram', null);
  await confirm([o.id]);
  const q = await events(o.id);
  assert.equal(q.length, 1);
  assert.equal(q[0].pixel_id, `instagram:${IG}`);
  const sent: any[] = [];
  const server: Ctx['server'] = { courier: async () => ({}), hashPassword: async (p) => p, meta: async (action: string, args: any) => (sent.push({ action, args }), { received: args.events.length }) };
  await call('landing.run', await as(EMAILS.admin, server), {});
  const e = sent.find((x) => x.args.target === `instagram:${IG}`).args.events[0];
  assert.equal(e.messaging_channel, 'instagram');
  assert.deepEqual(e.user_data, { instagram_business_account_id: IG, ig_sid: o.external });
});

test('never a Purchase for an order found fake before the job, nor for a WhatsApp chat (not this permission)', async () => {
  const fake = await chatOrder('messenger', PAGE);
  const wa = await chatOrder('whatsapp', '1234567890');
  await confirm([fake.id, wa.id]);
  assert.equal((await events(wa.id)).length, 0);
  await db.query(`UPDATE orders SET conf_status = 'fake' WHERE id = $1`, [fake.id]);
  const sent: any[] = [];
  const server: Ctx['server'] = { courier: async () => ({}), hashPassword: async (p) => p, meta: async (action: string, args: any) => (sent.push({ action, args }), { received: args.events.length }) };
  await call('landing.run', await as(EMAILS.admin, server), {});
  assert.ok(!sent.flatMap((x) => x.args.events).some((e: any) => e.event_id === `chat-purchase-${fake.ref}`));
  assert.equal((await events(fake.id))[0].status, 'skipped');
});

test('« at delivery »: the chat order is a Purchase only once delivered', async () => {
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'delivered', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
  const o = await chatOrder('messenger', PAGE);
  await confirm([o.id]);
  assert.equal((await events(o.id)).length, 0, 'confirmed is not enough');
  await db.query(`UPDATE orders SET follow_status = 'with_livreur', shipped_at = now() WHERE id = $1`, [o.id]);
  await call('orders.setFollow', await as(EMAILS.suivi), { ids: [o.id], status: 'delivered' });
  assert.equal((await events(o.id)).length, 1);
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
});

test('the server asks the dataset of the Page once, then sends the events to it (token in the body); a missing permission waits', async () => {
  const { runMeta } = await import('../meta');
  const calls: { url: string; body: any }[] = [];
  const real = globalThis.fetch;
  let refuse = false;
  globalThis.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (refuse) return new Response(JSON.stringify({ error: { code: 10, message: 'Application does not have permission for this action' } }), { status: 403 });
    return new Response(JSON.stringify(String(url).endsWith('/dataset') ? { id: '900000000000001' } : { events_received: body.data.length }), { status: 200 });
  }) as any;
  try {
    const ev = [{ event_name: 'Purchase' }];
    const r: any = await runMeta('chatCapi', { target: 'messenger:111111111111', token: 'EAAx', events: ev }, admin);
    assert.deepEqual(r, { received: 1, dataset: '900000000000001' });
    assert.match(calls[0].url, /\/111111111111\/dataset$/);
    assert.match(calls[1].url, /\/900000000000001\/events$/);
    assert.equal(calls[1].body.access_token, 'EAAx');
    assert.ok(!calls.some((c) => c.url.includes('EAAx')), 'never in a URL');
    await runMeta('chatCapi', { target: 'messenger:111111111111', token: 'EAAx', events: ev }, admin);
    assert.equal(calls.filter((c) => c.url.endsWith('/dataset')).length, 1, 'the dataset is asked once');
    refuse = true;
    await assert.rejects(runMeta('chatCapi', { target: 'instagram:222222222222', token: 'EAAx', events: ev }, admin), /réessayez après l’App Review/);
  } finally {
    globalThis.fetch = real;
  }
});

test('a chat order tells Meta the same things a page’s order does: Lead when it is taken, Delivered when the parcel arrives (Meta’s names for a chat)', async () => {
  const o = await chatOrder('messenger', PAGE);
  // the order is taken in the chat (orders.create does it for an order Dellal or an agent makes from a conversation)
  await queueChatEvent(db, o.id, 'Lead', Date.now());
  await queueChatEvent(db, o.id, 'Lead', Date.now());
  let q = await events(o.id);
  assert.deepEqual(q.map((e: any) => [e.event_name, e.event_id, e.platform]), [['Lead', `chat-lead-${o.ref}`, 'chat']]);
  await confirm([o.id]);
  await db.query(`UPDATE orders SET follow_status = 'with_livreur', shipped_at = now() WHERE id = $1`, [o.id]);
  await call('orders.setFollow', await as(EMAILS.suivi), { ids: [o.id], status: 'delivered' });
  q = await events(o.id);
  assert.deepEqual(q.map((e: any) => e.event_name).sort(), ['Delivered', 'Lead', 'Purchase']);
  const sent: any[] = [];
  const server: Ctx['server'] = { courier: async () => ({}), hashPassword: async (p) => p, meta: async (action: string, args: any) => (sent.push({ action, args }), { received: args.events.length }) };
  await db.query(`UPDATE meta_events SET status = 'sent' WHERE status = 'queued' AND order_id <> $1`, [o.id]);
  await call('landing.run', await as(EMAILS.admin, server), {});
  const names = sent.flatMap((x) => x.args.events).map((e: any) => [e.event_name, e.action_source, e.event_id]);
  assert.deepEqual(
    names.sort((a: any, b: any) => String(a[0]).localeCompare(String(b[0]))),
    [
      ['LeadSubmitted', 'business_messaging', `chat-lead-${o.ref}`],
      ['OrderDelivered', 'business_messaging', `chat-delivered-${o.ref}`],
      ['Purchase', 'business_messaging', `chat-purchase-${o.ref}`],
    ],
  );
  // a fake order's Lead never leaves; WhatsApp has no such event
  const fake = await chatOrder('messenger', PAGE);
  await queueChatEvent(db, fake.id, 'Lead', Date.now());
  await db.query(`UPDATE orders SET conf_status = 'fake' WHERE id = $1`, [fake.id]);
  await call('landing.run', await as(EMAILS.admin, server), {});
  assert.equal((await events(fake.id))[0].status, 'skipped');
  const wa = await chatOrder('whatsapp', '1234567890');
  await queueChatEvent(db, wa.id, 'Lead', Date.now());
  assert.equal((await events(wa.id)).length, 0);
});

test('a chat’s Purchase is dated when the order was taken, not when the agent confirmed it nor when it left; stuck more than 7 days, it is not sent (Meta refuses it)', async () => {
  const conf = await as(EMAILS.conf);
  const sent: any[] = [];
  const server: Ctx['server'] = { courier: async () => ({}), hashPassword: async (p) => p, meta: async (action: string, args: any) => (sent.push({ action, args }), { received: args.events.length }) };
  const job = await as(EMAILS.admin, server);
  const o = await chatOrder('messenger', PAGE);
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [o.id, conf.session.profile.id]);
  const tc = Date.now() + 10 * 3600_000;
  await call('orders.setConf', { ...conf, now: () => tc }, { ids: [o.id], status: 'confirmed' });
  await db.query(`UPDATE meta_events SET status = 'sent' WHERE status = 'queued' AND order_id <> $1`, [o.id]);
  // the job only runs a day later (the server or Meta down): the sale keeps the day of its order
  await call('landing.run', { ...job, now: () => tc + 26 * 3600_000 }, {});
  const e = sent.flatMap((x) => x.args.events).find((x: any) => x.event_id === `chat-purchase-${o.ref}`);
  assert.ok(e, 'it left');
  const [row] = await db.query('SELECT created_at FROM orders WHERE id = $1', [o.id]);
  assert.equal(e.event_time, Math.floor(new Date(row.created_at).getTime() / 1000), 'the moment the order was taken');
  assert.ok(e.event_time < Math.floor(tc / 1000) - 9 * 3600, 'not the moment the agent confirmed it');
  // confirmed, then stuck more than 7 days: Meta would refuse the whole batch, so it is not sent
  const o2 = await chatOrder('messenger', PAGE);
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [o2.id, conf.session.profile.id]);
  const tb = tc + 27 * 3600_000;
  await call('orders.setConf', { ...conf, now: () => tb }, { ids: [o2.id], status: 'confirmed' });
  sent.length = 0;
  await call('landing.run', { ...job, now: () => tb + 7 * 24 * 3600_000 }, {});
  assert.ok(!sent.flatMap((x) => x.args.events).some((x: any) => x.event_id === `chat-purchase-${o2.ref}`));
  const [late] = (await events(o2.id)).filter((x: any) => x.event_name === 'Purchase');
  assert.equal(late.status, 'skipped');
  assert.match(late.error, /7 jours/);
});
