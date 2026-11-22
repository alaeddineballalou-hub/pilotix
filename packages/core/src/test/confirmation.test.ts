// Confirmation queue: lists, deadlines, banner, statistics and their role checks.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { communesOf, DEFAULT_CALL_SETTINGS } from '@pilotix/shared';
import { call, clientFee, Ctx, Db } from '../index';
import { attackOf, cancelReason, computeDue, kfRange, leadOf } from '../modules/confirmation';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

test('confirmation.list returns only the statuses of the sub-page, with default sorts', async () => {
  const ctx = await as(EMAILS.conf);
  const nv: any = await call('confirmation.list', ctx, { sub: 'nouvelles', pageSize: 100 });
  for (const o of nv.rows) assert.equal(o.confStatus, 'new');
  // default: the most urgent call countdown first (late ones at the top)
  const key = (o: any) => (o.deadline ? (o.deadline.m === 'start' ? o.deadline.e ?? o.deadline.t : o.deadline.t) : Infinity);
  for (let k = 1; k < nv.rows.length; k++) assert.ok(key(nv.rows[k - 1]) <= key(nv.rows[k]), 'most urgent first');
  // newest first when asked
  const nw: any = await call('confirmation.list', ctx, { sub: 'nouvelles', sort: 'created_at', dir: 'desc', pageSize: 100 });
  for (let k = 1; k < nw.rows.length; k++) assert.ok(nw.rows[k - 1].createdAt >= nw.rows[k].createdAt, 'newest first');
  // paging by countdown keeps the same order across pages
  const p1: any = await call('confirmation.list', ctx, { sub: 'nouvelles', pageSize: 5, page: 1 });
  const p2: any = await call('confirmation.list', ctx, { sub: 'nouvelles', pageSize: 5, page: 2 });
  assert.deepEqual([...p1.rows, ...p2.rows].map((o: any) => o.id), nv.rows.slice(0, 10).map((o: any) => o.id));
  assert.equal(p2.page, 2);
  const at: any = await call('confirmation.list', ctx, { sub: 'attente', pageSize: 100 });
  for (const o of at.rows) assert.ok(['to_check', 'no_answer', 'busy', 'callback', 'postponed'].includes(o.confStatus));
  const cf: any = await call('confirmation.list', ctx, { sub: 'confirmees', pageSize: 20 });
  for (const o of cf.rows) assert.ok(['confirmed', 'no_stock'].includes(o.confStatus));
  assert.ok(Array.isArray(cf.rows[0].skus) && cf.rows[0].skus.length > 0);
  // a new order has a first-call deadline
  if (nw.rows.length) assert.equal(nw.rows[0].deadline.m, 'first');
  await assert.rejects(call('confirmation.list', ctx, { sub: 'nouvelles', status: 'confirmed' }), /Statut/);
  const counts: any = await call('confirmation.counts', ctx, {});
  assert.equal(counts.nouvelles, nv.total);
  assert.equal(counts.attente, at.total);
});

test('filters: agent "none", wilaya, search', async () => {
  const ctx = await as(EMAILS.admin);
  const none: any = await call('confirmation.list', ctx, { sub: 'nouvelles', agentId: 'none', pageSize: 100 });
  for (const o of none.rows) assert.equal(o.agentId, null);
  const any: any = await call('confirmation.list', ctx, { sub: 'confirmees', pageSize: 1 });
  const w = any.rows[0].wilayaId;
  const byW: any = await call('confirmation.list', ctx, { sub: 'confirmees', wilayaId: w, pageSize: 50 });
  for (const o of byW.rows) assert.equal(o.wilayaId, w);
  const byRef: any = await call('confirmation.list', ctx, { sub: 'confirmees', q: any.rows[0].ref });
  assert.equal(byRef.rows[0].id, any.rows[0].id);
});

