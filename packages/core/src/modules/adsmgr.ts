// Pilot Ads (Marketing › Publicité): the buttons that change the shop's Meta ads (pause, start again, budget, copy),
// the owner's limits and « Tout arrêter », the log of every change with Undo, Pilote auto (its rules and suggestions),
// where the ads' orders come from (wilayas, hours, goals), and the audiences built from the shop's own customers.
//
// Every change is one ad_actions row first (with what it was before), then Meta (server) or the tables (demo, no
// server), then the row says what happened. A marketer's big raise waits for the owner's yes. Pausing always works.
import { z } from 'zod';
import { Db, num } from '../db';
import { bad, Ctx, forbidden, notFound, proc, withActionLock } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, META_TOKEN_KEY, setRaw } from './admin';
import { listPhones, listSwitches } from './landinglists';
import { addDays, adsetDiagnostic, dayStart, fxTable, insights, isOwner, moneyOf, ordersOf, productAdvice, sumDays, syncMeta, visibleAdsets } from './ads';
import {
  AUDIENCE_DEFAULT_ON,
  AUDIENCE_KINDS,
  AUTO_PER_DAY,
  AUTO_RULES,
  checkChange,
  DEFAULT_GUARD,
  DEFAULT_RULES,
  EVENT_AUDIENCE_DAYS,
  EVENT_AUDIENCES,
  isEventAudience,
  metaPhone,
  RULE_COOLDOWN_H,
  RULE_KEYS,
  suggestFor,
  type AdsetStats,
  type AudienceKind,
  type EventAudienceKind,
  type Guard,
  type RuleKey,
  type RuleMode,
  type TagKind,
} from './pilotads';

const KEY = 'pilot_ads';
const ACCOUNTS_KEY = 'pilot_ads_accounts';
export interface PilotSettings {
  guard: Guard;
  rules: Record<RuleKey, RuleMode>;
  lastRun: string | null;
  structureAt: string | null;
  audiencesAt: string | null;
  auto: { day: string; n: number };
}
export async function pilotSettings(db: Db): Promise<PilotSettings> {
  const s = await getRaw<Partial<PilotSettings>>(db, KEY, {});
  return {
    guard: { ...DEFAULT_GUARD, ...(s.guard ?? {}) },
    rules: { ...DEFAULT_RULES, ...(s.rules ?? {}) },
    lastRun: s.lastRun ?? null,
    structureAt: s.structureAt ?? null,
    audiencesAt: s.audiencesAt ?? null,
    auto: s.auto ?? { day: '', n: 0 },
  };
}
const savePilot = async (ctx: Ctx, next: PilotSettings) => setRaw(ctx.db, KEY, next, ctx.session.profile.id || undefined);
const me = (ctx: Ctx) => ctx.session.profile.id || null;
const stamp = (ctx: Ctx) => new Date(ctx.now()).toISOString();
/** the day in Algiers (UTC+1) */
const algDay = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 10);

export interface AccountHealth {
  id: string;
  name: string;
  currency: string;
  /** Meta's account_status: 1 active, 2 disabled, 3 unpaid, 7 pending review, 9 grace period, 101 closed */
  status: number;
  disableReason: number;
  spendCap: number | null;
  spent: number | null;
  balance: number | null;
  minDaily: number | null;
}

/**
 * Campaigns, ad sets and ads as Meta has them now (budgets, states), and each ad account's health. Server only. An
 * account read whole: what Meta no longer gives was deleted (in the Ads Manager, or here), and leaves the tree.
 */
export async function syncStructure(ctx: Ctx, force = false): Promise<boolean> {
  if (!ctx.server) return false;
  const s = await pilotSettings(ctx.db);
  if (!force && s.structureAt && ctx.now() - Date.parse(s.structureAt) < 10 * 60_000) return false;
  const r = (await ctx.server.meta('structure', {}, ctx)) as { accounts: AccountHealth[]; campaigns: any[]; adsets: any[]; ads?: any[]; complete?: string[] };
  await ctx.db.tx(async (tx) => {
    for (const x of r.ads ?? [])
      await tx.query(
        `INSERT INTO ads (id, adset_id, name, status, is_video, updated_at) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (id) DO UPDATE SET adset_id = EXCLUDED.adset_id, name = EXCLUDED.name, status = EXCLUDED.status, is_video = EXCLUDED.is_video, updated_at = now()`,
        [x.id, x.adsetId, x.name, x.status, !!x.isVideo],
      );
    for (const acct of r.complete ?? []) {
      const camps = r.campaigns.filter((c) => c.accountId === acct).map((c) => String(c.id));
      const sets = r.adsets.filter((a) => a.accountId === acct).map((a) => String(a.id));
      const inSets = new Set(sets);
      const ads = (r.ads ?? []).filter((x) => inSets.has(String(x.adsetId))).map((x) => String(x.id));
      await tx.query(`UPDATE ad_campaigns SET status = 'DELETED', updated_at = now() WHERE account_id = $1 AND NOT (id = ANY($2)) AND coalesce(status, '') NOT IN ('DELETED', 'ARCHIVED')`, [acct, camps]);
      await tx.query(`UPDATE adsets SET status = 'DELETED', updated_at = now() WHERE account_id = $1 AND NOT (id = ANY($2)) AND coalesce(status, '') NOT IN ('DELETED', 'ARCHIVED')`, [acct, sets]);
      await tx.query(
        `UPDATE ads SET status = 'DELETED', updated_at = now() WHERE adset_id IN (SELECT id FROM adsets WHERE account_id = $1) AND NOT (id = ANY($2)) AND coalesce(status, '') NOT IN ('DELETED', 'ARCHIVED')`,
        [acct, ads],
      );
    }
    for (const c of r.campaigns)
      await tx.query(
        `INSERT INTO ad_campaigns (id, account_id, name, objective, status, daily_budget_cents, bid_strategy, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (id) DO UPDATE SET account_id = EXCLUDED.account_id, name = EXCLUDED.name, objective = EXCLUDED.objective, status = EXCLUDED.status,
           daily_budget_cents = EXCLUDED.daily_budget_cents, bid_strategy = EXCLUDED.bid_strategy, updated_at = now()`,
        [c.id, c.accountId, c.name, c.objective, c.status, c.dailyBudgetCents, c.bidStrategy],
      );
    for (const a of r.adsets)
      await tx.query(
        `INSERT INTO adsets (id, name, campaign_id, account_id, daily_budget_cents, status, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (id) DO UPDATE SET campaign_id = EXCLUDED.campaign_id, account_id = EXCLUDED.account_id, daily_budget_cents = EXCLUDED.daily_budget_cents,
           status = coalesce(EXCLUDED.status, adsets.status), updated_at = now()`,
        [a.id, a.name, a.campaignId || null, a.accountId, a.dailyBudgetCents, a.status],
      );
  });
  await setRaw(ctx.db, ACCOUNTS_KEY, r.accounts);
  await setRaw(ctx.db, KEY, { ...(await getRaw(ctx.db, KEY, {})), structureAt: stamp(ctx) });
  return true;
}

// ---------------------------------------------------------------- control
export type Op = 'pause' | 'resume' | 'budget' | 'copy';
interface Target {
  /** 'ad': one ad, turned on or off only (Lancer une pub › the tree) */
  level: 'adset' | 'campaign' | 'ad';
  id: string;
  name: string;
  status: string | null;
  budgetCents: number | null;
  currency: string;
  marketerId: number | null;
  /** an ad set whose campaign holds the budget: its campaign */
  campaignId: string | null;
}

/** an amount in the account's cents → dollars (a dinar account through the month's rate) */
function usdOf(cents: number | null, currency: string, rate: number | null): number | null {
  if (cents === null) return null;
  if (currency.toUpperCase() === 'DZD') return rate ? cents / 100 / rate : null;
  return cents / 100;
}
const centsOf = (usd: number, currency: string, rate: number | null) => (currency.toUpperCase() === 'DZD' ? Math.round(usd * (rate ?? 0) * 100) : Math.round(usd * 100));

async function targetOf(ctx: Ctx, objectId: string): Promise<Target> {
  const a = (await ctx.db.query(`SELECT s.*, c.daily_budget_cents AS campaign_budget FROM adsets s LEFT JOIN ad_campaigns c ON c.id = s.campaign_id WHERE s.id = $1`, [objectId]))[0];
  if (a) {
    // a marketer only changes the ad sets he sees (his own, or his partner's)
    if (!isOwner(ctx) && !(await visibleAdsets(ctx)).some((s) => s.id === objectId)) throw forbidden();
    return { level: 'adset', id: String(a.id), name: String(a.name), status: a.status ?? null, budgetCents: a.daily_budget_cents === null ? null : num(a.daily_budget_cents), currency: String(a.currency ?? 'USD'), marketerId: a.marketer_id === null ? null : num(a.marketer_id), campaignId: a.campaign_id ?? null };
  }
  // one ad: whoever may change its ad set may turn it on or off
  const ad = (await ctx.db.query(`SELECT d.id, d.name, d.status, d.adset_id, s.currency, s.marketer_id FROM ads d LEFT JOIN adsets s ON s.id = d.adset_id WHERE d.id = $1`, [objectId]))[0];
  if (ad) {
    if (!isOwner(ctx) && !(await visibleAdsets(ctx)).some((s) => s.id === String(ad.adset_id))) throw forbidden();
    return { level: 'ad', id: String(ad.id), name: String(ad.name), status: ad.status ?? null, budgetCents: null, currency: String(ad.currency ?? 'USD'), marketerId: ad.marketer_id === null ? null : num(ad.marketer_id), campaignId: null };
  }
  const c =(await ctx.db.query(`SELECT c.*, (SELECT currency FROM adsets WHERE campaign_id = c.id LIMIT 1) AS currency FROM ad_campaigns c WHERE c.id = $1`, [objectId]))[0];
  if (!c) throw notFound('Ad set ou campagne introuvable');
  if (!isOwner(ctx)) {
    const mine = new Set((await visibleAdsets(ctx)).map((s) => s.id));
    const kids = (await ctx.db.query(`SELECT id FROM adsets WHERE campaign_id = $1`, [objectId])).map((r: any) => String(r.id));
    if (!kids.length || !kids.every((k) => mine.has(k))) throw forbidden();
  }
  return { level: 'campaign', id: String(c.id), name: String(c.name), status: c.status ?? null, budgetCents: c.daily_budget_cents === null ? null : num(c.daily_budget_cents), currency: String(c.currency ?? 'USD'), marketerId: null, campaignId: null };
}

