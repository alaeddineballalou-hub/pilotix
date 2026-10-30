// NOEST Express. Auth: Authorization: Bearer <api_token> + api_token and user_guid in each POST body
// (NOEST space → API). Base https://app.noest-dz.com/api/public.
// Ported from the original Pilotix adapter. Endpoints: POST create/order, POST valid/order, POST get/trackings/info, POST delete/order,
// GET get/order/label?tracking= (PDF), GET desks.
// Parcel page: POST get/trackings/info (OrderInfo + activity). Changes: POST update/order {tracking, client, phone, phone_2, adresse,
// wilaya_id, commune, montant, stop_desk, station_code} (only before pickup). POST ask/return, POST ask/new-tentative, POST add/maj
// {tracking, content}. Exchange: type_id 2 at creation (NOEST docs: 1 Livraison, 2 Échange, 3 Pick up — vargo guesses 3 = exchange
// « based on common usage » and 2 = fragile; we keep 2, the documented value).
// BEST GUESS (check with real keys): canModify = no activity yet past upload / customer_validation; station_code on update/order
// (vargo's update rules do not list it); the OrderInfo field names (tarif, stop_desk, station_code).
// BEST GUESS (check with real keys): the fees endpoint — NOEST did not document one; we try /fees, /get/fees, /tarifs.
import type { ChangeInput, CourierAdapter, CourierCompany, Parcel, ParcelInfo } from './types';
import { baseUrl, chunks, CourierError, cut, errText, flag, http, HttpOpts, humanize, needKeys, sleep, timeUp, weighed } from './util';

const STATUSES: CourierAdapter['statuses'] = {
  upload: null, customer_validation: null, validation_collect_colis: null, pickedup: 'shipped', validation_reception_admin: 'shipped', validation_reception: 'shipped',
  fdr_activated: 'out_for_delivery', sent_to_redispatch: 'shipped', nouvel_tentative_asked_by_customer: 'failed', colis_suspendu: 'alert', livre: 'delivered',
  livred: 'delivered', non_livre: 'failed', livraison_echoue_recu: 'returning', return_asked_by_customer: 'returning', return_asked_by_hub: 'returning',
  retour_dispatched_to_partenaires: 'returning', return_dispatched_to_partenaire: 'returning', colis_retour_transmit_to_partner: 'returning',
  return_validated_by_partener: 'returned', return_redispatched_to_livraison: 'shipped', return_dispatched_to_warehouse: 'returning',
};
const url = (c: CourierCompany, p: string) => baseUrl(c, 'https://app.noest-dz.com', '/api/public') + p;
const auth = (c: CourierCompany) => ({ Authorization: `Bearer ${String(c.secret.api_token ?? '').trim()}` });

async function api(c: CourierCompany, path: string, body?: Record<string, unknown>, o: HttpOpts = {}) {
  const r = await http(c.name, url(c, path), {
    method: body ? 'POST' : 'GET',
    ...o,
    headers: auth(c),
    ...(body ? { json: { api_token: String(c.secret.api_token ?? '').trim(), user_guid: String(c.secret.user_guid ?? '').trim(), ...body } } : {}),
  });
  await sleep(400);
  if (r && r.success === false) throw new CourierError(`${c.name} : ${errText(r.errors || r.message) || 'refusé'}`);
  return r;
}

/** NOEST wants 9–10 digit local numbers (0661…). */
const localPhone = (v: string | null | undefined) => {
  const d = String(v ?? '').replace(/\D/g, '').replace(/^00/, '').replace(/^213/, '');
  return d ? (d.startsWith('0') ? d : `0${d}`) : '';
};
/** Events before the driver picks the parcel up: NOEST still accepts update/order. */
const PRE_PICKUP = new Set(['upload', 'customer_validation']);

