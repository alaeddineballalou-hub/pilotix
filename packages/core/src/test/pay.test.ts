// Agent pay: the shop's pay days, a plan per job (5 price steps, the real upsell), the owner's red alert for anyone
// without a plan, paying what is ready from a caisse (and cancelling the last pay), acomptes within the room left, and
// the agent's « Reçu » / « Pas encore reçu » (the owners see the second at once).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DEFAULT_MANAGEMENT_PLAN, payIsOn, payPeriodAt, payPeriods, payTasksOf } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { PAY_CARRY_OVER } from '../migrations/098_pay';
import { payOrderShape, planFee } from '../modules/pay';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(250));
});

const H = 3_600_000;
const D = 24 * H;
const at = (s: string) => Date.parse(s);

test('pay days: every 15 days, every month, every week, chosen days — periods cut at 00:00 in Algiers', () => {
  const half = { every: 'half' as const };
  // 8 Nov 2026, 13:00 in Algiers → the 1–15 November period, ready on the 16th at 00:00 (Algiers = UTC+1)
  assert.deepEqual(payPeriodAt(half, at('2026-11-08T12:00:00Z')), { from: at('2026-10-31T23:00:00Z'), to: at('2026-11-15T23:00:00Z') });
  // 23:30 on the 15th in Algiers is still the first half; 00:00 on the 16th is the second
  assert.equal(payPeriodAt(half, at('2026-11-15T22:30:00Z')).to, at('2026-11-15T23:00:00Z'));
  assert.equal(payPeriodAt(half, at('2026-11-15T23:00:00Z')).from, at('2026-11-15T23:00:00Z'));
  assert.equal(payPeriodAt(half, at('2026-11-20T10:00:00Z')).to, at('2026-11-30T23:00:00Z'));
  assert.deepEqual(payPeriodAt({ every: 'month', day: 5 }, at('2026-11-03T10:00:00Z')), { from: at('2026-10-04T23:00:00Z'), to: at('2026-11-04T23:00:00Z') });
  // every Saturday (6): Sunday 8 November → from Saturday 7 at 00:00, 7 days
  assert.deepEqual(payPeriodAt({ every: 'week', weekday: 6 }, at('2026-11-08T12:00:00Z')), { from: at('2026-11-06T23:00:00Z'), to: at('2026-11-13T23:00:00Z') });
  assert.equal(payPeriodAt({ every: 'days', days: [20, 5, 5] }, at('2026-11-08T12:00:00Z')).to, at('2026-11-19T23:00:00Z'));
  const list = payPeriods(half, at('2026-10-02T00:00:00Z'), at('2026-11-08T12:00:00Z'));
  assert.equal(list.length, 3, '1–15 oct, 16–31 oct, 1–15 nov');
  assert.equal(list[1].to, list[2].from);
});

test('the jobs that need a plan; a plan in 5 price steps; the real upsell (services never count)', () => {
  assert.deepEqual(payTasksOf(['confirmation']), ['confirmation']);
  assert.deepEqual(payTasksOf(['agent_manager', 'suivi']), ['superviseur', 'suivi']);
  assert.deepEqual(payTasksOf(['admin', 'confirmation']), []);
  assert.deepEqual(payTasksOf(['vendeur']), []);
  assert.deepEqual(payTasksOf(['livreur']), []);
  const plan = {
    ...DEFAULT_MANAGEMENT_PLAN,
    agentTask: 'confirmation' as const,
    method: 'tier' as const,
    trigger: 'delivered' as const,
    ranges: [
      { from: 0, to: 2000, amount: 50 },
      { from: 2001, to: 5000, amount: 80 },
      { from: 5001, to: 10000, amount: 100 },
      { from: 10001, to: 15000, amount: 150 },
      { from: 15001, to: null, amount: 200 },
    ],
  };
  // a price exactly on a limit goes in the lower step
  assert.deepEqual(planFee(plan, 2000), { fee: 50, step: 0 });
  assert.deepEqual(planFee(plan, 2001), { fee: 80, step: 1 });
  assert.deepEqual(planFee(plan, 15000), { fee: 150, step: 3 });
  assert.deepEqual(planFee(plan, 16950), { fee: 200, step: 4 });
  // 1 ordered, 2 delivered: 1 extra article; a « Montage » service added never counts
  const items = [
    { p: 1, v: 10, q: 2, u: 3400, n: 'Lot de 6 biberons' },
    { p: 9, v: null, q: 1, u: 1500, n: 'Montage' },
  ];
  const s = payOrderShape(items, [{ productId: 1, variantId: 10, qty: 1, unitPrice: 3400 }], new Set([9]));
  assert.equal(s.extra, 1);
  assert.equal(s.price, 3400);
  assert.equal(s.ordered, 1);
  assert.equal(s.qty, 2);
  // the same quantity as ordered: no upsell; another product added: 1 extra
  assert.equal(payOrderShape([{ p: 1, v: 10, q: 1, u: 3400, n: 'x' }], [{ productId: 1, variantId: 10, qty: 1, unitPrice: 3400 }], new Set()).extra, 0);
  assert.equal(payOrderShape([{ p: 1, v: 10, q: 1, u: 3400, n: 'x' }, { p: 2, v: null, q: 1, u: 900, n: 'y' }], [{ productId: 1, variantId: 10, qty: 1, unitPrice: 3400 }], new Set()).extra, 1);
});