/**
 * what all the shop's running ads may spend per day, in dollars (ad set budgets + campaign budgets). A campaign's
 * budget counts while one of its ad sets may still spend: every ad set paused or deleted, it spends nothing.
 */
export async function shopDailyUsd(db: Db, rate: number | null): Promise<number> {
  const sets = await db.query(`SELECT daily_budget_cents, currency FROM adsets WHERE status = 'ACTIVE' AND daily_budget_cents IS NOT NULL`);
  const camps = await db.query(
    `SELECT c.daily_budget_cents, (SELECT currency FROM adsets WHERE campaign_id = c.id LIMIT 1) AS currency FROM ad_campaigns c
     WHERE c.status = 'ACTIVE' AND c.daily_budget_cents IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM adsets s WHERE s.campaign_id = c.id)
            OR EXISTS (SELECT 1 FROM adsets s WHERE s.campaign_id = c.id AND coalesce(s.status, '') NOT IN ('PAUSED','CAMPAIGN_PAUSED','DELETED','ARCHIVED')))`,
  );
  return [...sets, ...camps].reduce((s: number, r: any) => s + (usdOf(num(r.daily_budget_cents), String(r.currency ?? 'USD'), rate) ?? 0), 0);
}

/** Meta (server) or the tables (demo): the change itself. Returns what the object is now. */
async function applyChange(ctx: Ctx, t: Target, op: Op, valueCents: number | null): Promise<{ status: string | null; budgetCents: number | null; copyId?: string }> {
  if (t.level === 'ad') {
    if (op !== 'pause' && op !== 'resume') throw bad('Une pub s’allume ou s’éteint : son budget est celui de son ensemble.');
    let status: string | null = op === 'pause' ? 'PAUSED' : 'ACTIVE';
    if (ctx.server) status = ((await ctx.server.meta('update', { id: t.id, status, level: 'ad' }, ctx)) as { status: string | null }).status ?? status;
    await ctx.db.query(`UPDATE ads SET status = $2, changed_at = now(), updated_at = now() WHERE id = $1`, [t.id, status]);
    return { status, budgetCents: null };
  }
  const table = t.level === 'adset' ? 'adsets' : 'ad_campaigns';
  if (op === 'copy') {
    let id: string;
    if (ctx.server) id = String(((await ctx.server.meta('copy', { id: t.id, level: t.level }, ctx)) as { id: string }).id);
    else id = String(10_000_000_000_000 + Math.floor(ctx.now() % 1_000_000_000));
    if (t.level === 'adset')
      await ctx.db.query(
        `INSERT INTO adsets (id, name, campaign, campaign_id, account_id, daily_budget_cents, goal, product_ids, group_id, marketer_id, status, currency, launch_id, updated_at)
         SELECT $2, name || ' · copie', campaign, campaign_id, account_id, daily_budget_cents, goal, product_ids, group_id, marketer_id, 'PAUSED', currency, launch_id, now() FROM adsets WHERE id = $1
         ON CONFLICT (id) DO NOTHING`,
        [t.id, id],
      );
    return { status: t.status, budgetCents: t.budgetCents, copyId: id };
  }
  const status = op === 'pause' ? 'PAUSED' : op === 'resume' ? 'ACTIVE' : null;
  let now = { status: status ?? t.status, budgetCents: op === 'budget' ? valueCents : t.budgetCents };
  if (ctx.server) {
    const r = (await ctx.server.meta('update', { id: t.id, ...(status ? { status } : {}), ...(op === 'budget' ? { dailyBudgetCents: valueCents } : {}) }, ctx)) as { status: string | null; dailyBudgetCents: number | null };
    now = { status: r.status ?? now.status, budgetCents: r.dailyBudgetCents ?? now.budgetCents };
  }
  await ctx.db.query(`UPDATE ${table} SET status = $2, daily_budget_cents = $3, changed_at = now(), updated_at = now() WHERE id = $1`, [t.id, now.status, now.budgetCents]);
  return now;
}

export interface ActInput {
  objectId: string;
  op: Op;
  /** budget: the new daily budget, in dollars */
  usd?: number | null;
  clientId?: string | null;
  /** auto: Pilot Automations (no stock left → paused, stock back → started again) */
  source?: 'person' | 'rule' | 'stop_all' | 'pilot' | 'launch' | 'auto';
  rule?: RuleKey | null;
  why?: string | null;
  /** Pilote auto acting alone: a change that would wait for the owner is not made at all */
  auto?: boolean;
}
/**
 * One change, safely: checked against the owner's limits and Meta's 4 budget changes per hour, written down first,
 * then made. Too big for a marketer: it waits for the owner (status waiting_yes). The same clientId twice (a double
 * click) gives the first answer back.
 */
