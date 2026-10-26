// Administration: users (via users.*), statuses, pay plans + monthly payslips, client delivery prices,
// sales channels, shop settings, depots, website webhook, cron key and the Meta Ads connection.
import { CONF_STATUSES, DEFAULT_CALL_SETTINGS, FOLLOW_STATUSES, SAV_STATUSES } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { DEFAULT_SETTINGS, getSetting, setSetting, SettingsMap } from '../settings';
import { sendInPreview } from './notify';
import { createOrder } from './orders';
import { usersProcs } from './users';

// ---------------------------------------------------------------- small helpers
/** A random key (webhooks, cron). Works in Node 22 and browsers. */
export function randomKey(len = 32): string {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

/** Settings stored by this module under their own keys (not part of SettingsMap). */
export async function getRaw<T>(db: Db, key: string, def: T): Promise<T> {
  const r = await db.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return r[0] ? r[0].value : def;
}
export async function setRaw(db: Db, key: string, value: unknown, userId?: number) {
  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId ?? null],
  );
}

/** Own setting keys. The Meta token lives ONLY under META_TOKEN_KEY and is never returned by any procedure. */
export const STATUS_ORDER_KEY = 'statusOrder';
export const META_TOKEN_KEY = 'secret_meta_token';

const me = (ctx: Ctx) => ctx.session.profile.id;

// ---------------------------------------------------------------- statuses
/** The five groups of Management → Statuts, as in the original (which base statuses each one shows). */
export const STATUS_GROUPS = {
  confirmation: { track: 'conf' as const, base: [...CONF_STATUSES] as string[], always: ['to_check', 'new', 'confirmed', 'cancelled'] },
  depot: { track: 'follow' as const, base: ['to_prepare', 'prepared', 'returned'], always: ['to_prepare', 'prepared', 'returned'] },
  suivi: { track: 'follow' as const, base: ['shipped', 'alert', 'in_exchange', 'exchanged', 'returning', 'lost', 'cancelled'], always: ['shipped'] },
  livraison: { track: 'follow' as const, base: ['out_for_delivery', 'failed', 'delivered'], always: ['delivered'] },
  sav: { track: 'sav' as const, base: [...SAV_STATUSES] as string[], always: ['open', 'resolved'] },
};
export type StatusGroup = keyof typeof STATUS_GROUPS;
const GROUP_KEYS = Object.keys(STATUS_GROUPS) as StatusGroup[];
const TONES = ['info', 'ok', 'mid', 'warn', 'bad', 'off'] as const;

/** Which group a custom status belongs to: the group of the base status it behaves like. */
export function groupOfStatus(track: 'conf' | 'follow' | 'sav', key: string): StatusGroup | null {
  return GROUP_KEYS.find((g) => STATUS_GROUPS[g].track === track && STATUS_GROUPS[g].base.includes(key)) ?? null;
}

const StatusLabel = z.object({ fr: z.string().trim().max(60).optional(), ar: z.string().trim().max(60).optional(), tone: z.enum(TONES).optional(), hidden: z.boolean().optional() });
const CustomStatus = z.object({
  key: z.string().regex(/^c_[a-z0-9_]{2,40}$/),
  track: z.enum(['conf', 'follow', 'sav']),
  label: z.string().trim().min(1).max(60),
  ar: z.string().trim().max(60).optional(),
  tone: z.enum(TONES),
  behavesLike: z.string().min(2).max(40),
});

// ---------------------------------------------------------------- payroll
/** Start of a month in Algiers (UTC+1), as an ISO string. ym = '2026-10'. */
export function monthRange(ym: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) throw bad('Mois invalide (AAAA-MM)');
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { from: new Date(Date.UTC(y, mo, 1) - 3_600_000).toISOString(), to: new Date(Date.UTC(y, mo + 1, 1) - 3_600_000).toISOString() };
}

export interface PayLine {
  id: number;
  name: string;
  /** what is counted (orders) */
  count: number;
  /** details by rate */
  parts: { label: string; qty: number; rate: number; amount: number }[];
  pay: number;
}

/**
 * Monthly payslips, computed from the orders (all amounts whole dinars).
 *  - Confirmation agents: each order they confirmed (agent_id) that was DELIVERED in the month
 *    (follow_status delivered/exchanged, delivered_at in the month). Order total >= threshold → `above`, else `below`
 *    (threshold 0 = every order is "above"). + upsellBonus per delivered order with an upsell.
 *    + formOrder per delivered order the agent typed in himself (created_by = agent).
 *  - Agent managers: perDelivered for each delivered order of their team's agents (setting teams).
 *  - Suivi: perDelivered for each delivered order they followed (follow_agent_id, else the suivi user who set "delivered").
 *  - Dépôt: perPrepared for each order prepared in the month by them (user of the event to "prepared").
 *  - Livreurs: each order they delivered: `heavy` when the parcel weighs >= heavyFromKg, else `light`.
 */
