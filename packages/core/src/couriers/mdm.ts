// MDM Express. Auth: header x-api-key: <api_key> (+ Authorization: Bearer <token> when a token is given); the store id
// (storeId) goes in every request (body for POST, query for GET), as vargo's MdmDriver does. Base https://api.mdm.express.
// Endpoints (from vargo's Mdm driver): GET /api/auth/me (test), POST /api/v2/orders (create → {trackingId}),
// POST /api/v2/orders/search {filters:{trackingId:[…]}, pagination} → {list:[…]} (track), GET /api/v2/orders/{tracking} and
// /api/v2/orders/{tracking}/status-history → {list:[{status, notes, date}]} (parcel), POST /api/prints/parcel-slips
// {parcelIds, format} → {fileId} then GET /api/prints/files/{fileId} (label PDF), GET /api/geo/countries?search=Algeria,
// GET /api/geo/cities?countryId[]=DZA&stateId[]=DZA16 (communes), GET /api/v2/shipping/companies/offices (stop desks).
// MDM has no update / cancel / fees API in vargo (vargo's prices are a static table, not an API): not implemented.
// BEST GUESS (check with real keys): totalPrice = the amount the customer pays (our total) with freeShipping from the
// "free_shipping" setting; the city id sent is the "id" of /api/geo/cities; status words are lower-case (pending…returned);
// the order fields read back (client, destination.cityName/stateName, isStopDesk, stopDesk, deliveryPrice).
import { cacheKeyOf } from './types';
import type { CourierAdapter, CourierCompany, Desk, ParcelInfo, TrackItem } from './types';
import { baseUrl, chunks, CourierError, cut, errText, flag, http, HttpOpts, humanize, needKeys, query, sleep, splitName, timeUp } from './util';

const STATUSES: CourierAdapter['statuses'] = {
  pending: null, confirmed: null, shipped: 'shipped', delivered: 'delivered', cancelled: null, returned: 'returned', expired: null, archived: null,
  PENDING: null, CONFIRMED: null, SHIPPED: 'shipped', DELIVERED: 'delivered', CANCELLED: null, RETURNED: 'returned', EXPIRED: null, ARCHIVED: null,
};
const WORDS: Record<string, string> = {
  pending: 'En attente', confirmed: 'Confirmée', shipped: 'Expédiée', delivered: 'Livrée', cancelled: 'Annulée', returned: 'Retournée', expired: 'Expirée', archived: 'Archivée',
};
const word = (s: unknown) => (s == null || s === '' ? null : WORDS[String(s).toLowerCase()] ?? humanize(String(s)));

const storeId = (c: CourierCompany) => String(c.secret.store_id || c.settings.store_id || '').trim();
const headers = (c: CourierCompany) => {
  const h: Record<string, string> = { 'x-api-key': String(c.secret.api_key ?? '').trim() };
  const t = String(c.secret.token ?? '').trim();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
};
const keys = (c: CourierCompany) => {
  needKeys(c, 'api_key');
  if (!storeId(c)) throw new CourierError(`Mettez le Store ID de ${c.name} dans Sociétés de livraison`);
};

/** GET with query (storeId added) or POST with JSON body (storeId added). `q` may hold arrays: key[0]=v. */
async function api(c: CourierCompany, path: string, o: { q?: Record<string, unknown>; json?: Record<string, unknown> } & HttpOpts = {}) {
  const { q, json, ...rest } = o;
  const flat: Record<string, unknown> = { storeId: storeId(c) || undefined };
  for (const [k, v] of Object.entries(q ?? {})) {
    if (Array.isArray(v)) v.forEach((x, i) => (flat[`${k}[${i}]`] = x));
    else flat[k] = v;
  }
  const qs = json ? '' : query(flat);
  const r = await http(c.name, baseUrl(c, 'https://api.mdm.express') + path + (qs ? `?${qs}` : ''), {
    ...rest,
    headers: headers(c),
    ...(json ? { json: { storeId: storeId(c) || undefined, ...json } } : {}),
  });
  await sleep(300);
  return r;
}
const listOf = (r: any): any[] => (Array.isArray(r) ? r : Array.isArray(r?.list) ? r.list : Array.isArray(r?.data) ? r.data : Array.isArray(r?.items) ? r.items : []);