export async function act(ctx: Ctx, i: ActInput): Promise<{ id: number; status: string; why: string | null; copyId?: string | null }> {
  if (i.clientId) {
    const seen = (await ctx.db.query(`SELECT id, status, why FROM ad_actions WHERE client_id = $1`, [i.clientId]))[0];
    if (seen) return { id: num(seen.id), status: String(seen.status), why: seen.why ?? null };
  }
  return withActionLock(ctx.db, `ads:${i.objectId}`, me(ctx), 'Un autre changement est en cours sur cette pub.', async () => {
    let t = await targetOf(ctx, i.objectId);
    if (t.level === 'ad' && i.op !== 'pause' && i.op !== 'resume') throw bad('Une pub s’allume ou s’éteint : son budget est celui de son ensemble.');
    // an ad set whose budget is its campaign's: the budget changes on the campaign
    if (i.op === 'budget' && t.level === 'adset' && t.budgetCents === null && t.campaignId) t = await targetOf(ctx, t.campaignId);
    const s = await pilotSettings(ctx.db);
    const fx = await fxTable(ctx.db);
    const rate = fx(algDay(ctx.now()).slice(0, 7));
    const fromUsd = usdOf(t.budgetCents, t.currency, rate);
    const toUsd = i.op === 'budget' ? (i.usd ?? null) : fromUsd;
    if (i.op === 'budget' && t.currency.toUpperCase() === 'DZD' && !rate) throw bad('Ajoutez le taux du dollar de ce mois (Publicité) : le compte pub est en dinars.');
    const changes = num((await ctx.db.query(`SELECT count(*) AS n FROM ad_actions WHERE object_id = $1 AND op IN ('budget','undo') AND status = 'done' AND done_at > now() - interval '1 hour'`, [t.id]))[0]?.n);
    const owner = isOwner(ctx) && (i.source ?? 'person') !== 'rule';
    if (i.op === 'budget' && t.budgetCents === null) throw bad('Le budget de cette pub se règle dans Meta (budget à vie, ou pas encore lu) : changez-le dans le Gestionnaire de publicités.');
    const v = checkChange(s.guard, { op: i.op, owner, fromUsd, toUsd, shopDailyUsd: await shopDailyUsd(ctx.db, rate), changesLastHour: changes });
    if (!v.ok) throw bad(v.why);
    if (v.needsYes && i.auto) throw bad(v.why ?? 'Le propriétaire doit dire oui.');
    const before = { status: t.status, budgetCents: t.budgetCents };
    const valueCents = i.op === 'budget' && toUsd !== null ? centsOf(toUsd, t.currency, rate) : null;
    const after = i.op === 'budget' ? { budgetCents: valueCents } : i.op === 'copy' ? {} : { status: i.op === 'pause' ? 'PAUSED' : 'ACTIVE' };
    const row = (
      await ctx.db.query(
        `INSERT INTO ad_actions (client_id, level, object_id, object_name, op, before, after, source, rule_key, status, why, by_user)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [i.clientId ?? null, t.level, t.id, t.name, i.op, JSON.stringify(before), JSON.stringify(after), i.source ?? 'person', i.rule ?? null, v.needsYes ? 'waiting_yes' : 'queued', i.why ?? v.why, me(ctx)],
      )
    )[0];
    const id = num(row.id);
    if (v.needsYes) return { id, status: 'waiting_yes', why: v.why };
    return run(ctx, id, t, i.op, valueCents);
  });
}

async function run(ctx: Ctx, id: number, t: Target, op: Op, valueCents: number | null) {
  try {
    const r = await applyChange(ctx, t, op, valueCents);
    await ctx.db.query(`UPDATE ad_actions SET status = 'done', done_at = now(), after = after || $2::jsonb WHERE id = $1`, [id, JSON.stringify({ status: r.status, budgetCents: r.budgetCents, ...(r.copyId ? { copyId: r.copyId } : {}) })]);
    return { id, status: 'done', why: null, copyId: r.copyId ?? null };
  } catch (e: any) {
    await ctx.db.query(`UPDATE ad_actions SET status = 'failed', error = $2, done_at = now() WHERE id = $1`, [id, String(e?.message ?? e).slice(0, 500)]);
    throw e;
  }
}

/** A change undone (7 days at most, and only when nothing changed the object since). */
async function undo(ctx: Ctx, id: number) {
  const a = (await ctx.db.query(`SELECT * FROM ad_actions WHERE id = $1`, [id]))[0];
  if (!a) throw notFound('Changement introuvable');
  if (a.status !== 'done' || !['pause', 'resume', 'budget'].includes(a.op)) throw bad('Ce changement ne peut pas être annulé.');
  if (ctx.now() - new Date(a.done_at ?? a.created_at).getTime() > 7 * 86_400_000) throw bad('Trop ancien : un changement s’annule pendant 7 jours.');
  const later = (await ctx.db.query(`SELECT 1 FROM ad_actions WHERE object_id = $1 AND id > $2 AND status = 'done' LIMIT 1`, [a.object_id, id]))[0];
  if (later) throw bad('Cette pub a changé depuis : annulez d’abord le changement le plus récent.');
  const t = await targetOf(ctx, String(a.object_id));
  const before = a.before ?? {};
  const op: Op = a.op === 'budget' ? 'budget' : before.status === 'ACTIVE' ? 'resume' : 'pause';
  // going back is a change like the others: the owner's limits still hold (a budget raised back, a pub started again)
  const s = await pilotSettings(ctx.db);
  const rate = (await fxTable(ctx.db))(algDay(ctx.now()).slice(0, 7));
  const fromUsd = usdOf(t.budgetCents, t.currency, rate);
  const toUsd = op === 'budget' ? usdOf(before.budgetCents ?? null, t.currency, rate) : fromUsd;
  const v = checkChange(s.guard, { op, owner: isOwner(ctx), fromUsd, toUsd, shopDailyUsd: await shopDailyUsd(ctx.db, rate), changesLastHour: 0 });
  if (!v.ok) throw bad(v.why);
  if (v.needsYes) throw bad(`${v.why} Refaites le changement avec le bouton Budget : il ira au propriétaire.`);
  const row = (
    await ctx.db.query(
      `INSERT INTO ad_actions (level, object_id, object_name, op, before, after, source, status, by_user, undo_of) VALUES ($1,$2,$3,'undo',$4,$5,'person','queued',$6,$7) RETURNING id`,
      [t.level, t.id, t.name, JSON.stringify({ status: t.status, budgetCents: t.budgetCents }), JSON.stringify(before), me(ctx), id],
    )
  )[0];
  const r = await run(ctx, num(row.id), t, op, op === 'budget' ? (before.budgetCents ?? null) : null);
  await ctx.db.query(`UPDATE ad_actions SET status = 'undone' WHERE id = $1`, [id]);
  return r;
}

async function actionsOf(ctx: Ctx, limit: number, where = '') {
  const mine = isOwner(ctx) ? null : new Set((await visibleAdsets(ctx)).map((s) => s.id));
  const rows = await ctx.db.query(
    `SELECT a.*, p.name AS by_name, q.name AS approved_name FROM ad_actions a LEFT JOIN profiles p ON p.id = a.by_user LEFT JOIN profiles q ON q.id = a.approved_by
     ${where} ORDER BY a.id DESC LIMIT $1`,
    [limit],
  );
  return rows
    .filter((r: any) => !mine || mine.has(String(r.object_id)) || (r.by_user !== null && num(r.by_user) === me(ctx)))
    .map((r: any) => ({
      id: num(r.id),
      level: String(r.level),
      objectId: String(r.object_id),
      objectName: String(r.object_name),
      op: String(r.op),
      before: r.before ?? null,
      after: r.after ?? null,
      source: String(r.source),
      rule: r.rule_key ?? null,
      status: String(r.status),
      why: r.why ?? null,
      error: r.error ?? null,
      // Pilot Automations acted alone (its name is shown, not the account it runs as)
      by: r.source === 'auto' ? null : (r.by_name ?? null),
      approvedBy: r.approved_name ?? null,
      at: new Date(r.created_at).toISOString(),
      canUndo: r.status === 'done' && ['pause', 'resume', 'budget'].includes(r.op) && ctx.now() - new Date(r.done_at ?? r.created_at).getTime() < 7 * 86_400_000,
    }));
}

/** Everything the buttons need: each ad set and campaign (state, budget), the limits, the waiting yeses, the log. */
async function controlState(ctx: Ctx) {
  try {
    await syncStructure(ctx);
  } catch {
    // Meta unreachable: the last known state is shown
  }
  const s = await pilotSettings(ctx.db);
  const fx = await fxTable(ctx.db);
  const rate = fx(algDay(ctx.now()).slice(0, 7));
  const sets = await visibleAdsets(ctx);
  const ids = sets.map((x) => x.id);
  const rows = ids.length
    ? await ctx.db.query(
        `SELECT s.id, s.name, s.status, s.daily_budget_cents, s.currency, s.goal, s.campaign_id, s.changed_at, s.launch_id, c.name AS campaign_name, c.daily_budget_cents AS campaign_budget, c.status AS campaign_status
         FROM adsets s LEFT JOIN ad_campaigns c ON c.id = s.campaign_id WHERE s.id = ANY($1)`,
        [ids],
      )
    : [];
  const waiting = new Set((await ctx.db.query(`SELECT object_id FROM ad_actions WHERE status = 'waiting_yes'`)).map((r: any) => String(r.object_id)));
  const objects = rows.map((r: any) => {
    const cur = String(r.currency ?? 'USD');
    const own = r.daily_budget_cents !== null;
    const cents = own ? num(r.daily_budget_cents) : r.campaign_budget === null ? null : num(r.campaign_budget);
    return {
      id: String(r.id),
      name: String(r.name),
      status: r.status ?? null,
      goal: r.goal ?? null,
      currency: cur,
      budgetCents: cents,
      budgetUsd: usdOf(cents, cur, rate),
      budgetLevel: own ? ('adset' as const) : r.campaign_id && r.campaign_budget !== null ? ('campaign' as const) : null,
      campaignId: r.campaign_id ?? null,
      campaignName: r.campaign_name ?? null,
      changedAt: r.changed_at ? new Date(r.changed_at).toISOString() : null,
      waiting: waiting.has(String(r.id)) || (!!r.campaign_id && waiting.has(String(r.campaign_id))),
      launched: r.launch_id !== null,
    };
  });
  const accounts = await getRaw<AccountHealth[]>(ctx.db, ACCOUNTS_KEY, []);
  const openSuggestions = num((await ctx.db.query(`SELECT count(*) AS n FROM ad_suggestions WHERE status = 'open'`))[0]?.n);
  return {
    owner: isOwner(ctx),
    demo: !ctx.server,
    guard: s.guard,
    rate,
    shopDailyUsd: Math.round((await shopDailyUsd(ctx.db, rate)) * 100) / 100,
    accounts,
    objects,
    waiting: await actionsOf(ctx, 50, `WHERE a.status = 'waiting_yes'`),
    recent: await actionsOf(ctx, 30),
    suggestions: openSuggestions,
  };
}

async function stopAll(ctx: Ctx, on: boolean) {
  const s = await pilotSettings(ctx.db);
  if (on) {
    await savePilot(ctx, { ...s, guard: { ...s.guard, stopped: true } });
    const live = await ctx.db.query(`SELECT id FROM adsets WHERE status = 'ACTIVE'`);
    let paused = 0;
    for (const r of live) {
      try {
        await act(ctx, { objectId: String(r.id), op: 'pause', source: 'stop_all', why: 'Tout arrêter' });
        paused++;
      } catch {
        // one that Meta refuses stays as it is (shown in the log)
      }
    }
    return { paused, resumed: 0 };
  }
  await savePilot(ctx, { ...s, guard: { ...s.guard, stopped: false } });
  // what « Tout arrêter » paused starts again, unless someone changed it since
  const rows = await ctx.db.query(
    `SELECT DISTINCT ON (object_id) object_id, source, op, status FROM ad_actions WHERE status IN ('done','undone') ORDER BY object_id, id DESC`,
  );
  let resumed = 0;
  for (const r of rows.filter((x: any) => x.source === 'stop_all' && x.op === 'pause' && x.status === 'done')) {
    try {
      await act(ctx, { objectId: String(r.object_id), op: 'resume', source: 'person', why: 'Tout relancer' });
      resumed++;
    } catch {
      // left paused
    }
  }
  return { paused: 0, resumed };
}

// ---------------------------------------------------------------- Pilote auto
/** The numbers the rules read for each running ad set (3 and 7 days of spend and orders, 30 days of the product). */
async function statsOf(ctx: Ctx): Promise<AdsetStats[]> {
  const today = algDay(ctx.now());
  const fx = await fxTable(ctx.db);
  const rate = fx(today.slice(0, 7));
  const sets = (await visibleAdsets({ ...ctx, session: { ...ctx.session, isAdmin: true } } as Ctx)).filter((s) => s.status === 'ACTIVE');
  if (!sets.length) return [];
  const extra = new Map(
    (await ctx.db.query(`SELECT id, daily_budget_cents, currency, changed_at FROM adsets WHERE id = ANY($1)`, [sets.map((s) => s.id)])).map((r: any) => [String(r.id), r]),
  );
  const rows = await insights(ctx.db, sets.map((s) => s.id), addDays(today, -13), today);
  const out: AdsetStats[] = [];
  for (const s of sets) {
    const days = rows.filter((r) => r.adsetId === s.id);
    const last3 = sumDays(days.filter((r) => r.day > addDays(today, -3)));
    const last7 = days.filter((r) => r.day > addDays(today, -7));
    const prev7 = days.filter((r) => r.day <= addDays(today, -7));
    // orders that carry this ad set (or one of its ads) in their link, else the product's orders by its share of spend
    const attributed = await ctx.db.query(
      `SELECT created_at FROM sales WHERE created_at >= $2 AND conf_status <> 'duplicate'
         AND (adset_id = $1 OR utm->>'adset_id' = $1 OR utm->>'ad_id' IN (SELECT id FROM ads WHERE adset_id = $1))`,
      [s.id, dayStart(addDays(today, -6))],
    );
    const o3 = attributed.filter((o: any) => new Date(o.created_at).getTime() >= Date.parse(dayStart(addDays(today, -2)))).length;
    const orders30 = await ordersOf(ctx.db, s.productIds, addDays(today, -29), today);
    const m = await moneyOf(ctx.db, orders30, 0);
    const pAdv = productAdvice(m, null).k;
    const e = extra.get(s.id);
    const perDelivered = m.d ? m.avant / m.d : null;
    const target = perDelivered && rate ? (perDelivered * (m.n ? m.d / m.n : 0.5)) / rate : null;
    out.push({
      id: s.id,
      name: s.name,
      status: s.status,
      budgetUsd: usdOf(e?.daily_budget_cents === null || e?.daily_budget_cents === undefined ? null : num(e.daily_budget_cents), String(e?.currency ?? 'USD'), rate),
      spend3Usd: last3.spend,
      spend7Usd: sumDays(last7).spend,
      orders3: o3,
      orders7: attributed.length,
      received: m.n,
      delivered: m.d,
      returned: m.r,
      cancelled: m.x ?? 0,
      perDeliveredDzd: perDelivered,
      rate,
      diag: adsetDiagnostic(last7, prev7, pAdv, target && target > 0 ? target : null).k,
      changedHoursAgo: e?.changed_at ? (ctx.now() - new Date(e.changed_at).getTime()) / 3_600_000 : null,
    });
  }
  return out;
}

/**
 * Pilote auto, every 15 minutes (and « Vérifier maintenant »): fresh numbers, one suggestion per ad set at most, and
 * the rules set to « Automatique » act alone within the limits (5 changes a day, 72 h between two budget changes,
 * never a raise that needs the owner). The daily cap pauses at the cap and starts again the next morning.
 */
export async function pilotRun(ctx: Ctx) {
  const s = await pilotSettings(ctx.db);
  const today = algDay(ctx.now());
  if (ctx.server) {
    try {
      await syncMeta(ctx, addDays(today, -2), today);
      await syncStructure(ctx);
    } catch {
      // Meta unreachable: the rules read the last numbers
    }
    // « Pubs faites à la main »: the Pilotix lists on the new ad sets made in Meta (a check already running: skipped)
    await handRun(ctx).catch(() => null);
    // and the URL parameters on the new ads made in Meta, so each of their orders knows its ad
    await tagRun(ctx).catch(() => null);
  }
  const sys = { ...ctx, session: { ...ctx.session, isAdmin: true } } as Ctx;
  const stats = await statsOf(ctx);
  const seen = new Set<string>();
  let auto = s.auto.day === today ? s.auto.n : 0;
  const acted: string[] = [];
  // a change already waiting for the owner's yes: Pilote auto does not add another one
  const waiting = new Set((await ctx.db.query(`SELECT object_id FROM ad_actions WHERE status = 'waiting_yes'`)).map((r: any) => String(r.object_id)));
  for (const st of stats) {
    const sug = suggestFor(st);
    if (!sug || s.rules[sug.rule] === 'off') continue;
    seen.add(`${sug.rule}:${sug.objectId}`);
    const open = (await ctx.db.query(`SELECT id FROM ad_suggestions WHERE rule_key = $1 AND object_id = $2 AND status = 'open'`, [sug.rule, sug.objectId]))[0];
    const sid = open
      ? num(open.id)
      : num(
          (
            await ctx.db.query(`INSERT INTO ad_suggestions (rule_key, object_id, object_name, op, value, why) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
              sug.rule,
              sug.objectId,
              sug.objectName,
              sug.op,
              sug.value,
              JSON.stringify(sug.why),
            ])
          )[0].id,
        );
    const cooled = st.changedHoursAgo === null || st.changedHoursAgo >= RULE_COOLDOWN_H || sug.op === 'pause';
    if (s.rules[sug.rule] === 'auto' && AUTO_RULES.includes(sug.rule) && (sug.op === 'pause' || sug.op === 'budget') && auto < AUTO_PER_DAY && cooled && !s.guard.stopped && !waiting.has(sug.objectId)) {
      try {
        const r = await act(sys, { objectId: sug.objectId, op: sug.op, usd: sug.value, source: 'rule', rule: sug.rule, why: sug.rule, auto: true });
        if (r.status === 'done') {
          auto++;
          acted.push(sug.objectId);
          await ctx.db.query(`UPDATE ad_suggestions SET status = 'applied', action_id = $2, decided_at = now() WHERE id = $1`, [sid, r.id]);
        }
      } catch {
        // refused by a limit or by Meta: it stays a suggestion
      }
    }
  }
  // suggestions whose reason is gone
  for (const r of await ctx.db.query(`SELECT id, rule_key, object_id FROM ad_suggestions WHERE status = 'open'`))
    if (!seen.has(`${r.rule_key}:${r.object_id}`)) await ctx.db.query(`UPDATE ad_suggestions SET status = 'expired', decided_at = now() WHERE id = $1`, [r.id]);

  // the daily cap: today's spend against the owner's limit
  let capped = 0;
  if (s.rules.cap !== 'off' && s.guard.maxDailyUsd !== null) {
    const spent = (await insights(ctx.db, stats.map((x) => x.id), today, today)).reduce((x, r) => x + r.spendCents / 100, 0);
    if (spent >= s.guard.maxDailyUsd && s.rules.cap === 'auto')
      for (const st of stats) {
        try {
          await act(sys, { objectId: st.id, op: 'pause', source: 'rule', rule: 'cap', why: 'cap', auto: true });
          capped++;
        } catch {
          // left as it is
        }
      }
  }
  // the next morning: what the cap paused yesterday starts again
  if (s.rules.cap === 'auto' && !s.guard.stopped) {
    const rows = await ctx.db.query(`SELECT DISTINCT ON (object_id) object_id, rule_key, op, status, created_at FROM ad_actions WHERE status IN ('done','undone') ORDER BY object_id, id DESC`);
    for (const r of rows.filter((x: any) => x.rule_key === 'cap' && x.op === 'pause' && x.status === 'done' && algDay(new Date(x.created_at).getTime()) < today))
      try {
        await act(sys, { objectId: String(r.object_id), op: 'resume', source: 'rule', rule: 'cap', why: 'cap-morning', auto: true });
      } catch {
        // left paused
      }
  }
  await savePilot(ctx, { ...(await pilotSettings(ctx.db)), lastRun: stamp(ctx), auto: { day: today, n: auto } });
  // the audiences, once a day
  if (!s.audiencesAt || ctx.now() - Date.parse(s.audiencesAt) > 20 * 3_600_000) await syncAudiences(ctx).catch(() => null);
  return { checked: stats.length, open: num((await ctx.db.query(`SELECT count(*) AS n FROM ad_suggestions WHERE status = 'open'`))[0]?.n), acted: acted.length, capped };
}