test('only the owner sees Caisse › Paie; an agent sees only his own pay', async () => {
  const samira = await as(EMAILS.conf);
  const rania = await as(EMAILS.conf2);
  const vendeur = await as(EMAILS.vendeur);
  await assert.rejects(call('pay.board', samira, {}), /Accès refusé/);
  await assert.rejects(call('pay.board', vendeur, {}), /Accès refused|Accès refusé/);
  await assert.rejects(call('pay.settings', samira, { calendar: { every: 'half' }, acompte: { max: 0, fromDay: 1 } }), /Accès refusé/);
  const mine: any = await call('pay.mine', samira, {});
  assert.equal(mine.person.name, 'Samira');
  assert.deepEqual(mine.plans.map((p: any) => p.task), ['confirmation']);
  assert.equal(mine.plans[0].config.method, 'tier');
  const now = Date.now();
  await assert.rejects(call('pay.rows', samira, { personId: rania.session.profile.id, from: new Date(now - D).toISOString(), to: new Date(now).toISOString() }), /votre propre paie/);
});

test('the owner is told about anyone without a plan; giving the plan clears it and counts from the period start', async () => {
  const admin = await as(EMAILS.admin);
  const board: any = await call('pay.board', admin, {});
  const imane = board.people.find((p: any) => p.name === 'Imane');
  assert.ok(imane, 'Imane is paid here');
  assert.deepEqual(imane.missing, ['confirmation']);
  assert.ok(board.alerts.noPlan.some((x: any) => x.name === 'Imane'));
  // Co-Pilot (Accueil) has the red alert too
  const doc: any = await call('stats.doctor', admin, {});
  assert.ok(doc.items.some((i: any) => i.id === 'payNoPlan' && i.level === 'bad'));
  // a plan made for another job is refused; the confirmation plan is given
  const sup = board.plans.find((p: any) => p.task === 'superviseur');
  const conf = board.plans.find((p: any) => p.task === 'confirmation');
  await assert.rejects(call('pay.assign', admin, { personId: imane.id, task: 'confirmation', planId: sup.id }), /autre travail/);
  await assert.rejects(call('pay.assign', admin, { personId: imane.id, task: 'suivi', planId: board.plans.find((p: any) => p.task === 'suivi').id }), /ne fait pas ce travail/);
  // a monthly calendar cutting on tomorrow's date: the open period started about a month ago
  const day = new Date(Date.now() + H).getUTCDate();
  await call('pay.settings', admin, { calendar: { every: 'month', day: day >= 28 ? 1 : day + 1 }, acompte: { max: 100000, fromDay: 1 } });
  await call('pay.assign', admin, { personId: imane.id, task: 'confirmation', planId: conf.id });
  const after: any = await call('pay.board', admin, {});
  assert.ok(!after.alerts.noPlan.some((x: any) => x.name === 'Imane'));
  const im = await as('imane@demo.pilotix.dz');
  const mine: any = await call('pay.mine', im, {});
  const cal = after.calendar;
  assert.equal(mine.start, new Date(payPeriodAt(cal, Date.now()).from).toISOString(), 'the first plan counts from the start of the open period');
  assert.equal(mine.ready.periods.length, 0);
  assert.equal(mine.open.earned, mine.rows.reduce((s: number, r: any) => s + r.amount, 0));
});

