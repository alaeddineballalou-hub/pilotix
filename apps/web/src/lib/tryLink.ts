// « Essayer » links of the owner's Pilotix Deploy page (a Claude artifact): they open the demo already logged in with
// the right demo account, straight on the page that changed.
// Demo build only (VITE_DEMO_ONLY: the Pilotix artifact in Claude): pilotix.online never reads these links.
//
// Claude passes only a plain « #name » (letters, digits, dashes) from an artifact's link to its page, never « #/x », so:
//   #essayer-<account>                      logs in, then the account's home page
//   #essayer-<account>---<page>--<sub>…     logs in, then #/<page>/<sub>…  (« -- » stands for « / »)
// <account> = a demo account's key (admin, vendeur, conf1, manager1, agence…) or its first name (samira, yacine, nadia…).
// Example: #essayer-samira---confirmation--attente → Samira (Confirmation), on Confirmation › En attente.
import { DEMO_ACCOUNTS, DEMO_PARTNER_ACCOUNTS } from '@pilotix/shared';
import { DEMO_ONLY } from './backend';

export type TryLink = { email: string; route: string | null };

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const firstName = (name: string) => plain(name.split(/[\s(]/)[0] || '');

/** The « Essayer » link in this hash, or null (not one, or not the demo build). */
export function readTryLink(hash: string = location.hash): TryLink | null {
  if (!DEMO_ONLY) return null;
  const m = /^#essayer-([a-z0-9]+)(?:---([a-z0-9-]+))?$/i.exec(hash || '');
  if (!m) return null;
  const who = plain(m[1]);
  const all = [...DEMO_ACCOUNTS, ...DEMO_PARTNER_ACCOUNTS] as readonly { key: string; name: string; email: string }[];
  const acc = all.find((a) => a.key === who) || all.find((a) => firstName(a.name) === who);
  if (!acc) return null;
  const route = m[2]
    ? m[2]
        .split('--')
        .map((s) => s.replace(/^-+|-+$/g, ''))
        .filter(Boolean)
        .join('/')
    : null;
  return { email: acc.email, route: route || null };
}

/** The link to put on the Deploy page for this account and page (« confirmation/attente »). */
export function tryLinkHash(account: string, route?: string): string {
  return `#essayer-${account}${route ? '---' + route.replace(/^[#/]+/, '').split('/').join('--') : ''}`;
}
