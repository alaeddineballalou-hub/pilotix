// Confirmation statistics, the owner's rules (27 Nov 2026):
// - « Date de changement de statut » is the day the CONFIRMATION status changed, never the order's last change (an
//   order delivered today was counted as confirmed today);
// - Nouvelles › Statistiques: today only, live, no filters — volume, speed, result, right now, each agent; the store's
//   owner also gets each team side by side and the load per agent.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const at = async (email: string, now: number): Promise<Ctx> => ({ ...(await as(email)), now: () => now });

test('« changement de statut »: an order the courier touched today is not confirmed today', async () => {
  const now = Date.now();
  const ctx = await at(EMAILS.vendeur, now);
  const KF = { per: 'today', basis: 'updated' } as const;
  // an order confirmed long ago, with nothing in its confirmation history today
  const [old] = await db.query(
    `SELECT o.id FROM orders o WHERE o.conf_status = 'confirmed' AND NOT o.is_exchange
        AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'conf_status' AND e.at >= now() - interval '2 days')
      ORDER BY o.id LIMIT 1`,
  );
  assert.ok(old, 'the demo has an old confirmed order');
  const before0: any = await call('confirmation.period', ctx, KF);
  const ov0: any = await call('confirmation.overview', ctx, KF);
  // the depot and the courier move it today: its last change is today, its confirmation is not
  await db.query(`UPDATE orders SET follow_status = 'delivered', updated_at = now() WHERE id = $1`, [old.id]);
  const after0: any = await call('confirmation.period', ctx, KF);
  const ov1: any = await call('confirmation.overview', ctx, KF);
  assert.equal(after0.received, before0.received, 'a delivery never moves an order into today');
  assert.equal(after0.confirmed, before0.confirmed);
  assert.equal(JSON.stringify(ov1.confirmed), JSON.stringify(ov0.confirmed), 'Confirmées counts it on its confirmation day');
});

test('Nouvelles › Statistiques: today only, the team adds up its agents, a manager gets no team table', async () => {
  const now = Date.now();
  await assert.rejects(call('confirmation.nouvelles', await at(EMAILS.conf, now), {}), /Accès refusé/);
  for (const who of ['vendeur', 'manager'] as const) {
    const s: any = await call('confirmation.nouvelles', await at(EMAILS[who], now), {});
    for (const k of ['today', 'prev'] as const) {
      const x = s[k];
      assert.ok(x.under5 <= x.called && x.onTime <= x.called, `${who} ${k}: parts of the calls`);
      assert.ok(x.converted <= x.reached && x.reached <= x.called, `${who} ${k}: confirmed ⊂ reached ⊂ called`);
    }
    assert.ok(s.live.late <= s.live.waiting && s.live.noAgent <= s.live.waiting);
    // each agent's line: never more calls than the team's (the team line adds every call)
    const sumCalled = s.agents.reduce((n: number, a: any) => n + a.called, 0);
    assert.ok(sumCalled <= s.today.called, `${who}: agents add up to the team at most`);
    for (const a of s.agents) assert.ok(a.converted <= a.reached && a.reached <= a.called);
    if (who === 'manager') {
      assert.equal(s.director, false);
      assert.equal(s.teams, null, 'a manager never sees the other teams');
    } else {
      assert.equal(s.director, true);
      assert.ok(Array.isArray(s.teams));
      for (const t of s.teams) if (t.kind === 'agency') assert.equal(t.agents, null, "an agency's agents stay private");
    }
  }
  const owner: any = await call('confirmation.nouvelles', await at(EMAILS.vendeur, now), {});
  const mgr: any = await call('confirmation.nouvelles', await at(EMAILS.manager, now), {});
  assert.ok(mgr.today.called <= owner.today.called, 'a manager counts his team only');
  // « Toutes les équipes » adds the lines up; a store team has no « Non assignées » of its own
  assert.equal(owner.allTeams.called, owner.teams.reduce((n: number, r: any) => n + r.called, 0));
  assert.equal(owner.allTeams.received, owner.teams.reduce((n: number, r: any) => n + r.received, 0));
  // with « Sans équipe », the lines add up to the cards
  assert.equal(owner.allTeams.received, owner.today.received, 'Nouvelles: the teams add up to the new orders');
  assert.equal(owner.allTeams.called, owner.today.called, 'Nouvelles: the teams add up to the first calls');
  assert.equal(owner.allTeams.late, owner.live.late);
  assert.equal(owner.allTeams.unassigned, owner.live.noAgent);
  for (const r of owner.teams) if (r.kind === 'team') assert.equal(r.unassigned, null);
  // a team opened by the owner: its manager view (no team table), never more than all the teams
  const first = owner.teams.find((r: any) => r.kind === 'team');
  if (first) {
    const one: any = await call('confirmation.nouvelles', await at(EMAILS.vendeur, now), { team: first.key });
    assert.equal(one.director, false);
    assert.equal(one.teams, null);
    assert.equal(one.team.key, first.key);
    assert.ok(one.today.called <= owner.today.called);
  }
  // a manager cannot open another team
  const other: any = await call('confirmation.nouvelles', await at(EMAILS.manager, now), { team: 't999' });
  assert.equal(other.team, null);
});

