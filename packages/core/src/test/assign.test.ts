// Affectation automatique (piece A): a new order gets its agent at once — tour de rôle (an agent ×2 gets two in a
// row), moins chargé, only agents on line and in their hours, under their maximum, allowed on the channel; a known
// customer goes back to his agent; a free agent before one on a call; an absent agent gives back what he never touched.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (e: string) => Promise<Ctx>;
let admin: Ctx;
let X: { productId: number; variantId: number };
let ids: number[] = [];
let base: any;

before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  const r = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  X = { productId: Number(r.id), variantId: Number(r.vid) };
  ids = (await db.query(`SELECT id FROM profiles WHERE active AND 'confirmation' = ANY(roles) AND agency_id IS NULL ORDER BY id`)).map((x: any) => Number(x.id));
  base = ((await call('assign.get', admin, {})) as any).cfg;
  // nothing waiting from the demo: only this test's orders get agents
  await db.query(`UPDATE orders SET agent_id = (SELECT min(id) FROM profiles WHERE 'confirmation' = ANY(roles)) WHERE agent_id IS NULL`);
});

let n = 0;
const order = async (phone?: string, extra: object = {}) =>
  (await call('orders.create', admin, { customerName: `Client Auto ${++n}`, phone: phone ?? `0670${String(100000 + n).slice(-6)}`, wilayaId: 16, commune: 'Kouba', address: 'Rue 1', items: [{ ...X, qty: 1 }], ...extra })) as any;
const online = (who: number[], presence = 'online') => db.query(`UPDATE profiles SET last_seen_at = now(), presence = $2 WHERE id = ANY($1)`, [who, presence]);
const offline = (who: number[], min = 30) => db.query(`UPDATE profiles SET last_seen_at = now() - make_interval(mins => $2) WHERE id = ANY($1)`, [who, min]);
const save = (conf: object, extra: object = {}) => call('assign.set', admin, { ...base, conf: { ...base.conf, ...conf }, ...extra });

test('manual by default: nobody is given anything', async () => {
  assert.equal(base.conf.mode, 'manual');
  const o = await order();
  assert.equal(o.agentId, null);
});

test('tour de rôle: one each in turn among the agents on line; ×2 gets two in a row', async () => {
  assert.ok(ids.length >= 3, 'three confirmation agents in the demo');
  const [a, b, c] = ids;
  await offline(ids);
  await online([a, b]);
  await save({ mode: 'turn', max: 0 }, { order: [a, b, c] });
  const got = [];
  for (let k = 0; k < 4; k++) got.push((await order()).agentId);
  assert.deepEqual(new Set(got), new Set([a, b]), 'never the agent not on line');
  assert.equal(got.filter((x) => x === a).length, 2);
  await save({ mode: 'turn', max: 0 }, { order: [a, b, c], agents: { [a]: { out: false, weight: 2, channels: [], products: [], from: null, to: null, langs: [], senior: false } } });
  const got2 = [];
  for (let k = 0; k < 6; k++) got2.push((await order()).agentId);
  assert.equal(got2.filter((x) => x === a).length, 4, 'a ×2 gets twice as many');
});

test('moins chargé, maximum, same customer, a free agent first', async () => {
  const [a, b] = ids;
  await offline(ids);
  await online([a, b]);
  await save({ mode: 'load', max: 0, speedFirst: true, sameClient: true });
  await db.query(`UPDATE orders SET agent_id = NULL WHERE agent_id = ANY($1) AND conf_status = 'new' AND created_at > now() - interval '1 hour'`, [[a, b]]);
  // a has 3 open orders, b none: b gets it
  for (let k = 0; k < 3; k++) await db.query(`UPDATE orders SET agent_id = $1 WHERE id = $2`, [a, (await order()).id]);
  await db.query(`UPDATE orders SET agent_id = $1 WHERE agent_id IS NULL AND created_at > now() - interval '1 hour'`, [a]);
  const o1 = await order('0671000001');
  assert.equal(o1.agentId, b);
  // the same customer orders again: the same agent, whatever the load
  const o2 = await order('0671000001');
  assert.equal(o2.agentId, b);
  // b on a call, a free: a (speed first)
  await online([b], 'call');
  const o3 = await order();
  assert.equal(o3.agentId, a);
  // a at his maximum: b, even on a call
  const load = Number((await db.query(`SELECT count(*)::int AS n FROM orders WHERE agent_id = $1 AND conf_status IN ('new','to_check','no_answer','busy','callback','postponed') AND shipped_at IS NULL`, [a]))[0].n);
  await save({ mode: 'load', max: load, speedFirst: true });
  const o4 = await order();
  assert.equal(o4.agentId, b);
  // everyone full: it waits
  await save({ mode: 'load', max: 1 });
  const o5 = await order();
  assert.equal(o5.agentId, null);
});

test('respect the channels; an absent agent gives back what he never touched', async () => {
  const [a, b] = ids;
  await offline(ids);
  await online([a, b]);
  const ag = (channels: string[]) => ({ out: false, weight: 1, channels, products: [], from: null, to: null, langs: [], senior: false });
  await save({ mode: 'load', max: 0, offlineMin: 15 }, { agents: { [a]: ag(['facebook']), [b]: ag([]) } });
  const o = await order(undefined, { channel: 'tiktok' });
  assert.equal(o.agentId, b, 'a only takes Facebook');
  // b leaves: his untouched order goes back to the queue, then to a — no, a only takes Facebook: it waits
  await offline([b], 20);
  const r = (await call('assign.run', admin, {})) as any;
  assert.ok(r.conf.back >= 1);
  assert.equal((await db.query('SELECT agent_id FROM orders WHERE id = $1', [o.id]))[0].agent_id, null);
  // the history says why
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'note' ORDER BY at DESC LIMIT 1`, [o.id]);
  assert.match(ev[0].note, /agent absent/);
  // a now takes everything: it goes to him
  await save({ mode: 'load', max: 0 }, { agents: {} });
  await call('assign.run', admin, {});
  assert.equal(Number((await db.query('SELECT agent_id FROM orders WHERE id = $1', [o.id]))[0].agent_id), a);
});

test('Suivi: a new alert goes to a suivi agent on line', async () => {
  const s = (await as(EMAILS.suivi)).session.profile.id;
  await online([s]);
  await call('assign.set', admin, { ...base, follow: { ...base.follow, mode: 'load', max: 0 } });
  const o = (await db.query(`SELECT id FROM orders WHERE shipped_at IS NOT NULL AND follow_status = 'out_for_delivery' LIMIT 1`))[0];
  await db.query(`UPDATE orders SET follow_status = 'alert', follow_agent_id = NULL WHERE id = $1`, [o.id]);
  await call('assign.run', admin, {});
  const r = (await db.query('SELECT follow_agent_id FROM orders WHERE id = $1', [o.id]))[0];
  assert.ok(r.follow_agent_id !== null);
  await call('assign.set', admin, base);
});
