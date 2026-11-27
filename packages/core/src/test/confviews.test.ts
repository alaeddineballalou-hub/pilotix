// Confirmation in three views (owner's choice, 27 Nov 2026): Super admin (the owner, the administrators), Admin (an agent
// manager, an agency's chiefs) and Agent. An agent manager's « Statistiques » count the same orders as his list (before:
// the whole shop, 82 in the numbers and 50 in his list); « Tous les vendeurs » and « Toutes les boutiques » keep their
// counters and each row its own shop's tries; the red « Appels en retard » banner adds up over an agency's sellers.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx } from '../index';
import { BANNER_FAN, FANOUT, type Part } from '../modules/fanout';
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
    const st: any = await call('confirmation.enCours', ctx, KF);
    assert.equal(st.count, list.total, `${who}: the numbers are his list's`);
  }
  const owner: any = await call('confirmation.enCours', await at(EMAILS.vendeur, now), KF);
  const mgr: any = await call('confirmation.enCours', await at(EMAILS.manager, now), KF);
  assert.ok(mgr.count < owner.count, 'a manager never counts another team');
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
