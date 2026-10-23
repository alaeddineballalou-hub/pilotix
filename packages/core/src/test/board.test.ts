// Team boards: each member next to the team and the period before, who sees which team, and an agent's own day.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, getSetting } from '../index';
import { prevOf } from '../modules/board';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
const range = () => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });
const sum = (xs: any[], k: string) => xs.reduce((s, x) => s + (x.v[k] ?? 0), 0);

before(async () => {
  ({ db, as } = await setup(400));
});

test('prevOf: the period before is as long, and a running period is compared up to the same moment', () => {
  const now = Date.parse('2026-10-23T15:00:00Z');
  const p = prevOf({ from: '2026-10-22T23:00:00.000Z', to: '2026-10-23T23:00:00.000Z' }, now);
  assert.equal(p.from, '2026-10-21T23:00:00.000Z');
  assert.equal(p.to, '2026-10-22T15:00:00.000Z');
  const w = prevOf({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' }, now);
  assert.equal(w.from, '2026-09-24T00:00:00.000Z');
  assert.equal(w.to, '2026-10-01T00:00:00.000Z');
});

test('confirmation board (admin): every team, the team adds up its members, days and reasons add up', async () => {
  const admin = await as(EMAILS.admin);
  const b: any = await call('stats.board', admin, { ...range(), area: 'confirmation' });
  const teams = await getSetting(db, 'teams');
  assert.ok(b.teams.length >= teams.length);
  assert.ok(b.members.length >= 4);
  for (const k of ['treated', 'confirmed', 'cancelled', 'invalid', 'calls', 'delivered', 'returned']) assert.equal(b.team[k], sum(b.members, k), k);
  assert.ok(b.team.confirmed > 0 && b.team.cancelled > 0);
  assert.equal(b.team.confRate, b.team.confirmed / (b.team.confirmed + b.team.cancelled));
  assert.equal(b.team.confRate_n, b.team.confirmed + b.team.cancelled);
  assert.equal(b.team.deliveryRate, b.team.delivered / (b.team.delivered + b.team.returned));
  // each member: a rate is out of what it says, and never above 1
  for (const m of b.members) {
    assert.ok(m.v.confirmed + m.v.cancelled + m.v.invalid <= m.v.treated);
    for (const k of ['confRate', 'deliveryRate', 'firstRate', 'triesRate', 'upsellRate']) assert.ok(m.v[k] === null || (m.v[k] >= 0 && m.v[k] <= 1), `${m.name} ${k}`);
  }
  // the bars of the days are the confirmations, their rate the decided ones
  assert.equal(b.days.reduce((s: number, d: any) => s + d.n, 0), b.team.confirmed);
  assert.equal(b.days.reduce((s: number, d: any) => s + d.of, 0), b.team.confirmed + b.team.cancelled);
  // why orders were lost: every cancellation once (reasons, the others, none given)
  assert.equal(b.reasons.reduce((s: number, r: any) => s + r.n, 0), b.team.cancelled);
  // the teams compared: their members add up to the whole
  assert.ok(b.groups.length >= 2);
  assert.equal(b.groups.reduce((s: number, g: any) => s + g.v.confirmed, 0), b.team.confirmed);
  // the delivered of the orders they confirmed, as in the orders table
  const ids = b.members.map((m: any) => m.id);
  const dl = (await db.query(`SELECT count(*)::int AS n FROM sales WHERE agent_id = ANY($1) AND follow_status IN ('delivered','exchanged') AND delivered_at >= $2 AND delivered_at < $3`, [ids, range().from, range().to]))[0].n;
  assert.equal(b.team.delivered, Number(dl));
  // what is late now
  assert.deepEqual(b.now.map((x: any) => x.key), ['firstLate', 'lateCallbacks', 'unassigned', 'inProgress']);
  // the period before is there, with the same numbers
  assert.ok('confRate' in b.prev && b.prevRange.to <= b.range.from);
});

test('confirmation board: a manager sees only his team; one team chosen limits the members', async () => {
  const admin = await as(EMAILS.admin);
  const all: any = await call('stats.board', admin, { ...range(), area: 'confirmation' });
  const team = all.teams.find((t: any) => t.managerName && /Yacine/.test(t.managerName));
  assert.ok(team);
  const one: any = await call('stats.board', admin, { ...range(), area: 'confirmation', teamId: team.id });
  assert.equal(one.members.length, team.size);
  assert.equal(one.groups.length, 0);
  const mgr = await as(EMAILS.manager);
  const mine: any = await call('stats.board', mgr, { ...range(), area: 'confirmation' });
  assert.deepEqual(mine.members.map((m: any) => m.id).sort(), one.members.map((m: any) => m.id).sort());
  assert.equal(mine.team.confirmed, one.team.confirmed);
  assert.equal(mine.teams.length, 1);
  // not his area, not a manager
  await assert.rejects(call('stats.board', mgr, { ...range(), area: 'suivi' }), /pas ouvert/);
  await assert.rejects(call('stats.board', await as(EMAILS.conf), { ...range(), area: 'confirmation' }), /Accès refusé/);
});

test('suivi, dépôt, livreurs and SAV boards add up like the orders and tickets tables', async () => {
  const admin = await as(EMAILS.admin);
  const r = range();
  const q1 = async (sql: string, p: unknown[] = [r.from, r.to]) => Number((await db.query(sql, p))[0].n);

  const s: any = await call('stats.board', admin, { ...r, area: 'suivi' });
  assert.equal(s.team.delivered, await q1(`SELECT count(*)::int AS n FROM sales WHERE follow_status IN ('delivered','exchanged') AND delivered_at >= $1 AND delivered_at < $2`));
  assert.equal(s.team.delivered, sum(s.members, 'delivered'));
  assert.ok(s.members.some((m: any) => m.name === 'Nadia'));
  assert.equal(s.team.treated, await q1(`SELECT count(DISTINCT (order_id, user_id))::int AS n FROM order_events WHERE kind = 'sub_status' AND to_value = 'alert_traitee' AND at >= $1 AND at < $2 AND user_id IS NOT NULL`));
  assert.deepEqual(s.now.map((x: any) => x.key), ['alertsOld', 'alerts', 'claimsLate', 'orphan']);

  const d: any = await call('stats.board', admin, { ...r, area: 'depot' });
  assert.equal(d.team.packed, await q1(`SELECT count(DISTINCT order_id)::int AS n FROM order_events e JOIN sales o ON o.id = e.order_id WHERE e.kind = 'follow_status' AND e.to_value = 'prepared' AND e.at >= $1 AND e.at < $2 AND e.user_id IS NOT NULL`));
  assert.ok(d.team.prepMs !== null && d.team.prepMs >= 0);
  assert.ok(d.members.some((m: any) => m.name === 'Karim' && m.v.packed > 0));

  const l: any = await call('stats.board', admin, { ...r, area: 'livreurs' });
  assert.equal(l.team.delivered, await q1(`SELECT count(*)::int AS n FROM sales WHERE livreur_id IS NOT NULL AND follow_status IN ('delivered','exchanged') AND delivered_at >= $1 AND delivered_at < $2`));
  assert.equal(l.team.uncashed, await q1(`SELECT COALESCE(sum(total), 0)::bigint AS n FROM sales WHERE livreur_id IS NOT NULL AND follow_status = 'delivered' AND NOT cashed`, []));

  const v: any = await call('stats.board', admin, { ...r, area: 'sav' });
  assert.equal(v.team.settled, await q1(`SELECT count(*)::int AS n FROM complaints WHERE status = 'resolved' AND resolved_at >= $1 AND resolved_at < $2`));
  assert.equal(v.team.todo, await q1(`SELECT count(*)::int AS n FROM complaints WHERE status IN ('open','progress')`, []));
});

test('stats.me: an agent sees their own day next to their own team, with their rank', async () => {
  const r = range();
  const samira = await as(EMAILS.conf);
  const me: any[] = (await call('stats.me', samira, r)) as any[];
  const c = me.find((x) => x.area === 'confirmation');
  assert.ok(c && c.me);
  const mgr: any = await call('stats.board', await as(EMAILS.manager), { ...r, area: 'confirmation' });
  const row = mgr.members.find((m: any) => m.id === samira.session.profile.id);
  assert.ok(row, 'Samira is in Yacine’s team');
  assert.equal(c.me.v.treated, row.v.treated);
  assert.equal(c.team.confirmed, mgr.team.confirmed);
  assert.equal(c.size, mgr.members.length);
  assert.ok(c.rank >= 1 && c.rank <= c.size);
  // a count is compared with the average of those who worked; the day by day of the team comes along
  const worked = mgr.members.filter((m: any) => m.v.treated > 0);
  assert.equal(Math.round(c.avg.treated * 1000), Math.round((worked.reduce((s: number, m: any) => s + m.v.treated, 0) / worked.length) * 1000));
  assert.deepEqual(c.teamDays.map((d: any) => d.n), mgr.days.map((d: any) => d.n));
  // no names of the others
  assert.ok(!JSON.stringify(me).includes('Rania'));
  const nadia: any[] = (await call('stats.me', await as(EMAILS.suivi), r)) as any[];
  assert.ok(nadia.some((x) => x.area === 'suivi' && x.me));
  const karim: any[] = (await call('stats.me', await as(EMAILS.depot), r)) as any[];
  assert.ok(karim.some((x) => x.area === 'depot' && x.me && x.me.v.packed > 0));
  await assert.rejects(call('stats.me', await as(EMAILS.livreur), r), /refusé/);
});
