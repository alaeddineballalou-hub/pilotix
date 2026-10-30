// Yalidine (and companies on the same platform, e.g. Guepex: base_url https://api.guepex.app/v1/).
// Auth: headers X-API-ID + X-API-TOKEN (Yalidine → Développement → Gestionnaire d’API). Base https://api.yalidine.app/v1/.
// Ported from the original Pilotix adapter. Endpoints: wilayas/, communes/?wilaya_id=, centers/, parcels/ (POST array, GET ?tracking=,
// DELETE parcels/{tracking}), fees/?from_wilaya_id=&to_wilaya_id=. Yalidine limits the request rate: we wait between calls.
// Yalidine only knows the 58 historic wilayas; wilayas 59–69 are sent as their parent wilaya.
// Parcel page: GET parcels/?tracking= (current state) + GET histories/?tracking= (journey). Changes: PATCH parcels/{tracking}
// (price, contact_phone, address/to_commune_name/to_wilaya_name, is_stopdesk/stopdesk_id) — Yalidine only accepts them before
// the parcel is picked up. BEST GUESS (check with real keys): which pre-pickup states Yalidine still lets us PATCH (its docs say
// « En préparation »; we also allow the other « not picked up yet » words and show Yalidine's refusal in French otherwise).
// Webhooks: registered by the user in Yalidine's dashboard (Développement → Webhooks), not through the API: `webhook` only says so.
import { NEW_WILAYA_PARENT } from '@pilotix/shared';
import { cacheKeyOf } from './types';
import type { ChangeInput, CourierAdapter, CourierCompany, Helpers, Parcel, ParcelInfo } from './types';
import { baseUrl, chunks, CourierError, cut, http, HttpOpts, needKeys, sleep, splitName, timeUp, weighed } from './util';

const STATUSES: CourierAdapter['statuses'] = {
  'Pas encore expédié': null, 'A vérifier': null, 'En préparation': null, 'Pas encore ramassé': null, 'Prêt à expédier': null, 'En passation': null,
  'Ramassé': 'shipped', 'Bloqué': 'alert', 'Débloqué': 'shipped', Transfert: 'shipped', 'Expédié': 'shipped', Centre: 'shipped', 'En localisation': 'shipped',
  'Vers Wilaya': 'shipped', 'En transit': 'shipped', 'Reçu à Wilaya': 'shipped', 'En attente du client': 'out_for_delivery', 'Prêt pour livreur': 'out_for_delivery',
  'Sorti en livraison': 'out_for_delivery', 'En attente': 'failed', 'Annulé': null, 'En alerte': 'alert', 'Alerte résolue': 'shipped', 'Tentative échouée': 'failed',
  'Livré': 'delivered', 'Echèc livraison': 'returning', 'Retour vers centre': 'returning', 'Retourné au centre': 'returning', 'Retour transfert': 'returning',
  'Retour groupé': 'returning', 'Retour à retirer': 'returning', 'Retour non retiré': 'returning', 'Colis abandonné': 'lost', 'Retour vers vendeur': 'returning',
  'Retourné au vendeur': 'returned', 'Echange échoué': 'alert',
};
const yw = (w: number) => (w > 58 ? NEW_WILAYA_PARENT[w] ?? w : w);

async function api(c: CourierCompany, path: string, o: HttpOpts = {}) {
  const r = await http(c.name, baseUrl(c, 'https://api.yalidine.app/v1') + '/' + path.replace(/^\//, ''), {
    ...o,
    headers: { 'X-API-ID': String(c.secret.api_id ?? '').trim(), 'X-API-TOKEN': String(c.secret.api_token ?? '').trim(), ...(o.headers ?? {}) },
  });
  await sleep(220);
  return r;
}
async function all(c: CourierCompany, path: string) {
  const out: any[] = [];
  for (let page = 1; page < 30; page++) {
    const r = await api(c, `${path}${path.includes('?') ? '&' : '?'}page_size=1000&page=${page}`);
    out.push(...(r?.data ?? []));
    if (!r?.has_more) break;
  }
  return out;
}
const wcache = new Map<string, any[]>();
async function wilayas(c: CourierCompany) {
  const k = cacheKeyOf(c);
  if (!wcache.has(k)) wcache.set(k, await all(c, 'wilayas/'));
  return wcache.get(k)!;
}

