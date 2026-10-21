// Suivi des livraisons: alerts, treated alerts, delivered, cancelled parcels, swaps and claims (réclamations) to couriers / livreurs.
import type { Order, Page } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull, Where } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { getSetting } from '../settings';
import { addEvent, FollowInput, getOrder, listOrders, ListInput, setFollow } from './orders';
import { findOrders } from './sav';

const id = z.number().int().positive();

export const SUIVI_TABS = ['alertes', 'traites', 'livres', 'annules', 'swap', 'swapped'] as const;
export type SuiviTab = (typeof SUIVI_TABS)[number];
/** Where a parcel can be swapped from: it is still with the courier or the livreur. */
export const SWAP_FROM = ['returning', 'failed', 'alert', 'out_for_delivery', 'shipped'] as const;
export const CLAIM_STATUSES = ['waiting', 'still_waiting', 'resolved'] as const;
export const CLAIM_REASONS = ['relivrer', 'late', 'nocall', 'fakedeliv', 'fakeret', 'address', 'damaged', 'money', 'noreturn', 'other'] as const;
export const TREAT_WHAT = ['date', 'adresse', 'injoignable', 'autre'] as const;

const DAY = 86_400_000;

/** Filters of each Suivi tab, expressed with the orders list. */
function tabFilter(tab: SuiviTab, now: number): Partial<ListInput> {
  switch (tab) {
    case 'alertes':
      return { follow: ['alert'], sort: 'updated_at', dir: 'asc' };
    case 'traites':
      return { follow: ['out_for_delivery', 'shipped', 'failed'], subStatus: 'alert_traitee', sort: 'updated_at', dir: 'desc' };
    case 'livres':
      return { follow: ['delivered'], dateField: 'delivered_at', from: new Date(now - 30 * DAY).toISOString(), sort: 'delivered_at', dir: 'desc' };
    case 'annules':
      return { follow: ['returning'], sort: 'updated_at', dir: 'desc' };
    case 'swap':
      return { follow: ['returning'], sort: 'updated_at', dir: 'desc' };
    case 'swapped':
      return { follow: ['cancelled'], subStatus: 'annule_swappe', sort: 'updated_at', dir: 'desc' };
  }
}

export interface SuiviRowExtra {
  companyKind: string | null;
  livreurPhone: string | null;
  claim: { id: number; status: string; createdAt: string; sentAt: string | null } | null;
  /** why the parcel is in alert (note of its last "alert" event), shown next to the tracking */
  alertReason: string | null;
}

async function extras(db: Db, orders: Order[]): Promise<Record<number, SuiviRowExtra>> {
  if (!orders.length) return {};
  const ids = orders.map((o) => o.id);
  const rows = await db.query(
    `SELECT o.id, co.kind AS company_kind, lv.phone AS livreur_phone,
       (SELECT json_build_object('id', c.id, 'status', c.status, 'createdAt', c.created_at, 'sentAt', c.sent_at)
          FROM claims c WHERE c.order_id = o.id ORDER BY c.created_at DESC LIMIT 1) AS claim,
       (SELECT e.note FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS alert_reason
     FROM orders o LEFT JOIN delivery_companies co ON co.id = o.company_id LEFT JOIN profiles lv ON lv.id = o.livreur_id
     WHERE o.id = ANY($1)`,
    [ids],
  );
  const out: Record<number, SuiviRowExtra> = {};
  for (const r of rows) {
    const c = typeof r.claim === 'string' ? JSON.parse(r.claim) : r.claim;
    out[num(r.id)] = {
      companyKind: r.company_kind ?? null,
      livreurPhone: r.livreur_phone ?? null,
      claim: c ? { id: num(c.id), status: c.status, createdAt: iso(c.createdAt), sentAt: isoOrNull(c.sentAt) } : null,
      alertReason: r.alert_reason ?? null,
    };
  }
  return out;
}

