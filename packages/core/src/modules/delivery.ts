// Delivery companies (couriers with or without API), their tariffs and stop desks, sending parcels, status sync,
// own livreurs and their round ("Ma tournée"). Courier APIs run on the server only (ctx.server.courier → couriers/index.ts);
// in the browser preview every courier answer is simulated.
import { sealDeep, sealString } from '../secretbox';
import { COURIER_KINDS, CourierKind, courierCardOf, FOLLOW_ON_ROAD, FollowStatus, itemsKey, normalizePhone, Order, Session, SUB_TAKEN_UNSCANNED, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { ADAPTERS } from '../couriers/adapters';
import { DEFAULT_TEMPLATE, PLACEHOLDERS, checkTemplate, custom } from '../couriers/custom';
import { fakeTracking, nextStep, word, zrWeighs } from '../couriers/demo';
import { CARDS, KINDS } from '../couriers/kinds';
import { keysOk, loadCompany, loadParcels, resolveStatus } from '../couriers/load';
import { courierEvent, decideAlert, ordinalFr, SUB_ERREUR } from '../couriers/alertstart';
import { getPrefs } from './prefs';
import { checkedInToday } from './livreur';
import type { CourierCosts, CourierStep, CourierSwapSeen, Desk, ExchangeResult, FeeRow, LabelResult, PreviewResult, SendResult, TrackItem, TrackResult } from '../couriers/types';
import { Db, iso, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, notFound, proc, publicApi, takeActionLocks } from '../rpc';

/** Compares two secrets in a time that does not depend on where they differ (no guessing a key letter by letter). */
function sameSecret(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let k = 0; k < Math.max(a.length, b.length); k++) d |= (a.charCodeAt(k) || 0) ^ (b.charCodeAt(k) || 0);
  return d === 0;
}
import { getSetting } from '../settings';
import { removedCouriers } from '../platform/courierWatch';
import { addEvent, getOrder, listOrders, setFollow } from './orders';
import { recipients } from './depotalerts';
import { sendPush } from './push';
import { SWAP_FROM, writeSwap } from './swapwrite';
import { apiFees, companyWeightRule, courierFeesOf, declaredKg, feesByApi, knownKg, ruleFee, saveCourierFees, saveCourierWeight, weightRuleOf, weightRuleSet, wholeKg, type WeightRule } from './courierfees';

const id = z.number().int().positive();
const ids = z.array(id).min(1).max(500);

/** Statuses where a parcel is waiting to leave with this company. */
export const TO_SHIP: FollowStatus[] = ['to_prepare', 'prepared'];
/** Statuses the courier sync follows (parcels with a tracking number, not final). « En dispatch » only for the company's
 *  word and its ends: taken on the road, it waits for the depot's scan (syncCompany). « En retour » too: the Suivi may
 *  have marked it so (Perdu, client annule) while the company still delivers it — only its delivered / lost is taken. */
const SYNCABLE: FollowStatus[] = ['prepared', ...FOLLOW_ON_ROAD, 'returning'];
/** Statuses set by hand by the suivi that the courier's ordinary on-the-road statuses must not overwrite. */
const MANUAL_HOLD: FollowStatus[] = ['alert', 'in_exchange'];
/** Courier statuses that still move a parcel held by the suivi. */
const SYNC_ENDS: FollowStatus[] = ['delivered', 'returning', 'returned', 'exchanged', 'lost'];
/** The company's ordinary « on its way » statuses (a correction can send a parcel back to them). */
const BACK_ON_ROAD: FollowStatus[] = ['shipped', 'out_for_delivery', 'failed'];

// ---------------------------------------------------------------- finished parcels a company may still correct
// The owner, 27 Nov 2026 (« sometimes the livreur taps Livré by mistake, then cancels »): a finished parcel is still
// followed until its company pays it — « Livrée » until its money is in a caisse (cashed), « Annulée » after it left
// until it is back at the depot (returned_at) or the company took its return fee (fee_taken_at). The company's correction
// is followed (Livrée → Annulée / En retour / back on the road, Annulée → Livrée…) and written in the order's history.
// WATCH_DAYS: a safety net, for a parcel nobody ever marks paid (counted from the company's last news).
const WATCH_DAYS = 45;
/** Parcels read per company in each full sync (every 30 minutes), in turn by id: a webhook brings the others at once. */
const WATCH_BATCH = 400;
const WATCH_SQL = `((o.follow_status = 'delivered' AND NOT o.cashed)
  OR (o.follow_status = 'cancelled' AND o.shipped_at IS NOT NULL AND o.returned_at IS NULL AND o.fee_taken_at IS NULL))`;
/** Where a finished parcel may go when its company corrects it (never back to the depot's own steps). */
const CORRECTED_TO: Partial<Record<FollowStatus, FollowStatus[]>> = {
  delivered: [...BACK_ON_ROAD, 'alert', 'returning', 'returned', 'cancelled'],
  cancelled: [...BACK_ON_ROAD, 'alert', 'delivered', 'returning', 'returned'],
};
const FOLLOW_FR: Record<FollowStatus, string> = {
  to_prepare: 'À préparer', prepared: 'Préparée', shipped: 'Expédiée', out_for_delivery: 'En livraison', failed: 'Reportée / échec', alert: 'Alerte',
  in_exchange: 'En échange', delivered: 'Livrée', returning: 'Retour en cours', returned: 'Retournée', exchanged: 'Échangée', lost: 'Perdue', cancelled: 'Annulée',
};

export interface CompanyRow {
  id: number;
  name: string;
  kind: CourierKind;
  kindLabel: string;
  active: boolean;
  /** all the keys the kind needs are filled (the keys themselves are never returned) */
  hasKeys: boolean;
  /** which secret keys are filled (names only) */
  keysSet: string[];
  phone: string | null;
  settings: Record<string, unknown>;
  statusMap: Record<string, string>;
  toShip: number;
  onRoad: number;
  livreurs: number;
  createdAt: string;
}

const isLivreurOnly = (s: Session) => !s.isAdmin && s.roles.includes('livreur') && !s.roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r));
const isDemo = (ctx: Ctx) => !ctx.server;
const asCourier = (ctx: Ctx): Ctx => ({ ...ctx, session: { ...ctx.session, roles: [...ctx.session.roles, 'admin'], isAdmin: true } });
const parseJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});

async function companies(db: Db, onlyId?: number): Promise<CompanyRow[]> {
  const rows = await db.query(
    `SELECT c.*,
       (SELECT count(*)::int FROM orders o WHERE o.company_id = c.id AND o.follow_status = ANY($1)) AS to_ship,
       (SELECT count(*)::int FROM orders o WHERE o.company_id = c.id AND o.follow_status = ANY($2)) AS on_road,
       (SELECT count(*)::int FROM profiles p WHERE p.livreur_company_id = c.id) AS livreurs
     FROM delivery_companies c ${onlyId ? 'WHERE c.id = $3' : ''} ORDER BY c.active DESC, c.name`,
    onlyId ? [TO_SHIP, FOLLOW_ON_ROAD, onlyId] : [TO_SHIP, FOLLOW_ON_ROAD],
  );
  return rows.map((r: any) => {
    const cred = parseJson(r.credentials) as Record<string, unknown>;
    const cfg = parseJson(r.config) as any;
    const kind = r.kind as CourierKind;
    return {
      id: num(r.id),
      name: r.name,
      kind,
      kindLabel: KINDS[kind]?.label ?? kind,
      active: !!r.active,
      hasKeys: keysOk(kind, cred),
      keysSet: Object.keys(cred).filter((k) => k !== 'demo' && String(cred[k] ?? '').trim() !== ''),
      phone: r.phone ?? null,
      settings: cfg.settings ?? {},
      statusMap: cfg.statusMap ?? {},
      toShip: num(r.to_ship),
      onRoad: num(r.on_road),
      livreurs: num(r.livreurs),
      createdAt: iso(r.created_at),
    };
  });
}

async function companyOr404(db: Db, companyId: number) {
  const c = (await companies(db, companyId))[0];
  if (!c) throw notFound('Société introuvable');
  return c;
}

const courierOf = (ctx: Ctx) => ctx.server!.courier;

// ---------------------------------------------------------------- tariffs
const DEFAULT_FEES = (w: number) => {
  const far = [1, 11, 33, 37, 49, 50, 52, 53, 54, 56].includes(w);
  const south = [3, 7, 8, 17, 30, 32, 39, 45, 47, 51, 55, 57, 58, 59, 61, 63, 66, 68, 69].includes(w);
  const home = w === 16 ? 400 : [9, 35, 42].includes(w) ? 500 : far ? 1100 : south ? 800 : 600;
  return { home, desk: Math.max(250, home - 200), returnFee: 200 };
};

async function feesOf(db: Db, companyId: number) {
  const rows = await db.query('SELECT wilaya_id, home, desk, return_fee FROM delivery_fees WHERE company_id = $1', [companyId]);
  const by = new Map(rows.map((r: any) => [num(r.wilaya_id), r]));
  return WILAYAS.map((name, i) => {
    const r: any = by.get(i + 1);
    return { wilayaId: i + 1, name, home: r ? num(r.home) : null, desk: r ? num(r.desk) : null, returnFee: r ? num(r.return_fee) : null };
  });
}

/** `all`: the rows are the company's whole list (its API): a wilaya it no longer prices loses its price here too. */
async function saveFeeRows(db: Db, companyId: number, rows: FeeRow[], all = false) {
  await db.tx(async (tx) => {
    if (all) {
      const kept = rows.filter((r) => r.wilayaId >= 1 && r.wilayaId <= 69 && !(r.home === null && r.desk === null && r.returnFee === null)).map((r) => r.wilayaId);
      await tx.query('DELETE FROM delivery_fees WHERE company_id=$1 AND NOT (wilaya_id = ANY($2::int[]))', [companyId, kept]);
    }
    for (const r of rows) {
      if (!(r.wilayaId >= 1 && r.wilayaId <= 69)) continue;
      if (r.home === null && r.desk === null && r.returnFee === null) {
        await tx.query('DELETE FROM delivery_fees WHERE company_id=$1 AND wilaya_id=$2', [companyId, r.wilayaId]);
        continue;
      }
      await tx.query(
        `INSERT INTO delivery_fees (company_id, wilaya_id, home, desk, return_fee) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (company_id, wilaya_id) DO UPDATE SET home=EXCLUDED.home, desk=EXCLUDED.desk, return_fee=EXCLUDED.return_fee`,
        [companyId, r.wilayaId, Math.max(0, Math.round(r.home ?? 0)), Math.max(0, Math.round(r.desk ?? 0)), Math.max(0, Math.round(r.returnFee ?? 0))],
      );
    }
  });
}

/** The last time a company's prices came from its API: when, how many changed, or why it failed (the « Tarifs » window). */
interface FeesSync {
  at: string | null;
  changed: number | null;
  error: string | null;
}
async function setFeesSync(db: Db, companyId: number, s: Partial<FeesSync>) {
  const cfg = parseJson((await db.query('SELECT config FROM delivery_companies WHERE id=$1', [companyId]))[0]?.config);
  const cur: FeesSync = { at: null, changed: null, error: null, ...(cfg.feesSync ?? {}) };
  await db.query('UPDATE delivery_companies SET config=$2 WHERE id=$1', [companyId, JSON.stringify({ ...cfg, feesSync: { ...cur, ...s } })]);
}

/**
 * A company's prices taken again from its API (browser preview: a realistic grid) — the only way they change for a
 * company that has them by API (« Tarifs » cannot edit them): when it is connected, every night, and « Mettre à jour ».
 */
export async function importFeesNow(ctx: Ctx, companyId: number) {
  const c = await companyOr404(ctx.db, companyId);
  if (!KINDS[c.kind].fees) throw bad(`${c.name} : import des tarifs non disponible, remplissez-les à la main`);
  const before = await feesOf(ctx.db, companyId);
  let rows: FeeRow[];
  try {
    if (isDemo(ctx)) {
      const f = c.kind === 'zr' ? 0.95 : c.kind === 'noest' ? 0.9 : 1;
      rows = WILAYAS.map((_, k) => {
        const d = DEFAULT_FEES(k + 1);
        return { wilayaId: k + 1, home: Math.round((d.home * f) / 50) * 50, desk: Math.round((d.desk * f) / 50) * 50, returnFee: d.returnFee };
      });
    } else rows = (await courierOf(ctx)('fees', { companyId }, ctx)) as FeeRow[];
    // an empty answer is a hiccup, not « delivers nowhere »: the prices we have stay
    if (!rows.some((r) => r.home !== null || r.desk !== null)) throw bad(`${c.name} n’a renvoyé aucun prix : les prix d’avant restent`);
  } catch (e: any) {
    await setFeesSync(ctx.db, companyId, { error: String(e?.message ?? e).slice(0, 300) });
    throw e;
  }
  await saveFeeRows(ctx.db, companyId, rows, true);
  const after = await feesOf(ctx.db, companyId);
  const changed = after.filter((r, k) => r.home !== before[k].home || r.desk !== before[k].desk || r.returnFee !== before[k].returnFee).length;
  await setFeesSync(ctx.db, companyId, { at: new Date(ctx.now()).toISOString(), changed, error: null });
  return { imported: rows.length, changed, rows: after };
}

// ---------------------------------------------------------------- sending
export async function sendOrders(ctx: Ctx, orderIds: number[], forceCompanyId?: number | null) {
  // a double click, two people or a retry never send the same parcel twice (the courier would bill two parcels)
  const locks = await takeActionLocks(ctx.db, orderIds.map((x) => `send:${x}`), ctx.session.profile.id);
  try {
    const busy = orderIds.filter((x) => !locks.taken.has(`send:${x}`));
    const out = await sendOrdersLocked(ctx, orderIds.filter((x) => locks.taken.has(`send:${x}`)), forceCompanyId);
    if (busy.length) {
      const refs = await ctx.db.query('SELECT id, ref FROM orders WHERE id = ANY($1)', [busy]);
      for (const r of refs) out.results.push({ id: num(r.id), ref: r.ref, ok: false, error: 'Envoi déjà en cours pour ce colis' });
      out.failed = out.results.filter((r) => !r.ok).length;
    }
    return out;
  } finally {
    await locks.release();
  }
}

