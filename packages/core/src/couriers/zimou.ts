// Zimou Express. Auth: Authorization: Bearer <api_token>. Base https://zimou.express/api.
// Endpoints (from vargo's ZimouExpressDriver, API v3): GET /v3/user (test), GET /v3/helpers/wilayas, GET /v3/helpers/communes,
// GET /v3/helpers/offices (stop desks), POST /v3/packages (create), GET /v3/packages?search= (find a package by tracking),
// GET /v3/packages/{id}, GET /v3/packages/{id}/histories, PUT /v3/packages/{id} (update), GET /v3/packages/status?packages[]=
// (many at once), DELETE /v3/packages/bulk?tracking_codes[]= (cancel), POST /v3/packages/labels (label, PDF or a URL),
// POST /v3/packages/mark-as-returned {trackings} (askReturn), POST /v3/orders/{order_id}/comments {description} (note),
// GET /v3/my/prices (fees).
// Zimou takes the wilaya and commune by NAME at creation (its own names, found in its lists); updates take commune_id.
// Payments: vargo only passes /v3/payments through without its fields, not enough to map balance / statements: not done.
// BEST GUESS (check with real keys): Zimou wilaya ids = Algerian wilaya codes; the answer shape of /v3/packages/status
// (an object keyed by tracking, or a list); the label answer (PDF, or JSON with a url); office_id on a PUT (Domicile ↔
// Stop desk); the order_id used for comments (vargo calls it Zimou's internal order id); which statuses can still be
// changed (only 1 « Nouveau »).
import { cacheKeyOf } from './types';
import type { ChangeInput, CourierAdapter, CourierCompany, Desk, Helpers, Parcel, ParcelInfo, TrackItem, TrackResult } from './types';
import { baseUrl, chunks, CourierError, cut, errText, http, HttpOpts, needKeys, query, sleep, splitName, timeUp } from './util';

const LABELS: Record<string, string> = {
  '1': 'Nouveau', '2': 'Expédié', '3': 'Livré', '4': 'Retourné', '5': 'Annulé', '6': 'En cours de livraison', '7': 'Centre de tri', '8': 'Échoué',
};
const STATUSES: CourierAdapter['statuses'] = {
  '1': null, '2': 'shipped', '3': 'delivered', '4': 'returned', '5': null, '6': 'out_for_delivery', '7': 'shipped', '8': 'failed',
  Nouveau: null, Expédié: 'shipped', Livré: 'delivered', Retourné: 'returned', Annulé: null, 'En cours de livraison': 'out_for_delivery',
  'Centre de tri': 'shipped', Échoué: 'failed', 'En retour': 'returning', 'Retour en cours': 'returning', Perdu: 'lost',
};

const DEFAULT = 'https://zimou.express/api';
const auth = (c: CourierCompany) => ({ Authorization: `Bearer ${String(c.secret.api_token ?? '').trim()}` });
const listOf = (r: any): any[] => (Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : Array.isArray(r?.data?.data) ? r.data.data : []);
const num = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const refused = (e: any) => String(e?.message).includes('refuse les clés') || e?.status === 429;
/** a[]=x&a[]=y */
const arr = (k: string, v: string[]) => v.map((x) => `${encodeURIComponent(k)}[]=${encodeURIComponent(x)}`).join('&');

async function api(c: CourierCompany, path: string, o: HttpOpts & { q?: Record<string, unknown> | string } = {}) {
  needKeys(c, 'api_token');
  const qs = typeof o.q === 'string' ? o.q : o.q ? query(o.q) : '';
  const r = await http(c.name, baseUrl(c, DEFAULT) + path + (qs ? `?${qs}` : ''), { ...o, headers: { ...auth(c), ...(o.headers ?? {}) } });
  await sleep(300);
  if (!o.binary && r && typeof r === 'object' && Number(r.error) > 0) throw new CourierError(`${c.name} : ${errText(r.message || r.errors) || 'refusé'}`);
  return r;
}

// ---------------------------------------------------------------- wilayas, communes, offices
const cache = new Map<string, any[]>();
async function cached(c: CourierCompany, what: string, load: () => Promise<any[]>) {
  const key = `${cacheKeyOf(c)}:${what}`;
  if (!cache.has(key)) cache.set(key, await load());
  return cache.get(key)!;
}
const wilayas = (c: CourierCompany) => cached(c, 'w', async () => listOf(await api(c, '/v3/helpers/wilayas')).map((x) => ({ id: Number(x.id), name: String(x.name ?? '') })));
const communes = (c: CourierCompany) =>
  cached(c, 'c', async () => listOf(await api(c, '/v3/helpers/communes')).map((x) => ({ id: Number(x.id), name: String(x.name ?? ''), wilaya: Number(x.wilaya_id) })));

