// « Toutes / Non affectées / Affectées » (the owner's ask, 25 Nov 2026): the managers' switch on Confirmation › Nouvelles
// and En cours, and on Suivi's alerts — its numbers, its two sides, and who gets it (never a plain agent).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx } from '../index';
import { EMAILS, setup } from './harness';

let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ as } = await setup(300));
});

test('confirmation.list: the owner and the managers get the numbers, each side keeps its own orders', async () => {
  for (const who of [EMAILS.admin, EMAILS.vendeur, EMAILS.manager]) {
    const ctx = await as(who);
    for (const sub of ['nouvelles', 'attente'] as const) {
      const all: any = await call('confirmation.list', ctx, { sub, pageSize: 3000 });
      assert.ok(all.assign, `${who} › ${sub}: counted`);
      assert.equal(all.assign.free + all.assign.given, all.total, `${who} › ${sub}: the two sides make the list`);
      assert.equal(all.assign.free, all.rows.filter((o: any) => !o.agentId).length);
      const free: any = await call('confirmation.list', ctx, { sub, assigned: 'free', pageSize: 3000 });
      assert.equal(free.total, all.assign.free);
      for (const o of free.rows) assert.equal(o.agentId, null);
      const given: any = await call('confirmation.list', ctx, { sub, assigned: 'given', pageSize: 3000 });
      assert.equal(given.total, all.assign.given);
      for (const o of given.rows) assert.ok(o.agentId, `${o.ref} has an agent`);
      // another sort than the countdown, a small page: the same numbers
      const byTotal: any = await call('confirmation.list', ctx, { sub, sort: 'total', pageSize: 10 });
      assert.deepEqual(byTotal.assign, all.assign);
      assert.equal(byTotal.rows.length, Math.min(10, all.total));
      // a side's pages follow on from one another
      const p1: any = await call('confirmation.list', ctx, { sub, assigned: 'given', pageSize: 5, page: 1 });
      const p2: any = await call('confirmation.list', ctx, { sub, assigned: 'given', pageSize: 5, page: 2 });
      assert.deepEqual([...p1.rows, ...p2.rows].map((o: any) => o.id), given.rows.slice(0, 10).map((o: any) => o.id));
    }
  }
});

test('confirmation.list: a plain agent and the other lists get no numbers', async () => {
  const agent: any = await call('confirmation.list', await as(EMAILS.conf), { sub: 'nouvelles' });
  assert.equal(agent.assign, null);
  const admin = await as(EMAILS.admin);
  for (const sub of ['confirmees', 'terminees'] as const) {
    const l: any = await call('confirmation.list', admin, { sub, pageSize: 5 });
    assert.equal(l.assign, null, sub);
  }
});

test('the agent filter « any »: only the orders someone has', async () => {
  const admin = await as(EMAILS.admin);
  const any: any = await call('confirmation.list', admin, { sub: 'nouvelles', agentId: 'any', pageSize: 3000 });
  for (const o of any.rows) assert.ok(o.agentId);
  const none: any = await call('confirmation.list', admin, { sub: 'nouvelles', agentId: 'none', pageSize: 3000 });
  const all: any = await call('confirmation.list', admin, { sub: 'nouvelles', pageSize: 3000 });
  assert.equal(any.total + none.total, all.total);
});

test('suivi.list: the alerts split for the owner and the managers, never for a suivi agent', async () => {
  for (const who of [EMAILS.vendeur, EMAILS.manager]) {
    const boss = await as(who);
    for (const tab of ['alertes', 'alertes_new', 'alertes_encours'] as const) {
      const all: any = await call('suivi.list', boss, { tab, pageSize: 500 });
      assert.ok(all.assign, `${who} › ${tab}: counted`);
      assert.equal(all.assign.free + all.assign.given, all.total, `${who} › ${tab}: the two sides make the list`);
      const free: any = await call('suivi.list', boss, { tab, assigned: 'free', pageSize: 500 });
      assert.equal(free.total, all.assign.free);
      for (const o of free.rows) assert.equal(o.followAgentId, null);
      const given: any = await call('suivi.list', boss, { tab, assigned: 'given', pageSize: 500 });
      assert.equal(given.total, all.assign.given);
      for (const o of given.rows) assert.ok(o.followAgentId, `${o.ref} has a suivi agent`);
    }
    const road: any = await call('suivi.list', boss, { tab: 'enlivraison', pageSize: 5 });
    assert.equal(road.assign, null, 'only the alerts');
  }
  const agent: any = await call('suivi.list', await as(EMAILS.suivi), { tab: 'alertes' });
  assert.equal(agent.assign, null);
});
