// Publicité › Demander: the owner asks Pilot AI about the shop's ads in their own words (« quelle pub me coûte le plus
// cher ? », « compare avec la semaine dernière », « mets en pause celle qui ne vend pas »). Pilot AI reads the ads with
// Meta's own tools — the ads MCP server (../metamcp.ts, permission ads_mcp_management) — and answers with the numbers it
// read, in the language of the question.
//
// A change it proposes (a pause, a budget, a new campaign…) is never made at once: it waits for the owner's « Oui,
// faire », then goes to Meta through the same tool, with the owner's limits checked first (« Tout arrêter », the most
// per day, Meta's 4 budget changes an hour) and a line in the log of changes (undone like any other within 7 days).
// Only the owner asks: Meta's tools read the whole ad account, more than a marketer sees in Pilotix.
//
// In the demo (no server) the same tools are played by Pilotix on the demo's own ads (the seeded campaigns, ad sets and
// days); without an AI, ready sentences answer the usual questions with those numbers.
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, notFound, proc, withActionLock } from '../rpc';
import { getSetting } from '../settings';
import { daySpend, fxTable, isOwner } from './ads';
import { pilotSettings, shopDailyUsd } from './adsmgr';
import { aiKeyed, dellalSettings, PILOT_CHEAP_MODEL, pilotOn, type AiResponse } from './dellal';
import { checkChange } from './pilotads';

export const ASK_LANGS = ['fr', 'en', 'ar'] as const;
export type AskLang = (typeof ASK_LANGS)[number];
const MAX_ROUNDS = 8;
const me = (ctx: Ctx) => ctx.session.profile.id || null;
const algDay = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const usd2 = (v: number) => `${(Math.round(v * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[  ]/g, ' ')} $`;

/** A tool as Meta's MCP server describes it (../metamcp.ts McpTool). */
export interface AskTool {
  name: string;
  title?: string | null;
  description: string;
  inputSchema: unknown;
  readOnly: boolean | null;
  destructive: boolean | null;
}
interface ToolResult {
  text: string;
  isError: boolean;
}

// ---------------------------------------------------------------- reading or changing
const READS = new Set([
  'get',
  'list',
  'search',
  'find',
  'read',
  'insights',
  'insight',
  'fetch',
  'describe',
  'lookup',
  'preview',
  'estimate',
  'benchmark',
  'benchmarks',
  'diagnose',
  'diagnostics',
  'help',
  'validate',
  'check',
  'explain',
  'compare',
  'analyze',
  'show',
  'view',
  'query',
  'report',
]);
const WRITES = new Set([
  'create',
  'update',
  'edit',
  'set',
  'pause',
  'resume',
  'activate',
  'deactivate',
  'delete',
  'remove',
  'archive',
  'duplicate',
  'copy',
  'upload',
  'publish',
  'add',
  'change',
  'apply',
  'launch',
  'start',
  'stop',
  'enable',
  'disable',
  'assign',
  'link',
  'unlink',
  'send',
  'submit',
  'boost',
  'save',
  'post',
  'replace',
  'move',
  'rename',
  'scale',
  'increase',
  'decrease',
]);
/**
 * Whether a tool changes something on Meta: what the tool says of itself first (MCP annotations), else the first verb of
 * its name (ads_get_…, ads_insights_… read; ads_update_…, ads_create_… change). A tool that says nothing is a change: it
 * waits for the owner.
 */
export function isWrite(t: Pick<AskTool, 'name' | 'readOnly' | 'destructive'>): boolean {
  if (t.readOnly === true) return false;
  if (t.readOnly === false || t.destructive === true) return true;
  for (const part of t.name.toLowerCase().split(/[_.\-]+/)) {
    if (READS.has(part)) return false;
    if (WRITES.has(part)) return true;
  }
  return true;
}

/** The change a tool's arguments make, when Pilotix knows it: a pause, a start again, a new daily budget (cents). */
export interface ChangeKind {
  op: 'pause' | 'resume' | 'budget' | null;
  objectId: string | null;
  budgetCents: number | null;
}
const flat = (input: any): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...(input ?? {}) };
  for (const k of ['fields', 'updates', 'update', 'params', 'data', 'changes']) if (input?.[k] && typeof input[k] === 'object' && !Array.isArray(input[k])) Object.assign(out, input[k]);
  return out;
};
/** `budgetIn`: how the tool counts a budget (Meta's API: cents; a tool whose schema says dollars: × 100). */
export function changeOf(input: unknown, budgetIn: 'cents' | 'units' = 'cents'): ChangeKind {
  const f = flat(input);
  const idKey = ['entity_id', 'object_id', 'id', 'adset_id', 'ad_set_id', 'campaign_id', 'ad_id'].find((k) => /^\d{6,25}$/.test(String(f[k] ?? '').replace(/^act_/, '')));
  const objectId = idKey ? String(f[idKey]) : null;
  const status = String(f.status ?? f.effective_status ?? f.configured_status ?? '').toUpperCase();
  const rawBudget = f.daily_budget ?? f.dailyBudget ?? f.daily_budget_cents;
  const n = rawBudget === undefined || rawBudget === null || rawBudget === '' ? null : Number(rawBudget);
  const budgetCents = n !== null && isFinite(n) && n > 0 ? Math.round(budgetIn === 'units' ? n * 100 : n) : null;
  const op = budgetCents !== null ? 'budget' : status === 'PAUSED' ? 'pause' : status === 'ACTIVE' ? 'resume' : null;
  return { op, objectId, budgetCents };
}
/** how a tool's schema counts a daily budget (its words: « cents », « minor units »… or « dollars », « major units ») */
function budgetUnitOf(t: AskTool | undefined): 'cents' | 'units' {
  const props = (t?.inputSchema as any)?.properties ?? {};
  const said = JSON.stringify(props.daily_budget ?? props.dailyBudget ?? props.fields ?? props.updates ?? {}).toLowerCase();
  return /dollar|major unit|currency unit|not in cents|in units/.test(said) && !/cent|minor unit|offset/.test(said) ? 'units' : 'cents';
}

