// ZR Express — new platform (api.zrexpress.app).
// Auth: headers X-Api-Key + X-Tenant (ZR space → Paramètres → API).
// Ported from the original Pilotix adapter, which was used in production with real keys.
// Endpoints: POST /api/v1/territories/search, /hubs/search, /customers/individual, /parcels, GET /parcels/{id},
// DELETE /parcels/bulk/by-tracking-number, POST /parcels/labels/individual/pdf, GET /delivery-pricing/rates,
// Réclamations (from ZR's API documentation): POST /claim-categories/search → {items:[{id,name}]},
// POST /claims {categoryId, title, description, parcelId (ZR parcel UUID)} → {id}, POST /claims/{id} {claimId} → claim with
// state {name, description, isLocked}, PATCH /claim-comments/{id} {claimId, comment}, POST /claim-comments/{id}/search → {items:[{content, createdAt}]}.
// Also (ZR's API reference): POST /parcels/labels/multiple/pdf (one PDF for many parcels), /parcels/exchange, pickup bags
// (POST /pickup-bags, PATCH /pickup-bags/{id}/add-parcel | remove-parcel, POST /pickup-bags/search, /pickup-bags/labels/pdf),
// GET /parcels/{id}/state-history and /sms-history, modification requests (POST /parcel-modification-requests, …/phone,
// GET …/{id}), POST /workflows/search (ZR's statuses), GET /delivery-pricing/service-pricing, webhooks (/webhooks/endpoints).
// BEST GUESS (check with real keys): the "state.name" values in STATUSES below come from ZR's dashboard wording;
// unknown ones are shown as-is and can be mapped by hand with the "Statuts" button.
import { cacheKeyOf } from './types';
import type { BagAdded, BagInfo, ChangeInput, ChangeState, ClaimCategory, ClaimFound, ClaimMessage, ClaimState, CourierAdapter, CourierBags, CourierCompany, CourierStep, CourierSwapSeen, Desk, FeeRow, Helpers, Parcel, ParcelInfo, SwapInput, SwapSent, TrackItem } from './types';
import { ASK_AGAIN_MS, baseUrl, bestMatch, CourierError, cut, http, intl, LIST_KEPT_MS, listClock, needKeys, sleep, timeUp } from './util';

const STATUSES: CourierAdapter['statuses'] = {
  commande_recue: null, en_traitement: null, appel_confirmation: null, commande_confirmee: null, en_preparation: null, pret_a_expedier: null,
  confirme_au_bureau: 'shipped', confirme_chez_partenaire: 'shipped', dispatch: 'shipped', vers_wilaya: 'shipped',
  en_livraison: 'out_for_delivery', sortie_en_livraison: 'out_for_delivery', disponible_bureau: 'out_for_delivery', en_attente_client: 'out_for_delivery',
  echec_livraison: 'failed', livre: 'delivered', encaisse: 'delivered', recouvert: 'delivered',
  retourne: 'returning', retour_confirme: 'returning', retour_sous_traitant: 'returning', colis_recupere: 'returning', attente_recuperation_fournisseur: 'returning',
  recupere_par_fournisseur: 'returned', reinjecte_dans_stock: 'returned', remboursement_reinjecte: 'returned', annule: null,
};

const h = (c: CourierCompany) => ({ 'X-Api-Key': String(c.secret.api_key ?? '').trim(), 'X-Tenant': String(c.secret.tenant ?? '').trim() });
const url = (c: CourierCompany, path: string) => baseUrl(c, 'https://api.zrexpress.app', '/api/v1') + path;
/** ZR's label format: a6 (one 10 × 15 cm label per page) or a4 (four per page) */
const labelFormat = (c: CourierCompany) => (/^a4$/i.test(String(c.settings.label_format ?? '').trim()) ? 'a4' : 'a6');

const cache = new Map<string, any[]>();
const kept = new Map<string, { at: number; list: any[] }>();
/** ZR's wilayas or communes, kept an hour; `fresh`: read again at once (a commune not on the list: ZR may have just added
 *  it), at most once a minute. */
async function territories(c: CourierCompany, level: 'wilaya' | 'commune', fresh = false) {
  const key = `${cacheKeyOf(c)}:${level}`;
  const had = kept.get(key);
  if (had && listClock.now() - had.at < (fresh ? ASK_AGAIN_MS : LIST_KEPT_MS)) return had.list;
  const out: any[] = [];
  let filtered = true;
  const page = (n: number, f: boolean) =>
    http(c.name, url(c, '/territories/search'), {
      method: 'POST',
      headers: h(c),
      json: { keyword: '', pageNumber: n, pageSize: 1000, ...(f ? { advancedFilter: { logic: 'and', filters: [{ field: 'level', operator: 'eq', value: level }] } } : {}) },
    });
  for (let n = 1; n < 10; n++) {
    let r: any;
    try {
      r = await page(n, filtered);
    } catch (e) {
      if (filtered && n === 1) {
        filtered = false;
        r = await page(n, false);
      } else throw e;
    }
    out.push(...(r.items ?? []));
    if (!r.hasNext) break;
  }
  const list = out.filter((t) => t.level === level);
  kept.set(key, { at: listClock.now(), list });
  return list;
}
/** ZR's hubs (its bureaus), kept an hour: a bureau ZR opens or closes is seen by the next import (every hour) */
async function hubs(c: CourierCompany) {
  const key = `${cacheKeyOf(c)}:hubs`;
  const had = kept.get(key);
  if (had && listClock.now() - had.at < LIST_KEPT_MS) return { list: had.list, complete: true };
  const out: any[] = [];
  const seen = new Set<string>();
  for (let n = 1; n < 10; n++) {
    const r = await http(c.name, url(c, '/hubs/search'), { method: 'POST', headers: h(c), json: { pageNumber: n, pageSize: 200 } });
    if (!Array.isArray(r?.items)) break;
    let valid = true;
    for (const item of r.items) {
      if (!item?.id || seen.has(String(item.id))) {
        valid = false;
        continue;
      }
      seen.add(String(item.id));
      out.push(item);
    }
    if (!valid || (!r.items.length && (r.hasNext || n > 1))) break;
    if (r.hasNext === false) {
      kept.set(key, { at: listClock.now(), list: out });
      return { list: out, complete: true };
    }
    if (r.hasNext !== true) break;
  }
  return { list: out, complete: false };
}

