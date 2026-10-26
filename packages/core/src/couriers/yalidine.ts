// Yalidine (and companies on the same platform, e.g. Guepex: base_url https://api.guepex.app/v1/).
// Auth: headers X-API-ID + X-API-TOKEN (Yalidine → Développement → Gestionnaire d’API). Base https://api.yalidine.app/v1/.
// Ported from the original Pilotix adapter. Endpoints: wilayas/, communes/?wilaya_id=, centers/, parcels/ (POST array, GET ?tracking=,
// DELETE parcels/{tracking}), fees/?from_wilaya_id=&to_wilaya_id=. Yalidine limits the request rate: we wait between calls.
// Yalidine only knows the 58 historic wilayas; wilayas 59–69 are sent as their parent wilaya.
import { NEW_WILAYA_PARENT } from '@pilotix/shared';
import { cacheKeyOf } from './types';
import type { CourierAdapter, CourierCompany } from './types';
import { baseUrl, chunks, CourierError, cut, http, HttpOpts, needKeys, sleep, splitName, timeUp } from './util';

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
      const rows = await all(c, `parcels/?fields=tracking,last_status,date_last_status&tracking=${group.map((g) => encodeURIComponent(g.tracking)).join(',')}`);
      for (const r of rows) {
        const it = group.find((g) => g.tracking === r.tracking);
        if (it && r.last_status) out.push({ id: it.id, status: r.last_status, at: r.date_last_status ?? null });
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
};
