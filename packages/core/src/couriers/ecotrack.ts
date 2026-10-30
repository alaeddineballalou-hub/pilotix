// EcoTrack platform: DHD (https://platform.dhd-dz.com), Conexlog, Areex, World Express… (each company has its own address).
// Auth: Authorization: Bearer <token> (also passed as api_token where the API asks). Base <company address>/api/v1.
// Ported from the original Pilotix adapter. Endpoints: GET validate/token, get/communes?wilaya_id=, POST create/order, POST valid/order,
// get/orders/status?trackings=, get/tracking/info?tracking=, DELETE delete/order, get/order/label (PDF), get/fees.
// EcoTrack allows ~50 requests/minute: we wait 1.25 s between calls.
// Parcel page: get/tracking/info?tracking= (activity = journey; OrderInfo when given, else get/orders?tracking=). Changes: POST update/order
// (query string, update field names: client, tel, tel2, adresse, commune, wilaya, montant, stop_desk, code_postal — they differ from
// create/order), accepted only before the parcel is validated (error 10001 after). POST ask/for/order/return?tracking= (return),
// POST add/maj?tracking=&content= (note). Exchange is sent at creation (type=2).
// BEST GUESS (check with real keys): canModify = no activity yet past « order_information_received_by_carrier » / pre-pickup states
// (EcoTrack gives no « validated » flag); the OrderInfo shape of get/tracking/info; the update field names (from vargo's rules, which
// accept both client/nom_client, tel/telephone, wilaya/code_wilaya, product/produit).
import { cacheKeyOf } from './types';
import type { ChangeInput, CourierAdapter, CourierCompany, Helpers, Parcel, ParcelInfo } from './types';
import { baseUrl, chunks, CourierError, cut, errText, flag, http, HttpOpts, humanize, needKeys, query, sleep, timeUp, weighed } from './util';

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
  if (!c.settings.base_url) throw new CourierError(`Mettez l’adresse de ${c.name} (ex. https://platform.dhd-dz.com) dans Sociétés de livraison`);
  const qs = query(q);
  // DHD moved (dhd.ecotrack.dz answers « 301 », and a POST that follows a 301 becomes a GET): its new address
  const base = baseUrl(c, '', '/api/v1').replace(/^https?:\/\/dhd\.ecotrack\.dz\b/i, 'https://platform.dhd-dz.com');
  const r = await http(c.name, base + path + (qs ? `?${qs}` : ''), { ...o, headers: { Authorization: `Bearer ${String(c.secret.token ?? '').trim()}`, ...(o.headers ?? {}) } });
  await sleep(1250);
  if (!o.binary && r && r.success === false) throw new CourierError(`${c.name} : ${errText(r.message || r.errors) || 'refusé'}${r.error ? ` (${r.error})` : ''}`);
  return r;
}

/** EcoTrack wants 9–10 digit local numbers (0661…). */
const localPhone = (v: string | null | undefined) => {
  const d = String(v ?? '').replace(/\D/g, '').replace(/^00/, '').replace(/^213/, '');
  return d ? (d.startsWith('0') ? d : `0${d}`) : '';
};
const PRE_PICKUP = new Set(['order_information_received_by_carrier', 'notification_on_order', 'prete_a_expedier', 'prete_a_preparer', 'en_ramassage', 'en_preparation_stock']);
const eventAt = (x: any) => [x?.date, x?.time].filter(Boolean).join(' ');

async function parcelInfo(c: CourierCompany, tracking: string): Promise<ParcelInfo> {
  needKeys(c, 'token');
  const r = await api(c, '/get/tracking/info', { tracking });
  let o: any = r?.OrderInfo ?? r?.order ?? null;
  if (!o) {
    const l = await api(c, '/get/orders', { tracking }).catch(() => null);
    o = (Array.isArray(l?.data) ? l.data : Object.values(l?.data ?? {})).find((x: any) => x && (!x.tracking || x.tracking === tracking)) ?? null;
  }
  const acts: any[] = (Array.isArray(r?.activity) ? r.activity : []).filter((x: any) => x?.status);
  const last = acts.length ? acts[acts.length - 1] : null;
  const lastKey = String(last?.status ?? o?.status ?? '');
  const can = !lastKey || acts.every((x) => PRE_PICKUP.has(String(x.status)));
  const n = (v: unknown) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
  const desk = Number(o?.stop_desk) === 1;
  return {
    state: lastKey ? humanize(lastKey) : null,
    color: null,
    situation: last?.reason ?? null,
    livreur: null,
    risk: null,
    canModify: can,
    canChangePhone: can,
    direct: can,
    pendingChange: false,
    modifications: null,
    modificationLimit: null,
    phoneChanges: null,
    phoneChangeLimit: null,
    phoneChangePrice: null,
    delivery: {
      type: o ? (desk ? 'Stop desk' : 'Domicile') : null,
      hub: desk ? (o?.desk_commune ?? o?.commune ?? null) : null,
      city: o?.wilaya ?? o?.wilaya_name ?? (o?.wilaya_id ? `Wilaya ${o.wilaya_id}` : null),
      district: o?.commune ?? null,
      street: o?.adresse ?? null,
    },
    amount: n(o?.montant),
    deliveryPrice: n(o?.tarif_prestation),
    returnPrice: n(o?.tarif_retour),
    swap: null,
    history: acts
      .map((x) => ({
        at: eventAt(x),
        status: humanize(String(x.status)),
        color: null,
        hub: x.station ?? x.scanLocation ?? null,
        by: x.driver ?? x.livreur ?? null,
        comment: x.reason ?? x.remarque ?? null,
        situations: [],
      }))
      .filter((x) => x.at)
      .sort((x, y) => y.at.localeCompare(x.at)),
    sms: [],
  };
}