/** One of a price line's prices (home, pickup-point, return): ZR's price with VAT, else the discounted or plain one. */
function rateOf(rate: any, type: string): number | null {
  const x = (rate?.deliveryPrices ?? []).find((d: any) => d?.deliveryType === type);
  return x ? Number(x.priceTtc ?? x.discountedPrice ?? x.price) || null : null;
}
/** The price most lines have (a tie: the higher one). */
function mostCommon(prices: (number | null)[]): number | null {
  const n = new Map<number, number>();
  for (const p of prices) if (p && p > 0) n.set(p, (n.get(p) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;
}
/** A wilaya's prices from its price lines: its own line, or its communes' lines (the price most of them have). */
const feeOf = (wilayaId: number, rates: any[]): FeeRow => ({
  wilayaId,
  home: mostCommon(rates.map((x) => rateOf(x, 'home'))),
  desk: mostCommon(rates.map((x) => rateOf(x, 'pickup-point'))),
  returnFee: mostCommon(rates.map((x) => rateOf(x, 'return'))),
});

/**
 * ZR's « tarifs locaux »: the shop's own wilaya (Alger: its 57 communes) has one price line per commune, no line of
 * its own — so it stayed empty and Pilotix said « ZR ne livre pas à Alger ». Each commune line goes to its wilaya
 * (ZR's communes say which), and the wilaya takes the price most of its communes have (today they all have the same).
 * The shop's own wilaya still without a price is asked to ZR directly: the wilaya, else its communes one by one.
 */
async function communeFees(c: CourierCompany, rows: Map<number, FeeRow>, local: any[]) {
  const priced = (w: number) => {
    const x = rows.get(w);
    return !!x && (x.home !== null || x.desk !== null);
  };
  const home = Number(c.shop?.fromWilayaId) || null;
  if (!local.length && (!home || priced(home))) return;
  const [ws, cs] = await Promise.all([territories(c, 'wilaya'), territories(c, 'commune')]);
  const code = new Map<string, number>(ws.map((w: any) => [String(w.id), Number(w.code)]));
  const wilayaOf = new Map<string, number>();
  for (const x of cs) {
    const w = code.get(String(x.parentId));
    if (!(w && w >= 1 && w <= 69)) continue;
    wilayaOf.set(`id:${x.id}`, w);
    if (x.code != null && x.code !== '') wilayaOf.set(`code:${x.code}`, w);
  }
  // the wilaya's own prices first: its communes only fill what it lacks
  const fill = (w: number, from: FeeRow) => {
    const x = rows.get(w);
    rows.set(w, { wilayaId: w, home: x?.home ?? from.home, desk: x?.desk ?? from.desk, returnFee: x?.returnFee ?? from.returnFee });
  };
  const per = new Map<number, any[]>();
  for (const rate of local) {
    const w = wilayaOf.get(`id:${rate.toTerritoryId}`) ?? wilayaOf.get(`code:${rate.toTerritoryCode}`);
    if (w) per.set(w, [...(per.get(w) ?? []), rate]);
  }
  for (const [w, list] of per) fill(w, feeOf(w, list));
  if (!home || priced(home)) return;
  const one = (id: unknown) => http(c.name, url(c, `/delivery-pricing/rates/${encodeURIComponent(String(id))}`), { headers: h(c) }).catch(() => null);
  const t = ws.find((w: any) => Number(w.code) === home);
  if (!t) return;
  fill(home, feeOf(home, [await one(t.id)]));
  if (priced(home)) return;
  const answers: any[] = [];
  for (const x of cs.filter((x: any) => String(x.parentId) === String(t.id))) {
    if (timeUp()) break;
    answers.push(await one(x.id));
  }
  fill(home, feeOf(home, answers));
}

/** Words of our reasons that find ZR's category when the user did not choose one. ZR's own 12 (read in its app,
 *  25 Nov 2026): Accélération de la commande, Accélération d'encaissement, Annulation de la commande, Autre, Colis
 *  endommagé, Colis perdu, Demande de retour, Demande d'information, Mise à jour des situations, Relancer un colis,
 *  Reporter un colis, Retard de livraison. Without accents, in order of preference. */
const REASON_HINTS: Record<string, string[]> = {
  relivrer: ['relancer un colis', 'reporter un colis', 'relivraison'],
  late: ['retard de livraison', 'acceleration de la commande', 'retard'],
  nocall: ['relancer un colis', 'appel'],
  fakedeliv: ['mise a jour des situations', 'situation', 'statut'],
  fakeret: ['mise a jour des situations', 'situation', 'statut'],
  address: ['adresse', 'modification'],
  damaged: ['colis endommage', 'endommage'],
  money: ["acceleration d'encaissement", 'encaissement', 'paiement'],
  noreturn: ['demande de retour', 'retour'],
  other: ['autre'],
};

async function loadClaimCats(c: CourierCompany): Promise<ClaimCategory[]> {
  const key = `${cacheKeyOf(c)}:claimcat`;
  if (cache.has(key)) return cache.get(key)!;
  const r = await http(c.name, url(c, '/claim-categories/search'), { method: 'POST', headers: h(c), json: { keyword: '', pageNumber: 1, pageSize: 200 } });
  const list = ((r?.items ?? []) as any[]).map((x) => ({ id: String(x.id), name: String(x.name || x.nameEnglish || x.nameArabic || x.id) }));
  cache.set(key, list);
  return list;
}

// Payments (ZR "treasury", from ZR's API documentation): GET /supplier-payment/supplier-balance, POST /payment-request
// {requestedDate ≥ tomorrow}, POST /payment-request/search {onlyPending}, POST /supplier-payment/search → payments with their
// totals (parcels delivered / cancelled, refunds, labeling, office holding, storage) and acceptedAt, PUT /supplier-payment/{id}
// (we received it), POST /treasury-transactions/search/supplier-payment/by-supplier-payment/{id} → one line per parcel.
const numOf = (v: unknown) => Math.round(Number(v) || 0);
const priceOf = (v: unknown) => (v == null || v === '' || !isFinite(Number(v)) ? null : Math.round(Number(v)));
const kgOf = (v: unknown) => (v == null || v === '' || !isFinite(Number(v)) || Number(v) <= 0 ? null : Math.round(Number(v) * 100) / 100);
/** What ZR charges for a parcel (its create answer, the parcel itself): its delivery and return price, the weight it counts. */
const costsOf = (p: any) => ({ delivery: priceOf(p?.deliveryPrice), ret: priceOf(p?.returnPrice), kg: kgOf(p?.weight?.effectiveWeight ?? p?.weight?.weight) });
const DONE = /(accept|pay[ée]|paid|valid|termin|complet|done|re[çc]u)/i;
async function pages(c: CourierCompany, path: string, json: Record<string, unknown>, max = 5) {
  const out: any[] = [];
  for (let n = 1; n <= max; n++) {
    const r = await http(c.name, url(c, path), { method: 'POST', headers: h(c), json: { pageNumber: n, pageSize: 100, ...json } });
    out.push(...(r?.items ?? []));
    if (!r?.hasNext || !(r?.items ?? []).length) break;
  }
  return out;
}
const payments: NonNullable<CourierAdapter['payments']> = {
  async balance(c) {
    needKeys(c, 'api_key', 'tenant');
    const r = await http(c.name, url(c, '/supplier-payment/supplier-balance'), { headers: h(c) });
    // ZR's app (25 Nov 2026): « Solde prêt » = totalAmountReadyToBeCashed, the money it holds for us that we can ask for
    // (Pilotix asks for it by itself when it is above 0); « Paiements en attente de récupération » =
    // totalAmountReadyToBePaid, payments ZR already made that wait at its office (they show on their own, « à récupérer »).
    // Until then Pilotix read the second one as « Prêt à payer »: it showed 0 and never asked.
    return { paid: numOf(r?.totalAmountPaid), ready: numOf(r?.totalAmountReadyToBeCashed), delivered: numOf(r?.totalAmountDelivered), notReady: numOf(r?.totalAmountNotReadyCashed) };
  },
  async requests(c) {
    needKeys(c, 'api_key', 'tenant');
    const items = await pages(c, '/payment-request/search', { orderBy: ['createdAt desc'], onlyPending: false }, 1);
    return items.map((x) => ({ extId: String(x.id), date: x.requestedDate ?? null, approved: x.validatedAt ? x.isApproved !== false : null, comment: x.comment ?? null, at: x.createdAt ?? null }));
  },
  async request(c, date) {
    needKeys(c, 'api_key', 'tenant');
    const r = await http(c.name, url(c, '/payment-request'), { method: 'POST', headers: h(c), json: { requestedDate: date } });
    const id = r?.id || (typeof r === 'string' ? r : null);
    if (!id) throw new CourierError('ZR n’a pas renvoyé de numéro de demande');
    return { extId: String(id) };
  },
  async list(c) {
    needKeys(c, 'api_key', 'tenant');
    const items = await pages(c, '/supplier-payment/search', { orderBy: ['createdAt desc'] }, 2);
    return items.map((x) => {
      const status = String(x.status ?? '');
      const done = !!x.acceptedAt || DONE.test(status);
      const hub = x.cashDrawer?.hub?.name;
      const who = [x.cashDrawer?.cashDrawerUser?.firstName, x.cashDrawer?.cashDrawerUser?.lastName].filter(Boolean).join(' ');
      return {
        extId: String(x.id),
        ref: x.referenceId ?? null,
        amount: numOf(x.amount),
        status,
        done,
        at: x.createdAt ?? null,
        doneAt: x.acceptedAt ?? null,
        requestId: x.paymentRequestId ?? null,
        place: [hub, who].filter(Boolean).join(' · ') || null,
        details: {
          parcelsDelivered: numOf(x.totalParcelsDelivered),
          parcelsCancelled: numOf(x.totalParcelsCancelled),
          refundsCredited: numOf(x.totalRefundsCredited),
          refundsDebited: numOf(x.totalRefundsDebited),
          labelingItems: numOf(x.totalItemLabeling),
          labeling: numOf(x.labelingAmount),
          officeHoldingItems: numOf(x.totalItemOfficeHolding),
          officeHolding: numOf(x.officeHoldingAmount),
          storage: numOf(x.storage),
        },
      };
    });
  },
  async lines(c, extId) {
    needKeys(c, 'api_key', 'tenant');
    const items = await pages(c, `/treasury-transactions/search/supplier-payment/by-supplier-payment/${encodeURIComponent(extId)}`, { supplierPaymentId: extId }, 30);
    return items.map((x) => ({
      tracking: x.parcel?.trackingNumber ?? null,
      customer: x.parcel?.customerFullName ?? null,
      type: String(x.type ?? ''),
      amount: numOf(x.amount),
      costs: numOf(x.weightCost) + numOf(x.swapCost) + numOf(x.phoneChangeCost),
      comment: x.comment ?? null,
      // the parcel's own prices and ZR's weight fee on it (« weightCost »: 50 DA a kg above 5 kg, also on a return)
      fees: { delivery: priceOf(x.parcel?.deliveryPrice), ret: priceOf(x.parcel?.returnPrice), kg: kgOf(x.parcel?.weight), weight: numOf(x.weightCost) },
    }));
  },
  async accept(c, extId) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, `/supplier-payment/${encodeURIComponent(extId)}`), { method: 'PUT', headers: h(c), json: { supplierPaymentId: extId } });
  },
  async requestDate(c, extId, date) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, `/payment-request/${encodeURIComponent(extId)}/date`), { method: 'PATCH', headers: h(c), json: { requestId: extId, requestedDate: date } });
  },
  async requestCancel(c, extId) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, `/payment-request/${encodeURIComponent(extId)}`), { method: 'DELETE', headers: h(c) });
  },
};

