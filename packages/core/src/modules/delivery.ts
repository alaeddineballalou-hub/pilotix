// Delivery companies (couriers with or without API), their tariffs and stop desks, sending parcels, status sync,
// own livreurs and their round ("Ma tournée"). Courier APIs run on the server only (ctx.server.courier → couriers/index.ts);
// in the browser preview every courier answer is simulated.
import { COURIER_KINDS, CourierKind, FOLLOW_ON_ROAD, FollowStatus, Order, Session, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { ADAPTERS } from '../couriers/adapters';
import { DEFAULT_TEMPLATE, PLACEHOLDERS, checkTemplate, custom } from '../couriers/custom';
import { fakeTracking, nextStep, word } from '../couriers/demo';
import { CARDS, KINDS } from '../couriers/kinds';
import { keysOk, loadCompany, loadParcels, resolveStatus } from '../couriers/load';
import { checkedInToday } from './livreur';
import type { Desk, ExchangeResult, FeeRow, LabelResult, PreviewResult, SendResult, TrackItem, TrackResult } from '../couriers/types';
import { Db, iso, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc, publicApi, takeActionLocks } from '../rpc';

/** Compares two secrets in a time that does not depend on where they differ (no guessing a key letter by letter). */
function sameSecret(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let k = 0; k < Math.max(a.length, b.length); k++) d |= (a.charCodeAt(k) || 0) ^ (b.charCodeAt(k) || 0);
  return d === 0;
}
import { getSetting } from '../settings';
import { removedCouriers } from '../platform/courierWatch';
import { addEvent, getOrder, listOrders, setFollow } from './orders';

const id = z.number().int().positive();
const ids = z.array(id).min(1).max(500);

/** Statuses where a parcel is waiting to leave with this company. */
export const TO_SHIP: FollowStatus[] = ['to_prepare', 'prepared'];
/** Statuses the courier sync follows (parcels with a tracking number, not final). */
const SYNCABLE: FollowStatus[] = ['prepared', ...FOLLOW_ON_ROAD];
/** Statuses set by hand by the suivi that the courier's ordinary on-the-road statuses must not overwrite. */
const MANUAL_HOLD: FollowStatus[] = ['alert', 'in_exchange'];
/** Courier statuses that still move a parcel held by the suivi. */
const SYNC_ENDS: FollowStatus[] = ['delivered', 'returning', 'returned', 'exchanged', 'lost'];

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

async function saveFeeRows(db: Db, companyId: number, rows: FeeRow[]) {
  await db.tx(async (tx) => {
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
       o.is_exchange, o.original_order_id, oo.company_id AS orig_company, oo.tracking AS orig_tracking, oo.ext_id AS orig_ext
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
      sent = plain.map((r) =>
        keysOk(kind, cred) ? { id: num(r.id), ok: true as const, tracking: fakeTracking(kind, r.ref), extId: null, labelUrl: null } : { id: num(r.id), ok: false as const, error: `Clés API manquantes pour ${list[0].company_name}` },
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
      const cost = f ? num(r.is_stopdesk ? f.desk : f.home) : null;
      const status = word(kind, 'prepared');
      await ctx.db.query(
        `UPDATE orders SET company_id=$2, tracking=$3, ext_id=$4, label_url=$5, ext_status=$6, ext_status_at=now(),
           delivery_cost = COALESCE($7, delivery_cost), send_error = NULL, send_error_at = NULL, updated_at=now(), version=version+1 WHERE id=$1`,
        [s.id, companyId, s.tracking, s.extId, s.labelUrl, status, cost],
      );
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
  await ctx.db.query('UPDATE orders SET tracking=NULL, ext_id=NULL, label_url=NULL, ext_status=NULL, ext_status_at=NULL, updated_at=now(), version=version+1 WHERE id=$1', [orderId]);
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

// ---------------------------------------------------------------- status sync
async function syncCompany(ctx: Ctx, c: CompanyRow, onlyIds?: number[]) {
  const parcels = await ctx.db.query(
    `SELECT id, ref, tracking, ext_id, follow_status, sub_status, ext_status FROM orders
     WHERE company_id = $1 AND tracking IS NOT NULL AND follow_status = ANY($2) ${onlyIds ? 'AND id = ANY($3)' : ''} ORDER BY ext_status_at NULLS FIRST LIMIT 2000`,
    onlyIds ? [c.id, SYNCABLE, onlyIds] : [c.id, SYNCABLE],
  );
  if (!parcels.length) return { company: c.name, checked: 0, changed: 0 };
  let answers: TrackResult[];
  if (isDemo(ctx)) {
    answers = [];
    for (const p of parcels) {
      const next = nextStep(p.follow_status, !!p.tracking);
      if (next) answers.push({ id: num(p.id), status: word(c.kind, next), mapped: next, at: new Date(ctx.now()).toISOString() });
    }
  } else {
    const items: TrackItem[] = parcels.map((p: any) => ({ id: num(p.id), tracking: p.tracking, extId: p.ext_id }));
    answers = (await courierOf(ctx)('track', { companyId: c.id, items }, ctx)) as TrackResult[];
  }
  const defaults = ADAPTERS[c.kind]?.statuses ?? {};
  const byStatus = new Map<FollowStatus, number[]>();
  let changed = 0;
  const errors: { ref: string; error: string }[] = [];
  for (const a of answers) {
    const p = parcels.find((x: any) => num(x.id) === a.id);
    if (!p) continue;
    if (a.error) {
      errors.push({ ref: p.ref, error: a.error });
      continue;
    }
    const to = resolveStatus(defaults, c.statusMap, a);
    if (a.status !== p.ext_status) {
      await ctx.db.query('UPDATE orders SET ext_status=$2, ext_status_at=COALESCE($3::timestamptz, now()), updated_at=now() WHERE id=$1', [a.id, a.status.slice(0, 200), safeDate(a.at)]);
      changed++;
    }
    // Suivi's own work (an alert raised or handled, an exchange in progress) is not undone by the courier's
    // « en livraison » / « vers wilaya »: only an end (livré, retour, perdu…) moves such a parcel.
    if (MANUAL_HOLD.includes(p.follow_status) && to && !SYNC_ENDS.includes(to)) continue;
    // a treated alert is not put back to « en route » by the courier, but a new failed attempt or alert still comes in
    if (p.sub_status === 'alert_traitee' && (to === 'shipped' || to === 'out_for_delivery')) continue;
    if (to && to !== p.follow_status) byStatus.set(to, [...(byStatus.get(to) ?? []), a.id]);
  }
  const sys = asCourier(ctx);
  for (const [status, list] of byStatus) {
    changed += (await setFollow(sys, { ids: list, status, note: `Statut ${c.name}` }, { system: true })).changed.length;
  }
  return { company: c.name, checked: parcels.length, changed, failed: errors.length, errors: errors.slice(0, 20) };
}
const safeDate = (s: string | null | undefined) => {
  if (!s) return null;
  const t = Date.parse(s);
  return isFinite(t) ? new Date(t).toISOString() : null;
};

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
    auto: resolveStatus(defaults, {}, { status: label.get(s) ?? s, key: s }) ?? null,
  }));
}