// ---------------------------------------------------------------- places (country id, cities), cached per company
const cache = new Map<string, { at: number; v: any }>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const x = cache.get(key);
  if (x && Date.now() - x.at < 6 * 3600_000) return x.v;
  const v = await load();
  cache.set(key, { at: Date.now(), v });
  return v;
}
const countryId = (c: CourierCompany) =>
  cached(`mdm:${cacheKeyOf(c)}:country`, async () => {
    try {
      const r = listOf(await api(c, '/api/geo/countries', { q: { search: 'Algeria' } }));
      return String(r.find((x: any) => x?.iso2 === 'DZ')?.id ?? 'DZA');
    } catch {
      return 'DZA';
    }
  });
const stateKey = (country: string, w: number) => `${country}${String(w).padStart(2, '0')}`;
const wilayaOf = (v: unknown) => {
  const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10);
  return n >= 1 && n <= 69 ? n : null;
};
async function cities(c: CourierCompany, w: number): Promise<{ id: string; name: string }[]> {
  const country = await countryId(c);
  return cached(`mdm:${cacheKeyOf(c)}:cities:${w}`, async () => {
    const r = listOf(await api(c, '/api/geo/cities', { q: { countryId: [country], stateId: [stateKey(country, w)], perPage: 1000 } }));
    return r
      .filter((x: any) => x?.id != null && x?.name && (!x.stateId || wilayaOf(x.stateCode ?? x.stateId) === w))
      .map((x: any) => ({ id: String(x.id), name: String(x.name) }));
  });
}

async function order(c: CourierCompany, it: TrackItem) {
  const r = await api(c, `/api/v2/orders/${encodeURIComponent(it.tracking)}`);
  const o = r?.trackingId || r?.status ? r : r?.data ?? r;
  if (!o || (!o.trackingId && !o.status)) throw new CourierError(`Colis ${it.tracking} introuvable chez ${c.name}`);
  return o;
}

async function slips(c: CourierCompany, trackings: string[]) {
  const fmt = String(c.settings.label_format || '').toUpperCase();
  const r = await api(c, '/api/prints/parcel-slips', { method: 'POST', json: { parcelIds: trackings, ...(['A4', 'A5', 'A6'].includes(fmt) ? { format: fmt } : {}) } });
  const fileId = r?.fileId ?? r?.data?.fileId;
  if (!fileId) throw new CourierError(`${c.name} : bordereau non généré (${errText(r) || 'pas de fichier'})`);
  return http(c.name, baseUrl(c, 'https://api.mdm.express') + `/api/prints/files/${encodeURIComponent(String(fileId))}`, { headers: headers(c), binary: true });
}