// ZR's own claim workflow (read in its app, 25 Nov 2026): « En attente de traitement » → « Réclamation en traitement » →
// « Traitée » (its end: no step after it, but ZR does not lock it). ZR has no « refused » state.
const RESOLVED = /(r[ée]solu|r[ée]gl|cl[ôo]tur|ferm[ée]|closed|resolved|termin[ée]|\btrait[ée]e\b)/i;
/** A claim ZR closed without giving us what we asked (« Perdue » in Pilotix, never « Résolue »). */
const REFUSED = /(rejet|refus|non[ -]?fond|infond|sans suite|irrecevable|rejected|declined)/i;

/** Where a ZR claim stands from its state: open, or closed (locked) as solved or as refused. */
export function claimEnd(state: any): { status: string; closed: boolean; resolved: boolean; refused: boolean } {
  const name = String(state?.name || '');
  const status = String(state?.description || name);
  const refused = REFUSED.test(name) || REFUSED.test(status);
  const closed = !!state?.isLocked || refused || RESOLVED.test(name) || RESOLVED.test(status);
  return { status, closed, resolved: closed && !refused, refused };
}

/** ZR's comments on a claim, oldest first: its team's answers and the shop's own messages (from Pilotix or ZR's app). */
async function claimMessages(c: CourierCompany, id: string): Promise<ClaimMessage[]> {
  const out: ClaimMessage[] = [];
  for (let n = 1; n <= 5; n++) {
    const r = await http(c.name, url(c, `/claim-comments/${encodeURIComponent(id)}/search`), { method: 'POST', headers: h(c), json: { claimId: id, pageNumber: n, pageSize: 100 } });
    for (const x of (r?.items ?? []) as any[]) {
      const text = String(x.content ?? '').trim();
      if (!text) continue;
      out.push({ id: String(x.id ?? `${id}:${x.createdAt ?? out.length}`), at: x.createdAt ?? null, by: x.modifiedBy?.fullName ? String(x.modifiedBy.fullName) : null, byId: x.modifiedBy?.id ? String(x.modifiedBy.id) : null, text });
    }
    if (!r?.hasNext) break;
  }
  return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
}

/** A short number for a ZR claim with no parcel number (ZR gives no number of its own: the start of its id). */
const claimNo = (id: string) => String(id).slice(0, 8).toUpperCase();

// ---------------------------------------------------------------- parcels: body, ids, addresses
/** Where ZR delivers: a stop desk (its hub) or a home address (wilaya and commune as ZR territories). */
async function zrAddress(c: CourierCompany, p: Parcel, helpers: Helpers) {
  if (p.is_stopdesk) {
    if (!p.stopdesk_ext_id) throw new CourierError('Choisissez le bureau ZR (stop desk) de la commande');
    const hub = (await hubs(c)).list.find((x) => String(x.id) === String(p.stopdesk_ext_id));
    if (!hub) throw new CourierError(`Bureau ZR introuvable : réimportez les stop desks de ${c.name}`);
    return { hubId: String(hub.id), address: { cityTerritoryId: hub.address?.cityTerritoryId, districtTerritoryId: hub.address?.districtTerritoryId, street: cut(p.address || hub.name, 200) } };
  }
  const w = (await territories(c, 'wilaya')).find((t) => Number(t.code) === Number(p.wilaya_id));
  if (!w) throw new CourierError(`ZR ne livre pas la wilaya ${p.wilaya_id}`);
  // ZR gives each commune's Arabic name too: « Beni Zmenzer » (أيت زمنزر) is found as ZR's « Ait Zmenzer »
  const com = await helpers.communeName(p, async (_w, fresh) => (await territories(c, 'commune', fresh)).filter((t) => t.parentId === w.id).map((t) => ({ id: t.id, name: t.name, ar: t.nameArabic ?? null })), `zr:${cacheKeyOf(c)}:${w.id}`);
  if (!com) throw new CourierError(`Commune « ${p.commune} » introuvable chez ZR : corrigez la commune`);
  return { hubId: undefined, address: { cityTerritoryId: w.id, districtTerritoryId: com.id, street: cut(p.address || p.commune, 200) } };
}

/** The body ZR wants for a new parcel (also used for an exchange). The customer is created or updated first. */
async function parcelBody(c: CourierCompany, p: Parcel, helpers: Helpers) {
  const { hubId, address } = await zrAddress(c, p, helpers);
  const phone = { number1: intl(p.phone), ...(p.phone2 ? { number2: intl(p.phone2) } : {}) };
  const customer = await http(c.name, url(c, '/customers/individual'), { method: 'POST', headers: h(c), json: { name: cut(p.customer_name || 'Client', 100), phone } });
  const body: Record<string, unknown> = {
    customer: { customerId: customer.id, name: cut(p.customer_name || 'Client', 100), phone },
    deliveryAddress: address,
    deliveryType: p.is_stopdesk ? 'pickup-point' : 'home',
    amount: Math.round(p.total),
    description: cut(p.products, 100),
    externalId: p.ref,
    orderedProducts: p.items.map((i) => ({ productName: cut(i.name, 100), unitPrice: Math.round(i.price), quantity: i.qty, stockType: c.settings.stock_type || 'none', ...(i.sku ? { productSku: cut(i.sku, 50) } : {}) })),
    weight: { weight: Math.max(1, Math.round(p.weight || 1)) },
  };
  if (hubId) body.hubId = hubId;
  return body;
}

const keysRefused = (e: any) => String(e?.message).includes('refuse les clés') || e?.status === 429;

/** ZR's own id (UUID) of one of our parcels: the one kept at sending, else found from its tracking number. */
async function parcelUuid(c: CourierCompany, it: TrackItem): Promise<string> {
  if (it.extId) return it.extId;
  const p = await http(c.name, url(c, `/parcels/${encodeURIComponent(it.tracking)}`), { headers: h(c) });
  if (!p?.id) throw new CourierError(`Colis ${it.tracking} introuvable chez ZR`);
  return String(p.id);
}
/** The UUIDs of many parcels (uuid → our tracking number); the ones ZR does not know are set apart. */
async function parcelUuids(c: CourierCompany, items: TrackItem[]) {
  const byId = new Map<string, string>();
  const failed: { tracking: string; error: string }[] = [];
  for (const it of items) {
    try {
      byId.set(await parcelUuid(c, it), it.tracking);
    } catch (e: any) {
      if (keysRefused(e)) throw e;
      failed.push({ tracking: it.tracking, error: e?.message ?? 'Colis introuvable chez ZR' });
    }
  }
  return { byId, failed };
}
/** ZR's answer to adding parcels to a bag → our tracking numbers added, and the refused ones with their reason. */
function bagResult(r: any, byId: Map<string, string>): BagAdded {
  const failures = (r?.failures ?? []) as any[];
  const refused = new Set(failures.map((f) => String(f.parcelId)));
  const failed = failures.map((f) => ({ tracking: byId.get(String(f.parcelId)) ?? String(f.parcelId), error: String(f.errorMessage || f.errorCode || 'Refusé par ZR') }));
  const added = Array.isArray(r?.successes)
    ? (r.successes as any[]).map((s) => byId.get(String(s.parcelId)) ?? (s.trackingNumber ? String(s.trackingNumber) : null)).filter((x): x is string => !!x)
    : [...byId.entries()].filter(([id]) => !refused.has(id)).map(([, t]) => t);
  return { added, failed };
}
/** ZR states and situations come as objects or words. */
const word = (s: unknown): string | null => {
  if (s == null) return null;
  if (typeof s === 'object') return String((s as any).description || (s as any).name || (s as any).value || '') || null;
  return String(s) || null;
};
const listOf = (r: any): any[] => (Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : []);
const phoneOf = (p: unknown): string | null => (p && typeof p === 'object' ? String((p as any).number1 || '') || null : p ? String(p) : null);

