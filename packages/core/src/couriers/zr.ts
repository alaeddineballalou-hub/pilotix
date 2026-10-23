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
import type { BagAdded, BagInfo, ChangeInput, ChangeState, ClaimCategory, ClaimState, CourierAdapter, CourierBags, CourierCompany, Desk, Helpers, Parcel, ParcelInfo, TrackItem } from './types';
import { baseUrl, bestMatch, CourierError, cut, http, intl, needKeys, timeUp } from './util';

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
async function territories(c: CourierCompany, level: 'wilaya' | 'commune') {
  const key = `${c.id}:${level}`;
  if (cache.has(key)) return cache.get(key)!;
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
  cache.set(key, list);
  return list;
}
async function hubs(c: CourierCompany) {
  const key = `${c.id}:hubs`;
  if (cache.has(key)) return cache.get(key)!;
  const out: any[] = [];
  for (let n = 1; n < 10; n++) {
    const r = await http(c.name, url(c, '/hubs/search'), { method: 'POST', headers: h(c), json: { pageNumber: n, pageSize: 200 } });
    out.push(...(r.items ?? []));
    if (!r.hasNext || !(r.items ?? []).length) break;
  }
  cache.set(key, out);
  return out;
}

/** Words of our reasons that should find ZR's category (when the user did not choose one). */
const REASON_HINTS: Record<string, string[]> = {
  relivrer: ['relivraison', 'nouvelle tentative', 'livraison'],
  late: ['retard', 'delai', 'livraison'],
  nocall: ['appel', 'injoignable', 'livreur'],
  fakedeliv: ['faux', 'livre', 'statut'],
  fakeret: ['faux', 'retour', 'statut'],
  address: ['adresse', 'modification'],
  damaged: ['endommage', 'casse', 'abime'],
  money: ['paiement', 'versement', 'argent', 'encaissement'],
  noreturn: ['retour', 'non recu'],
  other: ['autre'],
};