export async function suiviCounts(ctx: Ctx) {
  const d30 = new Date(ctx.now() - 30 * DAY).toISOString();
  const r = (
    await ctx.db.query(
      `SELECT
         count(*) FILTER (WHERE follow_status = 'alert')::int AS alertes,
         count(*) FILTER (WHERE sub_status = 'alert_traitee' AND follow_status IN ('out_for_delivery','shipped','failed'))::int AS traites,
         count(*) FILTER (WHERE follow_status = 'delivered' AND delivered_at >= $1)::int AS livres,
         count(*) FILTER (WHERE follow_status = 'returning')::int AS returning,
         count(*) FILTER (WHERE follow_status = 'cancelled' AND sub_status = 'annule_swappe')::int AS swapped
       FROM orders WHERE follow_status IS NOT NULL`,
      [d30],
    )
  )[0];
  const claims = num((await ctx.db.query(`SELECT count(*)::int AS n FROM claims WHERE status <> 'resolved'`))[0]?.n);
  return {
    alertes: num(r.alertes),
    traites: num(r.traites),
    livres: num(r.livres),
    annules: num(r.returning) + num(r.swapped),
    swap: num(r.returning),
    swapped: num(r.swapped),
    claims,
  };
}

// ---------------------------------------------------------------- swap
async function swapCandidates(ctx: Ctx, fromId: number, q?: string) {
  const from = await getOrder(ctx, fromId);
  const variants = new Set(from.items.map((i) => i.variantId).filter(Boolean));
  const products = new Set(from.items.map((i) => i.productId));
  let rows: Order[];
  if (q?.trim()) {
    rows = await findOrders(ctx, q.trim(), 15, (w) => w.add(`o.conf_status = 'confirmed' AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared')) AND o.shipped_at IS NULL`));
  } else {
    // confirmed orders still at the depot that ask for one of the parcel's products
    const ids = await ctx.db.query(
      `SELECT DISTINCT o.id FROM orders o JOIN order_items i ON i.order_id = o.id
       WHERE o.conf_status = 'confirmed' AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared')) AND o.shipped_at IS NULL
         AND o.id <> $1 AND i.product_id = ANY($2) LIMIT 150`,
      [fromId, [...products]],
    );
    rows = [];
    for (const r of ids) rows.push(await getOrder(ctx, num(r.id)));
  }
  const list = rows
    .filter((x) => x.id !== fromId && !x.shippedAt)
    .map((x) => {
      const sameVariant = x.items.some((i) => i.variantId && variants.has(i.variantId));
      const sameProduct = x.items.some((i) => products.has(i.productId));
      return { ...x, sameWilaya: x.wilayaId === from.wilayaId, sameVariant, sameProduct };
    })
    .sort(
      (a, b) =>
        Number(b.sameWilaya) - Number(a.sameWilaya) ||
        Number(a.followStatus === 'prepared') - Number(b.followStatus === 'prepared') ||
        Number(b.sameVariant) - Number(a.sameVariant) ||
        String(a.confirmedAt).localeCompare(String(b.confirmedAt)),
    )
    .slice(0, 30);
  return { from, rows: list };
}