export async function computePayroll(db: Db, ym: string) {
  const { from, to } = monthRange(ym);
  const plans = await getSetting(db, 'payPlans');
  const teams = await getSetting(db, 'teams');
  const people = await db.query(`SELECT id, name, roles, active FROM profiles ORDER BY name`);
  const P = new Map(people.map((p: any) => [num(p.id), p]));
  const has = (id: number, r: string) => {
    const p: any = P.get(id);
    if (!p) return false;
    const roles: string[] = p.roles;
    return roles.includes(r) || (r === 'confirmation' && roles.includes('agent_manager'));
  };

  const delivered = await db.query(
    `SELECT o.id, o.agent_id, o.total, o.has_upsell, o.created_by, o.livreur_id, o.follow_agent_id, o.is_exchange,
            (SELECT e.user_id FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'delivered' ORDER BY e.at DESC LIMIT 1) AS deliverer,
            (SELECT COALESCE(sum(i.qty * p.weight_kg), 0) FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id) AS weight
     FROM orders o
     WHERE o.delivered_at >= $1 AND o.delivered_at < $2 AND o.follow_status IN ('delivered','exchanged')`,
    [from, to],
  );
  // SAV ticket parcels are not sales: no commission for agents, managers or suivi (the depot and livreurs are still paid for the work)
  const sales = delivered.filter((o: any) => !o.is_exchange);

  // agents
  const ag = new Map<number, { above: number; below: number; upsell: number; form: number }>();
  for (const o of sales) {
    const a = o.agent_id === null ? null : num(o.agent_id);
    if (a === null || !has(a, 'confirmation')) continue;
    const r = ag.get(a) ?? { above: 0, below: 0, upsell: 0, form: 0 };
    if (num(o.total) >= plans.agent.threshold) r.above++;
    else r.below++;
    if (o.has_upsell) r.upsell++;
    if (o.created_by !== null && num(o.created_by) === a) r.form++;
    ag.set(a, r);
  }
  const agents: PayLine[] = people
    .filter((p: any) => has(num(p.id), 'confirmation') && (p.active || ag.has(num(p.id))))
    .map((p: any) => {
      const r = ag.get(num(p.id)) ?? { above: 0, below: 0, upsell: 0, form: 0 };
      const parts = [
        { label: 'delivered_above', qty: r.above, rate: plans.agent.above, amount: r.above * plans.agent.above },
        { label: 'delivered_below', qty: r.below, rate: plans.agent.below, amount: r.below * plans.agent.below },
        { label: 'upsell', qty: r.upsell, rate: plans.agent.upsellBonus, amount: r.upsell * plans.agent.upsellBonus },
        { label: 'form', qty: r.form, rate: plans.agent.formOrder, amount: r.form * plans.agent.formOrder },
      ];
      return { id: num(p.id), name: p.name, count: r.above + r.below, parts: parts.filter((x) => x.qty > 0), pay: parts.reduce((s, x) => s + x.amount, 0) };
    });

  // managers: delivered orders of their team agents
  const managers: PayLine[] = [];
  for (const t of teams) {
    if (!t.managerId) continue;
    const set = new Set(t.agentIds);
    const n = sales.filter((o: any) => o.agent_id !== null && set.has(num(o.agent_id))).length;
    const existing = managers.find((m) => m.id === t.managerId);
    if (existing) {
      existing.count += n;
      existing.parts[0].qty += n;
      existing.parts[0].amount += n * plans.manager.perDelivered;
      existing.pay += n * plans.manager.perDelivered;
    } else {
      const p: any = P.get(t.managerId);
      if (!p) continue;
      managers.push({ id: t.managerId, name: p.name, count: n, parts: [{ label: 'team_delivered', qty: n, rate: plans.manager.perDelivered, amount: n * plans.manager.perDelivered }], pay: n * plans.manager.perDelivered });
    }
  }

  // suivi
  const su = new Map<number, number>();
  for (const o of sales) {
    const who = o.follow_agent_id !== null ? num(o.follow_agent_id) : o.deliverer !== null ? num(o.deliverer) : null;
    if (who === null || !has(who, 'suivi')) continue;
    su.set(who, (su.get(who) ?? 0) + 1);
  }
  const suivi: PayLine[] = people
    .filter((p: any) => has(num(p.id), 'suivi') && (p.active || su.has(num(p.id))))
    .map((p: any) => {
      const n = su.get(num(p.id)) ?? 0;
      return { id: num(p.id), name: p.name, count: n, parts: [{ label: 'delivered', qty: n, rate: plans.suivi.perDelivered, amount: n * plans.suivi.perDelivered }], pay: n * plans.suivi.perDelivered };
    });

  // dépôt
  const prepared = await db.query(
    // an order is paid once, to whoever prepared it first (setting « Préparée » again, by the same or another person, pays nobody)
    `SELECT f.user_id, count(*) AS n FROM (
       SELECT DISTINCT ON (e.order_id) e.order_id, e.user_id, e.at FROM order_events e
        WHERE e.kind = 'follow_status' AND e.to_value = 'prepared' AND e.user_id IS NOT NULL
          AND e.order_id IN (SELECT order_id FROM order_events WHERE kind = 'follow_status' AND to_value = 'prepared' AND at >= $1 AND at < $2)
        ORDER BY e.order_id, e.at, e.id) f
     WHERE f.at >= $1 AND f.at < $2 GROUP BY f.user_id`,
    [from, to],
  );
  const dp = new Map(prepared.map((r: any) => [num(r.user_id), num(r.n)]));
  const depot: PayLine[] = people
    .filter((p: any) => has(num(p.id), 'depot') && (p.active || dp.has(num(p.id))))
    .map((p: any) => {
      const n = dp.get(num(p.id)) ?? 0;
      return { id: num(p.id), name: p.name, count: n, parts: [{ label: 'prepared', qty: n, rate: plans.depot.perPrepared, amount: n * plans.depot.perPrepared }], pay: n * plans.depot.perPrepared };
    });

  // livreurs
  const lv = new Map<number, { light: number; heavy: number }>();
  for (const o of delivered) {
    if (o.livreur_id === null) continue;
    const id = num(o.livreur_id);
    const r = lv.get(id) ?? { light: 0, heavy: 0 };
    if (Number(o.weight) >= plans.livreur.heavyFromKg) r.heavy++;
    else r.light++;
    lv.set(id, r);
  }
  const livreurs: PayLine[] = people
    .filter((p: any) => has(num(p.id), 'livreur') && (p.active || lv.has(num(p.id))))
    .map((p: any) => {
      const r = lv.get(num(p.id)) ?? { light: 0, heavy: 0 };
      const parts = [
        { label: 'light', qty: r.light, rate: plans.livreur.light, amount: r.light * plans.livreur.light },
        { label: 'heavy', qty: r.heavy, rate: plans.livreur.heavy, amount: r.heavy * plans.livreur.heavy },
      ];
      return { id: num(p.id), name: p.name, count: r.light + r.heavy, parts: parts.filter((x) => x.qty > 0), pay: parts.reduce((s, x) => s + x.amount, 0) };
    });

  const sum = (l: PayLine[]) => l.reduce((s, x) => s + x.pay, 0);
  return {
    month: ym,
    plans,
    agents,
    managers,
    suivi,
    depot,
    livreurs,
    total: sum(agents) + sum(managers) + sum(suivi) + sum(depot) + sum(livreurs),
  };
}