async function pilotState(ctx: Ctx) {
  const s = await pilotSettings(ctx.db);
  const mine = isOwner(ctx) ? null : new Set((await visibleAdsets(ctx)).map((x) => x.id));
  const sugg = (await ctx.db.query(`SELECT * FROM ad_suggestions WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`))
    .filter((r: any) => !mine || mine.has(String(r.object_id)))
    .map((r: any) => ({ id: num(r.id), rule: String(r.rule_key) as RuleKey, objectId: String(r.object_id), objectName: String(r.object_name), op: String(r.op), value: r.value === null ? null : Number(r.value), why: r.why ?? {}, at: new Date(r.created_at).toISOString() }));
  return {
    owner: isOwner(ctx),
    rules: s.rules,
    guard: s.guard,
    lastRun: s.lastRun,
    autoToday: s.auto.day === algDay(ctx.now()) ? s.auto.n : 0,
    autoPerDay: AUTO_PER_DAY,
    suggestions: sugg,
    history: await actionsOf(ctx, 40, `WHERE a.source IN ('rule','pilot')`),
  };
}

// ---------------------------------------------------------------- where the orders come from
async function where(ctx: Ctx, from: string, to: string) {
  const sets = await visibleAdsets(ctx);
  const ids = sets.map((s) => s.id);
  if (!ids.length) return { wilayas: [], hours: [], goals: [] };
  const orders = await ctx.db.query(
    `SELECT o.wilaya_id, o.created_at, o.conf_status, o.follow_status, COALESCE(s.goal, 'sales') AS goal
     FROM sales o
     LEFT JOIN adsets s ON s.id = COALESCE(o.utm->>'adset_id', o.adset_id, (SELECT a.adset_id FROM ads a WHERE a.id = o.utm->>'ad_id'))
     WHERE o.created_at >= $2 AND o.created_at < $3 AND o.conf_status <> 'duplicate'
       AND COALESCE(o.utm->>'adset_id', o.adset_id, (SELECT a.adset_id FROM ads a WHERE a.id = o.utm->>'ad_id')) = ANY($1)`,
    [ids, dayStart(from), dayStart(addDays(to, 1))],
  );
  const no = (o: any) => ['cancelled', 'fake', 'wrong_number'].includes(o.conf_status) || o.follow_status === 'cancelled';
  const del = (o: any) => o.follow_status === 'delivered' || o.follow_status === 'exchanged';
  const ret = (o: any) => o.follow_status === 'returned' || o.follow_status === 'lost';
  const W = new Map<number, { orders: number; confirmed: number; delivered: number; returned: number }>();
  const H = Array.from({ length: 24 }, () => ({ orders: 0, confirmed: 0 }));
  const G = new Map<string, { orders: number; delivered: number }>();
  for (const o of orders) {
    const w = num(o.wilaya_id);
    const x = W.get(w) ?? { orders: 0, confirmed: 0, delivered: 0, returned: 0 };
    x.orders++;
    if (!no(o)) x.confirmed++;
    if (del(o)) x.delivered++;
    if (ret(o)) x.returned++;
    W.set(w, x);
    const h = new Date(new Date(o.created_at).getTime() + 3_600_000).getUTCHours();
    H[h].orders++;
    if (!no(o)) H[h].confirmed++;
    const g = G.get(String(o.goal)) ?? { orders: 0, delivered: 0 };
    g.orders++;
    if (del(o)) g.delivered++;
    G.set(String(o.goal), g);
  }
  // spend per goal (dollars) over the same days
  const days = await insights(ctx.db, ids, from, to);
  const goalOf = new Map((await ctx.db.query(`SELECT id, COALESCE(goal, 'sales') AS goal FROM adsets WHERE id = ANY($1)`, [ids])).map((r: any) => [String(r.id), String(r.goal)]));
  const spendGoal = new Map<string, number>();
  for (const d of days) spendGoal.set(goalOf.get(d.adsetId) ?? 'sales', (spendGoal.get(goalOf.get(d.adsetId) ?? 'sales') ?? 0) + d.spendCents / 100);
  const goals = [...new Set([...G.keys(), ...spendGoal.keys()])].map((g) => ({ goal: g, spendUsd: Math.round((spendGoal.get(g) ?? 0) * 100) / 100, orders: G.get(g)?.orders ?? 0, delivered: G.get(g)?.delivered ?? 0 }));
  return {
    wilayas: [...W.entries()].map(([wilayaId, x]) => ({ wilayaId, ...x, rate: x.delivered + x.returned ? Math.round((x.delivered / (x.delivered + x.returned)) * 100) : null })).sort((a, b) => b.orders - a.orders),
    hours: H.map((x, h) => ({ h, ...x })),
    goals: goals.sort((a, b) => b.spendUsd - a.spendUsd),
  };
}

