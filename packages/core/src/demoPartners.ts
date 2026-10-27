// The in-browser demo's partners: a confirmation agency (« Rapide Call Center ») and a marketer (« Nassim Ads »)
// working for the demo store, with their teams, prices, contracts, orders, ad sets and bills — so the store's
// « Agences » and « Marketers » pages and the two partners' own spaces can be tried with fake data. Built the first
// time one of them is opened: it adds the platform's tables (shop #1 = the demo store) and two small shops.
import { DEMO_PARTNER_ACCOUNTS } from '@pilotix/shared';
import { num } from './db';
import type { Ctx } from './rpc';
import { dispatch, makeSession, Procedure } from './rpc';
import { REGISTRY } from './registry';
import { agencyGate } from './modules/agencyscope';
import { profileById } from './modules/users';
import { loadShop, migrateAll, platformSettings, provisionShop, Shop, shopCtx, shopStatus } from './platform/shops';
import type { Tenancy } from './platform/tenancy';

const DAY = 86_400_000;
const run = (ctx: Ctx, name: string, input: unknown) => dispatch(REGISTRY as unknown as Record<string, Procedure>, name, ctx, input, agencyGate) as Promise<any>;

/** A person of a shop, as the server would make their request (their shop's rules, the whole platform). */
async function as(t: Tenancy, shop: Shop, email: string, now: number): Promise<Ctx> {
  const db = t.shop(shop.schema);
  const id = (await db.query('SELECT id FROM profiles WHERE lower(email) = $1', [email.toLowerCase()]))[0]?.id;
  const p = id === undefined ? null : await profileById(db, num(id));
  if (!p) throw new Error(`demo: no ${email} in ${shop.name}`);
  const st = shopStatus(shop, now, (await platformSettings(t)).trial.graceDays);
  return { db, session: makeSession(p), now: () => now, emit: () => {}, t, shop: shopCtx(shop, st) };
}

const AGENCY_TEAM = [
  { name: 'Nora Hamdi', email: 'nora.agence@demo.pilotix.dz', roles: ['confirmation'] },
  { name: 'Yasmine Kaci', email: 'yasmine.agence@demo.pilotix.dz', roles: ['confirmation'] },
  { name: 'Ali Mansouri', email: 'ali.agence@demo.pilotix.dz', roles: ['suivi'] },
  { name: 'Riad Bouzid', email: 'riad.agence@demo.pilotix.dz', roles: ['agent_manager'] },
];
const MARKETER_TEAM = [
  { name: 'Nadir Ferhat', email: 'nadir.mk@demo.pilotix.dz', roles: ['marketer'] },
  { name: 'Selma Kaci', email: 'selma.mk@demo.pilotix.dz', roles: ['marketer'] },
];
const NO_BONUS = { bonusRate: { min: 0, amount: 0 }, bonusVolume: { above: 0, amount: 0 } };
const AGENCY_PRICES = { perConfirmed: 0, perDelivered: 180, perUpsell: 60, monthly: 0, bonusRate: { min: 70, amount: 20 }, bonusVolume: { above: 300, amount: 15 }, perSuccess: 0, profitRate: 0 };
const MARKETER_PRICES = { perConfirmed: 0, perDelivered: 150, perUpsell: 0, monthly: 0, ...NO_BONUS, perSuccess: 15000, profitRate: 10 };

const ym = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 7);

