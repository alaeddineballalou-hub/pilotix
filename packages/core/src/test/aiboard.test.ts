// Pilot AI › Dellal AI, CM AI, Spy AI: the control room's dashboards of the shops' AI agents. Dellal's figures follow the
// chats that started in the period (Algeria's days): how many ended with an order, how many with a parcel delivered
// (only once the parcels had time to arrive), against the period before; per shop, product and channel; why chats ended
// without a sale. Its instruction book is put together at each download (always the latest version).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, staffLogin } from '../index';
import { boardPeriod, chatSource } from '../platform/aiboard';
import { recordAiUsage } from '../platform/aiusage';
import { loadShop } from '../platform/shops';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
/** Friday 30 October 2026, 11:00 in Algeria */
const NOW = Date.parse('2026-10-30T10:00:00Z');

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => NOW };
  const p = <T = any>(name: string, input: unknown = {}, as: PCtx = pctx) => platformCall(name, as, input) as Promise<T>;
  const support: PCtx = { ...pctx, staff: { ...pctx.staff, role: 'support' } };
  return { t, p, support };
}

let ext = 0;
/** a chat of the shop: its channel, when it started, the product Dellal found first, its orders */
async function chat(
  db: any,
  o: {
    channel?: string;
    at: string;
    mode?: string;
    source?: string | null;
    found?: number[];
    /** Dellal's first answer, so many seconds after the customer's first message */
    reply?: number;
    /** handed to the team so many seconds after the start; a person writes `team` seconds later */
    handoff?: { after: number; team?: number };
    orders?: { conf?: string; follow?: string | null; total: number; lines: [number, number, number][] }[];
  },
) {
  const c = (
    await db.query(`INSERT INTO conversations (channel, external_id, mode, source, created_at, last_message_at) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`, [
      o.channel ?? 'whatsapp',
      `ext-${++ext}`,
      o.mode ?? 'ai',
      o.source ?? null,
      o.at,
    ])
  )[0].id;
  const later = (sec: number) => new Date(Date.parse(o.at) + sec * 1000).toISOString();
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body, created_at) VALUES ($1, 'customer', 'salam', $2)`, [c, o.at]);
  if (o.reply !== undefined) await db.query(`INSERT INTO conv_messages (conversation_id, role, body, created_at) VALUES ($1, 'agent', 'Salam ! Kifach nqder n3awnek ?', $2)`, [c, later(o.reply)]);
  if (o.handoff) {
    await db.query(`INSERT INTO conv_messages (conversation_id, role, body, meta, created_at) VALUES ($1, 'tool', 'handoff', '{"tool":"handoff"}', $2)`, [c, later(o.handoff.after)]);
    if (o.handoff.team !== undefined) await db.query(`INSERT INTO conv_messages (conversation_id, role, body, created_at) VALUES ($1, 'staff', 'Bonjour, je prends la suite.', $2)`, [c, later(o.handoff.after + o.handoff.team)]);
  }
  if (o.found)
    await db.query(`INSERT INTO conv_messages (conversation_id, role, body, meta, created_at) VALUES ($1, 'tool', 'search_products', $2, $3)`, [
      c,
      JSON.stringify({ tool: 'search_products', input: { query: 'x' }, result: { products: o.found.map((id) => ({ product_id: id, name: `P${id}` })) } }),
      o.at,
    ]);
  for (const r of o.orders ?? []) {
    const cust = (await db.query(`INSERT INTO customers (phone, name) VALUES ($1, 'Test') RETURNING id`, [`05${String(++ext).padStart(8, '0')}`]))[0].id;
    const id = (
      await db.query(
        `INSERT INTO orders (ref, customer_id, customer_name, phone, wilaya_id, conf_status, follow_status, total, subtotal, conversation_id, created_at)
         VALUES ('T' || nextval('order_ref_seq'), $1, 'Test', '0550000000', 16, $2, $3, $4, $4, $5, $6) RETURNING id`,
        [cust, r.conf ?? 'confirmed', r.follow ?? null, r.total, c, o.at],
      )
    )[0].id;
    for (const [product, qty, price] of r.lines) await db.query(`INSERT INTO order_items (order_id, product_id, name, qty, unit_price) VALUES ($1, $2, 'x', $3, $4)`, [id, product, qty, price]);
  }
  return Number(c);
}

test('the period: Algeria’s days, the one before, the days whose parcels are still on the road, weeks for 90 days', () => {
  const p = boardPeriod(30, NOW);
  assert.deepEqual([p.from, p.to, p.prevFrom, p.prevTo, p.openFrom, p.bucket], ['2026-10-01', '2026-10-30', '2026-09-01', '2026-09-30', '2026-10-24', 'day']);
  // 23:30 UTC is already the next day in Algeria
  assert.equal(boardPeriod(7, Date.parse('2026-10-30T23:30:00Z')).to, '2026-10-31');
  assert.equal(boardPeriod(90, NOW).bucket, 'week');
});

test('Dellal: conversion and real sales of the chats that started in the period, vs the period before, per shop, product and channel', async () => {
  const { t, p, support } = await server();
  const shop = (await loadShop(t, { primary: true }))!;
  const db = t.shop('public');
  const [p1, p2] = (
    await db.query(`INSERT INTO products (name, sku, price) VALUES ('Montre Atlas', 'MA-1', 3500), ('Sac Lina', 'SL-1', 3000) RETURNING id`)
  ).map((r: any) => Number(r.id));

  // this period (1–30 October)
  await chat(db, { at: '2026-10-05T10:00:00Z', found: [p1], orders: [{ follow: 'delivered', total: 4000, lines: [[p1, 1, 3500]] }] }); // A: sold
  await chat(db, { channel: 'messenger', at: '2026-10-06T10:00:00Z', mode: 'handoff', found: [p1] }); // B: to the team, no order
  await chat(db, { at: '2026-10-10T10:00:00Z', orders: [{ follow: 'returned', total: 3000, lines: [[p2, 1, 3000]] }] }); // C: refused
  await chat(db, { at: '2026-10-27T10:00:00Z', orders: [{ follow: 'shipped', total: 3500, lines: [[p1, 1, 3500]] }] }); // D: on the road
  await chat(db, { at: '2026-10-08T10:00:00Z', orders: [{ conf: 'duplicate', total: 3000, lines: [[p2, 1, 3000]] }] }); // H: a duplicate only
  await chat(db, { at: '2026-10-29T23:30:00Z' }); // I: 30 October in Algeria
  await chat(db, { at: '2026-09-30T23:30:00Z', found: [p1, p2, p1, p2] }); // J: 1 October in Algeria; a vague search names no product
  await chat(db, { channel: 'test', at: '2026-10-07T10:00:00Z', orders: [{ follow: 'delivered', total: 9000, lines: [[p2, 3, 3000]] }] }); // a test chat
  // the period before (September)
  await chat(db, { channel: 'instagram', at: '2026-09-15T10:00:00Z', orders: [{ follow: 'delivered', total: 3000, lines: [[p2, 1, 3000]] }] });
  await chat(db, { at: '2026-09-16T10:00:00Z' });
  // an order a person made without a chat does not count
  await recordAiUsage(t, { shopId: shop.id, feature: 'dellal', model: 'claude-haiku-5-5', payer: 'pilotix', usage: { input_tokens: 0, output_tokens: 1_200_000 }, at: new Date('2026-10-12T10:00:00Z') }); // 0.60 $
  await recordAiUsage(t, { shopId: shop.id, feature: 'dellal', model: 'claude-sonnet-5-5', payer: 'shop', usage: { input_tokens: 1_000_000 }, at: new Date('2026-10-12T10:00:00Z') }); // the shop's own key
  // what Pilot AI read (names removed): why chats ended without a sale
  const kase = (conv: number, outcome: string, reason: string | null, done = true) =>
    t.platform.query(`INSERT INTO platform.pilot_cases (shop_id, conv_id, outcome, reason, done, opened_at) VALUES ($1, $2, $3, $4, $5, '2026-10-05T10:00:00Z')`, [shop.id, conv, outcome, reason, done]);
  await kase(1, 'no_order', 'ghosted');
  await kase(2, 'no_order', 'ghosted');
  await kase(3, 'refused', 'price');
  await kase(4, 'delivered', null);
  await kase(5, 'pending', 'in_delivery', false);

  const b = await p('p.dellal.board', { days: 30 });
  assert.equal(b.from, '2026-10-01');
  assert.equal(b.rowKind, 'shop');
  assert.equal(b.kpi.chats, 7, 'test chats left out; the night of 30 September (UTC) is 1 October in Algeria');
  assert.equal(b.kpi.ordered, 3, 'a duplicate order is not a sale');
  assert.equal(b.kpi.conversion, 42.9);
  assert.equal(b.kpi.ripeChats, 5, 'the chats of the last 7 days still wait for their parcels');
  assert.equal(b.kpi.realSales, 20);
  assert.deepEqual([b.kpi.orders, b.kpi.delivered, b.kpi.lost, b.kpi.pending], [3, 1, 1, 1]);
  assert.equal(b.kpi.deliveredRate, 50);
  assert.equal(b.kpi.revenue, 4000);
  assert.equal(b.kpi.basket, 3500);
  assert.equal(b.kpi.handedRate, 14.3);
  assert.deepEqual(b.prev, { chats: 2, conversion: 50, realSales: 50, deliveredRate: 100, basket: 3000, handedRate: 0 });
  assert.equal(b.cost.usd.toFixed(2), '0.60', 'only what Pilotix’s key paid');
  assert.equal(b.cost.perOrder.toFixed(2), '0.20');
  assert.equal(b.cost.models[0].model, 'claude-haiku-5-5');
  // the line: a point a day, the last 7 days marked as waiting for their parcels
  assert.equal(b.series.length, 30);
  const day = (d: string) => b.series.find((x: any) => x.day === d);
  assert.deepEqual(day('2026-10-05'), { day: '2026-10-05', chats: 1, ordered: 1, ripeChats: 1, sold: 1, open: false });
  assert.equal(day('2026-10-23').open, false);
  assert.deepEqual(day('2026-10-27'), { day: '2026-10-27', chats: 1, ordered: 1, ripeChats: 0, sold: 0, open: true });
  assert.equal(b.series.reduce((a: number, x: any) => a + x.chats, 0), 7);
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].label, shop.name);
  assert.equal(b.rows[0].conversion, 42.9);
  // why: the finished chats Pilot AI read, the biggest reason first
  assert.equal(b.whyTotal, 3);
  assert.deepEqual(b.why[0], { outcome: 'no_order', reason: 'ghosted', n: 2, pct: 66.7 });
  assert.deepEqual(b.why[1], { outcome: 'refused', reason: 'price', n: 1, pct: 33.3 });

  // one shop: its products (the most talked about first)
  const s = await p('p.dellal.board', { days: 30, shopId: shop.id });
  assert.equal(s.rowKind, 'product');
  assert.deepEqual(
    s.products.map((x: any) => x.name),
    ['Montre Atlas', 'Sac Lina'],
  );
  const r1 = s.rows.find((x: any) => x.key === String(p1));
  assert.deepEqual([r1.chats, r1.ordered, r1.conversion, r1.ripeChats, r1.realSales, r1.revenue], [3, 2, 66.7, 2, 50, 3500]);
  const r2 = s.rows.find((x: any) => x.key === String(p2));
  assert.deepEqual([r2.chats, r2.ordered, r2.deliveredRate], [2, 1, 0], 'the duplicate chat talked about it, without a sale');

  // one product: only its chats and its lines; its channels
  const one = await p('p.dellal.board', { days: 30, shopId: shop.id, productId: p1 });
  assert.equal(one.rowKind, 'channel');
  assert.deepEqual([one.kpi.chats, one.kpi.ordered, one.kpi.realSales, one.kpi.revenue, one.kpi.basket], [3, 2, 50, 3500, 3500]);
  assert.equal(one.cost.perOrder, null, 'a product’s share of the AI cost cannot be told');
  assert.deepEqual(
    one.rows.map((x: any) => [x.key, x.chats]),
    [
      ['whatsapp', 2],
      ['messenger', 1],
    ],
  );
  // a product without a shop is ignored
  assert.equal((await p('p.dellal.board', { days: 30, productId: p1 })).productId, null);

  // 90 days: a point a week (its Monday), the same chats
  const w = await p('p.dellal.board', { days: 90 });
  assert.equal(w.bucket, 'week');
  assert.ok(w.series.every((x: any) => new Date(`${x.day}T12:00:00Z`).getUTCDay() === 1));
  assert.equal(
    w.series.reduce((a: number, x: any) => a + x.chats, 0),
    9,
  );
  // 7 days: every parcel is still on the road
  const d7 = await p('p.dellal.board', { days: 7 });
  assert.equal(d7.kpi.realSales, null, 'too early to tell: never a made-up 0 %');
  await assert.rejects(p('p.dellal.board', { days: 15 }));

  // the coach (support) sees the sales, not what the AI costs
  const sup = await p('p.dellal.board', { days: 30 }, support);
  assert.equal(sup.kpi.chats, 7);
  assert.equal(sup.cost, null);
});

test('CM AI and Spy AI: what each agent did in the period, every shop or one, what it cost (managers only)', async () => {
  const { t, p, support } = await server();
  const shop = (await loadShop(t, { primary: true }))!;
  const db = t.shop('public');
  const post = (await db.query(`INSERT INTO cm_posts (channel, external_id) VALUES ('facebook', 'post-1') RETURNING id`))[0].id;
  const comment = (k: number, at: string, f: Record<string, unknown>) =>
    db.query(
      `INSERT INTO cm_comments (post_id, channel, external_id, body, status, public_reply_id, private_sent, hidden, conversation_id, phone, handled_by, created_at)
       VALUES ($1, 'facebook', $2, 'prix ?', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [post, `c-${k}`, f.status ?? 'answered', f.reply ?? null, !!f.private, !!f.hidden, f.conv ?? null, f.phone ?? null, f.by ?? null, at],
    );
  await comment(1, '2026-10-05T10:00:00Z', { reply: 'r1' });
  await comment(2, '2026-10-06T10:00:00Z', { reply: 'r2', private: true, conv: 7 });
  await comment(3, '2026-10-07T10:00:00Z', { status: 'hidden', hidden: true, phone: '0550000001' });
  await comment(4, '2026-10-08T10:00:00Z', { status: 'handoff', by: 1 });
  await comment(5, '2026-10-09T10:00:00Z', { status: 'error' });
  await comment(6, '2026-09-20T10:00:00Z', { reply: 'r6' });
  await recordAiUsage(t, { shopId: shop.id, feature: 'cm', model: 'claude-haiku-5-5', payer: 'pilotix', usage: { output_tokens: 200_000 }, at: new Date('2026-10-06T10:00:00Z') }); // 0.10 $

  const c = await p('p.cm.board', { days: 30 });
  assert.deepEqual(c.kpi, { comments: 5, answered: 2, privates: 1, hidden: 1, handed: 1, errors: 1, team: 1, leads: 2 });
  assert.equal(c.prev.comments, 1);
  assert.equal(c.cost.usd.toFixed(2), '0.10');
  assert.equal(c.cost.calls, 1);
  assert.equal(c.series.length, 30);
  assert.equal(c.series.find((x: any) => x.day === '2026-10-05').comments, 1);
  assert.equal(c.rows[0].label, shop.name);
  assert.equal((await p('p.cm.board', { days: 30 }, support)).cost, null);
  assert.equal((await p('p.cm.board', { days: 30, shopId: 999 })).kpi.comments, 0, 'a shop that is not there: nothing');

  const prod = (await db.query(`INSERT INTO products (name, sku, price) VALUES ('Montre Atlas', 'MA-1', 3500) RETURNING id`))[0].id;
  await db.query(`INSERT INTO spy_watch (product_id, watch, brief) VALUES ($1, true, '{"sum":"x"}')`, [prod]);
  const ad = (k: number, f: Record<string, unknown>) =>
    db.query(`INSERT INTO spy_ads (product_id, gkey, ad_id, source, own, active, ai, first_seen) VALUES ($1, $2, $2, 'meta', $3, $4, $5, $6)`, [
      prod,
      `g-${k}`,
      !!f.own,
      f.active ?? true,
      f.ai ? JSON.stringify(f.ai) : null,
      f.at ?? '2026-10-10T10:00:00Z',
    ]);
  await ad(1, { ai: { hook: 'x' } });
  await ad(2, { active: false, at: '2026-08-01T10:00:00Z' });
  await ad(3, { own: true });
  await db.query(`INSERT INTO spy_follow (page_key, page_name, product_id) VALUES ('pg-1', 'Rival', $1)`, [prod]);
  await db.query(`INSERT INTO spy_events (kind, page_name, product_id, at) VALUES ('new_ad', 'Rival', $1, '2026-10-11T10:00:00Z'), ('price', 'Rival', $1, '2026-08-11T10:00:00Z')`, [prod]);
  const s = await p('p.spy.board', { days: 30 });
  assert.deepEqual(s.kpi, { watched: 1, ads: 2, active: 1, newAds: 1, analysed: 1, briefs: 1, followed: 1, alerts: 1 }, 'the shop’s own ads are not competitors');
  assert.equal(s.rows.length, 1);
  assert.equal(s.cost.usd, 0);
  assert.equal((await p('p.spy.board', { days: 30 }, support)).cost, null);
});