/** Each wilaya's share of delivered parcels (90 days, all the shop's orders): what the launcher keeps or leaves out. */
export async function wilayaRates(db: Db, now: number): Promise<Map<number, { settled: number; delivered: number }>> {
  const rows = await db.query(
    `SELECT wilaya_id, count(*) FILTER (WHERE follow_status IN ('delivered','exchanged')) AS d, count(*) FILTER (WHERE follow_status IN ('delivered','exchanged','returned','lost')) AS s
     FROM sales WHERE created_at >= $1 GROUP BY wilaya_id`,
    [new Date(now - 90 * 86_400_000).toISOString()],
  );
  return new Map(rows.map((r: any) => [num(r.wilaya_id), { settled: num(r.s), delivered: num(r.d) }]));
}

// ---------------------------------------------------------------- audiences
/** the audiences made of the shop's own customers (their phones, hashed): the others are a lookalike, or Meta's own lists */
type ListKind = Exclude<AudienceKind, 'lookalike' | EventAudienceKind>;
const AUDIENCE_SQL: Record<ListKind, string> = {
  returners: `follow_status IN ('returned','lost')`,
  fake: `conf_status IN ('fake','wrong_number')`,
  buyers: `follow_status IN ('delivered','exchanged')`,
};
const AUDIENCE_NAME: Record<AudienceKind, string> = {
  returners: 'Pilotix · retours',
  fake: 'Pilotix · faux numéros',
  fakeorder: 'Pilotix · fausses commandes (navigateurs)',
  competitor: 'Pilotix · concurrents (navigateurs)',
  buyers: 'Pilotix · clients livrés',
  lookalike: 'Pilotix · comme mes clients livrés',
};
/** the pixels each event audience was last made on (its rule is sent again when the shop's pixels change) */
const EVENT_PIXELS_KEY = 'pilot_ads_event_pixels';

/**
 * The shop's Meta pixels (Réglages › Pixels, the pixel of the pages, a page's own): the landing pages send « FakeOrder »
 * and « Competitor » to them (modules/pixels.ts pixelsOf), so the two lists are read from all of them: 10 at most, the
 * main one first (the one a page uses when it names none).
 */
async function eventPixels(db: Db): Promise<string[]> {
  const named = await db.query(`SELECT pixel_id, is_default FROM tracking_pixels WHERE platform = 'meta' ORDER BY is_default DESC, id`).catch(() => []);
  const pages = await db.query(`SELECT DISTINCT pixel_id FROM landing_pages WHERE COALESCE(pixel_id, '') <> '' ORDER BY 1`).catch(() => []);
  const pages0 = String((await getSetting(db, 'landing')).pixelId ?? '').trim();
  const ids = [...named.filter((r: any) => r.is_default), { pixel_id: pages0 }, ...named.filter((r: any) => !r.is_default), ...pages].map((r: any) => String(r.pixel_id ?? '').trim());
  return [...new Set(ids)].filter((p) => /^\d{5,20}$/.test(p)).slice(0, 10);
}

/** the shop's ads are linked to Meta (an ad account and its key): without them no list can be made there */
const metaLinked = async (db: Db) => !!(await getSetting(db, 'meta')).adAccountId && !!(await getRaw<string>(db, META_TOKEN_KEY, ''));

/** the lists of phones: Pilotix's own orders of the last year, and the numbers the owner added himself in the last year */
const LIST_KINDS = ['returners', 'fake', 'buyers'] as const satisfies readonly ListKind[];
const LIST_DAYS = 365;
async function phonesOf(db: Db, kind: ListKind, now: number): Promise<string[]> {
  const since = new Date(now - LIST_DAYS * 86_400_000).toISOString();
  const rows = await db.query(`SELECT DISTINCT phone FROM sales WHERE ${AUDIENCE_SQL[kind]} AND created_at >= $1`, [since]);
  const added = await db.query(`SELECT phone FROM ad_audience_phones WHERE kind = $1 AND added_at >= $2`, [kind, since]);
  // Landing pages › Réglages › « Team et fournisseurs »: the suppliers join the numbers the ads leave out (« faux
  // numéros »), and the team's numbers are in no list at all — never left out of the ads (they still see them, to test)
  const sw = await listSwitches(db);
  const suppliers = kind === 'fake' && sw.suppliers ? [...(await listPhones(db, 'supplier', sw))].map((p) => metaPhone(p)) : [];
  const team = new Set(sw.team ? [...(await listPhones(db, 'team', sw))].map((p) => metaPhone(p)) : []);
  return [...new Set([...rows.map((r: any) => metaPhone(r.phone)), ...added.map((r: any) => String(r.phone)), ...suppliers].filter((p): p is string => !!p && !team.has(p)))];
}
/** how many numbers the owner added to each list himself and that still count */
async function addedCounts(db: Db, now: number): Promise<Record<string, number>> {
  const rows = await db.query(`SELECT kind, count(*) AS n FROM ad_audience_phones WHERE added_at >= $1 GROUP BY kind`, [new Date(now - LIST_DAYS * 86_400_000).toISOString()]);
  return Object.fromEntries(rows.map((r: any) => [String(r.kind), num(r.n)]));
}
/** every Algerian mobile number found in a text (a pasted column, a CSV file): one per number, as Meta takes them */
export function phonesIn(text: string): string[] {
  const found = text.match(/(?:\+|00)?213[\s.-]?[5-7](?:[\s.-]?\d){8}|0[5-7](?:[\s.-]?\d){8}/g) ?? [];
  return [...new Set(found.map((x) => metaPhone(x.replace(/[\s.-]/g, ''))).filter((p): p is string => !!p))];
}

/**
 * No customer goes to Meta before the owner turns an audience on (its row exists): the shop's customers are its own,
 * and uploading them is the owner's choice. « recommended »: what Pilotix advises (leave out returners and fake orders).
 * The two lists Meta fills from the pages' events (« events »: fake orders, competitors) upload nothing: they are on
 * unless the owner turned them off, and wait to be made (« waiting ») until the first update or launch.
 */
async function audienceRows(db: Db) {
  const rows = new Map((await db.query(`SELECT * FROM ad_audiences`)).map((r: any) => [String(r.kind), r]));
  return AUDIENCE_KINDS.map((kind) => {
    const r: any = rows.get(kind);
    const events = isEventAudience(kind);
    return {
      kind,
      events,
      on: r ? !!r.is_on : events,
      recommended: AUDIENCE_DEFAULT_ON[kind],
      metaId: r?.meta_id ?? null,
      size: r ? num(r.size) : 0,
      // an event list switched back on, or left without its Meta list (a new ad account): to be made again
      status: r ? (events && r.is_on && String(r.status) === 'off' ? 'waiting' : String(r.status)) : events ? 'waiting' : 'off',
      error: r?.error ?? null,
      syncedAt: r?.synced_at ? new Date(r.synced_at).toISOString() : null,
    };
  });
}

/**
 * The audiences sent to Meta again (the server each night; the demo only counts): only those the owner turned on, and
 * only this shop's own customers, hashed on the server (meta.ts). The lookalike needs 100 delivered customers. The two
 * event lists are only made (once, in the ad account new ads start from) and kept on the shop's pixels: Meta fills them.
 * `only`: these kinds alone (before a launch), the daily update still to come.
 */