// ---------------------------------------------------------------- pickup bags (sacs de ramassage)
const bags: CourierBags = {
  async create(c, items) {
    needKeys(c, 'api_key', 'tenant');
    const { byId, failed } = await parcelUuids(c, items);
    if (!byId.size) throw new CourierError(failed[0]?.error || 'Aucun colis à mettre dans le sac');
    const r = await http(c.name, url(c, '/pickup-bags'), { method: 'POST', headers: h(c), json: { parcelIds: [...byId.keys()] } });
    const id = r?.id || (typeof r === 'string' ? r : null);
    if (!id) throw new CourierError('ZR n’a pas renvoyé de numéro de sac');
    const res = bagResult(r, byId);
    return { extId: String(id), tracking: r?.trackingNumber ? String(r.trackingNumber) : null, added: res.added, failed: [...failed, ...res.failed] };
  },
  async add(c, bag, items) {
    needKeys(c, 'api_key', 'tenant');
    const { byId, failed } = await parcelUuids(c, items);
    if (!byId.size) return { added: [], failed };
    const r = await http(c.name, url(c, `/pickup-bags/${encodeURIComponent(bag)}/add-parcel`), { method: 'PATCH', headers: h(c), json: { pickupBagId: bag, parcelIds: [...byId.keys()] } });
    const res = bagResult(r, byId);
    return { added: res.added, failed: [...failed, ...res.failed] };
  },
  async remove(c, bag, item) {
    needKeys(c, 'api_key', 'tenant');
    const parcelId = await parcelUuid(c, item);
    await http(c.name, url(c, `/pickup-bags/${encodeURIComponent(bag)}/remove-parcel`), { method: 'PATCH', headers: h(c), json: { pickupBagId: bag, parcelId } });
  },
  async list(c) {
    needKeys(c, 'api_key', 'tenant');
    const items = await pages(c, '/pickup-bags/search', { orderBy: ['createdAt desc'], onlyUnprocessed: false }, 2);
    return items.map((x): BagInfo => ({
      extId: String(x.id),
      tracking: x.trackingNumber ? String(x.trackingNumber) : null,
      state: word(x.state),
      parcels: x.totalParcels == null ? null : numOf(x.totalParcels),
      unprocessed: x.unprocessedParcelsCount == null ? null : numOf(x.unprocessedParcelsCount),
      at: x.createdAt ?? null,
    }));
  },
  async label(c, tracking) {
    needKeys(c, 'api_key', 'tenant');
    const r = await http(c.name, url(c, '/pickup-bags/labels/pdf'), { method: 'POST', headers: h(c), json: { trackingNumber: tracking } });
    return r?.fileUrl ? { url: String(r.fileUrl) } : null;
  },
  async drop(c, bag) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, `/pickup-bags/${encodeURIComponent(bag)}`), { method: 'DELETE', headers: h(c) });
  },
};

// ---------------------------------------------------------------- one parcel as ZR sees it
/** Its past states, oldest first (GET /parcels/{id}/state-history): the words of each, as `track` writes them (the
 *  state's description, its situations by name), so an old history line gets the same words a new one would. */
