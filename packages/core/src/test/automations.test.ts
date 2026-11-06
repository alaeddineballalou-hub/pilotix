// Pilot Automations: each switch does what it says — the « Affectation » and « Messages de livraison » switches are the
// same as on their pages; « Stock revenu » off keeps the « sans stock » orders until « Envoyer au dépôt »; « Dispatch
// automatique » off keeps every picked order in « À attribuer »; « Plus de stock » pauses the ad sets of a product with
// nothing left and closes its pages, then puts back on only what it paused (never one a person started again); the
// evening report comes once, at its hour, with the day's numbers; the slow queue alerts come once an hour at most; the
// come-back offer goes once to the customers delivered X days before who said yes and did not order again.
import { algiersDayStart, slotAt } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { addDays } from '../modules/ads';
import { getAssign } from '../modules/assign';
import { dayReport } from '../modules/automations';
import { livreursToday, ownWaiting } from '../modules/dispatch';
import { pilotConfig } from '../modules/pilot';
import { notifySettings } from '../modules/notify';
import { getSetting, setSetting } from '../settings';
import { EMAILS, setup } from './harness';

const H = 3_600_000;
const MIN = 60_000;
const algDay = (t: number) => new Date(t + H).toISOString().slice(0, 10);
/** a moment of an Algiers day */
const alg = (day: string, hour: number) => Date.parse(day + 'T00:00:00Z') - H + hour * H;
/** the most recent Algiers day whose `hour` (+ margin) is already past */
const pastDay = (hour: number, margin = 0) => {
  const d = algDay(Date.now());
  return alg(d, hour) + margin <= Date.now() ? d : addDays(d, -1);
};
const at = (c: Ctx, t: number): Ctx => ({ ...c, now: () => t });

let db: Db;
let as: (email: string) => Promise<Ctx>;
let admin: Ctx;
let wh: number;

before(async () => {
  ({ db, as } = await setup(150));
  admin = await as(EMAILS.admin);
  wh = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
});