// ---------------------------------------------------------------- what Pilotix knows of an object
interface Known {
  level: 'adset' | 'campaign';
  id: string;
  name: string;
  status: string | null;
  budgetCents: number | null;
  currency: string;
}
async function knownOf(db: Db, id: string | null): Promise<Known | null> {
  if (!id) return null;
  const a = (await db.query(`SELECT id, name, status, daily_budget_cents, currency FROM adsets WHERE id = $1`, [id]))[0];
  if (a) return { level: 'adset', id: String(a.id), name: String(a.name), status: a.status ?? null, budgetCents: numOrNull(a.daily_budget_cents), currency: String(a.currency ?? 'USD') };
  const c = (await db.query(`SELECT c.id, c.name, c.status, c.daily_budget_cents, (SELECT currency FROM adsets WHERE campaign_id = c.id LIMIT 1) AS currency FROM ad_campaigns c WHERE c.id = $1`, [id]))[0];
  if (c) return { level: 'campaign', id: String(c.id), name: String(c.name), status: c.status ?? null, budgetCents: numOrNull(c.daily_budget_cents), currency: String(c.currency ?? 'USD') };
  return null;
}
const moneyOf = (cents: number, currency: string) =>
  currency.toUpperCase() === 'DZD'
    ? `${Math.round(cents / 100)
        .toLocaleString('fr-FR')
        .replace(/[  ]/g, ' ')} DA`
    : usd2(cents / 100);

/** The change in plain words, for the owner's « Oui, faire ». */
async function describeChange(db: Db, tool: string, input: unknown, lang: AskLang, budgetIn: 'cents' | 'units'): Promise<{ label: string; kind: ChangeKind }> {
  const kind = changeOf(input, budgetIn);
  const k = await knownOf(db, kind.objectId);
  const name = k ? `« ${k.name} »` : kind.objectId ? `#${kind.objectId}` : '';
  const L = {
    fr: { pause: `Mettre en pause ${name}`, resume: `Relancer ${name}`, budget: (v: string) => `Budget de ${name} : ${v} par jour` },
    en: { pause: `Pause ${name}`, resume: `Turn ${name} back on`, budget: (v: string) => `${name} budget: ${v} a day` },
    ar: { pause: `إيقاف ${name} مؤقتا`, resume: `إعادة تشغيل ${name}`, budget: (v: string) => `ميزانية ${name}: ${v} في اليوم` },
  }[lang];
  if (kind.op === 'pause' && name) return { label: L.pause, kind };
  if (kind.op === 'resume' && name) return { label: L.resume, kind };
  if (kind.op === 'budget' && name && kind.budgetCents) return { label: L.budget(moneyOf(kind.budgetCents, k?.currency ?? 'USD')), kind };
  const args = JSON.stringify(input ?? {});
  return { label: `${tool} ${args.length > 180 ? `${args.slice(0, 179)}…` : args}`, kind };
}

// ---------------------------------------------------------------- the demo's tools (Pilotix plays Meta on its own tables)
export const DEMO_TOOLS: AskTool[] = [
  { name: 'ads_get_ad_accounts', description: 'Lists the ad accounts this person can use, with their currency and status.', inputSchema: { type: 'object', properties: {} }, readOnly: true, destructive: false },
  {
    name: 'ads_get_campaigns',
    description: 'Lists the campaigns of the ad account: id, name, objective, status, daily budget (cents of the account currency, null when the ad sets hold the budget).',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['ACTIVE', 'PAUSED'], description: 'Only the campaigns in this status' } } },
    readOnly: true,
    destructive: false,
  },
  {
    name: 'ads_get_adsets',
    description: 'Lists the ad sets: id, name, campaign_id, status, daily budget (cents of the account currency, null when the campaign holds the budget).',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string', description: 'Only the ad sets of this campaign' } } },
    readOnly: true,
    destructive: false,
  },
  {
    name: 'ads_insights_performance',
    description: 'Results by campaign or ad set over a period: spend (USD), impressions, link clicks, purchases seen by the pixel, cost per purchase, CTR.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['account', 'campaign', 'adset'] },
        date_preset: { type: 'string', enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month'] },
      },
      required: ['level', 'date_preset'],
    },
    readOnly: true,
    destructive: false,
  },
  {
    name: 'ads_update_entity',
    description: 'Changes a campaign or an ad set: its status (ACTIVE or PAUSED) and / or its daily budget.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The campaign or ad set id' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
        daily_budget: { type: 'integer', description: 'The new daily budget, in cents of the ad account currency' },
      },
      required: ['entity_id'],
    },
    readOnly: false,
    destructive: false,
  },
];

function rangeOf(preset: string, now: number): { from: string; to: string } {
  const today = algDay(now);
  const first = `${today.slice(0, 8)}01`;
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last_14d':
      return { from: addDays(today, -14), to: addDays(today, -1) };
    case 'last_30d':
      return { from: addDays(today, -30), to: addDays(today, -1) };
    case 'this_month':
      return { from: first, to: today };
    case 'last_month': {
      const end = addDays(first, -1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    }
    default:
      return { from: addDays(today, -7), to: addDays(today, -1) };
  }
}