/** States in which the parcel is not picked up yet: Yalidine still accepts a change (PATCH) or a delete. */
const EDITABLE = new Set(['En préparation', 'Pas encore expédié', 'A vérifier', 'Pas encore ramassé', 'Prêt à expédier'].map((x) => x.toLowerCase()));
const editable = (status: unknown) => EDITABLE.has(String(status ?? '').trim().toLowerCase());

async function current(c: CourierCompany, tracking: string) {
  const r = await api(c, `parcels/?tracking=${encodeURIComponent(tracking)}`);
  const one = r?.data?.[0] ?? (r?.tracking ? r : null);
  if (!one) throw new CourierError(`Colis ${tracking} introuvable chez ${c.name}`);
  return one;
}

async function parcelInfo(c: CourierCompany, tracking: string): Promise<ParcelInfo> {
  needKeys(c, 'api_id', 'api_token');
  const p = await current(c, tracking);
  const hist = await all(c, `histories/?tracking=${encodeURIComponent(tracking)}`).catch(() => [] as any[]);
  const n = (v: unknown) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
  const can = editable(p.last_status);
  const desk = p.is_stopdesk === true || p.is_stopdesk === 1 || p.is_stopdesk === '1';
  return {
    state: p.last_status ?? null,
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
      type: desk ? 'Stop desk' : 'Domicile',
      hub: desk ? (p.stopdesk_name ?? (p.stopdesk_id ? `Bureau ${p.stopdesk_id}` : null)) : null,
      city: p.to_wilaya_name ?? null,
      district: p.to_commune_name ?? null,
      street: p.address ?? null,
    },
    amount: n(p.price),
    deliveryPrice: n(p.delivery_fee),
    returnPrice: n(p.taxe_retour),
    swap: null,
    history: hist
      .map((x: any) => ({
        at: String(x.date_status ?? ''),
        status: String(x.status ?? ''),
        color: null,
        hub: x.center_name || [x.commune_name, x.wilaya_name].filter(Boolean).join(', ') || null,
        by: null,
        comment: x.reason || null,
        situations: [],
      }))
      .filter((x) => x.at && x.status)
      .sort((x, y) => y.at.localeCompare(x.at)),
    sms: [],
  };
}

/** Changes a parcel straight at Yalidine (PATCH), only while it is not picked up. */
async function changeDirect(c: CourierCompany, i: ChangeInput, helpers: Helpers, p: Parcel | null) {
  needKeys(c, 'api_id', 'api_token');
  const tracking = i.item.tracking;
  const cur = await current(c, tracking);
  if (!editable(cur.last_status)) {
    throw new CourierError(`${c.name} n’accepte plus de modification : le colis est « ${cur.last_status || 'déjà ramassé'} ». Changez-le depuis l’espace ${c.name} ou appelez la société.`);
  }
  const body: Record<string, unknown> = {};
  if (i.kind === 'amount') {
    if (i.amount == null || !(i.amount >= 0)) throw new CourierError('Le nouveau montant manque');
    body.price = Math.min(150000, Math.round(i.amount));
  } else if (i.kind === 'phone') {
    if (!i.phone) throw new CourierError('Le nouveau numéro manque');
    body.contact_phone = [i.phone, i.phone2].filter(Boolean).join(',');
  } else {
    const ws = await wilayas(c);
    const wname = (id: number) => {
      const w = ws.find((x) => Number(x.id) === yw(id));
      if (!w) throw new CourierError(`Wilaya ${id} inconnue chez ${c.name}`);
      return w.name as string;
    };
    const toDesk = i.kind === 'delivery' ? !!i.stopdesk : cur.is_stopdesk === true || cur.is_stopdesk === 1 || cur.is_stopdesk === '1';
    if (i.kind === 'address' && toDesk) throw new CourierError('Colis livré en stop desk : changez plutôt le bureau (Domicile ↔ Stop desk)');
    if (toDesk) {
      const deskId = Number(i.hubExtId ?? p?.stopdesk_ext_id);
      if (!deskId) throw new CourierError(`Choisissez le bureau ${c.name} (stop desk)`);
      let center = ((await api(c, `centers/?center_id=${deskId}`)).data ?? [])[0];
      if (!center && (i.wilayaId || p?.wilaya_id)) center = (await all(c, `centers/?wilaya_id=${yw(Number(i.wilayaId || p?.wilaya_id))}`)).find((x) => Number(x.center_id) === deskId);
      if (!center) throw new CourierError(`Bureau ${c.name} introuvable : réimportez les stop desks`);
      Object.assign(body, { is_stopdesk: true, stopdesk_id: deskId, to_commune_name: center.commune_name, to_wilaya_name: wname(Number(center.wilaya_id)) });
    } else {
      if (!p) throw new CourierError('Commande introuvable');
      const next: Parcel = { ...p, is_stopdesk: false, wilaya_id: i.wilayaId ?? p.wilaya_id, commune: i.commune ?? p.commune, address: i.address ?? p.address };
      const m = await helpers.communeName(next, async (w) => (await all(c, `communes/?wilaya_id=${yw(w)}`)).map((x) => ({ id: x.id, name: x.name as string })), `yal:${cacheKeyOf(c)}`);
      if (!m) throw new CourierError(`Commune « ${next.commune} » introuvable chez ${c.name} : corrigez la commune`);
      Object.assign(body, { address: cut(next.address || m.name, 250), to_commune_name: m.name, to_wilaya_name: wname(next.wilaya_id) });
      if (i.kind === 'delivery') Object.assign(body, { is_stopdesk: false, stopdesk_id: null });
    }
    if (i.amount != null && i.amount >= 0) body.price = Math.min(150000, Math.round(i.amount));
  }
  let r: any;
  try {
    r = await api(c, `parcels/${encodeURIComponent(tracking)}`, { method: 'PATCH', json: body });
  } catch (e: any) {
    if (e instanceof CourierError && /pr[ée]paration|cannot|can't|not allowed|impossible/i.test(String(e.message))) {
      throw new CourierError(`${c.name} refuse la modification : le colis n’est plus « En préparation » (${String(e.message).replace(`${c.name} : `, '')})`);
    }
    throw e;
  }
  const err = r && (r.error || (r.success === false ? r.message : null));
  if (err) throw new CourierError(`${c.name} refuse la modification : ${typeof err === 'string' ? err : JSON.stringify(err).slice(0, 200)}`);
  return { extId: tracking, approved: true, direct: true };
}

