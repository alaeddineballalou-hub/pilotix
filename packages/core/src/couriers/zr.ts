// ZR Express — new platform (api.zrexpress.app).
// Auth: headers X-Api-Key + X-Tenant (ZR space → Paramètres → API).
// Ported from the original Pilotix adapter, which was used in production with real keys.
// Endpoints: POST /api/v1/territories/search, /hubs/search, /customers/individual, /parcels, GET /parcels/{id},
// DELETE /parcels/bulk/by-tracking-number, POST /parcels/labels/individual/pdf, GET /delivery-pricing/rates,
// Réclamations (from ZR's API documentation): POST /claim-categories/search → {items:[{id,name}]},
// POST /claims {categoryId, title, description, parcelId (ZR parcel UUID)} → {id}, POST /claims/{id} {claimId} → claim with
// state {name, description, isLocked}, PATCH /claim-comments/{id} {claimId, comment}, POST /claim-comments/{id}/search → {items:[{content, createdAt}]}.
// BEST GUESS (check with real keys): the "state.name" values in STATUSES below come from ZR's dashboard wording;
// unknown ones are shown as-is and can be mapped by hand with the "Statuts" button.
import type { ClaimCategory, ClaimState, CourierAdapter, CourierCompany, Desk } from './types';
import { baseUrl, bestMatch, CourierError, cut, http, intl, needKeys, timeUp } from './util';

const STATUSES: CourierAdapter['statuses'] = {
  commande_recue: null, en_traitement: null, appel_confirmation: null, commande_confirmee: null, en_preparation: null, pret_a_expedier: null,
  confirme_au_bureau: 'shipped', confirme_chez_partenaire: 'shipped', dispatch: 'shipped', vers_wilaya: 'shipped',
  en_livraison: 'out_for_delivery', sortie_en_livraison: 'out_for_delivery', disponible_bureau: 'out_for_delivery', en_attente_client: 'out_for_delivery',
  echec_livraison: 'failed', livre: 'delivered', encaisse: 'delivered', recouvert: 'delivered',
  retourne: 'returning', retour_confirme: 'returning', retour_sous_traitant: 'returning', colis_recupere: 'returning', attente_recuperation_fournisseur: 'returning',
  recupere_par_fournisseur: 'returned', reinjecte_dans_stock: 'returned', remboursement_reinjecte: 'returned', annule: null,
};

const h = (c: CourierCompany) => ({ 'X-Api-Key': String(c.secret.api_key ?? '').trim(), 'X-Tenant': String(c.secret.tenant ?? '').trim() });
const url = (c: CourierCompany, path: string) => baseUrl(c, 'https://api.zrexpress.app', '/api/v1') + path;

const cache = new Map<string, any[]>();
async function territories(c: CourierCompany, level: 'wilaya' | 'commune') {
  const key = `${c.id}:${level}`;
  if (cache.has(key)) return cache.get(key)!;
  const out: any[] = [];
  let filtered = true;
  const page = (n: number, f: boolean) =>
    http(c.name, url(c, '/territories/search'), {
      method: 'POST',
      headers: h(c),
      json: { keyword: '', pageNumber: n, pageSize: 1000, ...(f ? { advancedFilter: { logic: 'and', filters: [{ field: 'level', operator: 'eq', value: level }] } } : {}) },
    });
  for (let n = 1; n < 10; n++) {
    let r: any;
    try {
      r = await page(n, filtered);
    } catch (e) {
      if (filtered && n === 1) {
        filtered = false;
        r = await page(n, false);
      } else throw e;
    }
    out.push(...(r.items ?? []));
    if (!r.hasNext) break;
  }
  const list = out.filter((t) => t.level === level);
  cache.set(key, list);
  return list;
}
async function hubs(c: CourierCompany) {
  const key = `${c.id}:hubs`;
  if (cache.has(key)) return cache.get(key)!;
  const out: any[] = [];
  for (let n = 1; n < 10; n++) {
    const r = await http(c.name, url(c, '/hubs/search'), { method: 'POST', headers: h(c), json: { pageNumber: n, pageSize: 200 } });
    out.push(...(r.items ?? []));
    if (!r.hasNext || !(r.items ?? []).length) break;
  }
  cache.set(key, out);
  return out;
}

