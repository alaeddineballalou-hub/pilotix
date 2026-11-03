// « Copier des réglages »: the owner of several boutiques gives one of them what another one is already set up with, so a
// new boutique starts like the others instead of being set up again by hand. Only how a boutique works:
//  - couriers: its delivery companies (their keys when asked, what they charge, their bureaus, the status choices),
//    « Pilot Auto Assign », the wilaya parcels leave from, the default company and the companies' preferences;
//  - fees: the customers' delivery prices (the grids, SAV, overweight);
//  - statuses: renamed and added statuses, their order, the reasons of Suivi;
//  - work: calls, automatic assignment, pay, the client score, Suivi's clock, goals, the column presets…;
//  - messages: the messages sent to customers and the livreur's ready messages;
//  - pages: the landing pages' settings (when a sale counts, the reminder, the WhatsApp button);
//  - ai: how Message AI agent and CM AI agent talk and work.
// Never the orders, products, stock, customers, team, money, linked Facebook / WhatsApp / TikTok accounts, pixels or
// secrets of the agents. What the other boutique never set is left as it is; companies are added or updated (none is
// removed) and only missing bureaus are added, so the orders there keep theirs. People and products named in the
// settings (an agent's choices, a rule for some products) are found again by their e-mail and their SKU or name; a rule
// whose products are not in this boutique is left out (it never becomes a rule for every product).
import { CLASH_ASSIGN, type PilotConfig } from '@pilotix/shared';
import { z } from 'zod';
import type { Db } from '../db';
import { num } from '../db';
import { loadShop, type Shop } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { DEFAULT_SETTINGS, getSetting, setSetting, type AssignAgent, type AssignArea, type SettingsMap, type SuiviMotif } from '../settings';
import { ownBoutique } from './boutiques';

export const COPY_PARTS = ['couriers', 'fees', 'statuses', 'work', 'messages', 'pages', 'ai'] as const;
export type CopyPart = (typeof COPY_PARTS)[number];

/** The settings rows each part reads (`shop` and `prefs` are shared: each part takes its own fields of them). */
const PART_KEYS: Record<CopyPart, string[]> = {
  couriers: ['pilot', 'shop', 'prefs'],
  fees: ['clientFees', 'defaultFeeGrid', 'savFees', 'weightFees'],
  statuses: ['statusLabels', 'customStatuses', 'suiviMotifs', 'statusOrder'],
  work: ['calls', 'autoAssign', 'payPlans', 'clientScore', 'goals', 'caisses', 'colPresets', 'colPresetActive', 'depotAlerts', 'mgrScope', 'prefs'],
  messages: ['notify', 'livreurMessages', 'shop'],
  pages: ['landing'],
  ai: ['dellal', 'cm'],
};
const ALL_KEYS = [...new Set(Object.values(PART_KEYS).flat())];

/** The parts of `prefs` that belong to the delivery companies (the rest is Suivi's and the depot's rules). */
const PREFS_COURIERS = ['manualDefault', 'changeCompany', 'strictLock', 'rulesBy', 'privateBackup', 'livreurAlerts'] as const;
const PREFS_WORK = ['noStockDays', 'suiviClock', 'suiviTries', 'suiviStuck'] as const;
/** Message AI agent: how it talks and works (not whether it is on, nor the Page / Instagram / WhatsApp it answers on). */
const DELLAL_FIELDS = ['version', 'name', 'tone', 'languages', 'ordersTo', 'model', 'allowDiscount', 'followUpHours', 'nightReplies', 'notes', 'handoffTopics', 'servicePhone', 'darijaPrefer', 'darijaAvoid'];
/** Messages to customers: the texts and when they leave (not the WhatsApp account, its approved templates, the SMS phone). */
const NOTIFY_FIELDS = ['enabled', 'lang', 'cases', 'texts', 'whatsapp', 'sms', 'quietFrom', 'quietTo'];
/** Landing pages: how they work (not their link, pixel, robot check or the products left without a page). */
const LANDING_FIELDS = ['purchaseAt', 'abandonAfterMin', 'autoCreate', 'whatsapp'] as const;

const parseJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : (v ?? {}));
const companyKey = (kind: string, name: string) => `${kind}|${String(name).trim().toLowerCase()}`;
const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
/** Keys in one order, to compare two sets of courier keys. */
const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export interface CopyPreview {
  /** the other boutique's delivery companies: whether their keys are typed, whether this boutique has one of that name */
  companies: { name: string; kind: string; keys: boolean; there: boolean }[];
  /** whether the other boutique set anything of each part (a part it never touched changes nothing here) */
  set: Record<CopyPart, boolean>;
}

export interface CopyResult {
  parts: CopyPart[];
  /** companies added here, and the ones already here that were updated */
  added: string[];
  updated: string[];
}

/** What another boutique holds of each part, for the choice. */
export async function copyPreview(from: Db, to: Db): Promise<CopyPreview> {
  const companies = await from.query('SELECT name, kind, credentials FROM delivery_companies ORDER BY id');
  const there = new Set((await to.query('SELECT name, kind FROM delivery_companies')).map((r: any) => companyKey(r.kind, r.name)));
  const keys = new Set((await from.query('SELECT key FROM settings WHERE key = ANY($1)', [ALL_KEYS])).map((r: any) => String(r.key)));
  const shop = keys.has('shop') ? await getSetting(from, 'shop') : null;
  const set = Object.fromEntries(
    COPY_PARTS.map((p) => {
      const own = PART_KEYS[p].filter((k) => k !== 'shop' && k !== 'prefs').some((k) => keys.has(k));
      if (p === 'couriers') return [p, companies.length > 0 || own];
      if (p === 'work') return [p, own || keys.has('prefs')];
      if (p === 'messages') return [p, own || (!!shop && shop.whatsappTemplate !== DEFAULT_SETTINGS.shop.whatsappTemplate)];
      return [p, own];
    }),
  ) as Record<CopyPart, boolean>;
  return {
    companies: companies.map((c: any) => ({
      name: String(c.name),
      kind: String(c.kind),
      keys: Object.entries(parseJson(c.credentials) as Record<string, unknown>).some(([k, v]) => k !== 'webhook_key' && String(v ?? '').trim() !== ''),
      there: there.has(companyKey(c.kind, c.name)),
    })),
    set,
  };
}

/** Same people (by e-mail) in both boutiques: their id there → their id here. */
async function peopleMap(from: Db, to: Db): Promise<Map<number, number>> {
  const q = `SELECT id, lower(email) AS e FROM profiles WHERE email IS NOT NULL AND email <> ''`;
  const here = new Map((await to.query(q)).map((r: any) => [String(r.e), num(r.id)]));
  const out = new Map<number, number>();
  for (const r of (await from.query(q)) as any[]) {
    const id = here.get(String(r.e));
    if (id) out.set(num(r.id), id);
  }
  return out;
}

/** Same products in both boutiques (by SKU, else by a name used once here): their id there → their id here. */
async function productMap(from: Db, to: Db): Promise<Map<number, number>> {
  const q = 'SELECT id, sku, lower(trim(name)) AS n FROM products';
  const mine = (await to.query(q)) as any[];
  const bySku = new Map(mine.map((r) => [String(r.sku), num(r.id)]));
  const byName = new Map<string, number | null>();
  for (const r of mine) byName.set(String(r.n), byName.has(String(r.n)) ? null : num(r.id));
  const out = new Map<number, number>();
  for (const r of (await from.query(q)) as any[]) {
    const id = bySku.get(String(r.sku)) ?? byName.get(String(r.n)) ?? null;
    if (id) out.set(num(r.id), id);
  }
  return out;
}

const mapped = (ids: readonly number[] | undefined, m: Map<number, number>) => (ids ?? []).map((x) => m.get(Number(x))).filter((x): x is number => !!x);

/** « Pilot Auto Assign » with this boutique's companies and products; a rule that cannot follow is left out. */
export function mapPilot(p: PilotConfig, companies: Map<number, number>, products: Map<number, number>): PilotConfig {
  const rules: PilotConfig['rules'] = [];
  for (const r of p.rules ?? []) {
    const to = companies.get(Number(r.to));
    if (!to) continue;
    const prods = mapped(r.products, products);
    // a rule for some products stays a rule for those products: none of them here, no rule (never « every product »)
    if ((r.products ?? []).length && !prods.length) continue;
    rules.push({ ...r, to, products: prods });
  }
  const ids = new Set(rules.map((r) => r.id));
  const clashes = (p.clashes ?? []).filter((c) => ids.has(c.a) && ids.has(c.b) && (c.win === CLASH_ASSIGN || ids.has(c.win)));
  return { mode: p.mode, rules, clashes };
}