const lines = async (kind: string) => (await db.query(`SELECT * FROM auto_log WHERE kind = $1 ORDER BY at DESC, id DESC`, [kind])) as any[];
const forget = (...keys: string[]) => db.query(`UPDATE settings SET value = value ${keys.map((k) => `- '${k}'`).join(' ')} WHERE key = 'automations_state'`);
/** a product of its own: nothing in stock, nothing promised */
const emptyProduct = async (skip: number) => {
  const p = (await db.query(`SELECT p.id FROM products p WHERE p.active AND NOT p.is_service AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active) ORDER BY p.id OFFSET $1 LIMIT 1`, [skip]))[0];
  const productId = Number(p.id);
  const variants = (await db.query(`SELECT id FROM product_variants WHERE product_id = $1 ORDER BY id`, [productId])).map((r: any) => Number(r.id));
  await db.query('DELETE FROM stock WHERE variant_id = ANY($1)', [variants]);
  await db.query(
    `UPDATE orders SET conf_status = 'cancelled', follow_status = CASE WHEN follow_status IN ('to_prepare','prepared') THEN 'cancelled' ELSE follow_status END
      WHERE id IN (SELECT order_id FROM order_items WHERE variant_id = ANY($1)) AND conf_status IN ('confirmed','no_stock')`,
    [variants],
  );
  const variantId = Number((await db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND active ORDER BY id LIMIT 1`, [productId]))[0].id);
  return { productId, variantId, variants };
};

test('the demo: the automations on, and what they did these last days; only the administrators', async () => {
  const s: any = await call('auto.state', admin, {});
  assert.deepEqual([s.s.stockBack, s.s.autoDispatch, s.s.noStock.on, s.s.evening.on, s.s.queue.on, s.s.comeBack.on], [true, true, true, true, true, true]);
  const kinds = new Set(s.log.map((l: any) => l.kind));
  for (const k of ['evening', 'nostock', 'stockback', 'queue', 'comeback']) assert.ok(kinds.has(k), `a line « ${k} »`);
  const ev = s.log.find((l: any) => l.kind === 'evening');
  const r = await dayReport(db, ev.data.day);
  assert.deepEqual([ev.data.orders, ev.data.delivered, ev.data.cash], [r.orders, r.delivered, r.cash], 'the demo’s own numbers');
  assert.ok(r.orders > 0);
  assert.ok(s.campaigns.some((c: any) => c.id === s.s.comeBack.campaignId && c.name === 'Offre de retour −10 %'));
  assert.ok(s.comeBackSent > 0);
  // in Pilot Ads' log, the pause is Pilot Automations' (not the account it runs as)
  const acts = await db.query(`SELECT * FROM ad_actions WHERE source = 'auto' ORDER BY id`);
  assert.deepEqual(acts.map((a: any) => a.op), ['pause', 'resume']);
  for (const e of [EMAILS.marketer, EMAILS.conf, EMAILS.manager, EMAILS.vendeur]) await assert.rejects(call('auto.state', await as(e), {}), (err: any) => !!err, e);
  await assert.rejects(call('auto.save', await as(EMAILS.manager), { stockBack: false }));
});

test('Affectation and Messages de livraison: the same switches as on their pages, and the mode comes back', async () => {
  const a = await getAssign(db);
  await setSetting(db, 'autoAssign', { ...a, conf: { ...a.conf, mode: 'load' } });
  let s: any = await call('auto.save', admin, { assignConf: false });
  assert.equal(s.assign.conf, 'manual');
  assert.equal((await getAssign(db)).conf.mode, 'manual');
  s = await call('auto.save', admin, { assignConf: true });
  assert.equal(s.assign.conf, 'load', 'its own mode back, not « tour à tour »');
  assert.equal((await getAssign(db)).conf.rotation.on, a.conf.rotation.on, 'the rest of its settings kept');
  s = await call('auto.save', admin, { delivery: false });
  assert.equal(s.delivery, false);
  assert.equal((await notifySettings(db)).enabled, false);
  s = await call('auto.save', admin, { delivery: true });
  assert.equal((await notifySettings(db)).enabled, true);
});

test('Stock revenu off: the orders wait in « Sans stock » until « Envoyer au dépôt »; on again, what can go goes', async () => {
  const X = await emptyProduct(0);
  const order = async () => {
    const o = (await call('orders.create', admin, { customerName: 'Attente Auto', phone: `0696${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, wilayaId: 16, commune: 'Kouba', items: [{ productId: X.productId, variantId: X.variantId, qty: 1 }] })) as any;
    await call('orders.setConf', admin, { ids: [o.id], status: 'confirmed' });
    return Number(o.id);
  };
  const conf = async (id: number) => (await db.query('SELECT conf_status, follow_status FROM orders WHERE id = $1', [id]))[0];
  await call('auto.save', admin, { stockBack: false });
  const a = await order();
  const b = await order();
  assert.equal((await conf(a)).conf_status, 'no_stock');
  await call('catalog.move', await as(EMAILS.depot), { variantId: X.variantId, warehouseId: wh, kind: 'entry', qty: 1, unitCost: 1000 });
  await call('depot.noStock', await as(EMAILS.depot), {});
  assert.equal((await conf(a)).conf_status, 'no_stock', 'the stock came, it still waits');
  const s: any = await call('auto.state', admin, {});
  assert.ok(s.noStock.waiting >= 2);
  assert.ok(s.noStock.ready >= 1, 'one can be served (the oldest)');
  const r: any = await call('auto.release', admin, {});
  assert.ok(r.sent >= 1);
  assert.deepEqual(await conf(a), { conf_status: 'confirmed', follow_status: 'to_prepare' });
  assert.equal((await conf(b)).conf_status, 'no_stock');
  assert.equal((await lines('release'))[0].n, r.sent);
  // on again: the next one goes as soon as its stock is there
  await call('catalog.move', await as(EMAILS.depot), { variantId: X.variantId, warehouseId: wh, kind: 'entry', qty: 1, unitCost: 1000 });
  assert.equal((await conf(b)).conf_status, 'no_stock');
  await call('auto.save', admin, { stockBack: true });
  assert.deepEqual(await conf(b), { conf_status: 'confirmed', follow_status: 'to_prepare' });
});

