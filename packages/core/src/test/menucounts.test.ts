// The menu's numbers count what the person's own pages show (owner's ask, 26 Nov 2026: « it should only show the number
// assigned to her, not 9 »): Suivi = the alerts of her Suivi page (Nouvelles alertes + En cours), SAV = the open tickets
// of her SAV page — an agent only hers, the owner and the administrators every one. Never the whole shop's number.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(240));
});

const counts = async (ctx: Ctx) => (await call('orders.counts', ctx, {})) as any;
/** the alerts the person's Suivi page lists: Nouvelles alertes + En cours */
async function pageAlerts(ctx: Ctx): Promise<number> {
  const total = async (tab: string) => Number(((await call('suivi.list', ctx, { tab, pageSize: 500 })) as any).total);
  return (await total('alertes_new')) + (await total('alertes_encours'));
}
const shopAlerts = async () => Number((await db.query(`SELECT count(*)::int AS n FROM orders WHERE follow_status = 'alert'`))[0].n);
/** a parcel of the shop's own team, on the road, made an alert given to `agentId` (null: nobody's yet) */
async function alertFor(agentId: number | null): Promise<number> {
  const o = (
    await db.query(
      `SELECT id FROM sales WHERE follow_status IN ('shipped','out_for_delivery','failed') AND shipped_at IS NOT NULL
          AND locked_by IS NULL AND follow_agency_id IS NULL AND conf_agency_id IS NULL ORDER BY id LIMIT 1`,
    )
  )[0];
  const id = Number(o.id);
  await db.query(`UPDATE orders SET follow_status = 'alert', sub_status = NULL, follow_agent_id = $2 WHERE id = $1`, [id, agentId]);
  return id;
}

test('Suivi: a suivi agent counts only the alerts given to her; the owner every alert', async () => {
  const nadia = await as(EMAILS.suivi);
  const admin = await as(EMAILS.admin);
  const was = { nadia: Number((await counts(nadia)).alerts), admin: Number((await counts(admin)).alerts) };
  await alertFor(nadia.session.profile.id);
  await alertFor(null);
  const now = { nadia: Number((await counts(nadia)).alerts), admin: Number((await counts(admin)).alerts) };
  assert.equal(now.nadia, was.nadia + 1, 'the alert given to her counts, the free one does not');
  assert.equal(now.admin, was.admin + 2, 'the owner counts both');
  assert.equal(now.admin, await shopAlerts());
  assert.ok(now.nadia < now.admin, 'never the whole shop’s number');
  // the number is what her page shows
  assert.equal(now.nadia, await pageAlerts(nadia));
});

test('Suivi: a confirmation agent, an agent manager and the seller count what their Suivi page shows', async () => {
  for (const email of [EMAILS.conf, EMAILS.manager, EMAILS.vendeur]) {
    const ctx = await as(email);
    assert.equal(Number((await counts(ctx)).alerts), await pageAlerts(ctx), email);
  }
  assert.equal(Number((await counts(await as(EMAILS.vendeur))).alerts), await shopAlerts(), 'the seller: every alert');
});

test('SAV: an agent counts only her open tickets; the owner every one', async () => {
  const admin = await as(EMAILS.admin);
  const samira = await as(EMAILS.conf);
  const me = samira.session.profile.id;
  // a delivered order that is not hers (not confirmed, followed or typed by her)
  const orderId = Number(
    (
      await db.query(
        `SELECT id FROM orders WHERE follow_status = 'delivered' AND agent_id IS DISTINCT FROM $1 AND follow_agent_id IS DISTINCT FROM $1
            AND created_by IS DISTINCT FROM $1 ORDER BY id LIMIT 1`,
        [me],
      )
    )[0].id,
  );
  // (her SAV page first: opening it settles the tickets whose exchange was delivered)
  await call('sav.list', samira, { view: 'todo' });
  const was = { samira: Number((await counts(samira)).sav), admin: Number((await counts(admin)).sav) };
  await call('sav.create', admin, { orderId, type: 'defect', details: 'Roue cassée' });
  const now = { samira: Number((await counts(samira)).sav), admin: Number((await counts(admin)).sav) };
  assert.equal(now.admin, was.admin + 1, 'the owner counts it');
  assert.equal(now.samira, was.samira, 'not hers: not in her number');
  assert.equal(now.admin, Number((await db.query(`SELECT count(*)::int AS n FROM complaints WHERE status IN ('open','progress')`))[0].n));
  // her number is her SAV page's « À traiter »
  const page = Number(((await call('sav.list', samira, { view: 'todo' })) as any).counts.todo);
  assert.equal(Number((await counts(samira)).sav), page);
});
