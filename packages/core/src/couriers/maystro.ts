// Maystro Delivery. Auth: Authorization: Token <token> (a token already starting with "Token " / "Bearer " is sent as is).
// Base https://backend.maystro-delivery.com/api (b.maystro-delivery.com is the same server).
// CHECKED from the internet (Oct 2026, made-up token: 401 = the address exists, 404 = it does not): stores/orders/,
// stores/orders/{id}/ (GET, PATCH), stores/history_order/{id}/, delivery/starter/starter_bordureau/, base/wilayas/,
// stores/hooks/costume/, stores/hooks/types/ exist. vargo's paths (orders/, orders/history_order/, starter_bordureau/,
// stock/products, base/communes/, base/delivery-prices/) do NOT exist: not used.
// Endpoints: GET base/wilayas/?country=1 (test), GET base/wilayas/{wilaya}/ (its communes), POST stores/orders/,
// GET stores/orders/{id}/, GET stores/history_order/{id}/, PATCH stores/orders/{id}/ (amount / phone / address, and
// status 50 = cancel), POST delivery/starter/starter_bordureau/ {orders_ids} (PDF labels), webhooks: GET stores/hooks/types/,
// GET|POST stores/hooks/costume/, DELETE stores/hooks/costume/{id}/.
// Maystro works with numeric ids: wilaya = our wilaya code, commune = Maystro's commune id (found by name).
// The order's Maystro id (extId) is used for every call; the tracking shown is its display_id.
// No stop desk list API: a stop desk order is sent as delivery_type 2 to the commune. No delivery prices API found.
// BEST GUESS (check with real keys): the communes come in base/wilayas/{id}/ (« communes » list); cancel = PATCH status 50;
// products[].product_id = our SKU (or the product name); the "all" webhook type is found by its name in stores/hooks/types/;
// the shape of the history and hook lists; which statuses can still be changed (4–15); delivery_type 1 = home, 2 = stop desk.
import { cacheKeyOf } from './types';
import type { ChangeInput, CourierAdapter, CourierCompany, Helpers, Parcel, ParcelInfo, TrackItem, TrackResult } from './types';
import { baseUrl, bestMatch, CourierError, cut, http, HttpOpts, needKeys, query, sleep, timeUp } from './util';

const LABELS: Record<string, string> = {
  '4': 'Créé', '5': 'Ramassage demandé', '6': 'En traitement', '8': 'En attente de transit', '9': 'En transit pour expédition',
  '10': 'En transit pour retour', '11': 'En attente', '12': 'Rupture de stock', '15': 'Prêt à expédier', '22': 'Assigné',
  '31': 'Expédié', '32': 'Alerté', '41': 'Livré', '42': 'Reporté', '50': 'Annulé', '51': 'Prêt à retourner',
  '52': 'Récupéré par le magasin', '53': 'Non reçu',
};

const STATUSES: CourierAdapter['statuses'] = {
  '4': null, '5': null, '6': null, '8': null, '11': null, '12': null, '15': null,
  '9': 'shipped', '22': 'shipped', '31': 'out_for_delivery', '32': 'alert', '41': 'delivered', '42': 'failed',
  // 50 « Annulé »: before pickup it is a cancel (no change); after pickup the track() below says 'returning'
  '50': null, '10': 'returning', '51': 'returning', '52': 'returned', '53': 'alert',
  Créé: null, 'Ramassage demandé': null, 'En traitement': null, 'En attente de transit': null, 'En attente': null, 'Rupture de stock': null,
  'Prêt à expédier': null, 'En transit pour expédition': 'shipped', Assigné: 'shipped', Expédié: 'out_for_delivery', Alerté: 'alert',
  Livré: 'delivered', Reporté: 'failed', Annulé: null, 'En transit pour retour': 'returning', 'Prêt à retourner': 'returning',
  'Récupéré par le magasin': 'returned', 'Non reçu': 'alert',
};
/** statuses of a parcel not handed to the delivery yet: it can still be changed / cancelled */
const BEFORE_PICKUP = new Set(['4', '5', '6', '8', '11', '12', '15']);
/** statuses after the parcel left: an « Annulé » after one of these is a return */
const LEFT = new Set(['9', '22', '31', '32', '42']);

