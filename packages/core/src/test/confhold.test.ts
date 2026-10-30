// One order = one agent: « Commande suivante » and an order opened from a list keep it for one agent; the others see
// who has it and cannot change it (an admin can).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const freeNew = async () =>
  (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL AND (locked_until IS NULL OR locked_until < now()) ORDER BY id LIMIT 1`))[0].id as number;

test('two agents pressing « Commande suivante » at the same moment never get the same customer', async () => {
  const samira = await as(EMAILS.conf);
  const rania = await as(EMAILS.conf2);
  const [a, b]: any[] = await Promise.all([call('orders.next', samira, {}), call('orders.next', rania, {})]);
  assert.ok(a.id && b.id);
  assert.notEqual(a.id, b.id);
  await call('confirmation.release', samira, { id: a.id });
  await call('confirmation.release', rania, { id: b.id });
});

test('an order opened from a list is kept for its agent; another agent sees who has it and cannot change it', async () => {
  const samira = await as(EMAILS.conf);
  const rania = await as(EMAILS.conf2);
  const id = Number(await freeNew());
  const s: any = await call('confirmation.hold', samira, { id });
  assert.equal(s.ok, true);
  const r: any = await call('confirmation.hold', rania, { id });
  assert.equal(r.ok, false);
  assert.ok(r.by && r.by.length > 0, 'the name of who has it');
  // the list shows it to Rania
  const o: any = await call('orders.get', rania, { id });
  assert.equal(o.lockedBy?.id, samira.session.profile.id);
  // Rania's click is refused, the order does not move
  await assert.rejects(call('orders.setConf', rania, { ids: [id], status: 'cancelled', reason: 'Prix' }), /est sur cette commande/);
  assert.equal((await db.query('SELECT conf_status FROM orders WHERE id = $1', [id]))[0].conf_status, 'new');
  // « Commande suivante » does not give it to Rania either
  for (let k = 0; k < 5; k++) {
    const n: any = await call('orders.next', rania, {});
    assert.notEqual(n.id, id);
    if (n.id) await call('confirmation.release', rania, { id: n.id });
  }
  // Samira works on it
  await call('orders.setConf', samira, { ids: [id], status: 'no_answer' });
  assert.equal((await db.query('SELECT conf_status FROM orders WHERE id = $1', [id]))[0].conf_status, 'no_answer');
  await call('confirmation.release', samira, { id });
  // given back, but it is Samira's order now (her first call): Rania still cannot take it
  const again: any = await call('confirmation.hold', rania, { id });
  assert.equal(again.ok, false);
  assert.ok(again.by);
});

test('opening another order gives the first one back; an admin can still act on a held order', async () => {
  const samira = await as(EMAILS.conf);
  const admin = await as(EMAILS.admin);
  const a = Number(await freeNew());
  await call('confirmation.hold', samira, { id: a });
  const b = Number(await freeNew());
  await call('confirmation.hold', samira, { id: b });
  const la = (await db.query('SELECT locked_by FROM orders WHERE id = $1', [a]))[0];
  assert.equal(la.locked_by, null, 'the first order is free again');
  // several at once (bulk): the held one is left as it is, the others go on
  const c = Number(await freeNew());
  const rania = await as(EMAILS.conf2);
  const res: any = await call('orders.setConf', rania, { ids: [b, c], status: 'no_answer' });
  assert.deepEqual(res.changed, [c]);
  assert.equal(res.blocked[0].id, b);
  // the admin unblocks it
  await call('orders.setConf', admin, { ids: [b], status: 'no_answer' });
  assert.equal((await db.query('SELECT conf_status FROM orders WHERE id = $1', [b]))[0].conf_status, 'no_answer');
});

test('who sees which orders: an agent his own, an agent manager his team (not another team), the owner all', async () => {
  const admin = await as(EMAILS.admin);
  const samira = await as(EMAILS.conf);
  const rania = await as(EMAILS.conf2);
  const yacine = await as(EMAILS.manager);
  const amel = await as(EMAILS.manager2);
  const owner = await as(EMAILS.vendeur);
  const S = samira.session.profile.id;
  const R = rania.session.profile.id;
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('teams', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify([{ id: 't1', name: 'Équipe Yacine', managerId: yacine.session.profile.id, agentIds: [S] }, { id: 't2', name: 'Équipe Amel', managerId: amel.session.profile.id, agentIds: [R] }])],
  );
  const free = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL ORDER BY id LIMIT 3`)).map((r: any) => Number(r.id));
  const [x, y, z] = free;
  await call('orders.assignAgent', admin, { ids: [x], agentId: S });
  await call('orders.assignAgent', admin, { ids: [y], agentId: R });
  await db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = ANY($1)', [free]);
  const seen = async (ctx: Ctx) => ((await call('confirmation.list', ctx, { sub: 'nouvelles', pageSize: 500 })) as any).rows.map((o: any) => o.id as number);
  const sS = await seen(samira);
  assert.ok(sS.includes(x) && !sS.includes(y) && !sS.includes(z), 'Samira: only hers');
  for (const id of sS) assert.equal(Number((await db.query('SELECT agent_id FROM orders WHERE id = $1', [id]))[0].agent_id), S);
  const sY = await seen(yacine);
  assert.ok(sY.includes(x) && sY.includes(z) && !sY.includes(y), 'Yacine: his team and the free ones, not Amel\'s team');
  const sA = await seen(amel);
  assert.ok(sA.includes(y) && sA.includes(z) && !sA.includes(x), 'Amel: her team and the free ones');
  for (const c of [owner, admin]) {
    const all = await seen(c);
    assert.ok(all.includes(x) && all.includes(y) && all.includes(z), 'the owner sees every order');
  }
  // the menu counts follow the same rule
  const cnt: any = await call('confirmation.counts', samira, {});
  assert.equal(cnt.nouvelles, sS.length);
  // Rania cannot change Samira's order, nor open it as hers
  await assert.rejects(call('orders.setConf', rania, { ids: [x], status: 'no_answer' }), /autre agent/);
  assert.equal(((await call('confirmation.hold', rania, { id: x })) as any).ok, false);
  // « Commande suivante » still gives Rania a free order (it becomes hers), never Samira's
  const n: any = await call('orders.next', rania, { skip: [] });
  assert.ok(n.id);
  assert.notEqual(n.id, x);
  await call('confirmation.release', rania, { id: n.id });
});
