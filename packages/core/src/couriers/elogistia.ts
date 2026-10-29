// Elogistia. Auth: the API key sent as the `key` query value on every call (and also in the JSON body of POSTs).
// Base https://api.elogistia.com. Ported from vargo's Elogistia driver. Endpoints:
// POST insertCommande (create), GET deleteOrder?tracking= (cancel), GET getTracking?tracking= (one parcel's history: body[]
// {Tracking, Statut, Date, Commune}), GET getManyTracking (many parcels), GET getOrders/{tracking} (the parcel: Nom, Prénom,
// Téléphone, Addresse, Commune, Wilaya, Frais de livraison, Status), GET printBordereau_10x15?tracking= (PDF label; 15x20 by
// setting label_format), GET getShippingCost (body[] {wilayaID, home, stopdesk}), GET getWilayas, getMunicipalities?wilaya=
// (body[] {commune_name}), getAgences (body[] {Nom du bureau, Code wilaya, Commune, Adresse}).
// No update endpoint in vargo (the capability is declared but not implemented): no change().
// BEST GUESS (check with real keys):
// - getManyTracking: its parameters are not in vargo; we send tracking=<t1,t2,…> and group the events by their Tracking,
//   then fall back to getTracking one by one for the parcels it did not answer.
// - getOrders/{tracking} (path form, as given); falls back to getOrders?tracking= (the form vargo really calls).
// - price = total − delivery fee, with the fee in fraisDeLivraison (vargo sends product prices + fraisDeLivraison apart).
// - wilaya sent by its NAME (vargo's test sends « Alger »); the stop desk is chosen by Elogistia from the commune
//   (insertCommande takes no office id: stop_desk 2 = desk, 1 = home).
// - mail is required by vargo's rules: we send settings.email, else a placeholder.
// - the status words (vargo's list) and their order: « À expédiée » before pick-up, « Réceptionnée » after it.
import { cacheKeyOf } from './types';
import type { CourierAdapter, CourierCompany, ParcelInfo, TrackItem, TrackResult } from './types';
import { baseUrl, chunks, CourierError, cut, errText, http, HttpOpts, needKeys, query, sleep, splitName, timeUp } from './util';

const STATUSES: CourierAdapter['statuses'] = {
  'À expédiée': null, 'A expédiée': null, 'À expédier': null, 'En attente': null, 'Nouvelle': null,
  Ramassée: 'shipped', Ramassé: 'shipped', Réceptionnée: 'shipped', Réceptionné: 'shipped',
  'En transit': 'shipped', 'En hub': 'shipped',
  'En cours livraison': 'out_for_delivery', 'En cours de livraison': 'out_for_delivery',
  Livré: 'delivered', Livrée: 'delivered', 'Livrée & réglée': 'delivered', 'Livré & réglé': 'delivered', 'Partiel remis': 'delivered',
  Suspendue: 'alert', Suspendu: 'alert',
  Annulée: 'failed', Annulé: 'failed',
  'Retour en transit': 'returning', 'Retour remis': 'returned',
  Perdue: 'lost', Perdu: 'lost',
};

const DEF = 'https://api.elogistia.com';
const key = (c: CourierCompany) => String(c.secret.api_key ?? '').trim();

async function api(c: CourierCompany, path: string, q: Record<string, unknown> = {}, o: HttpOpts = {}) {
  const qs = query({ key: key(c), ...q });
  const r = await http(c.name, `${baseUrl(c, DEF)}/${path}?${qs}`, o);
  await sleep(400);
  if (!o.binary && r && typeof r === 'object' && r.success === false) throw new CourierError(`${c.name} : ${errText(r.message || r.errors || r.error) || 'refusé'}`);
  return r;
}
const body = (r: any): any[] => (Array.isArray(r?.body) ? r.body : Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : []);

/** 0661… (Elogistia wants 9 or 10 digits). */
const phoneOf = (p: string | null | undefined) => {
  const d = String(p ?? '').replace(/\D/g, '').replace(/^213/, '');
  return d ? (d.startsWith('0') ? d : `0${d}`).slice(0, 10) : '';
};

