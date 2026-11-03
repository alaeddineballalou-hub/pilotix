// The in-browser demo's boutiques: the demo store's owner (« Administrateur ») has two more boutiques of his own —
// « Maison Fatima » (no logo yet) and « Sport Zone Alger » — so the boutique at the bottom of the menu and « Mes
// boutiques » can be tried with fake data. Built the first time the boutique list is asked: it adds the platform's
// tables (shop #1 = the demo store), as on a server. Safe to call again: it finds them. Only for the in-browser demo
// (its own database): never called on a server.
import { Db, num } from './db';
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

type Product = { name: string; sku: string; price: number; cost: number; variants: string[] };
type People = { name: string; email: string; roles: string[] }[];
interface DemoBoutique {
  name: string;
  slug: string;
  logo: string | null;
  /** where its order numbers start (PX5001…: not mistaken for the demo store's) */
  ref: number;
  products: Product[];
  /** Samira, Nadia, Lamine… work in several boutiques (the same e-mail): « Toutes les boutiques » shows them once */
  people: People;
  companies: { name: string; kind: string }[];
}

export const DEMO_BOUTIQUES: readonly DemoBoutique[] = [
  {
    name: 'Maison Fatima',
    slug: 'maison-fatima',
    logo: null,
    ref: 5001,
    products: [
      { name: 'Parure de lit brodée', sku: 'PARURE', price: 8900, cost: 4200, variants: ['Blanc', 'Beige', 'Gris perle'] },
      { name: 'Rideaux occultants', sku: 'RIDEAU', price: 6500, cost: 2900, variants: ['140 × 260', '200 × 260'] },
      { name: 'Tapis berbère', sku: 'TAPIS', price: 12500, cost: 6800, variants: ['Petit', 'Grand'] },
      { name: 'Coussin brodé main', sku: 'COUSSIN', price: 2400, cost: 900, variants: [] },
      { name: 'Service à thé doré', sku: 'THE', price: 5200, cost: 2300, variants: [] },
    ],
    people: [
      { name: 'Samira', email: 'samira@demo.pilotix.dz', roles: ['confirmation'] },
      { name: 'Meriem', email: 'meriem@demo.pilotix.dz', roles: ['confirmation'] },
      { name: 'Nadia', email: 'nadia@demo.pilotix.dz', roles: ['suivi'] },
      { name: 'Lamine', email: 'lamine@demo.pilotix.dz', roles: ['livreur'] },
    ],
    companies: [
      { name: 'Yalidine', kind: 'yalidine' },
      { name: 'Nos livreurs', kind: 'own' },
    ],
  },
  {
    name: 'Sport Zone Alger',
    slug: 'sport-zone-alger',
    logo: SPORT_LOGO,
    ref: 7001,
    products: [
      { name: 'Maillot Algérie 2026', sku: 'MAILLOT', price: 4500, cost: 1800, variants: ['S', 'M', 'L', 'XL'] },
      { name: 'Chaussures de running', sku: 'RUN', price: 9800, cost: 5200, variants: ['41', '42', '43', '44'] },
      { name: 'Haltères 2 × 5 kg', sku: 'HALT', price: 6200, cost: 3100, variants: [] },
      { name: 'Tapis de yoga', sku: 'YOGA', price: 3300, cost: 1200, variants: ['Bleu', 'Noir'] },
      { name: 'Ballon de football pro', sku: 'BALLON', price: 2900, cost: 1100, variants: [] },
    ],
    people: [
      { name: 'Samira', email: 'samira@demo.pilotix.dz', roles: ['confirmation'] },
      { name: 'Walid', email: 'walid.sz@demo.pilotix.dz', roles: ['confirmation', 'suivi'] },
    ],
    companies: [
      { name: 'Yalidine', kind: 'yalidine' },
      { name: 'ZR Express', kind: 'zr' },
    ],
  },
];

