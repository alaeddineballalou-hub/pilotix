// Confirmation in three views (owner's choice, 27 Nov 2026): Super admin (the owner, the administrators), Admin (an agent
// manager, an agency's chiefs) and Agent. An agent manager's « Statistiques » count the same orders as his list (before:
// the whole shop, 82 in the numbers and 50 in his list); « Tous les vendeurs » and « Toutes les boutiques » keep their
// counters and each row its own shop's tries; the red « Appels en retard » banner adds up over an agency's sellers.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx } from '../index';
import { BANNER_FAN, CANCEL_REPORT_FAN, FANOUT, type Part } from '../modules/fanout';
import { EMAILS, setup } from './harness';

let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ as } = await setup(300));
});

/** The same moment for every call of one test (an order's clock can pass its deadline between two calls). */
const at = async (email: string, now: number): Promise<Ctx> => ({ ...(await as(email)), now: () => now });
const KF = { per: '30', basis: 'created' } as const;

test('En cours › Statistiques count the orders of the En cours list, for the owner and for a manager', async () => {
  const now = Date.now();
  for (const who of ['vendeur', 'manager'] as const) {
    const ctx = await at(EMAILS[who], now);
    const list: any = await call('confirmation.list', ctx, { sub: 'attente', pageSize: 5 });
    const st: any = await call('confirmation.enCours', ctx, {});
    assert.equal(st.live.inProgress, list.total, `${who}: the numbers are his list's`);
  }
  const owner: any = await call('confirmation.enCours', await at(EMAILS.vendeur, now), {});
  const mgr: any = await call('confirmation.enCours', await at(EMAILS.manager, now), {});
  assert.ok(mgr.live.inProgress < owner.live.inProgress, 'a manager never counts another team');
});

test('Nouvelles › Statistiques: a manager sees his team and the orders no agent has yet, never another team', async () => {
  const now = Date.now();
  const owner: any = await call('confirmation.firstCall', await at(EMAILS.vendeur, now), KF);
  const mgr: any = await call('confirmation.firstCall', await at(EMAILS.manager, now), KF);
  const mgr2: any = await call('confirmation.firstCall', await at(EMAILS.manager2, now), KF);
  assert.ok(owner.waiting > 0);
  assert.ok(mgr.waiting <= owner.waiting && mgr2.waiting <= owner.waiting);
  // the free orders are every manager's to give out: the same number for all
  assert.equal(mgr.waitingNoAgent, owner.waitingNoAgent);
  assert.equal(mgr2.waitingNoAgent, owner.waitingNoAgent);
  // the two teams' own waiting orders add up to at most the shop's
  assert.ok(mgr.waiting - mgr.waitingNoAgent + (mgr2.waiting - mgr2.waitingNoAgent) <= owner.waiting - owner.waitingNoAgent);
  for (const name of ['confirmation.period', 'confirmation.confirmed', 'confirmation.overview'] as const) {
    const a: any = await call(name, await at(EMAILS.vendeur, now), KF);
    const b: any = await call(name, await at(EMAILS.manager, now), KF);
    assert.ok(a && b, `${name} answers both`);
  }
  const pa: any = await call('confirmation.period', await at(EMAILS.vendeur, now), KF);
  const pb: any = await call('confirmation.period', await at(EMAILS.manager, now), KF);
  assert.ok(pb.received <= pa.received, 'the period counts no order outside his list');
});

const part = (id: number, out: any): Part => ({ seller: { id, name: `Boutique ${id}` }, out });
const row = (id: number, deadlineT: number, extra: Record<string, unknown> = {}) => ({ id, createdAt: new Date(deadlineT).toISOString(), deadline: { t: deadlineT, m: 'first' }, ...extra });

test('« Tous les vendeurs » / « Toutes les boutiques »: the counters add up, each row keeps its shop\'s tries', () => {
  const t0 = Date.UTC(2026, 10, 27, 10);
  const merged = FANOUT['confirmation.list'].merge(
    [
      part(1, { rows: [row(11, t0 + 1), row(12, t0 + 3)], total: 2, assign: { free: 1, given: 1 }, buckets: { late: 2, soon: 0, ontime: 0 }, tries: 6 }),
      part(2, { rows: [row(21, t0 + 2)], total: 1, assign: { free: 0, given: 1 }, buckets: { late: 0, soon: 1, ontime: 0 }, tries: 3 }),
    ],
    { sub: 'nouvelles', page: 1, pageSize: 50 },
  );
  assert.deepEqual(merged.buckets, { late: 2, soon: 1, ontime: 0 });
  assert.deepEqual(merged.assign, { free: 1, given: 2 });
  assert.equal(merged.total, 3);
  assert.deepEqual(
    merged.rows.map((r: any) => [r.id, r.seller.id, r.tries]),
    [
      [11, 1, 6],
      [21, 2, 3],
      [12, 1, 6],
    ],
  );
  // a list that is not a queue (Confirmées): no counters, nothing invented
  const done = FANOUT['confirmation.list'].merge([part(1, { rows: [], total: 0, assign: null, buckets: null, tries: null })], { sub: 'confirmees' });
  assert.equal(done.buckets, null);
});