async function parcelSteps(c: CourierCompany, it: TrackItem): Promise<CourierStep[]> {
  needKeys(c, 'api_key', 'tenant');
  const pid = encodeURIComponent(await parcelUuid(c, it));
  const r = await http(c.name, url(c, `/parcels/${pid}/state-history`), { headers: h(c) });
  return listOf(r)
    .map((x): CourierStep => ({
      at: zrIso(x.createdAt) ?? '',
      key: x.newState && (x.newState.name || x.newState.code) ? String(x.newState.name || x.newState.code) : null,
      status: String(x.newState?.description || x.newState?.name || x.newState?.code || ''),
      situations: ((x.situations ?? []) as any[])
        .map((s) => ({ name: String(s.situationName || s.situationDescription || ''), at: zrIso(s.createdAt) }))
        .filter((s) => s.name)
        .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')),
    }))
    .filter((x) => x.at && x.status)
    .sort((a, b) => a.at.localeCompare(b.at));
}
/** A ZR date as a full ISO time (UTC); one written without its time zone is taken as UTC, ZR's clock. Null: no date. */
export function zrIso(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  if (!s) return null;
  const t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(s) || !/T\d/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function parcelInfo(c: CourierCompany, it: TrackItem): Promise<ParcelInfo> {
  needKeys(c, 'api_key', 'tenant');
  const p = await http(c.name, url(c, `/parcels/${encodeURIComponent(it.extId || it.tracking)}`), { headers: h(c) });
  const pid = encodeURIComponent(String(p?.id ?? it.extId ?? it.tracking));
  const soft = (path: string) => http(c.name, url(c, path), { headers: h(c) }).catch((e) => (keysRefused(e) ? Promise.reject(e) : null));
  const [hist, sms] = await Promise.all([soft(`/parcels/${pid}/state-history`), soft(`/parcels/${pid}/sms-history`)]);
  const dp = p?.deliveryPerson;
  const rm = p?.returnMeter;
  const a = p?.deliveryAddress ?? {};
  const n = (v: unknown) => (v == null ? null : numOf(v));
  return {
    state: word(p?.state),
    color: p?.state?.color ?? null,
    situation: word(p?.situation),
    livreur: dp && (dp.firstName || dp.lastName) ? { name: [dp.firstName, dp.lastName].filter(Boolean).join(' '), phone: phoneOf(dp.phone), hub: dp.hub?.name ?? null } : null,
    risk: rm && rm.score != null ? { score: numOf(rm.score), level: rm.level ?? null, orders: numOf(rm.completedOrders), returns: numOf(rm.returns) } : null,
    // not locked yet (not picked up): everything can still be changed directly
    canModify: p?.state?.isLocked === false || !!p?.isEligibleForModification,
    canChangePhone: p?.state?.isLocked === false || !!p?.isEligibleForPhoneChange,
    direct: p?.state?.isLocked === false,
    pendingChange: !!p?.hasActiveModificationRequest,
    modifications: n(p?.modificationCount),
    modificationLimit: n(p?.applicableModificationThreshold),
    phoneChanges: n(p?.phoneChangeCount),
    phoneChangeLimit: n(p?.applicablePhoneChangeThreshold),
    phoneChangePrice: n(p?.phoneChangePrice),
    delivery: { type: word(p?.deliveryType), hub: a.hubName ?? null, city: a.city ?? null, district: a.district ?? null, street: a.street ?? null },
    amount: n(p?.amount),
    deliveryPrice: n(p?.deliveryPrice),
    returnPrice: n(p?.returnPrice),
    swap: p?.swap ? { eligible: !!p.swap.isEligibleForSwap, count: numOf(p.swap.count ?? 0), sameCityPrice: n(p.swap.sameCityPrice), differentCityPrice: n(p.swap.differentCityPrice) } : null,
    history: listOf(hist)
      .map((x) => ({
        at: String(x.createdAt ?? ''),
        status: word(x.newState) ?? '',
        color: x.newState?.color ?? null,
        hub: x.arrivalHub?.hubName || x.location?.hubName || null,
        by: x.modifiedBy?.fullName ?? null,
        comment: x.comment ?? null,
        situations: ((x.situations ?? []) as any[]).map((s) => ({ name: String(s.situationDescription || s.situationName || ''), at: s.createdAt ?? null })).filter((s) => s.name),
      }))
      .filter((x) => x.at && x.status)
      .sort((x, y) => y.at.localeCompare(x.at)),
    sms: listOf(sms)
      .map((x) => ({
        at: String(x.sentAt || x.createdAt || ''),
        phone: x.phone ?? null,
        message: x.message ?? null,
        status: x.deliveredAt ? 'delivered' : x.failedAt || x.lastError ? 'failed' : x.sentAt || x.submittedAt ? 'sent' : 'waiting',
      }))
      .filter((x) => x.at)
      .sort((x, y) => y.at.localeCompare(x.at)),
  };
}

// ---------------------------------------------------------------- modification requests (demandes de modification)
async function changeRequest(c: CourierCompany, i: ChangeInput, helpers: Helpers, p: Parcel | null) {
  needKeys(c, 'api_key', 'tenant');
  const cur = await http(c.name, url(c, `/parcels/${encodeURIComponent(i.item.extId || i.item.tracking)}`), { headers: h(c) });
  if (!cur?.id) throw new CourierError(`Colis ${i.item.tracking} introuvable chez ZR`);
  const parcelId = String(cur.id);
  // A parcel ZR has not locked yet (not picked up) is changed DIRECTLY: ZR refuses a request for it
  // (« … is not in a locked state and can be modified directly »). Instant, and it uses none of the parcel's changes.
  if (cur.state?.isLocked === false) {
    try {
      return await changeDirect(c, i, helpers, p, cur);
    } catch (e: any) {
      // ZR's state can say « not locked » for a parcel it has locked (out for delivery, « Commune erronée »: PX1312,
      // 27 Nov 2026): its direct change then answers « … is in a locked state and cannot be modified ». A modification
      // request instead, as for any locked parcel.
      if (/is in a locked state|cannot be modified/i.test(String(e?.message))) return changeByRequest(c, i, helpers, p, cur);
      throw e;
    }
  }
  try {
    return await changeByRequest(c, i, helpers, p, cur);
  } catch (e: any) {
    if (/not in a locked state|modified directly/i.test(String(e?.message))) return changeDirect(c, i, helpers, p, cur);
    throw e;
  }
}

/** The new place of a parcel (stop desk or home), as for a new parcel. */
async function changedPlace(c: CourierCompany, i: ChangeInput, helpers: Helpers, p: Parcel | null) {
  if (!p) throw new CourierError('Commande introuvable');
  const next: Parcel = {
    ...p,
    is_stopdesk: i.kind === 'delivery' ? !!i.stopdesk : p.is_stopdesk,
    stopdesk_ext_id: i.kind === 'delivery' && i.stopdesk ? (i.hubExtId ?? null) : p.stopdesk_ext_id,
    wilaya_id: i.wilayaId ?? p.wilaya_id,
    commune: i.commune ?? p.commune,
    address: i.address ?? p.address,
  };
  if (i.kind === 'address' && next.is_stopdesk) throw new CourierError('Colis livré en stop desk : changez plutôt le bureau (Domicile ↔ Stop desk)');
  const { hubId, address } = await zrAddress(c, next, helpers);
  return { next, hubId, address };
}

/** Changes a parcel that is not locked yet straight at ZR (amount, address / stop desk, phone). */
async function changeDirect(c: CourierCompany, i: ChangeInput, helpers: Helpers, p: Parcel | null, cur: any) {
  const parcelId = String(cur.id);
  const at = (path: string, json: unknown) => http(c.name, url(c, `/parcels/${encodeURIComponent(parcelId)}/${path}`), { method: 'PATCH', headers: h(c), json });
  if (i.kind === 'phone') {
    if (!i.phone) throw new CourierError('Le nouveau numéro manque');
    const phone = { number1: intl(i.phone), ...(i.phone2 ? { number2: intl(i.phone2) } : {}) };
    await at('customer', { parcelId, name: cut(cur.customer?.name || p?.customer_name || 'Client', 100), phone });
  } else if (i.kind === 'amount') {
    if (i.amount == null || !(i.amount >= 0)) throw new CourierError('Le nouveau montant manque');
    await at('amount', { parcelId, amount: Math.round(i.amount) });
  } else {
    const { next, hubId, address } = await changedPlace(c, i, helpers, p);
    await at('deliveryAddress', { parcelId, deliveryAddress: address, ...(hubId ? { hubId } : {}) });
    if (i.amount != null && i.amount >= 0) await at('amount', { parcelId, amount: Math.round(i.amount) });
    if (i.kind === 'delivery') {
      // Domicile ↔ Stop desk: checked on ZR's side, never shown as done when ZR kept the old type
      const want = next.is_stopdesk ? 'pickup-point' : 'home';
      const after = await http(c.name, url(c, `/parcels/${encodeURIComponent(parcelId)}`), { headers: h(c) }).catch(() => null);
      const got = String(after?.deliveryType?.name ?? after?.deliveryType ?? '').toLowerCase();
      if (got && got !== want) throw new CourierError(`ZR a changé l’adresse mais pas le type de livraison (${got}). Supprimez le colis et renvoyez-le, ou changez-le après l’enlèvement.`);
    }
  }
  return { extId: `direct:${parcelId}:${Date.now()}`, approved: true, direct: true };
}

/** A modification request (parcel already locked at ZR): ZR validates it later. */
async function changeByRequest(c: CourierCompany, i: ChangeInput, helpers: Helpers, p: Parcel | null, cur: any) {
  const parcelId = String(cur.id);
  if (i.kind === 'phone') {
    if (!i.phone) throw new CourierError('Le nouveau numéro manque');
    const r = await http(c.name, url(c, '/parcel-modification-requests/phone'), {
      method: 'POST',
      headers: h(c),
      json: { parcelId, phone: { number1: intl(i.phone), ...(i.phone2 ? { number2: intl(i.phone2) } : {}) } },
    });
    // a phone change is applied by ZR at once (within its quota)
    return { extId: String(r?.id || (typeof r === 'string' ? r : parcelId)), approved: true };
  }
  const a = cur.deliveryAddress ?? {};
  const current = { cityTerritoryId: a.cityTerritoryId, districtTerritoryId: a.districtTerritoryId, street: cut(a.street || a.district || '-', 200) };
  const body: Record<string, unknown> = { parcelId, deliveryAddress: current };
  if (i.kind === 'amount') {
    if (i.amount == null || !(i.amount >= 0)) throw new CourierError('Le nouveau montant manque');
    body.amount = Math.round(i.amount);
  } else {
    // the new place: a stop desk (its hub) or a home address, as for a new parcel
    const { next, hubId, address } = await changedPlace(c, i, helpers, p);
    body.deliveryAddress = address;
    body.deliveryType = next.is_stopdesk ? 'pickup-point' : 'home';
    if (hubId) body.hubId = hubId;
    // the amount can change with the place (another fee, a discount agreed with the customer)
    if (i.amount != null && i.amount >= 0) body.amount = Math.round(i.amount);
  }
  const r = await http(c.name, url(c, '/parcel-modification-requests'), { method: 'POST', headers: h(c), json: body });
  const id = r?.id || (typeof r === 'string' ? r : null);
  if (!id) throw new CourierError('ZR n’a pas renvoyé de numéro de demande');
  return { extId: String(id), approved: null };
}

async function changeCancel(c: CourierCompany, extId: string) {
  needKeys(c, 'api_key', 'tenant');
  await http(c.name, url(c, `/parcel-modification-requests/${encodeURIComponent(extId)}`), { method: 'DELETE', headers: h(c) });
}

async function changeStates(c: CourierCompany, ids: string[]): Promise<ChangeState[]> {
  needKeys(c, 'api_key', 'tenant');
  const out: ChangeState[] = [];
  for (const id of ids) {
    if (timeUp()) break;
    let r: any;
    try {
      r = await http(c.name, url(c, `/parcel-modification-requests/${encodeURIComponent(id)}`), { headers: h(c) });
    } catch (e: any) {
      if (keysRefused(e)) throw e;
      continue;
    }
    const decided = !!r?.validatedAt || r?.isApproved === true;
    out.push({ extId: id, approved: decided ? r?.isApproved !== false : null, answer: r?.comment ?? null, at: r?.validatedAt ?? null });
  }
  return out;
}

// ---------------------------------------------------------------- statuses, service prices, webhook
async function zrStates(c: CourierCompany) {
  needKeys(c, 'api_key', 'tenant');
  const items = await pages(c, '/workflows/search', {}, 1);
  const flows = items.filter((w) => w.isDefault).length ? items.filter((w) => w.isDefault) : items;
  const seen = new Map<string, { key: string; label: string; color: string | null; rank: number }>();
  for (const w of flows)
    for (const s of (w.states ?? []) as any[]) {
      const key = String(s.name || '');
      if (key && !seen.has(key)) seen.set(key, { key, label: String(s.description || s.name), color: s.color ?? null, rank: numOf(s.ranking) });
    }
  return [...seen.values()].sort((a, b) => a.rank - b.rank).map(({ key, label, color }) => ({ key, label, color }));
}

async function zrServices(c: CourierCompany) {
  needKeys(c, 'api_key', 'tenant');
  const r = await http(c.name, url(c, '/delivery-pricing/service-pricing'), { headers: h(c) });
  const n = (v: unknown) => numOf(v);
  return [
    { key: 'swapSameCity', label: 'Échange (même wilaya)', price: n(r?.swapSameCityPrice) },
    { key: 'swapOtherCity', label: 'Échange (autre wilaya)', price: n(r?.swapDifferentCityPrice) },
    { key: 'phoneChange', label: 'Changement de téléphone', price: n(r?.phoneChangePrice) },
    { key: 'labeling', label: 'Étiquetage', price: n(r?.labelingPrice) },
    { key: 'weighting', label: 'Pesée', price: n(r?.weightingPrice) },
    { key: 'officeHolding', label: 'Garde au bureau', price: n(r?.officeHoldingPrice) },
    { key: 'officeHoldingFreeHours', label: 'Heures de garde gratuites', price: n(r?.officeHoldingFreeHours) },
  ];
}

const webhook: NonNullable<CourierAdapter['webhook']> = {
  async on(c, hookUrl, key) {
    needKeys(c, 'api_key', 'tenant');
    const body = { url: hookUrl, description: 'Pilotix : statuts des colis en direct', headers: { 'X-Pilotix-Key': key } };
    let r: any;
    try {
      r = await http(c.name, url(c, '/webhooks/endpoints'), { method: 'POST', headers: h(c), json: { ...body, eventTypes: ['parcel.state.updated'] } });
    } catch (e: any) {
      if (keysRefused(e)) throw e;
      // an account that names its events differently: every event
      r = await http(c.name, url(c, '/webhooks/endpoints'), { method: 'POST', headers: h(c), json: body });
    }
    const id = r?.id || (typeof r === 'string' ? r : null);
    if (!id) throw new CourierError('ZR n’a pas renvoyé de numéro de webhook');
    return { extId: String(id) };
  },
  async off(c, extId) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, `/webhooks/endpoints/${encodeURIComponent(extId)}`), { method: 'DELETE', headers: h(c) });
  },
  async get(c, extId) {
    needKeys(c, 'api_key', 'tenant');
    try {
      const r = await http(c.name, url(c, `/webhooks/endpoints/${encodeURIComponent(extId)}`), { headers: h(c) });
      return { on: !r?.disabled, url: r?.url ?? null };
    } catch (e: any) {
      if (keysRefused(e)) throw e;
      return null;
    }
  },
};

