// Admin + ads: payslips on a small hand-made case, admin-only procedures, the Meta token never leaves the server.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, setSetting } from '../index';
import { computePayroll } from '../modules/admin';
import { adsetDiagnostic, productAdvice } from '../modules/ads';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(120));
});

/** A month far from the demo data, so only our hand-made orders count. */
const base = new Date();
const YM = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - 10, 1)).toISOString().slice(0, 7);
const at = (d: number) => `${YM}-${String(d).padStart(2, '0')}T10:00:00Z`;
async function makeOrder(o: { agent: number; total: number; upsell?: boolean; createdBy?: number; livreur?: number | null; product: number; qty?: number; deliveredBy?: number; preparedBy?: number }) {
  const cust = (await db.query(`INSERT INTO customers (phone, name) VALUES ($1, 'Test') RETURNING id`, [`05${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`]))[0].id;
  const r = (
    await db.query(
      `INSERT INTO orders (ref, customer_id, customer_name, phone, wilaya_id, conf_status, agent_id, follow_status, total, subtotal, has_upsell, created_by, livreur_id, created_at, delivered_at, prepared_at)
       VALUES ('T' || nextval('order_ref_seq'), $1, 'Test', '0550000000', 16, 'confirmed', $2, 'delivered', $3, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [cust, o.agent, o.total, !!o.upsell, o.createdBy ?? null, o.livreur ?? null, at(2), at(10), at(5)],
    )
  )[0].id;
  await db.query(`INSERT INTO order_items (order_id, product_id, name, qty, unit_price) VALUES ($1, $2, 'x', $3, 1000)`, [r, o.product, o.qty ?? 1]);
  if (o.deliveredBy) await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value) VALUES ($1, $3, $2, 'follow_status', 'out_for_delivery', 'delivered')`, [r, o.deliveredBy, at(10)]);
  if (o.preparedBy) await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value) VALUES ($1, $3, $2, 'follow_status', 'to_prepare', 'prepared')`, [r, o.preparedBy, at(5)]);
  return r;
}

test('payroll: agents above / below threshold, upsell, managers by team, suivi, dépôt, livreurs light / heavy', async () => {
  const id = async (email: string) => (await as(email)).session.profile.id;
  const samira = await id(EMAILS.conf);
  const rania = await id(EMAILS.conf2);
  const yacine = await id(EMAILS.manager);
  const nadia = await id(EMAILS.suivi);
  const karim = await id(EMAILS.depot);
  const lamine = await id(EMAILS.livreur);
  const light = (await db.query(`SELECT id FROM products WHERE sku = 'PX-BIB'`))[0].id; // 0.2 kg
  const heavy = (await db.query(`SELECT id FROM products WHERE sku = 'PX-LIT'`))[0].id; // 9 kg
  await setSetting(db, 'payPlans', {
    agent: { threshold: 5000, below: 80, above: 100, upsellBonus: 50, formOrder: 30 },
    manager: { perDelivered: 20 },
    suivi: { perDelivered: 15 },
    depot: { perPrepared: 10 },
    livreur: { light: 150, heavy: 250, heavyFromKg: 5 },
  });
  await setSetting(db, 'teams', [{ id: 't1', name: 'Équipe Yacine', managerId: yacine, agentIds: [samira, rania] }]);

  await makeOrder({ agent: samira, total: 6000, upsell: true, product: light, livreur: lamine, deliveredBy: nadia, preparedBy: karim });
  await makeOrder({ agent: samira, total: 4000, product: heavy, livreur: lamine, deliveredBy: nadia, preparedBy: karim });
  await makeOrder({ agent: samira, total: 4999, product: light, createdBy: samira, preparedBy: karim });
  await makeOrder({ agent: rania, total: 9000, upsell: true, product: heavy, qty: 1 });

  const p = await computePayroll(db, YM);
  const s = p.agents.find((a) => a.id === samira)!;
  // 1 above (100) + 2 below (2 × 80) + 1 upsell (50) + 1 typed by herself (30) = 340
  assert.equal(s.count, 3);
  assert.equal(s.pay, 340);
  assert.equal(p.agents.find((a) => a.id === rania)!.pay, 150);
  // manager: 4 delivered orders of his team × 20
  assert.equal(p.managers.find((m) => m.id === yacine)!.pay, 80);
  // suivi: 2 orders she set delivered × 15
  assert.equal(p.suivi.find((m) => m.id === nadia)!.pay, 30);
  // dépôt: 3 prepared × 10
  assert.equal(p.depot.find((m) => m.id === karim)!.pay, 30);
  // livreur: one light (150) + one heavy (250)
  assert.equal(p.livreurs.find((m) => m.id === lamine)!.pay, 400);
  assert.equal(p.total, p.agents.reduce((x, a) => x + a.pay, 0) + 80 + 30 + 30 + 400);

  // same through the procedure, as admin
  const viaProc: any = await call('admin.payroll', await as(EMAILS.admin), { month: YM });
  assert.equal(viaProc.total, p.total);
});

test('roles: non-admins are refused on admin procedures', async () => {
  for (const email of [EMAILS.vendeur, EMAILS.manager, EMAILS.conf, EMAILS.marketer]) {
    const ctx = await as(email);
    await assert.rejects(call('admin.payroll', ctx, { month: YM }), (e: any) => e.code === 'forbidden');
    await assert.rejects(call('admin.settings.get', ctx, {}), (e: any) => e.code === 'forbidden');
    await assert.rejects(call('admin.meta.save', ctx, { adAccountId: '123456789', token: 'x'.repeat(40) }), (e: any) => e.code === 'forbidden');
  }
  // everyone can read the status labels (screens show them)
  const s: any = await call('admin.statuses.get', await as(EMAILS.conf), {});
  assert.ok(s.groups.confirmation.base.includes('new'));
  // a depot user cannot open Publicité
  await assert.rejects(call('ads.overview', await as(EMAILS.depot), { from: '2026-10-01', to: '2026-10-21' }), (e: any) => e.code === 'forbidden');
});

test('Meta token is write-only: never returned by any procedure', async () => {
  const admin = await as(EMAILS.admin);
  const token = 'EAAG-secret-token-' + 'z'.repeat(40);
  const r: any = await call('admin.meta.save', admin, { adAccountId: 'act_1234567890', token });
  assert.equal(r.connected, true);
  assert.equal(r.adAccountId, '1234567890');
  const outputs = [r, await call('admin.settings.get', admin, {}), await call('admin.statuses.get', admin, {}), await call('admin.pay.get', admin, {})];
  for (const o of outputs) assert.ok(!JSON.stringify(o).includes('secret-token'), 'token leaked');
  const s: any = outputs[1];
  assert.deepEqual(s.meta, { adAccountId: '1234567890', connected: true });
  // saving again without a token keeps it
  const again: any = await call('admin.meta.save', admin, { adAccountId: '1234567890' });
  assert.equal(again.connected, true);
  // with a server, Publicité calls Meta with the stored connection (never the browser)
  const seen: string[] = [];
  const server: Ctx['server'] = {
    courier: async () => ({}),
    hashPassword: async (p) => p,
    meta: async (action) => {
      seen.push(action);
      return { adsets: [], ads: [], adsetDays: [], adDays: [] };
    },
  };
  const mk = await as(EMAILS.marketer, server);
  const ov: any = await call('ads.overview', mk, { from: '2026-10-01', to: '2026-10-05' });
  assert.deepEqual(seen, ['insights']);
  assert.ok(!JSON.stringify(ov).includes('secret-token'));
  await call('admin.meta.disconnect', admin, {});
  assert.equal(((await call('admin.settings.get', admin, {})) as any).meta.connected, false);
});

test('ads: a marketer only sees his own ad sets; the owner sees all', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
  const mk: any = await call('ads.overview', await as(EMAILS.marketer), { from, to: today });
  const own: any = await call('ads.overview', await as(EMAILS.vendeur), { from, to: today });
  assert.ok(mk.adsets.length >= 1);
  assert.ok(!mk.adsets.some((a: any) => a.id === '120200004'), 'not his ad set');
  assert.ok(own.adsets.some((a: any) => a.id === '120200004'));
  assert.ok(own.totals.spendUsd > mk.totals.spendUsd);
  // he cannot link someone else's ad set
  await assert.rejects(call('ads.link', await as(EMAILS.marketer), { adsetId: '120200004', productIds: [] }), (e: any) => e.code === 'forbidden');
  await call('ads.link', await as(EMAILS.marketer), { adsetId: '120200005', productIds: [mk.catalog[0].id] });
});

test('ads rules: advice and diagnostics', () => {
  const m = (n: number, d: number, avant: number, pub: number) => ({ n, d, r: 0, enRoute: 0, qty: d, rev: 0, achat: 0, liv: 0, conf: 0, ret: 0, avant, pub, net: avant - pub });
  assert.equal(productAdvice(m(10, 3, 10000, 1000), 3000).k, 'wait');
  assert.equal(productAdvice(m(40, 20, -500, 1000), 3000).k, 'loss');
  assert.equal(productAdvice(m(40, 20, 40000, 20000), 3000).k, 'scale');
  assert.equal(productAdvice(m(40, 20, 40000, 36000), 3000).k, 'keep');
  assert.equal(productAdvice(m(40, 10, 40000, 60000), 30000).k, 'cutdel');
  const day = (o: Partial<Record<string, number>>) => ({ day: '2026-10-01', adsetId: 'x', spendCents: 1000, impressions: 1000, reach: 800, clicks: 20, lpv: 15, purchases: 1, video3s: 300, thruplays: 80, ...o });
  const week = (o: Partial<Record<string, number>>) => Array.from({ length: 7 }, () => day(o));
  assert.equal(adsetDiagnostic(week({ video3s: 100 }), week({ video3s: 100 }), null, null).k, 'hook');
  assert.equal(adsetDiagnostic(week({ video3s: 150, clicks: 10 }), week({}), null, null).k, 'fatigue');
  assert.equal(adsetDiagnostic(week({ reach: 300, spendCents: 1400 }), week({}), null, null).k, 'audience');
  assert.equal(adsetDiagnostic(week({ purchases: 0, spendCents: 1000 }), week({}), null, 5).k, 'cut');
  assert.equal(adsetDiagnostic(week({ lpv: 30, purchases: 0, spendCents: 300 }), week({}), null, null).k, 'page');
  assert.equal(adsetDiagnostic(week({ purchases: 2 }), week({}), null, null).k, 'scale');
});
