// NOEST Express. Auth: Authorization: Bearer <api_token> + api_token and user_guid in each POST body
// (NOEST space → API). Base https://app.noest-dz.com/api/public.
// Ported from the original Pilotix adapter. Endpoints: POST create/order, POST valid/order, POST get/trackings/info, POST delete/order,
// GET get/order/label?tracking= (PDF), GET desks.
// BEST GUESS (check with real keys): the fees endpoint — NOEST did not document one; we try /fees, /get/fees, /tarifs.
import type { CourierAdapter, CourierCompany } from './types';
import { baseUrl, chunks, CourierError, cut, errText, flag, http, HttpOpts, humanize, needKeys, sleep, timeUp } from './util';

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
        if (last) out.push({ id: it.id, key: last.event_key, status: last.event || humanize(last.event_key), at: last.date ?? null });
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
};