/** Changes a parcel straight at EcoTrack (update/order): only before EcoTrack validated it. */
async function changeDirect(c: CourierCompany, i: ChangeInput, helpers: Helpers, p: Parcel | null) {
  needKeys(c, 'token');
  const body: Record<string, unknown> = { tracking: i.item.tracking };
  if (i.kind === 'amount') {
    if (i.amount == null || !(i.amount >= 0)) throw new CourierError('Le nouveau montant manque');
    body.montant = Math.round(i.amount);
  } else if (i.kind === 'phone') {
    if (!i.phone) throw new CourierError('Le nouveau numéro manque');
    body.tel = localPhone(i.phone);
    if (i.phone2) body.tel2 = localPhone(i.phone2);
  } else {
    if (!p) throw new CourierError('Commande introuvable');
    const toDesk = i.kind === 'delivery' ? !!i.stopdesk : p.is_stopdesk;
    if (i.kind === 'address' && toDesk) throw new CourierError('Colis livré en stop desk : changez plutôt le bureau (Domicile ↔ Stop desk)');
    const next: Parcel = { ...p, is_stopdesk: toDesk, wilaya_id: i.wilayaId ?? p.wilaya_id, commune: i.commune ?? p.commune, address: i.address ?? p.address };
    const com = await helpers.communeName(
      next,
      async (w) => Object.values((await api(c, '/get/communes', { wilaya_id: w })) ?? {}).map((x: any) => ({ name: x.nom as string, id: x.code_postal, desk: Number(x.has_stop_desk) === 1 })),
      `eco:${cacheKeyOf(c)}`,
    );
    if (!com) throw new CourierError(`Commune « ${next.commune} » introuvable chez ${c.name} : corrigez la commune`);
    if (toDesk && com.desk === false) throw new CourierError(`${c.name} n’a pas de stop desk à ${com.name} : livraison à domicile ou autre commune`);
    Object.assign(body, {
      adresse: cut(next.address || com.name, 250),
      commune: com.name,
      wilaya: next.wilaya_id,
      stop_desk: toDesk ? 1 : 0,
      code_postal: toDesk ? com.id : undefined,
    });
    if (i.amount != null && i.amount >= 0) body.montant = Math.round(i.amount);
  }
  try {
    await api(c, '/update/order', body, { method: 'POST' });
  } catch (e: any) {
    if (/10001/.test(String(e?.message))) throw new CourierError(`${c.name} : colis déjà validé, il ne peut plus être modifié par l’API. Changez-le depuis l’espace ${c.name} ou appelez la société.`);
    throw e;
  }
  return { extId: i.item.tracking, approved: true, direct: true };
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
          out.push({ id: it.id, key: x.status, status: humanize(String(x.status)) + (last?.reason ? ` · ${last.reason}` : ''), at: last ? [last.date, last.time].filter(Boolean).join(' ') : null, ...weighed(x, x.order) });
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
        if (last?.status) out.push({ id: it.id, key: last.status, status: humanize(String(last.status)), at: [last.date, last.time].filter(Boolean).join(' ') || null, ...weighed(r, r?.order) });
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
  parcel(c, it) {
    return parcelInfo(c, it.tracking);
  },
  change(c, i, helpers, p) {
    return changeDirect(c, i, helpers, p);
  },
  async askReturn(c, it, note) {
    needKeys(c, 'token');
    await api(c, '/ask/for/order/return', { tracking: it.tracking }, { method: 'POST' });
    // EcoTrack's return request has no comment field: the reason goes as a note (best effort)
    if (String(note ?? '').trim()) await api(c, '/add/maj', { tracking: it.tracking, content: cut(String(note).trim(), 255) }, { method: 'POST' }).catch(() => undefined);
  },
  async note(c, it, text) {
    needKeys(c, 'token');
    const content = cut(String(text ?? '').trim(), 255);
    if (!content) throw new CourierError('La note est vide');
    await api(c, '/add/maj', { tracking: it.tracking, content }, { method: 'POST' });
  },
};
