// A delivery already paid that stops being « Livrée » (the owner, 27 Nov 2026: « Take it from next pay »). A company's
// correction, our livreur's tap by mistake or a person's change: whoever was already paid for that delivery
// (confirmation, team leader, suivi) gets it back as a minus line in the period it stopped; nobody paid yet: the order
// just leaves the pay. Delivered again: it counts at its new delivery, once. The pay cancelled, or the change undone: the
// minus line goes away.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DEFAULT_MANAGEMENT_PLAN, payPeriodAt } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { payLedger } from '../modules/pay';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let admin: Ctx;
let zr: number;
let confPlan: number;
let suiviPlan: number;
const H = 3_600_000;
const D = 24 * H;
const cal = { every: 'half' as const };
const open = () => payPeriodAt(cal, Date.now());
/** a moment of the period before the open one (closed: it can be paid) */
const lastPeriod = (h: number) => payPeriodAt(cal, open().from - 1).from + h * H;

before(async () => {
  ({ db, as } = await setup(170));
  admin = await as(EMAILS.admin);
  await call('pay.settings', admin, { calendar: cal, acompte: { max: 5000, fromDay: 5 } });
  zr = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' ORDER BY id LIMIT 1`))[0].id);
  const plan = async (name: string, config: object) =>
    Number((await db.query(`INSERT INTO management_payment_plans (kind, name, configuration) VALUES ('agent', $1, $2) RETURNING id`, [name, JSON.stringify(config)]))[0].id);
  const noUp = { enabled: false, method: 'qty', rate: 0, trigger: 'delivered', ruleVersion: 2 };
  confPlan = await plan('Confirmation · 100 par livrée', { ...DEFAULT_MANAGEMENT_PLAN, agentTask: 'confirmation', method: 'fixed', rate: 100, trigger: 'delivered', monthly: 0, upsell: noUp });
  suiviPlan = await plan('Suivi · 40 par livrée', { ...DEFAULT_MANAGEMENT_PLAN, agentTask: 'suivi', method: 'fixed', rate: 40, trigger: 'delivered', monthly: 0, upsell: noUp });
});

let n = 0;
/** a new person with a plan since 60 days */
async function person(task: 'confirmation' | 'suivi'): Promise<number> {
  n++;
  const id = Number(
    (await db.query(`INSERT INTO profiles (name, email, password_hash, roles) VALUES ($1, $2, 'x', $3) RETURNING id`, [`Agent ${task} ${n}`, `paie-${task}-${n}@test.pilotix.dz`, `{${task}}`]))[0].id,
  );
  const planId = task === 'confirmation' ? confPlan : suiviPlan;
  const p = (await db.query('SELECT name, configuration FROM management_payment_plans WHERE id = $1', [planId]))[0];
  await db.query('INSERT INTO pay_plan_terms (profile_id, task, plan_id, name, configuration, effective_at) VALUES ($1,$2,$3,$4,$5,$6)', [
    id,
    task,
    planId,
    p.name,
    typeof p.configuration === 'string' ? p.configuration : JSON.stringify(p.configuration),
    new Date(Date.now() - 60 * D).toISOString(),
  ]);
  await db.query('INSERT INTO pay_plan_slots (profile_id, task, plan_id) VALUES ($1,$2,$3)', [id, task, planId]);
  return id;
}

let taken = 0;
/** a confirmed order (never an alert, in no pickup bag), delivered by ZR at `at`, confirmed by `agent`, followed by `follow` */
async function delivered(agent: number, follow: number | null, at: number): Promise<number> {
  const r = (
    await db.query(
      `SELECT o.id FROM orders o WHERE o.conf_status = 'confirmed' AND NOT o.is_exchange
          AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.to_value = 'alert')
          AND NOT EXISTS (SELECT 1 FROM pickup_bag_parcels bp WHERE bp.order_id = o.id)
        ORDER BY o.id LIMIT 1 OFFSET $1`,
      [taken++],
    )
  )[0];
  assert.ok(r, 'enough confirmed orders in the demo');
  const id = Number(r.id);
  await db.query(
    `UPDATE orders SET agent_id = $2, follow_agent_id = $3, company_id = $4, follow_status = 'delivered', sub_status = NULL, ext_status = 'Livré',
       tracking = 'ZR-PAY-' || id, shipped_at = $5::timestamptz - interval '1 day', taken_at = $5::timestamptz - interval '1 day', ext_status_at = $5,
       delivered_at = $5, returning_at = NULL, returned_at = NULL, livreur_id = NULL, handover_id = NULL, locked_by = NULL, cashed = false, fee_taken_at = NULL,
       conf_agency_id = NULL, follow_agency_id = NULL
     WHERE id = $1`,
    [id, agent, follow, zr, new Date(at).toISOString()],
  );
  return id;
}