test('Dellal’s instruction book: its method, its Darija and the lesson book in service, put together at each download', async () => {
  const { t, p, support } = await server();
  let b = await p('p.pilot.bookText', {});
  assert.equal(b.version, null);
  assert.match(b.text, /^DELLAL — LE LIVRE D’INSTRUCTIONS/);
  assert.match(b.text, /Pas encore de livre de leçons/);
  assert.match(b.text, /MÉTHODE DE VENTE/);
  assert.match(b.text, /DARIJA ALGÉRIENNE/);
  assert.ok(!b.text.includes('${ORDER_NEXT}'), 'the shop’s part is not in it');

  await t.platform.query(
    `INSERT INTO platform.pilot_books (version, status, lesson_ids, text, created_at, promoted_at) VALUES (2, 'champion', '[1,2]', 'LEÇONS v2\n- [price] Donner le total avec la livraison.', '2026-10-20T10:00:00Z', '2026-10-21T10:00:00Z')`,
  );
  const v3 = (await t.platform.query(`INSERT INTO platform.pilot_books (version, status, lesson_ids, text) VALUES (3, 'testing', '[1,2,3]', 'LEÇONS v3\n- [trust] Rappeler le paiement à la livraison.') RETURNING id`))[0].id;
  await t.platform.query(`INSERT INTO platform.pilot_tests (champion_id, challenger_id, share, status) VALUES (1, $1, 0.2, 'running')`, [v3]);
  b = await p('p.pilot.bookText', {}, support);
  assert.equal(b.version, 2);
  assert.equal(b.lessons, 2);
  assert.equal(b.testVersion, 3);
  assert.equal(b.updatedAt, '2026-10-21T10:00:00.000Z');
  assert.match(b.text, /version 2, en service depuis le 21 octobre 2026 \(2 leçon\(s\)\)/);
  assert.match(b.text, /Donner le total avec la livraison/);
  assert.match(b.text, /EN TEST — version 3 \(20 % des nouvelles conversations\)/);
  assert.match(b.text, /Rappeler le paiement à la livraison/);
  // the test ends: the file follows at once
  await t.platform.query(`UPDATE platform.pilot_tests SET status = 'stopped'`);
  await t.platform.query(`UPDATE platform.pilot_books SET status = 'stopped' WHERE version = 3`);
  b = await p('p.pilot.bookText', {});
  assert.equal(b.testVersion, null);
  assert.ok(!b.text.includes('Rappeler le paiement'));
});