test('Dispatch automatique off: a picked order waits in « À attribuer », even with its company', async () => {
  const depot = await as(EMAILS.depot);
  const yal = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'yalidine' ORDER BY id LIMIT 1`))[0].id);
  const id = Number((await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND follow_status = 'to_prepare' AND tracking IS NULL AND NOT is_exchange ORDER BY id LIMIT 1`))[0].id);
  await db.query('UPDATE orders SET company_id = $2, livreur_id = NULL WHERE id = $1', [id, yal]);
  await call('auto.save', admin, { autoDispatch: false });
  await db.query('UPDATE order_items SET picked_qty = qty WHERE order_id = $1', [id]);
  const r: any = await call('depot.toAssign', depot, {});
  assert.ok(r.rows.some((o: any) => o.id === id), 'in « À attribuer »');
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status, 'to_prepare');
  assert.ok(((await call('auto.state', admin, {})) as any).noStock.toAssign >= 1);
  await call('auto.save', admin, { autoDispatch: true });
  const again: any = await call('depot.toAssign', depot, {});
  assert.ok(!again.rows.some((o: any) => o.id === id));
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status, 'prepared', 'to « En dispatch » by itself');
});

test('Plus de stock: its ad set paused and its page closed; back with the stock — never one a person started again', async () => {
  const page = (await db.query(`SELECT slug, product_id FROM landing_pages WHERE active ORDER BY id LIMIT 1`))[0];
  await db.query(`UPDATE landing_pages SET stock_mode = 'off' WHERE slug = $1`, [page.slug]);
  const productId = Number(page.product_id);
  const variants = (await db.query(`SELECT id FROM product_variants WHERE product_id = $1 ORDER BY id`, [productId])).map((r: any) => Number(r.id));
  const variantId = Number((await db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND active ORDER BY id LIMIT 1`, [productId]))[0].id);
  const empty = async () => {
    await db.query('DELETE FROM stock WHERE variant_id = ANY($1)', [variants]);
    await db.query(
      `UPDATE orders SET conf_status = 'cancelled', follow_status = CASE WHEN follow_status IN ('to_prepare','prepared') THEN 'cancelled' ELSE follow_status END
        WHERE id IN (SELECT order_id FROM order_items WHERE variant_id = ANY($1)) AND conf_status IN ('confirmed','no_stock')`,
      [variants],
    );
  };
  const fill = () => call('catalog.move', admin, { variantId, warehouseId: wh, kind: 'entry', qty: 5, unitCost: 1000 });
  const run = async () => {
    await forget('stockAt');
    return call('auto.run', admin, {});
  };
  const status = async () => (await db.query(`SELECT status FROM adsets WHERE id = '990000001'`))[0].status;
  const ours = async () => (await db.query(`SELECT * FROM auto_paused WHERE adset_id = '990000001'`))[0];
  const html = async () => ((await call('landing.html', admin, { slug: page.slug, mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/' })) as any).html as string;
  await db.query(`INSERT INTO adsets (id, name, campaign, product_ids, status, currency) VALUES ('990000001', 'Test stock', 'Test', $1, 'ACTIVE', 'USD')`, [[productId]]);
  await run(); // where things stand
  await empty();
  await run();
  assert.equal(await status(), 'PAUSED');
  assert.ok(await ours());
  const pause = (await db.query(`SELECT * FROM ad_actions WHERE object_id = '990000001' ORDER BY id DESC LIMIT 1`))[0];
  assert.deepEqual([pause.op, pause.source, pause.status], ['pause', 'auto', 'done']);
  assert.match(pause.why, /Plus de stock/);
  assert.ok((await lines('nostock')).some((l) => l.data.paused.includes('Test stock')));
  assert.match(await html(), /نفذت الكمية مؤقتاً/, 'the page says « épuisé », no form');
  assert.ok(((await call('auto.state', admin, {})) as any).soldOut.some((p: any) => p.id === productId && p.paused >= 1));
  // a person starts it again with no stock: left alone, not paused again
  await db.query(`UPDATE adsets SET status = 'ACTIVE' WHERE id = '990000001'`);
  await run();
  assert.equal(await status(), 'ACTIVE');
  assert.equal((await ours()).hands_off, true);
  await fill();
  await run();
  assert.equal(await ours(), undefined, 'forgotten once the stock is back');
  assert.equal(await status(), 'ACTIVE');
  assert.doesNotMatch(await html(), /نفذت الكمية مؤقتاً/, 'the page takes orders again');
  // again, alone this time: back on by itself with the stock
  await empty();
  await run();
  assert.equal(await status(), 'PAUSED');
  await fill();
  await run();
  assert.equal(await status(), 'ACTIVE');
  const resume = (await db.query(`SELECT * FROM ad_actions WHERE object_id = '990000001' ORDER BY id DESC LIMIT 1`))[0];
  assert.deepEqual([resume.op, resume.source], ['resume', 'auto']);
  assert.ok((await lines('stockback')).some((l) => l.data.resumed.includes('Test stock')));
  // switched off: what it paused goes back on, and the page takes orders even with no stock
  await empty();
  await run();
  assert.equal(await status(), 'PAUSED');
  await call('auto.save', admin, { noStock: { on: false } });
  assert.equal(await status(), 'ACTIVE');
  assert.equal(await ours(), undefined);
  assert.doesNotMatch(await html(), /نفذت الكمية مؤقتاً/);
  await call('auto.save', admin, { noStock: { on: true } });
  assert.equal(await status(), 'PAUSED', 'on again: checked at once');
  await fill();
  await run();
});

test('Rapport du soir: once a day, at its hour, with the day’s numbers', async () => {
  const day = pastDay(21.5);
  const t = alg(day, 21.5);
  await call('auto.save', admin, { evening: { on: true, hour: 23, to: [] } });
  await forget('eveningDay');
  const n0 = (await lines('evening')).length;
  await call('auto.run', at(admin, t), {});
  assert.equal((await lines('evening')).length, n0, 'not before its hour');
  await call('auto.save', admin, { evening: { on: true, hour: 21, to: [] } });
  await forget('eveningDay');
  await call('auto.run', at(admin, t), {});
  // its own report (sent at t): after 21:00 in Algiers, earlier tests' runs on the real clock send tonight's too
  const l = (await lines('evening')).find((x) => new Date(x.at).getTime() === t);
  assert.equal(l.data.day, day);
  const r = await dayReport(db, day);
  assert.deepEqual([l.data.orders, l.data.confirmed, l.data.delivered, l.data.returned, l.data.cash, l.data.profit], [r.orders, r.confirmed, r.delivered, r.returned, r.cash, r.profit]);
  assert.equal(l.data.people, 1, 'to the administrator');
  await call('auto.run', at(admin, t + 20 * MIN), {});
  assert.equal((await lines('evening')).length, n0 + 1, 'once');
});

test('File d’attente lente: orders waiting, an agent on line who calls nobody — once an hour at most', async () => {
  const calls = await getSetting(db, 'calls');
  const hour = calls.slots[0].from + 3;
  const t = alg(pastDay(hour, 41 * MIN), hour);
  assert.ok(slotAt(t, calls).open && slotAt(t + 31 * MIN, calls).open, 'in the call hours');
  await call('auto.save', admin, { queue: { on: true, waitHours: 2, idleMin: 30, to: [] } });
  await forget('told', 'online', 'queueAt');
  // Rania is on line, three orders wait for her, she has called nobody
  const rania = Number((await db.query(`SELECT id FROM profiles WHERE email = $1`, [EMAILS.conf2]))[0].id);
  await db.query(`DELETE FROM order_events WHERE user_id = $1 AND at > $2`, [rania, new Date(t - 12 * H).toISOString()]);
  const ids = (await db.query(`SELECT id FROM orders WHERE conf_status IN ('new','no_answer') AND follow_status IS NULL ORDER BY id DESC LIMIT 3`)).map((r: any) => Number(r.id));
  await db.query(`UPDATE orders SET agent_id = $2, conf_status = 'new', attempts = 0, next_call_at = NULL, created_at = $3 WHERE id = ANY($1)`, [ids, rania, new Date(algiersDayStart(t) - 2 * H).toISOString()]);
  const seen = (ms: number) => db.query(`UPDATE profiles SET last_seen_at = $2, presence = 'online' WHERE id = $1`, [rania, new Date(ms).toISOString()]);
  await seen(t);
  await call('auto.run', at(admin, t), {});
  const wait = (await lines('queue')).filter((l) => l.data.what === 'wait');
  assert.ok(wait.length && wait[0].data.n >= 3 && wait[0].data.hours >= 2, JSON.stringify(wait[0]?.data));
  assert.ok(!(await lines('queue')).some((l) => l.data.what === 'idle' && l.data.agent === 'Rania' && Date.parse(l.at) >= t), 'just arrived: not yet');
  await seen(t + 31 * MIN);
  await call('auto.run', at(admin, t + 31 * MIN), {});
  const idle = (await lines('queue')).find((l) => l.data.what === 'idle' && l.data.agent === 'Rania');
  assert.ok(idle && idle.data.minutes >= 30 && idle.data.n >= 3, JSON.stringify(idle?.data));
  assert.equal((await lines('queue')).filter((l) => l.data.what === 'wait').length, wait.length, 'the waiting orders: told once this hour');
  await seen(t + 40 * MIN);
  await call('auto.run', at(admin, t + 40 * MIN), {});
  assert.equal((await lines('queue')).filter((l) => l.data.what === 'idle' && l.data.agent === 'Rania').length, 1, 'Rania: once this hour');
});

test('Offre de retour: X days after a delivered order, the customers who said yes and did not order again', async () => {
  const s0: any = await call('auto.state', admin, {});
  const campaignId = s0.s.comeBack.campaignId as number;
  const draft = Number((await db.query(`SELECT id FROM wa_campaigns WHERE status = 'draft' LIMIT 1`))[0].id);
  await assert.rejects(call('auto.save', admin, { comeBack: { on: true, days: 30, campaignId: draft } }), /pas encore approuvé/);
  const t = alg(pastDay(10.5), 10.5);
  const delivered = addDays(algDay(t), -30);
  const X = await emptyProduct(1);
  const customer = async (phone: string) => {
    const o = (await call('orders.create', admin, { customerName: 'Retour Test', phone, wilayaId: 16, commune: 'Kouba', items: [{ productId: X.productId, variantId: X.variantId, qty: 1 }] })) as any;
    const d = alg(delivered, 14);
    await db.query(`UPDATE orders SET conf_status = 'confirmed', follow_status = 'delivered', delivered_at = $2, created_at = $3 WHERE id = $1`, [o.id, new Date(d).toISOString(), new Date(d - 3 * 24 * H).toISOString()]);
    const p = String((await db.query(`SELECT phone FROM orders WHERE id = $1`, [o.id]))[0].phone);
    await db.query(`UPDATE customers SET wa_optin_at = $2, wa_optout_at = NULL, blacklisted = false WHERE phone = $1`, [p, new Date(t - 60 * 24 * H).toISOString()]);
    return p;
  };
  const one = await customer('0697100001');
  const two = await customer('0697100002');
  const three = await customer('0697100003');
  // two ordered again since; three said « Stop »
  await call('orders.create', admin, { customerName: 'Retour Test', phone: two, wilayaId: 16, commune: 'Kouba', items: [{ productId: X.productId, variantId: X.variantId, qty: 1 }] });
  await db.query(`UPDATE customers SET wa_optout_at = $2 WHERE phone = $1`, [three, new Date(t - 24 * H).toISOString()]);
  await call('auto.save', admin, { comeBack: { on: true, days: 30, campaignId } });
  await forget('comeBackDay');
  await call('auto.run', at(admin, t), {});
  const sends = (await db.query(`SELECT phone FROM wa_campaign_sends WHERE campaign_id = $1`, [campaignId])).map((r: any) => String(r.phone));
  assert.ok(sends.includes(one));
  assert.ok(!sends.includes(two), 'ordered again');
  assert.ok(!sends.includes(three), 'said « Stop »');
  assert.equal((await db.query(`SELECT status FROM wa_campaigns WHERE id = $1`, [campaignId]))[0].status, 'sending', 'it leaves at the campaigns’ pace');
  const n = (await lines('comeback')).length;
  assert.ok((await lines('comeback'))[0].n >= 1);
  await call('auto.run', at(admin, t + 30 * MIN), {});
  assert.equal((await lines('comeback')).length, n, 'once a day');
});

test('who is asked to turn on notifications: the people the evening report and the slow queue alerts go to', async () => {
  const mine = async (e: string) => ((await call('auto.alertMine', await as(e), {})) as any).mine as boolean;
  const id = async (e: string) => Number((await db.query(`SELECT id FROM profiles WHERE email = $1`, [e]))[0].id);
  await call('auto.save', admin, { evening: { on: true, hour: 21, to: [] }, queue: { on: true, waitHours: 2, idleMin: 30, to: [] } });
  assert.equal(await mine(EMAILS.admin), true, 'the evening report: the administrators');
  assert.equal(await mine(EMAILS.conf), false, 'an agent: no');
  const boss = await id(EMAILS.manager);
  await db.query(`UPDATE profiles SET can_assign = true WHERE id = $1`, [boss]);
  assert.equal(await mine(EMAILS.manager), true, 'the queue alerts: the managers');
  // the people chosen instead
  await call('auto.save', admin, { queue: { on: true, waitHours: 2, idleMin: 30, to: [await id(EMAILS.conf2)] } });
  assert.equal(await mine(EMAILS.manager), true, 'still told: the chef d’équipe of his agents');
  assert.equal(await mine(EMAILS.conf2), true);
  await db.query(`UPDATE profiles SET can_assign = false WHERE id = $1`, [boss]);
  // off: nobody for it
  await call('auto.save', admin, { evening: { on: false, hour: 21, to: [] }, queue: { on: false, waitHours: 2, idleMin: 30, to: [] } });
  assert.equal(await mine(EMAILS.admin), false);
  // « Envoyer un essai » (no phone here)
  assert.deepEqual(await call('auto.pushTest', admin, {}), { sent: 0 });
  await call('auto.save', admin, { evening: { on: true, hour: 21, to: [] }, queue: { on: true, waitHours: 2, idleMin: 30, to: [] } });
});

/** Walid and Lamine, livreurs of our « Livraison privée », on a clean day (no parcel yet, nobody checked in, nothing
 *  waiting for a livreur); `ready()` makes a confirmed order of it, all picked, with no livreur */
const livreurDay = async (from: number) => {
  const own = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'own' AND active ORDER BY id LIMIT 1`))[0].id);
  const lamine = Number((await db.query(`SELECT id FROM profiles WHERE email = $1`, [EMAILS.livreur]))[0].id);
  const other = (await db.query(`SELECT id, email FROM profiles WHERE 'livreur' = ANY(roles) AND active AND id <> $1 ORDER BY id LIMIT 1`, [lamine]))[0];
  const walid = Number(other.id);
  await db.query(`UPDATE profiles SET livreur_company_id = $2 WHERE id = ANY($1)`, [[lamine, walid], own]);
  // a clean day for the two: no parcel yet today, nothing else waiting for a livreur
  const dayStart = new Date(algiersDayStart(Date.now())).toISOString();
  await db.query(
    `UPDATE orders SET livreur_id = NULL WHERE livreur_id = ANY($1) AND (follow_status IN ('prepared','shipped','out_for_delivery','failed','alert','in_exchange','returning') OR delivered_at >= $2 OR returned_at >= $2)`,
    [[lamine, walid], dayStart],
  );
  for (const oid of await ownWaiting(db)) await db.query(`UPDATE order_items SET picked_qty = 0 WHERE order_id = $1`, [oid]);
  await db.query(`DELETE FROM livreur_checkins`);
  const X = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, 500) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = 500', [X.vid, wh]);
  let k = 0;
  const ready = async () => {
    const o = (await call('orders.create', admin, { customerName: 'Privé Auto', phone: `0695${String(from + ++k).padStart(6, '0')}`, wilayaId: 16, commune: 'Kouba', address: 'Cité 5', items: [{ productId: Number(X.id), variantId: Number(X.vid), qty: 1 }], companyId: own })) as any;
    await call('orders.setConf', admin, { ids: [o.id], status: 'confirmed' });
    await db.query(`UPDATE orders SET company_id = $2, livreur_id = NULL WHERE id = $1`, [o.id, own]);
    await db.query(`UPDATE order_items SET picked_qty = qty WHERE order_id = $1`, [o.id]);
    return Number(o.id);
  };
  const row = async (id: number) => (await db.query(`SELECT follow_status, livreur_id FROM orders WHERE id = $1`, [id]))[0];
  /** Lamine already has `n` parcels in hand */
  const forLamine = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const id = await ready();
      await call('orders.assignCompany', admin, { ids: [id], companyId: own, livreurId: lamine });
      await call('orders.setFollow', admin, { ids: [id], status: 'prepared' });
    }
  };
  return { own, lamine, walid, walidEmail: String(other.email), ready, row, forLamine };
};