/** Automatic assignment with this boutique's people and products (the people of this boutique alone keep theirs). */
function mapAssign(src: SettingsMap['autoAssign'], cur: SettingsMap['autoAssign'], people: Map<number, number>, products: Map<number, number>): SettingsMap['autoAssign'] {
  const area = (a: AssignArea): AssignArea => ({ ...a, rotation: { ...a.rotation, target: a.rotation?.target != null ? (people.get(Number(a.rotation.target)) ?? null) : null } });
  const agents: Record<string, AssignAgent> = { ...(cur.agents ?? {}) };
  for (const [k, v] of Object.entries(src.agents ?? {})) {
    const id = people.get(Number(k));
    if (!id) continue;
    const prods = mapped(v.products, products);
    // his products are not sold here: his own choice here stays (never « everything » by mistake)
    agents[String(id)] = { ...v, products: (v.products ?? []).length && !prods.length ? (cur.agents?.[String(id)]?.products ?? []) : prods };
  }
  const order = mapped(src.order, people);
  return {
    conf: area(src.conf),
    follow: area(src.follow),
    agents,
    order: [...order, ...(cur.order ?? []).filter((x) => !order.includes(x))],
    womenProducts: [...new Set([...mapped(src.womenProducts, products), ...(cur.womenProducts ?? [])])],
  };
}

/** A list of keyed items: the other boutique's first, then the ones only this boutique has. */
function byKey<T extends { key: string }>(src: T[] | undefined, cur: T[] | undefined): T[] {
  const keys = new Set((src ?? []).map((x) => x.key));
  return [...(src ?? []), ...(cur ?? []).filter((x) => !keys.has(x.key))];
}

/**
 * Copies the chosen parts from one boutique's database to another's. Everything is read from the other boutique first,
 * then written here in one transaction (the in-browser preview has one connection: a transaction never reads another
 * boutique). `by`: the person, when this boutique is the one open (settings keep who changed them).
 */
