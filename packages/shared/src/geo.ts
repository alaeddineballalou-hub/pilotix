import geo from './geo.json';

/** Arabic names of the 69 wilayas (code → name). */
export const WILAYAS_AR: Record<number, string> = geo.wilayaAr as unknown as Record<number, string>;

/** The new wilayas (2026) and the wilaya their communes were previously part of. */
export const NEW_WILAYA_PARENT: Record<number, number> = { 59: 3, 60: 5, 61: 7, 62: 12, 63: 13, 64: 14, 65: 17, 66: 17, 67: 26, 68: 28, 69: 32 };

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