test('first-call deadlines: newest first, +pace per newer order, night counts from 9h', () => {
  const s = DEFAULT_CALL_SETTINGS;
  // 10:00 Algiers = 09:00 UTC
  const day = Date.UTC(2026, 9, 21);
  const at = (h: number, m = 0) => day + (h - 1) * 3_600_000 + m * 60_000;
  const row = (id: number, t: number, extra: Partial<any> = {}) => ({ id, ref: 'PX' + id, name: 'X', agentId: 7, createdAt: t, start: t, attempts: 0, nextCallAt: null, lastCallAt: null, status: 'new' as const, ...extra });
  const due = computeDue([row(1, at(10, 0)), row(2, at(10, 1)), row(3, at(2, 0))], s, at(10, 2));
  assert.equal(due.get(2)!.at, at(10, 16), 'newest: 15 min');
  assert.equal(due.get(1)!.at, at(10, 20), 'one newer ahead: +5 min');
  // the night order starts at 9h, two newer orders ahead
  assert.equal(due.get(3)!.at, at(9, 25));
  assert.equal(due.get(3)!.kind, 'first_late');
  // a callback date in the future is "later"
  const cb = computeDue([row(4, at(8), { attempts: 1, nextCallAt: new Date(at(15)).toISOString() })], s, at(10));
  assert.equal(cb.get(4)!.kind, 'later');
  assert.equal(cb.get(4)!.deadline!.m, 'start');
});

test('period ranges follow Algiers days', () => {
  const now = Date.UTC(2026, 9, 21, 22, 30); // 23:30 in Algiers
  const r = kfRange(now, { per: 'today' });
  assert.equal(new Date(r.a).toISOString(), '2026-10-20T23:00:00.000Z');
  assert.equal(r.b - r.a, 86_400_000);
  const c = kfRange(now, { per: 'custom', from: '2026-10-01', to: '2026-10-03' });
  assert.equal(c.b - c.a, 3 * 86_400_000);
});

test('statistics: managers only, numbers add up', async () => {
  const agent = await as(EMAILS.conf);
  await assert.rejects(call('confirmation.firstCall', agent, {}), /Accès refusé/);
  await assert.rejects(call('confirmation.enCours', agent, {}), /Accès refusé/);
  const mgr = await as(EMAILS.manager);
  const fc: any = await call('confirmation.firstCall', mgr, { per: '30' });
  assert.equal(fc.buckets.reduce((a: number, b: number) => a + b, 0), fc.called);
  assert.ok(fc.onTime <= fc.called);
  const pr: any = await call('confirmation.period', mgr, { per: '30' });
  assert.ok(pr.received >= pr.confirmed + pr.cancelled);
  assert.ok(pr.rate === null || (pr.rate >= 0 && pr.rate <= 100));
  const ec: any = await call('confirmation.enCours', mgr, { per: '30' });
  assert.equal(ec.byAgent.reduce((s: number, a: any) => s + a.n, 0), ec.count);
  assert.equal(ec.byAgent.reduce((s: number, a: any) => s + a.confirmed, 0), ec.confirmed);
  assert.ok(ec.complete <= ec.cancelled && ec.lost <= ec.cancelled && ec.recovered <= ec.confirmed);
  assert.ok(ec.confRate === null || (ec.confRate >= 0 && ec.confRate <= 100));
  const cf: any = await call('confirmation.confirmed', mgr, { per: '30' });
  assert.equal(cf.byAgent.reduce((s: number, a: any) => s + a.n, 0), cf.confirmed);
  assert.ok(cf.upsellOrders <= cf.confirmed);
  const dl: any = await call('confirmation.delivery', mgr, { per: '30' });
  assert.ok(dl.delivered <= dl.confirmed);
});

test('a lead: confirmed, refused by a real client, attack or duplicate; the reason the agent wrote', () => {
  assert.equal(leadOf('confirmed', null), 'confirmed');
  assert.equal(leadOf('no_stock', null), 'confirmed', 'confirmed « sans stock » is confirmed');
  assert.equal(leadOf('cancelled', 'Changé d’avis'), 'refused');
  assert.equal(leadOf('cancelled', 'Annulée automatiquement après 3 appels sans réponse'), 'attack', 'no answer after N calls is never the team');
  assert.equal(leadOf('fake', null), 'attack');
  assert.equal(leadOf('cancelled', "N'a pas commandé"), 'attack', 'the client never ordered: a fake');
  assert.equal(attackOf('cancelled', "N'a pas commandé — ce n'est pas lui"), 'fake');
  assert.equal(attackOf('cancelled', 'Annulée automatiquement après 5 appels sans réponse'), 'noAnswer');
  assert.equal(attackOf('wrong_number', null), 'wrong');
  assert.equal(attackOf('cancelled', 'Changé d’avis'), null);
  assert.equal(leadOf('wrong_number', null), 'attack');
  assert.equal(leadOf('duplicate', null), 'duplicate');
  for (const s of ['new', 'to_check', 'no_answer', 'busy', 'callback', 'postponed']) assert.equal(leadOf(s, null), 'pending');
  assert.equal(cancelReason('Frais de livraison trop chers'), 'fee');
  assert.equal(cancelReason('Prix trop cher'), 'price');
  assert.equal(cancelReason("Changé d'avis — c'est pas lui qui a fait la commande"), 'changed_mind');
  assert.equal(cancelReason('Changé d’avis'), 'changed_mind', 'curly apostrophe');
  assert.equal(cancelReason('A commandé ailleurs'), 'elsewhere');
  assert.equal(cancelReason('Délai trop long'), 'too_long');
  assert.equal(cancelReason('Autre — il rappellera'), 'other');
  assert.equal(cancelReason(null), 'none');
});

