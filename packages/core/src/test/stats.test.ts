// Stats: Accueil counters, dashboard areas, teams and manager scope.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, getSetting } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
const range = () => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });

before(async () => {
  ({ db, as } = await setup(400));
});

test('stats.now: counts match the orders table; money only for admin', async () => {
  const admin = await as(EMAILS.admin);
  const r: any = await call('stats.now', admin, {});
  const n = (await db.query(`SELECT count(*)::int AS n FROM orders WHERE follow_status = 'to_prepare'`))[0].n;
  assert.equal(r.toPrepare, n);
  assert.ok(r.moneyDue !== null && r.moneyDue >= 0);
  const conf = await as(EMAILS.conf);
  const c: any = await call('stats.now', conf, {});
  assert.equal(c.moneyDue, null);
  assert.equal(c.toPrepare, n);
});

test('stats.overview + agents: period numbers are consistent', async () => {
  const ctx = await as(EMAILS.conf);
  const o: any = await call('stats.overview', ctx, range());
  assert.ok(o.received > 0);
  assert.ok(o.receivedTodo <= o.received);
  assert.ok(o.confRate === null || (o.confRate >= 0 && o.confRate <= 1));
  const agents: any[] = (await call('stats.agents', ctx, range())) as any[];
  assert.ok(agents.length > 0);
  for (const a of agents) assert.ok(a.confirmed <= a.treated);
  await assert.rejects(call('stats.overview', ctx, { from: range().to, to: range().from }), /invalide/);
});

test('livreur and marketer cannot read the home stats', async () => {
  await assert.rejects(call('stats.overview', await as(EMAILS.livreur), range()), /refusé/);
  await assert.rejects(call('stats.now', await as(EMAILS.marketer), {}), /refusé/);
});

test('stats.livreurs / presence: admin sees livreurs, presence lists agents', async () => {
  const admin = await as(EMAILS.admin);
  const l: any = await call('stats.livreurs', admin, range());
  assert.ok(Array.isArray(l.rows));
  assert.ok(l.all.length >= 2);
  const p: any = await call('stats.presence', admin, {});
  assert.ok(p.agents.length > 0);
  assert.equal(p.online + p.idle + p.offline, p.agents.length);
});

test('dashboard: admin sees every area; a manager only his scope (Confirmation by default)', async () => {
  const admin = await as(EMAILS.admin);
  for (const n of ['stats.dashDepot', 'stats.dashSuivi', 'stats.dashSav'] as const) await call(n, admin, range());
  await call('stats.dashLivreurs', admin, range());
  const t: any = await call('stats.teams', admin, { ...range(), dateType: 'created', rateType: 'taux' });
  assert.ok(t.teams.length >= 2);
  assert.ok(t.comparison.length === t.teams.length);
  const s: any = await call('stats.teams', admin, { ...range(), dateType: 'status', rateType: 'perf' });
  assert.ok(s.teams.length >= 1);

  const amel = await as(EMAILS.manager2);
  const meta: any = await call('stats.dashMeta', amel, {});
  assert.deepEqual(meta.areas, ['confirmation', 'sav']);
  await call('stats.dashSav', amel, range());
  await assert.rejects(call('stats.dashDepot', amel, range()), /pas ouvert/);
  const mine: any = await call('stats.teams', amel, range());
  assert.equal(mine.teams.length, 1);
  assert.equal(mine.teams[0].managerId, amel.session.profile.id);
});

test('saveScope: admin only; manager then sees the new area', async () => {
  const admin = await as(EMAILS.admin);
  const yacine = await as(EMAILS.manager);
  const id = String(yacine.session.profile.id);
  await assert.rejects(call('stats.saveScope', yacine, { scope: { [id]: ['depot'] } }), /refusé/);
  await assert.rejects(call('stats.saveScope', admin, { scope: { '999999': ['depot'] } }), /manager/);
  await call('stats.saveScope', admin, { scope: { [id]: ['confirmation', 'depot'] } });
  const meta: any = await call('stats.dashMeta', yacine, {});
  assert.deepEqual(meta.areas, ['confirmation', 'depot']);
  await call('stats.dashDepot', yacine, range());
});

test('saveTeams: vendeur moves an agent; a manager cannot', async () => {
  const vendeur = await as(EMAILS.vendeur);
  const samira = await as(EMAILS.conf);
  const amel = await as(EMAILS.manager2);
  await assert.rejects(call('stats.saveTeams', amel, { assignments: [{ agentId: samira.session.profile.id, managerId: amel.session.profile.id }] }), /refusé/);
  await assert.rejects(call('stats.saveTeams', vendeur, { assignments: [{ agentId: samira.session.profile.id, managerId: samira.session.profile.id }] }), /manager/);
  await call('stats.saveTeams', vendeur, { assignments: [{ agentId: samira.session.profile.id, managerId: amel.session.profile.id }] });
  const teams = await getSetting(db, 'teams');
  const t = teams.find((x) => x.managerId === amel.session.profile.id)!;
  assert.ok(t.agentIds.includes(samira.session.profile.id));
  assert.ok(!teams.some((x) => x.managerId !== amel.session.profile.id && x.agentIds.includes(samira.session.profile.id)));
});