/** « 2026-04-02 10:00:00 » or « 02/04/2026 10:00 » → sortable « 2026-04-02 10:00:00 ». */
const when = (s: unknown) => {
  const t = String(s ?? '').trim();
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}${m[4]}` : t;
};

type Ev = { tracking: string; status: string; at: string; place: string | null; raw: any };
const events = (list: any[]): Ev[] =>
  list
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ tracking: String(e.Tracking ?? e.tracking ?? ''), status: String(e.Statut ?? e.status ?? e.Status ?? '').trim(), at: when(e.Date ?? e.date), place: e.Commune ?? e.location ?? null, raw: e }))
    .filter((e) => e.status)
    .sort((a, b) => a.at.localeCompare(b.at));

const lastOf = (ev: Ev[]) => ev.at(-1) ?? null;

async function history(c: CourierCompany, tracking: string) {
  return events(body(await api(c, 'getTracking', { tracking })));
}

async function order(c: CourierCompany, tracking: string) {
  const r = await api(c, `getOrders/${encodeURIComponent(tracking)}`).catch((e) => {
    if (String(e.message).includes('refuse les clés')) throw e;
    return api(c, 'getOrders', { tracking });
  });
  const list = body(r);
  return list.find((x) => String(x?.Tracking ?? x?.tracking ?? '') === tracking) ?? list[0] ?? (r && !Array.isArray(r) && (r.Tracking || r.tracking) ? r : null);
}

export const elogistia: CourierAdapter = {
  statuses: STATUSES,
  async test(c) {
    needKeys(c, 'api_key');
    // getMunicipalities checks the key (401 « apiKey pas valide »); getWilayas answers 404 to a wrong key (checked Oct 2026)
    const r = await api(c, 'getMunicipalities', { wilaya: 16 });
    if (!body(r).length) return { ok: false, message: `${c.name} n’a rien répondu : vérifiez la clé API` };
    return { ok: true, message: `Connexion réussie à ${c.name} (Elogistia).` };
  },
  async create(c, p, helpers) {
    needKeys(c, 'api_key');
    const com = await helpers.communeName(
      p,
      async (w) => body(await api(c, 'getMunicipalities', { wilaya: w })).map((x: any) => ({ name: String(x.commune_name ?? x.name ?? '') })).filter((x) => x.name),
      `elogistia:${cacheKeyOf(c)}`,
    );
    const commune = com?.name || (p.is_stopdesk ? p.stopdesk_commune : null) || p.commune;
    if (!commune) throw new CourierError(`Commune manquante pour ${c.name}`);
    const phone = phoneOf(p.phone);
    if (!/^\d{9,10}$/.test(phone)) throw new CourierError(`${c.name} : numéro de téléphone invalide (${p.phone})`);
    const { first, last } = splitName(p.customer_name || 'Client');
    const fee = Math.max(0, Math.round(p.delivery_fee || 0));
    const json = {
      key: key(c),
      name: cut(last, 100),
      firstname: cut(first, 100),
      mail: String(c.settings.email || 'client@pilotix.app'),
      phone,
      address: cut(p.address || commune, 255),
      commune: cut(commune, 100),
      wilaya: p.wilaya,
      fraisDeLivraison: fee,
      remarque: cut(p.delivery_note, 255) || undefined,
      stop_desk: p.is_stopdesk ? 2 : 1,
      product: cut(p.products, 100) || 'Produit',
      price: Math.max(0, Math.round(p.total) - fee),
      modeDeLivraison: p.is_exchange ? 4 : 1,
      exchangeName: p.is_exchange ? cut(p.products, 100) : undefined,
      IdCommande: cut(p.ref, 255),
      poids: Math.max(1, p.weight || 1),
    };
    const r = await api(c, 'insertCommande', {}, { method: 'POST', json });
    const tracking = r?.tracking ?? r?.Tracking ?? r?.body?.tracking ?? r?.body?.Tracking ?? (Array.isArray(r?.body) ? r.body[0]?.tracking ?? r.body[0]?.Tracking : null);
    if (!tracking) throw new CourierError(`${c.name} : pas de numéro de suivi (${errText(r)})`);
    return { tracking: String(tracking), extId: null, labelUrl: null };
  },
  async track(c, items) {
    needKeys(c, 'api_key');
    const out: TrackResult[] = [];
    const done = new Set<number>();
    const push = (it: TrackItem, ev: Ev[]) => {
      const last = lastOf(ev);
      if (!last) return;
      out.push({ id: it.id, key: last.status, status: last.status + (last.place ? ` · ${last.place}` : ''), at: last.at || null });
      done.add(it.id);
    };
    let many = true;
    for (const group of chunks(items, 50)) {
      if (timeUp() || !many) break;
      try {
        const ev = events(body(await api(c, 'getManyTracking', { tracking: group.map((g) => g.tracking).join(',') })));
        for (const it of group) push(it, ev.filter((e) => e.tracking === it.tracking));
      } catch (e: any) {
        if (String(e.message).includes('refuse les clés')) throw e;
        many = false;
      }
    }
    for (const it of items.filter((x) => !done.has(x.id))) {
      if (timeUp()) break;
      try {
        push(it, await history(c, it.tracking));
      } catch (e: any) {
        if (e.status === 429 || String(e.message).includes('refuse les clés')) break;
        out.push({ id: it.id, status: '', error: e.message });
      }
    }
    return out;
  },
  async cancel(c, it) {
    needKeys(c, 'api_key');
    await api(c, 'deleteOrder', { tracking: it.tracking });
  },
  async label(c, it) {
    needKeys(c, 'api_key');
    const path = String(c.settings.label_format || '') === '15x20' ? 'printBordereau_15x20' : 'printBordereau_10x15';
    return api(c, path, { tracking: it.tracking }, { binary: true });
  },
  async fees(c) {
    needKeys(c, 'api_key');
    const r = await api(c, 'getShippingCost');
    return body(r)
      .map((x: any) => ({ wilayaId: Number(x.wilayaID ?? x.wilaya_id), home: Number(x.home) || null, desk: Number(x.stopdesk) || null, returnFee: null }))
      .filter((x) => x.wilayaId >= 1 && x.wilayaId <= 69);
  },
  async stopdesks(c) {
    needKeys(c, 'api_key');
    const r = await api(c, 'getAgences');
    return body(r)
      .filter((d: any) => d && d['Nom du bureau'])
      .map((d: any) => ({
        extId: String(d['Nom du bureau']),
        name: String(d['Nom du bureau']),
        wilayaId: Number(d['Code wilaya']) || null,
        commune: d.Commune ?? null,
        address: d.Adresse ?? null,
      }));
  },
  async parcel(c, it): Promise<ParcelInfo> {
    needKeys(c, 'api_key');
    const ev = await history(c, it.tracking);
    const o = await order(c, it.tracking).catch((e) => {
      if (String(e.message).includes('refuse les clés')) throw e;
      return null;
    });
    const last = lastOf(ev);
    const state = last?.status ?? (o ? String(o.Status ?? o.status ?? '') || null : null);
    const fee = o?.['Frais de livraison'];
    return {
      state,
      color: null,
      situation: null,
      livreur: null,
      risk: null,
      canModify: false,
      canChangePhone: false,
      direct: false,
      pendingChange: false,
      modifications: null,
      modificationLimit: null,
      phoneChanges: null,
      phoneChangeLimit: null,
      phoneChangePrice: null,
      delivery: {
        type: null,
        hub: null,
        city: o ? (o['Wilaya '] ?? o.Wilaya ?? null) : null,
        district: o ? (o['Commune '] ?? o.Commune ?? null) : null,
        street: o ? (o.Addresse ?? o.Adresse ?? null) : null,
      },
      amount: o?.Montant != null ? Number(o.Montant) || null : o?.Prix != null ? Number(o.Prix) || null : null,
      deliveryPrice: fee != null && fee !== '' ? Number(fee) || null : null,
      returnPrice: null,
      swap: null,
      history: ev
        .map((e) => ({ at: e.at, status: e.status, color: null, hub: e.place, by: null, comment: e.raw?.Commentaire ?? e.raw?.comment ?? null, situations: [] }))
        .filter((x) => x.at)
        .sort((x, y) => y.at.localeCompare(x.at)),
      sms: [],
    };
  },
};