export async function syncAudiences(ctx: Ctx, only?: readonly AudienceKind[]) {
  // one at a time (the daily update, the owner's button, a launch): a list is never made twice at Meta
  return withActionLock(ctx.db, 'ads:audiences', me(ctx), 'Les audiences sont déjà en cours de mise à jour : réessayez dans un instant.', () => syncAudiencesNow(ctx, only));
}
async function syncAudiencesNow(ctx: Ctx, only?: readonly AudienceKind[]) {
  const list = (await audienceRows(ctx.db)).filter((a) => !only || only.includes(a.kind));
  const out: { kind: string; size: number; status: string }[] = [];
  let buyersId: string | null = list.find((x) => x.kind === 'buyers')?.metaId ?? null;
  const lookalikeOn = !!list.find((x) => x.kind === 'lookalike')?.on;
  for (const a of list) {
    // the delivered customers go to Meta for the lookalike only when it is on (its seed), never on their own
    if (!a.on && !(a.kind === 'buyers' && lookalikeOn)) continue;
    let size = a.size;
    let metaId = a.metaId;
    let status = 'ready';
    let error: string | null = null;
    try {
      if (isEventAudience(a.kind)) {
        // Meta's own list: nothing uploaded. Made once, checked each day (deleted at Meta: made again), its rule sent
        // again when the shop's pixels changed. A shop without a Meta pixel has nothing to read it from (« nopixel »);
        // one whose ads are not linked to Meta has nowhere to make it (« nometa »): neither is an error.
        const pixels = await eventPixels(ctx.db);
        size = 0;
        if (!pixels.length) status = 'nopixel';
        else if (ctx.server && !(await metaLinked(ctx.db))) status = 'nometa';
        else if (ctx.server) {
          const used = await getRaw<Record<string, string>>(ctx.db, EVENT_PIXELS_KEY, {});
          const r = (await ctx.server.meta(
            'eventAudience',
            { name: AUDIENCE_NAME[a.kind], event: EVENT_AUDIENCES[a.kind], pixels, days: EVENT_AUDIENCE_DAYS, metaId, refresh: !!metaId && (used[a.kind] ?? '') !== pixels.join(',') },
            ctx,
          )) as { id: string; partial?: boolean };
          metaId = r.id;
          // a pixel this ad account cannot read: the list follows the others, and the card says so
          if (r.partial) error = 'Meta n’a pas accepté tous les pixels de la boutique pour cette liste : elle suit seulement ceux qu’il a pris.';
          await setRaw(ctx.db, EVENT_PIXELS_KEY, { ...(await getRaw<Record<string, string>>(ctx.db, EVENT_PIXELS_KEY, {})), [a.kind]: pixels.join(',') });
        }
      } else if (a.kind === 'lookalike') {
        const seed = await phonesOf(ctx.db, 'buyers', ctx.now());
        size = seed.length;
        if (seed.length < 100) {
          status = 'small';
        } else if (ctx.server && !metaId && buyersId) metaId = String(((await ctx.server.meta('lookalike', { seedId: buyersId, ratio: 0.01 }, ctx)) as { id: string }).id);
      } else {
        const phones = await phonesOf(ctx.db, a.kind, ctx.now());
        size = phones.length;
        if (ctx.server && phones.length) {
          const r = (await ctx.server.meta('audience', { name: AUDIENCE_NAME[a.kind], metaId, phones }, ctx)) as { id: string; busy?: boolean };
          metaId = r.id;
          if (a.kind === 'buyers') buyersId = r.id;
          // nothing was sent tonight: said on the card, so a list Meta never finishes is seen
          if (r.busy) error = 'Meta n’a pas fini la dernière mise à jour de cette liste : Pilotix la renvoie à la prochaine mise à jour.';
        }
      }
    } catch (e: any) {
      // a list Meta already has stays in use when tonight's sending fails (the card says why): the next ad sets still
      // leave these people out. One never made is an error.
      status = metaId ? 'ready' : 'failed';
      error = String(e?.message ?? e).slice(0, 300);
    }
    await ctx.db.query(
      `INSERT INTO ad_audiences (kind, is_on, meta_id, size, status, error, synced_at) VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (kind) DO UPDATE SET meta_id = EXCLUDED.meta_id, size = EXCLUDED.size, status = EXCLUDED.status, error = EXCLUDED.error, synced_at = now()`,
      [a.kind, a.on, metaId, size, status, error],
    );
    out.push({ kind: a.kind, size, status });
  }
  if (!only) await setRaw(ctx.db, KEY, { ...(await getRaw(ctx.db, KEY, {})), audiencesAt: stamp(ctx) });
  return out;
}

/**
 * Before a launch (server): the two lists Meta fills from the pages' events are made if they are not yet (a shop's
 * first launch, a new ad account), so the new ad sets already leave them out. It never stops a launch: a list Meta
 * refuses is marked « Erreur » in Audiences, and the launch goes without it.
 */
export async function ensureEventAudiences(ctx: Ctx): Promise<void> {
  if (!ctx.server) return;
  const missing = (await audienceRows(ctx.db)).filter((a) => a.events && a.on && !(a.metaId && a.status === 'ready'));
  if (missing.length) await syncAudiences(ctx, missing.map((a) => a.kind)).catch(() => null);
}

/** the audiences a launch uses: Meta ids of those on (exclusions) and the lookalike (inclusion) */
export async function audienceIds(db: Db): Promise<{ exclude: string[]; include: string[]; list: Awaited<ReturnType<typeof audienceRows>> }> {
  const list = await audienceRows(db);
  return {
    exclude: list.filter((a) => a.on && a.kind !== 'lookalike' && a.metaId && a.status === 'ready').map((a) => a.metaId!),
    include: list.filter((a) => a.on && a.kind === 'lookalike' && a.metaId && a.status === 'ready').map((a) => a.metaId!),
    list,
  };
}

// ---------------------------------------------------------------- the lists on ad sets made by hand
/**
 * « Pubs faites à la main » (Audiences): an ad set made in Meta's Ads Manager does not leave the Pilotix lists out by
 * itself, and Meta has no setting that does it for a whole ad account (its « protect its brand » takes no list). So
 * every Pilote auto run (15 min, and « Vérifier maintenant ») reads the ad sets of the ad account the lists live in:
 * one made less than HAND_FIX_H hours ago that misses a list gets it from Pilotix — it is new, its learning loses
 * nothing. An older one is never touched (a list added to an ad set that runs restarts its learning): it is only listed
 * for the owner. The people inside a list change every night without restarting anything (Meta's « replace »).
 * The lists are those a launch from Pilotix leaves out (audienceIds). Ad sets Pilotix launched with « Utiliser les
 * audiences » unticked are the owner's choice: left alone. On unless the owner turns it off.
 */
const HAND_KEY = 'pilot_ads_hand';
export const HAND_FIX_H = 24;
/** Meta's refusal is tried again on the next runs, this many times in all, then the ad set is listed with it */
export const HAND_TRIES = 3;
export interface HandFixed {
  id: string;
  name: string;
  campaign: string;
  added: number;
  at: string;
}
export interface HandMissing {
  id: string;
  name: string;
  campaign: string;
  status: string | null;
  created: string | null;
  /** how many of the lists it does not leave out */
  lacks: number;
  /** Meta's last refusal, when Pilotix tried */
  error: string | null;
}
export interface HandState {
  on: boolean;
  checkedAt: string | null;
  /** the last run could not finish (Meta out of reach, the key over…): said as it is */
  error: string | null;
  /** how many lists an ad set should leave out now */
  lists: number;
  /** the ad sets Pilotix gave the lists to, newest first */
  fixed: HandFixed[];
  /** the older ad sets without every list, running first */
  missing: HandMissing[];
  /** ad set → Meta's refusals so far (young ones only) */
  tries: Record<string, { n: number; error: string }>;
}
export async function handState(db: Db): Promise<HandState> {
  const s = await getRaw<Partial<HandState>>(db, HAND_KEY, {});
  return { on: s.on ?? true, checkedAt: s.checkedAt ?? null, error: s.error ?? null, lists: s.lists ?? 0, fixed: s.fixed ?? [], missing: s.missing ?? [], tries: s.tries ?? {} };
}
/** the ad sets Pilotix launched with « Utiliser les audiences » unticked */
async function launchedWithoutLists(db: Db): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of await db.query(`SELECT adset_ids, meta_ids FROM ad_launches WHERE spec->>'useAudiences' = 'false'`)) {
    for (const id of (r as any).adset_ids ?? []) out.add(String(id));
    for (const [k, v] of Object.entries((r as any).meta_ids ?? {})) if (k.startsWith('adset:')) out.add(String(v));
  }
  return out;
}
interface MetaHandAdset {
  id: string;
  name: string;
  campaign: string;
  status: string | null;
  created: string | null;
  excluded: string[];
  included: string[];
}
/** Meta's answer says « later », not « no »: out of reach, too many requests, the key over */
const metaLater = (e: any) => e?.code === 'conflict' || /injoignable|jeton Meta/i.test(String(e?.message ?? ''));