interface Perf {
  id: string;
  name: string;
  campaignId: string | null;
  status: string | null;
  /** Pilotix's goal for the ad set (a messages or calls ad set is not judged on Meta's purchases) */
  goal: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
}
/** the demo's numbers per ad set over a period (Meta's purchases, spend in dollars) */
async function perfOf(db: Db, from: string, to: string): Promise<Perf[]> {
  const fx = await fxTable(db);
  const rows = await db.query(
    `SELECT s.id, s.name, s.campaign_id, s.status, s.goal, s.currency, to_char(i.day, 'YYYY-MM-DD') AS day, i.spend_cents, i.impressions, i.clicks, i.purchases
     FROM adsets s LEFT JOIN ad_insights i ON i.adset_id = s.id AND i.day BETWEEN $1 AND $2 ORDER BY s.id`,
    [from, to],
  );
  const by = new Map<string, Perf>();
  for (const r of rows) {
    const id = String(r.id);
    const p = by.get(id) ?? { id, name: String(r.name), campaignId: r.campaign_id ? String(r.campaign_id) : null, status: r.status ?? null, goal: r.goal ?? null, spend: 0, impressions: 0, clicks: 0, purchases: 0 };
    if (r.day) {
      p.spend += daySpend(fx, String(r.day), num(r.spend_cents), r.currency).spendCents / 100;
      p.impressions += num(r.impressions);
      p.clicks += num(r.clicks);
      p.purchases += num(r.purchases);
    }
    by.set(id, p);
  }
  return [...by.values()];
}
const perfLine = (p: { id: string; name: string; spend: number; impressions: number; clicks: number; purchases: number; status?: string | null }) => ({
  id: p.id,
  name: p.name,
  ...(p.status !== undefined ? { status: p.status } : {}),
  spend_usd: Math.round(p.spend * 100) / 100,
  impressions: p.impressions,
  link_clicks: p.clicks,
  purchases: p.purchases,
  cost_per_purchase_usd: p.purchases ? Math.round((p.spend / p.purchases) * 100) / 100 : null,
  ctr_pct: p.impressions ? Math.round((p.clicks / p.impressions) * 10000) / 100 : null,
});