export async function copyBoutique(from: Db, to: Db, parts: readonly CopyPart[], opts: { keys: boolean; by?: number | null }): Promise<CopyResult> {
  const want = new Set(parts);
  const rows = new Map(((await from.query('SELECT key, value FROM settings WHERE key = ANY($1)', [ALL_KEYS])) as any[]).map((r) => [String(r.key), parseJson(r.value)]));
  /** the other boutique's setting with its defaults, or null when it never set it */
  const src = <K extends keyof SettingsMap>(k: K): SettingsMap[K] | null => {
    if (!rows.has(k)) return null;
    const d = DEFAULT_SETTINGS[k];
    const v = rows.get(k);
    return typeof d === 'object' && d !== null && !Array.isArray(d) && typeof v === 'object' && v !== null && !Array.isArray(v) ? ({ ...d, ...v } as SettingsMap[K]) : (v as SettingsMap[K]);
  };
  const companies = want.has('couriers') ? ((await from.query('SELECT id, name, kind, active, phone, credentials, config FROM delivery_companies ORDER BY id')) as any[]) : [];
  const fees = companies.length ? ((await from.query('SELECT company_id, wilaya_id, home, desk, return_fee FROM delivery_fees')) as any[]) : [];
  const desks = companies.length ? ((await from.query('SELECT company_id, wilaya_id, commune, name, address, ext_id FROM stopdesks ORDER BY id')) as any[]) : [];
  const people = want.has('work') ? await peopleMap(from, to) : new Map<number, number>();
  const products = want.has('couriers') || want.has('work') ? await productMap(from, to) : new Map<number, number>();
  const by = opts.by ?? undefined;
  const result: CopyResult = { parts: COPY_PARTS.filter((p) => want.has(p)), added: [], updated: [] };

  await to.tx(async (tx) => {
    const put = <K extends keyof SettingsMap>(k: K, v: SettingsMap[K]) => setSetting(tx, k, v, by);
    const raw = async (k: string) => parseJson((await tx.query('SELECT value FROM settings WHERE key = $1', [k]))[0]?.value ?? {});
    const putRaw = (k: string, v: unknown) =>
      tx.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, [k, JSON.stringify(v), by ?? null]);
    const copy = async <K extends keyof SettingsMap>(k: K) => {
      const v = src(k);
      if (v !== null) await put(k, v);
    };

    // ------------------------------------------------ the delivery companies
    const companyIds = new Map<number, number>();
    if (want.has('couriers')) {
      const here = new Map(((await tx.query('SELECT id, name, kind, credentials, config FROM delivery_companies')) as any[]).map((r) => [companyKey(r.kind, r.name), r]));
      for (const c of companies) {
        const cfg = parseJson(c.config);
        // the courier's webhook was made for the other boutique's address (its id there, its key here): this one makes its own
        const { webhook_id: _wh, ...settings } = (cfg.settings ?? {}) as Record<string, unknown>;
        const { webhook_key: _wk, ...keys } = parseJson(c.credentials) as Record<string, unknown>;
        const hasKeys = Object.values(keys).some((v) => String(v ?? '').trim() !== '');
        const cur = here.get(companyKey(c.kind, c.name));
        let id: number;
        if (cur) {
          id = num(cur.id);
          const curCred = parseJson(cur.credentials) as Record<string, unknown>;
          const { webhook_key: ownKey, ...curKeys } = curCred;
          // the same account (or its keys kept): its webhook stays; another account's keys: the webhook goes with the old
          // account (the parcels are followed by asking the company until it is turned on again)
          const newKeys = opts.keys && hasKeys && JSON.stringify(sortKeys(keys)) !== JSON.stringify(sortKeys(curKeys));
          const own = newKeys ? null : parseJson(cur.config)?.settings?.webhook_id;
          const next = JSON.stringify({ ...cfg, settings: own ? { ...settings, webhook_id: own } : settings });
          const cred = newKeys ? keys : ownKey !== undefined ? { ...curKeys, webhook_key: ownKey } : curKeys;
          await tx.query('UPDATE delivery_companies SET active = $2, phone = $3, config = $4, credentials = $5 WHERE id = $1', [id, !!c.active, c.phone ?? null, next, JSON.stringify(cred)]);
          result.updated.push(String(c.name));
        } else {
          id = num(
            (
              await tx.query('INSERT INTO delivery_companies (name, kind, active, phone, credentials, config) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
                c.name,
                c.kind,
                !!c.active,
                c.phone ?? null,
                JSON.stringify(opts.keys ? keys : {}),
                JSON.stringify({ ...cfg, settings }),
              ])
            )[0].id,
          );
          result.added.push(String(c.name));
        }
        companyIds.set(num(c.id), id);
        // what the company charges, wilaya by wilaya
        const f = fees.filter((x) => num(x.company_id) === num(c.id));
        if (f.length)
          await tx.query(
            `INSERT INTO delivery_fees (company_id, wilaya_id, home, desk, return_fee)
             SELECT $1, w, h, d, r FROM unnest($2::smallint[], $3::int[], $4::int[], $5::int[]) AS x(w, h, d, r)
             ON CONFLICT (company_id, wilaya_id) DO UPDATE SET home = EXCLUDED.home, desk = EXCLUDED.desk, return_fee = EXCLUDED.return_fee`,
            [id, f.map((x) => num(x.wilaya_id)), f.map((x) => num(x.home)), f.map((x) => num(x.desk)), f.map((x) => num(x.return_fee))],
          );
        // its bureaus: the missing ones are added (the orders here keep the ones they have)
        const d = desks.filter((x) => num(x.company_id) === num(c.id));
        if (d.length) {
          const have = (await tx.query('SELECT wilaya_id, lower(name) AS n, ext_id FROM stopdesks WHERE company_id = $1', [id])) as any[];
          const ext = new Set(have.filter((h) => h.ext_id).map((h) => String(h.ext_id)));
          const named = new Set(have.map((h) => `${num(h.wilaya_id)}|${h.n}`));
          const add = d.filter((x) => (x.ext_id ? !ext.has(String(x.ext_id)) : !named.has(`${num(x.wilaya_id)}|${String(x.name).toLowerCase()}`)));
          if (add.length)
            await tx.query(
              `INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address, ext_id)
               SELECT $1, w, c, n, a, e FROM unnest($2::smallint[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(w, c, n, a, e)`,
              [id, add.map((x) => num(x.wilaya_id)), add.map((x) => String(x.commune ?? '')), add.map((x) => String(x.name)), add.map((x) => String(x.address ?? '')), add.map((x) => (x.ext_id ? String(x.ext_id) : null))],
            );
        }
      }
      const pilot = src('pilot');
      if (pilot) await put('pilot', mapPilot(pilot, companyIds, products));
    }

    // ------------------------------------------------ `shop` and `prefs`: each part its own fields
    const shopSrc = src('shop');
    if (shopSrc && (want.has('couriers') || want.has('messages'))) {
      const cur = await getSetting(tx, 'shop');
      const next = { ...cur };
      if (want.has('couriers')) {
        next.fromWilayaId = shopSrc.fromWilayaId;
        const def = shopSrc.defaultCompanyId != null ? companyIds.get(Number(shopSrc.defaultCompanyId)) : null;
        next.defaultCompanyId = def === undefined ? cur.defaultCompanyId : def;
      }
      if (want.has('messages')) next.whatsappTemplate = shopSrc.whatsappTemplate;
      await put('shop', next);
    }
    const prefsSrc = src('prefs');
    if (prefsSrc && (want.has('couriers') || want.has('work'))) {
      const cur = await getSetting(tx, 'prefs');
      const next: SettingsMap['prefs'] = { ...cur };
      if (want.has('couriers')) {
        Object.assign(next, pick(prefsSrc as any, PREFS_COURIERS));
        const pb = prefsSrc.privateBackup;
        const cid = pb?.companyId != null ? (companyIds.get(Number(pb.companyId)) ?? null) : null;
        if (pb) next.privateBackup = { ...pb, companyId: cid, on: !!pb.on && (pb.companyId == null || cid != null) };
      }
      if (want.has('work')) Object.assign(next, pick(prefsSrc as any, PREFS_WORK));
      await put('prefs', next);
    }

    // ------------------------------------------------ the customers' delivery prices
    if (want.has('fees')) for (const k of ['clientFees', 'defaultFeeGrid', 'savFees', 'weightFees'] as const) await copy(k);

    // ------------------------------------------------ statuses and reasons (the ones only this boutique has stay)
    if (want.has('statuses')) {
      const labels = src('statusLabels');
      if (labels) await put('statusLabels', { ...(await getSetting(tx, 'statusLabels')), ...labels });
      const custom = src('customStatuses');
      if (custom) await put('customStatuses', byKey(custom, await getSetting(tx, 'customStatuses')));
      const motifs = src('suiviMotifs');
      if (motifs) {
        const cur = await getSetting(tx, 'suiviMotifs');
        await put('suiviMotifs', { resolved: byKey<SuiviMotif>(motifs.resolved, cur.resolved), lost: byKey<SuiviMotif>(motifs.lost, cur.lost) });
      }
      if (rows.has('statusOrder')) {
        const order = (rows.get('statusOrder') ?? {}) as Record<string, string[]>;
        const cur = (await raw('statusOrder')) as Record<string, string[]>;
        const next: Record<string, string[]> = { ...cur };
        for (const [g, list] of Object.entries(order)) if (Array.isArray(list)) next[g] = [...list, ...(cur[g] ?? []).filter((k) => !list.includes(k))];
        await putRaw('statusOrder', next);
      }
    }

    // ------------------------------------------------ how the team works
    if (want.has('work')) {
      for (const k of ['calls', 'payPlans', 'clientScore', 'goals', 'caisses', 'colPresets', 'colPresetActive'] as const) await copy(k);
      const assign = src('autoAssign');
      if (assign) await put('autoAssign', mapAssign(assign, await getSetting(tx, 'autoAssign'), people, products));
      const alerts = src('depotAlerts');
      if (alerts) {
        const to = mapped(alerts.to, people);
        // the people it went to do not work here: this boutique keeps its own choice (never « everyone » by mistake)
        if (!(alerts.to ?? []).length || to.length) await put('depotAlerts', { to });
      }
      const scope = src('mgrScope');
      if (scope) {
        const next = { ...(await getSetting(tx, 'mgrScope')) };
        for (const [k, v] of Object.entries(scope)) {
          const id = people.get(Number(k));
          if (id) next[String(id)] = v;
        }
        await put('mgrScope', next);
      }
    }

    // ------------------------------------------------ messages to customers
    if (want.has('messages')) {
      await copy('livreurMessages');
      if (rows.has('notify')) await putRaw('notify', { ...(await raw('notify')), ...pick(rows.get('notify'), NOTIFY_FIELDS) });
    }

    // ------------------------------------------------ landing pages
    if (want.has('pages')) {
      const landing = src('landing');
      if (landing) await put('landing', { ...(await getSetting(tx, 'landing')), ...pick(landing as any, LANDING_FIELDS) });
    }

    // ------------------------------------------------ AI agents (on or off stays as it is here)
    if (want.has('ai')) {
      if (rows.has('dellal')) await putRaw('dellal', { ...(await raw('dellal')), ...pick(rows.get('dellal'), DELLAL_FIELDS) });
      if (rows.has('cm')) {
        const { enabled: _on, ...cm } = rows.get('cm') ?? {};
        await putRaw('cm', { ...(await raw('cm')), ...cm });
      }
    }
  });
  return result;
}