/** An answer that does not say whether ZR made the parcel: none in time, a network cut, or ZR's own server error. */
const unsure = (e: any) => e?.status === 502 || /: erreur 5\d\d$/.test(String(e?.message ?? ''));
/** how long ZR is given to finish a parcel it was slow to make, before Pilotix looks for it (tests set it to 0) */
export let lateWaitMs = 3000;
export const setLateWait = (ms: number) => void (lateWaitMs = ms);

/** The parcel ZR already has for this order (its externalId is the order's reference), or null. */
async function parcelOfOrder(c: CourierCompany, ref: string) {
  let r: any;
  try {
    r = await http(c.name, url(c, `/parcels/search/global?keyword=${encodeURIComponent(ref)}&top=10`), { headers: h(c) });
  } catch (e: any) {
    if (keysRefused(e)) throw e;
    return null;
  }
  const list: any[] = Array.isArray(r) ? r : (r?.items ?? r?.parcels ?? []);
  const x = list.find((p) => String(p?.externalId ?? '') === ref);
  return x?.id ? { tracking: String(x.trackingNumber || x.id), extId: String(x.id), labelUrl: null } : null;
}

// ---------------------------------------------------------------- swap (ZR's « Swaps »)
/** ZR's swap address: not in its public documentation, in the list its own app uses (« Internal V1 » of
 *  https://api.zrexpress.app/swagger, read 24 Nov 2026: « Creates and applies a parcel swap modification request »). */
const SWAP_PATH = '/parcel-modification-requests/swap';

/**
 * Gives a parcel its customer did not take to another customer, straight from ZR: ZR changes its customer (name, phones),
 * its address (home or one of its bureaus) and the amount to collect at once, and it cannot be undone there. ZR is asked
 * first whether it allows it (« Ne répond pas 3 » or « Commande annulée », before the return, 2 swaps at most), so its
 * refusal is said in plain words.
 */
async function swapParcel(c: CourierCompany, i: SwapInput, helpers: Helpers): Promise<SwapSent> {
  needKeys(c, 'api_key', 'tenant');
  const cur = await http(c.name, url(c, `/parcels/${encodeURIComponent(i.item.extId || i.item.tracking)}`), { headers: h(c) });
  if (!cur?.id) throw new CourierError(`Colis ${i.item.tracking} introuvable chez ZR`);
  if (cur.swap && cur.swap.isEligibleForSwap === false) {
    if (numOf(cur.swap.count) >= 2) throw new CourierError('ZR refuse : ce colis a déjà été swappé 2 fois (le maximum)');
    const now = [word(cur.state), word(cur.situation)].filter(Boolean).join(' · ');
    throw new CourierError(`ZR refuse le swap de ce colis maintenant${now ? ` (${now})` : ''} : seulement en « Ne répond pas 3 » ou « Commande annulée », avant son retour`);
  }
  const p = i.to;
  const phone = { number1: intl(p.phone), ...(p.phone2 ? { number2: intl(p.phone2) } : {}) };
  if (!phone.number1) throw new CourierError('Le téléphone du nouveau client manque');
  const { hubId, address } = await zrAddress(c, p, helpers);
  const body: Record<string, unknown> = {
    parcelId: String(cur.id),
    newCustomerName: cut(p.customer_name || 'Client', 100),
    phone,
    deliveryType: p.is_stopdesk ? 'pickup-point' : 'home',
    deliveryAddress: address,
    amount: Math.round(p.total),
  };
  if (hubId) body.hubId = hubId;
  const r = await swapPost(c, body);
  const id = r?.id || (typeof r === 'string' ? r : null);
  // made: its tracking number read back (ZR may give the parcel a new one), the old one kept if ZR does not answer
  const after = await http(c.name, url(c, `/parcels/${encodeURIComponent(String(cur.id))}`), { headers: h(c) }).catch(() => null);
  return { extId: id ? String(id) : null, parcelExtId: String(cur.id), tracking: String(after?.trackingNumber || cur.trackingNumber || i.item.tracking) };
}

/**
 * ZR reads a key two ways: « X-Api-Key » (the one its documentation gives) and « Authorization: Bearer » (the way its
 * own site sends its logins). Its swap is not in the list of addresses its keys may use (its « Jetons API » page, read
 * 26 Nov 2026: modifications and phone changes are, swaps are not), and the first way is refused there: the second is
 * tried at once. Both refused: ZR's own answer is said, word for word, so it can be shown to ZR.
 */
const hBearer = (c: CourierCompany) => ({ Authorization: `Bearer ${String(c.secret.api_key ?? '').trim()}`, 'X-Tenant': String(c.secret.tenant ?? '').trim() });
/** ZR's answer to a refused key, as it said it (« 403 · Forbidden », « 401 · Bearer error="invalid_token" »…). */
const zrRefusal = (e: any) => (e?.refused ? [String(e.refused.status), e.refused.words].filter(Boolean).join(' · ') : String(e?.message ?? ''));
/** What the swap window says when ZR refuses both ways: what to do now (the swap made in ZR's space is caught by itself). */
export const SWAP_REFUSED = 'ZR refuse le swap demandé avec la clé API de Pilotix : ZR ne donne pas encore le swap aux clés API. Faites ce swap dans l’espace ZR (menu « Swaps ») : Pilotix le voit tout seul et met le colis sur la commande de ce client.';