/** One of the demo's tools, read on the demo's tables (a change is never run here: it waits for the owner). */
export async function demoTool(ctx: Ctx, name: string, input: any): Promise<ToolResult> {
  const json = (v: unknown): ToolResult => ({ text: JSON.stringify(v), isError: false });
  if (name === 'ads_get_ad_accounts') return json({ data: [{ id: 'act_120211887', name: 'Compte pub démo', currency: 'USD', status: 'ACTIVE' }] });
  if (name === 'ads_get_campaigns') {
    const rows = await ctx.db.query(`SELECT id, name, objective, status, daily_budget_cents FROM ad_campaigns WHERE ($1::text IS NULL OR status = $1) ORDER BY id`, [input?.status ? String(input.status) : null]);
    return json({ data: rows.map((r: any) => ({ id: String(r.id), name: String(r.name), objective: r.objective, status: r.status, daily_budget: numOrNull(r.daily_budget_cents) })) });
  }
  if (name === 'ads_get_adsets') {
    const rows = await ctx.db.query(`SELECT id, name, campaign_id, status, daily_budget_cents FROM adsets WHERE ($1::text IS NULL OR campaign_id = $1) ORDER BY id`, [
      input?.campaign_id ? String(input.campaign_id) : null,
    ]);
    return json({ data: rows.map((r: any) => ({ id: String(r.id), name: String(r.name), campaign_id: r.campaign_id, status: r.status, daily_budget: numOrNull(r.daily_budget_cents) })) });
  }
  if (name === 'ads_insights_performance') {
    const r = rangeOf(String(input?.date_preset ?? 'last_7d'), ctx.now());
    const sets = await perfOf(ctx.db, r.from, r.to);
    const level = String(input?.level ?? 'adset');
    if (level === 'adset') return json({ since: r.from, until: r.to, data: sets.map(perfLine) });
    if (level === 'campaign') {
      const camps = new Map<string, Perf>();
      const names = new Map<string, string>((await ctx.db.query(`SELECT id, name FROM ad_campaigns`)).map((x: any) => [String(x.id), String(x.name)]));
      for (const s of sets) {
        const k = s.campaignId ?? 'none';
        const c = camps.get(k) ?? { id: k, name: names.get(k) ?? k, campaignId: null, status: null, goal: null, spend: 0, impressions: 0, clicks: 0, purchases: 0 };
        c.spend += s.spend;
        c.impressions += s.impressions;
        c.clicks += s.clicks;
        c.purchases += s.purchases;
        camps.set(k, c);
      }
      return json({ since: r.from, until: r.to, data: [...camps.values()].map(perfLine) });
    }
    const all = sets.reduce((a, s) => ({ ...a, spend: a.spend + s.spend, impressions: a.impressions + s.impressions, clicks: a.clicks + s.clicks, purchases: a.purchases + s.purchases }), {
      id: 'act_120211887',
      name: 'Compte pub démo',
      spend: 0,
      impressions: 0,
      clicks: 0,
      purchases: 0,
    });
    return json({ since: r.from, until: r.to, data: [perfLine(all)] });
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}
/** the demo's change, once the owner said yes: its campaign or ad set as Meta would have it */
async function demoWrite(ctx: Ctx, input: unknown): Promise<ToolResult> {
  const k = changeOf(input);
  const t = await knownOf(ctx.db, k.objectId);
  if (!t || !k.op) return { text: 'Unsupported change in the demo', isError: true };
  const table = t.level === 'adset' ? 'adsets' : 'ad_campaigns';
  if (k.op === 'budget') await ctx.db.query(`UPDATE ${table} SET daily_budget_cents = $2, changed_at = now(), updated_at = now() WHERE id = $1`, [t.id, k.budgetCents]);
  else await ctx.db.query(`UPDATE ${table} SET status = $2, changed_at = now(), updated_at = now() WHERE id = $1`, [t.id, k.op === 'pause' ? 'PAUSED' : 'ACTIVE']);
  return { text: JSON.stringify({ success: true, id: t.id }), isError: false };
}

// ---------------------------------------------------------------- ready sentences (the demo without an AI)
interface Draft {
  answer: string;
  reads: { tool: string; ok: boolean }[];
  pending: { tool: string; input: Record<string, unknown>; label: string; kind: ChangeKind } | null;
  byAi: boolean;
}
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function intentOf(q: string): 'pause' | 'raise' | 'compare' | 'summary' {
  const s = fold(q);
  if (/(pause|arret|arrete|stop|coupe|eteins|turn off|وقف|اوقف|أوقف|حبس|قطع)/.test(s)) return 'pause';
  if (/(augment|monte|scale|raise|increase|more budget|plus de budget|زيد|زيادة|ارفع|كبر)/.test(s)) return 'raise';
  if (/(compar|semaine|week|hier|yesterday|اسبوع|أسبوع|سمانة|البارح|امس|أمس)/.test(s)) return 'compare';
  return 'summary';
}
/** Ready sentences with the demo's own numbers (the last 7 days against the 7 before), a change proposed when asked. */
export async function readyAnswer(db: Db, now: number, q: string, lang: AskLang): Promise<Draft> {
  const today = algDay(now);
  const week = await perfOf(db, addDays(today, -7), addDays(today, -1));
  const before = await perfOf(db, addDays(today, -14), addDays(today, -8));
  const reads = [
    { tool: 'ads_get_adsets', ok: true },
    { tool: 'ads_insights_performance', ok: true },
  ];
  // judged on Meta's purchases: the ad sets made to sell on the site (a messages or calls one sells in the chat or on the phone)
  const sells = (p: Perf) => !p.goal || p.goal === 'sales' || p.goal === 'traffic';
  const live = week.filter((p) => p.spend > 0);
  const judged = live.filter(sells);
  const sum = (ps: Perf[]) => ps.reduce((a, p) => ({ spend: a.spend + p.spend, purchases: a.purchases + p.purchases }), { spend: 0, purchases: 0 });
  const w = sum(week);
  const b = sum(before);
  const cpa = (p: { spend: number; purchases: number }) => (p.purchases ? p.spend / p.purchases : Infinity);
  const sorted = [...judged].sort((x, y) => cpa(x) - cpa(y) || y.purchases - x.purchases);
  const best = sorted[0] ?? null;
  const worst = judged.filter((p) => p.status === 'ACTIVE').sort((x, y) => cpa(y) - cpa(x) || y.spend - x.spend)[0] ?? null;
  const per = (p: { spend: number; purchases: number }) => (p.purchases ? usd2(p.spend / p.purchases) : '—');
  const T = {
    fr: {
      none: 'Aucune dépense ces 7 derniers jours : rien à comparer pour l’instant.',
      head: `Ces 7 derniers jours : ${usd2(w.spend)} dépensés, ${w.purchases} achats vus par Meta (${per(w)} l’achat).`,
      best: (p: Perf) => `• La meilleure : « ${p.name} » — ${usd2(p.spend)}, ${p.purchases} achats (${per(p)} l’achat).`,
      worst: (p: Perf) => `• La plus chère : « ${p.name} » — ${usd2(p.spend)}, ${p.purchases ? `${p.purchases} achat${p.purchases > 1 ? 's' : ''} (${per(p)} l’achat)` : 'aucun achat'}.`,
      real: 'Les commandes livrées sont dans Mes pubs : Meta ne voit que les achats de son pixel.',
      cmp: (pct: number | null) => `La semaine d’avant : ${usd2(b.spend)} et ${b.purchases} achats (${per(b)} l’achat).${pct === null ? '' : ` Le coût d’un achat ${pct > 0 ? 'monte' : 'baisse'} de ${Math.abs(pct)} %.`}`,
      pause: (p: Perf) =>
        `Je propose de mettre en pause « ${p.name} » : ${usd2(p.spend)} dépensés pour ${p.purchases ? `${p.purchases} achat${p.purchases > 1 ? 's' : ''}` : 'aucun achat'} en 7 jours. Rien ne change avant votre « Oui, faire ».`,
      raise: (p: Perf, v: string) => `Je propose de monter « ${p.name} » à ${v} par jour (+20 %) : c’est celle qui vend le moins cher (${per(p)} l’achat). Rien ne change avant votre « Oui, faire ».`,
      noRaise: 'Aucune pub n’a un budget à elle à monter : son budget est dans sa campagne (Advantage+).',
    },
    en: {
      none: 'No spend in the last 7 days: nothing to compare yet.',
      head: `Last 7 days: ${usd2(w.spend)} spent, ${w.purchases} purchases seen by Meta (${per(w)} per purchase).`,
      best: (p: Perf) => `• Best: “${p.name}” — ${usd2(p.spend)}, ${p.purchases} purchases (${per(p)} each).`,
      worst: (p: Perf) => `• Most expensive: “${p.name}” — ${usd2(p.spend)}, ${p.purchases ? `${p.purchases} purchase${p.purchases === 1 ? '' : 's'} (${per(p)} each)` : 'no purchase'}.`,
      real: 'Delivered orders are in My ads: Meta only sees its pixel’s purchases.',
      cmp: (pct: number | null) => `The week before: ${usd2(b.spend)} and ${b.purchases} purchases (${per(b)} each).${pct === null ? '' : ` The cost of a purchase is ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%.`}`,
      pause: (p: Perf) =>
        `I suggest pausing “${p.name}”: ${usd2(p.spend)} spent for ${p.purchases ? `${p.purchases} purchase${p.purchases === 1 ? '' : 's'}` : 'no purchase'} in 7 days. Nothing changes before your “Yes, do it”.`,
      raise: (p: Perf, v: string) => `I suggest raising “${p.name}” to ${v} a day (+20%): it sells the cheapest (${per(p)} per purchase). Nothing changes before your “Yes, do it”.`,
      noRaise: 'No ad has a budget of its own to raise: its budget is in its campaign (Advantage+).',
    },
    ar: {
      none: 'لا إنفاق في الأيام السبعة الأخيرة: لا شيء للمقارنة الآن.',
      head: `آخر 7 أيام: ${usd2(w.spend)} مصروفة، ${w.purchases} عملية شراء رآها Meta (${per(w)} للشراء).`,
      best: (p: Perf) => `• الأفضل: « ${p.name} » — ${usd2(p.spend)}، ${p.purchases} شراء (${per(p)} للشراء).`,
      worst: (p: Perf) => `• الأغلى: « ${p.name} » — ${usd2(p.spend)}، ${p.purchases ? `${p.purchases} شراء (${per(p)} للشراء)` : 'بدون أي شراء'}.`,
      real: 'الطلبات المسلّمة في « إعلاناتي »: Meta يرى فقط مشتريات البكسل.',
      cmp: (pct: number | null) => `الأسبوع الذي قبله: ${usd2(b.spend)} و ${b.purchases} شراء (${per(b)} للشراء).${pct === null ? '' : ` تكلفة الشراء ${pct > 0 ? 'ارتفعت' : 'انخفضت'} بـ ${Math.abs(pct)}٪.`}`,
      pause: (p: Perf) => `أقترح إيقاف « ${p.name} » مؤقتا: ${usd2(p.spend)} مصروفة ${p.purchases ? `مقابل ${p.purchases} شراء` : 'بدون أي شراء'} في 7 أيام. لا شيء يتغير قبل « نعم، نفّذ ».`,
      raise: (p: Perf, v: string) => `أقترح رفع « ${p.name} » إلى ${v} في اليوم (+20٪): هو الأرخص في البيع (${per(p)} للشراء). لا شيء يتغير قبل « نعم، نفّذ ».`,
      noRaise: 'لا يوجد إعلان بميزانية خاصة به لرفعها: ميزانيته في حملته (Advantage+).',
    },
  }[lang];
  if (!live.length) return { answer: T.none, reads, pending: null, byAi: false };
  if (!judged.length) return { answer: T.head, reads, pending: null, byAi: false };
  const intent = intentOf(q);
  if (intent === 'pause' && worst) {
    const input = { entity_id: worst.id, status: 'PAUSED' };
    const d = await describeChange(db, 'ads_update_entity', input, lang, 'cents');
    return { answer: T.pause(worst), reads, pending: { tool: 'ads_update_entity', input, label: d.label, kind: d.kind }, byAi: false };
  }
  if (intent === 'raise') {
    const budgets = new Map<string, number | null>((await db.query(`SELECT id, daily_budget_cents FROM adsets`)).map((r: any) => [String(r.id), numOrNull(r.daily_budget_cents)]));
    const pick = sorted.find((p) => p.status === 'ACTIVE' && budgets.get(p.id));
    if (!pick) return { answer: T.noRaise, reads, pending: null, byAi: false };
    const cents = Math.round(budgets.get(pick.id)! * 1.2);
    const input = { entity_id: pick.id, daily_budget: cents };
    const d = await describeChange(db, 'ads_update_entity', input, lang, 'cents');
    return { answer: T.raise(pick, usd2(cents / 100)), reads, pending: { tool: 'ads_update_entity', input, label: d.label, kind: d.kind }, byAi: false };
  }
  const lines = [T.head];
  if (intent === 'compare') {
    const pct = isFinite(cpa(w)) && isFinite(cpa(b)) && cpa(b) > 0 ? Math.round(((cpa(w) - cpa(b)) / cpa(b)) * 100) : null;
    lines.push(T.cmp(pct));
  }
  if (best) lines.push(T.best(best));
  if (worst && worst.id !== best?.id) lines.push(T.worst(worst));
  lines.push(T.real);
  return { answer: lines.join('\n'), reads, pending: null, byAi: false };
}

// ---------------------------------------------------------------- Pilot AI with Meta's tools
const LANG_NAME: Record<AskLang, string> = { fr: 'français', en: 'anglais', ar: 'arabe (ou darija en lettres arabes si la question est en darija)' };
async function systemOf(ctx: Ctx, lang: AskLang): Promise<string> {
  const shop = await getSetting(ctx.db, 'shop');
  const meta = await getSetting(ctx.db, 'meta');
  const accounts = [...new Set((meta.adAccountIds?.length ? meta.adAccountIds : meta.adAccountId ? [meta.adAccountId] : ctx.server ? [] : ['120211887']).map((x) => `act_${String(x).replace(/^act_/, '')}`))];
  return `Tu es Pilot AI, l’assistant publicité de la boutique « ${shop.name || 'Pilotix'} » (Algérie, paiement à la livraison). Tu réponds à son propriétaire sur ses publicités Meta (Facebook, Instagram) avec les outils de Meta : lis d’abord les chiffres avec eux, n’invente jamais un chiffre.
Aujourd’hui : ${algDay(ctx.now())} (heure d’Alger). Comptes pub de la boutique : ${accounts.join(', ') || 'à lire avec les outils'}. N’agis sur aucun autre compte.
Règles :
- Réponds en ${LANG_NAME[lang]}, en mots simples, en 2 à 6 lignes ou une courte liste avec « • ». Donne les chiffres qui comptent (dépense, achats, coût par achat, période) et ce que tu conseilles.
- Les « achats » de Meta sont ceux que voit son pixel ; les vraies commandes livrées sont dans Pilotix (Publicité › Mes pubs). Dis-le quand on te demande ce qui rapporte vraiment.
- Pour changer quelque chose (pause, budget, nouvelle campagne…), appelle l’outil qui le fait, une seule fois : il n’est PAS exécuté tout de suite, il attend le « Oui, faire » du propriétaire dans Pilotix. Dis clairement ce que tu proposes et pourquoi, et que rien n’a encore changé.
- Un budget se donne par jour ; ne propose jamais de dépenser plus sans le dire en chiffres.
- Pas de markdown (pas de #, pas de **), pas de tableau.`;
}

async function aiAnswer(ctx: Ctx, i: { question: string; lang: AskLang; history: { question: string; answer: string }[] }): Promise<Draft> {
  const tools: AskTool[] = ctx.server ? ((await ctx.server.meta('mcpTools', {}, ctx)) as { tools: AskTool[] }).tools : DEMO_TOOLS;
  const usable = tools.filter((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name)).slice(0, 80);
  if (!usable.length) throw bad('Meta ne donne aucun outil à ce compte : reliez Meta à nouveau (Pilot AI › Comptes) et acceptez « ads_mcp_management ».');
  const byName = new Map(usable.map((t) => [t.name, t]));
  const aiTools = usable.map((t) => {
    const schema: any = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {};
    return {
      name: t.name,
      description: `${t.description || t.title || t.name}${isWrite(t) ? ' [CHANGE: not run now — it waits for the owner’s yes in Pilotix]' : ''}`.slice(0, 1024),
      input_schema: { ...schema, type: 'object', properties: schema.properties ?? {} },
    };
  });
  const reads: Draft['reads'] = [];
  let pending: Draft['pending'] = null;
  const runTool = async (name: string, input: any): Promise<any> => {
    const t = byName.get(name);
    if (!t) return { error: `Unknown tool ${name}` };
    if (isWrite(t)) {
      if (pending) return { error: 'One change per question: this one is not kept.' };
      const d = await describeChange(ctx.db, name, input, i.lang, budgetUnitOf(t));
      pending = { tool: name, input: input ?? {}, label: d.label, kind: d.kind };
      return { pending: true, note: 'Not done yet: this change waits for the owner’s « Oui, faire » in Pilotix. Tell them what you propose and why.' };
    }
    try {
      const r = ctx.server ? ((await ctx.server.meta('mcpCall', { name, args: input ?? {} }, ctx)) as ToolResult) : await demoTool(ctx, name, input);
      reads.push({ tool: name, ok: !r.isError });
      return r.isError ? { error: r.text.slice(0, 2000) } : r.text;
    } catch (e: any) {
      reads.push({ tool: name, ok: false });
      return { error: String(e?.message ?? e).slice(0, 400) };
    }
  };
  const inPage = !ctx.server?.dellal && ctx.dellalAi ? ctx.dellalAi : null;
  const pilot = !inPage && (await pilotOn(ctx));
  const model = pilot || inPage ? PILOT_CHEAP_MODEL : (await dellalSettings(ctx.db)).model;
  const system = await systemOf(ctx, i.lang);
  const messages: { role: 'user' | 'assistant'; content: any }[] = [];
  for (const h of i.history.slice(-4)) messages.push({ role: 'user', content: h.question }, { role: 'assistant', content: h.answer || '…' });
  messages.push({ role: 'user', content: i.question });
  let texts: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const req = { model, system, messages, tools: aiTools, max_tokens: 1200 };
    const res = (inPage ? await inPage({ ...req, runTool }) : await ctx.server!.dellal!('complete', { ...req, feature: 'other', pilot }, ctx)) as AiResponse;
    const uses = res.content.filter((b): b is Extract<AiResponse['content'][number], { type: 'tool_use' }> => b.type === 'tool_use');
    texts = res.content
      .filter((b) => b.type === 'text')
      .map((b: any) => String(b.text).trim())
      .filter(Boolean);
    if (!uses.length || res.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: res.content });
    const results: any[] = [];
    for (const u of uses) {
      const out = await runTool(u.name, u.input);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: typeof out === 'string' ? out : JSON.stringify(out), is_error: !!(out && typeof out === 'object' && 'error' in out) });
    }
    messages.push({ role: 'user', content: results });
  }
  const answer = texts.join('\n\n').replace(/\*\*/g, '').trim();
  return { answer: answer || (i.lang === 'ar' ? 'لم أتمكن من الإجابة الآن.' : i.lang === 'en' ? 'I could not answer just now.' : 'Je n’ai pas pu répondre pour l’instant.'), reads, pending, byAi: true };
}

