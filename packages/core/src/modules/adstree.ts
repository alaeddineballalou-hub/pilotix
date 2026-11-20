// Lancer une pub and Mes pubs › the shop's ads as a tree, like Facebook's but simple: the campaigns, their ad sets and
// their ads, each with its own switch; a campaign made empty (the life ad circle's TEST and SCALE, or another one),
// which spends nothing until ads go in it; and « Supprimer », for the owner alone: deleted at Meta for good (it never
// comes back), written in the log.
//
// A switch goes through Pilot Ads' own button (adsmgr.ts › act: the owner's limits, the log, « Annuler »); a new ad
// set, or new ads in an ad set, through « Lancer une pub » (adslaunch.ts › placeOf: « Où va la pub ? »).
import { CIRCLE_SETTING, circleValues } from '@pilotix/shared';
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, forbidden, proc, withActionLock } from '../rpc';
import { getRaw } from './admin';
import { fxTable, isOwner, visibleAdsets } from './ads';
import { account, BID_LIMITS_KEY } from './adslaunch';
import { syncStructure } from './adsmgr';
import { checkSettings } from './pilotchecks';
import { campaignKind, emptyCampaign, GOAL_META, GOALS, goalsOfObjective, isGone, isOn, type Goal } from './pilotads';

const algDay = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 10);
const me = (ctx: Ctx) => ctx.session.profile.id || null;
/**
 * SQL: the ad account of an ad set `s` (its own, else its campaign `c`'s), written without « act_ ». The tree shows one
 * ad account only, the one new ads go to (Comptes › « Compte pour lancer »): the shop's tables also keep the campaigns
 * of its other ad accounts, and those of an ad account unticked since (never read again, so never cleaned).
 */
const SET_ACCOUNT = `regexp_replace(coalesce(nullif(s.account_id, ''), c.account_id, ''), '^act_', '')`;
const notHere = (acct: { id: string; name: string } | null) =>
  acct ? `Dans un autre compte pub que « ${acct.name || acct.id} » (celui de vos pubs) : Pilotix n’y touche pas d’ici.` : 'Reliez le compte pub Meta de la boutique (Pilot AI › Comptes).';
