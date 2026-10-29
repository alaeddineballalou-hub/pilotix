// ZR Express old platform = Procolis (also ABEX, Colilog… on the same software; base_url changes).
// Auth: headers `token` + `key` (Procolis → Paramètres → API). Base https://procolis.com/api_v1.
// Ported from the original Pilotix adapter. Endpoints: GET /token, POST /add_colis {Colis:[…]}, POST /lire, POST /tarification.
// Procolis has no API to cancel, print labels or list stop desks.
// Note: the field "Confrimee" is spelled this way in Procolis' API (not a typo of ours).
import type { CourierAdapter, CourierCompany } from './types';
import { baseUrl, chunks, CourierError, cut, flag, http, needKeys, timeUp } from './util';

const STATUSES: CourierAdapter['statuses'] = {
  'En Preparation': null, 'En traitement - Pret a expedie': null, Dispatcher: 'shipped', 'Au Bureau': 'shipped', 'En livraison': 'out_for_delivery',
  'Reporté': 'failed', 'A relancé': 'failed', 'Appel sans Réponse 1': 'failed', 'Appel sans Réponse 2': 'failed', 'Appel sans Réponse 3': 'failed',
  'SD - Appel sans Réponse 1': 'failed', 'SD - Appel sans Réponse 2': 'failed', 'SD - Appel sans Réponse 3': 'failed', 'SD - En Attente du Client': 'out_for_delivery',
  'SD - Reporté': 'failed', 'Livrée': 'delivered', 'Colis Livrée': 'delivered', 'Livrée [ Encaisser ]': 'delivered', 'Livrée [ Recouvert ]': 'delivered',
  Echange: 'in_exchange', 'Annuler par le Client': 'returning', 'SD - Annuler par le Client': 'returning', 'SD - Annuler 3x': 'returning',
  'Retour de Dispatche': 'returning', 'Retour Livreur': 'returning', 'Retour Navette': 'returning', 'Retour Stock': 'returned',
};
const h = (c: CourierCompany) => ({ token: String(c.secret.token ?? '').trim(), key: String(c.secret.key ?? '').trim() });
// ABEX was once saved with abex.procolis.com, an address that does not exist: every Procolis company is on procolis.com
const url = (c: CourierCompany, p: string) => baseUrl(c, 'https://procolis.com/api_v1').replace(/^https?:\/\/abex\.procolis\.com\b/i, 'https://procolis.com') + p;

export const procolis: CourierAdapter = {
  statuses: STATUSES,
  async test(c) {
    needKeys(c, 'token', 'key');
    const r = await http(c.name, url(c, '/token'), { headers: h(c) });
    const st = r && (r.Statut || r.statut);
    return { ok: !st || /activ/i.test(st), message: st ? `${c.name} : ${st}` : `Connexion réussie à ${c.name}` };
  },
  async create(c, p) {
    needKeys(c, 'token', 'key');
    const colis = (tracking: string) => ({
      Tracking: tracking,
      TypeLivraison: p.is_stopdesk ? '1' : '0',
      TypeColis: p.is_exchange ? '1' : '0',
      Confrimee: flag(c, 'validate', true) ? '1' : '',
      Client: cut(p.customer_name || 'Client', 100),
      MobileA: p.phone,
      MobileB: p.phone2 || '',
      Adresse: cut(p.address || p.commune || '-', 200),
      IDWilaya: String(p.wilaya_id),
      Commune: p.commune || p.stopdesk_commune || '',
      Total: String(Math.round(p.total)),
      Note: cut(p.delivery_note, 200),
      TProduit: cut(p.products, 250),
      id_Externe: p.ref,
      Source: c.shop.name,
    });
    let tracking = p.ref;
    for (let i = 0; i < 2; i++) {
      const r = await http(c.name, url(c, '/add_colis'), { method: 'POST', headers: h(c), json: { Colis: [colis(tracking)] } });
      const one = r?.Colis?.[0] ?? {};
      if (one.MessageRetour === 'Good') return { tracking: one.Tracking || tracking, extId: null, labelUrl: null };
      // "Double" = this tracking already exists (order re-sent after a cancel): retry with a suffix
      if (/double/i.test(one.MessageRetour || '') && i === 0) {
        tracking = `${p.ref}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
        continue;
      }
      throw new CourierError(`${c.name} : ${one.MessageRetour || 'colis refusé'}`);
    }
    throw new CourierError(`${c.name} : colis refusé`);
  },
  async track(c, items) {
    const out = [];
    for (const group of chunks(items, 50)) {
      if (timeUp()) break;
      const r = await http(c.name, url(c, '/lire'), { method: 'POST', headers: h(c), json: { Colis: group.map((g) => ({ Tracking: g.tracking })) } });
      for (const x of r?.Colis ?? []) {
        const it = group.find((g) => String(g.tracking) === String(x.Tracking));
        if (it && x.Situation) out.push({ id: it.id, status: String(x.Situation).trim(), at: x.DateH_Action ?? null });
      }
    }
    return out;
  },
  async fees(c) {
    needKeys(c, 'token', 'key');
    const r = await http(c.name, url(c, '/tarification'), { method: 'POST', headers: h(c) });
    const out = [];
    for (const row of Array.isArray(r) ? r : []) {
      const w = Number(row.IDWilaya ?? row.idWilaya ?? row.Wilaya);
      if (!(w >= 1 && w <= 69)) continue;
      // BEST GUESS: column names vary between Procolis installs, matched by words.
      const col = (re: RegExp) => {
        const k = Object.keys(row).find((x) => re.test(x));
        return k ? Number(row[k]) || null : null;
      };
      out.push({ wilayaId: w, home: col(/domicile|home/i), desk: col(/stop|desk|bureau/i), returnFee: col(/annul|retour|return/i) });
    }
    return out;
  },
};
