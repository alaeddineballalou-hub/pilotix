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
  // their manager gives Samira and Rania their orders (an agent never takes one nobody gave him)
  const s = (await as(EMAILS.conf)).session.profile.id;
  const r = (await as(EMAILS.conf2)).session.profile.id;
  const free = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL ORDER BY id`)).map((x: any) => Number(x.id));
  free.splice(Math.min(6, Math.max(0, free.length - 4)));
  for (const [k, id] of free.entries()) await db.query('UPDATE orders SET agent_id = $2, assigned_at = now() WHERE id = $1', [id, k % 2 ? r : s]);
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

test('an order « Commande suivante » gave is kept for its agent; another agent cannot open or change it; a manager sees who has it', async () => {
  const samira = await as(EMAILS.conf);
  const rania = await as(EMAILS.conf2);
  const yacine = await as(EMAILS.manager);
  const id = Number(((await call('orders.next', samira, {})) as any).id);
  const s: any = await call('confirmation.hold', samira, { id });
  assert.equal(s.ok, true);
  // not Rania's: she does not open it, nor keep it
  await assert.rejects(call('confirmation.hold', rania, { id }), /autre agent/);
  await assert.rejects(call('orders.get', rania, { id }), /autre agent/);
  // the manager sees who has it
  const o: any = await call('orders.get', yacine, { id });
  assert.equal(o.lockedBy?.id, samira.session.profile.id);
  // Rania's click is refused, the order does not move
  const before = (await db.query('SELECT conf_status FROM orders WHERE id = $1', [id]))[0].conf_status;
  await assert.rejects(call('orders.setConf', rania, { ids: [id], status: 'cancelled', reason: 'Prix' }), /autre agent/);
  assert.equal((await db.query('SELECT conf_status FROM orders WHERE id = $1', [id]))[0].conf_status, before);
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
  await assert.rejects(call('confirmation.hold', rania, { id }), /autre agent/);
  assert.equal(Number((await db.query('SELECT agent_id FROM orders WHERE id = $1', [id]))[0].agent_id), samira.session.profile.id);
});

test('opening the next order gives the first one back; another agent never acts on it; an admin can', async () => {
  const samira = await as(EMAILS.conf);
  const admin = await as(EMAILS.admin);
  const a = Number(((await call('orders.next', samira, {})) as any).id);
  await call('confirmation.hold', samira, { id: a });
  const b = Number(((await call('orders.next', samira, { skip: [a] })) as any).id);
  await call('confirmation.hold', samira, { id: b });
  const la = (await db.query('SELECT locked_by FROM orders WHERE id = $1', [a]))[0];
  assert.equal(la.locked_by, null, 'the first order is free again');
  // another agent never acts on it
  const rania = await as(EMAILS.conf2);
  await assert.rejects(call('orders.setConf', rania, { ids: [b], status: 'no_answer' }), /autre agent/);
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
  await assert.rejects(call('confirmation.hold', rania, { id: x }), /autre agent/);
  // « Commande suivante » gives Rania one of her own orders, never Samira's nor one nobody gave her
  const n: any = await call('orders.next', rania, { skip: [] });
  assert.ok(n.id);
  assert.notEqual(n.id, x);
  assert.equal(Number((await db.query('SELECT agent_id FROM orders WHERE id = $1', [n.id]))[0].agent_id), R);
  await call('confirmation.release', rania, { id: n.id });
  // an order nobody has: Samira does not open it, take it nor change it; once her manager gives it, it is hers
  assert.equal(await call('confirmation.hold', samira, { id: z }).then((r: any) => r.ok === false, () => true), true, 'not opened');
  await assert.rejects(call('orders.assignAgent', samira, { ids: [z], agentId: S }), /autre agent|manager/);
  await assert.rejects(call('orders.setConf', samira, { ids: [z], status: 'busy' }), /autre agent|manager/);
  
  await call('orders.assignAgent', yacine, { ids: [z], agentId: S });
  assert.equal(((await call('confirmation.hold', samira, { id: z })) as any).ok, true);
  await call('confirmation.release', samira, { id: z });
});

test('« pas de réponse »: « Commande suivante » gives it again in the next call slot, never in the same one', async () => {
  const samira = await as(EMAILS.conf);
  const id = Number(await freeNew());
  // given to her (she works on her own orders)
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [id, samira.session.profile.id]);
  await call('orders.setConf', samira, { ids: [id], status: 'no_answer' });
  await call('confirmation.release', samira, { id });
  // the oldest order of the queue (it would come first), and the callbacks due now set aside
  await db.query(`UPDATE orders SET created_at = '2020-01-01T08:00:00Z' WHERE id = $1`, [id]);
  const callbacks = (await db.query(`SELECT id FROM orders WHERE next_call_at IS NOT NULL AND next_call_at <= now() LIMIT 200`)).map((r: any) => Number(r.id));
  const next = async () => {
    const n: any = await call('orders.next', samira, { skip: callbacks });
    if (n.id) await call('confirmation.release', samira, { id: n.id });
    return n.id;
  };
  // just called (this slot): not given again now
  assert.notEqual(await next(), id);
  // called before this slot started: its next try is now
  const { slotStartOf } = await import('@pilotix/shared');
  const { getSetting } = await import('../settings');
  const start = slotStartOf(Date.now(), await getSetting(db, 'calls'));
  await db.query('UPDATE orders SET last_call_at = $2 WHERE id = $1', [id, new Date(start - 60_000).toISOString()]);
  assert.equal(await next(), id);
});
