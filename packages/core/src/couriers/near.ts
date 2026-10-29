// Near Delivery. Auth: headers ApiKey: <api_key> and ApiSecret: <api_secret>. Base https://api.neardelivery.app/api/v1.
// Near delivers ONLY to pickup points (buralistes / centres): the customer collects the parcel there; no home delivery.
// Endpoints (from vargo's NearDelivery driver): POST parcels {parcels:[…]} → {data:[{tracking_number, id|parcel_id}]} (create),
// PATCH parcels/{id} (change), DELETE parcels/{id} (cancel), GET track/{tracking} → {data:{current_status, current_status_value…}},
// GET parcels/{tracking}/status-history/sender → {data:[{current_status:{name, code}, occurred_at, center}]},
// GET sender/parcels/{tracking}/bordereau (label PDF), GET sender/delivery-fees, GET sender/wilayas → {data:[{code, name,
// communes:[{id, code, name}]}]}, GET sender/buralists and sender/centers → {data:[{id, center_name, address, commune_code,
// wilaya_code, phone}]}.
// Create body (per parcel): recipient_name, recipient_phone, recipient_wilaya ("16"), recipient_commune (name), payment_preference
// (0 = COD, 1 = prepaid), pickup_location_type (how WE hand the parcel over: 0 = Near picks it up at pickup_address,
// 1 = we drop it at our sender_center_id), buralist_id (the customer's pickup point = the order's stop desk), items, size S/M/L,
// is_return + return_center_id.
// Settings: pickup_type ('center' default | 'address'), sender_center_id, pickup_address, return_center_id, size.
// BEST GUESS (check with real keys): the cash collected is the sum of the items (unit_price × quantity): we add a
// « Livraison » line so it equals our total; stop desks = sender/buralists (falls back to sender/centers); exchange →
// is_return with return_center_id; the fees answer shape (one wilaya per call, recipient_wilaya filter); status code values.
import { cacheKeyOf } from './types';
import type { CourierAdapter, CourierCompany, Desk, FeeRow, Parcel, ParcelInfo, TrackItem } from './types';
import { baseUrl, CourierError, cut, errText, http, HttpOpts, humanize, needKeys, query, sleep, timeUp } from './util';

// status code (current_status_value) and names (vargo's NearDeliveryParcelStatus)
type Follow = CourierAdapter['statuses'][string];
const CODES: Record<string, { key: string; label: string; follow: Follow }> = {};
const LIST: [number, string, string, Follow][] = [
  [0, 'PENDING', 'En attente', null],
  [1, 'WAITING_FOR_PICKUP', 'En attente de ramassage', null],
  [2, 'PICKED_UP', 'Ramassé', 'shipped'],
  [3, 'ARRIVED_AT_WAREHOUSE', 'Arrivé à l’entrepôt', 'shipped'],
  [5, 'IN_TRANSIT', 'En transit', 'shipped'],
  [6, 'ARRIVED_AT_LAST_CENTER', 'Disponible au point de retrait', 'out_for_delivery'],
  [7, 'DELIVERED', 'Livré', 'delivered'],
  [10, 'RETURN_INITIALIZED', 'Retour lancé', 'returning'],
  [11, 'RETURN_IN_TRANSIT', 'Retour en transit', 'returning'],
  [12, 'RETURN_ARRIVED_AT_WAREHOUSE', 'Retour arrivé à l’entrepôt', 'returning'],
  [13, 'RETURNED_TO_LAST_CENTER', 'Retour arrivé au centre', 'returning'],
  [14, 'RETURN_CONFIRMED', 'Retour confirmé', 'returned'],
  [15, 'RETURN_IN_REGION', 'Retour dans la région', 'returning'],
  [16, 'PICKUP_FROM_SENDER', 'Ramassage chez l’expéditeur', 'shipped'],
];
const STATUSES: CourierAdapter['statuses'] = {};
for (const [code, key, label, follow] of LIST) {
  CODES[String(code)] = { key, label, follow };
  CODES[key] = { key, label, follow };
  STATUSES[String(code)] = follow;
  STATUSES[key] = follow;
  STATUSES[key.toLowerCase()] = follow;
  STATUSES[humanize(key.toLowerCase())] = follow; // "Picked up"
  STATUSES[label] = follow;
}
// vargo's English labels ("Picked Up", "Arrived at Warehouse"…)
const EN: Record<string, string> = {
  'Pending': 'PENDING', 'Waiting for Pickup': 'WAITING_FOR_PICKUP', 'Picked Up': 'PICKED_UP', 'Arrived at Warehouse': 'ARRIVED_AT_WAREHOUSE',
  'In Transit': 'IN_TRANSIT', 'Arrived at Last Center': 'ARRIVED_AT_LAST_CENTER', 'Delivered': 'DELIVERED', 'Return Initialized': 'RETURN_INITIALIZED',
  'Return In Transit': 'RETURN_IN_TRANSIT', 'Return Arrived at Warehouse': 'RETURN_ARRIVED_AT_WAREHOUSE', 'Returned to Last Center': 'RETURNED_TO_LAST_CENTER',
  'Return Confirmed': 'RETURN_CONFIRMED', 'Return In Region': 'RETURN_IN_REGION', 'Pickup From Sender': 'PICKUP_FROM_SENDER',
};
for (const [en, key] of Object.entries(EN)) {
  CODES[en] = CODES[key];
  STATUSES[en] = CODES[key].follow;
}

