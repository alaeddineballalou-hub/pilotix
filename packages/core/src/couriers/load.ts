// Reads companies and orders from the database in the shape the adapters need, and maps courier statuses to ours.
// Runs on the server and in the browser preview (no network here).
import { FOLLOW_STATUSES, FollowStatus, WILAYAS, WILAYAS_AR } from '@pilotix/shared';
import type { CourierKind } from '@pilotix/shared';
import { Db, num } from '../db';
import { notFound } from '../rpc';
import { getSetting } from '../settings';
import { requiredKeys } from './kinds';
import type { CourierCompany, Parcel, TrackResult } from './types';
import { bestMatch } from './util';

export async function loadCompany(db: Db, id: number): Promise<CourierCompany> {
  const r = (await db.query('SELECT * FROM delivery_companies WHERE id = $1', [id]))[0];
  if (!r) throw notFound('Société introuvable');
  const shop = await getSetting(db, 'shop');
  const cfg = typeof r.config === 'string' ? JSON.parse(r.config) : r.config ?? {};
  const cred = typeof r.credentials === 'string' ? JSON.parse(r.credentials) : r.credentials ?? {};
  const secret = Object.fromEntries(Object.entries(cred).map(([k, v]) => [k, String(v ?? '')]));
  const settings = cfg.settings ?? {};
  return {
    id: num(r.id),
    name: r.name,
    kind: r.kind as CourierKind,
    secret,
    settings,
    statusMap: cfg.statusMap ?? {},
    shop: { name: shop.name, fromWilayaId: shop.fromWilayaId, fromWilaya: WILAYAS[shop.fromWilayaId - 1] ?? '' },
    cacheKey: `${r.kind}:${fnv(JSON.stringify([Object.entries(secret).filter(([k]) => k !== 'webhook_key').sort(), settings.base_url ?? '']))}`,
  };
}

/** A short hash (FNV-1a, 2 × 32 bits) — only to name a cache, never to protect anything. */
function fnv(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ s.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

/** True when every key the kind needs is filled (manual / own: no keys needed). */
export function keysOk(kind: CourierKind, cred: Record<string, unknown>): boolean {
  if ((cred as any).demo) return true;
  const need = requiredKeys(kind);
  return need.every((k) => String(cred[k] ?? '').trim() !== '');
}

export async function loadParcels(db: Db, ids: number[]): Promise<Parcel[]> {
  if (!ids.length) return [];
  const rows = await db.query(
    `SELECT o.*, sd.ext_id AS sd_ext, sd.name AS sd_name, sd.commune AS sd_commune, sd.wilaya_id AS sd_wilaya,
       (SELECT coalesce(json_agg(json_build_object('name', i.name, 'variant', i.variant_title, 'qty', i.qty, 'price', i.unit_price,
          'sku', coalesce(v.sku, p.sku), 'w', p.weight_kg) ORDER BY i.id), '[]')
        FROM order_items i JOIN products p ON p.id = i.product_id LEFT JOIN product_variants v ON v.id = i.variant_id WHERE i.order_id = o.id) AS items_json
     FROM orders o LEFT JOIN stopdesks sd ON sd.id = o.stopdesk_id WHERE o.id = ANY($1) ORDER BY o.id`,
    [ids],
  );
  return rows.map((r: any): Parcel => {
    const items = (typeof r.items_json === 'string' ? JSON.parse(r.items_json) : r.items_json ?? []) as any[];
    const wid = num(r.wilaya_id);
    return {
      id: num(r.id),
      ref: r.ref,
      customer_name: r.customer_name,
      phone: r.phone,
      phone2: r.phone2,
      wilaya_id: wid,
      wilaya: WILAYAS[wid - 1] ?? '',
      wilaya_ar: WILAYAS_AR[wid] ?? '',
      commune: r.commune ?? '',
      address: r.address ?? '',
      is_stopdesk: !!r.is_stopdesk,
      stopdesk_ext_id: r.sd_ext ?? null,
      stopdesk_name: r.sd_name ?? null,
      stopdesk_commune: r.sd_commune ?? null,
      stopdesk_wilaya_id: r.sd_wilaya ? num(r.sd_wilaya) : null,
      total: num(r.total),
      subtotal: num(r.subtotal),
      delivery_fee: num(r.delivery_fee),
      products: items.map((i) => `${i.qty} × ${i.name}${i.variant ? ` (${i.variant})` : ''}`).join(' + '),
      items: items.map((i) => ({ name: i.variant ? `${i.name} (${i.variant})` : i.name, sku: i.sku ?? null, price: num(i.price), qty: num(i.qty) })),
      pieces: items.reduce((s, i) => s + num(i.qty), 0),
      weight: Math.max(1, items.reduce((s, i) => s + Number(i.w || 0) * num(i.qty), 0)),
      delivery_note: r.delivery_note ?? '',
      is_exchange: !!r.is_exchange,
      tracking: r.tracking,
      ext_id: r.ext_id,
      retry: !!r.send_error,
    };
  });
}

/** Commune matching with a per-process cache (same commune list asked once per wilaya). */
const communeCache = new Map<string, unknown[]>();
export const helpers = {
  async communeName<T extends { name: string }>(p: Parcel, load: (w: number) => Promise<T[]>, cacheKey = ''): Promise<T | null> {
    const key = `${cacheKey}:${p.wilaya_id}`;
    let list = communeCache.get(key) as T[] | undefined;
    if (!list) {
      list = await load(p.wilaya_id);
      if (cacheKey) communeCache.set(key, list);
    }
    const want = p.is_stopdesk && p.stopdesk_commune ? p.stopdesk_commune : p.commune;
    const hit = bestMatch(want, list.map((x) => x.name));
    return hit ? list.find((x) => x.name === hit) ?? null : null;
  },
};

/**
 * Courier status → our follow status. Order: the company's own mapping (exact, then fuzzy), then the adapter's decision,
 * then the adapter defaults (key, then words, then fuzzy). undefined = unknown (no change); null = known but no change.
 */
export function resolveStatus(defaults: Record<string, FollowStatus | null>, own: Record<string, string>, r: Pick<TrackResult, 'key' | 'status' | 'mapped'>): FollowStatus | null | undefined {
  const valid = (v: unknown): FollowStatus | null => (v && (FOLLOW_STATUSES as readonly string[]).includes(v as string) ? (v as FollowStatus) : null);
  for (const k of [r.status, r.key]) if (k && Object.prototype.hasOwnProperty.call(own, k)) return valid(own[k]);
  const fuzzyOwn = r.status ? bestMatch(r.status, Object.keys(own)) : null;
  if (fuzzyOwn) return valid(own[fuzzyOwn]);
  if (r.mapped !== undefined) return r.mapped;
  for (const k of [r.key, r.status]) if (k && Object.prototype.hasOwnProperty.call(defaults, k)) return defaults[k];
  const base = r.status?.split(' · ')[0];
  if (base && Object.prototype.hasOwnProperty.call(defaults, base)) return defaults[base];
  const fuzzy = base ? bestMatch(base, Object.keys(defaults)) : null;
  return fuzzy ? defaults[fuzzy] : undefined;
}