test('En cours › Statistiques: today only, the closed orders add up, a manager gets no team table', async () => {
  const now = Date.now();
  await assert.rejects(call('confirmation.enCours', await at(EMAILS.conf, now), {}), /Accès refusé/);
  for (const who of ['vendeur', 'manager'] as const) {
    const s: any = await call('confirmation.enCours', await at(EMAILS[who], now), {});
    for (const k of ['today', 'prev'] as const) {
      const x = s[k];
      assert.ok(x.onTime <= x.calls, `${who} ${k}: on time ⊂ calls`);
      // each order reached took one call at least (its first call) and one more (it was in En cours)
      assert.ok(x.tries >= 2 * (x.confirmed + x.saidNo), `${who} ${k}: 2 calls at least to reach in En cours`);
    }
    assert.ok(s.live.late <= s.live.inProgress && s.live.dueHour + s.live.late <= s.live.inProgress);
    const t = s.agentsTotal;
    assert.equal(t.calls, s.agents.reduce((n: number, a: any) => n + a.calls, 0), `${who}: the team line adds up its agents`);
    assert.equal(t.confirmed + t.saidNo + t.never, s.agents.reduce((n: number, a: any) => n + a.confirmed + a.saidNo + a.never, 0));
    assert.ok(t.calls <= s.today.calls);
    if (who === 'manager') {
      assert.equal(s.director, false);
      assert.equal(s.teams, null, 'a manager never sees the other teams');
    } else {
      assert.equal(s.director, true);
      for (const r of s.teams) if (r.kind === 'agency') assert.equal(r.agents, null, "an agency's agents stay private");
      assert.equal(s.allTeams.calls, s.teams.reduce((n: number, r: any) => n + r.calls, 0));
      assert.equal(s.allTeams.inProgress, s.teams.reduce((n: number, r: any) => n + r.inProgress, 0));
      // with « Sans équipe », the lines add up to the cards
      assert.equal(s.allTeams.inProgress, s.live.inProgress, 'En cours: the teams add up to the orders in progress');
      assert.equal(s.allTeams.calls, s.today.calls, 'En cours: the teams add up to the calls');
      assert.equal(s.allTeams.late, s.live.late);
      const first = s.teams.find((r: any) => r.kind === 'team');
      if (first) {
        const one: any = await call('confirmation.enCours', await at(EMAILS.vendeur, now), { team: first.key });
        assert.equal(one.director, false);
        assert.equal(one.team.key, first.key);
        assert.ok(one.live.inProgress <= s.live.inProgress);
      }
    }
  }
});

test('Confirmées › Statistiques: taux (pending counted), the table adds up to the cards, one agent → per product', async () => {
  const now = Date.now();
  const KF30 = { per: '30', basis: 'updated' } as const;
  await assert.rejects(call('confirmation.confirmees', await at(EMAILS.conf, now), KF30), /Accès refusé/);
  for (const who of ['vendeur', 'manager'] as const) {
    const ctx = await at(EMAILS[who], now);
    const s: any = await call('confirmation.confirmees', ctx, KF30);
    const x = s.sum;
    assert.ok(x.qualified <= x.leads && x.confirmed <= x.qualified && x.upsell <= x.confirmed, `${who}: confirmed ⊂ qualified ⊂ leads`);
    assert.ok(x.delivered <= x.shipped && x.shipped <= x.confirmed, `${who}: delivered ⊂ shipped ⊂ confirmed`);
    // per agent (per team for the owner): every lead in one line, so the lines add up to the cards
    for (const k of ['leads', 'qualified', 'confirmed', 'delivered'] as const)
      assert.equal(s.table.reduce((n: number, r: any) => n + r[k], 0), x[k], `${who}: the lines add up (${k})`);
    assert.equal(s.director, who === 'vendeur');
    const real = s.reasons.reduce((n: number, r: any) => n + r.n, 0);
    assert.ok(real <= x.qualified - x.confirmed, `${who}: the reasons are real clients' only`);
    const one = s.agents[0];
    if (one) {
      const a: any = await call('confirmation.confirmees', ctx, { ...KF30, agent: one.id });
      assert.equal(a.by, 'product', 'one agent: the table per product');
      assert.ok(a.sum.leads <= x.leads);
    }
    const p: any = await call('confirmation.confirmees', ctx, { ...KF30, by: 'product' });
    assert.equal(p.by, 'product');
    for (const r of p.table) assert.ok(r.leads <= x.leads);
  }
  const mgr: any = await call('confirmation.confirmees', await at(EMAILS.manager, now), KF30);
  const owner: any = await call('confirmation.confirmees', await at(EMAILS.vendeur, now), KF30);
  assert.ok(mgr.sum.leads <= owner.sum.leads, 'a manager counts his team only');
  assert.equal(mgr.teams, null);
  const team = owner.teams.find((t: any) => t.kind === 'team');
  if (team) {
    const tv: any = await call('confirmation.confirmees', await at(EMAILS.vendeur, now), { ...KF30, team: team.key });
    assert.equal(tv.director, false);
    assert.equal(tv.team.key, team.key);
    assert.ok(tv.sum.leads <= owner.sum.leads);
  }
});