const view = async (personId: number): Promise<any> => call('pay.person', admin, { personId });
/** pays everything ready for this person (as the owner does in Caisse › Paie) */
async function payAll(personId: number) {
  const v = await view(personId);
  assert.ok(v.ready.total > 0, 'something ready to pay');
  return (await call('pay.pay', admin, { kind: 'pay', personId, caisse: 'main', amount: v.ready.total })) as { id: number };
}
const setFollow = (ctx: Ctx, input: Record<string, unknown>) => call('orders.setFollow', ctx, { clientId: `t-${Math.random()}`, ...input });
const linesOf = (v: any, orderId: number) => (v.rows as any[]).filter((r) => r.orderId === orderId).map((r) => ({ kind: r.kind, amount: r.amount }));

test('paid, then no longer delivered: a minus line in the open period, for the confirmation and the suivi alike', async () => {
  const lina = await person('confirmation');
  const sofiane = await person('suivi');
  const t1 = lastPeriod(2);
  const a = await delivered(lina, sofiane, t1);
  await payAll(lina);
  await payAll(sofiane);
  assert.deepEqual(linesOf(await view(lina), a), [], 'paid: not in the open period');
  await setFollow(admin, { ids: [a], status: 'failed', reason: 'Le livreur a appuyé « Livré » par erreur' });
  const v = await view(lina);
  assert.deepEqual(linesOf(v, a), [{ kind: 'correction', amount: -100 }]);
  const line = v.rows.find((r: any) => r.orderId === a);
  assert.equal(Date.parse(line.was), t1, 'it says when it had been delivered');
  assert.ok(Date.parse(line.at) >= open().from, 'taken back in the open period');
  assert.equal(v.open.back, 100);
  assert.equal(v.open.earned, -100);
  assert.equal(v.open.orders, 0, 'a minus line is no order');
  assert.equal(v.owed, 0);
  assert.deepEqual(linesOf(await view(sofiane), a), [{ kind: 'correction', amount: -40 }], 'the suivi paid for it too');
  const m = (await db.query('SELECT delivered_at, suivi_by FROM pay_takebacks WHERE order_id = $1', [a]))[0];
  assert.equal(Date.parse(m.delivered_at), t1);
  assert.equal(Number(m.suivi_by), sofiane);

  // delivered again: it counts at its new delivery (in the open period) — the minus line and the new one make 0
  await setFollow(admin, { ids: [a], status: 'delivered', reason: 'Livrée finalement' });
  const o = (await db.query('SELECT delivered_at FROM orders WHERE id = $1', [a]))[0];
  assert.ok(Date.parse(o.delivered_at) >= open().from, 'delivered again: its new time');
  const again = await view(lina);
  assert.deepEqual(linesOf(again, a).sort((x, y) => x.amount - y.amount), [{ kind: 'correction', amount: -100 }, { kind: 'order', amount: 100 }]);
  assert.equal(again.open.earned, 0);
  // the next pay day: nothing counted twice (0 for this order in that period), and nothing after it
  const at = payLedger(db, lina, open().to + H);
  const next = await at;
  assert.equal(next.ready.periods[next.ready.periods.length - 1].earned, 0);
  assert.equal(next.ready.total, 0);
  // its first delivery's time is kept in its history (« ↶ Annuler » puts it back)
  const ev = (await db.query(`SELECT data FROM order_events WHERE order_id = $1 AND kind = 'follow_status' AND to_value = 'delivered' ORDER BY at DESC, id DESC LIMIT 1`, [a]))[0];
  const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
  assert.equal(Date.parse(data.prev.da), t1);
});

