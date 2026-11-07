// Meta hears about real sales from chats too (Conversions API for Business Messaging): an order taken in a Messenger or
// Instagram conversation is a Purchase for that Page / Instagram account, at the moment the shop chose for its landing
// pages, once per order, and never for one marked fake.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
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
  assert.equal(sent[0].args.token, 'EAApage');
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