/** One check (server): the young ad sets get the lists, the older ones without them are listed. The demo shows its own. */
export async function handRun(ctx: Ctx): Promise<HandState> {
  if (!ctx.server) return handState(ctx.db);
  return withActionLock(ctx.db, 'ads:hand', me(ctx), 'Pilotix vérifie déjà les pubs faites à la main : réessayez dans un instant.', () => handRunNow(ctx));
}
async function handRunNow(ctx: Ctx): Promise<HandState> {
  const s = await handState(ctx.db);
  // ads not linked to Meta: no ad set to read (not an error)
  if (!s.on || !ctx.server || !(await metaLinked(ctx.db))) return s;
  const save = async (next: HandState) => {
    await setRaw(ctx.db, HAND_KEY, next);
    return next;
  };
  const exclude = (await audienceIds(ctx.db)).exclude;
  if (!exclude.length) return save({ ...s, checkedAt: stamp(ctx), error: null, lists: 0, missing: [], tries: {} });
  let adsets: MetaHandAdset[];
  try {
    adsets = ((await ctx.server.meta('handAdsets', {}, ctx)) as { adsets: MetaHandAdset[] }).adsets ?? [];
  } catch (e: any) {
    // nothing read: what was found last time stays on the page
    return save({ ...s, checkedAt: stamp(ctx), error: String(e?.message ?? e).slice(0, 300) });
  }
  const skip = await launchedWithoutLists(ctx.db);
  const now = ctx.now();
  const fixed = [...s.fixed];
  const tries: HandState['tries'] = {};
  const missing: HandMissing[] = [];
  let later: string | null = null;
  for (const a of adsets) {
    if (skip.has(a.id)) continue;
    const lacks = exclude.filter((id) => !a.excluded.includes(id) && !a.included.includes(id));
    if (!lacks.length) continue;
    const born = a.created ? Date.parse(a.created) : NaN;
    const young = Number.isFinite(born) && now - born <= HAND_FIX_H * 3_600_000;
    let t = s.tries[a.id];
    if (young && (t?.n ?? 0) < HAND_TRIES) {
      // Meta said « later » for one: the others wait for the next run too
      if (!later)
        try {
          const r = (await ctx.server.meta('handAdd', { id: a.id, audiences: lacks }, ctx)) as { added: number };
          // 0: it had them by now (put in the Ads Manager meanwhile)
          if (Number(r?.added) > 0) fixed.unshift({ id: a.id, name: a.name, campaign: a.campaign, added: Number(r.added), at: stamp(ctx) });
          continue;
        } catch (e: any) {
          const why = String(e?.message ?? e).slice(0, 300);
          if (metaLater(e)) later = why;
          else t = { n: (t?.n ?? 0) + 1, error: why };
        }
      if (t) tries[a.id] = t;
      // tries left: the next run tries again, it is not « without the lists » yet
      if ((t?.n ?? 0) < HAND_TRIES) continue;
    } else if (t) tries[a.id] = t; // its last refusal stays said
    missing.push({ id: a.id, name: a.name, campaign: a.campaign, status: a.status, created: a.created, lacks: lacks.length, error: t?.error ?? null });
  }
  const running = (m: HandMissing) => (m.status === 'ACTIVE' ? 0 : 1);
  missing.sort((x, y) => running(x) - running(y) || String(y.created ?? '').localeCompare(String(x.created ?? '')));
  return save({ on: true, checkedAt: stamp(ctx), error: later, lists: exclude.length, fixed: fixed.slice(0, 30), missing, tries });
}

/** What the card shows: a marketer sees only his own ad sets (as everywhere in Publicité). */
async function handView(ctx: Ctx) {
  const s = await handState(ctx.db);
  const mine = isOwner(ctx) ? null : new Set((await visibleAdsets(ctx)).map((x) => String(x.id)));
  const keep = <T extends { id: string }>(xs: T[]) => (mine ? xs.filter((x) => mine.has(x.id)) : xs);
  return { owner: isOwner(ctx), demo: !ctx.server, fixH: HAND_FIX_H, on: s.on, checkedAt: s.checkedAt, error: s.error, lists: s.lists, fixed: keep(s.fixed), missing: keep(s.missing) };
}

// ---------------------------------------------------------------- the URL parameters on ads made by hand
/**
 * « Paramètres d’URL » (Landing pages › Réglages): an ad launched from Pilotix carries them from the start; an ad made
 * in Meta's Ads Manager has only what the owner pasted. Without the ids, its orders do not know their ad and Pilot
 * Checks cannot judge it. So every Pilote auto run (15 min, and « Vérifier maintenant ») reads the shop's ads: a new
 * one (its first TAG_FIX_H hours) that sends people to a website without the ids gets them from Pilotix — a copy of
 * its créa with the parameters, on the same ad; Meta checks the ad again. An older one is never touched (it runs: a
 * new créa sends it back to Meta's check), and a kind Pilotix does not copy (several texts or formats, catalogue…) is
 * not either: both are only listed, with the line to paste. On unless the owner turns it off.
 */
const TAG_KEY = 'pilot_ads_tags';
export const TAG_FIX_H = 24;
/** Meta's refusal is tried again on the next runs, this many times in all, then the ad is listed with it */
export const TAG_TRIES = 3;
/** why an ad is listed: too old to touch, a kind Pilotix does not copy, Meta kept the post's créa, or Meta said no */
export type TagWhy = 'old' | Exclude<TagKind, 'spec'> | 'refused';
export interface TagFixed {
  id: string;
  name: string;
  campaign: string;
  adsetId: string;
  at: string;
}
export interface TagMissing {
  id: string;
  name: string;
  campaign: string;
  adsetId: string;
  status: string | null;
  created: string | null;
  why: TagWhy;
  /** Meta's last refusal, when Pilotix tried */
  error: string | null;
}
export interface TagState {
  on: boolean;
  checkedAt: string | null;
  /** the last run could not finish (Meta out of reach, the key over…): said as it is */
  error: string | null;
  /** the ads Pilotix gave the parameters to, newest first */
  fixed: TagFixed[];
  /** the ads still without them, running first */
  missing: TagMissing[];
  /** ad → Meta's refusals so far, or why Pilotix stopped trying (young ones only) */
  tries: Record<string, { n: number; error: string; why?: TagWhy }>;
}
export async function tagState(db: Db): Promise<TagState> {
  const s = await getRaw<Partial<TagState>>(db, TAG_KEY, {});
  return { on: s.on ?? true, checkedAt: s.checkedAt ?? null, error: s.error ?? null, fixed: s.fixed ?? [], missing: s.missing ?? [], tries: s.tries ?? {} };
}
interface MetaTagAd {
  id: string;
  name: string;
  campaign: string;
  adsetId: string;
  status: string | null;
  created: string | null;
  needs: boolean;
  kind: TagKind;
}

/** One check (server): the young ads get the parameters, the others without them are listed. The demo shows its own. */
export async function tagRun(ctx: Ctx): Promise<TagState> {
  if (!ctx.server) return tagState(ctx.db);
  return withActionLock(ctx.db, 'ads:tags', me(ctx), 'Pilotix vérifie déjà les paramètres d’URL des pubs : réessayez dans un instant.', () => tagRunNow(ctx));
}
async function tagRunNow(ctx: Ctx): Promise<TagState> {
  const s = await tagState(ctx.db);
  // ads not linked to Meta: no ad to read (not an error)
  if (!s.on || !ctx.server || !(await metaLinked(ctx.db))) return s;
  const save = async (next: TagState) => {
    await setRaw(ctx.db, TAG_KEY, next);
    return next;
  };
  let ads: MetaTagAd[];
  try {
    ads = ((await ctx.server.meta('tagAds', {}, ctx)) as { ads: MetaTagAd[] }).ads ?? [];
  } catch (e: any) {
    // nothing read: what was found last time stays on the page
    return save({ ...s, checkedAt: stamp(ctx), error: String(e?.message ?? e).slice(0, 300) });
  }
  const now = ctx.now();
  const fixed = [...s.fixed];
  const tries: TagState['tries'] = {};
  const missing: TagMissing[] = [];
  let later: string | null = null;
  for (const a of ads) {
    if (!a.needs) continue;
    const born = a.created ? Date.parse(a.created) : NaN;
    const young = Number.isFinite(born) && now - born <= TAG_FIX_H * 3_600_000;
    const copyable = a.kind === 'spec' || a.kind === 'post';
    let t = s.tries[a.id];
    let why: TagWhy = young ? (copyable ? 'refused' : (a.kind as TagWhy)) : 'old';
    if (young && copyable && !t?.why && (t?.n ?? 0) < TAG_TRIES) {
      // Meta said « later » for one: the others wait for the next run too
      if (!later)
        try {
          const r = (await ctx.server.meta('tagAd', { id: a.id }, ctx)) as { done: boolean; why?: string };
          if (r?.done) {
            fixed.unshift({ id: a.id, name: a.name, campaign: a.campaign, adsetId: a.adsetId, at: stamp(ctx) });
            continue;
          }
          // it has them by now (pasted in the Ads Manager meanwhile)
          if (r?.why === 'tagged') continue;
          // a kind Pilotix does not copy, or Meta kept the post's créa: not tried again
          t = { n: TAG_TRIES, error: '', why: (r?.why as TagWhy) || 'other' };
        } catch (e: any) {
          const msg = String(e?.message ?? e).slice(0, 300);
          if (metaLater(e)) later = msg;
          else t = { n: (t?.n ?? 0) + 1, error: msg };
        }
      if (t) tries[a.id] = t;
      // tries left: the next run tries again, it is not « without the parameters » yet
      if (!t?.why && (t?.n ?? 0) < TAG_TRIES) continue;
    } else if (t && young) tries[a.id] = t; // its last refusal stays said while it is young
    if (young && t?.why) why = t.why;
    missing.push({ id: a.id, name: a.name, campaign: a.campaign, adsetId: a.adsetId, status: a.status, created: a.created, why, error: why === 'refused' ? t?.error || null : null });
  }
  const running = (m: TagMissing) => (m.status === 'ACTIVE' ? 0 : 1);
  missing.sort((x, y) => running(x) - running(y) || String(y.created ?? '').localeCompare(String(x.created ?? '')));
  return save({ on: true, checkedAt: stamp(ctx), error: later, fixed: fixed.slice(0, 30), missing, tries });
}

/** What the card shows: a marketer sees only the ads of his own ad sets (as everywhere in Publicité). */
async function tagView(ctx: Ctx) {
  const s = await tagState(ctx.db);
  const mine = isOwner(ctx) ? null : new Set((await visibleAdsets(ctx)).map((x) => String(x.id)));
  const keep = <T extends { adsetId: string }>(xs: T[]) => (mine ? xs.filter((x) => mine.has(x.adsetId)) : xs);
  return { owner: isOwner(ctx), demo: !ctx.server, fixH: TAG_FIX_H, on: s.on, checkedAt: s.checkedAt, error: s.error, fixed: keep(s.fixed), missing: keep(s.missing) };
}

