// E-COM Delivery. Auth: headers Token: <token> and Key: <key>. Base https://ecom-dz.net.
// Ported from vargo's EcomDelivery driver. Endpoints: GET Api_v1/Test (quota → keys OK), POST Api_v1/Colis {Colis:[…]} (create;
// answers Colis[] {Tracking, label, Commentaire…}), PUT Api_v1/Colis/{tracking} {Colis:{…}} (change), PUT Api_v1/aExpédier
// {Colis:[{Tracking}]} (validate / ready to ship), PUT Api_v1/Supprimer {Colis:[{Tracking}]} (cancel), GET Api_v1/Colis/Tracking/{t}
// (the parcel: Colis[0].Colis_Base), POST Api_v1/Colis/Liste {Colis:[{Tracking}]} (many parcels), GET Api_v1/Historique/Tracking/{t}
// (Historique[] {Date_Création, Situation, Avancement, Commentaire, Commune}), GET Api_v1/Commune/{wilaya} (Commune[] {Commune}),
// GET Api_v1/Stopdesk (Commune[] {Libelle, Code, Adresse, Commune, Ville}).
// Label: only given at creation (Colis[].label) → returned as labelUrl. No fees API, no label API afterwards.
// Two status words per parcel: « Avancement » (the stage: En Préparation → … → En livraison → Dispatcher) and « Situation »
// (the call result: EnCours, Ne Réponde pas #1, Annuler, Reporté, Recouvert…); we report the stage, or the situation when it says more.
// Quota ~40 requests/minute: we wait 1.6 s between calls.
// BEST GUESS (check with real keys):
// - « Dispatcher » = delivered (as vargo), « Récupérer » = return taken back by the shop (returned; vargo says delivered),
//   « Retour Fournisseur » = returning (vargo says shipped), « En Traitement » = picked up and being processed.
// - Api_v1/Colis/Liste answer items: plain parcels or wrapped in Colis_Base (both read); falls back to Colis/Tracking/{t}.
// - The update (PUT Api_v1/Colis/{t}) is sent with the whole parcel (as vargo); it has no wilaya / stop desk fields, so
//   only amount, phone and address (same wilaya) can change. Parcels can be changed while « En Préparation » only.
// - Dates come as « dd/mm/yyyy hh:mm:ss » and are turned into « yyyy-mm-dd hh:mm:ss ».
import { cacheKeyOf } from './types';
import type { CourierAdapter, CourierCompany, ParcelInfo, TrackItem, TrackResult } from './types';
import { baseUrl, chunks, CourierError, cut, errText, flag, http, HttpOpts, needKeys, sleep, timeUp } from './util';

const STATUSES: CourierAdapter['statuses'] = {
  // Avancement (stage)
  'En Préparation': null, 'En préparation': null, 'En Traitement': 'shipped', 'En traitement': 'shipped', 'Au Bureau': 'shipped', 'Au bureau': 'shipped',
  'Sortir en livraison': 'out_for_delivery', 'Sortie en livraison': 'out_for_delivery', 'En livraison': 'out_for_delivery', 'En Livraison': 'out_for_delivery',
  Dispatcher: 'delivered', Livré: 'delivered', Livrée: 'delivered',
  'Retour Fournisseur': 'returning', 'Retour fournisseur': 'returning', Récupérer: 'returned', Récupéré: 'returned',
  Perdu: 'lost',
  // Situation (call result)
  EnCours: null, 'En Cours': null, 'Appel Tel': null, 'SMS Envoyé': null, BIZ: null,
  'Ne Réponde pas #1': 'failed', 'Ne Réponde pas #2': 'failed', 'Ne Réponde pas #3': 'failed',
  Annuler: 'failed', 'Annuler x3': 'failed', Reporté: 'failed',
  'Attend Information': 'alert', 'Reporté Commune Erronée': 'alert', 'Reporté Wilaya Erronée': 'alert',
  Recouvert: 'delivered',
};

const DEF = 'https://ecom-dz.net';
const hdr = (c: CourierCompany) => ({ Token: String(c.secret.token ?? '').trim(), Key: String(c.secret.key ?? '').trim() });

async function api(c: CourierCompany, path: string, o: HttpOpts = {}) {
  const r = await http(c.name, `${baseUrl(c, DEF)}/${path}`, { ...o, headers: { ...hdr(c), ...(o.headers ?? {}) } });
  await sleep(1600);
  return r;
}
const enc = encodeURIComponent;
const READY = `Api_v1/aExp${enc('é')}dier`;