/** Builds the demo's partners once (returns the two partner shops' ids). Safe to call again: it finds them. */
export async function seedDemoPartners(t: Tenancy, opts: { now?: number } = {}): Promise<{ agencyId: number; marketerId: number }> {
  const now = opts.now ?? Date.now();
  await migrateAll(t);
  const store = (await loadShop(t, { primary: true }))!;
  const known = await t.platform.query(`SELECT id, kind FROM platform.shops WHERE kind IN ('agency', 'marketer') ORDER BY id`);
  if (known.length >= 2) return { agencyId: num(known.find((r: any) => r.kind === 'agency').id), marketerId: num(known.find((r: any) => r.kind === 'marketer').id) };

  const sdb = t.shop('public');
  // every demo person has the demo password (the store's own hash, made once)
  const hash = (await sdb.query(`SELECT password_hash FROM profiles WHERE email = 'admin@demo.pilotix.dz'`))[0]?.password_hash as string;
  if (!hash) throw new Error('demo: seed the store first');
  const [AG, MK] = DEMO_PARTNER_ACCOUNTS;
  const mk = async (who: (typeof DEMO_PARTNER_ACCOUNTS)[number], team: { name: string; email: string; roles: string[] }[]) => {
    const s = await provisionShop(t, { name: who.shop, kind: who.kind, planId: null, trialDays: 0, owner: { name: who.name, email: who.email, language: 'fr' }, passwordHash: hash, verified: true, now });
    // Pilotix checked it a while ago
    await t.platform.query('UPDATE platform.shops SET agency_verified_at = $2, created_at = $2 WHERE id = $1', [s.id, new Date(now - 60 * DAY).toISOString()]);
    const db = t.shop(s.schema);
    for (const p of team) await db.query('INSERT INTO profiles (name, email, password_hash, roles, language) VALUES ($1, $2, $3, $4, $5)', [p.name, p.email, hash, p.roles, 'fr']);
    return (await loadShop(t, { id: s.id }))!;
  };
  const agency = await mk(AG, AGENCY_TEAM);
  const marketer = await mk(MK, MARKETER_TEAM);

  const owner = await as(t, store, 'admin@demo.pilotix.dz', now);
  const chiefA = await as(t, agency, AG.email, now);
  const chiefM = await as(t, marketer, MK.email, now);
  await run(chiefA, 'agency.prices', { prices: AGENCY_PRICES });
  await run(chiefM, 'agency.prices', { prices: MARKETER_PRICES });

  // the products: the agency confirms and follows the small items, the marketer runs the ads of the big ones
  const pid = async (sku: string) => num((await sdb.query('SELECT id FROM products WHERE sku = $1', [sku]))[0].id);
  const forAgency = [await pid('PX-BIB'), await pid('PX-THE'), await pid('PX-BOD')];
  const forMarketer = [await pid('PX-LIT'), await pid('PX-CHA'), await pid('PX-TAP')];

  // the store asks both; they accept and put their team on it
  const linkOf = async (partner: Shop, chief: Ctx, tasks: string[], products: number[]) => {
    const { id } = await run(owner, 'partners.request', { agencyId: partner.id, tasks, products });
    await run(chief, 'agency.answer', { id, accept: true });
    const team = await run(chief, 'agency.team', {});
    await run(chief, 'agency.setAgents', { id, people: team.map((p: any) => p.id) });
    // a contract of some weeks already (its numbers and last month's bill)
    await t.platform.query('UPDATE platform.agency_links SET created_at = $2, answered_at = $3, started_at = $3 WHERE id = $1', [id, new Date(now - 47 * DAY).toISOString(), new Date(now - 46 * DAY).toISOString()]);
    return num(id);
  };
  const agencyLink = await linkOf(agency, chiefA, ['confirmation', 'suivi'], forAgency);
  const marketerLink = await linkOf(marketer, chiefM, ['marketing'], forMarketer);

  // the agency's orders: those of its products since the contract, confirmed by its agents, followed by its suivi
  const people = async (partnerId: number) =>
    (await sdb.query('SELECT id, roles FROM profiles WHERE agency_id = $1 AND active ORDER BY id', [partnerId])).map((r: any) => ({ id: num(r.id), roles: r.roles as string[] }));
  const agents = await people(agency.id);
  const conf = agents.filter((p) => p.roles.includes('confirmation')).map((p) => p.id);
  const suivi = agents.filter((p) => p.roles.includes('suivi') && !p.roles.includes('confirmation')).map((p) => p.id);
  const since = new Date(now - 46 * DAY).toISOString();
  await sdb.query(
    `UPDATE orders o SET conf_agency_id = $1, follow_agency_id = $1, route_product_id = f.product_id
       FROM (SELECT DISTINCT ON (order_id) order_id, product_id FROM order_items ORDER BY order_id, id) f
      WHERE f.order_id = o.id AND f.product_id = ANY($2) AND o.created_at >= $3`,
    [agency.id, forAgency, since],
  );
  if (conf.length)
    await sdb.query(`UPDATE orders SET agent_id = ($2::bigint[])[1 + (id % $3)] WHERE conf_agency_id = $1 AND agent_id IS NOT NULL`, [agency.id, conf, conf.length]);
  if (suivi.length) await sdb.query(`UPDATE orders SET follow_agent_id = $2 WHERE follow_agency_id = $1 AND follow_agent_id IS NOT NULL`, [agency.id, suivi[0]]);

  // the marketer's ad sets: its people's, on its products, with Meta's results of the last weeks
  const byEmail = async (email: string) => num((await sdb.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);
  const [nadirId, selmaId] = [await byEmail('nadir.mk@demo.pilotix.dz'), await byEmail('selma.mk@demo.pilotix.dz')];
  const sets = [
    { id: '120300001', name: 'Lit parapluie — mamans 25-40', campaign: 'Bébé confort', product: forMarketer[0], who: nadirId, status: 'ACTIVE', days: 44, usd: 26, pur: 9 },
    { id: '120300002', name: 'Chaise haute — retargeting 30 j', campaign: 'Repas bébé', product: forMarketer[1], who: selmaId, status: 'ACTIVE', days: 30, usd: 15, pur: 6 },
    { id: '120300003', name: 'Tapis d’éveil — vidéo unboxing', campaign: 'Éveil', product: forMarketer[2], who: nadirId, status: 'PAUSED', days: 40, usd: 12, pur: 5, stopAfter: 22 },
  ];
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (const s of sets) {
    await sdb.query('INSERT INTO adsets (id, name, campaign, product_ids, marketer_id, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING', [s.id, s.name, s.campaign, [s.product], s.who, s.status]);
    for (let d = s.days; d >= 1; d--) {
      if (s.stopAfter && s.days - d >= s.stopAfter) break;
      const day = new Date(now - d * DAY + 3_600_000).toISOString().slice(0, 10);
      const spend = Math.round(s.usd * (0.8 + rnd() * 0.4) * 100);
      const imp = Math.round((spend / 100 / 1.9) * 1000);
      await sdb.query(
        `INSERT INTO ad_insights (day, adset_id, spend_cents, impressions, reach, clicks, purchases, video_3s) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (day, adset_id) DO NOTHING`,
        [day, s.id, spend, imp, Math.round(imp / 1.6), Math.round(imp * 0.018), Math.max(0, Math.round(s.pur * (0.6 + rnd() * 0.8))), Math.round(imp * 0.28)],
      );
    }
  }
  // the dollar rate of the months with spend (the marketers' pay is counted with it)
  for (const m of [ym(now - 60 * DAY), ym(now - 30 * DAY), ym(now)]) await sdb.query('INSERT INTO fx_rates (ym, rate) VALUES ($1, 250) ON CONFLICT (ym) DO NOTHING', [m]);
  // the stopped one was judged « réussi » by the store
  await run(owner, 'mk.force', { ids: ['120300003'], st: 'ok' });

  // bills: last month's asked by both; the store paid the agency's (the agency still has to say « reçu »)
  const last = ym(now - 30 * DAY);
  const ask = async (chief: Ctx, id: number) => {
    try {
      await run(chief, 'agency.billRequest', { id, month: last });
    } catch {
      // nothing to ask for that month: no bill
    }
  };
  await ask(chiefA, agencyLink);
  await ask(chiefM, marketerLink);
  const bill = (await t.platform.query('SELECT id FROM platform.agency_bills WHERE link_id = $1 AND month = $2', [agencyLink, last]))[0];
  if (bill) await run(owner, 'partners.billPaid', { billId: num(bill.id) });
  // asked at the start of this month, paid a few days later (never in the future)
  const monthStart = Date.parse(`${ym(now)}-01T00:00:00Z`) - 3_600_000;
  const asked = Math.min(now - 3_600_000, monthStart + 1.4 * DAY);
  const paid = Math.min(now - 1_800_000, asked + 3 * DAY);
  await t.platform.query(
    `UPDATE platform.agency_bills SET requested_at = $3, paid_at = CASE WHEN paid_at IS NULL THEN NULL ELSE $4::timestamptz END WHERE link_id = ANY($1) AND month = $2`,
    [[agencyLink, marketerLink], last, new Date(asked).toISOString(), new Date(paid).toISOString()],
  );
  return { agencyId: agency.id, marketerId: marketer.id };
}
