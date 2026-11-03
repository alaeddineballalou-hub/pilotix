// The in-browser demo's boutiques: the demo store's owner (« Administrateur ») has two more boutiques of his own —
// « Maison Fatima » (no logo yet) and « Sport Zone Alger » — so the boutique at the bottom of the menu and « Mes
// boutiques » can be tried with fake data. Built the first time the boutique list is asked: it adds the platform's
// tables (shop #1 = the demo store), as on a server. Safe to call again: it finds them. Only for the in-browser demo
// (its own database): never called on a server.
import { num } from './db';
import { setShopLogo } from './modules/boutiques';
import { ensureAccount } from './platform/accounts';
import { loadShop, migrateAll, provisionShop } from './platform/shops';
import type { Tenancy } from './platform/tenancy';

const OWNER = 'admin@demo.pilotix.dz';
/** An SVG drawing as a logo (made by the seed, never sent by a visitor). */
const svg = (s: string) => `data:image/svg+xml;base64,${btoa(s)}`;

/** The demo store's logo: a « p » on a pale blue square, with Pilotix's orange dot. */
export const DEMO_LOGO = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#E3EEFA"/><path d="M23 52V20h11a9.5 9.5 0 0 1 0 19H23" fill="none" stroke="#2C5A8C" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="46" cy="15" r="5.5" fill="#F2A65A"/></svg>',
);
const SPORT_LOGO = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#173F2A"/><path d="M36 11 19 37h12l-4 17 18-28H33z" fill="#B7E34B"/></svg>',
);

export const DEMO_BOUTIQUES = [
  { name: 'Maison Fatima', slug: 'maison-fatima', logo: null },
  { name: 'Sport Zone Alger', slug: 'sport-zone-alger', logo: SPORT_LOGO },
] as const;

export async function seedDemoBoutiques(t: Tenancy, opts: { now?: number } = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  await migrateAll(t);
  const store = (await loadShop(t, { primary: true }))!;
  const made = await t.platform.query('SELECT slug FROM platform.shops WHERE slug = ANY($1)', [DEMO_BOUTIQUES.map((b) => b.slug)]);
  if (made.length >= DEMO_BOUTIQUES.length) return;
  const sdb = t.shop('public');
  const admin = (await sdb.query('SELECT name, password_hash FROM profiles WHERE email = $1', [OWNER]))[0];
  if (!admin) throw new Error('demo: seed the store first');
  // the demo store is the owner's: the same account opens his other boutiques (the demo password)
  const { account } = await ensureAccount(t, { email: OWNER, name: String(admin.name), language: 'fr', passwordHash: String(admin.password_hash), verified: true });
  await t.platform.query('UPDATE platform.shops SET owner_account_id = $2 WHERE id = $1 AND owner_account_id IS NULL', [store.id, account.id]);
  await setShopLogo(sdb, DEMO_LOGO, undefined, { svg: true });
  for (const b of DEMO_BOUTIQUES) {
    if (made.some((r: any) => r.slug === b.slug)) continue;
    const s = await provisionShop(t, { name: b.name, slug: b.slug, kind: 'store', planId: null, trialDays: 0, owner: { name: String(admin.name), email: OWNER, language: 'fr' }, passwordHash: String(admin.password_hash), verified: true, now });
    // the demo's boutiques never expire, with every menu (the demo store's plan)
    await t.platform.query(
      'UPDATE platform.shops SET never_expires = true, plan_id = (SELECT plan_id FROM platform.shops WHERE primary_shop), created_at = $2 WHERE id = $1',
      [s.id, new Date(now - 40 * 86_400_000 * (num(s.id) % 3 + 1)).toISOString()],
    );
    if (b.logo) await setShopLogo(t.shop(s.schema), b.logo, undefined, { svg: true });
  }
  // the login index leaves the demo's e-mails out (on a server they never log in): this preview's own database lists them
  await t.platform.query(
    `INSERT INTO platform.logins (email, shop_id) SELECT $1, id FROM platform.shops WHERE kind = 'store' AND owner_account_id = $2 ON CONFLICT DO NOTHING`,
    [OWNER, account.id],
  );
}