export const yalidine: CourierAdapter = {
  statuses: STATUSES,
  async test(c) {
    needKeys(c, 'api_id', 'api_token');
    const r = await api(c, 'wilayas/?page_size=1');
    return { ok: true, message: `Connexion réussie à ${c.name}${r?.total_data ? ` (${r.total_data} wilayas)` : ''}.` };
  },
  async create(c, p, helpers) {
    needKeys(c, 'api_id', 'api_token');
    const ws = await wilayas(c);
    const wname = (id: number) => {
      const w = ws.find((x) => Number(x.id) === yw(id));
      if (!w) throw new CourierError(`Wilaya ${id} inconnue chez ${c.name}`);
      return w.name as string;
    };
    const from = Number(c.settings.from_wilaya_id || c.shop.fromWilayaId);
    let commune: string;
    let toWilaya = p.wilaya_id;
    let deskId: number | null = null;
    if (p.is_stopdesk) {
      if (!p.stopdesk_ext_id) throw new CourierError(`Choisissez le bureau ${c.name} (stop desk) de la commande`);
      deskId = Number(p.stopdesk_ext_id);
      let center = ((await api(c, `centers/?center_id=${deskId}`)).data ?? [])[0];
      if (!center) center = (await all(c, `centers/?wilaya_id=${yw(p.stopdesk_wilaya_id || p.wilaya_id)}`)).find((x) => Number(x.center_id) === deskId);
      if (!center) throw new CourierError(`Bureau ${c.name} introuvable : réimportez les stop desks`);
      commune = center.commune_name;
      toWilaya = Number(center.wilaya_id);
    } else {
      const m = await helpers.communeName(p, async (w) => (await all(c, `communes/?wilaya_id=${yw(w)}`)).map((x) => ({ id: x.id, name: x.name as string })), `yal:${cacheKeyOf(c)}`);
      if (!m) throw new CourierError(`Commune « ${p.commune} » introuvable chez ${c.name} : corrigez la commune`);
      commune = m.name;
    }
    const n = splitName(p.customer_name);
    const dims = c.settings.dims ?? {};
    const parcel = {
      order_id: p.ref,
      from_wilaya_name: wname(from),
      firstname: cut(n.first, 60),
      familyname: cut(n.last, 60),
      contact_phone: [p.phone, p.phone2].filter(Boolean).join(','),
      address: cut(p.address || commune, 250),
      to_commune_name: commune,
      to_wilaya_name: wname(toWilaya),
      product_list: cut(p.products, 250),
      price: Math.min(150000, Math.round(p.total)),
      do_insurance: false,
      declared_value: Math.min(150000, Math.round(p.subtotal)),
      length: Number(dims.length) || 30,
      width: Number(dims.width) || 20,
      height: Number(dims.height) || 10,
      weight: Math.max(1, Math.round(p.weight || 1)),
      freeshipping: true,
      is_stopdesk: p.is_stopdesk,
      stopdesk_id: deskId,
      has_exchange: p.is_exchange,
      product_to_collect: p.is_exchange ? cut(`Échange : ${p.products}`, 250) : null,
    };
    const r = await api(c, 'parcels/', { method: 'POST', json: [parcel] });
    const one = r && (r[p.ref] || Object.values(r)[0]);
    if (!one || !one.success) throw new CourierError(`${c.name} : ${one?.message || 'colis refusé'}`);
    return { tracking: one.tracking, extId: one.import_id ? String(one.import_id) : null, labelUrl: one.label || null };
  },
  async track(c, items) {
    const out = [];
    for (const group of chunks(items, 50)) {
      if (timeUp()) break;
      const rows = await all(c, `parcels/?fields=tracking,last_status,date_last_status,weight,delivery_fee,taxe_retour,return_fee&tracking=${group.map((g) => encodeURIComponent(g.tracking)).join(',')}`);
      for (const r of rows) {
        const it = group.find((g) => g.tracking === r.tracking);
        if (it && r.last_status) out.push({ id: it.id, status: r.last_status, at: r.date_last_status ?? null, ...weighed(r) });
      }
    }
    return out;
  },
  async cancel(c, it) {
    const r = await api(c, `parcels/${encodeURIComponent(it.tracking)}`, { method: 'DELETE' });
    const one = Array.isArray(r) ? r[0] : r;
    if (one && one.deleted === false) throw new CourierError(`${c.name} refuse : le colis n’est plus « En préparation »`);
  },
  async label(c, it) {
    const r = await api(c, `parcels/${encodeURIComponent(it.tracking)}`);
    const one = r?.data?.[0] ?? r;
    return one?.label ? { url: one.label } : null;
  },
  async fees(c) {
    needKeys(c, 'api_id', 'api_token');
    const from = Number(c.settings.from_wilaya_id || c.shop.fromWilayaId);
    const ws = (await wilayas(c)).filter((w) => w.is_deliverable !== 0 && w.is_deliverable !== false);
    // per commune prices: keep the most common one for the wilaya
    const mode = (vals: number[]) => {
      const m = new Map<number, number>();
      vals.forEach((v) => m.set(v, (m.get(v) ?? 0) + 1));
      return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const out = [];
    for (const w of ws) {
      if (timeUp()) break;
      const r = await api(c, `fees/?from_wilaya_id=${yw(from)}&to_wilaya_id=${w.id}`);
      await sleep(1000);
      const per = Object.values(r?.per_commune ?? {}) as any[];
      out.push({
        wilayaId: Number(w.id),
        home: mode(per.map((x) => Number(x.express_home)).filter((x) => x > 0)),
        desk: mode(per.map((x) => Number(x.express_desk)).filter((x) => x > 0)),
        returnFee: Number(r?.retour_fee) || null,
      });
    }
    return out;
  },
  async stopdesks(c) {
    needKeys(c, 'api_id', 'api_token');
    return (await all(c, 'centers/')).map((x) => ({ extId: String(x.center_id), name: x.name, wilayaId: Number(x.wilaya_id) || null, commune: x.commune_name ?? null, address: x.address ?? null }));
  },
  parcel(c, it) {
    return parcelInfo(c, it.tracking);
  },
  change(c, i, helpers, p) {
    return changeDirect(c, i, helpers, p);
  },
  async states() {
    return Object.keys(STATUSES).map((k) => ({ key: k, label: k, color: null }));
  },
  // Yalidine webhooks are added by the user in Yalidine's dashboard (no API): nothing to do remotely, the lead shows the URL to paste.
  webhook: {
    async on() {
      return { extId: 'manual' };
    },
    async off() {
      /* removed by the user in Yalidine's dashboard */
    },
    async get() {
      return { on: true, url: null };
    },
  },
};