test('Livreur automatique: a ready « Livraison privée » order goes to the livreur working today with the fewest parcels', async () => {
  const { lamine, walid, walidEmail, ready, row, forLamine } = await livreurDay(400000);
  // Walid says « Je travaille aujourd'hui » first; Lamine already has two parcels
  await call('tournee.checkIn', await as(walidEmail), {});
  await call('tournee.checkIn', await as(EMAILS.livreur), {});
  await forLamine(2);
  assert.deepEqual((await livreursToday(db, Date.now())).map((l) => [l.id, l.n]), [[walid, 0], [lamine, 2]]);
  // off (the default): they wait in « À attribuer »
  const four = [await ready(), await ready(), await ready(), await ready()];
  await call('depot.toAssign', await as(EMAILS.depot), {});
  assert.deepEqual(await row(four[0]), { follow_status: 'to_prepare', livreur_id: null });
  // on: Walid (0) gets the first two, then Walid first again (2 = 2, he checked in first), then Lamine (3 > 2)
  const s: any = await call('auto.save', admin, { livreurAuto: true });
  assert.equal(s.s.livreurAuto, true);
  const got = await Promise.all(four.map(row));
  assert.deepEqual(got.map((r) => Number(r.livreur_id)), [walid, walid, walid, lamine]);
  assert.ok(got.every((r) => r.follow_status === 'prepared'), 'and to « En dispatch » with him');
  const l = (await lines('livreur'))[0];
  assert.equal(l.n, 4);
  assert.deepEqual(l.data.livreurs.map((x: any) => x.n).sort(), [1, 3]);
  // nobody working today: it waits; the job gives it as soon as one checks in
  await db.query(`DELETE FROM livreur_checkins`);
  const late = await ready();
  await call('depot.toAssign', await as(EMAILS.depot), {});
  assert.deepEqual(await row(late), { follow_status: 'to_prepare', livreur_id: null });
  assert.equal(((await call('auto.state', admin, {})) as any).livreurs.waiting, 1);
  await call('tournee.checkIn', await as(EMAILS.livreur), {});
  await call('auto.run', admin, {});
  const given = await row(late);
  assert.deepEqual([given.follow_status, Number(given.livreur_id)], ['prepared', lamine]);
  // « Dispatch automatique » off: a manager chooses every parcel, livreur included
  await call('auto.save', admin, { autoDispatch: false });
  const manual = await ready();
  await call('auto.run', admin, {});
  await call('depot.toAssign', await as(EMAILS.depot), {});
  assert.deepEqual(await row(manual), { follow_status: 'to_prepare', livreur_id: null });
  await call('auto.save', admin, { autoDispatch: true, livreurAuto: false });
});

