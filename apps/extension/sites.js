// Pilotix Spy: the Pilotix addresses where the extension's bridge (bridge.js) runs.
// Shared by the popup and the service worker.

/**
 * The origin of a Pilotix address typed by the user ("app.maboutique.dz", "https://app.maboutique.dz/admin",
 * "localhost:5173"…). https:// for every site; http:// only for localhost / 127.0.0.1 (development).
 * Throws an Error with a French message when the address cannot be used.
 */
export function pilotixOrigin(input) {
  let t = String(input ?? '').trim();
  if (!t) throw new Error('Tapez l’adresse de votre Pilotix (ex. https://app.maboutique.dz).');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = (/^(localhost|127\.0\.0\.1)([:/]|$)/i.test(t) ? 'http://' : 'https://') + t;
  let u;
  try {
    u = new URL(t);
  } catch {
    throw new Error('Adresse invalide. Exemple : https://app.maboutique.dz');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol === 'http:' && !local) throw new Error('Utilisez une adresse https:// (http:// seulement pour localhost).');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Adresse invalide. Exemple : https://app.maboutique.dz');
  if (u.username || u.password) throw new Error('Adresse invalide. Exemple : https://app.maboutique.dz');
  if (/(^|\.)(facebook\.com|fbcdn\.net|fb\.com)$/i.test(u.hostname)) throw new Error('C’est une adresse de Facebook, pas de votre Pilotix.');
  if (!local && !u.hostname.includes('.')) throw new Error('Adresse invalide. Exemple : https://app.maboutique.dz');
  return u.origin;
}

/** The match pattern of an origin ("https://app.maboutique.dz/*"), for the permission and the content script. */
export const originPattern = (origin) => `${origin}/*`;

/** The id of the registered content script of an origin: "pilotix-" + a short hash of it. */
export function scriptId(origin) {
  let h = 5381;
  for (const ch of origin) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return `pilotix-${h.toString(36)}`;
}

/** The stored list of Pilotix origins (chrome.storage.local). */
export const SITES_KEY = 'sites';