async function place(c: CourierCompany, p: Parcel, h: Helpers) {
  const com = await h.communeName(p, async (w) => (await communes(c)).filter((x) => x.wilaya === w), `zimou:${cacheKeyOf(c)}`);
  if (!com) throw new CourierError(`Commune « ${p.commune || p.stopdesk_commune || '?'} » introuvable chez ${c.name} : corrigez la commune`);
  const w = (await wilayas(c)).find((x) => x.id === p.wilaya_id);
  return { commune: com, wilaya: w?.name || p.wilaya };
}

// ---------------------------------------------------------------- one package
/** Zimou's package (its numeric id is kept as extId; else found by tracking code) */
async function pkg(c: CourierCompany, it: TrackItem): Promise<any> {
  if (it.extId) {
    const r = await api(c, `/v3/packages/${encodeURIComponent(it.extId)}`);
    return r?.data ?? r;
  }
  const list = listOf(await api(c, '/v3/packages', { q: { search: it.tracking } }));
  const hit = list.find((x) => x?.tracking_code === it.tracking || x?.delivery_company_tracking_code === it.tracking);
  if (!hit) throw new CourierError(`Colis ${it.tracking} introuvable chez ${c.name}`, 404);
  return hit;
}
const statusKey = (x: any) => String(x?.status_id ?? x?.status?.id ?? (typeof x?.status === 'number' ? x.status : '') ?? '');
const statusWord = (x: any) => String(x?.status?.name ?? (typeof x?.status === 'string' ? x.status : '') ?? '') || LABELS[statusKey(x)] || '';

async function parcelInfo(c: CourierCompany, it: TrackItem): Promise<ParcelInfo> {
  const p = await pkg(c, it);
  let hist: any[] = [];
  try {
    const r = await api(c, `/v3/packages/${encodeURIComponent(String(p.id))}/histories`);
    hist = listOf(typeof r?.data === 'string' ? JSON.parse(r.data) : r);
  } catch (e: any) {
    if (refused(e)) throw e;
  }
  const key = statusKey(p);
  const open = key === '1';
  const com = (await communes(c).catch(() => [])).find((x) => x.id === Number(p.commune_id));
  const w = com ? (await wilayas(c).catch(() => [])).find((x) => x.id === com.wilaya) : null;
  const desk = /relais/i.test(String(p.delivery_type?.name ?? p.delivery_type ?? ''));
  return {
    state: statusWord(p) || null,
    color: p.status?.color ?? null,
    situation: p.situation?.name ?? (typeof p.situation === 'string' ? p.situation : null),
    livreur: p.deliverer?.name || p.driver?.name ? { name: String(p.deliverer?.name || p.driver?.name), phone: p.deliverer?.phone ?? p.driver?.phone ?? null, hub: null } : null,
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
    delivery: { type: desk ? 'Point relais' : 'A domicile', hub: p.office?.name ?? null, city: w?.name ?? null, district: com?.name ?? null, street: p.address ?? null },
    amount: num(p.price),
    deliveryPrice: num(p.delivery_price),
    returnPrice: num(p.return_price),
    swap: null,
    history: hist
      .filter((x) => x && x.created_at)
      .map((x) => ({
        at: String(x.created_at),
        status: LABELS[String(x.status_id ?? '')] || String(x.status?.name ?? x.description ?? x.status_id ?? ''),
        color: x.status?.color ?? null,
        hub: x.hub?.name ?? x.office?.name ?? null,
        by: x.user?.name ?? null,
        comment: x.comment ?? (x.status_id != null && x.description ? x.description : null),
        situations: x.situation?.name ? [{ name: String(x.situation.name), at: String(x.created_at) }] : [],
      }))
      .filter((x) => x.status)
      .sort((a, b) => b.at.localeCompare(a.at)),
    sms: [],
  };
}