test('statistics overview: managers only, every lead counted once, Leads quality = confirmed ÷ (confirmed + real refusals)', async () => {
  const agent = await as(EMAILS.conf);
  await assert.rejects(call('confirmation.overview', agent, {}), /Accès refusé/);
  const mgr = await as(EMAILS.manager);
  const ov: any = await call('confirmation.overview', mgr, { per: '30' });
  assert.ok(ov.received > 0);
  assert.equal(ov.confirmed.n + ov.refused.n + ov.attacks.n + ov.duplicates.n + ov.pending.n, ov.received);
  assert.equal(ov.finished, ov.received - ov.pending.n);
  assert.equal(ov.real, ov.confirmed.n + ov.refused.n);
  assert.equal(ov.attacks.fake + ov.attacks.wrong + ov.attacks.noAnswer, ov.attacks.n);
  assert.equal(ov.pending.fresh + ov.pending.noAnswer + ov.pending.later, ov.pending.n);
  assert.equal(ov.refused.reasons.reduce((s: number, r: any) => s + r.n, 0), ov.refused.n);
  assert.equal(ov.refused.reasons.reduce((s: number, r: any) => s + r.value, 0), ov.refused.value);
  assert.equal(ov.hours.length, 24);
  assert.equal(ov.hours.reduce((a: number, b: number) => a + b, 0), ov.received);
  assert.equal(ov.leadsQuality, ov.real ? Math.round((ov.confirmed.n * 100) / ov.real) : null);
  assert.equal(ov.oldRate, ov.finished ? Math.round((ov.confirmed.n * 100) / ov.finished) : null);
  for (const [k, total] of [['confirmed', ov.confirmed.n], ['refused', ov.refused.n], ['attacks', ov.attacks.n], ['duplicates', ov.duplicates.n]] as const)
    assert.equal(ov.byAgent.reduce((s: number, a: any) => s + a[k], 0), total, `byAgent ${k}`);
  for (const a of ov.byAgent) {
    assert.equal(a.fake + a.wrong + a.noAnswer, a.attacks);
    assert.equal(a.leadsQuality, a.confirmed + a.refused ? Math.round((a.confirmed * 100) / (a.confirmed + a.refused)) : null);
    assert.ok(a.upsell <= a.confirmed && a.toCallNight <= a.toCall);
  }
  assert.equal(ov.byAgent.reduce((s: number, a: any) => s + a.toCall, 0) <= ov.pending.n, true);
  for (const p of ov.byProduct) assert.equal(p.confirmed + p.refused + p.attacks + p.duplicates + p.pending, p.n);
  assert.ok(ov.upsell.orders <= ov.confirmed.n);
  assert.ok(ov.night.noAnswer <= ov.night.n && ov.night.noAnswer <= ov.night.noAnswerAll);
  assert.ok(ov.speed.onTime <= ov.speed.dayCalled);
  assert.equal(typeof ov.speed.firstMinutes, 'number');
});