/** Words of our reasons that should find ZR's category (when the user did not choose one). */
const REASON_HINTS: Record<string, string[]> = {
  relivrer: ['relivraison', 'nouvelle tentative', 'livraison'],
  late: ['retard', 'delai', 'livraison'],
  nocall: ['appel', 'injoignable', 'livreur'],
  fakedeliv: ['faux', 'livre', 'statut'],
  fakeret: ['faux', 'retour', 'statut'],
  address: ['adresse', 'modification'],
  damaged: ['endommage', 'casse', 'abime'],
  money: ['paiement', 'versement', 'argent', 'encaissement'],
  noreturn: ['retour', 'non recu'],
  other: ['autre'],
};

async function loadClaimCats(c: CourierCompany): Promise<ClaimCategory[]> {
  const key = `${c.id}:claimcat`;
  if (cache.has(key)) return cache.get(key)!;
  const r = await http(c.name, url(c, '/claim-categories/search'), { method: 'POST', headers: h(c), json: { keyword: '', pageNumber: 1, pageSize: 200 } });
  const list = ((r?.items ?? []) as any[]).map((x) => ({ id: String(x.id), name: String(x.name || x.nameEnglish || x.nameArabic || x.id) }));
  cache.set(key, list);
  return list;
}

const RESOLVED = /(r[ée]solu|r[ée]gl|cl[ôo]tur|ferm[ée]|closed|resolved|termin[ée])/i;