// ---------------------------------------------------------------- a boutique's own fake orders
const FIRST = ['Amine', 'Yacine', 'Sofiane', 'Karim', 'Walid', 'Nassim', 'Mehdi', 'Bilal', 'Amel', 'Samira', 'Nadia', 'Lina', 'Sarah', 'Imane', 'Meriem', 'Yasmine', 'Rania', 'Asma', 'Fatima', 'Houda'];
const LAST = ['Benali', 'Bouzid', 'Haddad', 'Mansouri', 'Belkacem', 'Cherif', 'Saidi', 'Boudiaf', 'Kaci', 'Meziane', 'Hamidi', 'Rahmani', 'Brahimi', 'Lounis', 'Touati'];
const PLACES: [number, string][] = [[16, 'Bab Ezzouar'], [16, 'Kouba'], [31, 'Es Senia'], [25, 'El Khroub'], [9, 'Boufarik'], [6, 'Akbou'], [15, 'Azazga'], [19, 'El Eulma'], [35, 'Boudouaou'], [13, 'Maghnia']];
const CANCEL = ['Prix trop cher', 'Frais de livraison trop chers', 'A commandé ailleurs', 'Changé d’avis'];

/** The boutique's team, couriers, products and about 45 orders of the last three weeks (its own pseudo-random list). */
async function seedBoutiqueData(db: Db, b: DemoBoutique, ownerId: number, passwordHash: string, now: number) {
  let seed = b.ref;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const iso = (t: number) => new Date(t).toISOString();
  const people: Record<string, number> = {};
  for (const p of b.people)
    people[p.email] = num((await db.query(`INSERT INTO profiles (name, email, phone, password_hash, roles) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [p.name, p.email, `07${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`, passwordHash, p.roles]))[0].id);
  const conf = b.people.filter((p) => p.roles.includes('confirmation')).map((p) => people[p.email]);
  const follow = b.people.filter((p) => p.roles.includes('suivi')).map((p) => people[p.email]);
  const livreur = b.people.find((p) => p.roles.includes('livreur'));
  const wh = num((await db.query(`SELECT id FROM warehouses WHERE is_default LIMIT 1`))[0]?.id ?? (await db.query(`INSERT INTO warehouses (name, wilaya_id, commune, is_default) VALUES ('Dépôt', 16, 'Alger', true) RETURNING id`))[0].id);
  const comps: { id: number; kind: string }[] = [];
  for (const c of b.companies) comps.push({ id: num((await db.query('INSERT INTO delivery_companies (name, kind, credentials) VALUES ($1,$2,$3) RETURNING id', [c.name, c.kind, JSON.stringify(c.kind === 'own' ? {} : { demo: true })]))[0].id), kind: c.kind });
  const own = comps.find((c) => c.kind === 'own');
  if (own && livreur) await db.query('UPDATE profiles SET livreur_company_id = $1 WHERE id = $2', [own.id, people[livreur.email]]);
  const catalog: { id: number; name: string; price: number; cost: number; variants: { id: number; title: string }[] }[] = [];
  for (const p of b.products) {
    const pid = num((await db.query('INSERT INTO products (name, sku, price, cost) VALUES ($1,$2,$3,$4) RETURNING id', [p.name, p.sku, p.price, p.cost]))[0].id);
    const vs: { id: number; title: string }[] = [];
    for (const [k, title] of (p.variants.length ? p.variants : ['']).entries()) {
      const vid = num((await db.query('INSERT INTO product_variants (product_id, title, sku) VALUES ($1,$2,$3) RETURNING id', [pid, title, `${p.sku}-${k + 1}`]))[0].id);
      await db.query('INSERT INTO stock (variant_id, warehouse_id, qty, alert_qty) VALUES ($1,$2,$3,5)', [vid, wh, 15 + Math.floor(rnd() * 60)]);
      vs.push({ id: vid, title });
    }
    catalog.push({ id: pid, name: p.name, price: p.price, cost: p.cost, variants: vs });
  }
  const N = 45;
  for (let i = 0; i < N; i++) {
    const created = now - Math.pow(rnd(), 1.6) * 21 * 86_400_000;
    const age = (now - created) / 86_400_000;
    const [wilaya, commune] = pick(PLACES);
    const phone = `0${pick(['5', '6', '7'])}${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`;
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const cust = num((await db.query('INSERT INTO customers (phone, name, wilaya_id, orders) VALUES ($1,$2,$3,1) RETURNING id', [phone, name, wilaya]))[0].id);
    const p = pick(catalog);
    const v = pick(p.variants);
    const qty = rnd() < 0.85 ? 1 : 2;
    const r = rnd();
    const cs = age < 0.5 ? (r < 0.6 ? 'new' : r < 0.8 ? 'no_answer' : 'confirmed') : age < 2 ? (r < 0.15 ? 'no_answer' : r < 0.22 ? 'callback' : r < 0.82 ? 'confirmed' : 'cancelled') : r < 0.8 ? 'confirmed' : 'cancelled';
    const f = rnd();
    const fs = cs !== 'confirmed' ? null : age < 1 ? 'to_prepare' : age < 2.5 ? (f < 0.4 ? 'prepared' : 'shipped') : age < 6 ? (f < 0.45 ? 'out_for_delivery' : f < 0.55 ? 'alert' : f < 0.85 ? 'delivered' : 'returning') : f < 0.8 ? 'delivered' : 'returned';
    const agent = cs === 'new' && rnd() < 0.5 ? null : pick(conf);
    const shippedLike = !!fs && !['to_prepare', 'prepared'].includes(fs);
    const company = shippedLike || fs === 'prepared' ? pick(comps) : null;
    const lv = company && company.kind === 'own' && livreur ? people[livreur.email] : null;
    const fee = wilaya === 16 ? 400 : 650;
    const subtotal = p.price * qty;
    const tConf = created + (0.5 + rnd() * 5) * 3_600_000;
    const tShip = tConf + (10 + rnd() * 20) * 3_600_000;
    const tDone = tShip + (30 + rnd() * 60) * 3_600_000;
    const cap = (t: number) => Math.min(t, now - 60_000);
    const delivered = fs === 'delivered';
    const ref = `PX${b.ref + i}`;
    const o = num(
      (
        await db.query(
          `INSERT INTO orders (ref, created_at, updated_at, created_by, customer_id, customer_name, phone, wilaya_id, commune, address, is_stopdesk, channel,
             conf_status, agent_id, attempts, confirmed_at, follow_status, company_id, warehouse_id, livreur_id, follow_agent_id, tracking,
             subtotal, delivery_fee, discount, total, delivery_cost, cashed, prepared_at, shipped_at, delivered_at, returned_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'',false,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,0,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
          [
            ref, iso(created), iso(cap(delivered ? tDone : shippedLike ? tShip : cs === 'confirmed' ? tConf : created + 3_600_000)), ownerId, cust, name, phone, wilaya, commune,
            pick(['site', 'facebook', 'facebook', 'instagram', 'tiktok', 'whatsapp']), cs, agent, cs === 'no_answer' ? 1 : 0, cs === 'confirmed' ? iso(cap(tConf)) : null,
            fs, company?.id ?? null, fs ? wh : null, lv, shippedLike && follow.length ? pick(follow) : null,
            shippedLike && company && company.kind !== 'own' ? `${company.kind === 'zr' ? 'ZR' : 'yal'}-${String(b.ref * 31 + i * 7919).slice(-8)}` : null,
            subtotal, fee, subtotal + fee, shippedLike ? Math.round(fee * 0.85) : 0, delivered && age > 6, fs && fs !== 'to_prepare' ? iso(cap(tConf + 6 * 3_600_000)) : null,
            shippedLike ? iso(cap(tShip)) : null, delivered ? iso(cap(tDone)) : null, fs === 'returned' ? iso(cap(tDone + 86_400_000)) : null,
          ],
        )
      )[0].id,
    );
    await db.query('INSERT INTO order_items (order_id, product_id, variant_id, name, variant_title, qty, unit_price, purchase_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [o, p.id, v.id, p.name, v.title, qty, p.price, p.cost]);
    await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value) VALUES ($1,$2,NULL,'created',NULL,'new')`, [o, iso(created)]);
    if (cs !== 'new') await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,'conf_status','new',$4,$5)`, [o, iso(cap(tConf)), agent, cs, cs === 'cancelled' ? pick(CANCEL) : null]);
    if (fs) await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value) VALUES ($1,$2,$3,'follow_status',NULL,$4)`, [o, iso(cap(shippedLike ? tShip : tConf)), agent, fs]);
  }
  await db.query(`SELECT setval('order_ref_seq', $1)`, [b.ref + N]);
}

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
    const sb = t.shop(s.schema);
    const owner = num((await sb.query('SELECT id FROM profiles WHERE lower(email) = $1', [OWNER]))[0]?.id);
    if (owner) await seedBoutiqueData(sb, b, owner, String(admin.password_hash), now);
  }
  // the login index leaves the demo's e-mails out (on a server they never log in): this preview's own database lists them
  await t.platform.query(
    `INSERT INTO platform.logins (email, shop_id) SELECT $1, id FROM platform.shops WHERE kind = 'store' AND owner_account_id = $2 ON CONFLICT DO NOTHING`,
    [OWNER, account.id],
  );
}