async function sendOrdersLocked(ctx: Ctx, orderIds: number[], forceCompanyId?: number | null) {
  const rows = await ctx.db.query(
    `SELECT o.id, o.ref, o.company_id, o.conf_status, o.follow_status, o.tracking, o.wilaya_id, o.is_stopdesk, c.kind, c.active, c.name AS company_name,
       o.is_exchange, o.original_order_id, oo.company_id AS orig_company, oo.tracking AS orig_tracking, oo.ext_id AS orig_ext,
       (SELECT coalesce(sum(p.weight_kg * it.qty), 0) FROM order_items it JOIN products p ON p.id = it.product_id WHERE it.order_id = o.id) AS kg
     FROM orders o LEFT JOIN delivery_companies c ON c.id = COALESCE($2::bigint, o.company_id) LEFT JOIN orders oo ON oo.id = o.original_order_id
     WHERE o.id = ANY($1) ORDER BY o.id`,
    [orderIds, forceCompanyId ?? null],
  );
  const results: { id: number; ref: string; ok: boolean; tracking?: string; error?: string }[] = [];
  const byCompany = new Map<number, any[]>();
  for (const r of rows) {
    const companyId = forceCompanyId ?? numOrNull(r.company_id);
    const fail = (error: string) => results.push({ id: num(r.id), ref: r.ref, ok: false, error });
    if (!['confirmed', 'no_stock'].includes(r.conf_status)) fail('Commande pas confirmée');
    else if (!companyId) fail('Choisissez d’abord une société de livraison');
    else if (r.tracking) fail(`Déjà envoyée (${r.tracking})`);
    else if (r.follow_status && !TO_SHIP.includes(r.follow_status) && r.follow_status !== 'shipped') fail('Colis déjà parti ou terminé');
    else if (!r.active) fail(`${r.company_name} est désactivée`);
    else if (!KINDS[r.kind as CourierKind]?.api) fail(`${r.company_name} n’a pas d’API : mettez le n° de suivi à la main`);
    else byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), r]);
  }
  for (const [companyId, list] of byCompany) {
    const kind = list[0].kind as CourierKind;
    let sent: ({ id: number; ok: true } & SendResult | { id: number; ok: false; error: string })[] = [];
    // an SAV exchange whose original parcel this company delivered: the company's own exchange (ZR delivers the new
    // product and brings the old one back with a return parcel of its own); any other parcel is sent as usual
    const swaps = KINDS[kind]?.zr ? list.filter((r) => r.is_exchange && r.orig_tracking && num(r.orig_company) === companyId) : [];
    const plain = list.filter((r) => !swaps.includes(r));
    const returns = new Map<number, { tracking: string; extId: string | null }>();
    const cred = isDemo(ctx) ? parseJson((await ctx.db.query('SELECT credentials FROM delivery_companies WHERE id=$1', [companyId]))[0]?.credentials) : null;
    if (plain.length && isDemo(ctx)) {
      const costs = feesByApi(kind) ? await demoCosts(ctx, companyId, plain.map((r) => num(r.id)), false) : new Map<number, CourierCosts>();
      sent = plain.map((r) =>
        keysOk(kind, cred)
          ? { id: num(r.id), ok: true as const, tracking: fakeTracking(kind, r.ref), extId: null, labelUrl: null, ...(costs.has(num(r.id)) ? { costs: costs.get(num(r.id)) } : {}) }
          : { id: num(r.id), ok: false as const, error: `Clés API manquantes pour ${list[0].company_name}` },
      );
    } else if (plain.length) {
      sent = (await courierOf(ctx)('send', { companyId, ids: plain.map((r) => num(r.id)) }, ctx)) as typeof sent;
    }
    for (const r of swaps) {
      const oid = num(r.id);
      try {
        if (isDemo(ctx)) {
          if (!keysOk(kind, cred)) throw bad(`Clés API manquantes pour ${r.company_name}`);
          sent.push({ id: oid, ok: true, tracking: fakeTracking(kind, r.ref), extId: null, labelUrl: null });
          returns.set(oid, { tracking: fakeTracking(kind, r.ref, Date.now() + 7), extId: null });
        } else {
          const x = (await courierOf(ctx)('exchange', { companyId, orderId: oid, item: { id: num(r.original_order_id), tracking: r.orig_tracking, extId: r.orig_ext ?? null } }, ctx)) as ExchangeResult;
          sent.push({ id: oid, ok: true, tracking: x.tracking, extId: x.extId, labelUrl: x.labelUrl });
          if (x.returnTracking) returns.set(oid, { tracking: x.returnTracking, extId: x.returnExtId });
        }
      } catch (e: any) {
        sent.push({ id: oid, ok: false, error: e?.message ?? 'Erreur' });
      }
    }
    const fees = new Map((await ctx.db.query('SELECT wilaya_id, home, desk FROM delivery_fees WHERE company_id=$1', [companyId])).map((f: any) => [num(f.wilaya_id), f]));
    let weightRule: WeightRule | null = null;
    const rule = async () => (weightRule ??= await companyWeightRule(ctx.db, companyId));
    for (const s of sent) {
      const r = list.find((x) => num(x.id) === s.id)!;
      if (!s.ok) {
        results.push({ id: s.id, ref: r.ref, ok: false, error: s.error });
        // refused: the reason stays on the order (« En dispatch » shows it with « Renvoyer » / « Autre société »)
        const had = (await ctx.db.query('SELECT send_error FROM orders WHERE id = $1', [s.id]))[0]?.send_error;
        await ctx.db.query('UPDATE orders SET send_error = $2, send_error_at = now() WHERE id = $1', [s.id, String(s.error ?? 'Erreur').slice(0, 500)]);
        if (had !== s.error) await addEvent(ctx.db, s.id, ctx.session.profile.id, 'note', null, 'event', `Colis refusé par ${r.company_name ?? 'la société'} : ${s.error}`);
        continue;
      }
      const f: any = fees.get(num(r.wilaya_id));
      // the company's own price for this parcel when its answer gives it (ZR), else its price list; its « Surpoids »
      // comes once it says the weight it found (never from the products' weight)
      const cost = s.costs?.delivery ?? (f ? num(r.is_stopdesk ? f.desk : f.home) : null);
      const status = word(kind, 'prepared');
      await ctx.db.query(
        `UPDATE orders SET company_id=$2, tracking=$3, ext_id=$4, label_url=$5, ext_status=$6, ext_status_at=now(), taken_at=NULL,
           delivery_cost = COALESCE($7, delivery_cost), send_error = NULL, send_error_at = NULL, updated_at=now(), version=version+1 WHERE id=$1`,
        [s.id, companyId, s.tracking, s.extId, s.labelUrl, status, cost],
      );
      if (s.costs) await saveCourierFees(ctx.db, s.id, s.costs, 'send', await rule(), new Date(ctx.now()).toISOString());
      const back = returns.get(s.id);
      if (back)
        await ctx.db.query(
          `INSERT INTO parcel_returns (order_id, company_id, tracking, ext_id) VALUES ($1,$2,$3,$4)
           ON CONFLICT (order_id) DO UPDATE SET company_id = EXCLUDED.company_id, tracking = EXCLUDED.tracking, ext_id = EXCLUDED.ext_id, created_at = now()`,
          [s.id, companyId, back.tracking, back.extId],
        );
      await addEvent(ctx.db, s.id, ctx.session.profile.id, 'company', null, String(companyId), back ? `Échange envoyé à ${r.company_name} · suivi ${s.tracking} · retour de l’ancien produit ${back.tracking}` : `Envoyée à ${r.company_name} · suivi ${s.tracking}`);
      results.push({ id: s.id, ref: r.ref, ok: true, tracking: s.tracking });
    }
  }
  if (results.some((r) => r.ok)) ctx.emit({ type: 'orders' });
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

/** Cancels a parcel at its courier (before pickup) and removes the courier's number: the order shows its Pilotix
 *  number again. Refused when the courier already has the parcel, or has no way to cancel it from Pilotix. */
export async function cancelParcel(ctx: Ctx, orderId: number) {
  const o = (await ctx.db.query('SELECT id, ref, tracking, ext_id, company_id, follow_status, shipped_at FROM orders WHERE id=$1', [orderId]))[0];
  if (!o) throw notFound('Commande introuvable');
  if (!o.tracking || !o.company_id) throw bad('Ce colis n’a pas été envoyé à une société');
  const c = await companyOr404(ctx.db, num(o.company_id));
  if (isDemo(ctx)) {
    // the browser preview's courier: a parcel that never left the depot can be cancelled (also once the order is cancelled)
    if (!TO_SHIP.includes(o.follow_status) && !(o.follow_status === 'cancelled' && !o.shipped_at)) throw bad(`${c.name} refuse : le colis est déjà pris en charge`);
  } else if (KINDS[c.kind].cancel) {
    await courierOf(ctx)('cancel', { companyId: c.id, item: { id: num(o.id), tracking: o.tracking, extId: o.ext_id } }, ctx);
  } else if (KINDS[c.kind].api) throw bad(`${c.name} : annulez le colis depuis l’espace de la société, puis réessayez`);
  await ctx.db.query('UPDATE orders SET tracking=NULL, ext_id=NULL, label_url=NULL, ext_status=NULL, ext_status_at=NULL, taken_at=NULL, updated_at=now(), version=version+1 WHERE id=$1', [orderId]);
  await ctx.db.query('DELETE FROM parcel_returns WHERE order_id=$1', [orderId]);
  await ctx.db.query('DELETE FROM pickup_bag_parcels WHERE order_id=$1', [orderId]);
  await addEvent(ctx.db, orderId, ctx.session.profile.id, 'company', String(c.id), String(c.id), `Colis annulé chez ${c.name} (${o.tracking})`);
  ctx.emit({ type: 'order', id: orderId });
}

/** The courier's own label of a parcel sent to it: a link or a PDF. null when the courier gives no label (Pilotix prints
 *  its own then); in the browser preview a stand-in (the courier is simulated). */
async function companyLabel(ctx: Ctx, orderId: number): Promise<LabelResult | null> {
  const o = (await ctx.db.query('SELECT id, tracking, ext_id, label_url, company_id FROM orders WHERE id=$1', [orderId]))[0];
  if (!o) throw notFound('Commande introuvable');
  if (o.label_url) return { url: o.label_url };
  if (!o.tracking || !o.company_id) throw bad('Pas encore envoyée à une société');
  const c = await companyOr404(ctx.db, num(o.company_id));
  if (!KINDS[c.kind].label_) return null;
  if (isDemo(ctx)) return { demo: true };
  return (await courierOf(ctx)('label', { companyId: c.id, item: { id: num(o.id), tracking: o.tracking, extId: o.ext_id } }, ctx)) as LabelResult | null;
}

export type LabelFile = { ids: number[]; label: LabelResult | null; error?: string };

/** The couriers' labels of several parcels, one entry per file. A courier that labels many parcels at once (ZR) gives
 *  ONE file for all its parcels (250 at most per file); the others one per parcel. */
async function companyLabels(ctx: Ctx, orderIds: number[]): Promise<LabelFile[]> {
  const rows = await ctx.db.query(
    `SELECT o.id, o.tracking, o.ext_id, o.label_url, o.company_id, c.kind FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id
     WHERE o.id = ANY($1) ORDER BY o.id`,
    [orderIds],
  );
  const out: LabelFile[] = [];
  const found = new Set(rows.map((r: any) => num(r.id)));
  for (const oid of orderIds) if (!found.has(oid)) out.push({ ids: [oid], label: null, error: 'Commande introuvable' });
  const batches = new Map<number, any[]>();
  for (const r of rows) {
    const oid = num(r.id);
    const k = r.kind ? KINDS[r.kind as CourierKind] : undefined;
    if (r.label_url) out.push({ ids: [oid], label: { url: r.label_url } });
    else if (!r.tracking || !r.company_id) out.push({ ids: [oid], label: null, error: 'Pas encore envoyée à une société' });
    else if (!k?.label_) out.push({ ids: [oid], label: null });
    else if (k.labels_) batches.set(num(r.company_id), [...(batches.get(num(r.company_id)) ?? []), r]);
    else if (isDemo(ctx)) out.push({ ids: [oid], label: { demo: true } });
    else {
      try {
        out.push({ ids: [oid], label: await companyLabel(ctx, oid) });
      } catch (e: any) {
        out.push({ ids: [oid], label: null, error: e?.message ?? 'Erreur' });
      }
    }
  }
  for (const [companyId, list] of batches) {
    for (let i = 0; i < list.length; i += 250) {
      const part = list.slice(i, i + 250);
      if (isDemo(ctx)) {
        out.push({ ids: part.map((x) => num(x.id)), label: { demo: true } });
        continue;
      }
      try {
        const items: TrackItem[] = part.map((x) => ({ id: num(x.id), tracking: x.tracking, extId: x.ext_id }));
        const r = (await courierOf(ctx)('labels', { companyId, items }, ctx)) as { label: LabelResult | null; failed: string[] };
        const failed = new Set((r?.failed ?? []).map(String));
        const ok = part.filter((x) => !failed.has(String(x.tracking)));
        if (ok.length && r?.label) out.push({ ids: ok.map((x) => num(x.id)), label: r.label });
        else if (ok.length) out.push({ ids: ok.map((x) => num(x.id)), label: null, error: 'La société n’a pas renvoyé d’étiquette' });
        for (const x of part.filter((y) => failed.has(String(y.tracking)))) out.push({ ids: [num(x.id)], label: null, error: 'La société n’a pas fait cette étiquette' });
      } catch (e: any) {
        out.push({ ids: part.map((x) => num(x.id)), label: null, error: e?.message ?? 'Erreur' });
      }
    }
  }
  return out;
}

/** Browser preview: what a company with prices by API (ZR) would answer — its price for the place, and once it has the
 *  parcel, the weight it counts (the products' real one). */
async function demoCosts(ctx: Ctx, companyId: number, ids: number[], weighed: boolean): Promise<Map<number, CourierCosts>> {
  const rows = await ctx.db.query(
    `SELECT o.id, o.is_stopdesk, f.home, f.desk, f.return_fee,
       (SELECT coalesce(sum(p.weight_kg * i.qty), 0) FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id) AS kg
     FROM orders o JOIN delivery_fees f ON f.company_id = $1 AND f.wilaya_id = o.wilaya_id WHERE o.id = ANY($2)`,
    [companyId, ids],
  );
  return new Map(rows.map((r: any) => [num(r.id), { delivery: num(r.is_stopdesk ? r.desk : r.home), ret: num(r.return_fee), kg: weighed ? zrWeighs(num(r.id), r.kg) : null }]));
}

// ---------------------------------------------------------------- status sync
/** A company's finished parcels it has not paid yet (WATCH_SQL), its last news under WATCH_DAYS old: these ids, or the
 *  next WATCH_BATCH in turn (a cursor per company in the settings, back to the start once all were read). */
async function watchedParcels(ctx: Ctx, c: CompanyRow, onlyIds?: number[]) {
  const since = new Date(ctx.now() - WATCH_DAYS * 86_400_000).toISOString();
  const base = `SELECT o.id, o.ref, o.tracking, o.ext_id, o.follow_status, o.sub_status, o.ext_status, o.taken_at FROM orders o
     WHERE o.company_id = $1 AND o.tracking IS NOT NULL AND o.livreur_id IS NULL AND ${WATCH_SQL} AND coalesce(o.ext_status_at, o.updated_at) > $2::timestamptz`;
  if (onlyIds) return ctx.db.query(`${base} AND o.id = ANY($3)`, [c.id, since, onlyIds]);
  const key = `watchCursor:${c.id}`;
  const after = num((await ctx.db.query('SELECT value FROM settings WHERE key = $1', [key]))[0]?.value ?? 0);
  const rows = await ctx.db.query(`${base} AND o.id > $3 ORDER BY o.id LIMIT ${WATCH_BATCH}`, [c.id, since, after]);
  const next = rows.length < WATCH_BATCH ? 0 : num(rows[rows.length - 1].id);
  await ctx.db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(next)]);
  return rows;
}