const DEFAULT = 'https://backend.maystro-delivery.com/api';
const auth = (c: CourierCompany) => {
  const t = String(c.secret.token ?? '').trim();
  return { Authorization: /^(token|bearer)\s/i.test(t) ? t : `Token ${t}` };
};
const listOf = (r: any): any[] => (Array.isArray(r) ? r : Array.isArray(r?.results) ? r.results : Array.isArray(r?.list?.results) ? r.list.results : Array.isArray(r?.data) ? r.data : []);
const num = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

async function api(c: CourierCompany, path: string, o: HttpOpts & { q?: Record<string, unknown> } = {}) {
  needKeys(c, 'token');
  const qs = o.q ? query(o.q) : '';
  const r = await http(c.name, baseUrl(c, DEFAULT) + '/' + path.replace(/^\//, '') + (qs ? `?${qs}` : ''), { ...o, headers: { ...auth(c), ...(o.headers ?? {}) } });
  await sleep(300);
  return r;
}
const oid = (it: TrackItem) => encodeURIComponent(it.extId || it.tracking);

// ---------------------------------------------------------------- wilayas, communes
const cache = new Map<string, any[]>();
async function communes(c: CourierCompany, wilayaId: number | null): Promise<{ name: string; id: number; wilaya: number }[]> {
  const key = `${cacheKeyOf(c)}:c${wilayaId ?? 'all'}`;
  if (cache.has(key)) return cache.get(key)!;
  // the wilaya's own page lists its communes (no communes address exists at Maystro)
  const r = wilayaId ? await api(c, `base/wilayas/${wilayaId}/`, { q: { country: 1, language: 'fr' } }) : null;
  const raw: any[] = Array.isArray(r) ? r : Array.isArray(r?.communes) ? r.communes : Array.isArray(r?.data?.communes) ? r.data.communes : listOf(r);
  const list = raw
    .filter((x: any) => x && x.id != null && (!wilayaId || x.wilaya == null || Number(x.wilaya) === wilayaId))
    .map((x: any) => ({ name: String(x.name ?? ''), id: Number(x.id), wilaya: Number(x.wilaya ?? wilayaId) }));
  cache.set(key, list);
  return list;
}
async function wilayas(c: CourierCompany) {
  const key = `${cacheKeyOf(c)}:w`;
  if (cache.has(key)) return cache.get(key)!;
  const r = await api(c, 'base/wilayas/', { q: { country: 1, language: 'fr' } });
  const list = listOf(r)
    .map((x) => (Array.isArray(x) ? { id: Number(x[0]), name: String(x[1] ?? '') } : { id: Number(x?.id), name: String(x?.name ?? '') }))
    .filter((x) => x.id >= 1);
  cache.set(key, list);
  return list;
}
async function communeOf(c: CourierCompany, p: Parcel, h: Helpers) {
  const com = await h.communeName(p, (w) => communes(c, w), `maystro:${cacheKeyOf(c)}`);
  if (!com) throw new CourierError(`Commune « ${p.commune || p.stopdesk_commune || '?'} » introuvable chez ${c.name} : corrigez la commune`);
  return com;
}

// ---------------------------------------------------------------- one parcel
async function order(c: CourierCompany, it: TrackItem) {
  return api(c, `stores/orders/${oid(it)}/`);
}
async function history(c: CourierCompany, it: TrackItem) {
  const r = await api(c, `stores/history_order/${oid(it)}/`);
  return listOf(r)
    .filter((x) => x && x.status != null)
    .map((x) => ({ key: String(x.status), at: String(x.created_at ?? x.date ?? ''), by: x.user?.name ?? x.created_by ?? x.user ?? null, comment: x.comment ?? x.note ?? x.abort_reason_text ?? null }))
    .sort((a, b) => a.at.localeCompare(b.at));
}
const word = (k: string) => LABELS[k] ?? `Statut ${k}`;

async function parcelInfo(c: CourierCompany, it: TrackItem): Promise<ParcelInfo> {
  const o = await order(c, it);
  const hist = await history(c, it).catch((e) => (String(e?.message).includes('refuse les clés') ? Promise.reject(e) : []));
  const key = String(o?.status ?? hist.at(-1)?.key ?? '');
  const open = BEFORE_PICKUP.has(key);
  const desk = Number(o?.delivery_type) === 2;
  return {
    state: key ? word(key) : null,
    color: null,
    situation: o?.abort_reason_text ?? o?.alert_reason ?? null,
    livreur: o?.deliveryman_name || o?.driver_name ? { name: String(o.deliveryman_name || o.driver_name), phone: o.deliveryman_phone ?? o.driver_phone ?? null, hub: null } : null,
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
    delivery: { type: desk ? 'Stop desk' : 'Domicile', hub: null, city: o?.wilaya_name ?? (typeof o?.wilaya === 'string' ? o.wilaya : null), district: o?.commune_name ?? null, street: o?.destination_text ?? null },
    amount: num(o?.product_price),
    deliveryPrice: num(o?.price ?? o?.delivery_price),
    returnPrice: null,
    swap: null,
    history: hist
      .filter((x) => x.at)
      .map((x) => ({ at: x.at, status: word(x.key), color: null, hub: null, by: x.by ? String(x.by) : null, comment: x.comment ? String(x.comment) : null, situations: [] }))
      .reverse(),
    sms: [],
  };
}

async function change(c: CourierCompany, i: ChangeInput, h: Helpers, p: Parcel | null) {
  const o = await order(c, i.item);
  const key = String(o?.status ?? '');
  if (key && !BEFORE_PICKUP.has(key)) throw new CourierError(`${c.name} : colis déjà pris en charge (${word(key)}), modifiez-le depuis l’espace Maystro`);
  const body: Record<string, unknown> = {};
  if (i.kind === 'amount') {
    if (i.amount == null || !(i.amount >= 0)) throw new CourierError('Le nouveau montant manque');
    body.product_price = Math.round(i.amount);
  } else if (i.kind === 'phone') {
    if (!i.phone) throw new CourierError('Le nouveau numéro manque');
    body.customer_phone = String(i.phone).replace(/\D/g, '');
  } else if (i.kind === 'address') {
    if (!p) throw new CourierError('Commande introuvable');
    const next: Parcel = { ...p, wilaya_id: i.wilayaId ?? p.wilaya_id, commune: i.commune ?? p.commune, address: i.address ?? p.address };
    const com = await communeOf(c, next, h);
    body.wilaya = next.wilaya_id;
    body.commune = com.id;
    body.destination_text = cut(next.address || com.name, 255);
    if (i.amount != null && i.amount >= 0) body.product_price = Math.round(i.amount);
  } else {
    throw new CourierError(`${c.name} ne permet pas de changer Domicile ↔ Stop desk par l’API : supprimez le colis et renvoyez-le`);
  }
  await api(c, `stores/orders/${oid(i.item)}/`, { method: 'PATCH', json: body });
  return { extId: `direct:${i.item.extId || i.item.tracking}:${Date.now()}`, approved: true, direct: true };
}

// ---------------------------------------------------------------- webhook (stores/hooks/costume/)
const webhook: NonNullable<CourierAdapter['webhook']> = {
  async on(c, hookUrl) {
    // the key is in hookUrl (?key=): Maystro's hook has no custom headers
    let trigger: string | undefined;
    try {
      const types = listOf(await api(c, 'stores/hooks/types/'));
      const all = types.find((t) => [t?.name, t?.type, t?.code, t?.slug, t?.trigger].some((v) => String(v ?? '').toLowerCase() === 'all'));
      trigger = all?.id ? String(all.id) : undefined;
    } catch (e: any) {
      if (String(e?.message).includes('refuse les clés')) throw e;
    }
    const r = await api(c, 'stores/hooks/costume/', { method: 'POST', json: { endpoint: hookUrl, ...(trigger ? { trigger_type_id: trigger } : {}) } });
    const id = r?.id ?? r?.data?.id;
    if (id == null) throw new CourierError(`${c.name} n’a pas renvoyé de numéro de webhook`);
    return { extId: String(id) };
  },
  async off(c, extId) {
    await api(c, `stores/hooks/costume/${encodeURIComponent(extId)}/`, { method: 'DELETE' });
  },
  async get(c, extId) {
    const hook = listOf(await api(c, 'stores/hooks/costume/')).find((x) => String(x?.id) === extId);
    return hook ? { on: hook.is_active !== false && hook.active !== false, url: hook.endpoint ?? hook.url ?? null } : null;
  },
};

export const maystro: CourierAdapter = {
  statuses: STATUSES,
  parcel: parcelInfo,
  change,
  webhook,
  async test(c) {
    await api(c, 'base/wilayas/', { q: { country: 1 } });
    return { ok: true, message: `Connexion réussie à ${c.name} (Maystro Delivery).` };
  },
  async create(c, p, h) {
    needKeys(c, 'token');
    const com = await communeOf(c, p, h);
    const items = p.items.length ? p.items : [{ name: p.products || 'Produit', sku: null, price: p.total, qty: Math.max(1, p.pieces || 1) }];
    const body = {
      wilaya: p.wilaya_id,
      commune: com.id,
      destination_text: cut(p.address || p.commune || com.name || '-', 255),
      customer_phone: String(p.phone).replace(/\D/g, ''),
      customer_name: cut(p.customer_name || 'Client', 255),
      product_price: Math.round(p.total),
      delivery_type: p.is_stopdesk ? 2 : 1,
      express: false,
      note_to_driver: cut([p.delivery_note, p.phone2 ? `Tél 2 : ${p.phone2}` : '', p.is_exchange ? 'ÉCHANGE : récupérer l’ancien produit' : ''].filter(Boolean).join(' · '), 255) || undefined,
      products: items.map((x) => ({ product_id: cut(x.sku || x.name || 'Produit', 100), quantity: Math.max(1, Math.round(x.qty || 1)), logistical_description: cut(x.name || x.sku || 'Produit', 255) })),
      source: 4,
      external_order_id: p.ref,
    };
    const r = await api(c, 'stores/orders/', { method: 'POST', json: body });
    const id = r?.id ?? r?.data?.id;
    if (id == null) throw new CourierError(`${c.name} n’a pas renvoyé de numéro de colis`);
    return { tracking: String(r.display_id ?? r?.data?.display_id ?? id), extId: String(id), labelUrl: null };
  },
  async track(c, items) {
    const out: TrackResult[] = [];
    for (const it of items) {
      if (timeUp()) break;
      try {
        const hist = await history(c, it);
        let last = hist.at(-1);
        if (!last) {
          const o = await order(c, it);
          if (o?.status == null) continue;
          last = { key: String(o.status), at: String(o.updated_at ?? o.last_update ?? ''), by: null, comment: null };
        }
        const left = hist.some((x) => LEFT.has(x.key));
        out.push({ id: it.id, key: last.key, status: word(last.key) + (last.comment ? ` · ${last.comment}` : ''), at: last.at || null, mapped: last.key === '50' && left ? 'returning' : undefined });
      } catch (e: any) {
        if (String(e?.message).includes('refuse les clés') || e?.status === 429) throw e;
        out.push({ id: it.id, status: '', error: String(e?.message ?? 'Erreur').slice(0, 200) });
      }
    }
    return out;
  },
  async cancel(c, it) {
    await api(c, `stores/orders/${oid(it)}/`, { method: 'PATCH', json: { status: 50, abort_reason: 21 } });
  },
  async label(c, it) {
    return api(c, 'delivery/starter/starter_bordureau/', { method: 'POST', json: { all_created: true, orders_ids: [it.extId || it.tracking] }, binary: true });
  },
  async labels(c, items) {
    const label = await api(c, 'delivery/starter/starter_bordureau/', { method: 'POST', json: { all_created: true, orders_ids: items.map((i) => i.extId || i.tracking) }, binary: true, timeout: 60_000 });
    return { label, failed: [] };
  },
};