test('the late-calls banner over every seller: the numbers add up, the next customer comes first', () => {
  const now = Date.now();
  const out = (n: number, next: any) => ({ late: n, now: n, fresh: n, night: 0, firstLate: n, slot: null, nightFrom: 9, next });
  const b = BANNER_FAN.merge(
    [
      part(1, out(2, { id: 5, ref: 'PX5', deadline: { t: now + 40 * 60_000, m: 'first' } })),
      part(2, out(1, { id: 7, ref: 'PX7', deadline: { t: now + 10 * 60_000, m: 'first' } })),
      part(3, out(0, null)),
    ],
    {},
  );
  assert.equal(b.late, 3);
  assert.equal(b.fresh, 3);
  assert.equal(b.next.ref, 'PX7', 'the soonest deadline');
  assert.equal(b.next.seller.id, 2, 'with its seller');
});

test('Terminé › Annulé: everyone reads « Raisons des annulations » on his own orders; the money is the Super admin view\'s', async () => {
  const now = Date.now();
  const range = { from: new Date(now - 60 * 86_400_000).toISOString(), to: new Date(now + 86_400_000).toISOString() };
  const owner: any = await call('orders.cancelReport', await at(EMAILS.vendeur, now), range);
  const admin: any = await call('orders.cancelReport', await at(EMAILS.admin, now), range);
  const mgr: any = await call('orders.cancelReport', await at(EMAILS.manager, now), range);
  const agent: any = await call('orders.cancelReport', await at(EMAILS.conf, now), range);
  assert.equal(typeof owner.returns.fees, 'number', 'the owner sees what the returns cost');
  assert.equal(typeof admin.returns.fees, 'number', 'the administrator too');
  for (const [who, r] of [['manager', mgr], ['agent', agent]] as const) {
    assert.equal(r.returns.fees, null, `${who}: no shop money`);
    assert.equal(r.returns.swapFees, null);
    for (const c of r.returns.companies) assert.equal(c.fees, null);
  }
  assert.ok(agent.conf.n <= mgr.conf.n + owner.conf.n && agent.conf.n <= owner.conf.n, 'an agent counts only his own orders');
  // every agent row of his report is himself
  const me = (await at(EMAILS.conf, now)).session.profile.id;
  for (const a of agent.conf.agents) assert.equal(a.id, me);
});

test('Terminé › Annulé over every shop: the reasons add up, the money only when every shop sent it', () => {
  const rep = (n: number, fees: number | null, reasons: [string, number][]) => ({
    conf: { n, amount: n * 1000, confirmed: 10, rate: null, byStatus: { cancelled: n }, reasons: { top: reasons.map(([reason, k]) => ({ reason, n: k })), others: 1, none: 2 }, agents: [{ id: 7, name: 'Samira', n, confirmed: 10, rate: 0.1 }] },
    returns: { n: 2, returning: 1, returned: 1, amount: 5000, fees, swaps: 0, swapFees: fees === null ? null : 0, delivered: 20, rate: null, reasons: { top: [], others: 0, none: 2 }, companies: [] },
  });
  const both = CANCEL_REPORT_FAN.merge([part(1, rep(3, 400, [['Prix trop cher', 2], ['Changé d’avis', 1]])), part(2, rep(2, 300, [['Prix trop cher', 1]]))], {});
  assert.equal(both.conf.n, 5);
  assert.equal(both.conf.confirmed, 20);
  assert.equal(both.conf.rate, 5 / 25);
  assert.deepEqual(both.conf.reasons.top[0], { reason: 'Prix trop cher', n: 3 });
  assert.equal(both.conf.reasons.none, 4);
  assert.equal(both.conf.byStatus.cancelled, 5);
  assert.deepEqual(both.conf.agents, [], 'the agents table stays one shop\'s');
  assert.equal(both.returns.fees, 700);
  assert.equal(both.returns.rate, 4 / 44);
  const noMoney = CANCEL_REPORT_FAN.merge([part(1, rep(3, null, [])), part(2, rep(2, null, []))], {});
  assert.equal(noMoney.returns.fees, null);
});

test('Suivi « Tous les vendeurs »: the counters (En retard, À appeler vite, À temps) are added up over the sellers', () => {
  const list = (n: number, late: number, soon: number) => ({ rows: Array.from({ length: n }, (_, k) => ({ id: k + 1, ref: `PX${k}`, updatedAt: '2026-11-27T10:00:00Z' })), total: n, page: 1, pageSize: 100, extra: {}, assign: null, buckets: { late, soon, ok: 0 } });
  const out = FANOUT['suivi.list'].merge([part(1, list(2, 1, 1)), part(2, list(3, 2, 0))], { tab: 'alertes_new', page: 1, pageSize: 100 });
  assert.deepEqual(out.buckets, { late: 3, soon: 1, ok: 0 });
  assert.equal(out.total, 5);
});