/** an amount in the account's cents → dollars (a dinar account through the month's rate) */
function usdOf(cents: number | null, currency: string, rate: number | null): number | null {
  if (cents === null) return null;
  if (currency.toUpperCase() === 'DZD') return rate ? Math.round((cents / 100 / rate) * 100) / 100 : null;
  return Math.round(cents) / 100;
}
/** TEST first, then SCALE, then the others */
const RANK = { test: 0, scale: 1 } as const;
/** the demo's ids, Meta-like (17 digits) */
const fakeId = (ctx: Ctx) => `2387${String(Math.floor(ctx.now() % 1e10)).padStart(10, '0')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;

/**
 * Everything the tree shows, fresh from Meta (at most every 10 minutes): the campaigns (a marketer sees them all, to
 * put his ads in), the ad sets he may see and their ads, of the ad account new ads go to and of no other (an ad set
 * whose ad account is not known yet waits for the next read). What Meta deleted or archived is left out. `prefill`:
 * what a new ad set in TEST or SCALE starts from (the life ad circle, Pilot Checks, the bid limits typed before).
 */
async function treeState(ctx: Ctx) {
  try {
    await syncStructure(ctx);
  } catch {
    // Meta unreachable: the last known state is shown
  }
  const owner = isOwner(ctx);
  const rate = (await fxTable(ctx.db))(algDay(ctx.now()).slice(0, 7));
  const acct = await account(ctx);
  const currency = acct?.currency ?? 'USD';
  // no ad account linked: nothing to show
  const acctId = acct?.id ?? '';
  const ids = (await visibleAdsets(ctx)).map((s) => s.id);
  const setRows = ids.length
    ? await ctx.db.query(
        `SELECT s.id, s.name, s.status, s.daily_budget_cents, s.currency, s.campaign_id, s.product_ids, s.group_id, coalesce(nullif(g.title, ''), p.name) AS product_name,
                m.name AS marketer_name, c.daily_budget_cents AS campaign_budget
           FROM adsets s LEFT JOIN products p ON p.id = s.product_ids[1] LEFT JOIN landing_groups g ON g.id = s.group_id LEFT JOIN profiles m ON m.id = s.marketer_id
                LEFT JOIN ad_campaigns c ON c.id = s.campaign_id
          WHERE s.id = ANY($1) AND $2 <> '' AND ${SET_ACCOUNT} = $2 ORDER BY lower(s.name), s.id`,
        [ids, acctId],
      )
    : [];
  const adsets = setRows
    .filter((r: any) => !isGone(r.status))
    .map((r: any) => {
      const own = r.daily_budget_cents !== null;
      return {
        id: String(r.id),
        campaignId: r.campaign_id ? String(r.campaign_id) : null,
        name: String(r.name),
        status: (r.status ?? null) as string | null,
        on: isOn(r.status),
        budgetUsd: own ? usdOf(num(r.daily_budget_cents), String(r.currency ?? currency), rate) : null,
        /** where its money is: its own budget, or its campaign's (Advantage+) */
        budgetLevel: own ? ('adset' as const) : r.campaign_id && r.campaign_budget !== null ? ('campaign' as const) : null,
        productIds: (r.product_ids ?? []).map(num) as number[],
        /** a group of Landing pages › Groupes it sells (its page), or null: one product */
        groupId: r.group_id === null || r.group_id === undefined ? null : num(r.group_id),
        productName: (r.product_name ?? null) as string | null,
        marketerName: (r.marketer_name ?? null) as string | null,
        ads: 0,
      };
    });
  const adRows = adsets.length ? await ctx.db.query(`SELECT id, adset_id, name, status, is_video FROM ads WHERE adset_id = ANY($1) ORDER BY id`, [adsets.map((s) => s.id)]) : [];
  const ads = adRows
    .filter((r: any) => !isGone(r.status))
    .map((r: any) => ({ id: String(r.id), adsetId: String(r.adset_id), name: String(r.name), status: (r.status ?? null) as string | null, on: isOn(r.status), isVideo: !!r.is_video }));
  const perSet = new Map<string, number>();
  for (const a of ads) perSet.set(a.adsetId, (perSet.get(a.adsetId) ?? 0) + 1);
  for (const s of adsets) s.ads = perSet.get(s.id) ?? 0;
  const campRows = await ctx.db.query(
    `SELECT c.id, c.name, c.objective, c.status, c.daily_budget_cents, c.kind,
            (SELECT count(*) FROM adsets s WHERE s.campaign_id = c.id AND coalesce(s.status, '') NOT IN ('DELETED', 'ARCHIVED')) AS all_sets,
            (SELECT currency FROM adsets s WHERE s.campaign_id = c.id AND s.currency IS NOT NULL LIMIT 1) AS currency
       FROM ad_campaigns c
      WHERE $1 <> '' AND regexp_replace(c.account_id, '^act_', '') = $1`,
    [acctId],
  );
  const campaigns = campRows
    .filter((r: any) => !isGone(r.status))
    .map((r: any) => {
      const kids = adsets.filter((s) => s.campaignId === String(r.id));
      const all = num(r.all_sets);
      return {
        id: String(r.id),
        name: String(r.name),
        kind: campaignKind(r.kind ?? null, String(r.name)),
        objective: (r.objective ?? null) as string | null,
        /** the goals an ad in it may have (none known: any) */
        goals: goalsOfObjective(r.objective),
        status: (r.status ?? null) as string | null,
        on: isOn(r.status),
        /** its money is its own (Advantage+): the ad sets in it have none */
        cbo: r.daily_budget_cents !== null,
        budgetUsd: r.daily_budget_cents !== null ? usdOf(num(r.daily_budget_cents), String(r.currency ?? currency), rate) : null,
        /** the ad sets this person sees in it; `allSets`: all of them (a marketer's campaign may hold other people's) */
        adsets: kids.length,
        allSets: all,
        ads: kids.reduce((n, s) => n + s.ads, 0),
        /** may this person switch it: the owner, or a marketer when every ad set in it is his (adsmgr.ts › targetOf) */
        mine: owner || (all > 0 && kids.length === all),
      };
    })
    .sort(
      (a, b) =>
        (a.kind ? RANK[a.kind] : 2) - (b.kind ? RANK[b.kind] : 2) || Number(b.on) - Number(a.on) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }),
    );
  const circle = circleValues(await getRaw<unknown>(ctx.db, CIRCLE_SETTING, null));
  const base = (await checkSettings(ctx.db)).find((s) => s.key === 'budgetBase')?.v ?? null;
  return {
    owner,
    demo: !ctx.server,
    currency,
    rate,
    account: acct ? { id: acct.id, name: acct.name } : null,
    campaigns,
    adsets,
    ads,
    prefill: {
      /** the circle's test: this many purchases at the product's bid limit, for this many days (the whole test's money) */
      testBuys: typeof circle.testBuys === 'number' ? circle.testBuys : 50,
      testDays: typeof circle.testDays === 'number' ? circle.testDays : 7,
      /** SCALE's starting budget for each product of an ad set, in the ad account's money (Pilot Checks) */
      budgetBase: base,
      /** the bid limit typed for each product before, in DA */
      bidLimits: await getRaw<Record<string, number>>(ctx.db, BID_LIMITS_KEY, {}),
    },
  };
}

/**
 * « Campagne vide »: TEST or SCALE (sales, the money on each ad set: the life ad circle's way), or another goal. On at
 * once, since with nothing in it it spends nothing. One name, one campaign: a second « TEST » would split the tests.
 */
async function makeCampaign(ctx: Ctx, i: { kind: 'test' | 'scale' | 'other'; name: string; goal: Goal; clientId?: string | null }) {
  if (i.clientId) {
    const seen = (await ctx.db.query(`SELECT object_id, object_name FROM ad_actions WHERE client_id = $1`, [i.clientId]))[0];
    if (seen) return { id: String(seen.object_id), name: String(seen.object_name), kind: i.kind === 'other' ? null : i.kind };
  }
  const name = i.name.trim();
  const goal: Goal = i.kind === 'other' ? i.goal : 'sales';
  const same = (await ctx.db.query(`SELECT 1 FROM ad_campaigns WHERE lower(name) = lower($1) AND coalesce(status, '') NOT IN ('DELETED', 'ARCHIVED') LIMIT 1`, [name]))[0];
  if (same) throw bad(`Vous avez déjà une campagne « ${name} » : ajoutez vos ensembles dedans, ou donnez un autre nom.`);
  const acct = await account(ctx);
  if (!acct) throw bad('Reliez le compte pub Meta de la boutique (Pilot AI › Comptes).');
  const body = emptyCampaign(name, goal);
  const id = ctx.server ? String(((await ctx.server.meta('create', { accountId: acct.id, body }, ctx)) as { id: string }).id) : fakeId(ctx);
  const kind = i.kind === 'other' ? null : i.kind;
  await ctx.db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO ad_campaigns (id, account_id, name, objective, status, daily_budget_cents, bid_strategy, kind, changed_at, updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',NULL,NULL,$5,now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [id, acct.id, name, GOAL_META[goal].objective, kind],
    );
    await tx.query(
      `INSERT INTO ad_actions (client_id, level, object_id, object_name, op, before, after, source, status, by_user, done_at) VALUES ($1,'campaign',$2,$3,'create',NULL,$4,'person','done',$5,now())`,
      [i.clientId ?? null, id, name, JSON.stringify({ status: 'ACTIVE', kind, goal }), me(ctx)],
    );
  });
  return { id, name, kind };
}

/** what a Meta id is in the shop's tables (an ad, an ad set or a campaign), and its ad account ('' not known) */
async function objectOf(ctx: Ctx, id: string): Promise<{ level: 'campaign' | 'adset' | 'ad'; name: string; status: string | null; account: string } | null> {
  const ad = (
    await ctx.db.query(`SELECT d.name, d.status, ${SET_ACCOUNT} AS account FROM ads d LEFT JOIN adsets s ON s.id = d.adset_id LEFT JOIN ad_campaigns c ON c.id = s.campaign_id WHERE d.id = $1`, [id])
  )[0];
  if (ad) return { level: 'ad', name: String(ad.name), status: ad.status ?? null, account: String(ad.account ?? '') };
  const set = (await ctx.db.query(`SELECT s.name, s.status, ${SET_ACCOUNT} AS account FROM adsets s LEFT JOIN ad_campaigns c ON c.id = s.campaign_id WHERE s.id = $1`, [id]))[0];
  if (set) return { level: 'adset', name: String(set.name), status: set.status ?? null, account: String(set.account ?? '') };
  const c = (await ctx.db.query(`SELECT name, status, regexp_replace(account_id, '^act_', '') AS account FROM ad_campaigns WHERE id = $1`, [id]))[0];
  if (c) return { level: 'campaign', name: String(c.name), status: c.status ?? null, account: String(c.account ?? '') };
  return null;
}
const ORDER = { campaign: 0, adset: 1, ad: 2 } as const;

/**
 * « Supprimer », the owner alone (the page asks « Vous êtes sûr ? » first): deleted at Meta for good, with what is in
 * it (a campaign's ad sets and ads, an ad set's ads). The campaigns go first, so what they hold is not asked twice.
 * One that Meta refuses stays, and says why; the others still go. Only in the ad account the tree shows: one of
 * another ad account is left alone, even asked by its number.
 */
async function remove(ctx: Ctx, ids: string[]) {
  if (!isOwner(ctx)) throw forbidden('Seul le propriétaire supprime sur Meta : vous pouvez éteindre.');
  const acct = await account(ctx);
  const found: { id: string; level: 'campaign' | 'adset' | 'ad'; name: string; status: string | null }[] = [];
  const failed: { id: string; why: string }[] = [];
  for (const id of [...new Set(ids)]) {
    const o = await objectOf(ctx, id);
    if (!o) failed.push({ id, why: 'Introuvable' });
    else if (!acct || o.account !== acct.id) failed.push({ id, why: notHere(acct) });
    else found.push({ id, level: o.level, name: o.name, status: o.status });
  }
  found.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  let deleted = 0;
  for (const o of found) {
    try {
      await withActionLock(ctx.db, `ads:${o.id}`, me(ctx), 'Un autre changement est en cours sur cette pub.', async () => {
        // gone already (with its campaign or ad set, deleted just before)
        const now = (await objectOf(ctx, o.id))?.status ?? o.status;
        if (isGone(now)) return;
        const row = (
          await ctx.db.query(
            `INSERT INTO ad_actions (level, object_id, object_name, op, before, after, source, status, by_user) VALUES ($1,$2,$3,'delete',$4,$5,'person','queued',$6) RETURNING id`,
            [o.level, o.id, o.name, JSON.stringify({ status: now }), JSON.stringify({ status: 'DELETED' }), me(ctx)],
          )
        )[0];
        try {
          if (ctx.server) await ctx.server.meta('delete', { id: o.id }, ctx);
        } catch (e: any) {
          await ctx.db.query(`UPDATE ad_actions SET status = 'failed', error = $2, done_at = now() WHERE id = $1`, [row.id, String(e?.message ?? e).slice(0, 500)]);
          throw e;
        }
        await ctx.db.tx(async (tx) => {
          if (o.level === 'campaign') {
            await tx.query(`UPDATE ads SET status = 'DELETED', updated_at = now() WHERE adset_id IN (SELECT id FROM adsets WHERE campaign_id = $1)`, [o.id]);
            await tx.query(`UPDATE adsets SET status = 'DELETED', changed_at = now(), updated_at = now() WHERE campaign_id = $1`, [o.id]);
            await tx.query(`UPDATE ad_campaigns SET status = 'DELETED', changed_at = now(), updated_at = now() WHERE id = $1`, [o.id]);
          } else if (o.level === 'adset') {
            await tx.query(`UPDATE ads SET status = 'DELETED', updated_at = now() WHERE adset_id = $1`, [o.id]);
            await tx.query(`UPDATE adsets SET status = 'DELETED', changed_at = now(), updated_at = now() WHERE id = $1`, [o.id]);
          } else await tx.query(`UPDATE ads SET status = 'DELETED', changed_at = now(), updated_at = now() WHERE id = $1`, [o.id]);
          await tx.query(`UPDATE ad_actions SET status = 'done', done_at = now() WHERE id = $1`, [row.id]);
        });
        deleted++;
      });
    } catch (e: any) {
      failed.push({ id: o.id, why: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return { deleted, failed };
}

const MetaId = z.string().regex(/^\d{6,25}$/);

export const adsTreeProcs = {
  /** the campaigns, their ad sets and their ads, as the tree shows them */
  'ads.tree.state': proc(['marketer'], z.object({}), (ctx) => treeState(ctx)),
  /** « Campagne vide »: TEST, SCALE, or another one with its goal */
  'ads.tree.campaign': proc(
    ['marketer'],
    z.object({ kind: z.enum(['test', 'scale', 'other']), name: z.string().trim().min(1).max(200), goal: z.enum(GOALS).default('sales'), clientId: z.string().max(64).nullable().optional() }),
    (ctx, i) => makeCampaign(ctx, i),
  ),
  /** « Supprimer » (the owner): campaigns, ad sets or ads, deleted at Meta for good */
  'ads.tree.delete': proc(['vendeur'], z.object({ ids: z.array(MetaId).min(1).max(50) }), (ctx, i) => remove(ctx, i.ids)),
};