// ---------------------------------------------------------------- procs
const Obj = z.string().regex(/^\d{6,25}$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GuardInput = z.object({
  maxDailyUsd: z.number().min(1).max(100_000).nullable(),
  maxRaisePct: z.number().int().min(5).max(200),
  yesAboveUsd: z.number().min(1).max(100_000).nullable(),
  launchYes: z.boolean(),
});

export const adsMgrProcs = {
  'ads.ctl.state': proc(['marketer'], z.object({}), (ctx) => controlState(ctx)),
  /** pause, start again, a new daily budget (dollars), or a paused copy */
  'ads.ctl.act': proc(['marketer'], z.object({ objectId: Obj, op: z.enum(['pause', 'resume', 'budget', 'copy']), usd: z.number().min(1).max(100_000).nullable().optional(), clientId: z.string().max(64).nullable().optional() }), (ctx, i) =>
    act(ctx, { objectId: i.objectId, op: i.op, usd: i.usd ?? null, clientId: i.clientId ?? null }),
  ),
  'ads.ctl.actions': proc(['marketer'], z.object({ limit: z.number().int().min(1).max(200).default(60) }), (ctx, i) => actionsOf(ctx, i.limit)),
  'ads.ctl.undo': proc(['marketer'], z.object({ id: z.number().int().positive() }), (ctx, i) => undo(ctx, i.id)),
  /** the owner says yes (the change is made) or no (refused) to a marketer's change */
  'ads.ctl.approve': proc(['vendeur'], z.object({ id: z.number().int().positive(), yes: z.boolean() }), async (ctx, i) => {
    const a = (await ctx.db.query(`SELECT * FROM ad_actions WHERE id = $1`, [i.id]))[0];
    if (!a || a.status !== 'waiting_yes') throw bad('Ce changement n’attend plus de réponse.');
    if (!i.yes) {
      await ctx.db.query(`UPDATE ad_actions SET status = 'refused', approved_by = $2, done_at = now() WHERE id = $1`, [i.id, me(ctx)]);
      return { id: i.id, status: 'refused' };
    }
    if ((await pilotSettings(ctx.db)).guard.stopped && a.op !== 'pause') throw bad('Tout est arrêté : relancez d’abord (« Tout relancer »).');
    const t = await targetOf(ctx, String(a.object_id));
    await ctx.db.query(`UPDATE ad_actions SET approved_by = $2 WHERE id = $1`, [i.id, me(ctx)]);
    return run(ctx, i.id, t, a.op as Op, a.after?.budgetCents ?? null);
  }),
  'ads.ctl.guard': proc(['vendeur'], GuardInput, async (ctx, i) => {
    const s = await pilotSettings(ctx.db);
    await savePilot(ctx, { ...s, guard: { ...s.guard, ...i } });
    return { guard: (await pilotSettings(ctx.db)).guard };
  }),
  /** « Tout arrêter »: every running ad set paused, nothing starts again until « Tout relancer » */
  'ads.ctl.stopAll': proc(['vendeur'], z.object({ on: z.boolean() }), (ctx, i) => stopAll(ctx, i.on)),

  'ads.pilot.state': proc(['marketer'], z.object({}), (ctx) => pilotState(ctx)),
  'ads.pilot.save': proc(['vendeur'], z.object({ rules: z.record(z.enum(RULE_KEYS), z.enum(['off', 'suggest', 'auto'])) }), async (ctx, i) => {
    const s = await pilotSettings(ctx.db);
    const rules = { ...s.rules };
    for (const [k, m] of Object.entries(i.rules) as [RuleKey, RuleMode][]) rules[k] = m === 'auto' && !AUTO_RULES.includes(k) ? 'suggest' : m;
    await savePilot(ctx, { ...s, rules });
    return { rules };
  }),
  /** a suggestion applied (the change is made, as a person's) or set aside */
  'ads.pilot.decide': proc(['marketer'], z.object({ id: z.number().int().positive(), apply: z.boolean() }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT * FROM ad_suggestions WHERE id = $1`, [i.id]))[0];
    if (!r || r.status !== 'open') throw bad('Cette suggestion n’est plus ouverte.');
    if (!i.apply) {
      await ctx.db.query(`UPDATE ad_suggestions SET status = 'ignored', decided_at = now(), decided_by = $2 WHERE id = $1`, [i.id, me(ctx)]);
      return { status: 'ignored', action: null };
    }
    if (r.op !== 'pause' && r.op !== 'budget' && r.op !== 'copy') throw bad('Cette suggestion se fait à la main (nouvelle vidéo, vérifier les commandes).');
    const a = await act(ctx, { objectId: String(r.object_id), op: r.op as Op, usd: r.value === null ? null : Number(r.value), source: 'pilot', rule: r.rule_key, why: r.rule_key });
    await ctx.db.query(`UPDATE ad_suggestions SET status = 'applied', action_id = $2, decided_at = now(), decided_by = $3 WHERE id = $1`, [i.id, a.id, me(ctx)]);
    return { status: 'applied', action: a };
  }),
  'ads.pilot.run': proc([], z.object({}), (ctx) => pilotRun(ctx)),
  /** « Vérifier maintenant » */
  'ads.pilot.check': proc(['vendeur'], z.object({}), (ctx) => pilotRun(ctx)),

  'ads.report.where': proc(['marketer'], z.object({ from: Day, to: Day }), (ctx, i) => {
    if (i.to < i.from) throw bad('La date de fin est avant la date de début');
    return where(ctx, i.from, i.to);
  }),

  'ads.aud.list': proc(['marketer'], z.object({}), async (ctx) => ({ owner: isOwner(ctx), demo: !ctx.server, list: await audienceRows(ctx.db), added_by_kind: await addedCounts(ctx.db, ctx.now()), syncedAt: (await pilotSettings(ctx.db)).audiencesAt })),
  'ads.aud.save': proc(['vendeur'], z.object({ kind: z.enum(AUDIENCE_KINDS), on: z.boolean() }), async (ctx, i) => {
    await ctx.db.query(`INSERT INTO ad_audiences (kind, is_on) VALUES ($1,$2) ON CONFLICT (kind) DO UPDATE SET is_on = EXCLUDED.is_on`, [i.kind, i.on]);
    return { list: await audienceRows(ctx.db) };
  }),
  /**
   * The owner adds phone numbers to a list himself (pasted, or a file read in the browser): a start for a shop whose
   * past orders are elsewhere. Only Algerian mobile numbers are kept, each once; nothing goes to Meta here (the list's
   * switch and the next update do that). `clear`: the numbers he added to that list are taken out again.
   */
  'ads.aud.add': proc(['vendeur'], z.object({ kind: z.enum(LIST_KINDS), text: z.string().max(3_000_000).default(''), clear: z.boolean().default(false) }), async (ctx, i) => {
    if (i.clear) {
      const gone = await ctx.db.query(`DELETE FROM ad_audience_phones WHERE kind = $1 RETURNING phone`, [i.kind]);
      return { found: 0, added: 0, removed: gone.length, list: await audienceRows(ctx.db), added_by_kind: await addedCounts(ctx.db, ctx.now()) };
    }
    const phones = phonesIn(i.text);
    if (!phones.length) throw bad('Aucun numéro algérien trouvé (05, 06 ou 07, 10 chiffres).');
    let added = 0;
    for (let k = 0; k < phones.length; k += 1000) {
      const part = phones.slice(k, k + 1000);
      const r = await ctx.db.query(`INSERT INTO ad_audience_phones (kind, phone, added_at) SELECT $1, x, $3 FROM unnest($2::text[]) AS x ON CONFLICT (kind, phone) DO UPDATE SET added_at = EXCLUDED.added_at RETURNING (xmax = 0) AS fresh`, [i.kind, part, stamp(ctx)]);
      added += r.filter((x: any) => x.fresh).length;
    }
    return { found: phones.length, added, removed: 0, list: await audienceRows(ctx.db), added_by_kind: await addedCounts(ctx.db, ctx.now()) };
  }),
  'ads.aud.sync': proc(['vendeur'], z.object({}), async (ctx) => {
    await syncAudiences(ctx);
    return { list: await audienceRows(ctx.db) };
  }),

  /** « Pubs faites à la main »: the lists Pilotix put on new ad sets made in Meta, and the older ones without them */
  'ads.hand.state': proc(['marketer'], z.object({}), (ctx) => handView(ctx)),
  /** on or off (on by default): off, Pilotix touches no ad set made by hand */
  'ads.hand.save': proc(['vendeur'], z.object({ on: z.boolean() }), async (ctx, i) => {
    await setRaw(ctx.db, HAND_KEY, { ...(await handState(ctx.db)), on: i.on, tries: {} }, me(ctx) || undefined);
    return handView(ctx);
  }),
  /** « Vérifier maintenant »: right after publishing an ad set in Meta, no need to wait for the next run */
  'ads.hand.check': proc(['vendeur'], z.object({}), async (ctx) => {
    await handRun(ctx);
    return handView(ctx);
  }),

  /** « Paramètres d’URL »: the ads Pilotix gave them to, and those still without them */
  'ads.tags.state': proc(['marketer'], z.object({}), (ctx) => tagView(ctx)),
  /** on or off (on by default): off, Pilotix touches no ad made by hand */
  'ads.tags.save': proc(['vendeur'], z.object({ on: z.boolean() }), async (ctx, i) => {
    await setRaw(ctx.db, TAG_KEY, { ...(await tagState(ctx.db)), on: i.on, tries: {} }, me(ctx) || undefined);
    return tagView(ctx);
  }),
  /** « Vérifier maintenant »: right after publishing an ad in Meta, no need to wait for the next run */
  'ads.tags.check': proc(['vendeur'], z.object({}), async (ctx) => {
    await tagRun(ctx);
    return tagView(ctx);
  }),
};