/** `full`: the sync every 30 minutes (not the fast one every 5): it also reads, in turn, the finished parcels the company
 *  has not paid yet (WATCH_SQL); a webhook or a single parcel (`onlyIds`) reads them at once. */
async function syncCompany(ctx: Ctx, c: CompanyRow, onlyIds?: number[], scenario?: FollowStatus, full = false) {
  if (scenario && (ctx.server || (ctx.shop && !ctx.shop.demo))) throw forbidden('Simulation réservée à la démo');
  // by_courier: an « En retour » the company itself gave (not the Suivi's): the company may correct it
  const parcels = await ctx.db.query(
    `SELECT o.id, o.ref, o.tracking, o.ext_id, o.follow_status, o.sub_status, o.ext_status, o.taken_at,
       CASE WHEN o.follow_status = 'returning' THEN (SELECT coalesce(e.data->>'courier', '') = 'true' FROM order_events e
         WHERE e.order_id = o.id AND e.kind = 'follow_status' ORDER BY e.at DESC, e.id DESC LIMIT 1) END AS by_courier
       FROM orders o
     WHERE o.company_id = $1 AND o.tracking IS NOT NULL AND o.follow_status = ANY($2) ${onlyIds ? 'AND o.id = ANY($3)' : ''} ORDER BY o.ext_status_at NULLS FIRST LIMIT 2000`,
    onlyIds ? [c.id, SYNCABLE, onlyIds] : [c.id, SYNCABLE],
  );
  // finished parcels not paid yet (WATCH_SQL): the company may still correct them
  const watched = scenario || c.kind === 'own' || (!full && !onlyIds) ? [] : await watchedParcels(ctx, c, onlyIds);
  const watchIds = new Set(watched.map((p: any) => num(p.id)));
  // parcels just finished (delivered, returned, swapped): asked once more for the weight the company found — that is the
  // one it charges (Pilotix never counts the products' weight); their status is left alone
  const ended =
    c.kind === 'own' || onlyIds
      ? []
      : await ctx.db.query(
          `SELECT id, ref, tracking, ext_id, follow_status, sub_status, ext_status FROM orders
           WHERE company_id = $1 AND tracking IS NOT NULL AND livreur_id IS NULL AND follow_status IN ('delivered','returned','exchanged')
             AND (courier_fees->>'final') IS NULL AND coalesce(courier_fees->>'src', '') <> 'pay'
             AND coalesce(delivered_at, returned_at, updated_at) > $2::timestamptz ORDER BY id DESC LIMIT 300`,
          [c.id, new Date(ctx.now() - 30 * 86_400_000).toISOString()],
        );
  const endedIds = new Set(ended.map((p: any) => num(p.id)));
  parcels.push(...ended);
  // (a delivered parcel can be both: read once for its weight, and followed for a correction)
  for (const w of watched) if (!endedIds.has(num(w.id))) parcels.push(w);
  if (!parcels.length) return { company: c.name, checked: 0, changed: 0, fees: 0 };
  let answers: TrackResult[];
  if (isDemo(ctx)) {
    answers = [];
    // a company whose API gives its prices: its statuses bring them, with the weight it counted
    // the others say the weight they found (their price list counts)
    const costs = c.kind !== 'own' && KINDS[c.kind]?.api ? await demoCosts(ctx, c.id, parcels.map((p: any) => num(p.id)), true) : new Map<number, CourierCosts>();
    if (!feesByApi(c.kind)) for (const [k, v] of costs) costs.set(k, { delivery: null, ret: null, kg: v.kg });
    const expanded = (await ctx.db.query(`SELECT value FROM settings WHERE key = 'demoExpanded'`))[0]?.value === true;
    for (const p of parcels) {
      if (endedIds.has(num(p.id))) {
        answers.push({ id: num(p.id), status: p.ext_status ?? '', at: null, ...(costs.has(num(p.id)) ? { costs: costs.get(num(p.id)) } : {}) });
        continue;
      }
      const next = scenario ?? nextStep(p.follow_status, !!p.tracking, Math.random(), expanded);
      if (next) answers.push({ id: num(p.id), status: word(c.kind, next), mapped: next, at: new Date(ctx.now()).toISOString(), ...(costs.has(num(p.id)) ? { costs: costs.get(num(p.id)) } : {}) });
    }
  } else {
    const items: TrackItem[] = parcels.map((p: any) => ({ id: num(p.id), tracking: p.tracking, extId: p.ext_id }));
    answers = (await courierOf(ctx)('track', { companyId: c.id, items }, ctx)) as TrackResult[];
  }
  const defaults = ADAPTERS[c.kind]?.statuses ?? {};
  const byStatus = new Map<FollowStatus, number[]>();
  const courierNotes = new Map<number, string>();
  let changed = 0;
  let feesChanged = 0;
  let weightRule: WeightRule | null = null;
  const rule = async () => (weightRule ??= await companyWeightRule(ctx.db, c.id));
  const errors: { ref: string; error: string }[] = [];
  /** parcels the company just took before the depot's scan (the depot is told once, below) */
  const taken: string[] = [];
  /** swaps made in the company's own space, put on their new customer's order (« PX1329 → PX1392 ») */
  const swaps: string[] = [];
  // Suivi › Réglages › « Quand une alerte commence » (the owner, 26 Nov 2026): on the companies' real answers, the try
  // where an alert starts and where a problem goes decide — not the statuses once ticked in « Alertes du Suivi »
  const pr = !isDemo(ctx) && !scenario ? await getPrefs(ctx.db) : null;
  const ownPlain: Record<string, string> = Object.fromEntries(Object.entries((c.statusMap ?? {}) as Record<string, string>).filter(([, v]) => v !== 'alert'));
  const triesSeen = pr ? await courierTriesSeen(ctx.db, answers.map((x) => x.id)) : new Map<number, number>();
  /** new alerts that are problems to fix (Suivi › Erreurs) */
  const problemAlerts: number[] = [];
  /** the company's corrections (a finished parcel, its own « En retour »): from → to, said in the history once moved */
  const corrections = new Map<number, [FollowStatus, FollowStatus]>();
  /** Suivi › Erreurs the company no longer says: they leave the tab once moved */
  const errorGoneIds = new Set<number>();
  for (const a of answers) {
    const p = parcels.find((x: any) => num(x.id) === a.id);
    if (!p) continue;
    if (a.error) {
      errors.push({ ref: p.ref, error: a.error });
      continue;
    }
    // swapped in the company's own space (ZR › « Swaps »): the parcel goes to its new customer's order, its statuses and
    // prices are read there from now on (the next read)
    if (a.swapped && !endedIds.has(a.id) && !watchIds.has(a.id)) {
      const moved = await catchSwapSeen(ctx, c, a.id, a.swapped);
      if (moved) {
        swaps.push(moved);
        changed++;
        continue;
      }
    }
    // The scenario picker supplies an already mapped status; ordinary sync still honors the shop's courier mapping.
    let to = scenario ?? resolveStatus(defaults, c.statusMap, a, ADAPTERS[c.kind]?.situations);
    // what the company charges for it (its prices, the weight it counted): counted instead of the price list
    // (a company without its prices by API only says the weight it found: its « Surpoids » counts on that weight)
    // its own prices for the parcel (delivery, return — 0 for a free return) come first, like ZR's; with only a weight,
    // its price list + its « Surpoids » on that weight
    const priced = !!a.costs && (feesByApi(c.kind) || a.costs.delivery !== null || a.costs.ret !== null);
    if (priced && (await saveCourierFees(ctx.db, a.id, a.costs!, 'track', await rule(), new Date(ctx.now()).toISOString()))) feesChanged++;
    else if (!priced && a.costs?.kg && (await saveCourierWeight(ctx.db, a.id, c.kind, await rule(), a.costs.kg, new Date(ctx.now()).toISOString()))) feesChanged++;
    // a finished parcel: only its weight (read once) — and, not paid yet, the company's correction (WATCH_SQL, below)
    if (endedIds.has(a.id)) {
      await ctx.db.query(`UPDATE orders SET courier_fees = coalesce(courier_fees, '{}'::jsonb) || '{"final":true}'::jsonb WHERE id = $1`, [a.id]);
      if (!watchIds.has(a.id)) continue;
    }
    // the company says something new about the parcel (not the same words read again)
    const fresh = a.status !== p.ext_status;
    // « Quand une alerte commence »: a failed try before the chosen one, or a status that is no try, no cancel and no
    // problem, is never an alert; the chosen try and a cancel are; a problem is one of Suivi › Erreurs
    let problem = false;
    if (pr) {
      const d = decideAlert({
        to,
        plain: resolveStatus(defaults, ownPlain, a),
        status: a.status || a.key || '',
        start: pr.suiviAlertStart,
        problems: pr.suiviProblems,
        seen: triesSeen.get(a.id) ?? 0,
        fresh,
      });
      to = d.to;
      problem = d.problem;
      // a company that does not number its tries: Pilotix counts each new one (its history says « 2e tentative ratée »)
      if (fresh && d.event?.kind === 'try' && d.event.n === null && d.tryN)
        await addEvent(ctx.db, a.id, null, 'note', null, 'event', `${c.name} : ${ordinalFr(d.tryN)} tentative ratée`, { courierTry: d.tryN });
      // a problem of Suivi › Erreurs that becomes a real alert: the customer cancelled, or the chosen try came
      if (fresh && p.follow_status === 'alert' && p.sub_status === SUB_ERREUR && to === 'alert' && !problem) {
        await ctx.db.query(`UPDATE orders SET sub_status = NULL, updated_at = now() WHERE id = $1 AND follow_status = 'alert' AND sub_status = $2`, [a.id, SUB_ERREUR]);
        await addEvent(ctx.db, a.id, null, 'note', null, 'event', `${courierNote(c.name, a.status || a.key)} : ce n’est plus une erreur, c’est une alerte`);
        changed++;
      }
    }
    if (a.status !== p.ext_status) {
      await ctx.db.query('UPDATE orders SET ext_status=$2, ext_status_at=COALESCE($3::timestamptz, now()), updated_at=now() WHERE id=$1', [a.id, a.status.slice(0, 200), safeDate(a.at)]);
      changed++;
    }
    // The company has the parcel as soon as it says anything after « handed over » (ZR: « Confirmé au bureau »,
    // « Dispatch », « Vers wilaya »… anything after « Prêt à expédier »): it leaves Dépôt › Dispatchées, with or without
    // a pickup bag (the owner's rule, 22 Nov 2026). Kept once, the first time; a parcel the company took before the
    // depot's scan skips Dispatchées after the scan.
    if (!p.taken_at && companyHasIt(a, to)) {
      await ctx.db.query('UPDATE orders SET taken_at = COALESCE($2::timestamptz, now()) WHERE id = $1 AND taken_at IS NULL', [a.id, safeDate(a.at)]);
      changed++;
    }
    // The depot hands a parcel over by scanning it (« Dispatchées »): until then the company's « on the road » statuses
    // do not take it out of « En dispatch » (the owner's rule, 9 Nov 2026). It waits there marked « … l’a déjà pris :
    // scannez-le »; the scan clears the mark and the next sync moves it on. An end (livré, retour, perdu…) still moves it.
    if (p.follow_status === 'prepared' && to && FOLLOW_ON_ROAD.includes(to)) {
      if (p.sub_status !== SUB_TAKEN_UNSCANNED) {
        await ctx.db.query(`UPDATE orders SET sub_status = $2, updated_at = now() WHERE id = $1 AND follow_status = 'prepared'`, [a.id, SUB_TAKEN_UNSCANNED]);
        await addEvent(ctx.db, a.id, null, 'note', null, 'event', `${c.name} a pris le colis avant le scan du dépôt : il reste « En dispatch » jusqu’au scan`, { taken: true });
        changed++;
        taken.push(p.ref);
        continue;
      }
      // the safety (the owner's choice): still not scanned a day after the company took it, it follows the company's
      // status by itself — the Suivi must see its news (a failed attempt, an alert). Said in its history.
      if (!(await takenLongAgo(ctx, a.id))) continue;
      await addEvent(ctx.db, a.id, null, 'note', null, 'event', `Pas scanné au dépôt 24 h après que ${c.name} l’a pris : il suit maintenant son statut`);
    }
    // a finished parcel the company has not paid (WATCH_SQL): only its correction moves it (CORRECTED_TO), said in its
    // history below — never the same words read again
    if (watchIds.has(a.id)) {
      if (!fresh || !to || to === p.follow_status || !CORRECTED_TO[p.follow_status as FollowStatus]?.includes(to)) continue;
      corrections.set(a.id, [p.follow_status, to]);
    }
    // Suivi › Erreurs (the owner, 27 Nov 2026): the company no longer says the problem (« Commune erronée » gone, the
    // parcel back on its way): the error leaves the tab by itself and the parcel follows the company again — never
    // « Résolu » (only « Relivrer » then delivered is)
    const errorGone = !!pr && fresh && p.follow_status === 'alert' && p.sub_status === SUB_ERREUR && !problem && !!to && BACK_ON_ROAD.includes(to);
    if (errorGone) errorGoneIds.add(a.id);
    // Suivi's own work (an alert raised or handled, an exchange in progress) is not undone by the courier's
    // « en livraison » / « vers wilaya »: only an end (livré, retour, perdu…) moves such a parcel.
    if (MANUAL_HOLD.includes(p.follow_status) && to && !SYNC_ENDS.includes(to) && !errorGone) continue;
    // a treated alert is not put back to « en route » by the courier, but a new failed attempt or alert still comes in —
    // a new word from the company, not the same status read again (it would raise the treated alert again and again)
    if (p.sub_status === 'alert_traitee' && (to === 'shipped' || to === 'out_for_delivery')) continue;
    if (p.sub_status === 'alert_traitee' && to && !SYNC_ENDS.includes(to) && a.status === p.ext_status) continue;
    // marked « En retour » by the Suivi: only the company's delivered or lost moves it (the depot receives the returns);
    // one the company gave itself, it may correct: its new word puts the parcel back on its way (the owner, 27 Nov 2026)
    const returnFixed = p.follow_status === 'returning' && p.by_courier === true && fresh && !!to && BACK_ON_ROAD.includes(to);
    if (returnFixed) corrections.set(a.id, ['returning', to!]);
    if (p.follow_status === 'returning' && to !== 'delivered' && to !== 'lost' && !returnFixed) continue;
    if (to && to !== p.follow_status) {
      if (to === 'alert' && problem) problemAlerts.push(a.id);
      else byStatus.set(to, [...(byStatus.get(to) ?? []), a.id]);
      // the history line always says what the company said (« ZR : Sortie en livraison »), never « Statut ZR » alone
      courierNotes.set(a.id, courierNote(c.name, a.status || a.key));
    }
  }
  const sys = asCourier(ctx);
  // each parcel moves only from the status it had when the company was asked (an agent may have changed it meanwhile:
  // an alert raised, a swap — never overwritten by an older answer)
  const expect = new Map<number, string | null>(parcels.map((p: any) => [num(p.id), p.follow_status ?? null]));
  /** the parcels that really moved (an agent may have changed one meanwhile) */
  const moved = new Set<number>();
  for (const [status, list] of byStatus) {
    // a new alert from the company is a new one (« à traiter » again)
    const r = await setFollow(sys, { ids: list, status, note: courierNote(c.name, null), ...(status === 'alert' ? { subStatus: null } : {}) }, { system: true, courier: true, by: c.name, expect, courierNotes });
    changed += r.changed.length;
    for (const id of r.changed) moved.add(id);
  }
  // a problem to fix (« Commune erronée », « Bloqué »…): an alert of its own, in Suivi › Erreurs
  if (problemAlerts.length) {
    const r = await setFollow(sys, { ids: problemAlerts, status: 'alert', note: courierNote(c.name, null), subStatus: SUB_ERREUR }, { system: true, courier: true, by: c.name, expect, courierNotes });
    changed += r.changed.length;
    for (const id of r.changed) moved.add(id);
  }
  // Suivi › Erreurs the company no longer says: back on their way, their mark goes (the parcel leaves the tab)
  const gone = [...errorGoneIds].filter((id) => moved.has(id));
  if (gone.length) await ctx.db.query(`UPDATE orders SET sub_status = NULL WHERE id = ANY($1) AND sub_status = $2 AND follow_status <> 'alert'`, [gone, SUB_ERREUR]);
  for (const id of gone) await addEvent(ctx.db, id, null, 'note', null, 'event', `${c.name} ne signale plus d’erreur : le colis quitte « Erreurs » et suit de nouveau ${c.name}`, { errorGone: true });
  // the company corrected a status it gave: said in the order's history
  for (const [id, [from, to]] of corrections)
    if (moved.has(id)) await addEvent(ctx.db, id, null, 'note', null, 'event', `Correction de ${c.name} : « ${FOLLOW_FR[from]} » → « ${FOLLOW_FR[to]} »`, { courierFix: { from, to } });
  // the mark goes with the parcels that left « En dispatch » (24 h passed, or the company's end: livré, retour…)
  await ctx.db.query(`UPDATE orders SET sub_status = NULL WHERE company_id = $1 AND sub_status = $2 AND follow_status IS DISTINCT FROM 'prepared'`, [c.id, SUB_TAKEN_UNSCANNED]);
  // the depot manager (Management › Alertes dépôt; nobody chosen: every depot agent) gets one notification on the phone
  // for the parcels the company just took before the depot's scan — they are waiting in « En dispatch » to be scanned
  if (taken.length) {
    const what = taken.length === 1 ? taken[0] : `${taken.length} colis`;
    await sendPush(ctx, await recipients(ctx.db), {
      title: `📦 ${c.name} a pris ${what} sans le scan du dépôt`,
      body: taken.length === 1 ? 'Scannez-le dans Dépôt › En dispatch.' : `${taken.slice(0, 6).join(', ')}${taken.length > 6 ? '…' : ''} · scannez-les dans Dépôt › En dispatch.`,
      tag: `depot-taken-${c.id}`,
      url: '#/depot/prepares',
    }).catch(() => 0);
  }
  return { company: c.name, checked: parcels.length, changed, fees: feesChanged, failed: errors.length, errors: errors.slice(0, 20), ...(swaps.length ? { swaps } : {}) };
}

