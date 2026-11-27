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
});
