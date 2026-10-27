// The in-browser demo's partners: a confirmation agency and a marketer made for the demo store the first time their
// pages open — their contracts, team accounts in the store, orders, ad sets and bills — so every page has something.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_PARTNER_ACCOUNTS, DEMO_PASSWORD } from '@pilotix/shared';
import { call, Ctx, loadShop, loadShops, login, migrate, pgliteTenancy, platformSettings, seedDemo, seedDemoPartners, shopCtx, shopStatus, Tenancy } from '../index';

async function as(t: Tenancy, schema: string, email: string, extra: Partial<Ctx> = {}): Promise<Ctx> {
  const s = (await loadShops(t)).find((x) => x.schema === schema)!;
  const db = t.shop(schema);
  const st = shopStatus(s, Date.now(), (await platformSettings(t)).trial.graceDays);
  return { db, session: await login(db, email, DEMO_PASSWORD), now: () => Date.now(), emit: () => {}, t, shop: shopCtx(s, st), ...extra };
}

test('the demo store gets its agency and its marketer, each with work to show', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedDemo(t.shop('public'), { orders: 400 });
  const ids = await seedDemoPartners(t);
  // again: nothing new (the page opened twice)
  assert.deepEqual(await seedDemoPartners(t), ids);

  const shops = await loadShops(t);
  const [AG, MK] = DEMO_PARTNER_ACCOUNTS;
  const agency = shops.find((s) => s.id === ids.agencyId)!;
  const marketer = shops.find((s) => s.id === ids.marketerId)!;
  assert.deepEqual([agency.kind, agency.name, marketer.kind, marketer.name], ['agency', AG.shop, 'marketer', MK.shop]);
  assert.equal((await loadShop(t, { primary: true }))!.schema, 'public');

  // the store: both contracts, this month's numbers, last month's bills
  const owner = await as(t, 'public', 'admin@demo.pilotix.dz');
  const home: any = await call('partners.home', owner, {});
  assert.deepEqual(home.links.map((l: any) => [l.kind, l.status]).sort(), [['agency', 'active'], ['marketer', 'active']]);
  for (const l of home.links) assert.ok(l.agents.length >= 2, `${l.agency.name}: its people work here`);
  const agLink = home.links.find((l: any) => l.kind === 'agency');
  const mkLink = home.links.find((l: any) => l.kind === 'marketer');
  assert.ok(home.counts[String(agLink.id)].received > 0, 'the agency has orders this month');
  assert.ok(home.counts[String(mkLink.id)].adsets > 0, 'the marketer has ad sets this month');
  const agBills: any = await call('partners.link', owner, { id: agLink.id });
  assert.deepEqual(agBills.bills.map((b: any) => b.status), ['paid']);
  const mkBills: any = await call('partners.link', owner, { id: mkLink.id });
  assert.deepEqual(mkBills.bills.map((b: any) => b.status), ['requested']);
  // the store's Marketer page names the marketer's people
  const mk: any = await call('mk.overview', owner, {});
  assert.ok(mk.marketers.some((m: any) => m.partner?.name === MK.shop));

  // the agency's chief: its seller, its orders to call
  const chiefA = await as(t, agency.schema, AG.email);
  assert.deepEqual(((await call('agency.sellers', chiefA, {})) as any[]).map((s) => s.name), ['Pilotix Démo']);
  const conf: any = await call('confirmation.list', { ...chiefA, seller: 'all' }, { sub: 'nouvelles' });
  assert.ok(conf.rows.length > 0, 'new orders to call');
  // the marketer's chief: his team's ad sets, one judged « réussi », and his bill
  const chiefM = await as(t, marketer.schema, MK.email);
  const rows: any = await call('mk.overview', { ...chiefM, seller: 'all' }, {});
  assert.equal(rows.rows.length, 3);
  assert.equal(rows.rows.filter((r: any) => r.final && r.ok).length, 1);
  const billing: any = await call('agency.billing', chiefM, {});
  assert.ok(billing.rows[0].bill.total > 0);
});