/** Writes who copied what in the platform's journal (best effort). */
async function journalCopy(t: Tenancy, toShop: number, who: string, details: Record<string, unknown>) {
  await t.platform.query('INSERT INTO platform.audit (staff_id, staff_name, shop_id, action, details) VALUES (NULL, $1, $2, $3, $4)', [who, toShop, 'shop.settings_copied', JSON.stringify(details)]).catch(() => undefined);
}

/**
 * « Ajouter une boutique » with « Commencer avec les réglages de … »: the new boutique gets everything of one of the
 * person's own boutiques (the same keys at the delivery companies).
 */
export async function copyIntoNewBoutique(t: Tenancy, account: { id: number; email: string }, fromId: number, to: Shop): Promise<CopyResult> {
  const s = await loadShop(t, { id: fromId });
  if (!s || s.kind !== 'store' || s.status === 'deleted' || s.status === 'archived' || s.ownerAccountId !== account.id) throw forbidden('Vous ne pouvez copier que les réglages de vos propres boutiques');
  if (s.id === to.id) throw bad('Choisissez une autre boutique');
  const r = await copyBoutique(t.shop(s.schema), t.shop(to.schema), COPY_PARTS, { keys: true, by: null });
  await journalCopy(t, to.id, account.email, { from: s.id, parts: r.parts, keys: true, atCreation: true });
  return r;
}