test('Livreur automatique: a livreur with the maximum in hand gets no more until he delivers; 0 is no limit', async () => {
  const { lamine, walid, walidEmail, ready, row, forLamine } = await livreurDay(500000);
  const lv = async (id: number) => {
    const r = await row(id);
    return r.livreur_id ? Number(r.livreur_id) : null;
  };
  await call('tournee.checkIn', await as(walidEmail), {});
  await call('tournee.checkIn', await as(EMAILS.livreur), {});
  await forLamine(2);
  // at most 2 in hand: Walid (0) takes two, then both have 2: the third waits in « À attribuer »
  const three = [await ready(), await ready(), await ready()];
  const s: any = await call('auto.save', admin, { livreurAuto: true, livreurMax: 2 });
  assert.equal(s.s.livreurMax, 2);
  assert.deepEqual(await Promise.all(three.map(lv)), [walid, walid, null]);
  const st: any = await call('auto.state', admin, {});
  assert.equal(st.livreurs.waiting, 1);
  assert.deepEqual(
    st.livreurs.today.map((l: any) => [l.id, l.n, l.hands]).sort((a: number[], b: number[]) => a[0] - b[0]),
    [[walid, 2, 2], [lamine, 2, 2]].sort((a, b) => a[0] - b[0]),
  );
  // Walid delivers one: the job gives him the third
  await db.query(`UPDATE orders SET follow_status = 'delivered', delivered_at = now() WHERE id = $1`, [three[0]]);
  await call('auto.run', admin, {});
  assert.equal(await lv(three[2]), walid);
  // both full again: one more waits; « Pas de limite » (0) gives it at once, to the fewest parcels today
  const more = await ready();
  await call('auto.run', admin, {});
  assert.equal(await lv(more), null);
  await call('auto.save', admin, { livreurMax: 0 });
  assert.equal(await lv(more), lamine, 'Lamine 2 today, Walid 3 (one delivered)');
  // out of range: refused
  await assert.rejects(call('auto.save', admin, { livreurMax: -1 }), (err: any) => !!err);
  await call('auto.save', admin, { livreurAuto: false, livreurMax: 30 });
});