// ---------------------------------------------------------------- the questions
const askView = (r: any) => ({
  id: num(r.id),
  threadId: num(r.thread_id ?? r.id),
  question: String(r.question),
  answer: String(r.answer ?? ''),
  lang: String(r.lang ?? 'fr') as AskLang,
  reads: (Array.isArray(r.reads) ? r.reads : []) as { tool: string; ok: boolean }[],
  pending: r.pending ? { tool: String(r.pending.tool), label: String(r.pending.label), input: r.pending.input ?? {}, op: (r.pending.kind?.op ?? null) as ChangeKind['op'] } : null,
  status: String(r.status) as 'done' | 'waiting_yes' | 'applied' | 'refused' | 'failed',
  result: r.result ?? null,
  error: r.error ?? null,
  byAi: !!r.by_ai,
  by: r.by_name ?? null,
  decidedBy: r.decided_name ?? null,
  at: iso(r.created_at),
  decidedAt: r.status === 'applied' || r.status === 'refused' || r.status === 'failed' ? isoOrNull(r.updated_at) : null,
});
export type AskView = ReturnType<typeof askView>;
const ASK_ROW = `SELECT q.*, u.name AS by_name, d.name AS decided_name FROM ads_asks q LEFT JOIN profiles u ON u.id = q.by_user LEFT JOIN profiles d ON d.id = q.decided_by`;
async function askRow(db: Db, id: number) {
  const r = (await db.query(`${ASK_ROW} WHERE q.id = $1`, [id]))[0];
  if (!r) throw notFound('Question introuvable');
  return r;
}
const onlyOwner = (ctx: Ctx) => {
  if (!isOwner(ctx)) throw forbidden('Seul le propriétaire de la boutique pose ses questions à Pilot AI sur ses pubs.');
};

