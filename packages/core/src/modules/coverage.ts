// Pilot Auto Assign › « À corriger »: what keeps the rules from working.
//  - Communes: an order's commune is matched to the official list by name (accents, spaces, dashes ignored) or its
//    Arabic name, then by sound (« Bab Ezzouar » = « Bab Azzouar », when only one commune fits: listed under « Reconnues
//    toutes seules » so a wrong match can be changed); one Pilotix cannot match is listed with the closest official
//    name — corrected once, it is remembered (commune_aliases) and the waiting orders with it are fixed.
//  - A company with an API whose tariffs were never imported (Pilot cannot know where it delivers).
//  - Where a company delivers comes from the company itself (its tariffs and bureaus), imported again every night and
//    with « Mettre à jour maintenant ». Our own livreurs' zone is set when they are set up (Livreurs).
import { ALL_WILAYAS, communesOf, normCommune, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { KINDS } from '../couriers/kinds';
import { Db, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { deliveryProcs } from './delivery';
import { canRules, pilotMayRun, pilotPick, setPick } from './pilot';

const wid = z.number().int().min(1).max(69);

/** Levenshtein distance (short strings: commune names). */
function dist(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** A commune name as it sounds: the usual ways of writing Algerian names in Latin letters (e/a/i/o/u, ou/u, dj/j,
 *  sh/ch, q/k, double letters, « El »/« Al ») or in Arabic (hamza, ta marbuta, alif maqsura, harakat, « ال ») all give
 *  the same key: « Bab Ezzouar », « Bab Azzouar » and « Bab Ezouar » are one name. */
export function soundKey(s: string | null | undefined): string {
  const raw = String(s ?? '').toLowerCase();
  if (/[\u0600-\u06ff]/.test(raw)) {
    return raw
      .replace(/[\u064b-\u0652\u0640]/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/(^|\s)ال/g, '$1')
      .replace(/[^\u0621-\u064a]/g, '')
      .replace(/(.)\1+/g, '$1');
  }
  return normCommune(raw.replace(/(^|[\s-])(el|al|l)[\s-]+/g, '$1'))
    .replace(/dj/g, 'j')
    .replace(/sh/g, 'ch')
    .replace(/q/g, 'k')
    .replace(/[aeiouy]/g, '')
    .replace(/(.)\1+/g, '$1');
}

/** The official commune a name is surely meant for, matched by Pilotix itself: the same sound key, or one letter off
 *  (names of 6 letters or more) — only when exactly one commune of the wilaya fits, else null (left to « À corriger »). */
export function autoCommune(wilayaId: number, text: string | null | undefined): string | null {
  const k = soundKey(text);
  if (!k || k.length < 2) return null;
  const list = communesOf(wilayaId);
  const same = [...new Set(list.filter((c) => soundKey(c[1]) === k || (c[2] && soundKey(c[2]) === k)).map((c) => c[1]))];
  if (same.length) return same.length === 1 ? same[0] : null;
  const n = normCommune(text);
  if (n.length < 6 || /[\u0600-\u06ff]/.test(n)) return null;
  const near = [...new Set(list.filter((c) => dist(n, normCommune(c[1])) <= 1).map((c) => c[1]))];
  return near.length === 1 ? near[0] : null;
}

/** How an order's commune is recognized: the official name (French or Arabic), the shop's own correction, or matched by Pilotix. */
export async function matchCommune(db: Db, wilayaId: number | null, text: string | null | undefined): Promise<{ commune: string; how: 'exact' | 'alias' | 'auto' } | null> {
  const n = normCommune(text);
  if (!wilayaId || !n) return null;
  const hit = communesOf(wilayaId).find((c) => normCommune(c[1]) === n || (c[2] && normCommune(c[2]) === n));
  if (hit) return { commune: hit[1], how: 'exact' };
  const alias = (await db.query('SELECT commune FROM commune_aliases WHERE wilaya_id = $1 AND alias = $2', [wilayaId, n]))[0]?.commune as string | undefined;
  if (alias) return { commune: alias, how: 'alias' };
  const auto = autoCommune(wilayaId, text);
  return auto ? { commune: auto, how: 'auto' } : null;
}

/** The official commune an order's text names in this wilaya (null: not recognized). */
export async function canonCommune(db: Db, wilayaId: number | null, text: string | null | undefined): Promise<string | null> {
  return (await matchCommune(db, wilayaId, text))?.commune ?? null;
}

/** The closest official commune (a suggestion for « À corriger »), or null when nothing is close. */
export function closestCommune(wilayaId: number, text: string): string | null {
  const n = normCommune(text);
  if (!n) return null;
  let best: { c: string; d: number } | null = null;
  for (const c of communesOf(wilayaId)) {
    const d = Math.min(dist(n, normCommune(c[1])), normCommune(c[1]).includes(n) || n.includes(normCommune(c[1])) ? 1 : 99);
    if (!best || d < best.d) best = { c: c[1], d };
  }
  return best && best.d <= Math.max(2, Math.round(n.length * 0.3)) ? best.c : null;
}

/** Each company: whether it delivers everywhere by itself, and its prices. */
async function companiesWithCoverage(db: Db) {
  const cos = await db.query('SELECT id, name, kind, active FROM delivery_companies ORDER BY active DESC, id');
  const fees = await db.query('SELECT company_id, wilaya_id, home, desk FROM delivery_fees');
  return cos.map((c: any) => {
    const cid = num(c.id);
    const mine = fees.filter((f: any) => num(f.company_id) === cid);
    const price = new Map(mine.map((f: any) => [num(f.wilaya_id), { home: num(f.home), desk: num(f.desk) }]));
    const free = c.kind === 'own' || c.kind === 'manual' || !mine.length;
    const wilayas = ALL_WILAYAS.map((w) => {
      const p = price.get(w) ?? null;
      return { w, home: p ? p.home : null, desk: p ? p.desk : null, served: free || (!!p && (p.home > 0 || p.desk > 0)) };
    });
    return { id: cid, name: String(c.name), kind: String(c.kind), active: !!c.active, own: c.kind === 'own', free, hasApi: !!KINDS[c.kind as keyof typeof KINDS]?.fees, hasFees: mine.length > 0, wilayas };
  });
}

/** The wilayas each company delivers to (a price there; our livreurs and companies without tariffs: everywhere). */
export async function servedWilayas(db: Db): Promise<Map<number, number[]>> {
  return new Map((await companiesWithCoverage(db)).map((c) => [c.id, c.wilayas.filter((w) => w.served).map((w) => w.w)]));
}

/** « À corriger »: communes not recognized on waiting orders, and prices missing where a company is switched on. */
async function toFix(ctx: Ctx) {
  const since = new Date(ctx.now() - 60 * 86_400_000).toISOString();
  const rows = await ctx.db.query(
    `SELECT id, wilaya_id, commune FROM orders
      WHERE created_at >= $1::timestamptz AND NOT is_stopdesk AND COALESCE(commune, '') <> '' AND shipped_at IS NULL
        AND (follow_status IS NULL OR follow_status IN ('to_prepare', 'prepared')) AND conf_status NOT IN ('cancelled', 'duplicate', 'wrong_number', 'fake')
      ORDER BY id DESC LIMIT 5000`,
    [since],
  );
  const groups = new Map<string, { wilayaId: number; commune: string; count: number; orderIds: number[]; to: string | null }>();
  const seen = new Map<string, Awaited<ReturnType<typeof matchCommune>>>();
  for (const r of rows) {
    const w = num(r.wilaya_id);
    const key = `${w}|${normCommune(r.commune)}`;
    if (!seen.has(key)) seen.set(key, await matchCommune(ctx.db, w, r.commune));
    const m = seen.get(key);
    if (m && m.how !== 'auto') continue;
    const g = groups.get(key) ?? { wilayaId: w, commune: String(r.commune).trim(), count: 0, orderIds: [], to: m?.commune ?? null };
    g.count++;
    if (g.orderIds.length < 5) g.orderIds.push(num(r.id));
    groups.set(key, g);
  }
  const all = [...groups.values()].sort((a, b) => b.count - a.count);
  // not recognized: to correct by hand (the closest name suggested)
  const communes = all.filter((g) => !g.to).slice(0, 200).map(({ to: _, ...g }) => ({ ...g, suggestion: closestCommune(g.wilayaId, g.commune) }));
  // matched by Pilotix itself: shown so a wrong match can be changed
  const auto = all.filter((g) => g.to).slice(0, 200).map(({ to, ...g }) => ({ ...g, to: to as string }));
  // a company with an API whose tariffs were never imported: Pilot cannot know where it delivers
  const prices = (await companiesWithCoverage(ctx.db)).filter((c) => c.active && c.hasApi && !c.hasFees).map((c) => ({ companyId: c.id, name: c.name }));
  return { communes, auto, prices, refresh: await getSetting(ctx.db, 'coverageRefresh') };
}

/** Tariffs and bureaus of every active company with an API, imported again (each company on its own: one failing does not stop the others). */
export async function refreshCoverage(ctx: Ctx) {
  const cos = await ctx.db.query('SELECT id, name, kind FROM delivery_companies WHERE active ORDER BY id');
  const results: { companyId: number; name: string; ok: boolean; error: string | null }[] = [];
  for (const c of cos) {
    const k = KINDS[c.kind as keyof typeof KINDS];
    if (!k?.fees && !k?.desks) continue;
    const cid = num(c.id);
    try {
      if (k.fees) await deliveryProcs['delivery.importFees'].run(ctx, { companyId: cid });
      if (k.desks) await deliveryProcs['delivery.importStopdesks'].run(ctx, { companyId: cid });
      results.push({ companyId: cid, name: String(c.name), ok: true, error: null });
    } catch (e) {
      results.push({ companyId: cid, name: String(c.name), ok: false, error: ((e as Error)?.message || 'Erreur').slice(0, 300) });
    }
  }
  const at = new Date(ctx.now()).toISOString();
  await setSetting(ctx.db, 'coverageRefresh', { at, results }, ctx.session.profile.id);
  return { at, results };
}

const canFix = async (ctx: Ctx) => {
  if (!(await canRules(ctx))) throw forbidden('Seuls les admins et les personnes choisies dans Préférences corrigent les communes');
};

export const coverageProcs = {
  'coverage.toFix': proc(null, z.object({}), async (ctx) => (await canFix(ctx), toFix(ctx))),

  /** « Corriger »: this commune is that official one — remembered, and the waiting orders with it fixed (Pilot chooses again). */
  'coverage.fixCommune': proc(null, z.object({ wilayaId: wid, from: z.string().trim().min(1).max(120), to: z.string().trim().min(1).max(120) }), async (ctx, i) => {
    await canFix(ctx);
    const official = communesOf(i.wilayaId).find((c) => normCommune(c[1]) === normCommune(i.to));
    if (!official) throw bad(`« ${i.to} » n’est pas une commune de ${WILAYAS[i.wilayaId - 1] ?? 'cette wilaya'}`);
    const alias = normCommune(i.from);
    await ctx.db.query('INSERT INTO commune_aliases (wilaya_id, alias, commune) VALUES ($1,$2,$3) ON CONFLICT (wilaya_id, alias) DO UPDATE SET commune = EXCLUDED.commune', [i.wilayaId, alias, official[1]]);
    const rows = await ctx.db.query(
      `SELECT * FROM orders WHERE wilaya_id = $1 AND NOT is_stopdesk AND shipped_at IS NULL AND tracking IS NULL
         AND (follow_status IS NULL OR follow_status IN ('to_prepare', 'prepared'))`,
      [i.wilayaId],
    );
    let fixed = 0;
    for (const r of rows.filter((x: any) => normCommune(x.commune) === alias)) {
      await ctx.db.query('UPDATE orders SET commune = $2, updated_at = now() WHERE id = $1', [r.id, official[1]]);
      fixed++;
      if (await pilotMayRun(ctx.db, r)) {
        const pids = (await ctx.db.query('SELECT DISTINCT product_id FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL', [r.id])).map((x: any) => num(x.product_id));
        const pick = await pilotPick(ctx.db, { wilayaId: num(r.wilaya_id), commune: official[1], isStopdesk: false, stopdeskId: null, productIds: pids });
        if (pick.companyId !== numOrNull(r.company_id) || pick.rule !== (r.pilot_rule ?? null)) await setPick(ctx.db, r, pick, null, `Commune corrigée : ${i.from} → ${official[1]}`);
      }
    }
    if (fixed) ctx.emit({ type: 'orders' });
    return { fixed, commune: official[1] };
  }),

  /** « Mettre à jour maintenant » (and every night): tariffs and bureaus from the companies' APIs. */
  'coverage.refresh': proc(null, z.object({}), async (ctx) => (await canFix(ctx), refreshCoverage(ctx))),
};