/** ZR's situations are not statuses: its own words for a try, a cancel and a problem (read on a real account, 26 Nov 2026) */
const SITUATION_WORDS: Partial<Record<CourierKind, { numbered: string; cancels: string[]; problems: string[] }>> = {
  zr: { numbered: 'Ne répond pas {n}', cancels: ['Commande annulée'], problems: ['Commune erronée'] },
};
const ROAD_MEANING: (FollowStatus | null | undefined)[] = [undefined, 'shipped', 'out_for_delivery', 'failed', 'alert'];
/** A company's words for « Quand une alerte commence »: its numbered try (« Ne répond pas {n} »), the tries Pilotix counts,
 *  the cancels that make an alert (said while the parcel is on its way) and those that are already its return, its problems. */
function alertWordsOf(kind: CourierKind) {
  const st = ADAPTERS[kind]?.statuses ?? {};
  // a company's ids (« non_livre », « colis_suspendu ») read as words; each word once, codes (« 31 ») left out
  const shown = (k: string) => (/^[0-9a-z_]+$/i.test(k) && k.includes('_') ? (k.charAt(0).toUpperCase() + k.slice(1).toLowerCase()).replace(/_/g, ' ') : k);
  const seen = new Set<string>();
  const words: [string, FollowStatus | null][] = [];
  for (const k of Object.keys(st)) {
    const w = shown(k);
    const key = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/^\d+$/.test(k) || /^[0-9a-z]+$/.test(k) || seen.has(key)) continue;
    seen.add(key);
    words.push([w, st[k] ?? null]);
  }
  let numbered: string | null = null;
  const tries: string[] = [];
  const cancels: string[] = [];
  const cancelsBack: string[] = [];
  const problems: string[] = [];
  for (const [w, meaning] of words) {
    const ev = courierEvent(w, meaning);
    if (!ev) continue;
    if (ev.kind === 'try') {
      if (ev.n !== null) numbered ??= w.replace(/\d+/, '{n}');
      else tries.push(w);
    } else if (ev.kind === 'cancel') {
      // a cancel said on the way makes an alert; one that is already the company's return goes to Annulés
      if (ROAD_MEANING.includes(meaning)) cancels.push(w);
      else if (meaning === 'returning' || meaning === 'returned') cancelsBack.push(w);
    } else if (ROAD_MEANING.includes(meaning)) problems.push(w);
  }
  // the words that say « a try failed » first (« Tentative échouée » before « En attente »)
  const tryLike = (w: string) => (/echou|échou|non livr|attempt|appel sans/i.test(w) ? 0 : /tentative/i.test(w) ? 1 : 2);
  tries.sort((a, b) => tryLike(a) - tryLike(b));
  const own = SITUATION_WORDS[kind];
  return {
    numbered: own?.numbered ?? numbered,
    tries: own ? [] : tries.slice(0, 3),
    cancels: [...(own?.cancels ?? []), ...cancels].slice(0, 3),
    cancelsBack: own ? [] : cancelsBack.slice(0, 2),
    problems: [...(own?.problems ?? []), ...problems].slice(0, 4),
  };
}