export async function swapParcel(ctx: Ctx, fromId: number, toId: number, note?: string | null) {
  if (fromId === toId) throw bad('Choisissez une autre commande');
  const me = ctx.session.profile.id;
  const res = await ctx.db.tx(async (tx) => {
    const A = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [fromId]))[0];
    const B = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [toId]))[0];
    if (!A || !B) throw notFound('Commande introuvable');
    if (!A.shipped_at || !(SWAP_FROM as readonly string[]).includes(A.follow_status ?? '')) throw bad(`${A.ref} : le colis n’est pas chez la société ou le livreur`);
    if (B.conf_status !== 'confirmed') throw bad(`${B.ref} : la commande n’est pas confirmée`);
    if (B.shipped_at || !(B.follow_status === null || ['to_prepare', 'prepared'].includes(B.follow_status))) throw bad(`${B.ref} : déjà expédiée`);
    const nowIso = new Date(ctx.now()).toISOString();
    // The parcel (and its stock, already out of the depot) goes to B: no new stock out for B, no return for A.
    await tx.query(
      `UPDATE orders SET company_id=$2, delivery_cost=$3, tracking=$4, ext_id=$5, label_url=$6, ext_status=NULL, ext_status_at=NULL,
         warehouse_id=COALESCE($7, warehouse_id), livreur_id=$8, follow_status='out_for_delivery', sub_status='livraison_swappe',
         prepared_at=COALESCE(prepared_at, $9::timestamptz), shipped_at=$9::timestamptz, updated_at=now(), version=version+1 WHERE id=$1`,
      [B.id, A.company_id, num(A.delivery_cost) || num(B.delivery_cost), A.tracking, A.ext_id, A.label_url, A.warehouse_id, A.livreur_id, nowIso],
    );
    await tx.query(
      `UPDATE orders SET follow_status='cancelled', sub_status='annule_swappe', tracking=NULL, ext_id=NULL, label_url=NULL, ext_status=NULL, ext_status_at=NULL,
         updated_at=now(), version=version+1 WHERE id=$1`,
      [A.id],
    );
    const n = note ? ` · ${note}` : '';
    await addEvent(tx, num(A.id), me, 'follow_status', A.follow_status, 'cancelled', `Colis swappé vers ${B.ref}${n}`, { swap_to: num(B.id), tracking: A.tracking });
    await addEvent(tx, num(A.id), me, 'sub_status', A.sub_status, 'annule_swappe', null);
    const was = B.follow_status === 'prepared' ? ' · était En dispatch (emballée) : colis à défaire' : ' · retirée de En préparation';
    await addEvent(tx, num(B.id), me, 'follow_status', B.follow_status, 'out_for_delivery', `Colis swappé depuis ${A.ref} (${A.tracking ?? '—'})${was}${n}`, { swap_from: num(A.id), tracking: A.tracking });
    await addEvent(tx, num(B.id), me, 'sub_status', B.sub_status, 'livraison_swappe', null);
    const kind = A.company_id ? (await tx.query('SELECT kind FROM delivery_companies WHERE id=$1', [A.company_id]))[0]?.kind ?? null : null;
    return {
      from: await getOrder(ctx, num(A.id), tx),
      to: await getOrder(ctx, num(B.id), tx),
      oldTracking: (A.tracking as string | null) ?? null,
      wasPrepared: B.follow_status === 'prepared',
      oldTotal: num(A.total),
      companyKind: kind as string | null,
    };
  });
  ctx.emit({ type: 'orders' });
  return res;
}

/** For a swapped parcel: the order that received it. */
async function swapTarget(ctx: Ctx, fromId: number) {
  const from = await getOrder(ctx, fromId);
  const ev = (
    await ctx.db.query(`SELECT data FROM order_events WHERE order_id = $1 AND kind = 'follow_status' AND data IS NOT NULL ORDER BY at DESC, id DESC LIMIT 20`, [fromId])
  ).find((e: any) => {
    const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    return d?.swap_to;
  });
  if (!ev) throw notFound(`${from.ref} : commande qui a reçu le colis introuvable`);
  const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
  const to = await getOrder(ctx, num(d.swap_to));
  const kind = to.companyId ? (await ctx.db.query('SELECT kind FROM delivery_companies WHERE id=$1', [to.companyId]))[0]?.kind ?? null : null;
  return { from, to, oldTracking: (d.tracking as string | null) ?? to.tracking, oldTotal: from.total, companyKind: kind as string | null };
}

// ---------------------------------------------------------------- claims
export interface Claim {
  id: number;
  ref: string;
  orderId: number | null;
  orderRef: string | null;
  tracking: string | null;
  customerName: string | null;
  phone: string | null;
  companyId: number | null;
  companyName: string | null;
  livreurId: number | null;
  livreurName: string | null;
  livreurPhone: string | null;
  reason: string;
  details: string;
  message: string;
  channel: string;
  status: (typeof CLAIM_STATUSES)[number];
  notes: { at: string; userId: number | null; userName?: string | null; text: string; status?: string | null }[];
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  resolvedAt: string | null;
}

const claimRef = (n: number) => `REC-${String(n).padStart(4, '0')}`;
const CLAIM_SELECT = `SELECT c.*, o.ref AS order_ref, o.tracking, o.customer_name, o.phone, co.name AS company_name, lv.name AS livreur_name, lv.phone AS livreur_phone, cb.name AS created_by_name
  FROM claims c LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN delivery_companies co ON co.id = c.company_id
  LEFT JOIN profiles lv ON lv.id = c.livreur_id LEFT JOIN profiles cb ON cb.id = c.created_by`;