export const mdm: CourierAdapter = {
  statuses: STATUSES,
  async test(c) {
    keys(c);
    const r = await api(c, '/api/auth/me');
    const who = r?.email || r?.name || r?.firstName || r?.user?.email;
    return { ok: true, message: `Connexion réussie à ${c.name}${who ? ` (${who})` : ''}.` };
  },
  async create(c, p, helpers) {
    keys(c);
    if (p.is_stopdesk && !p.stopdesk_ext_id) throw new CourierError(`Choisissez le bureau ${c.name} (stop desk) de la commande`);
    const city = await helpers.communeName(p, (w) => cities(c, w), `mdm:${cacheKeyOf(c)}`);
    if (!city) throw new CourierError(`Commune « ${p.commune} » introuvable chez ${c.name} : corrigez la commune`);
    const { first, last } = splitName(p.customer_name || 'Client');
    const products = p.items.length
      ? p.items.map((i) => ({ trackingId: '', quantity: Math.max(1, i.qty), price: Math.round(i.price), displayName: cut(i.name, 255) || 'Produit' }))
      : [{ trackingId: '', quantity: 1, price: Math.round(p.subtotal || p.total), displayName: cut(p.products, 255) || 'Produit' }];
    const body: Record<string, unknown> = {
      totalPrice: Math.round(p.total),
      notes: cut([p.ref, p.delivery_note].filter(Boolean).join(' · '), 500) || undefined,
      client: { firstName: cut(first, 100), lastName: cut(last, 100), phone: cut(p.phone, 20), phone2: p.phone2 ? cut(p.phone2, 20) : null },
      destination: { cityId: city.id, streetAddress: cut(p.address || p.commune || '-', 255) },
      products,
      freeShipping: flag(c, 'free_shipping', false),
      isStopDesk: p.is_stopdesk,
      stopDeskId: p.is_stopdesk ? String(p.stopdesk_ext_id) : undefined,
      weight: Math.max(1, Math.round(p.weight || 1)),
      fragile: flag(c, 'fragile', false) || undefined,
      openable: flag(c, 'can_open', false) || undefined,
    };
    const r = await api(c, '/api/v2/orders', { method: 'POST', json: body });
    const tracking = r?.trackingId ?? r?.data?.trackingId;
    if (!tracking) throw new CourierError(`${c.name} : pas de numéro de suivi (${errText(r)})`);
    return { tracking: String(tracking), extId: r?.id != null ? String(r.id) : null, labelUrl: null };
  },
  async track(c, items) {
    keys(c);
    const out = [];
    for (const group of chunks(items, 100)) {
      if (timeUp()) break;
      const r = await api(c, '/api/v2/orders/search', {
        method: 'POST',
        json: { filters: { trackingId: group.map((g) => g.tracking) }, pagination: { page: 1, perPage: 100 } },
      });
      const byTracking = new Map(listOf(r).map((x: any) => [String(x?.trackingId ?? ''), x]));
      for (const it of group) {
        const x = byTracking.get(it.tracking);
        if (!x?.status) continue;
        out.push({ id: it.id, key: String(x.status), status: word(x.status) ?? String(x.status), at: x.statusDate ?? x.updatedAt ?? null });
      }
    }
    return out;
  },
  async parcel(c, it): Promise<ParcelInfo> {
    keys(c);
    const o = await order(c, it);
    const hist = await api(c, `/api/v2/orders/${encodeURIComponent(it.tracking)}/status-history`).catch(() => null);
    const d = o.destination ?? {};
    const n = (v: unknown) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
    return {
      state: word(o.status),
      color: null,
      situation: null,
      livreur: null,
      risk: null,
      // MDM has no update API (in vargo): nothing can be changed from Pilotix
      canModify: false,
      canChangePhone: false,
      pendingChange: false,
      modifications: null,
      modificationLimit: null,
      phoneChanges: null,
      phoneChangeLimit: null,
      phoneChangePrice: null,
      delivery: {
        type: o.isStopDesk ? 'pickup-point' : 'home',
        hub: o.isStopDesk ? o.stopDesk?.name ?? o.stopDeskName ?? (o.stopDeskId ? String(o.stopDeskId) : null) : null,
        city: d.stateName ?? null,
        district: d.cityName ?? null,
        street: d.streetAddress ?? null,
      },
      amount: n(o.totalPrice),
      deliveryPrice: n(o.deliveryPrice),
      returnPrice: n(o.returnPrice),
      swap: null,
      history: listOf(hist)
        .map((x: any) => ({
          at: String(x.date ?? x.createdAt ?? ''),
          status: word(x.status) ?? '',
          color: null,
          hub: null,
          by: x.createdBy?.name ?? x.user?.name ?? null,
          comment: x.notes ?? null,
          situations: [],
        }))
        .filter((x) => x.at && x.status)
        .sort((x, y) => y.at.localeCompare(x.at)),
      sms: [],
    };
  },
  async label(c, it) {
    keys(c);
    return slips(c, [it.tracking]);
  },
  async labels(c, items) {
    keys(c);
    return { label: await slips(c, items.map((i) => i.tracking)), failed: [] };
  },
  async stopdesks(c): Promise<Desk[]> {
    keys(c);
    const country = await countryId(c);
    const r = listOf(await api(c, '/api/v2/shipping/companies/offices', { q: { countryId: country } }));
    return r
      .filter((o: any) => o?.id != null)
      .map((o: any) => {
        const a = typeof o.address === 'object' && o.address ? o.address : {};
        return {
          extId: String(o.id),
          name: String(o.name || o.id),
          wilayaId: wilayaOf(a.stateId ?? o.stateId ?? o.state),
          commune: a.cityName ?? o.cityName ?? null,
          address: (typeof o.address === 'string' ? o.address : a.streetAddress) || null,
        };
      });
  },
};