// ---------------------------------------------------------------- inputs
const PayPlans = z.object({
  agent: z.object({ threshold: z.number().int().min(0), below: z.number().int().min(0), above: z.number().int().min(0), upsellBonus: z.number().int().min(0), formOrder: z.number().int().min(0) }),
  manager: z.object({ perDelivered: z.number().int().min(0) }),
  suivi: z.object({ perDelivered: z.number().int().min(0) }),
  depot: z.object({ perPrepared: z.number().int().min(0) }),
  livreur: z.object({ light: z.number().int().min(0), heavy: z.number().int().min(0), heavyFromKg: z.number().min(0).max(1000) }),
});
const Hour = z.number().int().min(0).max(24);
const CallsInput = z.object({
  slots: z.array(z.object({ key: z.string().min(1).max(20), from: Hour, to: Hour })).min(1).max(6),
  tries: z.number().int().min(1).max(10),
  firstMinutes: z.number().int().min(1).max(1440),
  paceMinutes: z.number().int().min(0).max(600),
  cancelAfterNoAnswer: z.number().int().min(0).max(30),
});
const FeeRow = z.object({ home: z.number().int().min(0).max(100_000), desk: z.number().int().min(0).max(100_000) });
const GridName = z.string().trim().min(1).max(60);
export const CHANNEL_KINDS = ['sheets', 'woocommerce', 'shopify', 'youcan', 'lightfunnels', 'api', 'connector'] as const;
const id = z.number().int().positive();

const toWarehouse = (r: any) => ({ id: num(r.id), name: r.name, wilayaId: num(r.wilaya_id), commune: r.commune, address: r.address, isDefault: r.is_default, active: r.active });
const toChannel = (r: any) => ({
  id: num(r.id),
  kind: r.kind as string,
  name: r.name as string,
  creatorId: r.creator_id === null ? null : num(r.creator_id),
  creatorName: (r.creator_name as string | null) ?? null,
  skuRequired: !!r.sku_required,
  active: !!r.active,
  url: (r.config?.url as string | undefined) ?? '',
  webhookKey: r.webhook_key as string,
  lastSyncAt: isoOrNull(r.last_sync_at),
});

/** Copy of the default company's tariffs as a client price grid (or a flat grid when none). */
async function gridFromCompany(db: Db, companyId: number | null) {
  const rows = companyId ? await db.query('SELECT wilaya_id, home, desk FROM delivery_fees WHERE company_id = $1', [companyId]) : [];
  const grid: Record<string, { home: number; desk: number }> = {};
  for (let w = 1; w <= 69; w++) grid[String(w)] = { home: 600, desk: 400 };
  for (const r of rows) grid[String(num(r.wilaya_id))] = { home: num(r.home), desk: num(r.desk) };
  return grid;
}