/** What our statuses a courier status means once the seller's choices are applied. */
const effective = (r: { own?: string; auto: string | null }) => (r.own !== undefined ? r.own : r.auto);
/** Our statuses while the parcel is with the company: the courier statuses meaning one of them can be an alert. */
const ON_ROAD = ['shipped', 'out_for_delivery', 'failed', 'returning', 'in_exchange'];

export const deliveryProcs = {
  /** Courier kinds, provider cards and custom-API placeholders (for the forms). */
  // a company removed from Pilotix (control room) is no longer offered; a shop's own companies keep their kind
  'delivery.kinds': proc([], z.object({}), async (ctx) => {
    const removed = ctx.t ? await removedCouriers(ctx.t).catch(() => ({}) as Record<string, unknown>) : {};
    return { kinds: Object.values(KINDS), cards: CARDS.filter((c) => !c.company || !(c.company in removed)), placeholders: PLACEHOLDERS, defaultTemplate: DEFAULT_TEMPLATE };
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
          cid, i.name, i.kind, i.active, i.phone ?? null, JSON.stringify({ ...cred, ...newKeys }),
          // the courier's webhook (set from « ZR depuis Pilotix ») stays when the form does not send it back
          JSON.stringify({ ...cfg, settings: cur.kind === i.kind && cfg.settings?.webhook_id && settings.webhook_id === undefined ? { ...settings, webhook_id: cfg.settings.webhook_id } : settings }),
        ]);
      } else {
        const r = await tx.query('INSERT INTO delivery_companies (name, kind, active, phone, credentials, config) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
          i.name, i.kind, i.active, i.phone ?? null, JSON.stringify(newKeys), JSON.stringify({ settings, statusMap: {} }),
        ]);
        cid = num(r[0].id);
      }
    });
    ctx.emit({ type: 'settings' });
    return companyOr404(ctx.db, cid!);
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

  'delivery.saveFees': proc([], z.object({ companyId: id, rows: z.array(FeeInput).max(69) }), async (ctx, i) => {
    await companyOr404(ctx.db, i.companyId);
    await saveFeeRows(ctx.db, i.companyId, i.rows);
    return feesOf(ctx.db, i.companyId);
  }),

  /** Imports the tariffs from the courier's API (demo: a realistic grid). */
  'delivery.importFees': proc([], z.object({ companyId: id }), async (ctx, { companyId }) => {
    const c = await companyOr404(ctx.db, companyId);
    if (!KINDS[c.kind].fees) throw bad(`${c.name} : import des tarifs non disponible, remplissez-les à la main`);
    let rows: FeeRow[];
    if (isDemo(ctx)) {
      const f = c.kind === 'zr' ? 0.95 : c.kind === 'noest' ? 0.9 : 1;
      rows = WILAYAS.map((_, k) => {
        const d = DEFAULT_FEES(k + 1);
        return { wilayaId: k + 1, home: Math.round((d.home * f) / 50) * 50, desk: Math.round((d.desk * f) / 50) * 50, returnFee: d.returnFee };
      });
    } else rows = (await courierOf(ctx)('fees', { companyId }, ctx)) as FeeRow[];
    await saveFeeRows(ctx.db, companyId, rows);
    return { imported: rows.length, rows: await feesOf(ctx.db, companyId) };
  }),

  'delivery.stopdesks': proc(null, z.object({ companyId: id, wilayaId: z.number().int().min(1).max(69).optional() }), async (ctx, i) => {
    const rows = await ctx.db.query(
      `SELECT * FROM stopdesks WHERE company_id=$1 ${i.wilayaId ? 'AND wilaya_id=$2' : ''} ORDER BY wilaya_id, commune, name`,
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
    await ctx.db.tx(async (tx) => {
      for (const d of desks) {
        if (!d.wilayaId) continue;
        const cur = (await tx.query('SELECT id FROM stopdesks WHERE company_id=$1 AND ext_id=$2', [companyId, d.extId]))[0];
        if (cur) await tx.query('UPDATE stopdesks SET wilaya_id=$2, commune=$3, name=$4, address=$5 WHERE id=$1', [cur.id, d.wilayaId, d.commune ?? '', d.name, d.address ?? '']);
        else await tx.query('INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address, ext_id) VALUES ($1,$2,$3,$4,$5,$6)', [companyId, d.wilayaId, d.commune ?? '', d.name, d.address ?? '', d.extId]);
      }
    });
    return { imported: desks.length };
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
          { key: 'swapSameCity', label: 'Échange (même wilaya)', price: 200 },
          { key: 'swapOtherCity', label: 'Échange (autre wilaya)', price: 350 },
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
      [c.id, key, extId],
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
  'delivery.sync': proc(['suivi', 'depot'], z.object({ companyId: id.optional(), fast: z.boolean().optional() }), async (ctx, i) => {
    // fast (every 5 minutes): the companies that tell Pilotix themselves (webhook on) are left to their webhook and
    // checked only in the full sync (every 30 minutes), in case a call was lost
    const list = (await companies(ctx.db)).filter(
      (c) => c.active && KINDS[c.kind]?.api && c.hasKeys && (!i.companyId || c.id === i.companyId) && !(i.fast && String((c.settings as any).webhook_id ?? '')),
    );
    const out: { company: string; checked: number; changed: number; failed?: number; errors?: { ref: string; error: string }[]; error?: string }[] = [];
    for (const c of list) {
      try {
        out.push(await syncCompany(ctx, c));
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
    // the companies' payments (ZR): demande de paiement when money is ready, payments imported into the caisse
    const payments = i.companyId || !ctx.session.isAdmin ? [] : await step('Paiements des sociétés', () => import('./courierpay').then((m) => m.payRunAll(ctx)), [] as any[]);
    return {
      companies: out,
      checked: out.reduce((s, x) => s + x.checked, 0),
      changed: out.reduce((s, x) => s + x.changed, 0),
      failed: out.reduce((s, x) => s + (x.failed ?? 0), 0),
      payments,
      steps,
    };
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
    if (i.companyId && !isLivreurOnly(ctx.session)) {
      const c = await companyOr404(ctx.db, i.companyId);
      const rows = (await listOrders(ctx, { companyId: c.id, follow: ['prepared', 'shipped', 'out_for_delivery', 'failed', 'alert'], pageSize: 1000, page: 1, sort: 'wilaya_id', dir: 'asc', dateField: 'created_at', tickets: 'include' })).rows;
      const own = c.kind === 'own';
      const list = own ? rows : rows.filter((o) => o.tracking || o.followStatus === 'prepared');
      return { shop: shop.name, title: `Feuille de route · ${c.name}`, who: c.name, phone: c.phone, date: new Date(ctx.now()).toISOString(), orders: list, total: list.reduce((s, o) => s + o.total, 0) };
    }
    const t = await tournee(ctx, livreurTarget(ctx, i.livreurId));
    const phone = (await ctx.db.query('SELECT phone FROM profiles WHERE id=$1', [t.livreur.id]))[0]?.phone ?? null;
    const orders = [...t.toDeliver, ...t.pickup];
    return { shop: shop.name, title: `Feuille de route · ${t.livreur.name}`, who: t.livreur.name, phone, date: new Date(ctx.now()).toISOString(), orders, total: orders.reduce((s, o) => s + o.total, 0) };
  }),
};

/** Is this session limited to its own deliveries (livreur only)? */
export const livreurOnly = isLivreurOnly;