/** The failed tries Pilotix counted on each parcel (a company that does not number its tries; « Quand une alerte commence »). */
async function courierTriesSeen(db: Db, ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT order_id, max((data->>'courierTry')::int) AS n FROM order_events
      WHERE order_id = ANY($1) AND kind = 'note' AND user_id IS NULL AND data ? 'courierTry' GROUP BY 1`,
    [ids],
  );
  return new Map(rows.map((r: any) => [num(r.order_id), num(r.n)]));
}

// ---------------------------------------------------------------- swaps made in the company's own space
/**
 * A swap made in the company's own space, seen when Pilotix reads the parcel: it now goes to another customer (ZR gives
 * its swap to its own site only, not to API keys — read 26 Nov 2026 — so a swap is made in ZR › « Swaps »). Pilotix finds
 * that customer's order — confirmed, still at the depot, asking for exactly the parcel's products (the owner's rule: the
 * parcel is never opened) — and puts the parcel on it, like « Swap » does, its own parcel at the company cancelled first.
 * None found: said once on the order, looked for again at each read (an order made or fixed later is caught then).
 * Returns « PX1329 → PX1392 », or null.
 */
export async function catchSwapSeen(ctx: Ctx, c: CompanyRow, aId: number, seen: CourierSwapSeen): Promise<string | null> {
  const A0 = (await ctx.db.query('SELECT id, ref, phone, phone2, follow_status, shipped_at, wilaya_id FROM orders WHERE id = $1', [aId]))[0];
  if (!A0?.shipped_at || !(SWAP_FROM as readonly string[]).includes(A0.follow_status ?? '')) return null;
  const phones = [...new Set(seen.phones.map((x) => normalizePhone(x)).filter((x): x is string => !!x))];
  // still its own customer (the parcel Pilotix already gave this order, or no number read): nothing to do
  if (!phones.length || phones.includes(A0.phone) || (!!A0.phone2 && phones.includes(A0.phone2))) return null;
  const who = [seen.name, phones.join(' / ')].filter(Boolean).join(' · ');
  const key = phones.join(',');
  // said once per new customer (the parcel is read again and again)
  const say = async (k: string, text: string) => {
    const had = (await ctx.db.query(`SELECT 1 FROM order_events WHERE order_id = $1 AND kind = 'note' AND data->>'swap_seen' = $2 LIMIT 1`, [aId, k]))[0];
    if (!had) await addEvent(ctx.db, aId, null, 'note', null, 'event', text, { swap_seen: k });
  };
  // that customer's orders waiting at the depot: the same wilaya first, the oldest first
  const rows = await ctx.db.query(
    `SELECT o.id FROM sales o WHERE o.id <> $1 AND o.conf_status = 'confirmed' AND o.shipped_at IS NULL
       AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared')) AND (o.phone = ANY($2) OR o.phone2 = ANY($2))
     ORDER BY (o.wilaya_id = $3) DESC, o.confirmed_at ASC NULLS LAST, o.id ASC LIMIT 20`,
    [aId, phones, num(A0.wilaya_id)],
  );
  if (!rows.length) {
    await say(key, `${c.name} : colis swappé dans son espace vers ${who} — aucune commande confirmée en attente à ce numéro. Créez-la avec les mêmes produits : Pilotix lui donnera le colis tout seul.`);
    return null;
  }
  const ids = [aId, ...rows.map((r: any) => num(r.id))];
  const lines = await ctx.db.query('SELECT order_id, product_id, variant_id, qty FROM order_items WHERE order_id = ANY($1)', [ids]);
  const keyOf = (id: number) => itemsKey(lines.filter((l: any) => num(l.order_id) === id).map((l: any) => ({ productId: num(l.product_id), variantId: numOrNull(l.variant_id), qty: num(l.qty) })));
  const want = keyOf(aId);
  const bId = rows.map((r: any) => num(r.id)).find((id: number) => keyOf(id) === want);
  if (!bId) {
    await say(key, `${c.name} : colis swappé dans son espace vers ${who} — sa commande ne demande pas exactement les produits du colis. Corrigez-la (les mêmes produits) : Pilotix lui donnera le colis tout seul.`);
    return null;
  }
  // its own parcel already made at the company (packed, label printed): cancelled there first — else the company would
  // still pick it up and bill it (two parcels for one customer); refused there: said, nothing moves
  const own = (await ctx.db.query('SELECT ref, tracking FROM orders WHERE id = $1', [bId]))[0];
  if (own?.tracking) {
    try {
      await cancelParcel(ctx, bId);
    } catch (e: any) {
      await say(`${key}:own`, `${c.name} : colis swappé dans son espace vers ${own.ref}, mais son propre colis ${own.tracking} n’a pas pu être annulé (${e?.message ?? 'refusé'}). Annulez-le : Pilotix fera le reste tout seul.`);
      return null;
    }
  }
  const sw = await swapFees(ctx, c.id);
  const done = await ctx.db.tx(async (tx) => {
    const A = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [aId]))[0];
    const B = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [bId]))[0];
    // checked again under the lock: someone may have moved one of them meanwhile
    if (!A?.shipped_at || !(SWAP_FROM as readonly string[]).includes(A.follow_status ?? '')) return null;
    if (!B || B.conf_status !== 'confirmed' || B.shipped_at || !(B.follow_status === null || ['to_prepare', 'prepared'].includes(B.follow_status))) return null;
    const sameWilaya = num(A.wilaya_id) === num(B.wilaya_id);
    const total = Math.round(num(B.total));
    await writeSwap(tx, A, B, {
      me: null,
      sent: { extId: null, parcelExtId: seen.extId ?? (A.ext_id as string | null) ?? null, tracking: seen.tracking ?? String(A.tracking) },
      how: ` · fait dans l’espace ${c.name}, vu par Pilotix`,
      swapFee: (sameWilaya ? sw.same : sw.other) ?? 0,
      sameWilaya,
      // what the company collects now is what it was told in its space: said when it is not the order's amount
      warn: seen.amount !== null && seen.amount !== total ? `${c.name} encaissera ${seen.amount} DA, la commande dit ${total} DA` : null,
      nowIso: new Date(ctx.now()).toISOString(),
      extra: { seen_at_company: true },
    });
    return `${A.ref} → ${B.ref}`;
  });
  return done;
}
/** Does the company's answer say it has the parcel? Any word but its « before pickup » ones — those that change nothing
 *  (ZR: « Commande reçue » … « Prêt à expédier », its own « Annulé »), « À préparer », « Préparé » or « Annulé » — and
 *  never an empty one. A word Pilotix does not know yet counts: the company said something new about the parcel. */
export function companyHasIt(a: Pick<TrackResult, 'status'>, to: FollowStatus | null | undefined): boolean {
  return !!a.status?.trim() && to !== null && to !== 'to_prepare' && to !== 'prepared' && to !== 'cancelled';
}
/** How long a parcel the company took waits in « En dispatch » for the depot's scan before it moves on by itself. */
export const TAKEN_WAIT_MS = 24 * 3600_000;
/** Was this parcel taken by its company (before the depot's scan) more than TAKEN_WAIT_MS ago? From its history's note
 *  (tagged; the first ones of 9 Nov 2026 by their words). */
async function takenLongAgo(ctx: Ctx, orderId: number) {
  const at = (
    await ctx.db.query(
      `SELECT max(at) AS at FROM order_events WHERE order_id = $1 AND kind = 'note' AND (data->>'taken' = 'true' OR note LIKE '%avant le scan du dépôt%')`,
      [orderId],
    )
  )[0]?.at;
  return !!at && ctx.now() - new Date(at).getTime() >= TAKEN_WAIT_MS;
}
const safeDate = (s: string | null | undefined) => {
  if (!s) return null;
  const t = Date.parse(s);
  return isFinite(t) ? new Date(t).toISOString() : null;
};

// ---------------------------------------------------------------- the company's own words in the history
/** The note of a history line the company's status wrote: its own words (« ZR : Échec de livraison · Client
 *  injoignable »); no words (never seen with ZR): « ZR : sans détail ». Never « Statut ZR » alone (the owner's rule,
 *  24 Nov 2026). */
export const courierNote = (company: string, words: string | null | undefined) => `${company} : ${(words ?? '').trim().slice(0, 200) || COURIER_NO_WORDS}`;
const COURIER_NO_WORDS = 'sans détail';
/** What the sync wrote before 24 Nov 2026 (« Statut ZR »): these lines get the company's words of that moment. */
const OLD_COURIER_NOTE = (company: string) => `Statut ${company}`;
/** Said in place of the words when the company no longer knows the parcel (or its journey starts later). */
const COURIER_NOT_FOUND = 'statut non retrouvé';
/** Once no old line is left in the shop, this mark stops the search (« _v2 »: the lines filled on 24 Nov 2026 before
 *  the reason ZR kept from an earlier step was read are done again, once). */
const OLD_NOTES_DONE = 'courier_notes_filled_v2';
/** The lines ZR's sync wrote before its words came with each line (24 Nov 2026, 13 h 42 in Algiers): the only ones
 *  this fill writes. A line filled by its first version (marked « by », no « noteFill » 2) is filled again, once. */
const WORDS_LIVE_SINCE = '2026-11-24T12:45:00Z';
const FILL_VERSION = 2;
/** the company's clock and the server's may differ a little */
const CLOCK_MARGIN_MS = 60_000;
/** a line is written once the whole sync has read the company (up to a few minutes after it read this parcel) */
const READ_MARGIN_MS = 10 * 60_000;

/** The company's words for a parcel at `t` (a time), as the sync would have written them then: its status at that
 *  moment — the last step of its journey (oldest first) at or before it — with the reason (situation) ZR gave by then:
 *  the last one it gave on the parcel, even under an earlier step (ZR keeps it when the state changes: « Sortie en
 *  livraison · Appel téléphonique », « Dispatch dans une autre wilaya · Commande annulée »), else the step's own. The words that lead to
 *  `to` (the status the line wrote) are the ones the sync read; when the status does not lead there but one a few
 *  minutes earlier does, that one is it (the company moved again while the sync was writing). When nothing tells:
 *  the status with the last reason ZR gave. Null: the journey starts after `t` (another parcel). */
export function courierWordsAt(steps: CourierStep[], t: number, to: string | null, leadsTo: (words: string, key: string | null) => string | null | undefined): string | null {
  const by = t + CLOCK_MARGIN_MS;
  const before = steps.filter((s) => Date.parse(s.at) <= by);
  if (!before.length) return null;
  const known = (s: CourierStep) => s.situations.filter((x) => !x.at || Date.parse(x.at) <= by);
  // the last reason ZR gave on the parcel by then, whatever step it was given under
  const given = before
    .flatMap((s) => known(s).map((x) => ({ name: x.name, at: Date.parse(x.at ?? s.at) })))
    .sort((a, b) => a.at - b.at)
    .pop()?.name ?? null;
  const say = (s: CourierStep, sit: string | null | undefined) => (sit ? `${s.status} · ${sit}` : s.status);
  // what ZR shows on the parcel first (its state with the last reason it gave), then the step's own reason
  const options = (s: CourierStep) => [...new Set([say(s, given), say(s, known(s).pop()?.name)])];
  const fits = (s: CourierStep) => (to ? options(s).find((w) => leadsTo(w, s.key) === to) : undefined);
  const last = before[before.length - 1];
  const hit = fits(last) ?? [...before].reverse().filter((s) => s !== last && Date.parse(s.at) >= t - READ_MARGIN_MS).map(fits).find(Boolean);
  return hit ?? say(last, given);
}

/** The history lines the sync wrote before 24 Nov 2026 said only « Statut ZR »: each gets the company's own words of
 *  that moment, read from the parcel's journey at the company (ZR), like the lines written since. A few parcels at each
 *  sync until none is left; a parcel the company no longer knows: « ZR : statut non retrouvé ». A parcel the company
 *  could not answer for is asked again at the next syncs (3 times at most). */
export async function fillOldCourierNotes(ctx: Ctx, list: CompanyRow[], max = 30) {
  const out = { filled: 0, notFound: 0, left: false };
  if (isDemo(ctx) || ctx.shop?.demo || (await ctx.db.query('SELECT 1 FROM settings WHERE key = $1', [OLD_NOTES_DONE])).length) return out;
  for (const c of list.filter((x) => ADAPTERS[x.kind]?.steps)) {
    const old = OLD_COURIER_NOTE(c.name);
    // « Statut ZR », or filled by the first version (before the reason kept from an earlier step was read)
    const todo = `e.kind = 'follow_status' AND (e.note = $2 OR (e.at < '${WORDS_LIVE_SINCE}'::timestamptz AND e.data->>'courier' = 'true' AND e.data->>'by' IS NOT NULL
      AND coalesce((e.data->>'noteFill')::int, 1) < ${FILL_VERSION}))`;
    const orders = await ctx.db.query(
      `SELECT e.order_id, max(o.tracking) AS tracking, max(o.ext_id) AS ext_id, max(coalesce((e.data->>'noteTries')::int, 0)) AS tries
       FROM order_events e JOIN orders o ON o.id = e.order_id
       WHERE o.company_id = $1 AND o.tracking IS NOT NULL AND ${todo}
       GROUP BY e.order_id ORDER BY 4, e.order_id DESC LIMIT $3`,
      [c.id, old, max],
    );
    if (!orders.length) continue;
    out.left = true;
    const lines = await ctx.db.query(`SELECT e.id, e.order_id, e.at, e.to_value FROM order_events e WHERE e.order_id = ANY($1) AND ${todo} ORDER BY e.at`, [
      orders.map((o: any) => num(o.order_id)),
      old,
    ]);
    const defaults = ADAPTERS[c.kind]?.statuses ?? {};
    const leadsTo = (words: string, key: string | null) => resolveStatus(defaults, c.statusMap, { key: key ?? undefined, status: words }, ADAPTERS[c.kind]?.situations);
    for (const o of orders) {
      const mine = lines.filter((l: any) => num(l.order_id) === num(o.order_id));
      let steps: CourierStep[] = [];
      try {
        steps = (await courierOf(ctx)('steps', { companyId: c.id, item: { id: num(o.order_id), tracking: o.tracking, extId: o.ext_id ?? null } }, ctx)) as CourierStep[];
      } catch (e: any) {
        const msg = String(e?.message ?? '');
        // keys refused or too many calls: the rest waits for the next sync
        if (e?.status === 429 || msg.includes('refuse les clés')) break;
        // no answer (its server, the network): asked again at the next syncs, at most 3 times
        if (e?.status !== 404 && !/introuvable/i.test(msg) && num(o.tries) < 2) {
          await ctx.db.query(`UPDATE order_events SET data = coalesce(data, '{}'::jsonb) || jsonb_build_object('noteTries', $2::int) WHERE id = ANY($1)`, [mine.map((l: any) => num(l.id)), num(o.tries) + 1]);
          continue;
        }
      }
      for (const l of mine) {
        const words = courierWordsAt(steps, new Date(l.at).getTime(), l.to_value ?? null, leadsTo);
        // marked as the company's (no longer « Statut … »: « ↶ Annuler » and the history still know it is not a person's)
        await ctx.db.query(
          `UPDATE order_events SET note = $2, data = coalesce(data, '{}'::jsonb) || jsonb_build_object('courier', true, 'by', $4::text, 'noteFill', ${FILL_VERSION})
           WHERE id = $1 AND (note = $3 OR coalesce((data->>'noteFill')::int, 1) < ${FILL_VERSION})`,
          [num(l.id), courierNote(c.name, words ?? COURIER_NOT_FOUND), old, c.name],
        );
        if (words) out.filled++;
        else out.notFound++;
      }
    }
  }
  // nothing left anywhere (the sync never writes « Statut … » again): the search stops for good
  if (!out.left) await ctx.db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [OLD_NOTES_DONE, JSON.stringify({ at: new Date(ctx.now()).toISOString() })]);
  if (out.filled || out.notFound) ctx.emit({ type: 'orders' });
  return out;
}

// ---------------------------------------------------------------- livreurs and their round
async function livreursList(db: Db, now = Date.now()) {
  const inToday = await checkedInToday(db, now);
  const rows = await db.query(
    `SELECT p.id, p.name, p.phone, p.email, p.active, p.livreur_company_id, c.name AS company_name, r.end_wilaya_id, r.end_commune,
       (SELECT count(*)::int FROM orders o WHERE o.livreur_id = p.id AND o.follow_status = ANY($1)) AS to_ship,
       (SELECT count(*)::int FROM orders o WHERE o.livreur_id = p.id AND o.follow_status = ANY($2)) AS on_road
     FROM profiles p LEFT JOIN delivery_companies c ON c.id = p.livreur_company_id LEFT JOIN livreur_routes r ON r.profile_id = p.id
     WHERE 'livreur' = ANY(p.roles) ORDER BY p.active DESC, p.name`,
    [TO_SHIP, FOLLOW_ON_ROAD],
  );
  return rows.map((r: any) => ({
    id: num(r.id),
    name: r.name,
    phone: r.phone as string | null,
    email: r.email as string,
    active: !!r.active,
    companyId: numOrNull(r.livreur_company_id),
    companyName: (r.company_name ?? null) as string | null,
    endWilayaId: numOrNull(r.end_wilaya_id),
    endCommune: (r.end_commune ?? null) as string | null,
    toShip: num(r.to_ship),
    onRoad: num(r.on_road),
    /** « Je travaille aujourd'hui » today: when (null: not yet) */
    checkedInAt: inToday.get(num(r.id)) ?? null,
  }));
}

/** Farthest first, coming back to where the round ends (same wilaya and commune last). */
function sortRound(list: Order[], endWilayaId: number | null, endCommune: string | null) {
  const score = (o: Order) => (endWilayaId && o.wilayaId === endWilayaId ? (endCommune && o.commune.toLowerCase() === endCommune.toLowerCase() ? 2 : 1) : 0);
  return [...list].sort((a, b) => score(a) - score(b) || a.wilayaId - b.wilayaId || a.commune.localeCompare(b.commune, 'fr') || a.address.localeCompare(b.address, 'fr'));
}

async function tournee(ctx: Ctx, livreurId: number) {
  const route = (await ctx.db.query('SELECT end_wilaya_id, end_commune FROM livreur_routes WHERE profile_id=$1', [livreurId]))[0];
  const list = (await listOrders(ctx, { livreurId, follow: ['to_prepare', 'prepared', 'shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'], pageSize: 1000, page: 1, sort: 'updated_at', dir: 'desc', dateField: 'created_at', tickets: 'include' })).rows;
  // in his hands (after his scan): to deliver; still at the depot or on the shelf (« Dispatchées »): to take, by scanning
  const notTaken = [...TO_SHIP, 'shipped'];
  const toDeliver = sortRound(list.filter((o) => !notTaken.includes(o.followStatus!)), numOrNull(route?.end_wilaya_id), route?.end_commune ?? null);
  const pickup = list.filter((o) => notTaken.includes(o.followStatus!));
  const checkedInAt = (await checkedInToday(ctx.db, ctx.now())).get(livreurId) ?? null;
  // in his hands, to bring back to the depot: parcels going back (« Retour au dépôt ») until the depot scans them, and
  // the old product of each exchange he delivered until the depot receives it (a parts exchange brings nothing back)
  const back = await ctx.db.query(
    `SELECT o.id FROM orders o
      WHERE o.livreur_id = $1 AND (
        o.follow_status = 'returning'
        OR (o.is_exchange AND o.follow_status IN ('delivered','in_exchange','exchanged') AND o.updated_at > $2::timestamptz
            AND NOT EXISTS (SELECT 1 FROM complaints k WHERE k.exchange_order_id = o.id AND k.exchange_kind = 'parts')
            AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.note = 'Échange ' || o.ref || ' : ancien produit reçu au dépôt')))
      ORDER BY o.updated_at DESC LIMIT 100`,
    [livreurId, new Date(ctx.now() - 30 * 86_400_000).toISOString()],
  );
  const toReturn = await Promise.all(back.map((r: any) => getOrder(ctx, num(r.id))));
  const messages = await getSetting(ctx.db, 'livreurMessages');
  const today = await ctx.db.query(
    `SELECT count(*)::int AS n, coalesce(sum(total),0)::int AS amount FROM orders
     WHERE livreur_id=$1 AND follow_status='delivered' AND delivered_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Algiers') AT TIME ZONE 'Africa/Algiers'`,
    [livreurId],
  );
  const name = (await ctx.db.query('SELECT name FROM profiles WHERE id=$1', [livreurId]))[0]?.name ?? '';
  const shop = await getSetting(ctx.db, 'shop');
  return {
    shop: { name: shop.name, whatsappTemplate: shop.whatsappTemplate },
    livreur: { id: livreurId, name, endWilayaId: numOrNull(route?.end_wilaya_id), endCommune: route?.end_commune ?? null },
    toDeliver,
    pickup,
    toDeliverAmount: toDeliver.reduce((s, o) => s + o.total, 0),
    deliveredToday: num(today[0]?.n),
    deliveredTodayAmount: num(today[0]?.amount),
    /** « Je travaille aujourd'hui »: when he said it today (null: not yet) */
    checkedInAt,
    /** to bring back to the depot: parcels going back, old products of exchanges */
    toReturn,
    /** parcels in his hands: to deliver + to bring back */
    inHand: toDeliver.length + toReturn.length,
    /** Management › Livreur: the one-tap messages */
    messages,
  };
}

const livreurTarget = (ctx: Ctx, wanted?: number | null) => {
  if (isLivreurOnly(ctx.session)) return ctx.session.profile.id;
  if (wanted) return wanted;
  if (ctx.session.roles.includes('livreur')) return ctx.session.profile.id;
  throw bad('Choisissez un livreur');
};

// ---------------------------------------------------------------- procedures
const SaveCompany = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(COURIER_KINDS),
  active: z.boolean().default(true),
  phone: z.string().trim().max(30).nullable().optional(),
  settings: z.record(z.unknown()).default({}),
  /** new API keys; an empty value keeps the saved one */
  secret: z.record(z.string().max(2000)).optional(),
  clearKeys: z.boolean().optional(),
});

const FeeInput = z.object({ wilayaId: z.number().int().min(1).max(69), home: z.number().int().min(0).max(100000).nullable(), desk: z.number().int().min(0).max(100000).nullable(), returnFee: z.number().int().min(0).max(100000).nullable() });

/** A company's statuses (seen on our parcels + its known ones) and what each one does here. */
async function companyStatuses(ctx: Ctx, companyId: number) {
    const c = await companyOr404(ctx.db, companyId);
  const defaults = ADAPTERS[c.kind]?.statuses ?? {};
  const seen = await ctx.db.query(
    `SELECT ext_status AS s, count(*)::int AS n FROM orders WHERE company_id=$1 AND ext_status IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 300`,
    [companyId],
  );
  // the courier's own list of statuses (ZR's workflow), with its words
  let states: { key: string; label: string; color: string | null }[] = [];
  if (KINDS[c.kind]?.zr && c.hasKeys) {
    if (isDemo(ctx)) states = Object.keys(defaults).map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '), color: null }));
    else states = ((await courierOf(ctx)('states', { companyId }, ctx).catch(() => [])) as typeof states) ?? [];
  }
  const label = new Map(states.map((x) => [x.key, x.label]));
  const names = [...new Set([...states.map((x) => x.key), ...seen.map((r: any) => r.s as string), ...Object.keys(c.statusMap), ...Object.keys(defaults)])];
  return names.map((s) => ({
    status: s,
    label: label.get(s) ?? null,
    parcels: num(seen.find((r: any) => r.s === s)?.n),
    own: Object.prototype.hasOwnProperty.call(c.statusMap, s) ? c.statusMap[s] : undefined,
    auto: resolveStatus(defaults, {}, { status: label.get(s) ?? s, key: s }, ADAPTERS[c.kind]?.situations) ?? null,
  }));
}