/** The courier's status of a parcel or history line → {key, words}. */
function statusOf(value: unknown, name: unknown): { key: string; status: string } | null {
  const raw = [value, name].map((x) => (x == null ? '' : typeof x === 'object' ? '' : String(x).trim())).filter(Boolean);
  for (const r of raw) {
    const k = CODES[r] ?? CODES[r.toUpperCase().replace(/[\s-]+/g, '_')];
    if (k) return { key: k.key, status: k.label };
  }
  return raw.length ? { key: raw[0], status: humanize(raw[raw.length - 1]) } : null;
}

const url = (c: CourierCompany, path: string) => baseUrl(c, 'https://api.neardelivery.app/api/v1') + '/' + path.replace(/^\/+/, '');
const headers = (c: CourierCompany) => ({ ApiKey: String(c.secret.api_key ?? '').trim(), ApiSecret: String(c.secret.api_secret ?? '').trim() });
const keys = (c: CourierCompany) => needKeys(c, 'api_key', 'api_secret');

async function api(c: CourierCompany, path: string, o: HttpOpts & { q?: Record<string, unknown> } = {}) {
  const { q, ...rest } = o;
  const qs = q ? query(q) : '';
  const r = await http(c.name, url(c, path) + (qs ? `?${qs}` : ''), { ...rest, headers: headers(c) });
  await sleep(300);
  if (!o.binary && r && r.status === false) throw new CourierError(`${c.name} : ${errText(r.message || r.errors) || 'refusé'}`);
  return r;
}
const dataOf = (r: any) => (r && typeof r === 'object' && 'data' in r ? r.data : r);
const listOf = (r: any): any[] => {
  const d = dataOf(r);
  return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.items) ? d.items : [];
};

// ---------------------------------------------------------------- wilayas and communes (cached per company)
const cache = new Map<string, { at: number; v: any }>();
async function wilayas(c: CourierCompany): Promise<any[]> {
  const key = `near:${cacheKeyOf(c)}:wilayas`;
  const x = cache.get(key);
  if (x && Date.now() - x.at < 6 * 3600_000) return x.v;
  const v = listOf(await api(c, 'sender/wilayas'));
  cache.set(key, { at: Date.now(), v });
  return v;
}
const wcode = (w: number) => String(w).padStart(2, '0');
const wilayaOf = (v: unknown) => {
  const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10);
  return n >= 1 && n <= 69 ? n : null;
};
async function communes(c: CourierCompany, w: number) {
  const wl = (await wilayas(c)).find((x: any) => wilayaOf(x?.code ?? x?.id) === w);
  return ((wl?.communes ?? []) as any[]).filter((x) => x?.name).map((x) => ({ name: String(x.name), id: String(x.id ?? x.code ?? '') }));
}

/** Items whose total (unit_price × quantity) is the amount to collect. */
function itemsFor(p: Parcel, total: number) {
  const items = p.items
    .filter((i) => i.qty > 0)
    .map((i) => ({ name: cut(i.name, 255) || 'Produit', quantity: i.qty, unit_price: Math.max(0, Math.round(i.price)) }));
  const sum = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  const diff = Math.round(total) - sum;
  // Near takes at most 100 of an item; a discount (total below the items) cannot be shown item by item: one line
  if (!items.length || diff < 0 || items.some((i) => i.quantity > 100)) {
    return [{ name: cut(p.products, 255) || 'Colis', quantity: 1, unit_price: Math.max(0, Math.round(total)) }];
  }
  if (diff > 0) items.push({ name: 'Livraison', quantity: 1, unit_price: diff });
  return items;
}