async function change(c: CourierCompany, i: ChangeInput, h: Helpers, p: Parcel | null) {
  const cur = await pkg(c, i.item);
  const key = statusKey(cur);
  if (key && key !== '1') throw new CourierError(`${c.name} : colis déjà pris en charge (${statusWord(cur) || key}), modifiez-le depuis l’espace Zimou`);
  const body: Record<string, unknown> = {};
  if (i.kind === 'amount') {
    if (i.amount == null || !(i.amount >= 0)) throw new CourierError('Le nouveau montant manque');
    body.price = Math.round(i.amount);
  } else if (i.kind === 'phone') {
    if (!i.phone) throw new CourierError('Le nouveau numéro manque');
    body.client_phone = cut(i.phone, 20);
    if (i.phone2) body.client_phone2 = cut(i.phone2, 20);
  } else {
    if (!p) throw new CourierError('Commande introuvable');
    const next: Parcel = {
      ...p,
      is_stopdesk: i.kind === 'delivery' ? !!i.stopdesk : p.is_stopdesk,
      stopdesk_ext_id: i.kind === 'delivery' && i.stopdesk ? (i.hubExtId ?? null) : p.stopdesk_ext_id,
      wilaya_id: i.wilayaId ?? p.wilaya_id,
      commune: i.commune ?? p.commune,
      address: i.address ?? p.address,
    };
    if (next.is_stopdesk && !next.stopdesk_ext_id) throw new CourierError(`Choisissez le point relais ${c.name}`);
    const { commune } = await place(c, next, h);
    body.commune_id = commune.id;
    body.address = cut(next.address || commune.name, 500);
    if (i.kind === 'delivery') {
      body.delivery_type = next.is_stopdesk ? 'Point relais' : 'A domicile';
      if (next.is_stopdesk) body.office_id = Number(next.stopdesk_ext_id);
    }
    if (i.amount != null && i.amount >= 0) body.price = Math.round(i.amount);
  }
  await api(c, `/v3/packages/${encodeURIComponent(String(cur.id))}`, { method: 'PUT', json: body });
  return { extId: `direct:${cur.id}:${Date.now()}`, approved: true, direct: true };
}

/** Zimou answers a label with the PDF itself, or JSON giving its address */
async function labelOf(c: CourierCompany, trackings: string[], ids: (string | null)[]) {
  const pid = ids.filter((x): x is string => !!x).map(Number);
  const r = await api(c, '/v3/packages/labels', { method: 'POST', json: { tracking_codes: trackings, ...(pid.length ? { package_ids: pid, ids: pid } : {}) }, binary: true, timeout: 60_000 });
  if (r?.pdf && /json/i.test(String(r.type))) {
    let j: any = null;
    try {
      j = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.pdf), (ch) => ch.charCodeAt(0))));
    } catch {
      /* not JSON after all */
    }
    const u = j?.url ?? j?.data?.url ?? (typeof j?.data === 'string' ? j.data : null) ?? j?.pdf;
    if (typeof u === 'string' && /^https?:\/\//.test(u)) return { url: u };
    throw new CourierError(`${c.name} : ${errText(j) || 'pas d’étiquette'}`);
  }
  return r;
}