function toClaim(r: any): Claim {
  const notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes ?? [];
  return {
    id: num(r.id),
    ref: claimRef(num(r.id)),
    orderId: numOrNull(r.order_id),
    orderRef: r.order_ref ?? null,
    tracking: r.tracking ?? null,
    customerName: r.customer_name ?? null,
    phone: r.phone ?? null,
    companyId: numOrNull(r.company_id),
    companyName: r.company_name ?? null,
    livreurId: numOrNull(r.livreur_id),
    livreurName: r.livreur_name ?? null,
    livreurPhone: r.livreur_phone ?? null,
    reason: r.reason,
    details: r.details ?? '',
    message: r.message,
    channel: r.channel,
    status: r.status,
    notes,
    createdBy: numOrNull(r.created_by),
    createdByName: r.created_by_name ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at ?? r.created_at),
    sentAt: isoOrNull(r.sent_at),
    resolvedAt: isoOrNull(r.resolved_at),
  };
}

async function getClaim(db: Db, cid: number) {
  const r = (await db.query(`${CLAIM_SELECT} WHERE c.id = $1`, [cid]))[0];
  if (!r) throw notFound('Réclamation introuvable');
  return toClaim(r);
}

const ClaimsInput = z.object({
  target: z.enum(['company', 'livreur', 'all']).default('all'),
  status: z.enum([...CLAIM_STATUSES, 'open', 'all']).default('all'),
  orderId: id.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(100),
});

async function listClaims(ctx: Ctx, f: z.infer<typeof ClaimsInput>): Promise<Page<Claim> & { counts: Record<string, number> }> {
  const w = new Where();
  if (f.target === 'company') w.add('c.livreur_id IS NULL');
  if (f.target === 'livreur') w.add('c.livreur_id IS NOT NULL');
  if (f.orderId) w.add('c.order_id = ?', f.orderId);
  const base = w.sql;
  const cnt = await ctx.db.query(`SELECT c.status AS k, count(*)::int AS n FROM claims c ${base} GROUP BY 1`, w.params);
  const counts: Record<string, number> = { waiting: 0, still_waiting: 0, resolved: 0 };
  for (const r of cnt) counts[r.k] = num(r.n);
  counts.open = counts.waiting + counts.still_waiting;
  counts.all = counts.open + counts.resolved;
  if (f.status === 'open') w.add(`c.status <> 'resolved'`);
  else if (f.status !== 'all') w.add('c.status = ?', f.status);
  const total = num((await ctx.db.query(`SELECT count(*)::int AS n FROM claims c ${w.sql}`, w.params))[0]?.n);
  const lim = w.p(f.pageSize);
  const off = w.p((f.page - 1) * f.pageSize);
  const rows = await ctx.db.query(`${CLAIM_SELECT} ${w.sql} ORDER BY c.created_at DESC, c.id DESC LIMIT ${lim} OFFSET ${off}`, w.params);
  return { rows: rows.map(toClaim), total, page: f.page, pageSize: f.pageSize, counts };
}

const ClaimCreate = z.object({
  orderId: id,
  reason: z.enum(CLAIM_REASONS),
  details: z.string().max(1000).default(''),
  message: z.string().min(1).max(4000),
  channel: z.enum(['whatsapp', 'email', 'copy', 'phone']).default('whatsapp'),
  /** to our own livreur instead of the company */
  toLivreur: z.boolean().default(false),
});

const ClaimUpdate = z.object({
  id,
  status: z.enum(CLAIM_STATUSES).optional(),
  note: z.string().max(1000).optional(),
  /** the message was just sent through this channel */
  sentVia: z.enum(['whatsapp', 'email', 'copy', 'phone']).optional(),
  message: z.string().min(1).max(4000).optional(),
});

const CLAIM_STATUS_FR: Record<string, string> = { waiting: 'En attente', still_waiting: 'Toujours en attente', resolved: 'Réglée' };
const VIA_FR: Record<string, string> = { whatsapp: 'WhatsApp', email: 'e-mail', copy: 'copié', phone: 'téléphone' };

// ---------------------------------------------------------------- procedures
const ListSuivi = z.object({
  tab: z.enum(SUIVI_TABS),
  q: z.string().max(100).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(300),
});

