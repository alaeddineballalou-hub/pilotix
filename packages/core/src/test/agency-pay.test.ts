// A confirmation agency's agent pay (the new Paie): a plan per job (confirmation, suivi) asked when the person is added,
// who added him kept, his orders counted in each seller's store (« Mes gains »), and the red alert / the daily push for
// anyone left without a plan (the admins, and the person who added him).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MANAGEMENT_PLAN, NO_AGENCY_PRICES, payIsOn, payTasksIn } from '@pilotix/shared';
import { call, Ctx, login, migrate, migrateAll, pgliteTenancy, seedBase, shopCtx, shopStatus, provisionShop } from '../index';

const PW = 'Agency-Owner-Password-123';
const plan = (task: 'confirmation' | 'suivi', rate: number) => ({ ...structuredClone(DEFAULT_MANAGEMENT_PLAN), agentTask: task, method: 'fixed' as const, trigger: 'delivered' as const, rate });

test('agency pay: the jobs paid there', () => {
  assert.equal(payIsOn({ kind: 'agency', features: [] }), true);
  assert.equal(payIsOn({ kind: 'marketer', features: null }), false);
  assert.deepEqual(payTasksIn('agency', ['confirmation', 'suivi']), ['confirmation', 'suivi']);
  assert.deepEqual(payTasksIn('agency', ['agent_manager']), []);
  assert.deepEqual(payTasksIn('agency', ['agent_manager'], true), ['confirmation']);
  assert.deepEqual(payTasksIn('store', ['agent_manager']), ['superviseur']);
});