export const zimou: CourierAdapter = {
  statuses: STATUSES,
  parcel: parcelInfo,
  change,
  async test(c) {
    const r = await api(c, '/v3/user');
    const who = r?.data?.name ?? r?.name;
    return { ok: true, message: `Connexion réussie à ${c.name} (Zimou Express)${who ? ` : ${who}` : ''}.` };
  },
  async create(c, p, h) {
    needKeys(c, 'api_token');
    if (p.is_stopdesk && !p.stopdesk_ext_id) throw new CourierError(`Choisissez le point relais ${c.name} de la commande`);
    const { commune, wilaya } = await place(c, p, h);
    const n = splitName(p.customer_name || 'Client');
    const body = {
      type: 'ecommerce',
      name: cut(p.products || 'Produit', 255),
      client_last_name: cut(n.last, 255),
      client_first_name: cut(n.first, 255),
      client_phone: p.phone,
      client_phone2: p.phone2 || undefined,
      address: cut(p.address || commune.name || '-', 500),
      order_id: p.ref,
      price: String(Math.round(p.total)),
      free_delivery: 'false',
      quantity_items: Math.max(1, p.pieces || 1),
      delivery_type: p.is_stopdesk ? 'Point relais' : 'A domicile',
      wilaya,
      commune: commune.name,
      office_id: p.is_stopdesk ? Number(p.stopdesk_ext_id) : undefined,
      can_be_opened: true,
      observation: cut(p.delivery_note, 500) || undefined,
      returned_product: p.is_exchange ? cut(p.products, 255) : undefined,
      weight: Math.max(1, p.weight || 1),
    };
    const r = await api(c, '/v3/packages', { method: 'POST', json: body });
    const d = r?.data ?? r;
    if (!d?.tracking_code) throw new CourierError(`${c.name} : pas de numéro de suivi (${errText(r) || 'réponse vide'})`);
    return { tracking: String(d.tracking_code), extId: d.id != null ? String(d.id) : null, labelUrl: null };
  },
  async track(c, items) {
    const out: TrackResult[] = [];
    const done = new Set<number>();
    try {
      for (const group of chunks(items, 50)) {
        if (timeUp()) break;
        const r = await api(c, '/v3/packages/status', { q: arr('packages', group.map((g) => g.tracking)) });
        const data = r?.data ?? r ?? {};
        const byTracking = new Map<string, any>();
        if (Array.isArray(data)) for (const x of data) byTracking.set(String(x?.tracking_code ?? x?.delivery_company_tracking_code ?? ''), x);
        else for (const [k, v] of Object.entries(data)) byTracking.set(k, v);
        for (const it of group) {
          const x = byTracking.get(it.tracking);
          if (x == null) continue;
          const key = typeof x === 'object' ? statusKey(x) || statusWord(x) : String(x);
          if (!key) continue;
          const words = typeof x === 'object' ? statusWord(x) : LABELS[key] || key;
          out.push({ id: it.id, key, status: words || key, at: typeof x === 'object' ? (x.updated_at ?? x.status_updated_at ?? null) : null });
          done.add(it.id);
        }
      }
    } catch (e: any) {
      if (refused(e)) throw e;
    }
    // parcels the status list did not answer: one by one
    for (const it of items.filter((x) => !done.has(x.id))) {
      if (timeUp()) break;
      try {
        const p = await pkg(c, it);
        const key = statusKey(p) || statusWord(p);
        if (key) out.push({ id: it.id, key, status: statusWord(p) || key, at: p.updated_at ?? null });
      } catch (e: any) {
        if (refused(e)) throw e;
        out.push({ id: it.id, status: '', error: String(e?.message ?? 'Erreur').slice(0, 200) });
      }
    }
    return out;
  },
  async cancel(c, it) {
    const r = await api(c, '/v3/packages/bulk', { method: 'DELETE', q: arr('tracking_codes', [it.tracking]) });
    const ok = ((r?.deleted ?? r?.data?.deleted ?? []) as unknown[]).map(String).includes(it.tracking);
    if (!ok) throw new CourierError(`${c.name} refuse : ${r?.not_deleted?.[0]?.message || r?.data?.not_deleted?.[0]?.message || 'colis déjà pris en charge'}`);
  },
  async label(c, it) {
    return labelOf(c, [it.tracking], [it.extId]);
  },
  async labels(c, items) {
    return { label: await labelOf(c, items.map((i) => i.tracking), items.map((i) => i.extId)), failed: [] };
  },
  async askReturn(c, it) {
    await api(c, '/v3/packages/mark-as-returned', { method: 'POST', json: { trackings: [it.tracking] } });
  },
  async note(c, it, text) {
    const p = await pkg(c, it);
    const orderId = p?.order_id;
    if (!orderId) throw new CourierError(`${c.name} : commande du colis introuvable`);
    await api(c, `/v3/orders/${encodeURIComponent(String(orderId))}/comments`, { method: 'POST', json: { description: cut(text, 1000) } });
  },
  async stopdesks(c) {
    const [offices, coms] = await Promise.all([api(c, '/v3/helpers/offices'), communes(c)]);
    const byId = new Map(coms.map((x) => [x.id, x]));
    return listOf(offices)
      .filter((o) => o && o.id != null)
      .map((o): Desk => {
        const com = byId.get(Number(o.commune_id));
        return { extId: String(o.id), name: String(o.name ?? o.id), wilayaId: com?.wilaya ?? (num(o.wilaya_id) || null), commune: com?.name ?? null, address: o.address ?? null };
      });
  },
  async fees(c) {
    const r = await api(c, '/v3/my/prices');
    const rows = new Map<number, { wilayaId: number; home: number | null; desk: number | null; returnFee: number | null }>();
    for (const t of listOf(r)) {
      const desk = /relais|desk|bureau/i.test(String(t?.name ?? ''));
      for (const g of t?.prices ?? [])
        for (const w of g?.wilayas ?? []) {
          const id = Number(w?.id);
          const price = num(w?.pivot?.price);
          if (!(id >= 1 && id <= 69)) continue;
          const row = rows.get(id) ?? { wilayaId: id, home: null, desk: null, returnFee: null };
          if (desk) row.desk ??= price;
          else row.home ??= price;
          rows.set(id, row);
        }
    }
    return [...rows.values()].sort((a, b) => a.wilayaId - b.wilayaId);
  },
};