/** 0661… (E-COM wants 9 or 10 digits). */
const phoneOf = (p: string | null | undefined) => {
  const d = String(p ?? '').replace(/\D/g, '').replace(/^213/, '');
  return d ? (d.startsWith('0') ? d : `0${d}`).slice(0, 10) : '';
};
/** « 13/08/2024 20:24:08 » → « 2024-08-13 20:24:08 » */
const when = (s: unknown) => {
  const t = String(s ?? '').trim();
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}${m[4]}` : t;
};
const base = (x: any) => (x && typeof x === 'object' ? (x.Colis_Base ?? x) : null);

/** The stage, or the call situation when it says more (failed attempt, problem, money collected). */
function statusOf(x: any): { key: string; status: string } | null {
  const adv = String(x?.Avancement ?? '').trim();
  const sit = String(x?.Situation ?? '').trim();
  if (!adv && !sit) return null;
  const sMap = sit in STATUSES ? STATUSES[sit] : undefined;
  const aMap = adv in STATUSES ? STATUSES[adv] : undefined;
  const useSit = !adv || sMap === 'delivered' || ((sMap === 'failed' || sMap === 'alert') && (aMap === 'out_for_delivery' || aMap === 'shipped' || aMap === undefined));
  const words = [adv, sit && sit !== 'EnCours' ? sit : ''].filter(Boolean).join(' · ');
  return { key: useSit ? sit : adv, status: words || sit };
}

async function one(c: CourierCompany, tracking: string) {
  const r = await api(c, `Api_v1/Colis/Tracking/${enc(tracking)}`);
  const list: any[] = Array.isArray(r?.Colis) ? r.Colis : [];
  return base(list.find((x) => x && typeof x === 'object')) ?? null;
}
async function hist(c: CourierCompany, tracking: string): Promise<any[]> {
  const r = await api(c, `Api_v1/Historique/Tracking/${enc(tracking)}`);
  return (Array.isArray(r?.Historique) ? r.Historique : []).filter((x: any) => x && typeof x === 'object');
}
async function communes(c: CourierCompany, w: number): Promise<{ name: string }[]> {
  const r = await api(c, `Api_v1/Commune/${w}`);
  return (Array.isArray(r?.Commune) ? r.Commune : []).map((x: any) => ({ name: String(x.Commune ?? '') })).filter((x: { name: string }) => x.name);
}
const keysRefused = (e: any) => String(e?.message).includes('refuse les clés');

export const ecom: CourierAdapter = {
  statuses: STATUSES,
  async test(c) {
    needKeys(c, 'token', 'key');
    const r = await api(c, 'Api_v1/Test');
    if (!r?.Quota) return { ok: false, message: `${c.name} : réponse inattendue, vérifiez le Token et la Key` };
    const q = r.Quota;
    return { ok: true, message: `Connexion réussie à ${c.name} (E-COM)${q.Limite_24h ? ` · quota ${q.Consommer_24h ?? 0}/${q.Limite_24h} par jour` : ''}.` };
  },
  async create(c, p, helpers) {
    needKeys(c, 'token', 'key');
    if (p.is_stopdesk && !p.stopdesk_ext_id) throw new CourierError(`Choisissez le bureau ${c.name} (stop desk) de la commande`);
    const com = await helpers.communeName(p, (w) => communes(c, w), `ecom:${cacheKeyOf(c)}`);
    const commune = com?.name || (p.is_stopdesk ? p.stopdesk_commune : null) || p.commune;
    if (!commune) throw new CourierError(`Commune manquante pour ${c.name}`);
    const phone = phoneOf(p.phone);
    if (!/^\d{9,10}$/.test(phone)) throw new CourierError(`${c.name} : numéro de téléphone invalide (${p.phone})`);
    const phone2 = phoneOf(p.phone2);
    const parcel = {
      Echange: p.is_exchange ? 1 : 0,
      Stopdesk: p.is_stopdesk ? 1 : 0,
      CodeStopdesk: p.is_stopdesk ? String(p.stopdesk_ext_id) : undefined,
      NomComplet: cut(p.customer_name || 'Client', 255),
      Mobile_1: phone,
      Mobile_2: phone2 && phone2 !== phone ? phone2 : undefined,
      Adresse: cut(p.address || commune, 255),
      Wilaya: String(p.wilaya_id),
      Commune: cut(commune, 255),
      Article: cut(p.products, 255) || 'Produit',
      Ref_Article: cut(p.ref, 255),
      NoteFournisseur: cut(p.delivery_note, 255) || undefined,
      Total: String(Math.round(p.total)),
      ID_Externe: cut(p.ref, 255),
      Source: cut(c.shop.name || 'Pilotix', 100),
    };
    const r = await api(c, 'Api_v1/Colis', { method: 'POST', json: { Colis: [parcel] } });
    const x = (Array.isArray(r?.Colis) ? r.Colis : [])[0];
    if (!x?.Tracking) throw new CourierError(`${c.name} : pas de numéro de suivi (${errText(x?.Commentaire || x || r) || 'refusé'})`);
    const tracking = String(x.Tracking);
    if (flag(c, 'validate', true)) {
      try {
        await api(c, READY, { method: 'PUT', json: { Colis: [{ Tracking: tracking }] } });
      } catch {
        /* the parcel exists; it can be set « à expédier » in the company's space */
      }
    }
    return { tracking, extId: null, labelUrl: x.label || x.Label || x.Etiquette || null };
  },
  async track(c, items) {
    needKeys(c, 'token', 'key');
    const out: TrackResult[] = [];
    const done = new Set<number>();
    const push = (it: TrackItem, x: any) => {
      const s = statusOf(x);
      if (!s) return;
      out.push({ id: it.id, key: s.key, status: s.status, at: when(x.Date_Action_D ?? x.Date_last_status ?? x.Date_Création_D ?? x.Date_Création) || null });
      done.add(it.id);
    };
    let many = true;
    for (const group of chunks(items, 50)) {
      if (timeUp() || !many) break;
      try {
        const r = await api(c, 'Api_v1/Colis/Liste', { method: 'POST', json: { Colis: group.map((g) => ({ Tracking: g.tracking })), Page: 1 } });
        const byT = new Map<string, any>();
        for (const y of Array.isArray(r?.Colis) ? r.Colis : []) {
          const b = base(y);
          if (b?.Tracking) byT.set(String(b.Tracking), b);
        }
        for (const it of group) if (byT.has(it.tracking)) push(it, byT.get(it.tracking));
      } catch (e: any) {
        if (keysRefused(e) || e.status === 429) return out;
        many = false;
      }
    }
    for (const it of items.filter((x) => !done.has(x.id))) {
      if (timeUp()) break;
      try {
        const x = await one(c, it.tracking);
        if (x) push(it, x);
        else out.push({ id: it.id, status: '', error: `Colis introuvable chez ${c.name}` });
      } catch (e: any) {
        if (keysRefused(e) || e.status === 429) break;
        out.push({ id: it.id, status: '', error: e.message });
      }
    }
    return out;
  },
  async cancel(c, it) {
    needKeys(c, 'token', 'key');
    await api(c, 'Api_v1/Supprimer', { method: 'PUT', json: { Colis: [{ Tracking: it.tracking }] } });
  },
  async stopdesks(c) {
    needKeys(c, 'token', 'key');
    const r = await api(c, 'Api_v1/Stopdesk');
    const list = r?.Commune ?? r?.Stopdesk ?? [];
    return (Array.isArray(list) ? list : Object.values(list))
      .filter((d: any) => d && (d.Code || d.Libelle))
      .map((d: any) => ({
        extId: String(d.Code ?? d.Libelle),
        name: String(d.Libelle || d.Code),
        wilayaId: Number(d.Ville) || null,
        commune: d.Commune ?? null,
        address: d.Adresse ?? null,
      }));
  },
  async parcel(c, it): Promise<ParcelInfo> {
    needKeys(c, 'token', 'key');
    const x = await one(c, it.tracking);
    if (!x) throw new CourierError(`Colis ${it.tracking} introuvable chez ${c.name}`);
    const h = await hist(c, it.tracking).catch((e) => {
      if (keysRefused(e)) throw e;
      return [] as any[];
    });
    const lastH = h.at(-1);
    const adv = String(x.Avancement ?? lastH?.Avancement ?? '').trim() || null;
    const sit = String(x.Situation ?? lastH?.Situation ?? '').trim() || null;
    const open = !adv || /pr[ée]paration/i.test(adv);
    const desk = Number(x.Stopdesk) === 1;
    const num = (v: unknown) => (v == null || v === '' ? null : Number(v) || null);
    return {
      state: adv,
      color: null,
      situation: sit,
      livreur: null,
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
      delivery: {
        type: desk ? 'stopdesk' : 'home',
        hub: desk ? (x.CodeStopdesk ?? x.Commune_Bureau ?? null) : null,
        city: x.Wilaya ?? (x.IDWilaya != null ? String(x.IDWilaya) : null),
        district: x.Commune_Bureau ?? x.Commune ?? null,
        street: x.Adresse ?? null,
      },
      amount: num(x.Total),
      deliveryPrice: num(x.Frais ?? x.Frais_Livraison),
      returnPrice: null,
      swap: null,
      history: h
        .map((e: any) => ({
          at: when(e.Date_Création ?? e.Date_Création_D ?? e.Date),
          status: String(e.Avancement || e.Situation || ''),
          color: null,
          hub: e.Commune ?? null,
          by: e.Utilisateur ?? e.User ?? null,
          comment: e.Commentaire || null,
          situations: e.Situation && e.Avancement ? [{ name: String(e.Situation), at: when(e.Date_Création) || null }] : [],
        }))
        .filter((e) => e.at && e.status)
        .sort((a, b) => b.at.localeCompare(a.at)),
      sms: [],
    };
  },
  async change(c, i, helpers, p) {
    needKeys(c, 'token', 'key');
    const cur = await one(c, i.item.tracking);
    if (!cur) throw new CourierError(`Colis ${i.item.tracking} introuvable chez ${c.name}`);
    const body: Record<string, unknown> = {
      NomComplet: cut(cur.NomComplet || p?.customer_name || 'Client', 255),
      Mobile_1: phoneOf(cur.Mobile_1 || p?.phone),
      Mobile_2: phoneOf(cur.Mobile_2 || p?.phone2) || undefined,
      Adresse: cut(cur.Adresse || p?.address || '-', 255),
      Commune: cut(cur.Commune_Bureau || cur.Commune || p?.commune || '', 255),
      Article: cut(cur.Article || p?.products || 'Produit', 255),
      Ref_Article: cur.Ref_Article || p?.ref || undefined,
      NoteFournisseur: cur.NoteFournisseur || undefined,
      Total: String(Math.round(Number(cur.Total ?? p?.total ?? 0))),
      ID_Externe: cur.ID_Externe || p?.ref || undefined,
      Source: cur.Source || c.shop.name || 'Pilotix',
    };
    if (i.kind === 'amount') {
      if (i.amount == null || !(i.amount >= 0)) throw new CourierError('Le nouveau montant manque');
      body.Total = String(Math.round(i.amount));
    } else if (i.kind === 'phone') {
      const ph = phoneOf(i.phone);
      if (!/^\d{9,10}$/.test(ph)) throw new CourierError('Le nouveau numéro est invalide');
      body.Mobile_1 = ph;
      const ph2 = phoneOf(i.phone2);
      body.Mobile_2 = ph2 && /^\d{9,10}$/.test(ph2) ? ph2 : undefined;
    } else if (i.kind === 'address') {
      if (Number(cur.Stopdesk) === 1) throw new CourierError(`${c.name} : colis en stop desk, l’adresse ne peut pas être changée par l’API`);
      const curW = Number(cur.IDWilaya ?? cur.Wilaya) || p?.wilaya_id;
      if (i.wilayaId && curW && i.wilayaId !== curW) throw new CourierError(`${c.name} ne permet pas de changer la wilaya par l’API : supprimez le colis et renvoyez-le`);
      if (i.address) body.Adresse = cut(i.address, 255);
      if (i.commune) {
        const w = i.wilayaId || curW;
        const m = p && w ? await helpers.communeName({ ...p, wilaya_id: w, commune: i.commune }, (x) => communes(c, x), `ecom:${cacheKeyOf(c)}`) : null;
        body.Commune = cut(m?.name || i.commune, 255);
      }
      if (i.amount != null && i.amount >= 0) body.Total = String(Math.round(i.amount));
    } else {
      throw new CourierError(`${c.name} ne permet pas de changer Domicile ↔ Stop desk par l’API : supprimez le colis et renvoyez-le`);
    }
    for (const k of Object.keys(body)) if (body[k] === undefined || body[k] === '') delete body[k];
    await api(c, `Api_v1/Colis/${enc(i.item.tracking)}`, { method: 'PUT', json: { Colis: body } });
    return { extId: i.item.tracking, approved: true, direct: true };
  },
};
