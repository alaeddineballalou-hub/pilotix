import geo from './geo.json';

/** Arabic names of the 69 wilayas (code → name). */
export const WILAYAS_AR: Record<number, string> = geo.wilayaAr as unknown as Record<number, string>;

/** The new wilayas (2026) and the wilaya their communes were previously part of. */
export const NEW_WILAYA_PARENT: Record<number, number> = { 59: 3, 60: 5, 61: 7, 62: 12, 63: 13, 64: 14, 65: 17, 66: 17, 67: 26, 68: 28, 69: 32 };

/** A wilaya created in 2026 (59–69). */
export const isNewWilaya = (wilayaId: number | null | undefined): boolean => !!wilayaId && NEW_WILAYA_PARENT[wilayaId] !== undefined;

/**
 * The wilaya a delivery company that still counts 58 wilayas knows this one as: a new wilaya (2026) is the one its
 * communes were part of (Bou Saâda 68 → M'Sila 28); any other wilaya is itself. Pilotix keeps the 69 everywhere else
 * (the owner, 28 Nov 2026).
 */
export const oldWilaya = (wilayaId: number): number => NEW_WILAYA_PARENT[wilayaId] ?? wilayaId;

/** This wilaya and, for a new one (2026), also the one it was part of: where the companies still keep its bureaus and prices. */
export const wilayaAndOld = (wilayaId: number): number[] => (isNewWilaya(wilayaId) ? [wilayaId, oldWilaya(wilayaId)] : [wilayaId]);

/** The new wilayas (2026) made from each old one (M'Sila 28 → [68]; Djelfa 17 → [65, 66]). */
export const NEW_WILAYAS_OF: Record<number, number[]> = Object.entries(NEW_WILAYA_PARENT).reduce<Record<number, number[]>>((m, [n, o]) => {
  (m[o] ??= []).push(Number(n));
  return m;
}, {});

/** The wilayas a company that counts 58 sees as one: the old wilaya and the new ones made from it (Bou Saâda 68 and
 *  M'Sila 28 → [28, 68]); any other wilaya: itself. */
export const wilayaFamily = (wilayaId: number): number[] => {
  const o = oldWilaya(wilayaId);
  return [o, ...(NEW_WILAYAS_OF[o] ?? [])];
};

/** Same wilaya for a company that counts 58 (a swap's price, ZR's « same wilaya only » rule). */
export const sameOldWilaya = (a: number | null | undefined, b: number | null | undefined): boolean => !!a && !!b && oldWilaya(a) === oldWilaya(b);

/** All 1,541 communes: [wilaya code, French name, Arabic name]. */
export const COMMUNES = geo.communes as [number, string, string][];

/**
 * Communes to offer for a wilaya. For the 11 wilayas created in 2026 the official commune split is not loaded yet,
 * so the communes of the wilaya they were part of are offered.
 */
export function communesOf(wilayaId: number): [number, string, string][] {
  const w = NEW_WILAYA_PARENT[wilayaId] ?? wilayaId;
  return COMMUNES.filter((c) => c[0] === w).sort((a, b) => a[1].localeCompare(b[1], 'fr'));
}