/** What our statuses a courier status means once the seller's choices are applied. */
const effective = (r: { own?: string; auto: string | null }) => (r.own !== undefined ? r.own : r.auto);
/** Our statuses while the parcel is with the company: the courier statuses meaning one of them can be an alert. */
const ON_ROAD = ['shipped', 'out_for_delivery', 'failed', 'returning', 'in_exchange'];

/** What couriers usually take to give a parcel to another customer (swap): in the same wilaya, to another one. */
export const SWAP_DEFAULT = { same: 50, other: 100 } as const;

/**
 * A company's price to swap a parcel to another customer, same wilaya or another: ZR's own by its API (locked), else
 * the company's typed in « Tarifs », else 50 / 100 DA; none for our own livreurs.
 */
export async function swapFees(ctx: Ctx, companyId: number): Promise<{ same: number | null; other: number | null; fromApi: boolean }> {
  const c = (await ctx.db.query('SELECT kind, config FROM delivery_companies WHERE id = $1', [companyId]))[0];
  const kind = c?.kind as keyof typeof KINDS | undefined;
  if (!kind || kind === 'own') return { same: null, other: null, fromApi: false };
  const own = parseJson(c.config).swap ?? {};
  const pick = (v: unknown, d: number) => (typeof v === 'number' && v >= 0 ? v : d);
  const typed = { same: pick(own.same, SWAP_DEFAULT.same), other: pick(own.other, SWAP_DEFAULT.other), fromApi: false };
  if (!KINDS[kind]?.zr) return typed;
  let list: { key: string; price: number }[] = [];
  if (isDemo(ctx)) list = [{ key: 'swapSameCity', price: 50 }, { key: 'swapOtherCity', price: 100 }];
  else {
    try {
      list = ((await courierOf(ctx)('services', { companyId }, ctx)) as { key: string; price: number }[] | null) ?? [];
    } catch {
      list = [];
    }
  }
  const of = (k: string) => {
    const v = list.find((x) => x.key === k)?.price;
    return typeof v === 'number' && v > 0 ? v : null;
  };
  const same = of('swapSameCity');
  const other = of('swapOtherCity');
  return same !== null && other !== null ? { same, other, fromApi: true } : typed;
}

/**
 * A company's « Surpoids » for « Tarifs »: its rule (free kilos, DA a kilo above, also on the return), whether it is ZR's
 * own (locked: ZR weighs each parcel and gives its weight fee by its API) and whether it was set; none for our livreurs.
 */
function weightOf(kind: string, cfg: unknown) {
  if (kind === 'own') return null;
  return { ...weightRuleOf(kind, cfg), locked: feesByApi(kind), set: weightRuleSet(kind, cfg) };
}

