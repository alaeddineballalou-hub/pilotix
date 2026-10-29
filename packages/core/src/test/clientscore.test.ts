// The customer's score out of 100: what really happened weighs most, then what the protection saw, then the network
// (2 sellers at least, never against a customer who received and paid here); a blacklist or stop-desk caps it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call } from '../index';
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
  const list: any = await call('customers.list', admin, { pageSize: 20 });
  assert.ok(list.rows.length > 0);
  for (const r of list.rows) {
    assert.ok(r.score.score >= 0 && r.score.score <= 100);
    assert.ok(['new', 'top', 'good', 'watch', 'risk'].includes(r.score.level));
  }
  const one: any = await call('customers.history', admin, { id: list.rows[0].id });
  assert.deepEqual(one.customer.score, list.rows[0].score);
});