const Id = z.number().int().min(0);
const CopyIn = z.object({
  from: Id,
  to: Id,
  parts: z.array(z.enum(COPY_PARTS)).min(1, 'Cochez au moins une partie').max(COPY_PARTS.length),
  /** the same keys at the delivery companies (the same account there) */
  keys: z.boolean().default(true),
});

/** Both boutiques must be the person's own (two different ones). */
async function bothOwn(ctx: Ctx, from: number, to: number) {
  if (from === to) throw bad('Choisissez une autre boutique');
  const why = 'Seul le propriétaire des deux boutiques copie les réglages de l’une dans l’autre';
  const a = await ownBoutique(ctx, from, why);
  const b = await ownBoutique(ctx, to, why);
  return { a, b };
}

export const boutiqueCopyProcs = {
  /** What one of the person's boutiques can give another (« Copier des réglages », in « Mes boutiques »). */
  'boutiques.copyPreview': proc(null, z.object({ from: Id, to: Id }), async (ctx, i): Promise<CopyPreview> => {
    const { a, b } = await bothOwn(ctx, i.from, i.to);
    return copyPreview(a.db, b.db);
  }),

  /** Copies the ticked parts from one of the person's boutiques into another of theirs. */
  'boutiques.copy': proc(null, CopyIn, async (ctx, i): Promise<CopyResult> => {
    const { a, b } = await bothOwn(ctx, i.from, i.to);
    const here = !b.shop || b.shop.id === ctx.shop?.id;
    const r = await copyBoutique(a.db, b.db, [...new Set(i.parts)], { keys: i.keys, by: here ? ctx.session.profile.id : null });
    if (ctx.t) await journalCopy(ctx.t, i.to, ctx.session.profile.email, { from: i.from, parts: r.parts, keys: i.keys });
    if (here) ctx.emit({ type: 'settings' });
    return r;
  }),
};
