// Communes and « À corriger » (Pilot Auto Assign).
//  - Communes: an order's commune is the official one (French name). Written another way (a Google Sheet, the AI
//    seller), Pilotix matches it by sound (« Bab Ezzouar » = « Bab Azzouar ») when only one commune of the wilaya
//    fits; none fits: left empty, the agent confirms it with the customer on the call.
//  - « À corriger »: a company with an API whose tariffs were never imported (Pilot cannot know where it delivers).
//  - Where a company delivers comes from the company itself (its tariffs and bureaus), imported again every night and
//    with « Mettre à jour maintenant ». Our own livreurs' zone is set when they are set up (Livreurs).
import { ALL_WILAYAS, communesOf, normCommune } from '@pilotix/shared';
import { z } from 'zod';
import { KINDS } from '../couriers/kinds';
import { Db, num } from '../db';
import { Ctx, forbidden, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { deliveryProcs } from './delivery';
import { canRules } from './pilot';

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

/** The official commune (French name) an order's text names in this wilaya: the same name (French or Arabic, accents,
 *  spaces and dashes ignored), or the one Pilotix matches by sound — null when none fits (the agent asks the customer). */
export function officialCommune(wilayaId: number | null | undefined, text: string | null | undefined): string | null {
  const n = normCommune(text);
  if (!wilayaId || !n) return null;
  const hit = communesOf(wilayaId).find((c) => normCommune(c[1]) === n || (c[2] && normCommune(c[2]) === n));
  return hit ? hit[1] : autoCommune(wilayaId, text);
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

/** « À corriger »: companies with an API whose tariffs were never imported (Pilot cannot know where they deliver). */
async function toFix(ctx: Ctx) {
  const prices = (await companiesWithCoverage(ctx.db)).filter((c) => c.active && c.hasApi && !c.hasFees).map((c) => ({ companyId: c.id, name: c.name }));
  return { prices, refresh: await getSetting(ctx.db, 'coverageRefresh') };
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
  if (!(await canRules(ctx))) throw forbidden('Seuls les admins et les personnes choisies dans Préférences mettent à jour les tarifs');
};

export const coverageProcs = {
  'coverage.toFix': proc(null, z.object({}), async (ctx) => (await canFix(ctx), toFix(ctx))),

  /** « Mettre à jour maintenant » (and every night): tariffs and bureaus from the companies' APIs. */
  'coverage.refresh': proc(null, z.object({}), async (ctx) => (await canFix(ctx), refreshCoverage(ctx))),
};