test('not paid yet, then no longer delivered: the order just leaves the pay (no minus line)', async () => {
  const yanis = await person('confirmation');
  const b = await delivered(yanis, null, Math.min(open().from + H, Date.now() - H));
  assert.deepEqual(linesOf(await view(yanis), b), [{ kind: 'order', amount: 100 }]);
  await setFollow(admin, { ids: [b], status: 'failed', reason: 'Client absent' });
  const v = await view(yanis);
  assert.deepEqual(linesOf(v, b), []);
  assert.equal(v.open.back, 0);
  assert.equal(v.open.earned, 0);
});

test('the pay that paid it cancelled: no minus line (the period is paid again without it)', async () => {
  const omar = await person('confirmation');
  const c = await delivered(omar, null, lastPeriod(3));
  const paid = await payAll(omar);
  await setFollow(admin, { ids: [c], status: 'failed', reason: 'Refusée' });
  assert.deepEqual(linesOf(await view(omar), c), [{ kind: 'correction', amount: -100 }]);
  await call('pay.cancel', admin, { paymentId: paid.id });
  const v = await view(omar);
  assert.deepEqual(linesOf(v, c), []);
  assert.equal(v.ready.total, 0, 'not delivered: nothing to pay again for it');
  assert.equal(v.open.earned, 0);
});

test('the change undone (« ↶ Annuler »): the minus line goes away, the delivery stays paid once', async () => {
  const yasmine = await person('confirmation');
  const t1 = lastPeriod(4);
  const d = await delivered(yasmine, null, t1);
  await payAll(yasmine);
  await setFollow(admin, { ids: [d], status: 'failed', reason: 'Erreur' });
  assert.deepEqual(linesOf(await view(yasmine), d), [{ kind: 'correction', amount: -100 }]);
  await call('orders.undo', admin, { id: d });
  const o = (await db.query('SELECT follow_status, delivered_at FROM orders WHERE id = $1', [d]))[0];
  assert.equal(o.follow_status, 'delivered');
  assert.equal(Date.parse(o.delivered_at), t1, 'its delivery as before');
  assert.deepEqual(linesOf(await view(yasmine), d), []);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pay_takebacks WHERE order_id = $1', [d]))[0].n, 0);
});

test('a « Livré » undone after its pay (an owner may undo an old change): taken back too', async () => {
  const rym = await person('confirmation');
  const e = await delivered(rym, null, Date.now() - 2 * H);
  // (its « Livré », by the owner, two hours ago — paid since in this test as if its period had closed)
  await db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, at) VALUES ($1, $2, 'follow_status', 'out_for_delivery', 'delivered', $3)`, [
    e,
    admin.session.profile.id,
    new Date(Date.now() - 2 * H).toISOString(),
  ]);
  await db.query(`INSERT INTO pay_payments (profile_id, kind, period_from, period_to, amount, caisse, paid_at) VALUES ($1, 'pay', $2, $3, 100, 'main', now() - interval '1 hour')`, [
    rym,
    new Date(Date.now() - 3 * H).toISOString(),
    new Date(Date.now() - H).toISOString(),
  ]);
  const last = (await db.query(`SELECT id FROM order_events WHERE order_id = $1 AND kind = 'follow_status' ORDER BY at DESC, id DESC LIMIT 1`, [e]))[0];
  await call('orders.undo', admin, { id: e, eventId: Number(last.id) });
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [e]))[0].follow_status, 'out_for_delivery');
  assert.deepEqual(linesOf(await view(rym), e), [{ kind: 'correction', amount: -100 }]);
});

test('ZR corrects a « Livré » already paid (« Retourné »): the next pay takes it back', async () => {
  const ines = await person('confirmation');
  const f = await delivered(ines, null, lastPeriod(5));
  await payAll(ines);
  const zrSays = await as(EMAILS.suivi, {
    courier: async (action: string) => (action === 'track' ? [{ id: f, key: 'retourne', status: 'Retourné', at: null }] : []),
    meta: async () => null,
    hashPassword: async (v: string) => v,
  } as any);
  await call('delivery.sync', zrSays, { companyId: zr });
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [f]))[0].follow_status, 'returning');
  assert.deepEqual(linesOf(await view(ines), f), [{ kind: 'correction', amount: -100 }]);
});