// ---------------------------------------------------------------- procedures
export const adminProcs = {
  // ---------- users (the lists use users.list; these add what the original had on top)
  /** Users per role for the Rôles table. */
  'admin.roles': proc(null, z.object({}), async (ctx) => {
    if (!ctx.session.isAdmin && !ctx.session.canManageUsers) throw forbidden();
    const rows = await ctx.db.query('SELECT id, name, roles, active FROM profiles ORDER BY name');
    const out: Record<string, { active: number; total: number; names: string[] }> = {};
    for (const r of rows as any[]) {
      for (const role of r.roles as string[]) {
        const o = (out[role] ??= { active: 0, total: 0, names: [] });
        o.total++;
        if (r.active) {
          o.active++;
          o.names.push(r.name);
        }
      }
    }
    return out;
  }),
  /** Sets a new random password and returns it once (the admin passes it on). */
  'admin.users.resetPassword': proc(null, z.object({ id }), async (ctx, i) => {
    // the administrator, or someone allowed to handle the team's accounts (users.update checks who may be touched)
    const pw = randomKey(10);
    await usersProcs['users.update'].run(ctx, { id: i.id, password: pw });
    return { password: pw };
  }),
  /** Companies for selects (default company, livreur's company). */
  'admin.companies': proc(null, z.object({}), async (ctx) => {
    if (!ctx.session.isAdmin && !ctx.session.canManageUsers) throw forbidden();
    return (await ctx.db.query('SELECT id, name, kind, active FROM delivery_companies ORDER BY name')).map((r: any) => ({ id: num(r.id), name: r.name as string, kind: r.kind as string, active: !!r.active }));
  }),

  // ---------- statuses (everyone reads them: every screen shows the renamed labels)
  'admin.statuses.get': proc(null, z.object({}), async (ctx) => ({
    labels: await getSetting(ctx.db, 'statusLabels'),
    custom: await getSetting(ctx.db, 'customStatuses'),
    order: await getRaw<Record<string, string[]>>(ctx.db, STATUS_ORDER_KEY, {}),
    groups: Object.fromEntries(GROUP_KEYS.map((g) => [g, { track: STATUS_GROUPS[g].track, base: STATUS_GROUPS[g].base, always: STATUS_GROUPS[g].always }])),
  })),
  /** Rename / recolour / hide one status (base or custom). */
  'admin.statuses.setLabel': proc([], z.object({ key: z.string().min(2).max(44), label: StatusLabel }), async (ctx, i) => {
    const custom = await getSetting(ctx.db, 'customStatuses');
    const c = custom.find((x) => x.key === i.key);
    const isBase = (CONF_STATUSES as readonly string[]).includes(i.key) || (FOLLOW_STATUSES as readonly string[]).includes(i.key) || (SAV_STATUSES as readonly string[]).includes(i.key);
    if (!c && !isBase) throw notFound('Statut inconnu');
    const always = GROUP_KEYS.some((g) => STATUS_GROUPS[g].always.includes(i.key));
    if (always && i.label.hidden) throw bad('Statut indispensable : toujours actif');
    if (c) {
      const next = custom.map((x) => (x.key === i.key ? { ...x, label: i.label.fr || x.label, ar: i.label.ar ?? x.ar, tone: i.label.tone ?? x.tone } : x));
      await setSetting(ctx.db, 'customStatuses', next, me(ctx));
    }
    const labels = await getSetting(ctx.db, 'statusLabels');
    const cur = labels[i.key] ?? {};
    const merged = { ...cur, ...i.label };
    for (const k of Object.keys(merged) as (keyof typeof merged)[]) if (merged[k] === '' || merged[k] === undefined) delete merged[k];
    await setSetting(ctx.db, 'statusLabels', { ...labels, [i.key]: merged }, me(ctx));
    ctx.emit({ type: 'settings' });
    return { ok: true };
  }),
  'admin.statuses.addCustom': proc([], CustomStatus.omit({ key: true }).extend({ group: z.enum(GROUP_KEYS as [StatusGroup, ...StatusGroup[]]) }), async (ctx, i) => {
    const g = STATUS_GROUPS[i.group];
    if (g.track !== i.track || !g.base.includes(i.behavesLike)) throw bad('« Se comporte comme » doit être un statut d’origine de ce groupe');
    const custom = await getSetting(ctx.db, 'customStatuses');
    if (custom.length >= 60) throw bad('Trop de statuts ajoutés');
    const key = `c_${randomKey(8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await setSetting(ctx.db, 'customStatuses', [...custom, { key, track: i.track, label: i.label, ar: i.ar, tone: i.tone, behavesLike: i.behavesLike }], me(ctx));
    const order = await getRaw<Record<string, string[]>>(ctx.db, STATUS_ORDER_KEY, {});
    if (order[i.group]) await setRaw(ctx.db, STATUS_ORDER_KEY, { ...order, [i.group]: [...order[i.group], key] }, me(ctx));
    ctx.emit({ type: 'settings' });
    return { key };
  }),
  'admin.statuses.updateCustom': proc([], CustomStatus, async (ctx, i) => {
    const custom = await getSetting(ctx.db, 'customStatuses');
    const c = custom.find((x) => x.key === i.key);
    if (!c) throw notFound('Statut inconnu');
    const g = groupOfStatus(c.track, c.behavesLike);
    if (!g || !STATUS_GROUPS[g].base.includes(i.behavesLike) || i.track !== c.track) throw bad('« Se comporte comme » doit rester dans le même groupe');
    await setSetting(ctx.db, 'customStatuses', custom.map((x) => (x.key === i.key ? i : x)), me(ctx));
    ctx.emit({ type: 'settings' });
    return { ok: true };
  }),
  'admin.statuses.deleteCustom': proc([], z.object({ key: z.string() }), async (ctx, i) => {
    const custom = await getSetting(ctx.db, 'customStatuses');
    if (!custom.some((x) => x.key === i.key)) throw bad('Les statuts d’origine ne se suppriment pas');
    await setSetting(ctx.db, 'customStatuses', custom.filter((x) => x.key !== i.key), me(ctx));
    const labels = await getSetting(ctx.db, 'statusLabels');
    if (labels[i.key]) {
      const { [i.key]: _drop, ...rest } = labels;
      await setSetting(ctx.db, 'statusLabels', rest, me(ctx));
    }
    ctx.emit({ type: 'settings' });
    return { ok: true };
  }),
  /** New order of one group (keys of base + custom statuses of that group). */
  'admin.statuses.reorder': proc([], z.object({ group: z.enum(GROUP_KEYS as [StatusGroup, ...StatusGroup[]]), keys: z.array(z.string()).max(100) }), async (ctx, i) => {
    const custom = await getSetting(ctx.db, 'customStatuses');
    const g = STATUS_GROUPS[i.group];
    const valid = new Set([...g.base, ...custom.filter((c) => c.track === g.track && g.base.includes(c.behavesLike)).map((c) => c.key)]);
    if (i.keys.some((k) => !valid.has(k)) || new Set(i.keys).size !== i.keys.length) throw bad('Ordre invalide');
    const order = await getRaw<Record<string, string[]>>(ctx.db, STATUS_ORDER_KEY, {});
    await setRaw(ctx.db, STATUS_ORDER_KEY, { ...order, [i.group]: i.keys }, me(ctx));
    ctx.emit({ type: 'settings' });
    return { ok: true };
  }),

  // ---------- pay plans, call timing, payslips
  'admin.pay.get': proc([], z.object({}), async (ctx) => ({ plans: await getSetting(ctx.db, 'payPlans'), calls: await getSetting(ctx.db, 'calls'), teams: await getSetting(ctx.db, 'teams') })),
  'admin.pay.savePlans': proc([], PayPlans, async (ctx, i) => {
    await setSetting(ctx.db, 'payPlans', i, me(ctx));
    return { ok: true };
  }),
  'admin.calls.save': proc([], CallsInput, async (ctx, i) => {
    for (const s of i.slots) if (s.to <= s.from) throw bad('Un créneau doit finir après son début');
    await setSetting(ctx.db, 'calls', i, me(ctx));
    ctx.emit({ type: 'settings' });
    return { ok: true };
  }),
  'admin.payroll': proc([], z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), async (ctx, i) => computePayroll(ctx.db, i.month)),

  // ---------- client delivery prices
  'admin.fees.get': proc([], z.object({}), async (ctx) => {
    const products = await ctx.db.query('SELECT id, name, sku, fee_grid, active, weight_kg FROM products ORDER BY name');
    return {
      grids: await getSetting(ctx.db, 'clientFees'),
      defaultGrid: await getSetting(ctx.db, 'defaultFeeGrid'),
      savFees: await getSetting(ctx.db, 'savFees'),
      products: products.map((p: any) => ({ id: num(p.id), name: p.name as string, sku: p.sku as string, feeGrid: (p.fee_grid as string | null) ?? null, active: !!p.active, weightKg: Number(p.weight_kg) })),
    };
  }),
  /** Creates or replaces a grid (optionally renaming it). New grids start as a copy of `copyFrom` or of the default company's tariffs. */
  'admin.fees.saveGrid': proc(
    [],
    z.object({ name: GridName, oldName: GridName.optional(), rows: z.record(z.string().regex(/^\d{1,2}$/), FeeRow).optional(), copyFrom: GridName.optional() }),
    async (ctx, i) => {
      const grids = { ...(await getSetting(ctx.db, 'clientFees')) };
      if (i.oldName && i.oldName !== i.name && !grids[i.oldName]) throw notFound('Prix introuvable');
      if ((!i.oldName || i.oldName !== i.name) && grids[i.name]) throw bad('Ce nom existe déjà');
      let rows = i.rows;
      if (!rows) rows = i.copyFrom ? grids[i.copyFrom] : i.oldName ? grids[i.oldName] : await gridFromCompany(ctx.db, (await getSetting(ctx.db, 'shop')).defaultCompanyId);
      if (!rows) throw notFound('Prix à copier introuvable');
      for (const k of Object.keys(rows)) if (Number(k) < 1 || Number(k) > 69) throw bad('Wilaya invalide');
      const full: Record<string, { home: number; desk: number }> = {};
      for (let w = 1; w <= 69; w++) if (rows[String(w)]) full[String(w)] = rows[String(w)];
      if (i.oldName && i.oldName !== i.name) {
        delete grids[i.oldName];
        await ctx.db.query('UPDATE products SET fee_grid = $2 WHERE fee_grid = $1', [i.oldName, i.name]);
        if ((await getSetting(ctx.db, 'defaultFeeGrid')) === i.oldName) await setSetting(ctx.db, 'defaultFeeGrid', i.name, me(ctx));
      }
      grids[i.name] = full;
      await setSetting(ctx.db, 'clientFees', grids, me(ctx));
      if (Object.keys(grids).length === 1) await setSetting(ctx.db, 'defaultFeeGrid', i.name, me(ctx));
      return { ok: true };
    },
  ),
  /** The SAV tickets' own delivery tariff (wilaya → { home, desk }). */
  'admin.fees.saveSav': proc([], z.object({ rows: z.record(z.string().regex(/^\d{1,2}$/), FeeRow) }), async (ctx, i) => {
    const full: Record<string, { home: number; desk: number }> = {};
    for (const k of Object.keys(i.rows)) if (Number(k) < 1 || Number(k) > 69) throw bad('Wilaya invalide');
    for (let w = 1; w <= 69; w++) if (i.rows[String(w)]) full[String(w)] = i.rows[String(w)];
    await setSetting(ctx.db, 'savFees', full, me(ctx));
    return { ok: true };
  }),
  'admin.fees.deleteGrid': proc([], z.object({ name: GridName }), async (ctx, i) => {
    const grids = { ...(await getSetting(ctx.db, 'clientFees')) };
    if (!grids[i.name]) throw notFound('Prix introuvable');
    if ((await getSetting(ctx.db, 'defaultFeeGrid')) === i.name && Object.keys(grids).length > 1) throw bad('Choisissez d’abord un autre prix par défaut');
    delete grids[i.name];
    await setSetting(ctx.db, 'clientFees', grids, me(ctx));
    await ctx.db.query('UPDATE products SET fee_grid = NULL WHERE fee_grid = $1', [i.name]);
    return { ok: true };
  }),
  'admin.fees.setDefault': proc([], z.object({ name: GridName }), async (ctx, i) => {
    if (!(await getSetting(ctx.db, 'clientFees'))[i.name]) throw notFound('Prix introuvable');
    await setSetting(ctx.db, 'defaultFeeGrid', i.name, me(ctx));
    return { ok: true };
  }),
  /** The products that use this grid (exactly this list; the others go back to the default). */
  'admin.fees.assign': proc([], z.object({ name: GridName, productIds: z.array(id).max(5000) }), async (ctx, i) => {
    if (!(await getSetting(ctx.db, 'clientFees'))[i.name]) throw notFound('Prix introuvable');
    await ctx.db.tx(async (tx) => {
      await tx.query('UPDATE products SET fee_grid = NULL WHERE fee_grid = $1 AND NOT (id = ANY($2))', [i.name, i.productIds]);
      if (i.productIds.length) await tx.query('UPDATE products SET fee_grid = $1 WHERE id = ANY($2)', [i.name, i.productIds]);
    });
    return { ok: true };
  }),

  // ---------- sales channels
  'admin.channels.list': proc([], z.object({ q: z.string().max(100).optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(5).max(100).default(15) }), async (ctx, i) => {
    const q = i.q?.trim() ? `%${i.q.trim()}%` : null;
    const where = `WHERE ($1::text IS NULL OR c.name ILIKE $1 OR c.kind ILIKE $1 OR c.id::text = $2)`;
    const total = num((await ctx.db.query(`SELECT count(*) AS n FROM sales_channels c ${where}`, [q, i.q?.trim() ?? '']))[0].n);
    const rows = await ctx.db.query(
      `SELECT c.*, p.name AS creator_name FROM sales_channels c LEFT JOIN profiles p ON p.id = c.creator_id ${where} ORDER BY c.id DESC LIMIT $3 OFFSET $4`,
      [q, i.q?.trim() ?? '', i.pageSize, (i.page - 1) * i.pageSize],
    );
    return { rows: rows.map(toChannel), total, page: i.page, pageSize: i.pageSize };
  }),
  'admin.channels.save': proc(
    [],
    z.object({
      id: id.optional(),
      kind: z.enum(CHANNEL_KINDS),
      name: z.string().trim().min(2).max(80),
      creatorId: id.nullable().optional(),
      skuRequired: z.boolean().default(false),
      active: z.boolean().default(true),
      url: z.string().trim().max(500).optional(),
    }),
    async (ctx, i) => {
      if (i.kind === 'sheets' && !/^https:\/\/docs\.google\.com\/spreadsheets\//.test(i.url ?? '')) throw bad('Collez le lien de la feuille Google (publiée sur le web)');
      // a sheet keeps its column choices (Google Sheets channel) when it is renamed; a new sheet link starts again
      const before = i.id ? (await ctx.db.query('SELECT config FROM sales_channels WHERE id = $1', [i.id]))[0] : null;
      const old = before ? (typeof before.config === 'string' ? JSON.parse(before.config) : before.config ?? {}) : {};
      const keep = old.mapping && old.url === i.url ? { mapping: old.mapping } : {};
      const config = JSON.stringify(i.url ? { url: i.url, ...keep } : {});
      let r: any;
      if (i.id) {
        r = (
          await ctx.db.query(
            'UPDATE sales_channels SET kind=$2, name=$3, creator_id=$4, sku_required=$5, active=$6, config=$7 WHERE id=$1 RETURNING *',
            [i.id, i.kind, i.name, i.creatorId ?? null, i.skuRequired, i.active, config],
          )
        )[0];
        if (!r) throw notFound('Canal introuvable');
      } else {
        r = (
          await ctx.db.query(
            'INSERT INTO sales_channels (kind, name, creator_id, sku_required, active, config, webhook_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [i.kind, i.name, i.creatorId ?? me(ctx), i.skuRequired, i.active, config, randomKey(28)],
          )
        )[0];
      }
      return toChannel(r);
    },
  ),
  'admin.channels.toggle': proc([], z.object({ id, field: z.enum(['active', 'skuRequired']), value: z.boolean() }), async (ctx, i) => {
    const col = i.field === 'active' ? 'active' : 'sku_required';
    const r = await ctx.db.query(`UPDATE sales_channels SET ${col} = $2 WHERE id = $1 RETURNING id`, [i.id, i.value]);
    if (!r.length) throw notFound('Canal introuvable');
    return { ok: true };
  }),
  'admin.channels.rotateKey': proc([], z.object({ id }), async (ctx, i) => {
    const r = await ctx.db.query('UPDATE sales_channels SET webhook_key = $2 WHERE id = $1 RETURNING *', [i.id, randomKey(28)]);
    if (!r.length) throw notFound('Canal introuvable');
    return toChannel(r[0]);
  }),
  'admin.channels.delete': proc([], z.object({ id }), async (ctx, i) => {
    await ctx.db.query('DELETE FROM sales_channels WHERE id = $1', [i.id]);
    return { ok: true };
  }),

  // ---------- Réglages
  'admin.settings.get': proc([], z.object({}), async (ctx) => {
    const meta = await getSetting(ctx.db, 'meta');
    return {
      shop: await getSetting(ctx.db, 'shop'),
      calls: await getSetting(ctx.db, 'calls'),
      webhook: await getSetting(ctx.db, 'webhook'),
      cron: await getSetting(ctx.db, 'cron'),
      // token is write-only: only "connected" is ever sent back
      meta: { adAccountId: meta.adAccountId, connected: meta.hasToken && !!(await getRaw<string>(ctx.db, META_TOKEN_KEY, '')) },
      lastSync: await getRaw<{ at: string; checked: number; changed: number } | null>(ctx.db, 'courier_last_sync', null),
    };
  }),
  'admin.shop.save': proc(
    [],
    z.object({
      name: z.string().trim().min(1).max(80),
      fromWilayaId: z.number().int().min(1).max(69),
      defaultCompanyId: id.nullable(),
      whatsappTemplate: z.string().trim().max(500),
      cancelAfterNoAnswer: z.number().int().min(0).max(30),
      savPhone: z.string().trim().max(40).optional(),
    }),
    async (ctx, i) => {
      if (i.defaultCompanyId && !(await ctx.db.query('SELECT 1 FROM delivery_companies WHERE id = $1', [i.defaultCompanyId])).length) throw notFound('Société introuvable');
      const savPhone = i.savPhone ?? (await getSetting(ctx.db, 'shop')).savPhone;
      await setSetting(ctx.db, 'shop', { name: i.name, fromWilayaId: i.fromWilayaId, defaultCompanyId: i.defaultCompanyId, whatsappTemplate: i.whatsappTemplate || DEFAULT_SETTINGS.shop.whatsappTemplate, savPhone }, me(ctx));
      const calls = await getSetting(ctx.db, 'calls');
      await setSetting(ctx.db, 'calls', { ...DEFAULT_CALL_SETTINGS, ...calls, cancelAfterNoAnswer: i.cancelAfterNoAnswer }, me(ctx));
      ctx.emit({ type: 'settings' });
      return { ok: true };
    },
  ),
  'admin.warehouses.list': proc([], z.object({}), async (ctx) => (await ctx.db.query('SELECT * FROM warehouses ORDER BY is_default DESC, name')).map(toWarehouse)),
  'admin.warehouses.save': proc(
    [],
    z.object({ id: id.optional(), name: z.string().trim().min(2).max(80), wilayaId: z.number().int().min(1).max(69), commune: z.string().trim().max(120).default(''), address: z.string().trim().max(300).default(''), isDefault: z.boolean().default(false), active: z.boolean().default(true) }),
    async (ctx, i) => {
      if (i.isDefault && !i.active) throw bad('Le dépôt par défaut doit rester actif');
      return ctx.db.tx(async (tx) => {
        let r: any;
        if (i.id) {
          const cur = (await tx.query('SELECT * FROM warehouses WHERE id = $1', [i.id]))[0];
          if (!cur) throw notFound('Dépôt introuvable');
          if (cur.is_default && !i.isDefault) throw bad('Choisissez un autre dépôt par défaut à la place');
          r = (await tx.query('UPDATE warehouses SET name=$2, wilaya_id=$3, commune=$4, address=$5, is_default=$6, active=$7 WHERE id=$1 RETURNING *', [i.id, i.name, i.wilayaId, i.commune, i.address, i.isDefault, i.active]))[0];
        } else {
          const first = !(await tx.query('SELECT 1 FROM warehouses LIMIT 1')).length;
          r = (await tx.query('INSERT INTO warehouses (name, wilaya_id, commune, address, is_default, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.name, i.wilayaId, i.commune, i.address, i.isDefault || first, i.active]))[0];
        }
        if (r.is_default) await tx.query('UPDATE warehouses SET is_default = false WHERE id <> $1', [r.id]);
        return toWarehouse(r);
      });
    },
  ),
  /** Deletes an unused depot; a depot with stock or orders can only be deactivated. */
  'admin.warehouses.delete': proc([], z.object({ id }), async (ctx, i) => {
    const w = (await ctx.db.query('SELECT * FROM warehouses WHERE id = $1', [i.id]))[0];
    if (!w) throw notFound('Dépôt introuvable');
    if (w.is_default) throw bad('Le dépôt par défaut ne se supprime pas');
    const used = (await ctx.db.query('SELECT (SELECT count(*) FROM stock WHERE warehouse_id = $1 AND qty <> 0) + (SELECT count(*) FROM orders WHERE warehouse_id = $1) + (SELECT count(*) FROM stock_movements WHERE warehouse_id = $1) AS n', [i.id]))[0];
    if (num(used.n) > 0) throw bad('Ce dépôt a du stock ou des commandes : désactivez-le plutôt');
    await ctx.db.query('DELETE FROM stock WHERE warehouse_id = $1', [i.id]);
    await ctx.db.query('DELETE FROM warehouses WHERE id = $1', [i.id]);
    return { ok: true };
  }),
  'admin.webhook.rotate': proc([], z.object({}), async (ctx) => {
    const key = randomKey(32);
    await setSetting(ctx.db, 'webhook', { key }, me(ctx));
    return { key };
  }),
  'admin.cron.rotate': proc([], z.object({}), async (ctx) => {
    const key = randomKey(32);
    await setSetting(ctx.db, 'cron', { key }, me(ctx));
    return { key };
  }),
  /** "Simuler une commande du site": creates an order exactly as the website webhook would. */
  'admin.webhook.simulate': proc([], z.object({}), async (ctx) => {
    const p = (await ctx.db.query(`SELECT p.id, v.id AS vid FROM products p LEFT JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active ORDER BY random() LIMIT 1`))[0];
    if (!p) throw bad('Ajoutez d’abord un produit');
    const names = ['Amina Boudiaf', 'Yasmine Kaci', 'Nour Haddad', 'Sara Meziane', 'Lamia Touati'];
    const o = await createOrder(ctx, {
      customerName: names[Math.floor(Math.random() * names.length)],
      phone: `05${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      wilayaId: 16,
      commune: 'Rouiba',
      address: 'Cité 200 logements',
      isStopdesk: false,
      channel: 'site',
      source: 'site (simulation)',
      items: [{ productId: num(p.id), variantId: p.vid === null ? null : num(p.vid), qty: 1 }],
      discount: 0,
      customerNote: 'Appeler après 17 h',
      confirm: false,
      isExchange: false,
      utm: { utm_campaign: 'simulation' },
    });
    await sendInPreview(ctx);
    return { id: o.id, ref: o.ref };
  }),
  /** Meta Ads connection. The token is write-only: stored under its own key, never returned. */
  'admin.meta.save': proc([], z.object({ adAccountId: z.string().trim().regex(/^(act_)?\d{5,25}$/, 'ID du compte pub (chiffres)'), token: z.string().trim().min(20).max(1000).optional() }), async (ctx, i) => {
    const adAccountId = i.adAccountId.replace(/^act_/, '');
    if (i.token) await setRaw(ctx.db, META_TOKEN_KEY, i.token, me(ctx));
    const hasToken = !!(await getRaw<string>(ctx.db, META_TOKEN_KEY, ''));
    await setSetting(ctx.db, 'meta', { adAccountId, hasToken }, me(ctx));
    let test: { ok: boolean; name?: string; message?: string } | null = null;
    if (ctx.server && hasToken) {
      try {
        const r = (await ctx.server.meta('test', {}, ctx)) as { name?: string };
        test = { ok: true, name: r?.name };
      } catch (e: any) {
        test = { ok: false, message: e?.message ?? 'Erreur Meta' };
      }
    }
    return { adAccountId, connected: hasToken, test };
  }),
  'admin.meta.disconnect': proc([], z.object({}), async (ctx) => {
    await ctx.db.query('DELETE FROM settings WHERE key = $1', [META_TOKEN_KEY]);
    const meta = await getSetting(ctx.db, 'meta');
    await setSetting(ctx.db, 'meta', { ...meta, hasToken: false }, me(ctx));
    return { ok: true };
  }),
};

// keep the types handy for the web (pages/admin)
export type PayrollResult = Awaited<ReturnType<typeof computePayroll>>;
export type ShopSettings = SettingsMap['shop'];
void iso;
void forbidden;