test('acomptes: within the room left, one request at a time, paid from a caisse, « Pas encore reçu » tells the owner', async () => {
  const admin = await as(EMAILS.admin);
  const im = await as('imane@demo.pilotix.dz');
  const mine: any = await call('pay.mine', im, {});
  const room = mine.acompte.available;
  if (room < 1) {
    // nothing earned in this open period on this demo's dates: asking anything is refused
    await assert.rejects(call('pay.ask', im, { amount: 1 }), /au plus 0 DA/);
    return;
  }
  await assert.rejects(call('pay.ask', im, { amount: room + 1 }), new RegExp(`au plus ${room} DA`));
  await call('pay.ask', im, { amount: Math.min(room, 500), note: 'Loyer' });
  await assert.rejects(call('pay.ask', im, { amount: 1 }), /déjà une demande/);
  const board: any = await call('pay.board', admin, {});
  const req = board.people.find((p: any) => p.name === 'Imane').request;
  assert.equal(req.amount, Math.min(room, 500));
  await assert.rejects(call('pay.pay', admin, { kind: 'acompte', requestId: req.id, caisse: 'main', amount: req.amount + 1 }), /le montant demandé/);
  const mainBefore = (await call('caisse.view', admin, { caisse: 'main' }) as any).balance as number;
  const paid: any = await call('pay.pay', admin, { kind: 'acompte', requestId: req.id, caisse: 'main', amount: req.amount });
  const mainAfter = (await call('caisse.view', admin, { caisse: 'main' }) as any).balance as number;
  assert.equal(mainAfter, mainBefore - req.amount, 'the acompte leaves the caisse as a salary expense');
  const move = (await db.query(`SELECT category, note FROM cash_moves WHERE id = (SELECT cash_move_id FROM pay_payments WHERE id = $1)`, [paid.id]))[0];
  assert.equal(move.category, 'salary');
  assert.match(move.note, /Acompte · Imane/);
  // she has not got it: the owner's red alert; then she has it: the alert goes
  let now: any = await call('pay.mine', im, {});
  assert.ok(now.toConfirm.some((p: any) => p.id === paid.id));
  assert.equal(now.open.acomptes, req.amount);
  await call('pay.answer', im, { paymentId: paid.id, received: false, note: 'Pas encore vu' });
  assert.ok(((await call('pay.board', admin, {})) as any).alerts.notReceived.some((x: any) => x.id === paid.id));
  await call('pay.answer', im, { paymentId: paid.id, received: true });
  assert.ok(!((await call('pay.board', admin, {})) as any).alerts.notReceived.some((x: any) => x.id === paid.id));
  now = await call('pay.mine', im, {});
  assert.ok(!now.toConfirm.some((p: any) => p.id === paid.id));
  await assert.rejects(call('pay.answer', im, { paymentId: paid.id, received: false }), /déjà confirmé/);
  // someone else's payment cannot be answered
  const samira = await as(EMAILS.conf);
  await assert.rejects(call('pay.answer', samira, { paymentId: paid.id, received: true }), /introuvable/);
});

test('paying what is ready: the whole amount from a caisse, only the last pay can be cancelled', async () => {
  const admin = await as(EMAILS.admin);
  // back to every 15 days: the seeded periods
  await call('pay.settings', admin, { calendar: { every: 'half' }, acompte: { max: 5000, fromDay: 5 } });
  const board: any = await call('pay.board', admin, {});
  const rania = board.people.find((p: any) => p.name === 'Rania');
  if (rania.ready.total <= 0) return;
  await assert.rejects(call('pay.pay', admin, { kind: 'pay', personId: rania.id, caisse: 'main', amount: rania.ready.total + 1 }), /montant a changé/);
  await assert.rejects(call('pay.pay', admin, { kind: 'pay', personId: rania.id, caisse: `u${rania.id}`, amount: rania.ready.total }), /caisse de la boutique/);
  const paid: any = await call('pay.pay', admin, { kind: 'pay', personId: rania.id, caisse: 'main', amount: rania.ready.total });
  const after: any = (await call('pay.board', admin, {})) as any;
  const r2 = after.people.find((p: any) => p.id === rania.id);
  assert.equal(r2.ready.periods.length, 0);
  assert.equal(r2.waiting[0].id, paid.id);
  await assert.rejects(call('pay.pay', admin, { kind: 'pay', personId: rania.id, caisse: 'main', amount: 1 }), /Rien n’est prêt/);
  // the older pay (seeded) cannot be cancelled while a newer one stands
  const older = (await db.query(`SELECT id FROM pay_payments WHERE profile_id = $1 AND kind = 'pay' AND id <> $2 AND status <> 'cancelled'`, [rania.id, paid.id]))[0];
  if (older) await assert.rejects(call('pay.cancel', admin, { paymentId: Number(older.id) }), /dernier paiement/);
  await call('pay.cancel', admin, { paymentId: paid.id });
  const r3 = ((await call('pay.board', admin, {})) as any).people.find((p: any) => p.id === rania.id);
  assert.equal(r3.ready.total, rania.ready.total, 'cancelled: ready again');
  const move = (await db.query(`SELECT cancelled_at FROM cash_moves WHERE id = (SELECT cash_move_id FROM pay_payments WHERE id = $1)`, [paid.id]))[0];
  assert.ok(move.cancelled_at, 'its money is back in the caisse');
});