export const suiviProcs = {
  'suivi.counts': proc(['suivi'], z.object({}), (ctx) => suiviCounts(ctx)),

  'suivi.list': proc(['suivi'], ListSuivi, async (ctx, i) => {
    const page = await listOrders(ctx, ListInput.parse({ ...tabFilter(i.tab, ctx.now()), q: i.q, page: i.page, pageSize: i.pageSize }));
    // the swap list only shows parcels that really left (still with the courier or the livreur)
    const rows = i.tab === 'swap' ? page.rows.filter((o) => o.shippedAt) : page.rows;
    return { ...page, rows, extra: await extras(ctx.db, rows) };
  }),

  /** "Traiter" an alert: what was done, new date, note → back on the road with sub-status alert_traitee. */
  'suivi.treat': proc(['suivi'], z.object({ id, what: z.enum(TREAT_WHAT), date: z.string().max(20).nullable().optional(), note: z.string().max(1000).nullable().optional() }), async (ctx, i) => {
    const cur = await getOrder(ctx, i.id);
    if (cur.followStatus !== 'alert') throw bad(`${cur.ref} n’est pas en alerte`);
    const WHAT: Record<string, string> = { date: 'Client joint : nouvelle date de livraison', adresse: 'Adresse ou téléphone corrigé', injoignable: 'Client injoignable : nouvel essai', autre: 'Autre' };
    const day = i.date ? `le ${i.date.slice(0, 10).split('-').reverse().join('/')}` : '';
    const text = [WHAT[i.what], day, i.note?.trim()].filter(Boolean).join(' · ');
    await setFollow(ctx, FollowInput.parse({ ids: [i.id], status: 'out_for_delivery', subStatus: 'alert_traitee', note: `Alerte traitée — ${text}` }));
    await addEvent(ctx.db, i.id, ctx.session.profile.id, 'sub_status', cur.subStatus ?? null, 'alert_traitee', text);
    ctx.emit({ type: 'order', id: i.id });
    return getOrder(ctx, i.id);
  }),

  /** Client annule / Livré / Nouvelle alerte from the Suivi lists. */
  'suivi.act': proc(['suivi'], z.object({ id, action: z.enum(['cancel', 'delivered', 'realert']), note: z.string().max(1000).nullable().optional() }), async (ctx, i) => {
    const map = {
      cancel: { status: 'returning', note: 'Annulé par le client (suivi)' },
      delivered: { status: 'delivered', note: 'Livré après alerte traitée' },
      realert: { status: 'alert', note: 'Nouvelle alerte' },
    } as const;
    const m = map[i.action];
    await setFollow(ctx, FollowInput.parse({ ids: [i.id], status: m.status, note: [m.note, i.note].filter(Boolean).join(' — ') }));
    return getOrder(ctx, i.id);
  }),

  'suivi.swapCandidates': proc(['suivi'], z.object({ fromId: id, q: z.string().max(100).optional() }), (ctx, i) => swapCandidates(ctx, i.fromId, i.q)),
  'suivi.swap': proc(['suivi'], z.object({ fromId: id, toId: id, note: z.string().max(500).nullable().optional() }), (ctx, i) => swapParcel(ctx, i.fromId, i.toId, i.note)),
  'suivi.swapTarget': proc(['suivi'], z.object({ id }), (ctx, i) => swapTarget(ctx, i.id)),

  /** Couriers and livreurs that can receive a claim, with their claim contacts. */
  'suivi.contacts': proc(['suivi', 'confirmation', 'depot'], z.object({}), async (ctx) => {
    const shop = await getSetting(ctx.db, 'shop');
    const comps = await ctx.db.query(`SELECT id, name, kind, active, config FROM delivery_companies WHERE active ORDER BY name`);
    const livreurs = await ctx.db.query(`SELECT id, name, phone, livreur_company_id FROM profiles WHERE active AND 'livreur' = ANY(roles) ORDER BY name`);
    return {
      shopName: shop.name,
      companies: comps.map((c: any) => {
        const cfg = (typeof c.config === 'string' ? JSON.parse(c.config) : c.config) ?? {};
        const k = cfg.claim ?? {};
        return { id: num(c.id), name: c.name as string, kind: c.kind as string, wa: (k.wa as string) || null, email: (k.email as string) || null, phone: (k.phone as string) || null, portal: (k.portal as string) || null };
      }),
      livreurs: livreurs.map((l: any) => ({ id: num(l.id), name: l.name as string, phone: (l.phone as string) ?? null, companyId: numOrNull(l.livreur_company_id) })),
    };
  }),

  /** Orders that can get a claim: sent to a courier or given to a livreur. */
  'suivi.findOrders': proc(['suivi', 'confirmation', 'depot'], z.object({ q: z.string().min(2).max(100) }), (ctx, { q }) =>
    findOrders(ctx, q, 8, (w) => w.add('(o.company_id IS NOT NULL AND (o.tracking IS NOT NULL OR o.livreur_id IS NOT NULL))')),
  ),

  'suivi.claims': proc(['suivi', 'confirmation', 'depot'], ClaimsInput, (ctx, f) => listClaims(ctx, f)),

  'suivi.claimCreate': proc(['suivi', 'confirmation', 'depot'], ClaimCreate, async (ctx, i) => {
    const o = await getOrder(ctx, i.orderId);
    const me = ctx.session.profile.id;
    let companyId: number | null = null;
    let livreurId: number | null = null;
    if (i.toLivreur) {
      if (!o.livreurId) throw bad(`${o.ref} n’a pas de livreur`);
      livreurId = o.livreurId;
      companyId = o.companyId;
    } else {
      if (!o.companyId) throw bad(`${o.ref} n’est pas chez une société de livraison`);
      const kind = (await ctx.db.query('SELECT kind FROM delivery_companies WHERE id=$1', [o.companyId]))[0]?.kind;
      if (kind === 'own') {
        if (!o.livreurId) throw bad(`${o.ref} est chez nos livreurs : écrivez au livreur`);
        livreurId = o.livreurId;
      }
      companyId = o.companyId;
    }
    const nowIso = new Date(ctx.now()).toISOString();
    const cid = await ctx.db.tx(async (tx) => {
      const r = (
        await tx.query(
          `INSERT INTO claims (order_id, company_id, livreur_id, reason, details, message, channel, status, created_by, notes, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'waiting',$8,$9,$10,$10) RETURNING id`,
          [o.id, companyId, livreurId, i.reason, i.details, i.message, i.channel, me, JSON.stringify([{ at: nowIso, userId: me, text: 'Réclamation préparée', status: 'waiting' }]), nowIso],
        )
      )[0];
      const n = num(r.id);
      await addEvent(tx, o.id, me, 'note', null, 'event', `Réclamation ${claimRef(n)} : ${i.details || i.reason}`.slice(0, 300));
      return n;
    });
    ctx.emit({ type: 'order', id: o.id });
    return getClaim(ctx.db, cid);
  }),

  'suivi.claimUpdate': proc(['suivi', 'confirmation', 'depot'], ClaimUpdate, async (ctx, i) => {
    const cur = await getClaim(ctx.db, i.id);
    const me = ctx.session.profile.id;
    const nowIso = new Date(ctx.now()).toISOString();
    const parts: string[] = [];
    if (i.sentVia) parts.push(`${cur.sentAt ? 'Relance' : 'Envoyée'} (${VIA_FR[i.sentVia]})`);
    if (i.status && i.status !== cur.status) parts.push(CLAIM_STATUS_FR[i.status]);
    if (i.note?.trim()) parts.push(i.note.trim());
    if (!parts.length && !i.message) return cur;
    const notes = parts.length ? [...cur.notes, { at: nowIso, userId: me, text: parts.join(' · '), status: i.status ?? null }] : cur.notes;
    const status = i.status ?? cur.status;
    await ctx.db.query(
      `UPDATE claims SET status=$2, notes=$3, message=COALESCE($4, message), channel=COALESCE($5, channel),
         sent_at = CASE WHEN $6 THEN $7::timestamptz ELSE sent_at END,
         resolved_at = CASE WHEN $2 = 'resolved' THEN COALESCE(resolved_at, $7::timestamptz) ELSE NULL END,
         updated_at=$7::timestamptz WHERE id=$1`,
      [i.id, status, JSON.stringify(notes), i.message ?? null, i.sentVia ?? null, !!i.sentVia, nowIso],
    );
    if (cur.orderId && parts.length) await addEvent(ctx.db, cur.orderId, me, 'note', null, 'event', `Réclamation ${cur.ref} : ${parts.join(' · ')}`.slice(0, 300));
    ctx.emit({ type: 'order', id: cur.orderId ?? undefined });
    return getClaim(ctx.db, i.id);
  }),
};

