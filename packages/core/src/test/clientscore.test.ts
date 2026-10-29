// The customer's score out of 100: what really happened weighs most, then what the protection saw, then the network
// (2 sellers at least, never against a customer who received and paid here); a blacklist or stop-desk caps it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call } from '../index';
import { DEFAULT_SCORE_RULES, LEVEL_RANK, normalizeScoreRules, type ClientLevel } from '@pilotix/shared';
import { ClientFacts, scoreClient } from '../modules/clientscore';
import { EMAILS, setup } from './harness';

const none: ClientFacts = { delivered: 0, returned: 0, fake: 0, cancelled: 0, blocked: 0, review: 0, markFake: 0, markCompetitor: 0, network: 0, blacklisted: false, blacklistAuto: false, stopdeskOnly: false };
const score = (f: Partial<ClientFacts>) => scoreClient({ ...none, ...f });

test('a new customer is 60 « nouveau »; parcels delivered and paid raise it, up to 96', () => {
  assert.deepEqual(score({}), { score: 60, level: 'new', reasons: [{ code: 'new', points: 0, n: 0 }] });
  assert.deepEqual([score({ delivered: 1 }).score, score({ delivered: 1 }).level], [72, 'good']);
  assert.deepEqual([score({ delivered: 2 }).score, score({ delivered: 2 }).level], [84, 'top']);
  assert.equal(score({ delivered: 9 }).score, 96);
});

test('refused parcels, fake orders and what the protection saw take points off, each with its reason', () => {
  const s = score({ delivered: 1, returned: 1 });
  assert.deepEqual([s.score, s.level], [54, 'watch']);
  assert.deepEqual(s.reasons.map((r) => [r.code, r.points]), [['returned', -18], ['delivered', 12]]);
  assert.deepEqual([score({ fake: 1 }).score, score({ fake: 1 }).level], [30, 'risk']);
  assert.equal(score({ blocked: 5 }).score, 30); // −10 each, 30 at most
  assert.equal(score({ review: 1 }).score, 56);
  assert.deepEqual([score({ cancelled: 1 }).score, score({ cancelled: 1 }).level], [56, 'good']); // one cancel is not a risk
  assert.equal(score({ returned: 1 }).level, 'watch');
  assert.equal(score({ blocked: 3 }).level, 'risk');
  assert.equal(score({ markFake: 1 }).score, 35);
  assert.equal(score({ markCompetitor: 1, markFake: 1 }).score, 15); // the worse mark only
  assert.equal(score({ fake: 3 }).score, 0); // never under 0
});

test('the network: 2 sellers at least, and never against a customer who received and paid here', () => {
  assert.equal(score({ network: 1 }).score, 60);
  assert.equal(score({ network: 2 }).score, 40);
  assert.equal(score({ network: 6 }).score, 25); // −35 at most
  assert.equal(score({ network: 2 }).level, 'watch');
  assert.equal(score({ network: 3, delivered: 1 }).score, 72); // trusted here: the others' word does not count
  assert.equal(score({ network: 3, delivered: 1, returned: 1 }).score, 29);
  assert.equal(score({ network: null }).score, 60);
});

test('a blacklist or stop-desk caps the score', () => {
  assert.deepEqual([score({ delivered: 3, blacklisted: true }).score, score({ delivered: 3, blacklisted: true }).level], [5, 'risk']);
  assert.equal(score({ blacklisted: true, blacklistAuto: true }).score, 10);
  const s = score({ delivered: 1, stopdeskOnly: true });
  assert.deepEqual([s.score, s.level], [30, 'risk']);
  assert.ok(s.reasons.some((r) => r.code === 'stopdesk'));
});

test('the Clients list and a customer’s history carry the score', async () => {
  const s = await setup(60);
  const admin = await s.as(EMAILS.admin);
  // the order lists (Confirmation, Suivi, Commandes) and an order's page carry it too; a livreur's never
  const conf: any = await call('confirmation.list', await s.as(EMAILS.conf), { sub: 'nouvelles', page: 1, pageSize: 20 });
  assert.ok(conf.rows.length > 0 && conf.rows.every((r: any) => r.clientScore && r.clientScore.score >= 0 && r.clientScore.score <= 100));
  const suivi: any = await call('suivi.list', await s.as(EMAILS.suivi), { tab: 'livres', pageSize: 20 });
  assert.ok(suivi.rows.every((r: any) => r.clientScore && ['new', 'top', 'good', 'watch', 'risk'].includes(r.clientScore.level)));
  const all: any = await call('orders.list', admin, { pageSize: 5 });
  const one: any = await call('orders.get', admin, { id: all.rows[0].id });
  assert.deepEqual(one.clientScore, all.rows[0].clientScore);
  const mine: any = await call('livreur.list', await s.as(EMAILS.livreur), {}).catch(() => null);
  if (mine?.rows) assert.ok(mine.rows.every((r: any) => r.clientScore === undefined));
  const list: any = await call('customers.list', admin, { pageSize: 20 });
  assert.ok(list.rows.length > 0);
  for (const r of list.rows) {
    assert.ok(r.score.score >= 0 && r.score.score <= 100);
    assert.ok(['new', 'top', 'good', 'watch', 'risk'].includes(r.score.level));
  }
  const h: any = await call('customers.history', admin, { id: list.rows[0].id });
  assert.deepEqual(h.customer.score, list.rows[0].score);
});