/** Near's own parcel id: kept at sending, else read from its tracking. */
async function trackInfo(c: CourierCompany, tracking: string) {
  const d = dataOf(await api(c, `track/${encodeURIComponent(tracking)}`));
  const x = Array.isArray(d) ? d[0] : d;
  if (!x || typeof x !== 'object') throw new CourierError(`Colis ${tracking} introuvable chez ${c.name}`);
  return x;
}
async function parcelId(c: CourierCompany, it: TrackItem) {
  if (it.extId) return it.extId;
  const x = await trackInfo(c, it.tracking);
  const id = x.parcel_id ?? x.id;
  if (id == null) throw new CourierError(`Colis ${it.tracking} introuvable chez ${c.name}`);
  return String(id);
}
const numInt = (v: unknown) => {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
/** status code ≤ 1 (pending / waiting for pickup): not with Near yet, it can still be changed */
const early = (x: any) => {
  const s = statusOf(x?.current_status_value, x?.current_status);
  return !!s && ['PENDING', 'WAITING_FOR_PICKUP'].includes(s.key);
};

export const near: CourierAdapter = {
  statuses: STATUSES,
  async test(c) {
    keys(c);
    const n = (await wilayas(c)).length;
    return { ok: true, message: `Connexion réussie à ${c.name}${n ? ` (${n} wilayas)` : ''}.` };
  },
  async create(c, p, helpers) {
    keys(c);
    if (!p.is_stopdesk) throw new CourierError(`${c.name} livre uniquement en point de retrait (stop desk) : pas de livraison à domicile. Choisissez un point de retrait ${c.name} pour cette commande.`);
    const buralist = numInt(p.stopdesk_ext_id);
    if (!buralist) throw new CourierError(`Choisissez le point de retrait ${c.name} (stop desk) de la commande`);
    const w = p.stopdesk_wilaya_id || p.wilaya_id;
    const com = await helpers.communeName({ ...p, wilaya_id: w, commune: p.stopdesk_commune || p.commune }, (x) => communes(c, x), `near:${cacheKeyOf(c)}`);
    if (!com) throw new CourierError(`Commune « ${p.stopdesk_commune || p.commune} » introuvable chez ${c.name} : corrigez la commune`);
    const byAddress = String(c.settings.pickup_type || 'center') === 'address';
    const senderCenter = numInt(c.settings.sender_center_id);
    const pickupAddress = String(c.settings.pickup_address || '').trim();
    if (byAddress && !pickupAddress) throw new CourierError(`Mettez l’adresse de ramassage ${c.name} dans Sociétés de livraison`);
    const returnCenter = numInt(c.settings.return_center_id);
    if (p.is_exchange && !returnCenter) throw new CourierError(`Échange chez ${c.name} : mettez le centre de retour (return_center_id) dans Sociétés de livraison`);
    const size = ['S', 'M', 'L'].includes(String(c.settings.size || '').toUpperCase()) ? String(c.settings.size).toUpperCase() : 'S';
    const parcel: Record<string, unknown> = {
      recipient_name: cut(p.customer_name || 'Client', 255),
      recipient_phone: cut(p.phone, 20),
      recipient_wilaya: wcode(w),
      recipient_commune: com.name,
      payment_preference: p.total > 0 ? 0 : 1,
      pickup_location_type: byAddress ? 0 : 1,
      buralist_id: buralist,
      ...(senderCenter ? { sender_center_id: senderCenter } : {}),
      ...(byAddress ? { pickup_address: cut(pickupAddress, 500) } : {}),
      recipient_address: cut([p.address, p.delivery_note].filter(Boolean).join(' · '), 500) || undefined,
      reference: cut(p.ref, 100),
      ...(p.is_exchange ? { is_return: true, return_center_id: returnCenter } : {}),
      size,
      items: itemsFor(p, p.total),
    };
    const r = await api(c, 'parcels', { method: 'POST', json: { parcels: [parcel] } });
    const d = dataOf(r);
    const x = Array.isArray(d) ? d[0] : Array.isArray(d?.parcels) ? d.parcels[0] : d;
    const tracking = x?.tracking_number;
    if (!tracking) throw new CourierError(`${c.name} : pas de numéro de suivi (${errText(r?.errors ?? r?.failures ?? r) || 'refusé'})`);
    const id = x.parcel_id ?? x.id;
    return { tracking: String(tracking), extId: id != null ? String(id) : null, labelUrl: null };
  },
  // Near has no batch tracking: one call per parcel
  async track(c, items) {
    keys(c);
    const out = [];
    for (const it of items) {
      if (timeUp()) break;
      try {
        const x = await trackInfo(c, it.tracking);
        const s = statusOf(x.current_status_value, x.current_status);
        if (s) out.push({ id: it.id, key: s.key, status: s.status, at: x.updated_at ?? x.status_updated_at ?? null });
      } catch (e: any) {
        if (e?.status === 429 || String(e?.message).includes('refuse les clés')) throw e;
        out.push({ id: it.id, status: '', error: String(e?.message || 'erreur') });
      }
    }
    return out;
  },
  async parcel(c, it): Promise<ParcelInfo> {
    keys(c);
    const x = await trackInfo(c, it.tracking);
    const hist = await api(c, `parcels/${encodeURIComponent(it.tracking)}/status-history/sender`).catch((e) => (String(e?.message).includes('refuse les clés') ? Promise.reject(e) : null));
    const s = statusOf(x.current_status_value, x.current_status);
    const rc = x.recipient && typeof x.recipient === 'object' ? x.recipient : {};
    const bur = x.buralist ?? x.pickup_point ?? x.center ?? null;
    const n = (v: unknown) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
    const open = early(x);
    return {
      state: s?.status ?? null,
      color: null,
      situation: null,
      livreur: null,
      risk: null,
      canModify: open,
      canChangePhone: open,
      direct: open,
      pendingChange: false,
      modifications: null,
      modificationLimit: null,
      phoneChanges: null,
      phoneChangeLimit: null,
      phoneChangePrice: null,
      delivery: {
        type: 'pickup-point',
        hub: (bur && typeof bur === 'object' ? bur.center_name ?? bur.name : null) ?? null,
        city: rc.wilaya != null ? String(rc.wilaya) : x.recipient_wilaya ?? null,
        district: rc.commune ?? x.recipient_commune ?? null,
        street: rc.address ?? x.recipient_address ?? null,
      },
      amount: n(x.parcel_fees ?? x.cod_amount),
      deliveryPrice: n(x.delivery_fees),
      returnPrice: n(x.return_fees),
      swap: null,
      history: listOf(hist)
        .map((h: any) => {
          const cs = h.current_status && typeof h.current_status === 'object' ? h.current_status : {};
          const st = statusOf(cs.code, cs.name ?? h.current_status);
          const ctr = h.center && typeof h.center === 'object' ? h.center : {};
          return {
            at: String(h.occurred_at ?? h.created_at ?? ''),
            status: st?.status ?? '',
            color: null,
            hub: ctr.center_name ?? ctr.address ?? null,
            by: h.user?.name ?? h.created_by ?? null,
            comment: h.comment ?? h.note ?? null,
            situations: [],
          };
        })
        .filter((h) => h.at && h.status)
        .sort((a, b) => b.at.localeCompare(a.at)),
      sms: [],
    };
  },
  // direct update of a parcel not picked up yet (PATCH parcels/{id})
  async change(c, i, helpers, p) {
    keys(c);
    const id = await parcelId(c, i.item);
    const body: Record<string, unknown> = {};
    if (i.kind === 'phone') {
      if (!i.phone) throw new CourierError('Nouveau numéro manquant');
      body.recipient_phone = cut(i.phone, 20);
    } else if (i.kind === 'amount') {
      if (i.amount == null || !(i.amount >= 0)) throw new CourierError('Nouveau montant manquant');
      body.items = p ? itemsFor(p, i.amount) : [{ name: 'Colis', quantity: 1, unit_price: Math.round(i.amount) }];
      body.payment_preference = i.amount > 0 ? 0 : 1;
    } else if (i.kind === 'address') {
      if (i.address) body.recipient_address = cut(i.address, 500);
      if (i.wilayaId && p) {
        const com = await helpers.communeName({ ...p, wilaya_id: i.wilayaId, commune: i.commune || p.commune }, (x) => communes(c, x), `near:${cacheKeyOf(c)}`);
        if (!com) throw new CourierError(`Commune « ${i.commune || p.commune} » introuvable chez ${c.name}`);
        body.recipient_wilaya = wcode(i.wilayaId);
        body.recipient_commune = com.name;
      }
      if (!Object.keys(body).length) throw new CourierError('Nouvelle adresse manquante');
    } else if (i.kind === 'delivery') {
      if (i.stopdesk === false) throw new CourierError(`${c.name} livre uniquement en point de retrait : pas de livraison à domicile`);
      const bur = numInt(i.hubExtId);
      if (!bur) throw new CourierError(`Choisissez le nouveau point de retrait ${c.name}`);
      body.buralist_id = bur;
      if (i.wilayaId) {
        body.recipient_wilaya = wcode(i.wilayaId);
        if (p) {
          const com = await helpers.communeName({ ...p, wilaya_id: i.wilayaId, commune: i.commune || p.stopdesk_commune || p.commune }, (x) => communes(c, x), `near:${cacheKeyOf(c)}`);
          if (com) body.recipient_commune = com.name;
        }
      }
    } else {
      throw new CourierError(`${c.name} ne permet pas cette modification par l’API`);
    }
    try {
      await api(c, `parcels/${encodeURIComponent(id)}`, { method: 'PATCH', json: body });
    } catch (e: any) {
      if (e?.status === 429 || String(e?.message).includes('refuse les clés')) throw e;
      throw new CourierError(`${c.name} refuse la modification (colis déjà pris en charge ?) : ${String(e?.message || '').replace(`${c.name} : `, '')}`);
    }
    return { extId: i.item.tracking, approved: true, direct: true };
  },
  async cancel(c, it) {
    keys(c);
    const id = await parcelId(c, it);
    try {
      await api(c, `parcels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e: any) {
      if (e?.status === 429 || String(e?.message).includes('refuse les clés')) throw e;
      throw new CourierError(`${c.name} refuse l’annulation (colis déjà pris en charge ?) : ${String(e?.message || '').replace(`${c.name} : `, '')}`);
    }
  },
  async label(c, it) {
    keys(c);
    return api(c, `sender/parcels/${encodeURIComponent(it.tracking)}/bordereau`, { binary: true });
  },
  // stop desk only: home is always null
  async fees(c): Promise<FeeRow[]> {
    keys(c);
    const row = (x: any, w: number | null): FeeRow | null => {
      const wid = wilayaOf(x?.recipient_wilaya ?? x?.wilaya_code ?? x?.wilaya) ?? w;
      const desk = Number(x?.stop_desk_fee ?? x?.delivery_fee ?? x?.fee ?? x?.price);
      return wid && desk ? { wilayaId: wid, home: null, desk, returnFee: Number(x?.return_fee) || null } : null;
    };
    const first = dataOf(await api(c, 'sender/delivery-fees'));
    if (Array.isArray(first)) return first.map((x) => row(x, null)).filter((x): x is FeeRow => !!x);
    // one wilaya per answer: ask for each wilaya
    const out: FeeRow[] = [];
    for (const wl of await wilayas(c)) {
      if (timeUp()) break;
      const w = wilayaOf(wl?.code ?? wl?.id);
      if (!w) continue;
      try {
        const r = row(dataOf(await api(c, 'sender/delivery-fees', { q: { recipient_wilaya: wcode(w) } })), w);
        if (r) out.push(r);
      } catch (e: any) {
        if (e?.status === 429 || String(e?.message).includes('refuse les clés')) throw e;
      }
    }
    if (!out.length) throw new CourierError(`Import des tarifs non disponible chez ${c.name} : remplissez-les à la main`);
    return out;
  },
  // the customer's pickup points (buralistes); the centres when Near gives no buralistes
  async stopdesks(c): Promise<Desk[]> {
    keys(c);
    let list: any[] = [];
    try {
      list = listOf(await api(c, 'sender/buralists'));
    } catch (e: any) {
      if (e?.status === 429 || String(e?.message).includes('refuse les clés')) throw e;
    }
    if (!list.length) list = listOf(await api(c, 'sender/centers'));
    const all = await wilayas(c).catch(() => [] as any[]);
    const comName = (w: number | null, code: unknown) => {
      if (code == null || code === '') return null;
      const wl = all.find((x: any) => wilayaOf(x?.code ?? x?.id) === w);
      const cm = ((wl?.communes ?? []) as any[]).find((x) => String(x.code) === String(code) || String(x.id) === String(code));
      return cm?.name ?? String(code);
    };
    return list
      .filter((d: any) => d?.id != null)
      .map((d: any) => {
        const w = wilayaOf(d.wilaya_code ?? d.wilaya);
        return { extId: String(d.id), name: String(d.center_name || d.name || d.id), wilayaId: w, commune: d.commune_name ?? comName(w, d.commune_code), address: d.address ?? null };
      });
  },
};