test('plans given before in Management › Plans (« Agent Pay ») carry over to the job, from the 1st of this month', async () => {
  const add = async (name: string, roles: string) =>
    Number((await db.query(`INSERT INTO profiles (name, email, password_hash, roles) VALUES ($1, $2, 'x', $3) RETURNING id`, [name, `${name.toLowerCase()}@old.pilotix.dz`, roles]))[0].id);
  const lina = await add('Lina', '{confirmation}');
  const omar = await add('Omar', '{confirmation}');
  const boss = await add('Boss', '{admin}');
  const plan = async (name: string, config: object) =>
    Number((await db.query(`INSERT INTO management_payment_plans (kind, name, configuration) VALUES ('agent', $1, $2) RETURNING id`, [name, JSON.stringify(config)]))[0].id);
  // an old plan has no job written in it: it is a confirmation plan
  const conf = await plan('Ancien plan confirmation', DEFAULT_MANAGEMENT_PLAN);
  const suivi = await plan('Ancien plan suivi', { ...DEFAULT_MANAGEMENT_PLAN, agentTask: 'suivi', trigger: 'delivered' });
  for (const [who, id] of [[lina, conf], [omar, suivi], [boss, conf]]) await db.query(`INSERT INTO management_plan_assignments (target_kind, target_id, plan_id) VALUES ('agent', $1, $2)`, [who, id]);
  // run twice (a migration may be run again): nothing is doubled
  for (let k = 0; k < 2; k++) for (const sql of PAY_CARRY_OVER) await db.query(sql);
  const terms = await db.query(`SELECT profile_id, task, plan_id, configuration, effective_at FROM pay_plan_terms WHERE profile_id = ANY($1)`, [[lina, omar, boss]]);
  assert.equal(terms.length, 1, 'only Lina: Omar does not do suivi, and owners are not paid here');
  assert.equal(Number(terms[0].profile_id), lina);
  assert.equal(terms[0].task, 'confirmation');
  assert.equal(Number(terms[0].plan_id), conf);
  assert.equal((typeof terms[0].configuration === 'string' ? JSON.parse(terms[0].configuration) : terms[0].configuration).agentTask, 'confirmation');
  // the 1st of this month at 00:00 in Algiers (UTC+1)
  const local = new Date(Date.now() + H);
  assert.equal(new Date(terms[0].effective_at).getTime(), Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - H);
  const board: any = await call('pay.board', await as(EMAILS.admin), {});
  assert.deepEqual(board.people.find((p: any) => p.id === lina).missing, []);
  assert.deepEqual(board.people.find((p: any) => p.id === omar).missing, ['confirmation'], 'Omar still needs a confirmation plan');
});

test('agent pay is a store’s: a partner’s space, or a plan without Caisse › Paie, has no pay action and no pay alert', async () => {
  assert.equal(payIsOn(undefined), true, 'a one-shop server');
  assert.equal(payIsOn({ kind: 'store', features: null }), true);
  assert.equal(payIsOn({ features: ['*'] }), true, 'no kind = a store');
  assert.equal(payIsOn({ kind: 'store', features: ['*', '-caisse/paie'] }), false);
  assert.equal(payIsOn({ kind: 'store', features: ['commandes'] }), false, 'no Caisse at all');
  assert.equal(payIsOn({ kind: 'agency', features: null }), false);
  assert.equal(payIsOn({ kind: 'marketer', features: null }), false);
  const admin = await as(EMAILS.admin);
  const space = { id: 2, slug: 'b', primary: false, locked: false, demo: false, maxUsers: null, maxDrivers: null };
  // a store whose plan has no Caisse › Paie
  const noPaie = { ...space, kind: 'store' as const, features: ['*', '-caisse/paie'] };
  await assert.rejects(call('pay.board', { ...admin, shop: noPaie }, {}), /pas disponible/);
  await assert.rejects(call('pay.mine', { ...(await as(EMAILS.conf)), shop: noPaie }, {}), /pas disponible/);
  const off: any = await call('stats.doctor', { ...admin, shop: noPaie }, {});
  assert.ok(!off.items.some((i: any) => i.id === 'payNoPlan' || i.id === 'payNotReceived'));
  // a confirmation agency's own space (its Co-Pilot is not the store's either)
  const shop = { ...space, kind: 'agency' as const, features: null };
  await assert.rejects(call('pay.board', { ...admin, shop }, {}), /pas disponible|agence/);
  await assert.rejects(call('pay.mine', { ...(await as(EMAILS.conf)), shop }, {}), /pas disponible|agence/);
  const here: any = await call('stats.doctor', admin, {});
  assert.ok(here.items.some((i: any) => i.id === 'payNoPlan'));
});