export const zr: CourierAdapter = {
  statuses: STATUSES,
  async test(c) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, '/territories/search'), { method: 'POST', headers: h(c), json: { keyword: 'alger', pageSize: 1, pageNumber: 1 } });
    return { ok: true, message: `Connexion réussie à ${c.name} (ZR Express).` };
  },
  async create(c, p, helpers) {
    needKeys(c, 'api_key', 'tenant');
    let address: Record<string, unknown>;
    let hubId: string | undefined;
    if (p.is_stopdesk) {
      if (!p.stopdesk_ext_id) throw new CourierError('Choisissez le bureau ZR (stop desk) de la commande');
      const hub = (await hubs(c)).find((x) => String(x.id) === String(p.stopdesk_ext_id));
      if (!hub) throw new CourierError(`Bureau ZR introuvable : réimportez les stop desks de ${c.name}`);
      hubId = hub.id;
      address = { cityTerritoryId: hub.address?.cityTerritoryId, districtTerritoryId: hub.address?.districtTerritoryId, street: cut(p.address || hub.name, 200) };
    } else {
      const w = (await territories(c, 'wilaya')).find((t) => Number(t.code) === Number(p.wilaya_id));
      if (!w) throw new CourierError(`ZR ne livre pas la wilaya ${p.wilaya_id}`);
      const com = await helpers.communeName(p, async () => (await territories(c, 'commune')).filter((t) => t.parentId === w.id).map((t) => ({ id: t.id, name: t.name })), `zr:${c.id}:${w.id}`);
      if (!com) throw new CourierError(`Commune « ${p.commune} » introuvable chez ZR : corrigez la commune`);
      address = { cityTerritoryId: w.id, districtTerritoryId: com.id, street: cut(p.address || p.commune, 200) };
    }
    const phone = { number1: intl(p.phone), ...(p.phone2 ? { number2: intl(p.phone2) } : {}) };
    const customer = await http(c.name, url(c, '/customers/individual'), { method: 'POST', headers: h(c), json: { name: cut(p.customer_name || 'Client', 100), phone } });
    const body: Record<string, unknown> = {
      customer: { customerId: customer.id, name: cut(p.customer_name || 'Client', 100), phone },
      deliveryAddress: address,
      deliveryType: p.is_stopdesk ? 'pickup-point' : 'home',
      amount: Math.round(p.total),
      description: cut(p.products, 100),
      externalId: p.ref,
      orderedProducts: p.items.map((i) => ({ productName: cut(i.name, 100), unitPrice: Math.round(i.price), quantity: i.qty, stockType: c.settings.stock_type || 'none', ...(i.sku ? { productSku: cut(i.sku, 50) } : {}) })),
      weight: { weight: Math.max(1, Math.round(p.weight || 1)) },
    };
    if (hubId) body.hubId = hubId;
    const r = await http(c.name, url(c, '/parcels'), { method: 'POST', headers: h(c), json: body });
    const id = r?.id || r?.parcelId;
    if (!id) throw new CourierError('ZR n’a pas renvoyé d’identifiant de colis');
    const parcel = await http(c.name, url(c, `/parcels/${id}`), { headers: h(c) });
    return { tracking: parcel.trackingNumber || String(id), extId: String(id), labelUrl: null };
  },
  async track(c, items) {
    const out = [];
    for (const it of items) {
      if (timeUp()) break;
      let r: any;
      try {
        r = await http(c.name, url(c, `/parcels/${encodeURIComponent(it.extId || it.tracking)}`), { headers: h(c) });
      } catch (e: any) {
        if (String(e.message).includes('refuse les clés') || e.status === 429) throw e;
        continue;
      }
      const key = r.state && (r.state.name || r.state.code) ? String(r.state.name || r.state.code) : null;
      if (!key) continue;
      const situation = r.situation && (r.situation.name || r.situation.description);
      const mapped = STATUSES[key];
      out.push({ id: it.id, key, status: (r.state.description || key) + (situation ? ` · ${situation}` : ''), at: r.lastStateUpdateAt ?? null, mapped: r.isReturn && mapped !== 'returned' ? ('returning' as const) : undefined });
    }
    return out;
  },
  async cancel(c, it) {
    const r = await http(c.name, url(c, '/parcels/bulk/by-tracking-number'), { method: 'DELETE', headers: h(c), json: { trackingNumbers: [it.tracking] } });
    if (r?.failureCount) throw new CourierError(`ZR refuse : ${r.failures?.[0]?.errorMessage || 'colis déjà pris en charge'}`);
  },
  async label(c, it) {
    const r = await http(c.name, url(c, '/parcels/labels/individual/pdf'), { method: 'POST', headers: h(c), json: { trackingNumbers: [it.tracking], format: c.settings.label_format || 'a6' } });
    const f = (r.parcelLabelFiles ?? [])[0];
    return f ? { url: f.fileUrl } : null;
  },
  async fees(c) {
    needKeys(c, 'api_key', 'tenant');
    const r = await http(c.name, url(c, '/delivery-pricing/rates'), { headers: h(c) });
    const out = [];
    for (const rate of r.rates ?? []) {
      if (rate.toTerritoryLevel && rate.toTerritoryLevel !== 'wilaya') continue;
      const w = Number(rate.toTerritoryCode);
      if (!(w >= 1 && w <= 69)) continue;
      const price = (type: string) => {
        const x = (rate.deliveryPrices ?? []).find((d: any) => d.deliveryType === type);
        return x ? Number(x.priceTtc ?? x.discountedPrice ?? x.price) || null : null;
      };
      out.push({ wilayaId: w, home: price('home'), desk: price('pickup-point'), returnFee: price('return') });
    }
    return out;
  },
  async claimCategories(c) {
    needKeys(c, 'api_key', 'tenant');
    return loadClaimCats(c);
  },
  async claim(c, i) {
    needKeys(c, 'api_key', 'tenant');
    const cats = await loadClaimCats(c);
    let categoryId = i.categoryId && cats.some((x) => x.id === i.categoryId) ? i.categoryId : null;
    if (!categoryId) {
      const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const exact = bestMatch(i.reasonText, cats.map((x) => x.name));
      const hit = exact ? cats.find((x) => x.name === exact) : (REASON_HINTS[i.reason] ?? []).map((w) => cats.find((x) => norm(x.name).includes(w))).find(Boolean);
      categoryId = (hit ?? cats.find((x) => /autre|other/i.test(x.name)) ?? cats[0])?.id ?? null;
    }
    if (!categoryId) throw new CourierError('ZR n’a pas de catégorie de réclamation : vérifiez votre espace ZR');
    // ZR wants its own parcel UUID: the one kept at sending, else found from the tracking number
    let parcelId = i.item.extId;
    if (!parcelId) {
      const p = await http(c.name, url(c, `/parcels/${encodeURIComponent(i.item.tracking)}`), { headers: h(c) });
      parcelId = p?.id ? String(p.id) : null;
    }
    if (!parcelId) throw new CourierError(`Colis ${i.item.tracking} introuvable chez ZR`);
    const r = await http(c.name, url(c, '/claims'), {
      method: 'POST',
      headers: h(c),
      json: { categoryId, title: cut(`${i.reasonText} · ${i.item.tracking}`, 100), description: cut(i.description, 2000), parcelId },
    });
    const id = r?.id || (typeof r === 'string' ? r : null);
    if (!id) throw new CourierError('ZR n’a pas renvoyé de numéro de réclamation');
    let status: string | null = null;
    try {
      const g = await http(c.name, url(c, `/claims/${encodeURIComponent(id)}`), { method: 'POST', headers: h(c), json: { claimId: id } });
      status = g?.state?.description || g?.state?.name || null;
    } catch {
      /* the claim exists; its state comes with the next refresh */
    }
    return { extId: String(id), extRef: String(id).slice(0, 8).toUpperCase(), status };
  },
  async claimComment(c, extId, text) {
    needKeys(c, 'api_key', 'tenant');
    await http(c.name, url(c, `/claim-comments/${encodeURIComponent(extId)}`), { method: 'PATCH', headers: h(c), json: { claimId: extId, comment: cut(text, 2000) } });
  },
  async claimStates(c, ids) {
    needKeys(c, 'api_key', 'tenant');
    const out: ClaimState[] = [];
    for (const id of ids) {
      if (timeUp()) break;
      let g: any;
      try {
        g = await http(c.name, url(c, `/claims/${encodeURIComponent(id)}`), { method: 'POST', headers: h(c), json: { claimId: id } });
      } catch (e: any) {
        if (String(e.message).includes('refuse les clés') || e.status === 429) throw e;
        continue;
      }
      const name = String(g?.state?.name || '');
      const words = String(g?.state?.description || name);
      if (!words) continue;
      let answer: string | null = null;
      try {
        const cm = await http(c.name, url(c, `/claim-comments/${encodeURIComponent(id)}/search`), { method: 'POST', headers: h(c), json: { claimId: id, pageNumber: 1, pageSize: 100 } });
        const list = ((cm?.items ?? []) as any[]).filter((x) => String(x.content ?? '').trim());
        const last = list.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))).pop();
        answer = last ? `${last.modifiedBy?.fullName ? `${last.modifiedBy.fullName} : ` : ''}${String(last.content).trim()}` : null;
      } catch {
        /* comments are a bonus */
      }
      // a locked state is the end of ZR's workflow (solved / closed)
      out.push({ extId: id, status: words, resolved: !!g?.state?.isLocked || RESOLVED.test(name) || RESOLVED.test(words), at: g?.lastModifiedAt ?? null, answer });
    }
    return out;
  },
  async stopdesks(c) {
    needKeys(c, 'api_key', 'tenant');
    const [hs, ws] = await Promise.all([hubs(c), territories(c, 'wilaya')]);
    const code = new Map(ws.map((w: any) => [w.id, Number(w.code)]));
    return hs
      .filter((x: any) => x.isPickupPoint && x.isVisible !== false)
      .map((x: any): Desk => ({ extId: String(x.id), name: x.name, wilayaId: code.get(x.address?.cityTerritoryId) ?? null, commune: x.address?.district || x.address?.city || null, address: [x.address?.street, x.address?.district, x.address?.city].filter(Boolean).join(', ') || null }));
  },
};
