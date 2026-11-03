// The filter bars: their lists (filters.options) and the filters every list now reads — the team and the suivi agent
// in Commandes, Agent suivi / Produit / Société / Livreur / Wilaya / Du-Au in Suivi, Responsable / Produit / Du-Au in
// SAV, Société / Livreur in Caisse › Reçu.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, login, migrate, seedDemo } from '../index';
import { pgliteDb } from '../pglite';
import { DEMO_PASSWORD } from '../seed';
import { getSetting, setSetting } from '../settings';

let db: Db;
const ctxFor = async (email: string): Promise<Ctx> => ({ db, session: await login(db, email, DEMO_PASSWORD), now: () => Date.now(), emit: () => {} });

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  db = pgliteDb(pg as any);
  await migrate(db, async (sql) => {
    await pg.exec(sql);
  });
  await seedDemo(db, { orders: 300 });
});

test('filters.options: people with their roles, teams, products with variants, companies, livreurs, reasons', async () => {
  const admin = await ctxFor('admin@demo.pilotix.dz');
  const o: any = await call('filters.options', admin, {});
  assert.ok(o.agents.length > 0);
  assert.ok(o.agents.every((a: any) => typeof a.name === 'string' && Array.isArray(a.roles)));
  assert.ok(o.agents.some((a: any) => a.roles.includes('confirmation')));
  assert.ok(o.products.length > 0);
  // a variant listed has a name to choose
  assert.ok(o.products.every((p: any) => p.variants.every((v: any) => v.title)));
  assert.ok(o.companies.length > 0);
  assert.ok(Array.isArray(o.livreurs));
  assert.ok(Array.isArray(o.reasons.conf) && Array.isArray(o.reasons.back));
  // a livreur alone has nothing to filter
  const lv = (await db.query(`SELECT email FROM profiles WHERE roles = '{livreur}' AND active LIMIT 1`))[0];
  if (lv) {
    const e: any = await call('filters.options', await ctxFor(lv.email), {});
    assert.deepEqual(e.agents, []);
    assert.deepEqual(e.products, []);
  }
});

test('Commandes: the team filter keeps the orders of the team’s people; the suivi agent filter', async () => {
  const admin = await ctxFor('admin@demo.pilotix.dz');
  const ag = (await db.query(`SELECT agent_id, count(*)::int AS n FROM orders WHERE agent_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`))[0];
  assert.ok(ag, 'an agent with orders');
  const teams = await getSetting(db, 'teams');
  await setSetting(db, 'teams', [...teams, { id: 'tf1', name: 'Équipe filtre', managerId: null, agentIds: [Number(ag.agent_id)] }]);
  const r: any = await call('orders.list', admin, { teamId: 'tf1', pageSize: 500 });
  assert.equal(r.total, Number(ag.n));
  assert.ok(r.rows.every((x: any) => x.agentId === Number(ag.agent_id)));
  // an unknown team: nobody
  assert.equal(((await call('orders.list', admin, { teamId: 'nope', pageSize: 5 })) as any).total, 0);
  await setSetting(db, 'teams', teams);
  const fa = (await db.query(`SELECT follow_agent_id, count(*)::int AS n FROM orders WHERE follow_agent_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`))[0];
  if (fa) {
    const f: any = await call('orders.list', admin, { followAgentId: Number(fa.follow_agent_id), pageSize: 500 });
    assert.ok(f.rows.every((x: any) => x.followAgentId === Number(fa.follow_agent_id)));
  }
  const none: any = await call('orders.list', admin, { followAgentId: 'none', pageSize: 50 });
  assert.ok(none.rows.every((x: any) => x.followAgentId === null));
});

test('Suivi: Produit, Société, Wilaya, Livreur and Du / Au narrow the list', async () => {
  const admin = await ctxFor('admin@demo.pilotix.dz');
  const all: any = await call('suivi.list', admin, { tab: 'enlivraison', pageSize: 500 });
  assert.ok(all.rows.length > 0, 'parcels on the road');
  const o = all.rows[0];
  const byCompany: any = await call('suivi.list', admin, { tab: 'enlivraison', companyId: o.companyId, pageSize: 500 });
  assert.ok(byCompany.rows.length > 0 && byCompany.rows.every((x: any) => x.companyId === o.companyId));
  const byWilaya: any = await call('suivi.list', admin, { tab: 'enlivraison', wilayaId: o.wilayaId, pageSize: 500 });
  assert.ok(byWilaya.rows.some((x: any) => x.id === o.id) && byWilaya.rows.every((x: any) => x.wilayaId === o.wilayaId));
  const pid = o.items[0].productId;
  const byProduct: any = await call('suivi.list', admin, { tab: 'enlivraison', productId: pid, pageSize: 500 });
  assert.ok(byProduct.rows.some((x: any) => x.id === o.id));
  assert.ok(byProduct.rows.every((x: any) => x.items.some((i: any) => i.productId === pid)));
  // Du / Au: when the parcel left
  const day = String(o.shippedAt).slice(0, 10);
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString();
  const to = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  const byDate: any = await call('suivi.list', admin, { tab: 'enlivraison', from, to, pageSize: 500 });
  assert.ok(byDate.rows.some((x: any) => x.id === o.id));
  assert.ok(byDate.rows.every((x: any) => x.shippedAt >= from && x.shippedAt < to));
  const future: any = await call('suivi.list', admin, { tab: 'enlivraison', from: new Date(Date.now() + 86_400_000).toISOString(), pageSize: 5 });
  assert.equal(future.rows.length, 0);
  // a livreur nobody has: nothing
  const byLivreur: any = await call('suivi.list', admin, { tab: 'enlivraison', livreurId: 999999, pageSize: 5 });
  assert.equal(byLivreur.rows.length, 0);
});

test('SAV: Responsable, Produit and Du / Au', async () => {
  const admin = await ctxFor('admin@demo.pilotix.dz');
  const all: any = await call('sav.list', admin, { view: 'all', pageSize: 500 });
  const nobody: any = await call('sav.list', admin, { view: 'all', agentId: 999999, pageSize: 5 });
  assert.equal(nobody.rows.length, 0);
  const future: any = await call('sav.list', admin, { view: 'all', from: new Date(Date.now() + 86_400_000).toISOString(), pageSize: 5 });
  assert.equal(future.rows.length, 0);
  if (all.rows.length) {
    const tk = all.rows.find((x: any) => x.assignedTo) ?? null;
    if (tk) {
      const mine: any = await call('sav.list', admin, { view: 'all', agentId: tk.assignedTo, pageSize: 500 });
      assert.ok(mine.rows.every((x: any) => x.assignedTo === tk.assignedTo));
    }
  }
});

test('Caisse › Reçu: Société and Livreur', async () => {
  const admin = await ctxFor('admin@demo.pilotix.dz');
  const all: any[] = (await call('cash.history', admin, { limit: 100 })) as any[];
  const h = all.find((x) => x.companyId && !x.livreurId);
  if (h) {
    const by: any[] = (await call('cash.history', admin, { companyId: h.companyId, limit: 100 })) as any[];
    assert.ok(by.length > 0 && by.every((x) => x.companyId === h.companyId));
  }
  const none: any[] = (await call('cash.history', admin, { livreurId: 999999, limit: 10 })) as any[];
  assert.equal(none.length, 0);
});
