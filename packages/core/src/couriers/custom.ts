// "Autre API": any courier with an HTTP API, described by the admin (no code).
// settings: base_url, auth {name, prefix, name2}, test_path,
//   create {method, path, format json|form|query, body (JSON template with {{placeholders}}), tracking_path, id_path, label_path},
//   track {method, path, body, status_path, date_path}, cancel {method, path}.
// secret: token, token2. Placeholders: see PLACEHOLDERS (same list as the original app).
import type { CourierAdapter, CourierCompany, Parcel, PreviewResult } from './types';
import { baseUrl, CourierError, cut, getPath, http, intl, query, splitName, timeUp } from './util';

export const PLACEHOLDERS: [string, string][] = [
  ['ref', 'référence (PX123)'], ['customer_name', 'nom complet'], ['first_name', 'prénom'], ['last_name', 'nom'], ['phone', '0XXXXXXXXX'],
  ['phone_intl', '213XXXXXXXXX'], ['phone2', '2e numéro'], ['wilaya_id', 'n° wilaya'], ['wilaya', 'nom wilaya'], ['commune', 'nom commune'],
  ['commune_ar', 'commune en arabe'], ['address', 'adresse'], ['is_stopdesk', 'true / false'], ['is_stopdesk_01', '1 / 0'],
  ['stopdesk_id', 'code du bureau chez la société'], ['stopdesk_name', 'nom du bureau'], ['total', 'à encaisser'], ['subtotal', 'produits'],
  ['delivery_fee', 'livraison'], ['products', 'texte des produits'], ['qty', 'nombre de pièces'], ['weight', 'poids kg'], ['note', 'note pour le livreur'],
  ['from_wilaya_id', 'wilaya de départ'], ['from_wilaya', 'nom wilaya de départ'], ['secret.token', 'votre clé'], ['secret.token2', '2e clé'],
];

export const DEFAULT_TEMPLATE = `{
  "reference": "{{ref}}",
  "client": "{{customer_name}}",
  "phone": "{{phone}}",
  "phone2": "{{phone2}}",
  "wilaya": {{wilaya_id}},
  "commune": "{{commune}}",
  "address": "{{address}}",
  "stop_desk": {{is_stopdesk_01}},
  "amount": {{total}},
  "products": "{{products}}",
  "note": "{{note}}"
}`;

export function values(c: CourierCompany, p: Partial<Parcel>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const n = splitName(p.customer_name ?? '');
  return {
    ref: p.ref, id: p.id, customer_name: p.customer_name ?? '', first_name: n.first, last_name: n.last, phone: p.phone ?? '',
    phone_intl: (intl(p.phone) ?? '').replace('+', ''), phone2: p.phone2 ?? '', wilaya_id: p.wilaya_id, wilaya: p.wilaya ?? '', wilaya_ar: p.wilaya_ar ?? '',
    commune: p.commune || p.stopdesk_commune || '', commune_ar: '', address: p.address || p.commune || '', is_stopdesk: !!p.is_stopdesk,
    is_stopdesk_01: p.is_stopdesk ? 1 : 0, stopdesk_id: p.stopdesk_ext_id ?? '', stopdesk_name: p.stopdesk_name ?? '', total: Math.round(p.total ?? 0),
    subtotal: Math.round(p.subtotal ?? 0), delivery_fee: Math.round(p.delivery_fee ?? 0), products: cut(p.products, 250), qty: p.pieces ?? 1,
    weight: p.weight ?? 1, note: p.delivery_note ?? '', is_exchange: !!p.is_exchange, from_wilaya_id: c.shop.fromWilayaId, from_wilaya: c.shop.fromWilaya,
    shop: c.shop.name, date: new Date().toISOString().slice(0, 10), 'secret.token': c.secret.token ?? '', 'secret.token2': c.secret.token2 ?? '', ...extra,
  };
}

