// EcoTrack platform: DHD (https://dhd.ecotrack.dz), Conexlog, Anderson, Areex, World Express… (each company has its own address).
// Auth: Authorization: Bearer <token> (also passed as api_token where the API asks). Base <company address>/api/v1.
// Ported from the original Pilotix adapter. Endpoints: GET validate/token, get/communes?wilaya_id=, POST create/order, POST valid/order,
// get/orders/status?trackings=, get/tracking/info?tracking=, DELETE delete/order, get/order/label (PDF), get/fees.
// EcoTrack allows ~50 requests/minute: we wait 1.25 s between calls.
import { cacheKeyOf } from './types';
import type { CourierAdapter, CourierCompany } from './types';
import { baseUrl, chunks, CourierError, cut, errText, flag, http, HttpOpts, humanize, needKeys, query, sleep, timeUp } from './util';

const STATUSES: CourierAdapter['statuses'] = {
  order_information_received_by_carrier: null, picked: 'shipped', accepted_by_carrier: 'shipped', dispatched_to_driver: 'out_for_delivery',
  attempt_delivery: 'failed', return_asked: 'returning', return_in_transit: 'returning', Return_received: 'returned', return_received: 'returned',
  livred: 'delivered', encaissed: 'delivered', payed: 'delivered', notification_on_order: null, prete_a_expedier: null, prete_a_preparer: null,
  en_ramassage: null, en_preparation_stock: null, vers_hub: 'shipped', en_hub: 'shipped', vers_wilaya: 'shipped', en_preparation: 'shipped',
  en_livraison: 'out_for_delivery', suspendu: 'alert', livre_non_encaisse: 'delivered', encaisse_non_paye: 'delivered', paiements_prets: 'delivered',
  paye_et_archive: 'delivered', retour_chez_livreur: 'returning', retour_transit_entrepot: 'returning', retour_en_traitement: 'returning',
  retour_recu: 'returned', retour_archive: 'returned', annule: null,
  'Prêt à expédier': null, 'En ramassage': null, 'Vers hub': 'shipped', 'En hub': 'shipped', 'Vers wilaya': 'shipped', 'En livraison': 'out_for_delivery',
  Suspendus: 'alert', 'Retours chez livreur': 'returning', 'Retours reçu': 'returned', 'Livre non encaissé': 'delivered', 'Livre encaissé non payé': 'delivered',
  'Paiement prêt': 'delivered', 'Paiement archivé': 'delivered', 'Retours archivé': 'returned',
};

async function api(c: CourierCompany, path: string, q: Record<string, unknown> = {}, o: HttpOpts = {}) {
  if (!c.settings.base_url) throw new CourierError(`Mettez l’adresse de ${c.name} (ex. https://dhd.ecotrack.dz) dans Sociétés de livraison`);
  const qs = query(q);
  const r = await http(c.name, baseUrl(c, '', '/api/v1') + path + (qs ? `?${qs}` : ''), { ...o, headers: { Authorization: `Bearer ${String(c.secret.token ?? '').trim()}`, ...(o.headers ?? {}) } });
  await sleep(1250);
  if (!o.binary && r && r.success === false) throw new CourierError(`${c.name} : ${errText(r.message || r.errors) || 'refusé'}${r.error ? ` (${r.error})` : ''}`);
  return r;
}

