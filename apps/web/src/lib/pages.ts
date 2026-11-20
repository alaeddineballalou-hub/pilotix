// The address the landing pages live at, for the links the app shows and copies.
import { serverUrl } from './backend';
import { useRpc } from './query';

/** their own address (https://go.<domain>) once the server reaches it there, else the app's (as before; the demo too) */
export const usePagesBase = () => useRpc('landing.store', {}, { staleTime: 60_000 }).data?.pagesUrl || serverUrl();

/**
 * What a page's (or a group's) public link starts with, ending with « / »: the boutique's own domain
 * (https://babyjoydz.net/) by default once it is ready, else <pages' address>/<store>/ (Landing pages › Réglages ›
 * « Liens des pages »). '' while it loads or in the demo (its links open inside the app).
 */
export function usePagesPrefix(): string {
  const d = useRpc('landing.store', {}, { staleTime: 60_000 }).data;
  if (!d) return '';
  if (d.prefix) return d.prefix;
  const base = (d.pagesUrl || serverUrl()).replace(/\/+$/, '');
  return base && d.store ? `${base}/${d.store}/` : '';
}