async function swapPost(c: CourierCompany, body: Record<string, unknown>): Promise<any> {
  try {
    return await http(c.name, url(c, SWAP_PATH), { method: 'POST', headers: h(c), json: body });
  } catch (e: any) {
    if (!e?.refused) throw e;
    try {
      return await http(c.name, url(c, SWAP_PATH), { method: 'POST', headers: hBearer(c), json: body });
    } catch (e2: any) {
      if (!e2?.refused) throw e2;
      const first = zrRefusal(e);
      const second = zrRefusal(e2);
      throw new CourierError(`${SWAP_REFUSED} (réponse de ZR : ${first}${second && second !== first ? ` ; en « Bearer » : ${second}` : ''})`);
    }
  }
}

/** A parcel ZR swapped (its « swap » count, by its API or in its own « Swaps » page): who it goes to now, for the sync.
 *  Nothing for a parcel never swapped. */
export function swapSeen(r: any): { swapped?: CourierSwapSeen } {
  const count = numOf(r?.swap?.count ?? 0);
  if (!(count > 0)) return {};
  const ph = r?.customer?.phone ?? {};
  const phones = [ph.number1, ph.number2, ph.number3].map((x) => String(x ?? '').trim()).filter(Boolean);
  return {
    swapped: {
      count,
      at: zrIso(r?.swap?.swappedAt),
      name: r?.customer?.name ? String(r.customer.name) : null,
      phones,
      amount: r?.amount == null ? null : numOf(r.amount),
      tracking: r?.trackingNumber ? String(r.trackingNumber) : null,
      extId: r?.id ? String(r.id) : null,
    },
  };
}

/** « Tester »: whether ZR takes the swap from Pilotix with these keys — asked for a parcel that does not exist, so nothing
 *  is ever swapped: ZR looking for it means it accepts the keys for swaps. Both of ZR's ways are asked; its words said. */
async function swapReady(c: CourierCompany): Promise<string> {
  const none = '00000000-0000-0000-0000-000000000000';
  const body = { parcelId: none, phone: { number1: '+213550000000' }, deliveryType: 'home', deliveryAddress: { cityTerritoryId: none, districtTerritoryId: none, street: '-' }, amount: 0 };
  const ask = async (headers: Record<string, string>) => {
    try {
      await http(c.name, url(c, SWAP_PATH), { method: 'POST', headers, json: body });
      return null;
    } catch (e: any) {
      return e;
    }
  };
  const verdict = (e: any, how: string) => {
    const m = String(e?.message ?? '');
    if (/erreur 404$|erreur 405$/.test(m)) return 'Swap par API : adresse inconnue chez ZR (faites les swaps dans l’espace ZR : Pilotix les voit tout seul).';
    if (/trop de demandes|erreur 5\d\d$/.test(m)) return 'Swap par API : ZR ne répond pas maintenant, réessayez.';
    return `Swap par API : prêt${how}.`;
  };
  const e1 = await ask(h(c));
  if (!e1?.refused) return verdict(e1, '');
  const e2 = await ask(hBearer(c));
  if (!e2?.refused) return verdict(e2, ' (clé lue en « Bearer »)');
  return `Swap par API : ZR refuse la clé Pilotix (réponse de ZR : ${zrRefusal(e1)}). Faites les swaps dans l’espace ZR (menu « Swaps ») : Pilotix les voit tout seul et met chaque colis sur la commande de son nouveau client.`;
}