export const ecotrack: CourierAdapter = {
  statuses: STATUSES,
  async test(c) {
    needKeys(c, 'token');
    const r = await api(c, '/validate/token', { api_token: String(c.secret.token).trim() });
    const m = r?.message;
    return {
      ok: !m || m === 'VALID_TOKEN',
      message: m === 'TOKEN_NOT_ALLOWED' ? `${c.name} : l’API n’est pas activée sur votre compte (demandez-la à la société).` : m === 'INVALID_TOKEN' ? `Token refusé par ${c.name}` : `Connexion réussie à ${c.name}.`,
    };
  },
  async create(c, p, helpers) {
    needKeys(c, 'token');
    const com = await helpers.communeName(
      p,
      async (w) => Object.values((await api(c, '/get/communes', { wilaya_id: w })) ?? {}).map((x: any) => ({ name: x.nom as string, id: x.code_postal, desk: Number(x.has_stop_desk) === 1 })),
      `eco:${cacheKeyOf(c)}`,
    );
    if (!com && !p.is_stopdesk) throw new CourierError(`Commune « ${p.commune} » introuvable chez ${c.name} : corrigez la commune`);
    if (p.is_stopdesk && com && com.desk === false) throw new CourierError(`${c.name} n’a pas de stop desk à ${com.name} : livraison à domicile ou autre commune`);
    const body = {
      reference: p.ref,
      nom_client: cut(p.customer_name || 'Client', 100),
      telephone: p.phone,
      telephone_2: p.phone2 || undefined,
      adresse: cut(p.address || p.commune || '-', 250),
      commune: com ? com.name : p.commune,
      code_wilaya: p.wilaya_id,
      montant: Math.round(p.total),
      remarque: cut(p.delivery_note, 250) || undefined,
      produit: cut(p.products, 255),
      type: p.is_exchange ? 2 : 1,
      stop_desk: p.is_stopdesk ? 1 : 0,
      code_postal: p.is_stopdesk && com ? com.id : undefined,
      weight: Math.max(1, Math.round(p.weight || 1)),
      produit_a_recuperer: p.is_exchange ? cut(p.products, 255) : undefined,
      boutique: c.shop.name,
      fragile: flag(c, 'fragile', false) ? 1 : 0,
    };
    // EcoTrack reads the order from the query string of the POST (as in the original adapter).
    const r = await api(c, '/create/order', body, { method: 'POST' });
    if (!r?.tracking) throw new CourierError(`${c.name} : pas de numéro de suivi (${errText(r)})`);
    if (flag(c, 'validate', true)) {
      try {
        await api(c, '/valid/order', { tracking: r.tracking, ask_collection: flag(c, 'ask_collection', true) ? 1 : 0 }, { method: 'POST' });
      } catch {
        /* the parcel exists; validation can be done in the company's space */
      }
    }
    return { tracking: r.tracking, extId: null, labelUrl: null };
  },
  async track(c, items) {
    const out: { id: number; key: string; status: string; at: string | null }[] = [];
    const done = new Set<number>();
    try {
      for (const group of chunks(items, 100)) {
        if (timeUp()) break;
        const r = await api(c, '/get/orders/status', { api_token: String(c.secret.token).trim(), trackings: group.map((g) => g.tracking).join(','), status: 'all' });
        const data = r?.data ?? {};
        for (const it of group) {
          const x = data[it.tracking];
          if (!x?.status) continue;
          const last = Array.isArray(x.activity) && x.activity.length ? x.activity[x.activity.length - 1] : null;
          out.push({ id: it.id, key: x.status, status: humanize(String(x.status)) + (last?.reason ? ` · ${last.reason}` : ''), at: last ? [last.date, last.time].filter(Boolean).join(' ') : null });
          done.add(it.id);
        }
      }
    } catch (e: any) {
      if (e.status === 429) return out;
    }
    // older EcoTrack installs: one call per parcel
    for (const it of items.filter((x) => !done.has(x.id))) {
      if (timeUp()) break;
      try {
        const r = await api(c, '/get/tracking/info', { tracking: it.tracking });
        const last = (r?.activity ?? []).at(-1);
        if (last?.status) out.push({ id: it.id, key: last.status, status: humanize(String(last.status)), at: [last.date, last.time].filter(Boolean).join(' ') || null });
      } catch (e: any) {
        if (e.status === 429) break;
      }
    }
    return out;
  },
  async cancel(c, it) {
    try {
      await api(c, '/delete/order', { tracking: it.tracking }, { method: 'DELETE' });
    } catch (e: any) {
      if (/10001/.test(e.message)) throw new CourierError(`${c.name} : colis déjà validé, annulez-le depuis l’espace de la société`);
      throw e;
    }
  },
  async label(c, it) {
    return api(c, '/get/order/label', { tracking: it.tracking }, { binary: true });
  },
  async fees(c) {
    needKeys(c, 'token');
    const r = await api(c, '/get/fees');
    const ret = new Map<number, number | null>((r?.retours || r?.retour || []).map((x: any) => [Number(x.wilaya_id), Number(x.tarif) || null]));
    return (r?.livraison ?? [])
      .map((x: any) => ({ wilayaId: Number(x.wilaya_id), home: Number(x.tarif) || null, desk: Number(x.tarif_stopdesk) || null, returnFee: ret.get(Number(x.wilaya_id)) ?? null }))
      .filter((x: any) => x.wilayaId >= 1 && x.wilayaId <= 69);
  },
};
