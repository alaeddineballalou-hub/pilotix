// Pilot Auto Assign › « À corriger »: what keeps the rules from working.
//  - Communes: an order's commune is matched to the official list by name (accents, spaces, dashes ignored) or its
//    Arabic name; one written another way (« Bab Ezzouar ») is listed with the closest official name — corrected once,
//    it is remembered (commune_aliases) and the waiting orders with it are fixed (Pilot chooses again for them).
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

/** The official commune an order's text names in this wilaya (null: not recognized), the shop's corrections included. */
export async function canonCommune(db: Db, wilayaId: number | null, text: string | null | undefined): Promise<string | null> {
  const n = normCommune(text);
  if (!wilayaId || !n) return null;
  const hit = communesOf(wilayaId).find((c) => normCommune(c[1]) === n || (c[2] && normCommune(c[2]) === n));
  if (hit) return hit[1];
  return ((await db.query('SELECT commune FROM commune_aliases WHERE wilaya_id = $1 AND alias = $2', [wilayaId, n]))[0]?.commune as string | undefined) ?? null;
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
  const groups = new Map<string, { wilayaId: number; commune: string; count: number; orderIds: number[] }>();
  const known = new Map<string, boolean>();
  for (const r of rows) {
    const w = num(r.wilaya_id);
    const key = `${w}|${normCommune(r.commune)}`;
    if (!known.has(key)) known.set(key, !!(await canonCommune(ctx.db, w, r.commune)));
    if (known.get(key)) continue;
    const g = groups.get(key) ?? { wilayaId: w, commune: String(r.commune).trim(), count: 0, orderIds: [] };
    g.count++;
    if (g.orderIds.length < 5) g.orderIds.push(num(r.id));
    groups.set(key, g);
  }
  const communes = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 200).map((g) => ({ ...g, suggestion: closestCommune(g.wilayaId, g.commune) }));
  // a company with an API whose tariffs were never imported: Pilot cannot know where it delivers
  const prices = (await companiesWithCoverage(ctx.db)).filter((c) => c.active && c.hasApi && !c.hasFees).map((c) => ({ companyId: c.id, name: c.name }));
  return { communes, prices, refresh: await getSetting(ctx.db, 'coverageRefresh') };
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