async function state(ctx: Ctx) {
  onlyOwner(ctx);
  const inPage = !ctx.server?.dellal && !!ctx.dellalAi;
  const meta = await getSetting(ctx.db, 'meta');
  const rows = await ctx.db.query(`${ASK_ROW} ORDER BY q.id DESC LIMIT 40`);
  return {
    demo: !ctx.server,
    /** Pilot AI answers (else, in the demo, ready sentences with the demo's numbers) */
    ai: ctx.server ? await aiKeyed(ctx) : inPage,
    /** Meta is linked (the MCP server uses the shop's Meta token) */
    connected: ctx.server ? !!(meta.adAccountId && meta.hasToken) : true,
    waiting: rows.filter((r: any) => r.status === 'waiting_yes').length,
    asks: rows.reverse().map(askView),
  };
}

async function ask(ctx: Ctx, i: { question: string; threadId: number | null; lang: AskLang }) {
  onlyOwner(ctx);
  const question = i.question.trim();
  // Arabic letters: the answer in Arabic (or Darija), whatever the app's language
  const lang: AskLang = /[؀-ۿ]/.test(question) ? 'ar' : i.lang;
  const history = i.threadId
    ? (await ctx.db.query(`SELECT question, answer FROM ads_asks WHERE thread_id = $1 ORDER BY id DESC LIMIT 4`, [i.threadId])).reverse().map((r: any) => ({ question: String(r.question), answer: String(r.answer) }))
    : [];
  // a conversation forgotten meanwhile: this question starts a new one
  const threadId = i.threadId && history.length ? i.threadId : null;
  const inPage = !ctx.server?.dellal && !!ctx.dellalAi;
  let d: Draft;
  if (ctx.server) {
    const meta = await getSetting(ctx.db, 'meta');
    if (!meta.adAccountId || !meta.hasToken) throw bad('Reliez le compte pub Meta de la boutique (Pilot AI › Comptes) : Pilot AI lit vos pubs chez Meta.');
    if (!(await aiKeyed(ctx))) throw bad('Pilot AI n’est pas encore prêt pour cette boutique.');
    d = await aiAnswer(ctx, { question, lang, history });
  } else d = inPage ? await aiAnswer(ctx, { question, lang, history }) : await readyAnswer(ctx.db, ctx.now(), question, lang);
  const row = (
    await ctx.db.query(`INSERT INTO ads_asks (thread_id, by_user, question, answer, lang, reads, pending, status, by_ai) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [
      threadId,
      me(ctx),
      question.slice(0, 1000),
      d.answer.slice(0, 6000),
      lang,
      JSON.stringify(d.reads.slice(0, 30)),
      d.pending ? JSON.stringify(d.pending) : null,
      d.pending ? 'waiting_yes' : 'done',
      d.byAi,
    ])
  )[0];
  if (!threadId) await ctx.db.query(`UPDATE ads_asks SET thread_id = id WHERE id = $1`, [row.id]);
  return askView(await askRow(ctx.db, num(row.id)));
}

/**
 * The owner's answer to a proposed change. Yes: the owner's limits first (a pause always goes; a start again or a raise
 * not while « Tout arrêter » is on; a budget not above the most per day, nor a 5th change in the hour), then Meta (the
 * same tool, the same arguments), then the log of changes and Pilotix's own copy of the ad set or campaign.
 */
async function decide(ctx: Ctx, id: number, yes: boolean) {
  onlyOwner(ctx);
  return withActionLock(ctx.db, `ask:${id}`, me(ctx), 'Cette modification est déjà en cours.', async () => {
    const r = await askRow(ctx.db, id);
    if (r.status !== 'waiting_yes' || !r.pending) throw bad('Cette modification n’attend plus de réponse.');
    if (!yes) {
      await ctx.db.query(`UPDATE ads_asks SET status = 'refused', decided_by = $2, updated_at = now() WHERE id = $1`, [id, me(ctx)]);
      return askView(await askRow(ctx.db, id));
    }
    const p = r.pending as { tool: string; input: Record<string, unknown>; kind: ChangeKind };
    const kind = p.kind ?? changeOf(p.input);
    const target = await knownOf(ctx.db, kind.objectId);
    const s = await pilotSettings(ctx.db);
    const rate = (await fxTable(ctx.db))(algDay(ctx.now()).slice(0, 7));
    if (target && kind.op) {
      const usdOf = (cents: number | null) => (cents === null ? null : target.currency.toUpperCase() === 'DZD' ? (rate ? cents / 100 / rate : null) : cents / 100);
      const changes = num((await ctx.db.query(`SELECT count(*) AS n FROM ad_actions WHERE object_id = $1 AND op IN ('budget','undo') AND status = 'done' AND done_at > now() - interval '1 hour'`, [target.id]))[0]?.n);
      const v = checkChange(s.guard, {
        op: kind.op,
        owner: true,
        fromUsd: usdOf(target.budgetCents),
        toUsd: kind.op === 'budget' ? usdOf(kind.budgetCents) : usdOf(target.budgetCents),
        shopDailyUsd: await shopDailyUsd(ctx.db, rate),
        changesLastHour: changes,
      });
      if (!v.ok) throw bad(v.why);
    } else if (s.guard.stopped && kind.op !== 'pause') throw bad('Tout est arrêté par le propriétaire : relancez d’abord (« Tout relancer »), puis dites oui.');
    try {
      const res = ctx.server ? ((await ctx.server.meta('mcpCall', { name: p.tool, args: p.input }, ctx)) as ToolResult) : await demoWrite(ctx, p.input);
      if (res.isError) throw bad(`Meta : ${res.text.slice(0, 300)}`);
      // Pilotix's copy and the log of changes (a pause, a start again or a budget is undone from the log, 7 days)
      if (target && kind.op) {
        const table = target.level === 'adset' ? 'adsets' : 'ad_campaigns';
        const after = kind.op === 'budget' ? { budgetCents: kind.budgetCents } : { status: kind.op === 'pause' ? 'PAUSED' : 'ACTIVE' };
        if (ctx.server) {
          if (kind.op === 'budget') await ctx.db.query(`UPDATE ${table} SET daily_budget_cents = $2, changed_at = now(), updated_at = now() WHERE id = $1`, [target.id, kind.budgetCents]);
          else await ctx.db.query(`UPDATE ${table} SET status = $2, changed_at = now(), updated_at = now() WHERE id = $1`, [target.id, after.status]);
        }
        await ctx.db.query(`INSERT INTO ad_actions (level, object_id, object_name, op, before, after, source, status, why, by_user, approved_by, done_at) VALUES ($1,$2,$3,$4,$5,$6,'ask','done',$7,$8,$9,now())`, [
          target.level,
          target.id,
          target.name,
          kind.op,
          JSON.stringify({ status: target.status, budgetCents: target.budgetCents }),
          JSON.stringify(after),
          String(r.question).slice(0, 300),
          numOrNull(r.by_user),
          me(ctx),
        ]);
      } else
        await ctx.db.query(
          `INSERT INTO ad_actions (level, object_id, object_name, op, before, after, source, status, why, by_user, approved_by, done_at) VALUES ('account',$1,$2,'ai',NULL,$3,'ask','done',$4,$5,$6,now())`,
          [kind.objectId ?? p.tool, String(r.pending.label ?? p.tool).slice(0, 200), JSON.stringify({ tool: p.tool }), String(r.question).slice(0, 300), numOrNull(r.by_user), me(ctx)],
        );
      await ctx.db.query(`UPDATE ads_asks SET status = 'applied', result = $2, error = NULL, decided_by = $3, updated_at = now() WHERE id = $1`, [id, res.text.slice(0, 500), me(ctx)]);
    } catch (e: any) {
      await ctx.db.query(`UPDATE ads_asks SET status = 'failed', error = $2, decided_by = $3, updated_at = now() WHERE id = $1`, [id, String(e?.message ?? e).slice(0, 500), me(ctx)]);
      throw e;
    }
    return askView(await askRow(ctx.db, id));
  });
}

export const adsAskProcs = {
  /** the questions asked (the oldest first), whether Pilot AI answers, the changes waiting for the owner's yes */
  'ads.ask.state': proc(['vendeur'], z.object({}), (ctx) => state(ctx)),
  'ads.ask.send': proc(['vendeur'], z.object({ question: z.string().trim().min(2).max(1000), threadId: z.number().int().positive().nullable().default(null), lang: z.enum(ASK_LANGS).default('fr') }), (ctx, i) =>
    ask(ctx, i),
  ),
  'ads.ask.decide': proc(['vendeur'], z.object({ id: z.number().int().positive(), yes: z.boolean() }), (ctx, i) => decide(ctx, i.id, i.yes)),
  /** a conversation forgotten (its changes already made stay made) */
  'ads.ask.forget': proc(['vendeur'], z.object({ threadId: z.number().int().positive() }), async (ctx, i) => {
    onlyOwner(ctx);
    // a change still waiting is dropped with it (nothing was made on Meta)
    await ctx.db.query(`DELETE FROM ads_asks WHERE thread_id = $1`, [i.threadId]);
    return { ok: true };
  }),
};
