/**
 * An address that came from outside (a courier, Meta, an ad) as a link to open: http(s) only — never javascript:,
 * data: or the like, which would run in Pilotix's own page. null: not one to open.
 */
export function webHref(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(String(u).trim());
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null;
  } catch {
    return null;
  }
}