/** Fills a JSON template: inside quotes a value is escaped as a string; outside quotes it is written as JSON (number, true/false). */
export function fillJson(tpl: string, v: Record<string, unknown>): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < tpl.length; i++) {
    const ch = tpl[i];
    if (ch === '"' && tpl[i - 1] !== '\\') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (ch === '{' && tpl[i + 1] === '{') {
      const end = tpl.indexOf('}}', i + 2);
      if (end > 0) {
        const k = tpl.slice(i + 2, end).trim();
        const val = v[k] === undefined ? '' : v[k];
        out += inStr ? JSON.stringify(String(val ?? '')).slice(1, -1) : JSON.stringify(val ?? null);
        i = end + 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}
const fillPath = (s: string, v: Record<string, unknown>) => String(s || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => encodeURIComponent(String(v[k] ?? '')));

/** Checks a template before saving: returns an error message or ''. */
export function checkTemplate(body: string): string {
  try {
    JSON.parse(fillJson(body, Object.fromEntries(PLACEHOLDERS.map(([k]) => [k, 1]))));
    return '';
  } catch (e: any) {
    return `Modèle JSON invalide : ${e.message}`;
  }
}

function build(c: CourierCompany, step: { method?: string; path?: string; body?: string; format?: string }, v: Record<string, unknown>) {
  if (!step?.path) throw new CourierError(`API personnalisée de ${c.name} : chemin manquant`);
  const a = c.settings.auth ?? {};
  const headers: Record<string, string> = {};
  if (a.name && c.secret.token) headers[a.name] = (a.prefix || '') + c.secret.token;
  if (a.name2 && c.secret.token2) headers[a.name2] = c.secret.token2;
  let url = baseUrl(c, '') + '/' + fillPath(step.path, v).replace(/^\/+/, '');
  const method = step.method || 'POST';
  let json: unknown;
  let form: Record<string, unknown> | undefined;
  if (step.body) {
    let data: any;
    try {
      data = JSON.parse(fillJson(step.body, v));
    } catch (e: any) {
      throw new CourierError(`Modèle JSON invalide pour ${c.name} : ${e.message}`);
    }
    const fmt = method === 'GET' ? 'query' : step.format || 'json';
    if (fmt === 'json') json = data;
    else if (fmt === 'form') form = data;
    else url += (url.includes('?') ? '&' : '?') + query(Object.fromEntries(Object.entries(data).map(([k, x]) => [k, typeof x === 'object' ? JSON.stringify(x) : x])));
  }
  return { url, method, headers, json, form };
}

export const custom: CourierAdapter = {
  statuses: {},
  async test(c) {
    if (!c.settings.test_path) return { ok: true, message: 'Rien à tester automatiquement : envoyez une commande pour vérifier (ou ajoutez un « chemin pour tester »).' };
    const r = build(c, { method: 'GET', path: c.settings.test_path }, {});
    await http(c.name, r.url, { method: 'GET', headers: r.headers });
    return { ok: true, message: `Connexion réussie à ${c.name}.` };
  },
  async create(c, p) {
    const step = c.settings.create ?? {};
    const r = build(c, step, values(c, p));
    const res = await http(c.name, r.url, r);
    const tracking = getPath(res, step.tracking_path || 'tracking');
    if (tracking == null || tracking === '' || typeof tracking === 'object')
      throw new CourierError(`${c.name} a répondu sans numéro de suivi à l’endroit indiqué (« ${step.tracking_path || 'tracking'} ») : ${JSON.stringify(res).slice(0, 200)}`);
    return {
      tracking: String(tracking),
      extId: step.id_path ? String(getPath(res, step.id_path) ?? '') || null : null,
      labelUrl: step.label_path ? getPath(res, step.label_path) || null : null,
    };
  },
  async track(c, items) {
    const step = c.settings.track ?? {};
    if (!step.path) return [];
    const out = [];
    for (const it of items) {
      if (timeUp()) break;
      try {
        const r = build(c, step, { tracking: it.tracking, ext_id: it.extId ?? '', 'secret.token': c.secret.token ?? '' });
        const res = await http(c.name, r.url, r);
        const st = getPath(res, step.status_path || 'status');
        if (st != null && typeof st !== 'object') out.push({ id: it.id, status: String(st), at: step.date_path ? getPath(res, step.date_path) ?? null : null });
      } catch (e: any) {
        if (e.status === 429) break;
      }
    }
    return out;
  },
  async cancel(c, it) {
    const step = c.settings.cancel ?? {};
    if (!step.method || !step.path) throw new CourierError(`Annulation non configurée pour ${c.name}`);
    const r = build(c, step, { tracking: it.tracking, ext_id: it.extId ?? '', 'secret.token': c.secret.token ?? '' });
    await http(c.name, r.url, r);
  },
  async preview(c, p): Promise<PreviewResult> {
    const r = build(c, c.settings.create ?? {}, values(c, p));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) headers[k] = String(v).slice(0, 6) + '…';
    return { method: r.method, url: r.url, headers, body: r.json ?? r.form ?? null };
  },
};