export const zr: CourierAdapter = {
  statuses: STATUSES,
  // « Commande annulée » or « Ne répond pas 3 » under any status (« Sortie en livraison », « Confirmé au bureau »…): the
  // customer cancelled or never answered — an alert, never left « En livraison » (24 Nov 2026), and ZR's swap is open
  situations: { 'Commande annulée': 'alert', 'Ne répond pas 3': 'alert' },
  swap: swapParcel,
  payments,
  bags,
  webhook,
  parcel: parcelInfo,
  steps: parcelSteps,
  change: changeRequest,
  changeStates,
  changeCancel,
  states: zrStates,
  services: zrServices,
  async test(c) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, '/territories/search'), { method: 'POST', headers: h(c), json: { keyword: 'alger', pageSize: 1, pageNumber: 1 } });
    return { ok: true, message: `Connexion réussie à ${c.name} (ZR Express). ${await swapReady(c)}` };
  },
  async create(c, p, helpers) {
    needKeys(c, 'api_key', 'tenant');
    // sent again after a failed try: ZR may have made the parcel anyway (its answer came too late) — taken back, never made twice
    if (p.retry) {
      const had = await parcelOfOrder(c, p.ref);
      if (had) return had;
    }
    const body = await parcelBody(c, p, helpers);
    let r: any;
    try {
      r = await http(c.name, url(c, '/parcels'), { method: 'POST', headers: h(c), json: body });
    } catch (e: any) {
      // no answer in time (or ZR's own server error): ZR may have made the parcel anyway — looked for at once, by itself
      if (!unsure(e)) throw e;
      await sleep(lateWaitMs);
      const had = await parcelOfOrder(c, p.ref);
      if (had) return had;
      throw e;
    }
    const id = r?.id || r?.parcelId;
    if (!id) throw new CourierError('ZR n’a pas renvoyé d’identifiant de colis');
    // the parcel exists now: a failed look-up of its number must not make Pilotix think it was refused
    let tracking = r?.trackingNumber as string | undefined;
    if (!tracking) tracking = (await http(c.name, url(c, `/parcels/${id}`), { headers: h(c) }).catch(() => null))?.trackingNumber;
    return { tracking: tracking || String(id), extId: String(id), labelUrl: null, costs: costsOf(r) };
  },
  // an SAV exchange: ZR delivers the new parcel and makes its own return parcel for the old product
  async exchange(c, p, original, helpers) {
    needKeys(c, 'api_key', 'tenant');
    const originalParcelId = await parcelUuid(c, original);
    const r = await http(c.name, url(c, '/parcels/exchange'), { method: 'POST', headers: h(c), json: { ...(await parcelBody(c, p, helpers)), originalParcelId } });
    const id = r?.newParcelId || r?.id;
    if (!id) throw new CourierError('ZR n’a pas renvoyé d’identifiant pour l’échange');
    return {
      tracking: r?.newParcelTrackingNumber || String(id),
      extId: String(id),
      labelUrl: null,
      returnTracking: r?.returnParcelTrackingNumber ?? null,
      returnExtId: r?.returnParcelId ? String(r.returnParcelId) : null,
    };
  },
  async track(c, items) {
    const out = [];
    for (const it of items) {
      if (timeUp()) break;
      let r: any;
      try {
        r = await http(c.name, url(c, `/parcels/${encodeURIComponent(it.extId || it.tracking)}`), { headers: h(c) });
      } catch (e: any) {
        if (String(e.message).includes('refuse les clés') || e.status === 429) throw e;
        // told to the suivi (sync result) instead of being skipped in silence: the parcel would never update again
        out.push({ id: it.id, status: '', error: e.status === 404 ? 'ZR ne trouve pas ce colis' : String(e.message ?? 'Erreur').slice(0, 200) });
        continue;
      }
      const key = r.state && (r.state.name || r.state.code) ? String(r.state.name || r.state.code) : null;
      if (!key) continue;
      const situation = r.situation && (r.situation.name || r.situation.description);
      const mapped = STATUSES[key];
      out.push({ id: it.id, key, status: (r.state.description || key) + (situation ? ` · ${situation}` : ''), at: r.lastStateUpdateAt ?? null, mapped: r.isReturn && mapped !== 'returned' ? ('returning' as const) : undefined, costs: costsOf(r), ...swapSeen(r) });
    }
    return out;
  },
  async cancel(c, it) {
    const r = await http(c.name, url(c, '/parcels/bulk/by-tracking-number'), { method: 'DELETE', headers: h(c), json: { trackingNumbers: [it.tracking] } });
    if (r?.failureCount) throw new CourierError(`ZR refuse : ${r.failures?.[0]?.errorMessage || 'colis déjà pris en charge'}`);
  },
  async label(c, it) {
    const r = await http(c.name, url(c, '/parcels/labels/individual/pdf'), { method: 'POST', headers: h(c), json: { trackingNumbers: [it.tracking], format: labelFormat(c) } });
    const f = (r.parcelLabelFiles ?? [])[0];
    return f ? { url: f.fileUrl } : null;
  },
  // one PDF for up to 250 parcels (A6: one label per page, for label printers; A4: four per page)
  async labels(c, items) {
    needKeys(c, 'api_key', 'tenant');
    const r = await http(c.name, url(c, '/parcels/labels/multiple/pdf'), { method: 'POST', headers: h(c), json: { trackingNumbers: items.map((i) => i.tracking), format: labelFormat(c) } });
    return { label: r?.fileUrl ? { url: String(r.fileUrl) } : null, failed: ((r?.failedTrackingNumbers ?? []) as unknown[]).map(String) };
  },
  async fees(c) {
    needKeys(c, 'api_key', 'tenant');
    const r = await http(c.name, url(c, '/delivery-pricing/rates'), { headers: h(c) });
    const rows = new Map<number, FeeRow>();
    const local: any[] = [];
    for (const rate of r?.rates ?? []) {
      const w = Number(rate.toTerritoryCode);
      if ((!rate.toTerritoryLevel || rate.toTerritoryLevel === 'wilaya') && w >= 1 && w <= 69) rows.set(w, feeOf(w, [rate]));
      else local.push(rate);
    }
    try {
      await communeFees(c, rows, local);
    } catch {
      // the other wilayas keep the prices ZR gave: only a wilaya priced by commune stays without one, as before
    }
    return [...rows.values()].sort((a, b) => a.wilayaId - b.wilayaId);
  },
  async claimCategories(c) {
    needKeys(c, 'api_key', 'tenant');
    return loadClaimCats(c);
  },
  async claim(c, i) {
    needKeys(c, 'api_key', 'tenant');
    const cats = await loadClaimCats(c);
    let categoryId = i.categoryId && cats.some((x) => x.id === i.categoryId) ? i.categoryId : null;
    if (!categoryId) {
      const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’`]/g, "'").toLowerCase().trim();
      const hinted = (REASON_HINTS[i.reason] ?? []).map((w) => cats.find((x) => norm(x.name).includes(w))).find(Boolean);
      const loose = bestMatch(i.reasonText, cats.map((x) => x.name));
      const hit = hinted ?? (loose ? cats.find((x) => x.name === loose) : undefined);
      categoryId = (hit ?? cats.find((x) => /autre|other/i.test(x.name)) ?? cats[0])?.id ?? null;
    }
    if (!categoryId) throw new CourierError('ZR n’a pas de catégorie de réclamation : vérifiez votre espace ZR');
    // ZR wants its own parcel UUID: the one kept at sending, else found from the tracking number
    let parcelId = i.item.extId;
    if (!parcelId) {
      const p = await http(c.name, url(c, `/parcels/${encodeURIComponent(i.item.tracking)}`), { headers: h(c) });
      parcelId = p?.id ? String(p.id) : null;
    }
    if (!parcelId) throw new CourierError(`Colis ${i.item.tracking} introuvable chez ZR`);
    const r = await http(c.name, url(c, '/claims'), {
      method: 'POST',
      headers: h(c),
      json: { categoryId, title: cut(`${i.reasonText} · ${i.item.tracking}`, 100), description: cut(i.description, 2000), parcelId },
    });
    const id = r?.id || (typeof r === 'string' ? r : null);
    if (!id) throw new CourierError('ZR n’a pas renvoyé de numéro de réclamation');
    let status: string | null = null;
    try {
      const g = await http(c.name, url(c, `/claims/${encodeURIComponent(id)}`), { method: 'POST', headers: h(c), json: { claimId: id } });
      status = claimEnd(g?.state).status || null;
    } catch {
      /* the claim exists; its state comes with the next refresh */
    }
    // ZR's app lists a réclamation by its parcel's number (it has no number of its own); its category, in ZR's words
    return { extId: String(id), extRef: i.item.tracking || claimNo(String(id)), status, category: cats.find((x) => x.id === categoryId)?.name?.trim() || null };
  },
  async claimComment(c, extId, text) {
    needKeys(c, 'api_key', 'tenant');
    const r = await http(c.name, url(c, `/claim-comments/${encodeURIComponent(extId)}`), { method: 'PATCH', headers: h(c), json: { claimId: extId, comment: cut(text, 2000) } });
    // ZR's id for the comment: Pilotix knows it as its own when it reads the conversation back
    return r?.id ? String(r.id) : typeof r === 'string' && r.trim() ? r.trim() : null;
  },
  async claimStates(c, ids) {
    needKeys(c, 'api_key', 'tenant');
    const out: ClaimState[] = [];
    for (const id of ids) {
      if (timeUp()) break;
      let g: any;
      try {
        g = await http(c.name, url(c, `/claims/${encodeURIComponent(id)}`), { method: 'POST', headers: h(c), json: { claimId: id } });
      } catch (e: any) {
        if (String(e.message).includes('refuse les clés') || e.status === 429) throw e;
        continue;
      }
      const end = claimEnd(g?.state);
      if (!end.status) continue;
      let messages: ClaimMessage[] | undefined;
      try {
        messages = await claimMessages(c, id);
      } catch {
        /* the conversation comes with a later refresh */
      }
      const last = messages?.[messages.length - 1];
      out.push({ extId: id, ...end, at: g?.lastModifiedAt ?? null, answer: last ? `${last.by ? `${last.by} : ` : ''}${last.text}` : null, messages });
    }
    return out;
  },
  async claimList(c, since) {
    needKeys(c, 'api_key', 'tenant');
    const out: ClaimFound[] = [];
    const from = since ? Date.parse(since) : NaN;
    // newest first; 5 pages of 100 at most at each refresh (older ones were brought in before)
    for (let n = 1; n <= 5; n++) {
      if (timeUp()) break;
      const r = await http(c.name, url(c, '/claims/search'), { method: 'POST', headers: h(c), json: { keyword: '', pageNumber: n, pageSize: 100, orderBy: ['createdAt desc'] } });
      const items = (r?.items ?? []) as any[];
      let older = false;
      for (const x of items) {
        if (!x?.id) continue;
        if (Number.isFinite(from) && x.createdAt && Date.parse(x.createdAt) < from) {
          older = true;
          continue;
        }
        const end = claimEnd(x.state);
        out.push({
          extId: String(x.id),
          extRef: x.parcel?.trackingNumber ? String(x.parcel.trackingNumber) : claimNo(String(x.id)),
          category: String(x.category?.name || x.category?.nameEnglish || x.category?.nameArabic || '').trim() || null,
          title: x.title ? String(x.title) : null,
          description: x.description ? String(x.description) : null,
          tracking: x.parcel?.trackingNumber ? String(x.parcel.trackingNumber) : null,
          parcelExtId: x.parcel?.id ? String(x.parcel.id) : null,
          createdAt: x.createdAt ?? null,
          ...end,
        });
      }
      if (older || !r?.hasNext || !items.length) break;
    }
    return out;
  },
  async stopdesks(c) {
    needKeys(c, 'api_key', 'tenant');
    const [{ list: hs, complete }, ws] = await Promise.all([hubs(c), territories(c, 'wilaya')]);
    if (!complete) throw new CourierError('ZR : liste des bureaux incomplète');
    const code = new Map(ws.map((w: any) => [w.id, Number(w.code)]));
    return hs
      .filter((x: any) => x.isPickupPoint && x.isVisible !== false)
      .map((x: any): Desk => ({ extId: String(x.id), name: x.name, wilayaId: code.get(x.address?.cityTerritoryId) ?? null, commune: x.address?.district || x.address?.city || null, address: [x.address?.street, x.address?.district, x.address?.city].filter(Boolean).join(', ') || null }));
  },
  /** ZR's own communes of one wilaya (kept in memory, like for sending): the confirmation checks the order's commune
   *  is one of them, so a commune ZR does not know is fixed with the customer, not found at the depot. */
  async communes(c, wilayaId, fresh) {
    needKeys(c, 'api_key', 'tenant');
    const w = (await territories(c, 'wilaya')).find((t) => Number(t.code) === Number(wilayaId));
    if (!w) return [];
    return (await territories(c, 'commune', fresh)).filter((t) => t.parentId === w.id).map((t) => ({ id: String(t.id), name: String(t.name ?? ''), ar: t.nameArabic ? String(t.nameArabic) : null }));
  },
};