test('Pilot Auto Assign: the same switch as in Sociétés de livraison; a clash between two rules needs its answer first', async () => {
  const keep = await pilotConfig(db);
  let s: any = await call('auto.save', admin, { pilotAuto: false });
  assert.equal(s.pilot.on, false);
  assert.equal((await pilotConfig(db)).mode, 'manual');
  s = await call('auto.save', admin, { pilotAuto: true });
  assert.equal(s.pilot.on, true);
  assert.equal((await pilotConfig(db)).mode, 'auto');
  assert.deepEqual((await pilotConfig(db)).rules, keep.rules, 'the rules stay as they were');
  // two soft rules that meet, no answer yet: not switched on
  const cs = (await db.query(`SELECT id FROM delivery_companies WHERE active AND kind <> 'own' ORDER BY id LIMIT 2`)).map((r: any) => Number(r.id));
  const X = Number((await db.query(`SELECT id FROM products WHERE active AND NOT is_service ORDER BY id LIMIT 1`))[0].id);
  const r = (id: string, p: object) => ({ id, wilayas: [], except: false, communes: [], products: [], strict: false, on: true, ...p });
  await setSetting(db, 'pilot', { mode: 'manual', rules: [r('r1', { products: [X], to: cs[0] }), r('r2', { wilayas: [16], to: cs[1] })] as any, clashes: [] });
  await assert.rejects(call('auto.save', admin, { pilotAuto: true }), /se contredisent/);
  assert.equal((await pilotConfig(db)).mode, 'manual');
  await setSetting(db, 'pilot', keep);
});
