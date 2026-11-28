// A delivery company that still counts 58 wilayas gets a new wilaya (2026) as the one it was part of (Bou Saâda 68 →
// M'Sila 28): its communes, bureaus and prices are still there. An adapter that finds the new wilayas itself
// (`knowsNewWilayas`: ZR, which may add them one day) gets ours as they are. The owner's rule, 28 Nov 2026 (../newwilayas.ts).
import { type CourierKind, isNewWilaya, oldWilaya, WILAYAS, WILAYAS_AR } from '@pilotix/shared';
import { ADAPTERS } from './adapters';
import type { ChangeInput, CourierCompany, Parcel } from './types';

/** Does this company get our new wilayas as their old ones? */
export const toOldWilayas = (kind: CourierKind) => !ADAPTERS[kind]?.knowsNewWilayas;

/** The wilaya this company gets for one of ours. */
export const courierWilaya = (kind: CourierKind, wilayaId: number) => (toOldWilayas(kind) ? oldWilaya(wilayaId) : wilayaId);

/** A parcel as this company knows it: a new wilaya goes as its old one, with that wilaya's name. */
export function courierParcel(kind: CourierKind, p: Parcel): Parcel {
  if (!isNewWilaya(p.wilaya_id) || !toOldWilayas(kind)) return p;
  const w = oldWilaya(p.wilaya_id);
  return { ...p, wilaya_id: w, wilaya: WILAYAS[w - 1] ?? p.wilaya, wilaya_ar: WILAYAS_AR[w] ?? p.wilaya_ar };
}

/** A change request (a new address) as this company knows it. */
export function courierChange(kind: CourierKind, i: ChangeInput): ChangeInput {
  return i.wilayaId && isNewWilaya(i.wilayaId) && toOldWilayas(kind) ? { ...i, wilayaId: oldWilaya(i.wilayaId) } : i;
}

/** The company as its parcels leave: a shop (or a « wilaya de départ ») in a new wilaya sends from its old one. */
export function courierCompany(c: CourierCompany): CourierCompany {
  if (!toOldWilayas(c.kind)) return c;
  const from = Number(c.shop?.fromWilayaId) || 0;
  const set = Number(c.settings?.from_wilaya_id) || 0;
  if (!isNewWilaya(from) && !isNewWilaya(set)) return c;
  return {
    ...c,
    shop: isNewWilaya(from) ? { ...c.shop, fromWilayaId: oldWilaya(from), fromWilaya: WILAYAS[oldWilaya(from) - 1] ?? c.shop.fromWilaya } : c.shop,
    settings: isNewWilaya(set) ? { ...c.settings, from_wilaya_id: String(oldWilaya(set)) } : c.settings,
  };
}