test('statistics overview: a refusal is counted with its reason; « annulée automatiquement » is an attack', async () => {
  const admin = await as(EMAILS.admin);
  const mgr = await as(EMAILS.manager);
  const two = await db.query(`SELECT id, created_at FROM orders WHERE conf_status = 'new' AND agent_id IS NULL AND follow_status IS NULL AND NOT is_exchange ORDER BY id DESC LIMIT 3`);
  assert.equal(two.length, 3);
  const day = (t: unknown) => new Date(Date.parse(String(t instanceof Date ? t.toISOString() : t)) + 3_600_000).toISOString().slice(0, 10);
  const days = two.map((r: any) => day(r.created_at)).sort();
  const range = { per: 'custom', from: days[0], to: day(new Date()) } as const;
  const before: any = await call('confirmation.overview', mgr, range);
  const fee0 = before.refused.reasons.find((r: any) => r.code === 'fee')?.n ?? 0;
  // a real client: « Frais de livraison trop chers »
  await call('orders.setConf', admin, { ids: [Number(two[0].id)], status: 'cancelled', reason: 'Frais de livraison trop chers' });
  // no answer twice with « Annuler après 2 appels sans réponse »: cancelled by itself = an attack
  await db.query(`INSERT INTO settings (key, value) VALUES ('calls', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ...DEFAULT_CALL_SETTINGS, cancelAfterNoAnswer: 2 })]);
  for (let k = 0; k < 2; k++) await call('orders.setConf', admin, { ids: [Number(two[1].id)], status: 'no_answer' });
  // « N'a pas commandé »: the client never ordered = a fake
  await call('orders.setConf', admin, { ids: [Number(two[2].id)], status: 'cancelled', reason: "N'a pas commandé" });
  assert.equal((await db.query('SELECT conf_status FROM orders WHERE id = $1', [two[1].id]))[0].conf_status, 'cancelled');
  await db.query(`DELETE FROM settings WHERE key = 'calls'`);
  const after: any = await call('confirmation.overview', mgr, range);
  assert.equal(after.refused.n, before.refused.n + 1);
  assert.equal(after.refused.reasons.find((r: any) => r.code === 'fee')?.n, fee0 + 1);
  assert.equal(after.attacks.noAnswer, before.attacks.noAnswer + 1);
  assert.equal(after.attacks.fake, before.attacks.fake + 1);
  assert.equal(after.attacks.n, before.attacks.n + 2);
  assert.equal(after.pending.n, before.pending.n - 3);
  assert.equal(after.confirmed.n, before.confirmed.n);
  assert.equal(after.leadsQuality, Math.round((after.confirmed.n * 100) / (after.confirmed.n + after.refused.n)));
});

test('Tentative 02 sets no_answer with two attempts; block blacklists the customer', async () => {
  const ctx = await as(EMAILS.conf);
  // an agent sees only her own orders, given by her manager: « Commande suivante » gives her one
  const give = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL ORDER BY id LIMIT 1`))[0].id;
  await db.query('UPDATE orders SET agent_id = $2, assigned_at = now() WHERE id = $1', [give, ctx.session.profile.id]);
  const o: any = await call('orders.next', ctx, {});
  await call('confirmation.setTry', ctx, { ids: [o.id], n: 2 });
  const cur: any = await call('orders.get', ctx, { id: o.id });
  assert.equal(cur.confStatus, 'no_answer');
  assert.equal(cur.attempts, 2);
  await call('confirmation.block', ctx, { ids: [o.id] });
  const c = (await db.query('SELECT blacklisted FROM customers WHERE id = $1', [cur.customerId]))[0];
  assert.equal(c.blacklisted, true);
  // refused for a depot user
  const depot = await as(EMAILS.depot);
  await assert.rejects(call('confirmation.block', depot, { ids: [o.id] }), /Accès refusé/);
});

test('banner counts the agent orders and gives the next one', async () => {
  const ctx = await as(EMAILS.conf);
  const b: any = await call('confirmation.banner', ctx, {});
  for (const k of ['late', 'now', 'fresh', 'night', 'firstLate']) assert.equal(typeof b[k], 'number');
  if (b.fresh + b.now + b.late + b.night > 0) assert.ok(b.next && b.next.ref.startsWith('PX'));
  const m: any = await call('confirmation.meta', ctx, {});
  assert.ok(m.agents.length >= 3);
  assert.equal(m.manager, false);
  const mine: any = await call('confirmation.mine', ctx, {});
  assert.equal(typeof mine.due, 'number');
});