test('agency pay: a plan per job when added, orders counted in the sellers\' stores, alerts to the admins and the one who added him', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  try {
    await migrate(t.shop('public'), (s) => t.exec('public', s));
    await seedBase(t.shop('public'), { name: 'Pilotix', email: 'platform@example.dz', password: PW });
    await migrateAll(t);
    const bplan = (await t.platform.query("SELECT id FROM platform.plans WHERE code='business'"))[0];
    const owner = { name: 'Ala Owner', email: 'ala@example.dz' };
    const store = await provisionShop(t, { name: 'Baby Joy', owner, password: PW, verified: true, kind: 'store', planId: Number(bplan.id), trialDays: 30 });
    const agency = await provisionShop(t, { name: 'The Closer', owner, password: PW, verified: true, kind: 'agency', planId: null, trialDays: 0 });
    let clock = Date.now() + 60_000;
    const as = async (s: any, email = owner.email): Promise<Ctx> => ({ db: t.shop(s.schema), session: await login(t.shop(s.schema), email, PW), shop: shopCtx(s, shopStatus(s, clock, 3)), t, now: () => clock, emit: () => {} });
    const rpc = (ctx: Ctx, name: string, input: any = {}) => call(name, ctx, input) as Promise<any>;
    const chief = await as(agency);
    const seller = await as(store);
    await chief.db.query("UPDATE profiles SET phone='0710000001' WHERE id=$1", [chief.session.profile.id]);
    const conf = await rpc(chief, 'management.planSave', { name: 'Conf 100', kind: 'agent', configuration: plan('confirmation', 100) });
    const suivi = await rpc(chief, 'management.planSave', { name: 'Suivi 50', kind: 'agent', configuration: plan('suivi', 50) });

    // the form offers the plans by job
    const ch = await rpc(chief, 'pay.planChoices', {});
    assert.equal(ch.kind, 'agency');
    assert.deepEqual(ch.plans.map((p: any) => [p.name, p.task]).sort(), [['Conf 100', 'confirmation'], ['Suivi 50', 'suivi']]);

    // both jobs ticked: a plan for each is required
    const base = { name: 'Nora', email: 'nora@example.dz', phone: '0710000002', password: PW, roles: ['confirmation', 'suivi'] };
    await assert.rejects(rpc(chief, 'users.create', base), /plan de paie : Confirmation, Suivi/);
    await assert.rejects(rpc(chief, 'users.create', { ...base, plans: [{ task: 'confirmation', planId: conf.id }] }), /plan de paie : Suivi/);
    await assert.rejects(rpc(chief, 'users.create', { ...base, plans: [{ task: 'confirmation', planId: suivi.id }, { task: 'suivi', planId: suivi.id }] }), /autre travail/);
    const nora = await rpc(chief, 'users.create', { ...base, plans: [{ task: 'confirmation', planId: conf.id }, { task: 'suivi', planId: suivi.id }] });
    const terms = await chief.db.query('SELECT task, plan_id FROM pay_plan_terms WHERE profile_id = $1 ORDER BY task', [nora.id]);
    assert.deepEqual(terms.map((r: any) => [r.task, Number(r.plan_id)]), [['confirmation', conf.id], ['suivi', suivi.id]]);
    assert.equal(Number((await chief.db.query('SELECT created_by FROM profiles WHERE id = $1', [nora.id]))[0].created_by), chief.session.profile.id);

    // the agency works for the store: Nora confirms and follows an order there, it is delivered
    await t.platform.query('UPDATE platform.shops SET agency_verified_at=now() WHERE id=$1', [agency.id]);
    await rpc(chief, 'agency.prices', { prices: { ...NO_AGENCY_PRICES, perConfirmed: 5 } });
    const product = Number((await seller.db.query("INSERT INTO products(name,sku,price) VALUES('Vélo','VELO',9000) RETURNING id"))[0].id);
    const link = await rpc(chief, 'agency.request', { storeId: store.id, tasks: ['confirmation', 'suivi'] });
    await rpc(seller, 'partners.answer', { id: link.id, accept: true, products: null });
    const mapped = Number((await seller.db.query('SELECT id FROM profiles WHERE email=$1 AND agency_id=$2', ['nora@example.dz', agency.id]))[0].id);
    const order = await rpc(seller, 'orders.create', { customerName: 'Client', phone: '0661000001', wilayaId: 31, commune: 'Oran', items: [{ productId: product, variantId: null, qty: 1 }] });
    clock += 5000;
    await seller.db.query(
      "UPDATE orders SET conf_status='confirmed', confirmed_at=$2, agent_id=$3, conf_agency_id=$4, follow_agent_id=$3, follow_agency_id=$4, follow_status='delivered', delivered_at=$5 WHERE id=$1",
      [order.id, new Date(clock - 2000).toISOString(), mapped, agency.id, new Date(clock - 1000).toISOString()],
    );
    // « Mes gains »: 100 (confirmation) + 50 (suivi), in the store she worked for
    const me = await as(agency, 'nora@example.dz');
    const mine = await rpc(me, 'pay.mine', {});
    assert.equal(mine.open.earned, 150);
    assert.deepEqual(mine.rows.map((r: any) => [r.task, r.amount, r.agent]).sort(), [['confirmation', 100, 'Baby Joy'], ['suivi', 50, 'Baby Joy']]);
    // the chief's board: Nora, nothing missing; paying needs no caisse balance in an agency
    const board = await rpc(chief, 'pay.board', {});
    assert.equal(board.cashless, true);
    assert.deepEqual(board.people.find((p: any) => p.id === nora.id).missing, []);

    // someone added (by a user manager) without a plan: red alert to the admins and to him, a push once a day
    const lead = await rpc(chief, 'users.create', { name: 'Lina', email: 'lina@example.dz', phone: '0710000003', password: PW, roles: ['agent_manager'] });
    await chief.db.query('UPDATE profiles SET can_manage_users = true WHERE id = $1', [lead.id]);
    const leadCtx = await as(agency, 'lina@example.dz');
    const sami = Number((await chief.db.query("INSERT INTO profiles (name, email, phone, password_hash, roles, created_by) VALUES ('Sami','sami@example.dz','0710000004','x',ARRAY['suivi'],$1) RETURNING id", [lead.id]))[0].id);
    assert.deepEqual((await rpc(leadCtx, 'pay.noPlan', {})).people.map((p: any) => [p.id, p.missing]), [[sami, ['suivi']]]);
    assert.deepEqual((await rpc(chief, 'pay.noPlan', {})).people.map((p: any) => p.id), [sami]);
    assert.deepEqual((await rpc(me, 'pay.noPlan', {})).people, []);
    assert.ok((await rpc(chief, 'pay.noPlanPush', {})).sent >= 2);
    assert.equal((await rpc(chief, 'pay.noPlanPush', {})).skipped, 'today');
    // Utilisateurs: each person's plan per job, and the job without one
    const team = await rpc(chief, 'pay.teamPlans', {});
    assert.deepEqual(team.find((p: any) => p.id === nora.id).plans.map((x: any) => [x.task, x.name]), [['confirmation', 'Conf 100'], ['suivi', 'Suivi 50']]);
    assert.deepEqual(team.find((p: any) => p.id === sami).missing, ['suivi']);
    assert.deepEqual(await rpc(me, 'pay.teamPlans', {}), []);
    // adding the job later asks its plan too
    await assert.rejects(rpc(chief, 'users.update', { id: lead.id, roles: ['agent_manager', 'suivi'] }), /plan de paie : Suivi/);
    await rpc(chief, 'users.update', { id: lead.id, roles: ['agent_manager', 'suivi'], plans: [{ task: 'suivi', planId: suivi.id }] });
  } finally {
    await pg.close();
  }
});