async function parcelInfo(c: CourierCompany, tracking: string): Promise<ParcelInfo> {
  needKeys(c, 'api_token', 'user_guid');
  const r = await api(c, '/get/trackings/info', { trackings: [tracking] });
  const x = r?.[tracking] ?? (Object.values(r ?? {}).find((v: any) => v && typeof v === 'object' && (v.OrderInfo?.tracking === tracking || v.activity)) as any);
  if (!x) throw new CourierError(`Colis ${tracking} introuvable chez ${c.name}`);
  const o = x.OrderInfo ?? {};
  const acts: any[] = (Array.isArray(x.activity) ? x.activity : []).filter((a: any) => a && (a.event_key || a.event));
  const known = acts.filter((a) => a.event_key in STATUSES);
  const last = (known.length ? known : acts).at(-1);
  const can = acts.every((a) => PRE_PICKUP.has(String(a.event_key)));
  const n = (v: unknown) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
  const desk = Number(o.stop_desk) === 1;
  return {
    state: last ? last.event || humanize(String(last.event_key)) : null,
    color: null,
    situation: null,
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
      type: x.OrderInfo ? (desk ? 'Stop desk' : 'Domicile') : null,
      hub: desk ? (o.station_code ?? o.station ?? null) : null,
      city: o.wilaya ?? (o.wilaya_id ? `Wilaya ${o.wilaya_id}` : null),
      district: o.commune ?? null,
      street: o.adresse ?? null,
    },
    amount: n(o.montant),
    deliveryPrice: n(o.tarif ?? o.tarif_livraison),
    returnPrice: n(o.tarif_retour),
    swap: null,
    history: acts
      .map((a) => ({
        at: String(a.date ?? a.created_at ?? ''),
        status: String(a.event || humanize(String(a.event_key))),
        color: null,
        hub: a.location ?? a.station ?? null,
        by: a.by ?? a.causer ?? a.driver ?? null,
        comment: a.remarque ?? a.comment ?? null,
        situations: [],
      }))
      .filter((a) => a.at)
      .sort((a, b) => b.at.localeCompare(a.at)),
    sms: [],
  };
}

/** Changes a parcel straight at NOEST (update/order), before pickup. */
async function changeDirect(c: CourierCompany, i: ChangeInput, p: Parcel | null) {
  needKeys(c, 'api_token', 'user_guid');
  const body: Record<string, unknown> = { tracking: i.item.tracking };
  if (i.kind === 'amount') {
    if (i.amount == null || !(i.amount >= 0)) throw new CourierError('Le nouveau montant manque');
    body.montant = Math.round(i.amount);
  } else if (i.kind === 'phone') {
    if (!i.phone) throw new CourierError('Le nouveau numéro manque');
    body.phone = localPhone(i.phone);
    if (i.phone2) body.phone_2 = localPhone(i.phone2);
  } else {
    if (!p) throw new CourierError('Commande introuvable');
    const toDesk = i.kind === 'delivery' ? !!i.stopdesk : p.is_stopdesk;
    if (i.kind === 'address' && toDesk) throw new CourierError('Colis livré en stop desk : changez plutôt le bureau (Domicile ↔ Stop desk)');
    const station = toDesk ? (i.kind === 'delivery' ? (i.hubExtId ?? null) : p.stopdesk_ext_id) : null;
    if (toDesk && !station) throw new CourierError('Choisissez le bureau NOEST (stop desk)');
    Object.assign(body, {
      adresse: cut(i.address ?? p.address ?? i.commune ?? p.commune ?? '-', 250),
      wilaya_id: i.wilayaId ?? (station ? parseInt(String(station), 10) || p.wilaya_id : p.wilaya_id),
      commune: i.commune ?? p.commune ?? p.stopdesk_commune ?? '',
      stop_desk: toDesk ? 1 : 0,
      station_code: station ?? undefined,
    });
    if (i.amount != null && i.amount >= 0) body.montant = Math.round(i.amount);
  }
  try {
    await api(c, '/update/order', body);
  } catch (e: any) {
    if (e instanceof CourierError && !/refuse les clés|ne répond pas|trop de demandes/.test(String(e.message))) {
      throw new CourierError(`${c.name} refuse la modification (colis sans doute déjà ramassé) : ${String(e.message).replace(`${c.name} : `, '')}`);
    }
    throw e;
  }
  return { extId: i.item.tracking, approved: true, direct: true };
}