test('list rows carry stock availability and statuses passed; admin can delete orders still at confirmation only', async () => {
  const { call } = await import('../index');
  const admin = await as(EMAILS.admin);
  const l: any = await call('confirmation.list', admin, { sub: 'attente', pageSize: 50 });
  assert.ok(l.rows.some((r: any) => r.passed.length > 0));
  assert.ok(l.rows.every((r: any) => r.stock === null || r.stock === 'ok' || r.stock === 'short'));
  const fresh: any = await call('confirmation.list', admin, { sub: 'nouvelles', pageSize: 1 });
  const id = fresh.rows[0].id;
  await assert.rejects(call('orders.delete', await as(EMAILS.conf), { ids: [id] }), /refusé/);
  const r: any = await call('orders.delete', admin, { ids: [id] });
  assert.equal(r.deleted, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM orders WHERE id = $1', [id]))[0].n, 0);
  const shipped = (await db.query(`SELECT id FROM orders WHERE follow_status = 'shipped' LIMIT 1`))[0];
  await assert.rejects(call('orders.delete', admin, { ids: [Number(shipped.id)] }), /dépôt ou en livraison/);
});

test('column presets: admin adds and deletes, others only read, names are unique, no edit', async () => {
  const { as } = await setup(20);
  const admin = await as(EMAILS.admin);
  const conf = await as(EMAILS.conf);
  const p: any = await call('confirmation.addColPreset', admin, { name: 'Appels', cols: ['name', 'phone', 'phone', 'wilaya'] });
  assert.deepEqual(p.cols, ['name', 'phone', 'wilaya']);
  await assert.rejects(call('confirmation.addColPreset', admin, { name: 'appels', cols: ['name'] }), /nom/);
  await assert.rejects(call('confirmation.addColPreset', conf, { name: 'X', cols: ['name'] }), /refus/i);
  const seen: any = await call('confirmation.colPresets', conf, {});
  assert.equal(seen.length, 1);
  await assert.rejects(call('confirmation.deleteColPreset', conf, { id: p.id }), /refus/i);
  await call('confirmation.deleteColPreset', admin, { id: p.id });
  assert.equal(((await call('confirmation.colPresets', conf, {})) as any).length, 0);
});

test('delivery choice: bureaus of a wilaya with who delivers, bureau needs a stop desk, home forgets it; catalog has stock', async () => {
  const { db, as } = await setup(40);
  const conf = await as(EMAILS.conf);
  const w = Number((await db.query('SELECT wilaya_id FROM stopdesks ORDER BY id LIMIT 1'))[0].wilaya_id);
  const o = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' ORDER BY id LIMIT 1`))[0];
  // given to the agent (she works on her own orders)
  await db.query('UPDATE orders SET wilaya_id = $2, agent_id = $3 WHERE id = $1', [o.id, w, conf.session.profile.id]);
  o.wilaya_id = w;
  const opts: any = await call('confirmation.deskOptions', conf, { wilayaId: Number(o.wilaya_id) });
  assert.ok(opts.companies.length > 0 && opts.desks.length > 0);
  assert.ok(opts.desks.every((d: any) => typeof d.served === 'boolean' && d.companyName));
  await assert.rejects(call('orders.update', conf, { id: Number(o.id), isStopdesk: true, stopdeskId: null }), /bureau/);
  const d = opts.desks[0];
  const up: any = await call('orders.update', conf, { id: Number(o.id), isStopdesk: true, stopdeskId: d.id, companyId: d.companyId });
  assert.equal(up.isStopdesk, true);
  assert.equal(up.stopdeskId, d.id);
  const home: any = await call('orders.update', conf, { id: Number(o.id), isStopdesk: false });
  assert.equal(home.isStopdesk, false);
  assert.equal(home.stopdeskId, null);
  const cat: any = await call('confirmation.catalog', conf, {});
  assert.ok(cat.some((p: any) => p.variants.some((v: any) => typeof v.stock === 'number')));
});

test('an agent changes the wilaya and commune of an order; the grid price follows the wilaya chosen', async () => {
  const { db, as } = await setup(60);
  const conf = await as(EMAILS.conf);
  const nv: any = await call('confirmation.list', conf, { sub: 'nouvelles', pageSize: 5 });
  const o = nv.rows[0];
  const to = o.wilayaId === 31 ? 16 : 31;
  const grid = (await db.query('SELECT fee_grid FROM products WHERE id = $1', [o.items[0].productId]))[0]?.fee_grid ?? null;
  const g: any = await call('confirmation.gridFee', conf, { id: o.id, isStopdesk: false, wilayaId: to });
  assert.equal(g.fee, await clientFee(db, to, false, grid));
  const now: any = await call('confirmation.gridFee', conf, { id: o.id, isStopdesk: false });
  assert.equal(now.fee, await clientFee(db, o.wilayaId, false, grid));
  const commune = communesOf(to)[0][1];
  const up: any = await call('orders.update', conf, { id: o.id, version: o.version, wilayaId: to, commune, deliveryFee: g.fee });
  assert.equal(up.wilayaId, to);
  assert.equal(up.commune, commune);
  assert.equal(up.deliveryFee, g.fee);
});