export const deliveryProcs = {
  /** Deterministic fake courier response, using the normal tracking rules. Never available in a real shop. */
  'delivery.demoScenario': proc(['suivi', 'depot'], z.object({ orderId: id, status: z.enum(['out_for_delivery', 'alert', 'delivered', 'returning', 'lost', 'error']) }), async (ctx, i) => {
    // Check before reading or changing orders; a production context without hooks must also fail closed.
    if (ctx.server || (ctx.shop && !ctx.shop.demo)) throw forbidden('Simulation réservée à la démo');
    const o = await getOrder(ctx, i.orderId);
    if (!o.companyId || !o.shippedAt || !o.tracking || !SYNCABLE.includes(o.followStatus!)) throw bad('Choisissez un colis expédié avec un suivi actif');
    const company = await companyOr404(ctx.db, o.companyId);
    if (company.kind === 'own') throw bad('Choisissez une société de livraison');
    if (i.status === 'error') return { demo: true, checked: 1, changed: 0, error: 'Démo : API transporteur indisponible (503), aucune modification' };
    const r = await syncCompany(ctx, company, [o.id], i.status);
    if (r.changed) ctx.emit({ type: 'orders' });
    return { ...r, demo: true, error: null };
  }),
  /** Courier kinds, provider cards and custom-API placeholders (for the forms). */
  // a company removed from Pilotix (control room) is no longer offered; a shop's own companies keep their kind
  'delivery.kinds': proc([], z.object({}), async (ctx) => {
    const removed = ctx.t ? await removedCouriers(ctx.t).catch(() => ({}) as Record<string, unknown>) : {};
    return { kinds: Object.values(KINDS), cards: CARDS.filter((c) => !c.company || !(c.company in removed)), placeholders: PLACEHOLDERS, defaultTemplate: DEFAULT_TEMPLATE };
  }),

  /**
   * Each company's logo name (its card's), for its small badge that everyone sees (Suivi, Dépôt, Livré, Annulé, Caisse,
   * Réclamations): the app shows the company's own icon (couriers/icon/<logo>.webp) when Pilotix has it, else its
   * letters. `kinds`: the logo of a kind that is one company only (ZR, NOEST…), for an order whose company is not here.
   */
  'delivery.icons': proc(null, z.object({}), async (ctx) => {
    const rows = await ctx.db.query(`SELECT id, kind, config FROM delivery_companies`);
    const companies = rows.map((r: any) => {
      const settings = (parseJson(r.config) as any)?.settings ?? {};
      return { id: num(r.id), logo: r.kind === 'own' ? null : courierCardOf(CARDS, { kind: String(r.kind), settings })?.logo ?? null };
    });
    const kinds: Record<string, string> = {};
    for (const k of new Set(CARDS.map((c) => c.kind))) {
      const one = CARDS.filter((c) => c.kind === k);
      if (one.length === 1 && one[0].logo) kinds[k] = one[0].logo;
    }
    return { companies: companies as { id: number; logo: string | null }[], kinds };
  }),

  /** Companies with counts. Never returns API keys: only hasKeys / keysSet. Everyone can read the names (order forms). */
  'delivery.companies': proc(null, z.object({}), async (ctx) => {
    const list = await companies(ctx.db);
    if (ctx.session.isAdmin) return list;
    return list.map((c) => ({ ...c, settings: {}, statusMap: {}, keysSet: [] }));
  }),

  'delivery.saveCompany': proc([], SaveCompany, async (ctx, i) => {
    if (i.kind === 'custom') {
      const body = (i.settings as any)?.create?.body;
      if (!i.settings.base_url || !(i.settings as any)?.create?.path) throw bad('Mettez au moins l’adresse de l’API et le chemin pour créer un colis.');
      if (body) {
        const err = checkTemplate(String(body));
        if (err) throw bad(err);
      }
    }
    const allowed = new Set(KINDS[i.kind].fields.filter((f) => f.type === 'secret').map((f) => f.key));
    const newKeys = Object.fromEntries(Object.entries(i.secret ?? {}).filter(([k, v]) => allowed.has(k) && v.trim() !== '').map(([k, v]) => [k, v.trim()]));
    const settings = Object.fromEntries(Object.entries(i.settings).filter(([k]) => !allowed.has(k)));
    let cid = i.id;
    await ctx.db.tx(async (tx) => {
      if (cid) {
        const cur = (await tx.query('SELECT credentials, config, kind FROM delivery_companies WHERE id=$1 FOR UPDATE', [cid]))[0];
        if (!cur) throw notFound('Société introuvable');
        const cred = i.clearKeys || cur.kind !== i.kind ? {} : parseJson(cur.credentials);
        const cfg = parseJson(cur.config);
        await tx.query('UPDATE delivery_companies SET name=$2, kind=$3, active=$4, phone=$5, credentials=$6, config=$7 WHERE id=$1', [
          cid, i.name, i.kind, i.active, i.phone ?? null, JSON.stringify(sealDeep({ ...cred, ...newKeys })),
          // the courier's webhook (set from « ZR depuis Pilotix ») stays when the form does not send it back
          JSON.stringify({ ...cfg, settings: cur.kind === i.kind && cfg.settings?.webhook_id && settings.webhook_id === undefined ? { ...settings, webhook_id: cfg.settings.webhook_id } : settings }),
        ]);
      } else {
        const r = await tx.query('INSERT INTO delivery_companies (name, kind, active, phone, credentials, config) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
          i.name, i.kind, i.active, i.phone ?? null, JSON.stringify(sealDeep(newKeys)), JSON.stringify({ settings, statusMap: {} }),
        ]);
        cid = num(r[0].id);
      }
    });
    // a company with prices by API: its prices come at once (new, or its keys just typed); a failure is shown in « Tarifs »
    const saved = await companyOr404(ctx.db, cid!);
    if (KINDS[saved.kind].fees && saved.active && (saved.hasKeys || isDemo(ctx)) && (!i.id || Object.keys(newKeys).length > 0))
      await importFeesNow(ctx, cid!).catch(() => null);
    ctx.emit({ type: 'settings' });
    return saved;
  }),

  'delivery.removeCompany': proc([], z.object({ id }), async (ctx, { id: cid }) => {
    const used = num((await ctx.db.query('SELECT count(*)::int AS n FROM orders WHERE company_id=$1', [cid]))[0]?.n);
    if (used) {
      await ctx.db.query('UPDATE delivery_companies SET active=false WHERE id=$1', [cid]);
      return { removed: false, deactivated: true, orders: used };
    }
    await ctx.db.query('UPDATE profiles SET livreur_company_id=NULL WHERE livreur_company_id=$1', [cid]);
    await ctx.db.query('DELETE FROM delivery_companies WHERE id=$1', [cid]);
    ctx.emit({ type: 'settings' });
    return { removed: true, deactivated: false, orders: 0 };
  }),

  /** What the company charges per wilaya (home / stop desk / return). All 69 wilayas, null = not set. */
  'delivery.fees': proc(['depot', 'suivi', 'confirmation'], z.object({ companyId: id }), async (ctx, { companyId }) => feesOf(ctx.db, companyId)),

  /** Prices typed by hand: only for a company without prices by API (those of an API company are its own, see importFeesNow). */
  'delivery.saveFees': proc([], z.object({ companyId: id, rows: z.array(FeeInput).max(69) }), async (ctx, i) => {
    const c = await companyOr404(ctx.db, i.companyId);
    if (KINDS[c.kind].fees) throw bad(`Les prix de ${c.name} viennent de son API : ils ne se changent pas à la main (Pilotix les reprend tout seul chaque nuit)`);
    await saveFeeRows(ctx.db, i.companyId, i.rows);
    return feesOf(ctx.db, i.companyId);
  }),

  /** Takes the prices from the courier's API now (demo: a realistic grid). */
  'delivery.importFees': proc([], z.object({ companyId: id }), async (ctx, { companyId }) => importFeesNow(ctx, companyId)),

  /** The « Tarifs » window: whether the prices come from the API (locked) and their last update, the swap fees, the « Surpoids ». */
  'delivery.feesInfo': proc(['depot', 'suivi', 'confirmation'], z.object({ companyId: id }), async (ctx, { companyId }) => {
    const c = await companyOr404(ctx.db, companyId);
    const cfg = parseJson((await ctx.db.query('SELECT config FROM delivery_companies WHERE id=$1', [companyId]))[0]?.config);
    const s: Partial<FeesSync> = cfg.feesSync ?? {};
    return { api: !!KINDS[c.kind].fees, syncedAt: s.at ?? null, changed: s.changed ?? null, error: s.error ?? null, swap: await swapFees(ctx, companyId), weight: weightOf(c.kind, cfg) };
  }),

  /**
   * A company's « Surpoids » typed in « Tarifs »: free up to `freeKg`, then `perKg` DA for every whole kilo above, on the
   * delivery and — `onReturn` — on the return too (perKg 0: it takes none). Not ZR's (it weighs each parcel and gives its
   * weight fee by its API) nor our own livreurs'. The parcels not paid yet follow: their cost (the caisse, the profit)
   * drops the old weight fee and takes the new one.
   */
  'delivery.saveWeightRule': proc(
    [],
    z.object({ companyId: id, freeKg: z.number().int().min(0).max(100), perKg: z.number().int().min(0).max(100_000), onReturn: z.boolean() }),
    async (ctx, i) => {
      const row = (await ctx.db.query('SELECT name, kind, config FROM delivery_companies WHERE id=$1', [i.companyId]))[0];
      if (!row) throw notFound('Société introuvable');
      if (row.kind === 'own') throw bad('Vos livreurs : pas de surpoids');
      if (feesByApi(row.kind)) throw bad(`${row.name} pèse lui-même chaque colis : son surpoids vient de son API`);
      const cfg = parseJson(row.config);
      const old = weightRuleOf(row.kind, cfg);
      const next: WeightRule = { freeKg: i.freeKg, perKg: i.perKg, onReturn: i.onReturn };
      const moved = await ctx.db.tx(async (tx) => {
        await tx.query('UPDATE delivery_companies SET config=$2 WHERE id=$1', [i.companyId, JSON.stringify({ ...cfg, overweight: next })]);
        // its parcels sent and not paid yet: the weight fee in their cost follows the new rule
        const open = await tx.query(
          `SELECT o.id, o.courier_fees, (SELECT coalesce(sum(p.weight_kg * it.qty), 0) FROM order_items it JOIN products p ON p.id = it.product_id WHERE it.order_id = o.id) AS kg
           FROM orders o WHERE o.company_id = $1 AND NOT o.cashed AND o.delivery_cost > 0 AND o.livreur_id IS NULL`,
          [i.companyId],
        );
        const ids: number[] = [];
        const diffs: number[] = [];
        for (const o of open) {
          const kg = knownKg(o.courier_fees, o.kg);
          const d = ruleFee(row.kind, next, kg) - ruleFee(row.kind, old, kg);
          if (d) {
            ids.push(num(o.id));
            diffs.push(d);
          }
        }
        if (ids.length) await tx.query('UPDATE orders o SET delivery_cost = GREATEST(0, o.delivery_cost + v.d) FROM unnest($1::bigint[], $2::int[]) AS v(id, d) WHERE o.id = v.id', [ids, diffs]);
        return ids.length;
      });
      if (moved) ctx.emit({ type: 'orders' });
      return { weight: weightOf(row.kind, { ...cfg, overweight: next }), moved };
    },
  ),

  /**
   * Dashboard › Suivi › « Surpoids » : the period's parcels a company weighed heavier than Pilotix declared and took a
   * weight fee for (ZR by its API; another company that says the weight it found, by its « Surpoids ») — per product (the heaviest one of each parcel), how many, the weights, what it cost.
   */
  'delivery.overweight': proc(['suivi', 'agent_manager', 'vendeur'], z.object({ from: z.string().max(40), to: z.string().max(40) }), async (ctx, i) => {
    const rows = await ctx.db.query(
      `SELECT o.id, o.ref, o.follow_status, o.courier_fees, co.name AS company, co.kind, co.config,
         (SELECT coalesce(sum(p.weight_kg * it.qty), 0) FROM order_items it JOIN products p ON p.id = it.product_id WHERE it.order_id = o.id) AS kg
       FROM sales o JOIN delivery_companies co ON co.id = o.company_id
       WHERE (o.courier_fees->>'kg') IS NOT NULL
         AND ((o.follow_status = 'delivered' AND o.delivered_at >= $1 AND o.delivered_at < $2)
           OR (o.follow_status IN ('returning','returned') AND coalesce(o.returned_at, o.returning_at, o.updated_at) >= $1 AND coalesce(o.returned_at, o.returning_at, o.updated_at) < $2))`,
      [i.from, i.to],
    );
    const heavy = rows
      .map((r: any) => {
        const f = apiFees(r.courier_fees);
        const zr = wholeKg(courierFeesOf(r.courier_fees)?.kg);
        const declared = declaredKg(r.kg);
        const back = r.follow_status !== 'delivered';
        // ZR: its own weight fee; another company that said the weight it found: its « Surpoids » on that weight
        const rule = weightRuleOf(r.kind, r.config);
        const byRule = back && !rule.onReturn ? 0 : ruleFee(r.kind, rule, zr ?? 0);
        const fee = f ? (back ? f.weightRet : f.weight) : byRule;
        return { id: num(r.id), ref: String(r.ref), company: String(r.company), declared, zr, fee, back, exact: !!f?.exact };
      })
      .filter((x: any) => x.zr !== null && x.fee > 0);
    // each parcel under its heaviest product
    const items = heavy.length
      ? await ctx.db.query(`SELECT it.order_id, p.id, p.name, p.weight_kg, it.qty FROM order_items it JOIN products p ON p.id = it.product_id WHERE it.order_id = ANY($1)`, [heavy.map((x: any) => x.id)])
      : [];
    const main = new Map<number, any>();
    for (const it of items) {
      const cur = main.get(num(it.order_id));
      if (!cur || Number(it.weight_kg) * num(it.qty) > Number(cur.weight_kg) * num(cur.qty)) main.set(num(it.order_id), it);
    }
    const by = new Map<number, { productId: number; name: string; productKg: number; parcels: number; zrMin: number; zrMax: number; fees: number }>();
    for (const x of heavy) {
      const it = main.get(x.id);
      if (!it) continue;
      const g = by.get(num(it.id)) ?? { productId: num(it.id), name: String(it.name), productKg: Number(it.weight_kg) || 0, parcels: 0, zrMin: x.zr!, zrMax: x.zr!, fees: 0 };
      g.parcels++;
      g.zrMin = Math.min(g.zrMin, x.zr!);
      g.zrMax = Math.max(g.zrMax, x.zr!);
      g.fees += x.fee;
      by.set(g.productId, g);
    }
    return {
      total: { parcels: heavy.length, fees: heavy.reduce((s: number, x: any) => s + x.fee, 0), extraKg: heavy.reduce((s: number, x: any) => s + (x.zr! - x.declared), 0) },
      products: [...by.values()].sort((a, b) => b.fees - a.fees || b.parcels - a.parcels),
      parcels: heavy.sort((a: any, b: any) => b.fee - a.fee).slice(0, 30),
    };
  }),

  /** A company's swap fees typed by hand (when it does not give them by API); nothing for our own livreurs. */
  'delivery.saveSwapFees': proc([], z.object({ companyId: id, same: z.number().int().min(0).max(100_000), other: z.number().int().min(0).max(100_000) }), async (ctx, i) => {
    const row = (await ctx.db.query('SELECT name, kind, config FROM delivery_companies WHERE id=$1', [i.companyId]))[0];
    if (!row) throw notFound('Société introuvable');
    if (row.kind === 'own') throw bad('Vos livreurs : pas de frais d’échange');
    if ((await swapFees(ctx, i.companyId)).fromApi) throw bad(`Les frais d’échange de ${row.name} viennent de son API : ils ne se changent pas à la main`);
    await ctx.db.query('UPDATE delivery_companies SET config=$2 WHERE id=$1', [i.companyId, JSON.stringify({ ...parseJson(row.config), swap: { same: i.same, other: i.other } })]);
    return swapFees(ctx, i.companyId);
  }),

  'delivery.stopdesks': proc(null, z.object({ companyId: id, wilayaId: z.number().int().min(1).max(69).optional() }), async (ctx, i) => {
    const rows = await ctx.db.query(
      `SELECT * FROM stopdesks WHERE company_id=$1 AND gone_at IS NULL ${i.wilayaId ? 'AND wilaya_id=$2' : ''} ORDER BY wilaya_id, commune, name`,
      i.wilayaId ? [i.companyId, i.wilayaId] : [i.companyId],
    );
    return rows.map((r: any) => ({ id: num(r.id), companyId: num(r.company_id), wilayaId: num(r.wilaya_id), commune: r.commune, name: r.name, address: r.address, extId: r.ext_id as string | null }));
  }),

  /** Re-imports the stop desks from the courier (demo: one per big city). */
  'delivery.importStopdesks': proc([], z.object({ companyId: id }), async (ctx, { companyId }) => {
    const c = await companyOr404(ctx.db, companyId);
    if (!KINDS[c.kind].desks) throw bad(`${c.name} : pas de liste de stop desks par API`);
    let desks: Desk[];
    if (isDemo(ctx)) {
      const cities: [number, string][] = [[16, 'Bab Ezzouar'], [16, 'Hydra'], [31, 'Oran'], [25, 'Constantine'], [9, 'Blida'], [19, 'Sétif'], [23, 'Annaba'], [6, 'Béjaïa'], [15, 'Tizi Ouzou'], [30, 'Ouargla']];
      desks = cities.map(([w, com], k) => ({ extId: `${w}${String(k + 1).padStart(2, '0')}`, name: `${c.name} ${com}`, wilayaId: w, commune: com, address: 'Centre-ville' }));
    } else desks = (await courierOf(ctx)('stopdesks', { companyId }, ctx)) as Desk[];
    let closed = 0;
    await ctx.db.tx(async (tx) => {
      await tx.query('SELECT id FROM delivery_companies WHERE id = $1 FOR UPDATE', [companyId]);
      for (const d of desks) {
        if (!d.wilayaId) continue;
        const cur = (await tx.query('SELECT id FROM stopdesks WHERE company_id=$1 AND ext_id=$2', [companyId, d.extId]))[0];
        if (cur) await tx.query('UPDATE stopdesks SET wilaya_id=$2, commune=$3, name=$4, address=$5, gone_at=NULL WHERE id=$1', [cur.id, d.wilayaId, d.commune ?? '', d.name, d.address ?? '']);
        else await tx.query('INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address, ext_id) VALUES ($1,$2,$3,$4,$5,$6)', [companyId, d.wilayaId, d.commune ?? '', d.name, d.address ?? '', d.extId]);
      }
      // Only ZR's adapter verifies that its paginated snapshot is complete. Never infer closures from
      // an empty or unmappable snapshot, or hide desks that were entered without a carrier ID.
      if (c.kind === 'zr' && desks.length && desks.every((d) => d.wilayaId && d.extId))
        closed = (
          await tx.query(
            `UPDATE stopdesks SET gone_at = $3 WHERE company_id = $1 AND gone_at IS NULL AND ext_id IS NOT NULL AND ext_id <> ALL($2::text[]) RETURNING id`,
            [companyId, desks.map((d) => String(d.extId)), new Date(ctx.now()).toISOString()],
          )
        ).length;
    });
    return { imported: desks.length, closed };
  }),

  'delivery.saveStopdesk': proc([], z.object({ companyId: id, id: id.optional(), wilayaId: z.number().int().min(1).max(69), commune: z.string().max(120).default(''), name: z.string().trim().min(1).max(160), address: z.string().max(300).default(''), extId: z.string().max(60).nullable().optional() }), async (ctx, i) => {
    if (i.id) await ctx.db.query('UPDATE stopdesks SET wilaya_id=$3, commune=$4, name=$5, address=$6, ext_id=$7 WHERE id=$1 AND company_id=$2', [i.id, i.companyId, i.wilayaId, i.commune, i.name, i.address, i.extId ?? null]);
    else await ctx.db.query('INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address, ext_id) VALUES ($1,$2,$3,$4,$5,$6)', [i.companyId, i.wilayaId, i.commune, i.name, i.address, i.extId ?? null]);
    return { ok: true };
  }),
  'delivery.removeStopdesk': proc([], z.object({ id }), async (ctx, i) => {
    await ctx.db.query('UPDATE orders SET stopdesk_id=NULL WHERE stopdesk_id=$1 AND tracking IS NULL', [i.id]);
    await ctx.db.query('DELETE FROM stopdesks WHERE id=$1', [i.id]);
    return { ok: true };
  }),

  /** Status mapping: the courier's statuses (seen on our parcels + its known ones) and what each one does here. */
  'delivery.statuses': proc([], z.object({ companyId: id }), (ctx, { companyId }) => companyStatuses(ctx, companyId)),

  /** Préférences › Alertes du Suivi: each delivery company's statuses that can send a parcel to Suivi › Alertes, ticked when they do. */
  /** Suivi › Réglages › « Quand une alerte commence »: each delivery company's own words for a failed try, a cancel and a
   *  problem (from its statuses in Pilotix), and the shop's own companies (« Vos sociétés »). */
  'delivery.alertWords': proc([], z.object({}), async (ctx) => {
    const cos = await ctx.db.query(`SELECT DISTINCT kind FROM delivery_companies WHERE active AND kind NOT IN ('own', 'manual', 'custom')`);
    const mine = new Set(cos.map((r: any) => String(r.kind)));
    const kinds = (Object.keys(ADAPTERS) as CourierKind[]).filter((k) => !['own', 'manual', 'custom'].includes(k));
    return kinds.map((k) => ({ kind: k, label: KINDS[k]?.label ?? k, mine: mine.has(k), ...alertWordsOf(k) })).sort((a, b) => Number(b.mine) - Number(a.mine));
  }),

  'delivery.alertStatuses': proc([], z.object({}), async (ctx) => {
    const cos = await ctx.db.query(`SELECT id, name FROM delivery_companies WHERE active AND kind NOT IN ('own') ORDER BY name`);
    const out = [];
    for (const c of cos) {
      const rows = await companyStatuses(ctx, num(c.id));
      out.push({
        companyId: num(c.id),
        name: String(c.name),
        // only what happens while the parcel is with the company (not before it takes it, not once it ends); most seen first
        statuses: rows
          .filter((r) => effective(r) === 'alert' || ON_ROAD.includes(String(effective(r))))
          .sort((x, y) => y.parcels - x.parcels)
          .map((r) => ({ status: r.status, label: r.label, parcels: r.parcels, alert: effective(r) === 'alert' })),
      });
    }
    return out;
  }),

  /** Saves which of a company's statuses send a parcel to Suivi › Alertes (the other mappings stay as they are). */
  'delivery.saveAlertStatuses': proc([], z.object({ companyId: id, alert: z.array(z.string().max(120)).max(200) }), async (ctx, i) => {
    const cur = (await ctx.db.query('SELECT config FROM delivery_companies WHERE id=$1', [i.companyId]))[0];
    if (!cur) throw notFound('Société introuvable');
    const cfg = parseJson(cur.config);
    const map: Record<string, string> = { ...(cfg.statusMap ?? {}) };
    for (const r of await companyStatuses(ctx, i.companyId)) {
      const want = i.alert.includes(r.status);
      const now = effective(r) === 'alert';
      if (want && !now) map[r.status] = 'alert';
      // unticked: back to what the courier status means by itself, or still on the road when that is an alert
      if (!want && now) {
        if (r.auto === 'alert') map[r.status] = 'out_for_delivery';
        else delete map[r.status];
      }
    }
    await ctx.db.query('UPDATE delivery_companies SET config=$2 WHERE id=$1', [i.companyId, JSON.stringify({ ...cfg, statusMap: map })]);
    return { ok: true };
  }),

  /** ZR from Pilotix: instant status updates (webhook) and ZR's prices for its services. */
  'delivery.zr': proc([], z.object({ companyId: id }), async (ctx, { companyId }) => {
    const c = await companyOr404(ctx.db, companyId);
    if (!KINDS[c.kind]?.zr) throw bad(`${c.name} : pas disponible avec cette société`);
    const extId = String((c.settings as any).webhook_id ?? '') || null;
    const hookUrl = publicApi(ctx) ? `${publicApi(ctx)}/hooks/courier/${c.id}` : null;
    if (isDemo(ctx))
      return {
        webhook: { on: !!extId, extId, url: extId ? `https://votre-serveur.dz/api/hooks/courier/${c.id}` : null, error: null as string | null },
        hookUrl: `https://votre-serveur.dz/api/hooks/courier/${c.id}`,
        services: [
          { key: 'swapSameCity', label: 'Échange (même wilaya)', price: 50 },
          { key: 'swapOtherCity', label: 'Échange (autre wilaya)', price: 100 },
          { key: 'phoneChange', label: 'Changement de téléphone', price: 50 },
          { key: 'labeling', label: 'Étiquetage', price: 30 },
          { key: 'weighting', label: 'Pesée', price: 20 },
          { key: 'officeHolding', label: 'Garde au bureau', price: 50 },
          { key: 'officeHoldingFreeHours', label: 'Heures de garde gratuites', price: 72 },
        ],
        servicesError: null as string | null,
      };
    let webhook = { on: false, extId, url: null as string | null, error: null as string | null };
    if (extId) {
      try {
        const w = (await courierOf(ctx)('webhookGet', { companyId, extId }, ctx)) as { on: boolean; url: string | null } | null;
        webhook = w ? { ...webhook, on: w.on, url: w.url } : { ...webhook, error: `${c.name} ne connaît plus ce webhook : réactivez-le` };
      } catch (e: any) {
        webhook.error = e?.message ?? 'Erreur';
      }
    }
    let services: { key: string; label: string; price: number }[] | null = null;
    let servicesError: string | null = null;
    try {
      services = (await courierOf(ctx)('services', { companyId }, ctx)) as typeof services;
    } catch (e: any) {
      servicesError = e?.message ?? 'Erreur';
    }
    return { webhook, hookUrl, services, servicesError };
  }),

  /** Turns instant status updates on: ZR calls Pilotix on every status change (no waiting for the 30-minute sync). */
  'delivery.webhookOn': proc([], z.object({ companyId: id }), async (ctx, { companyId }) => {
    const c = await companyOr404(ctx.db, companyId);
    const mode = KINDS[c.kind]?.webhook;
    if (!mode) throw bad(`${c.name} : pas de mises à jour en direct avec cette société (Pilotix lui demande les statuts toutes les 5 minutes)`);
    if (!c.hasKeys) throw bad(`Clés API manquantes pour ${c.name}`);
    const bytes = new Uint8Array(18);
    globalThis.crypto.getRandomValues(bytes);
    const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    let extId = 'demo-hook';
    if (mode === 'manual') {
      if (!isDemo(ctx) && !publicApi(ctx)) throw bad('Adresse publique du serveur manquante (PUBLIC_URL) : la société ne saurait pas où prévenir Pilotix');
      extId = 'manual';
    } else if (!isDemo(ctx)) {
      if (!publicApi(ctx)) throw bad('Adresse publique du serveur manquante (PUBLIC_URL) : la société ne saurait pas où prévenir Pilotix');
      const old = String((c.settings as any).webhook_id ?? '');
      if (old) await courierOf(ctx)('webhookOff', { companyId, extId: old }, ctx).catch(() => null);
      const url = `${publicApi(ctx)}/hooks/courier/${c.id}?key=${key}`;
      extId = ((await courierOf(ctx)('webhookOn', { companyId, url, key }, ctx)) as { extId: string }).extId;
    }
    await ctx.db.query(
      `UPDATE delivery_companies SET credentials = credentials || jsonb_build_object('webhook_key', $2::text),
         config = jsonb_set(COALESCE(config, '{}'::jsonb), '{settings}', COALESCE(config->'settings', '{}'::jsonb) || jsonb_build_object('webhook_id', $3::text)) WHERE id = $1`,
      [c.id, sealString(key), extId],
    );
    // the courier's space asks for the address by hand (Yalidine: Développement → Webhooks): shown once, to paste there
    const base = publicApi(ctx) || 'https://votre-serveur.dz/api';
    return { ok: true, manual: mode === 'manual', url: `${base}/hooks/courier/${c.id}?key=${key}` };
  }),

  /** Instant status updates of one company: how it works with it, and whether it is on. */
  'delivery.live': proc([], z.object({ companyId: id }), async (ctx, { companyId }) => {
    const c = await companyOr404(ctx.db, companyId);
    const mode = KINDS[c.kind]?.webhook ?? null;
    const extId = String((c.settings as any).webhook_id ?? '') || null;
    return { mode, on: !!extId, pollMinutes: 5 };
  }),

  'delivery.webhookOff': proc([], z.object({ companyId: id }), async (ctx, { companyId }) => {
    const c = await companyOr404(ctx.db, companyId);
    const extId = String((c.settings as any).webhook_id ?? '');
    if (extId && extId !== 'manual' && !isDemo(ctx)) await courierOf(ctx)('webhookOff', { companyId, extId }, ctx);
    await ctx.db.query(
      `UPDATE delivery_companies SET credentials = credentials - 'webhook_key', config = jsonb_set(COALESCE(config, '{}'::jsonb), '{settings}', COALESCE(config->'settings', '{}'::jsonb) - 'webhook_id') WHERE id = $1`,
      [c.id],
    );
    return { ok: true };
  }),

  /** Server: the courier says a parcel's status changed (webhook). Its state is read again from the courier itself. */
  'delivery.hook': proc([], z.object({ companyId: id, key: z.string().max(200), trackings: z.array(z.string().max(80)).max(200).default([]), extIds: z.array(z.string().max(80)).max(200).default([]) }), async (ctx, i) => {
    const row = (await ctx.db.query('SELECT credentials FROM delivery_companies WHERE id = $1', [i.companyId]))[0];
    const key = String((parseJson(row?.credentials) as Record<string, unknown>).webhook_key ?? '');
    if (!row || !key || !sameSecret(key, i.key)) throw bad('Clé du webhook invalide');
    const c = await companyOr404(ctx.db, i.companyId);
    const ids = i.trackings.length || i.extIds.length
      ? (await ctx.db.query('SELECT id FROM orders WHERE company_id = $1 AND (upper(tracking) = ANY($2) OR ext_id = ANY($3))', [c.id, i.trackings.map((x) => x.toUpperCase()), i.extIds])).map((r: any) => num(r.id))
      : undefined;
    if (ids && !ids.length) return { checked: 0, changed: 0 };
    const r = await syncCompany(ctx, c, ids);
    if (r.changed) ctx.emit({ type: 'orders' });
    return { checked: r.checked, changed: r.changed };
  }),

  'delivery.saveStatuses': proc([], z.object({ companyId: id, map: z.record(z.string().max(30)) }), async (ctx, i) => {
    const cur = (await ctx.db.query('SELECT config FROM delivery_companies WHERE id=$1', [i.companyId]))[0];
    if (!cur) throw notFound('Société introuvable');
    const cfg = parseJson(cur.config);
    await ctx.db.query('UPDATE delivery_companies SET config=$2 WHERE id=$1', [i.companyId, JSON.stringify({ ...cfg, statusMap: i.map })]);
    return { ok: true };
  }),

  /** Creates the parcels at the couriers: gives each order its tracking number. The delivery status does not change. */
  'delivery.send': proc(['depot', 'suivi'], z.object({ ids, companyId: id.optional() }), async (ctx, i) => sendOrders(ctx, i.ids, i.companyId ?? null)),

  /** Asks every courier with an API for the status of its parcels on the road and updates them. */
  'delivery.sync': proc(['suivi', 'depot'], z.object({ companyId: id.optional(), fast: z.boolean().optional(), oldNotes: z.boolean().optional() }), async (ctx, i) => {
    // fast (every 5 minutes): the companies that tell Pilotix themselves (webhook on) are left to their webhook and
    // checked only in the full sync (every 30 minutes), in case a call was lost
    const list = (await companies(ctx.db)).filter(
      (c) => c.active && KINDS[c.kind]?.api && c.hasKeys && (!i.companyId || c.id === i.companyId) && !(i.fast && String((c.settings as any).webhook_id ?? '')),
    );
    const out: { company: string; checked: number; changed: number; failed?: number; errors?: { ref: string; error: string }[]; error?: string }[] = [];
    for (const c of list) {
      try {
        out.push(await syncCompany(ctx, c, undefined, undefined, !i.fast));
      } catch (e: any) {
        out.push({ company: c.name, checked: 0, changed: 0, error: e?.message ?? 'Erreur' });
      }
    }
    if (out.some((x) => x.changed)) ctx.emit({ type: 'orders' });
    // ZR's answers to the modification requests (applied to the orders), and how far it is with the pickup bags
    // each step's failure is returned (shown to the suivi) instead of being dropped
    const steps: { step: string; error: string }[] = [];
    const step = async <T>(name: string, run: () => Promise<T>, empty: T): Promise<T> => {
      try {
        return await run();
      } catch (e: any) {
        steps.push({ step: name, error: String(e?.message ?? 'Erreur').slice(0, 300) });
        return empty;
      }
    };
    await step('Demandes de modification', () => import('./parcels').then((m) => m.syncChanges(ctx)), null);
    await step('Sacs d’enlèvement', () => import('./pickup').then((m) => m.syncBags(ctx, i.companyId)), null);
    // the server's sync only (never an agent's « Actualiser »): the old « Statut ZR » lines get ZR's words, a few each time
    const oldNotes = i.oldNotes && !i.companyId && ctx.session.isAdmin
      ? await step('Anciens statuts', async () => fillOldCourierNotes(ctx, (await companies(ctx.db)).filter((c) => c.active && KINDS[c.kind]?.api && c.hasKeys)), null)
      : null;
    // the companies' payments (ZR): demande de paiement when money is ready, payments imported into the caisse
    // Suivi › Bloqués: a parcel still without news 2 days after it was « bloqué »: a claim to its company by itself
    if (!i.fast && !i.companyId && ctx.session.isAdmin) await step('Bloqués : réclamations', () => import('./suivi').then((m) => m.stuckAutoClaims(ctx)), null);
    const payments = i.companyId || !ctx.session.isAdmin ? [] : await step('Paiements des sociétés', () => import('./courierpay').then((m) => m.payRunAll(ctx)), [] as any[]);
    return {
      companies: out,
      checked: out.reduce((s, x) => s + x.checked, 0),
      changed: out.reduce((s, x) => s + x.changed, 0),
      failed: out.reduce((s, x) => s + (x.failed ?? 0), 0),
      payments,
      steps,
      ...(oldNotes ? { oldNotes } : {}),
    };
  }),

  /** One parcel read again from its company now (« J’ai fait le swap dans ZR »): its status, and a swap made in the
   *  company's own space put on its new customer's order at once (`swaps`: « PX1329 → PX1392 »). */
  'delivery.syncOne': proc(['suivi', 'confirmation'], z.object({ orderId: id }), async (ctx, { orderId }) => {
    const o = await getOrder(ctx, orderId);
    if (!o.companyId || !o.tracking) throw bad(`${o.ref} : pas de colis chez une société`);
    const c = await companyOr404(ctx.db, o.companyId);
    if (!KINDS[c.kind]?.api || isDemo(ctx)) return { changed: 0, swaps: [] as string[] };
    const r = (await syncCompany(ctx, c, [orderId])) as { changed: number; errors?: { ref: string; error: string }[]; swaps?: string[] };
    if (r.changed) ctx.emit({ type: 'orders' });
    if (r.errors?.[0]) throw bad(r.errors[0].error);
    return { changed: r.changed, swaps: r.swaps ?? [] };
  }),

  /** The courier's label for one parcel: a link or a PDF (base64). null = print our own slip. */
  'delivery.label': proc(['depot', 'suivi'], z.object({ orderId: id }), async (ctx, { orderId }): Promise<LabelResult | null> => companyLabel(ctx, orderId)),

  /** The couriers' labels of several parcels (En dispatch), one entry per file: ZR gives one file for all its parcels,
   *  the others one per parcel. label null without error = the courier gives none (Pilotix prints its own). */
  'delivery.labels': proc(['depot', 'suivi'], z.object({ ids: z.array(id).min(1).max(300) }), async (ctx, { ids }) => companyLabels(ctx, ids)),

  /** Cancels the parcel at the courier (before pickup) and removes the tracking number. */
  'delivery.cancel': proc(['depot', 'suivi'], z.object({ orderId: id }), async (ctx, { orderId }) => {
    await cancelParcel(ctx, orderId);
    return { ok: true };
  }),

  /** Checks the API keys with a harmless call. */
  'delivery.test': proc([], z.object({ companyId: id }), async (ctx, { companyId }) => {
    const c = await companyOr404(ctx.db, companyId);
    if (!KINDS[c.kind].api) return { ok: true, message: `${c.name} n’a pas d’API : rien à tester.` };
    if (!c.hasKeys) return { ok: false, message: `Clés API manquantes pour ${c.name}` };
    if (isDemo(ctx)) return { ok: true, message: `Connexion réussie à ${c.name} (démo : société simulée).` };
    try {
      return (await courierOf(ctx)('test', { companyId }, ctx)) as { ok: boolean; message: string };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? 'Erreur' };
    }
  }),

  /** What would be sent for one order (no sending): our normalized parcel, and for "Autre API" the exact request (keys masked). */
  'delivery.preview': proc([], z.object({ companyId: id, orderId: id.optional() }), async (ctx, i) => {
    const c = await companyOr404(ctx.db, i.companyId);
    let oid = i.orderId;
    if (!oid) {
      const r = (await ctx.db.query(`SELECT id FROM orders WHERE company_id=$1 AND follow_status = ANY($2) ORDER BY updated_at DESC LIMIT 1`, [c.id, TO_SHIP]))[0]
        ?? (await ctx.db.query(`SELECT id FROM orders WHERE conf_status='confirmed' ORDER BY created_at DESC LIMIT 1`))[0];
      if (!r) throw bad('Aucune commande pour l’aperçu');
      oid = num(r.id);
    }
    const parcel = (await loadParcels(ctx.db, [oid]))[0];
    if (!parcel) throw notFound('Commande introuvable');
    let request: PreviewResult | null = null;
    let error: string | null = null;
    if (c.kind === 'custom') {
      try {
        request = await custom.preview!(await loadCompany(ctx.db, c.id), parcel);
      } catch (e: any) {
        error = e?.message ?? 'Erreur';
      }
    }
    const { items: _items, ...rest } = parcel;
    return { company: c.name, kind: c.kind, ref: parcel.ref, parcel: rest, items: parcel.items, request, error };
  }),

  /** Own livreurs (accounts with the Livreur role): Livreur, Compte, Fin de tournée, À expédier, En livraison. */
  'delivery.livreurs': proc(['suivi', 'depot'], z.object({}), async (ctx) => livreursList(ctx.db, ctx.now())),

  'delivery.saveLivreur': proc([], z.object({ profileId: id, companyId: id.nullable().optional(), endWilayaId: z.number().int().min(1).max(69).nullable(), endCommune: z.string().max(120).nullable() }), async (ctx, i) => {
    const p = (await ctx.db.query(`SELECT id FROM profiles WHERE id=$1 AND 'livreur' = ANY(roles)`, [i.profileId]))[0];
    if (!p) throw notFound('Livreur introuvable');
    await ctx.db.query(
      `INSERT INTO livreur_routes (profile_id, end_wilaya_id, end_commune) VALUES ($1,$2,$3)
       ON CONFLICT (profile_id) DO UPDATE SET end_wilaya_id=EXCLUDED.end_wilaya_id, end_commune=EXCLUDED.end_commune, updated_at=now()`,
      [i.profileId, i.endWilayaId, i.endCommune || null],
    );
    if (i.companyId !== undefined) await ctx.db.query('UPDATE profiles SET livreur_company_id=$2 WHERE id=$1', [i.profileId, i.companyId]);
    return { ok: true };
  }),

  /** "Ma tournée": the livreur's parcels (to deliver, sorted for the round; to pick up at the depot) and today's numbers. */
  'delivery.tournee': proc(['livreur', 'suivi', 'depot'], z.object({ livreurId: id.optional() }), async (ctx, i) => tournee(ctx, livreurTarget(ctx, i.livreurId))),

  /** Route sheet to print: a livreur's round, or the parcels to hand over to a company. */
  'delivery.routeSheet': proc(['livreur', 'suivi', 'depot'], z.object({ livreurId: id.optional(), companyId: id.optional() }), async (ctx, i) => {
    const shop = await getSetting(ctx.db, 'shop');
    const logo = (await getSetting(ctx.db, 'logo')).url ?? null;
    if (i.companyId && !isLivreurOnly(ctx.session)) {
      const c = await companyOr404(ctx.db, i.companyId);
      const rows = (await listOrders(ctx, { companyId: c.id, follow: ['prepared', 'shipped', 'out_for_delivery', 'failed', 'alert'], pageSize: 1000, page: 1, sort: 'wilaya_id', dir: 'asc', dateField: 'created_at', tickets: 'include' })).rows;
      const own = c.kind === 'own';
      const list = own ? rows : rows.filter((o) => o.tracking || o.followStatus === 'prepared');
      return { shop: shop.name, logo, title: `Feuille de route · ${c.name}`, who: c.name, phone: c.phone, date: new Date(ctx.now()).toISOString(), orders: list, total: list.reduce((s, o) => s + o.total, 0) };
    }
    const t = await tournee(ctx, livreurTarget(ctx, i.livreurId));
    const phone = (await ctx.db.query('SELECT phone FROM profiles WHERE id=$1', [t.livreur.id]))[0]?.phone ?? null;
    const orders = [...t.toDeliver, ...t.pickup];
    return { shop: shop.name, logo, title: `Feuille de route · ${t.livreur.name}`, who: t.livreur.name, phone, date: new Date(ctx.now()).toISOString(), orders, total: orders.reduce((s, o) => s + o.total, 0) };
  }),
};

/** Is this session limited to its own deliveries (livreur only)? */
export const livreurOnly = isLivreurOnly;