export const noest: CourierAdapter = {
  statuses: STATUSES,
  async test(c) {
    needKeys(c, 'api_token', 'user_guid');
    await api(c, '/get/trackings/info', { trackings: [] }).catch(async (e) => {
      if (String(e.message).includes('refuse les clés')) throw e;
      await api(c, '/desks');
    });
    return { ok: true, message: `Connexion réussie à ${c.name} (NOEST).` };
  },
  async create(c, p) {
    needKeys(c, 'api_token', 'user_guid');
    if (p.is_stopdesk && !p.stopdesk_ext_id) throw new CourierError('Choisissez le bureau NOEST (stop desk) de la commande');
    const r = await api(c, '/create/order', {
      reference: p.ref,
      client: cut(p.customer_name || 'Client', 100),
      phone: p.phone,
      phone_2: p.phone2 || undefined,
      adresse: cut(p.address || p.commune || '-', 250),
      wilaya_id: p.wilaya_id,
      commune: p.commune || p.stopdesk_commune || '',
      montant: Math.round(p.total),
      remarque: cut(p.delivery_note, 250) || '',
      produit: cut(p.products, 250),
      type_id: p.is_exchange ? 2 : 1,
      poids: Math.max(1, Math.round(p.weight || 1)),
      stop_desk: p.is_stopdesk ? 1 : 0,
      station_code: p.is_stopdesk ? p.stopdesk_ext_id : undefined,
      stock: 0,
      can_open: flag(c, 'can_open', false) ? 1 : 0,
    });
    if (!r?.tracking) throw new CourierError(`${c.name} : pas de numéro de suivi`);
    if (flag(c, 'validate', true)) await api(c, '/valid/order', { tracking: r.tracking });
    return { tracking: r.tracking, extId: null, labelUrl: null };
  },
  async track(c, items) {
    const out = [];
    for (const group of chunks(items, 100)) {
      if (timeUp()) break;
      const r = await api(c, '/get/trackings/info', { trackings: group.map((g) => g.tracking) });
      for (const it of group) {
        const x = r?.[it.tracking];
        if (!x) continue;
        const acts = (x.activity ?? []).filter((a: any) => a?.event_key);
        const known = acts.filter((a: any) => a.event_key in STATUSES);
        const last = (known.length ? known : acts).at(-1);
        if (last) out.push({ id: it.id, key: last.event_key, status: last.event || humanize(last.event_key), at: last.date ?? null, ...weighed(x.OrderInfo, x.order_info, x) });
      }
    }
    return out;
  },
  async cancel(c, it) {
    await api(c, '/delete/order', { tracking: it.tracking });
  },
  async label(c, it) {
    return http(c.name, url(c, `/get/order/label?tracking=${encodeURIComponent(it.tracking)}`), { headers: auth(c), binary: true });
  },
  async stopdesks(c) {
    needKeys(c, 'api_token', 'user_guid');
    const r = await api(c, '/desks');
    return Object.values(r ?? {})
      .filter((d: any) => d && d.code)
      .map((d: any) => ({ extId: String(d.code), name: d.name || d.code, wilayaId: parseInt(String(d.code), 10) || null, commune: d.commune ?? null, address: d.address ?? null }));
  },
  async fees(c) {
    needKeys(c, 'api_token', 'user_guid');
    let r: any = null;
    for (const p of ['/fees', '/get/fees', '/tarifs']) {
      try {
        r = await api(c, p, {});
        if (r?.tarifs) break;
      } catch {
        /* try the next one */
      }
    }
    const t = r?.tarifs;
    if (!t) throw new CourierError('Import des tarifs non disponible chez NOEST : remplissez-les à la main');
    const home = t.delivery ?? {};
    const desk = t.stop_desk ?? t.stopdesk ?? t.desk ?? {};
    const ret = t.return ?? t.retour ?? {};
    return Object.keys(home)
      .map((w) => ({ wilayaId: Number(w), home: Number(home[w]?.tarif) || null, desk: Number(desk[w]?.tarif) || null, returnFee: Number(ret[w]?.tarif) || null }))
      .filter((x) => x.wilayaId >= 1 && x.wilayaId <= 69);
  },
  parcel(c, it) {
    return parcelInfo(c, it.tracking);
  },
  change(c, i, _helpers, p) {
    return changeDirect(c, i, p);
  },
  async askReturn(c, it, note) {
    needKeys(c, 'api_token', 'user_guid');
    await api(c, '/ask/return', { tracking: it.tracking });
    if (String(note ?? '').trim()) await api(c, '/add/maj', { tracking: it.tracking, content: cut(String(note).trim(), 255) }).catch(() => undefined);
  },
  async retry(c, it, note) {
    needKeys(c, 'api_token', 'user_guid');
    await api(c, '/ask/new-tentative', { tracking: it.tracking });
    if (String(note ?? '').trim()) await api(c, '/add/maj', { tracking: it.tracking, content: cut(String(note).trim(), 255) }).catch(() => undefined);
  },
  async note(c, it, text) {
    needKeys(c, 'api_token', 'user_guid');
    const content = cut(String(text ?? '').trim(), 255);
    if (!content) throw new CourierError('La note est vide');
    await api(c, '/add/maj', { tracking: it.tracking, content });
  },
};