test('the shop’s own points: a return can cost more, the levels can move, a broken value takes the recommended one', () => {
  const R = normalizeScoreRules({ ...DEFAULT_SCORE_RULES, returned: { each: 30, max: 40 }, levels: { top: 90, good: 60, watch: 40 } });
  assert.equal(scoreClient({ ...none, returned: 1 }, R).score, 30);
  assert.equal(scoreClient({ ...none, returned: 3 }, R).score, 20); // 40 at most now
  assert.equal(scoreClient({ ...none, delivered: 2 }, R).level, 'good'); // 84 is not « très fiable » any more
  assert.equal(scoreClient({ ...none, delivered: 1 }, R).level, 'good');
  // levels that do not go down, numbers out of range, missing parts: the recommended ones
  const bad = normalizeScoreRules({ base: 400, delivered: { each: -5 }, levels: { top: 30, good: 50, watch: 70 } });
  assert.equal(bad.base, 100);
  assert.deepEqual(bad.delivered, { each: 0, max: 36 });
  assert.deepEqual(bad.levels, DEFAULT_SCORE_RULES.levels);
  assert.deepEqual(normalizeScoreRules(null), DEFAULT_SCORE_RULES);
  // the recommended points give exactly the scores above
  assert.deepEqual(scoreClient({ ...none, delivered: 1, returned: 1 }, normalizeScoreRules({})), score({ delivered: 1, returned: 1 }));
});

test('Réglages › Score client: only an admin saves the points, the levels must go down, every score follows', async () => {
  const s = await setup(60);
  const admin = await s.as(EMAILS.admin);
  const got: any = await call('clientscore.rules', await s.as(EMAILS.conf), {});
  assert.deepEqual(got.rules, DEFAULT_SCORE_RULES);
  assert.deepEqual(got.recommended, DEFAULT_SCORE_RULES);
  await assert.rejects(call('clientscore.setRules', await s.as(EMAILS.conf), DEFAULT_SCORE_RULES));
  await assert.rejects(call('clientscore.setRules', admin, { ...DEFAULT_SCORE_RULES, levels: { top: 50, good: 60, watch: 30 } }), /descendre/);
  const before: any = await call('customers.list', admin, { pageSize: 200 });
  // every customer starts at 100 now: nobody known is « risqué » any more unless capped
  await call('clientscore.setRules', admin, { ...DEFAULT_SCORE_RULES, base: 100 });
  const after: any = await call('customers.list', admin, { pageSize: 200 });
  const by = new Map(before.rows.map((r: any) => [r.id, r.score.score]));
  assert.ok(after.rows.some((r: any) => r.score.score > (by.get(r.id) as number)));
  assert.ok(after.rows.every((r: any) => r.score.score >= (by.get(r.id) as number)));
  assert.equal((await call('clientscore.rules', admin, {}) as any).rules.base, 100);
});

test('Clients › filter by level: the same customers and scores as the list, every page', async () => {
  const s = await setup(60);
  const admin = await s.as(EMAILS.admin);
  const all: any = await call('customers.list', admin, { pageSize: 500 });
  for (const level of ['top', 'good', 'watch', 'risk', 'new'] as const) {
    const want = all.rows.filter((r: any) => r.score.level === level);
    const got: any = await call('customers.list', admin, { level, pageSize: 500 });
    assert.equal(got.total, want.length, level);
    // same order as the list, same scores (the facts counted once per table = counted per customer)
    assert.deepEqual(got.rows.map((r: any) => [r.id, r.score]), want.map((r: any) => [r.id, r.score]), level);
  }
  const known = all.rows.filter((r: any) => r.score.level !== 'new');
  assert.ok(known.length > 0);
  const lv = known[0].score.level;
  const p2: any = await call('customers.list', admin, { level: lv, page: 1, pageSize: 1 });
  assert.equal(p2.rows.length, 1);
  assert.equal(p2.total, all.rows.filter((r: any) => r.score.level === lv).length);
});

test('Confirmation › best customers first, and a filter by level', async () => {
  const s = await setup(60);
  const conf = await s.as(EMAILS.admin);
  const base: any = await call('confirmation.list', conf, { sub: 'nouvelles', page: 1, pageSize: 3000 });
  const best: any = await call('confirmation.list', conf, { sub: 'nouvelles', sort: 'score', page: 1, pageSize: 3000 });
  assert.equal(best.total, base.total);
  assert.deepEqual(new Set(best.rows.map((r: any) => r.id)), new Set(base.rows.map((r: any) => r.id)));
  const rank = (r: any) => LEVEL_RANK[(r.clientScore?.level ?? 'new') as ClientLevel] * 1000 + (r.clientScore?.score ?? 60);
  for (let k = 1; k < best.rows.length; k++) assert.ok(rank(best.rows[k - 1]) >= rank(best.rows[k]));
  const worst: any = await call('confirmation.list', conf, { sub: 'nouvelles', sort: 'score', dir: 'asc', page: 1, pageSize: 3000 });
  for (let k = 1; k < worst.rows.length; k++) assert.ok(rank(worst.rows[k - 1]) <= rank(worst.rows[k]));
  // a page of the sorted list is that part of the whole list
  const p2: any = await call('confirmation.list', conf, { sub: 'nouvelles', sort: 'score', page: 2, pageSize: 5 });
  assert.deepEqual(p2.rows.map((r: any) => r.id), best.rows.slice(5, 10).map((r: any) => r.id));
  for (const level of ['top', 'good', 'watch', 'risk', 'new'] as const) {
    const f: any = await call('confirmation.list', conf, { sub: 'nouvelles', level, page: 1, pageSize: 3000 });
    const want = base.rows.filter((r: any) => (r.clientScore?.level ?? 'new') === level);
    assert.equal(f.total, want.length, level);
    assert.deepEqual(f.rows.map((r: any) => r.id), want.map((r: any) => r.id), level);
  }
  // each order carries the reasons of its score (the warning before confirming a risky customer)
  assert.ok(base.rows.every((r: any) => !r.clientScore || (Array.isArray(r.clientScore.reasons) && r.clientScore.reasons.length > 0)));
});