test('what started a chat: an ad (its id, its title), a comment CM AI answered, nothing', () => {
  assert.deepEqual(chatSource('pub 120210000000001'), { kind: 'ad', adId: '120210000000001', label: null });
  assert.deepEqual(chatSource('pub 120210000000001 « Vélo enfant »'), { kind: 'ad', adId: '120210000000001', label: 'Vélo enfant' });
  assert.deepEqual(chatSource('pub « Vélo enfant »'), { kind: 'ad', adId: null, label: 'Vélo enfant' });
  assert.deepEqual(chatSource('Commentaire Facebook (pub) · « Promo montre »'), { kind: 'comment', adId: null, label: 'Promo montre' });
  assert.deepEqual(chatSource('Commentaire Instagram'), { kind: 'comment', adId: null, label: 'Instagram' });
  assert.deepEqual(chatSource(null), { kind: 'direct', adId: null, label: null });
  assert.equal(chatSource('shortlink').kind, 'other');
});

test('Dellal, more: how fast it answers (slow answers sell less), the hours that buy, each ad with what it cost', async () => {
  const { t, p, support } = await server();
  const db = t.shop('public');
  const [p1] = (await db.query(`INSERT INTO products (name, sku, price) VALUES ('Montre Atlas', 'MA-1', 3500) RETURNING id`)).map((r: any) => Number(r.id));
  await db.query(`INSERT INTO ads (id, adset_id, name) VALUES ('120210000000001', 'as1', 'Vidéo montre — octobre')`);
  await db.query(`INSERT INTO ad_daily (day, ad_id, adset_id, spend_cents) VALUES ('2026-10-04', '120210000000001', 'as1', 1500), ('2026-10-05', '120210000000001', 'as1', 500), ('2026-09-20', '120210000000001', 'as1', 9900)`);
  const sold = { follow: 'delivered', total: 4000, lines: [[p1, 1, 3500]] as [number, number, number][] };
  // Monday 5 October, 21:10 in Algeria (20:10 UTC): two chats from the video ad, answered in 8 s and 20 s, one sold
  await chat(db, { at: '2026-10-05T20:10:00Z', source: 'pub 120210000000001', reply: 8, orders: [sold] });
  await chat(db, { at: '2026-10-05T20:40:00Z', source: 'pub 120210000000001 « Montre Atlas »', reply: 20 });
  // a WhatsApp ad with only its title, answered after 3 minutes, an order still on the road
  await chat(db, { at: '2026-10-06T09:00:00Z', source: 'pub « Vélo enfant »', reply: 180, orders: [{ follow: 'shipped', total: 3000, lines: [[p1, 1, 3000]] }] });
  // a comment CM AI answered in private; no ad: answered after 40 minutes
  await chat(db, { at: '2026-10-07T12:00:00Z', source: 'Commentaire Facebook (pub) · « Promo montre »', reply: 2400 });
  await chat(db, { at: '2026-10-08T12:00:00Z', reply: 45, orders: [sold] });
  // never answered by Dellal: handed to the team after 30 s, a person wrote 10 minutes later
  await chat(db, { at: '2026-10-09T12:00:00Z', handoff: { after: 30, team: 600 } });
  // handed, nobody answered
  await chat(db, { at: '2026-10-10T12:00:00Z', reply: 5, handoff: { after: 60 } });

  const m = await p('p.dellal.more', { days: 30 });
  assert.equal(m.speed.answered, 6);
  assert.equal(m.speed.unanswered, 1);
  assert.equal(m.speed.median, 32.5, 'half the customers had their answer within 32.5 s');
  assert.equal(m.speed.underMinute, 66.7);
  assert.deepEqual(
    m.speed.steps.map((x: any) => [x.max, x.chats, x.ordered]),
    [
      [30, 3, 1],
      [60, 1, 1],
      [300, 1, 1],
      [1800, 0, 0],
      [null, 1, 0],
    ],
  );
  assert.deepEqual(m.speed.none, { chats: 1, ordered: 0, conversion: 0 });
  assert.deepEqual(m.speed.team, { chats: 1, median: 600, handed: 2 });
  // the hours (Algeria): Monday (1) at 21:00 holds the two video chats
  const mon = m.hours.find((h: any) => h.dow === 1 && h.hour === 21);
  assert.deepEqual(mon, { dow: 1, hour: 21, chats: 2, ordered: 1 });
  assert.equal(m.hours.reduce((a: number, h: any) => a + h.chats, 0), 7);
  // each ad: the same ad id with or without its title is one ad, named as in Publicité, with its spend in the period
  const video = m.ads.find((a: any) => a.adId === '120210000000001');
  assert.equal(video.label, 'Vidéo montre — octobre');
  assert.deepEqual([video.chats, video.ordered, video.conversion, video.ripeChats, video.sold, video.realSales, video.revenue], [2, 1, 50, 2, 1, 50, 4000]);
  assert.equal(video.spendUsd, 20, 'only the days of the period');
  assert.equal(video.costPerSale, 20);
  const bike = m.ads.find((a: any) => a.label === 'Vélo enfant');
  assert.deepEqual([bike.kind, bike.adId, bike.spendUsd, bike.costPerSale], ['ad', null, null, null]);
  assert.equal(m.ads.find((a: any) => a.kind === 'comment').label, 'Promo montre');
  assert.equal(m.ads.find((a: any) => a.kind === 'direct').chats, 3);
  assert.equal(m.ads[0].adId, '120210000000001', 'the ad with the most chats first');
  assert.equal(m.ads[m.ads.length - 1].kind, 'direct', 'the chats without an ad last');
  // the coach sees the sales, not the money spent
  const s = await p('p.dellal.more', { days: 30 }, support);
  assert.equal(s.ads.find((a: any) => a.adId === '120210000000001').spendUsd, null);
  // one product: only its chats
  const one = await p('p.dellal.more', { days: 30, shopId: (await loadShop(t, { primary: true }))!.id, productId: p1 });
  assert.equal(one.speed.answered, 3);
});