async function loadClaimCats(c: CourierCompany): Promise<ClaimCategory[]> {
  const key = `${c.id}:claimcat`;
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
    return { paid: numOf(r?.totalAmountPaid), ready: numOf(r?.totalAmountReadyToBePaid), delivered: numOf(r?.totalAmountDelivered), notReady: numOf(r?.totalAmountNotReadyCashed) + numOf(r?.totalAmountReadyToBeCashed) };
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

const RESOLVED = /(r[ée]solu|r[ée]gl|cl[ôo]tur|ferm[ée]|closed|resolved|termin[ée])/i;

// ---------------------------------------------------------------- parcels: body, ids, addresses
/** Where ZR delivers: a stop desk (its hub) or a home address (wilaya and commune as ZR territories). */
async function zrAddress(c: CourierCompany, p: Parcel, helpers: Helpers) {
  if (p.is_stopdesk) {
    if (!p.stopdesk_ext_id) throw new CourierError('Choisissez le bureau ZR (stop desk) de la commande');
    const hub = (await hubs(c)).find((x) => String(x.id) === String(p.stopdesk_ext_id));
    if (!hub) throw new CourierError(`Bureau ZR introuvable : réimportez les stop desks de ${c.name}`);
    return { hubId: String(hub.id), address: { cityTerritoryId: hub.address?.cityTerritoryId, districtTerritoryId: hub.address?.districtTerritoryId, street: cut(p.address || hub.name, 200) } };
  }
  const w = (await territories(c, 'wilaya')).find((t) => Number(t.code) === Number(p.wilaya_id));
  if (!w) throw new CourierError(`ZR ne livre pas la wilaya ${p.wilaya_id}`);
  const com = await helpers.communeName(p, async () => (await territories(c, 'commune')).filter((t) => t.parentId === w.id).map((t) => ({ id: t.id, name: t.name })), `zr:${c.id}:${w.id}`);
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
    canModify: !!p?.isEligibleForModification,
    canChangePhone: !!p?.isEligibleForPhoneChange,
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
    if (!p) throw new CourierError('Commande introuvable');
    // the new place: a stop desk (its hub) or a home address, as for a new parcel
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

export const zr: CourierAdapter = {
  statuses: STATUSES,
  payments,
  bags,
  webhook,
  parcel: parcelInfo,
  change: changeRequest,
  changeStates,
  changeCancel,
  states: zrStates,
  services: zrServices,
  async test(c) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, '/territories/search'), { method: 'POST', headers: h(c), json: { keyword: 'alger', pageSize: 1, pageNumber: 1 } });
    return { ok: true, message: `Connexion réussie à ${c.name} (ZR Express).` };
  },
  async create(c, p, helpers) {
    needKeys(c, 'api_key', 'tenant');
    const r = await http(c.name, url(c, '/parcels'), { method: 'POST', headers: h(c), json: await parcelBody(c, p, helpers) });
    const id = r?.id || r?.parcelId;
    if (!id) throw new CourierError('ZR n’a pas renvoyé d’identifiant de colis');
    const tracking = r?.trackingNumber || (await http(c.name, url(c, `/parcels/${id}`), { headers: h(c) })).trackingNumber;
    return { tracking: tracking || String(id), extId: String(id), labelUrl: null };
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
        continue;
      }
      const key = r.state && (r.state.name || r.state.code) ? String(r.state.name || r.state.code) : null;
      if (!key) continue;
      const situation = r.situation && (r.situation.name || r.situation.description);
      const mapped = STATUSES[key];
      out.push({ id: it.id, key, status: (r.state.description || key) + (situation ? ` · ${situation}` : ''), at: r.lastStateUpdateAt ?? null, mapped: r.isReturn && mapped !== 'returned' ? ('returning' as const) : undefined });
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
    const out = [];
    for (const rate of r.rates ?? []) {
      if (rate.toTerritoryLevel && rate.toTerritoryLevel !== 'wilaya') continue;
      const w = Number(rate.toTerritoryCode);
      if (!(w >= 1 && w <= 69)) continue;
      const price = (type: string) => {
        const x = (rate.deliveryPrices ?? []).find((d: any) => d.deliveryType === type);
        return x ? Number(x.priceTtc ?? x.discountedPrice ?? x.price) || null : null;
      };
      out.push({ wilayaId: w, home: price('home'), desk: price('pickup-point'), returnFee: price('return') });
    }
    return out;
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
      const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const exact = bestMatch(i.reasonText, cats.map((x) => x.name));
      const hit = exact ? cats.find((x) => x.name === exact) : (REASON_HINTS[i.reason] ?? []).map((w) => cats.find((x) => norm(x.name).includes(w))).find(Boolean);
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
      status = g?.state?.description || g?.state?.name || null;
    } catch {
      /* the claim exists; its state comes with the next refresh */
    }
    return { extId: String(id), extRef: String(id).slice(0, 8).toUpperCase(), status };
  },
  async claimComment(c, extId, text) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, `/claim-comments/${encodeURIComponent(extId)}`), { method: 'PATCH', headers: h(c), json: { claimId: extId, comment: cut(text, 2000) } });
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
      const name = String(g?.state?.name || '');
      const words = String(g?.state?.description || name);
      if (!words) continue;
      let answer: string | null = null;
      try {
        const cm = await http(c.name, url(c, `/claim-comments/${encodeURIComponent(id)}/search`), { method: 'POST', headers: h(c), json: { claimId: id, pageNumber: 1, pageSize: 100 } });
        const list = ((cm?.items ?? []) as any[]).filter((x) => String(x.content ?? '').trim());
        const last = list.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))).pop();
        answer = last ? `${last.modifiedBy?.fullName ? `${last.modifiedBy.fullName} : ` : ''}${String(last.content).trim()}` : null;
      } catch {
        /* comments are a bonus */
      }
      // a locked state is the end of ZR's workflow (solved / closed)
      out.push({ extId: id, status: words, resolved: !!g?.state?.isLocked || RESOLVED.test(name) || RESOLVED.test(words), at: g?.lastModifiedAt ?? null, answer });
    }
    return out;
  },
  async stopdesks(c) {
    needKeys(c, 'api_key', 'tenant');
    const [hs, ws] = await Promise.all([hubs(c), territories(c, 'wilaya')]);
    const code = new Map(ws.map((w: any) => [w.id, Number(w.code)]));
    return hs
      .filter((x: any) => x.isPickupPoint && x.isVisible !== false)
      .map((x: any): Desk => ({ extId: String(x.id), name: x.name, wilayaId: code.get(x.address?.cityTerritoryId) ?? null, commune: x.address?.district || x.address?.city || null, address: [x.address?.street, x.address?.district, x.address?.city].filter(Boolean).join(', ') || null }));
  },
};