test('is Dellal getting better: each lesson book’s chats, conversion and real sales (the base method first)', async () => {
  const { t, p } = await server();
  const shop = (await loadShop(t, { primary: true }))!;
  const db = t.shop('public');
  const [p1] = (await db.query(`INSERT INTO products (name, sku, price) VALUES ('Montre Atlas', 'MA-1', 3500) RETURNING id`)).map((r: any) => Number(r.id));
  const sold = { follow: 'delivered', total: 4000, lines: [[p1, 1, 3500]] as [number, number, number][] };
  const v1 = (await t.platform.query(`INSERT INTO platform.pilot_books (version, status, lesson_ids, text, promoted_at) VALUES (1, 'champion', '[1]', 'LEÇONS v1', '2026-10-01T09:00:00Z') RETURNING id`))[0].id;
  const v2 = (await t.platform.query(`INSERT INTO platform.pilot_books (version, status, lesson_ids, text) VALUES (2, 'testing', '[1,2]', 'LEÇONS v2') RETURNING id`))[0].id;
  await t.platform.query(`INSERT INTO platform.pilot_tests (champion_id, challenger_id, share, status, started_at) VALUES ($1, $2, 0.2, 'running', '2026-10-20T09:00:00Z')`, [v1, v2]);
  const seen = (conv: number, book: number | null, at: string, arm = 'A') =>
    t.platform.query(`INSERT INTO platform.pilot_exposure (shop_id, conv_id, book_id, arm, at) VALUES ($1, $2, $3, $4, $5)`, [shop.id, conv, book, arm, at]);
  // the base method (September): 4 chats, 1 sold
  for (const [k, o] of [[1, [sold]], [2, []], [3, []], [4, []]] as const) await seen(await chat(db, { at: `2026-09-1${k}T10:00:00Z`, orders: o as any }), null, `2026-09-1${k}T10:00:00Z`);
  // book v1 (October): 3 chats, 2 sold; one more too new for its parcel
  for (const [k, o] of [[2, [sold]], [3, [sold]], [4, []]] as const) await seen(await chat(db, { at: `2026-10-0${k}T10:00:00Z`, orders: o as any }), Number(v1), `2026-10-0${k}T10:00:00Z`);
  await seen(await chat(db, { at: '2026-10-28T10:00:00Z', orders: [{ follow: 'shipped', total: 3000, lines: [[p1, 1, 3000]] }] }), Number(v1), '2026-10-28T10:00:00Z');
  // book v2 in test: 1 chat
  await seen(await chat(db, { at: '2026-10-21T10:00:00Z', orders: [sold] }), Number(v2), '2026-10-21T10:00:00Z', 'B');
  // a test chat is never counted
  await seen(await chat(db, { channel: 'test', at: '2026-10-21T11:00:00Z', orders: [sold] }), Number(v2), '2026-10-21T11:00:00Z', 'B');

  const b = await p('p.dellal.books', {});
  assert.deepEqual(
    b.versions.map((v: any) => [v.version, v.status, v.chats, v.ordered, v.ripeChats, v.sold, v.realSales]),
    [
      [0, 'base', 4, 1, 4, 1, 25],
      [1, 'champion', 4, 3, 3, 2, 66.7],
      [2, 'testing', 1, 1, 1, 1, 100],
    ],
  );
  assert.equal(b.versions[1].from, '2026-10-02T10:00:00.000Z');
  assert.equal(b.test.challengerId, Number(v2));
  assert.equal(b.test.share, 0.2);
  assert.equal((await p('p.dellal.books', { shopId: 999 })).versions.length, 0);
});
