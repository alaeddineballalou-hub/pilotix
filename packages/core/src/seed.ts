// Base data (every install) and demo data (preview only). All demo people, phones and orders are invented.
import { CONF_TODO, ConfStatus, FollowStatus } from '@pilotix/shared';
import { fakeTracking } from './couriers/demo';
import { Db, num } from './db';
import { UPSELL_BACKFILL } from './migrations/020_upsell';
import { hashPassword } from './modules/users';
import { DEFAULT_SETTINGS, setSetting } from './settings';
import { seed as seed_orders } from './seeds/orders';
import { seed as seed_confirmation } from './seeds/confirmation';
import { seed as seed_stats } from './seeds/stats';
import { seed as seed_catalog } from './seeds/catalog';
import { seed as seed_stock } from './seeds/stock';
import { seed as seed_customers } from './seeds/customers';
import { seed as seed_suivi } from './seeds/suivi';
import { seed as seed_sav } from './seeds/sav';
import { seed as seed_delivery } from './seeds/delivery';
import { seed as seed_zr } from './seeds/zr';
import { seed as seed_cash } from './seeds/cash';
import { seed as seed_admin } from './seeds/admin';
import { seed as seed_ads } from './seeds/ads';
import { seed as seed_dellal } from './seeds/dellal';
import { seed as seed_cm } from './seeds/cm';
import { seed as seed_notify } from './seeds/notify';

/** First admin + one warehouse. Used by the real server on first start. */
export async function seedBase(db: Db, admin: { email: string; password: string; name?: string }) {
  if (admin.password.length < 10) throw new Error('Admin password must be at least 10 characters');
  await db.query(
    `INSERT INTO profiles (name, email, password_hash, roles) VALUES ($1,$2,$3,'{admin}') ON CONFLICT (email) DO NOTHING`,
    [admin.name ?? 'Administrateur', admin.email.toLowerCase(), await hashPassword(admin.password)],
  );
  const wh = await db.query('SELECT id FROM warehouses LIMIT 1');
  if (!wh.length) await db.query(`INSERT INTO warehouses (name, wilaya_id, commune, is_default) VALUES ('Dépôt principal', 16, 'Alger', true)`);
}

// ---------------------------------------------------------------- demo
let seed = 20261021;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const chance = (p: number) => rnd() < p;

export { DEMO_ACCOUNTS, DEMO_PASSWORD } from '@pilotix/shared';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '@pilotix/shared';

const FIRST = ['Amine', 'Yacine', 'Sofiane', 'Karim', 'Walid', 'Nassim', 'Riad', 'Mehdi', 'Bilal', 'Hichem', 'Lyes', 'Anis', 'Amel', 'Samira', 'Nadia', 'Lina', 'Sarah', 'Imane', 'Meriem', 'Yasmine', 'Rania', 'Khadidja', 'Asma', 'Selma', 'Fatima', 'Mohamed', 'Abdelkader', 'Houda'];
const LAST = ['Benali', 'Bouzid', 'Haddad', 'Mansouri', 'Belkacem', 'Cherif', 'Saidi', 'Boudiaf', 'Ait Ahmed', 'Kaci', 'Meziane', 'Hamidi', 'Rahmani', 'Zerrouki', 'Brahimi', 'Lounis', 'Touati', 'Benyahia', 'Djebbar', 'Ouali', 'Bensalem', 'Khelifi'];
const PLACES: [number, string[]][] = [
  [16, ['Bab Ezzouar', 'Hydra', 'Kouba', 'Bir Mourad Raïs', 'Chéraga', 'El Harrach', 'Dely Ibrahim', 'Bordj El Kiffan', 'Rouiba']],
  [16, ['Baraki', 'Draria', 'Saoula']],
  [31, ['Oran', 'Bir El Djir', 'Es Senia', 'Arzew']],
  [25, ['Constantine', 'El Khroub', 'Ali Mendjeli']],
  [9, ['Blida', 'Boufarik', 'Ouled Yaïch']],
  [19, ['Sétif', 'El Eulma']],
  [23, ['Annaba', 'El Bouni']],
  [6, ['Béjaïa', 'Akbou']],
  [15, ['Tizi Ouzou', 'Azazga']],
  [35, ['Boumerdès', 'Thénia']],
  [42, ['Tipaza', 'Koléa']],
  [5, ['Batna']],
  [60, ['Barika']],
  [13, ['Tlemcen', 'Maghnia']],
  [30, ['Ouargla', 'Hassi Messaoud']],
  [47, ['Ghardaïa']],
  [7, ['Biskra']],
  [10, ['Bouira']],
  [68, ['Bou Saâda']],
];
const PRODUCTS = [
  { name: 'Poussette canne pliable', sku: 'PX-POU', price: 12900, cost: 7200, w: 6, variants: ['Gris', 'Bleu marine', 'Rose'], packs: [], maxD: 1000 },
  { name: 'Ensemble bébé 3 pièces', sku: 'PX-ENS', price: 2900, cost: 1100, w: 0.4, variants: ['0-3 mois', '3-6 mois', '6-12 mois'], packs: [{ qty: 2, price: 5200 }, { qty: 3, price: 7500 }], maxD: 300 },
  { name: 'Biberon anti-colique 260 ml', sku: 'PX-BIB', price: 1500, cost: 600, w: 0.2, variants: [], packs: [{ qty: 3, price: 3900 }], maxD: 200 },
  { name: 'Lit parapluie', sku: 'PX-LIT', price: 15900, cost: 9100, w: 9, variants: ['Gris', 'Beige'], packs: [], maxD: 1500 },
  { name: 'Chaise haute évolutive', sku: 'PX-CHA', price: 8900, cost: 4800, w: 7, variants: [], packs: [], maxD: 800 },
  { name: 'Sac à langer à dos', sku: 'PX-SAC', price: 4500, cost: 2000, w: 0.8, variants: ['Noir', 'Camel'], packs: [], maxD: 400 },
  { name: 'Tapis d’éveil musical', sku: 'PX-TAP', price: 5900, cost: 2900, w: 1.5, variants: [], packs: [], maxD: 500 },
  { name: 'Thermomètre frontal', sku: 'PX-THE', price: 2400, cost: 900, w: 0.2, variants: [], packs: [], maxD: 200 },
  { name: 'Lot de 6 bodies coton', sku: 'PX-BOD', price: 3200, cost: 1300, w: 0.5, variants: ['Naissance', '3 mois', '6 mois', '12 mois'], packs: [], maxD: 300 },
  { name: 'Écharpe de portage', sku: 'PX-ECH', price: 3900, cost: 1600, w: 0.6, variants: ['Gris chiné', 'Vert sauge'], packs: [], maxD: 300 },
];

async function bulkInsert(db: Db, table: string, cols: string[], rows: unknown[][], returning = '') {
  const out: any[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params: unknown[] = [];
    const values = chunk.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(',')})`).join(',');
    out.push(...(await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values} ${returning}`, params)));
  }
  return out;
}

const iso = (t: number) => new Date(t).toISOString();

/** Fills an empty database with a realistic shop: team, catalog, couriers, ~1,500 orders over 60 days. */
export async function seedDemo(db: Db, opts: { orders?: number; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const N = opts.orders ?? 1500;
  seed = 20261021;
  const hash = await hashPassword(DEMO_PASSWORD);

  // team
  const users: Record<string, number> = {};
  for (const a of DEMO_ACCOUNTS) {
    const r = await db.query(
      `INSERT INTO profiles (name, email, phone, password_hash, roles, last_seen_at, presence) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [a.name, a.email, `06${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`, hash, a.roles, iso(now - rnd() * 3_600_000),
        a.key.startsWith('conf') || a.key === 'suivi' ? pick(['online', 'online', 'call', 'idle']) : 'offline'],
    );
    users[a.key] = num(r[0].id);
  }
  const agents = [users.conf1, users.conf2, users.conf3, users.manager1, users.manager2];

  // settings
  const grid: Record<string, { home: number; desk: number }> = {};
  for (let w = 1; w <= 69; w++) {
    const far = [1, 11, 33, 37, 49, 50, 52, 53, 54, 56].includes(w);
    const south = [3, 7, 8, 17, 30, 32, 39, 45, 47, 51, 55, 57, 58, 59, 61, 63, 66, 68, 69].includes(w);
    const base = w === 16 ? 400 : [9, 35, 42].includes(w) ? 500 : far ? 1300 : south ? 900 : 650;
    grid[String(w)] = { home: base, desk: Math.max(300, base - 250) };
  }
  await setSetting(db, 'clientFees', { Standard: grid });
  await setSetting(db, 'shop', { ...DEFAULT_SETTINGS.shop, name: 'Pilotix Démo' });
  await setSetting(db, 'teams', [
    { id: 't1', name: 'Équipe Yacine', managerId: users.manager1, agentIds: [users.conf1, users.conf2] },
    { id: 't2', name: 'Équipe Amel', managerId: users.manager2, agentIds: [users.conf3] },
  ]);
  await setSetting(db, 'webhook', { key: 'demo-webhook-key' });

  // depots
  const wh1 = num((await db.query(`INSERT INTO warehouses (name, wilaya_id, commune, address, is_default) VALUES ('Dépôt Alger', 16, 'Bab Ezzouar', 'Zone d’activité, lot 12', true) RETURNING id`))[0].id);
  await db.query(`INSERT INTO warehouses (name, wilaya_id, commune, address) VALUES ('Dépôt Oran', 31, 'Es Senia', 'Route de l’aéroport')`);

  // couriers
  const comp = async (name: string, kind: string, keys: boolean) =>
    num((await db.query('INSERT INTO delivery_companies (name, kind, credentials) VALUES ($1,$2,$3) RETURNING id', [name, kind, JSON.stringify(keys ? { demo: true } : {})]))[0].id);
  const yal = await comp('Yalidine', 'yalidine', true);
  const zr = await comp('ZR Express', 'zr', true);
  const own = await comp('Nos livreurs', 'own', false);
  await db.query('UPDATE profiles SET livreur_company_id=$1 WHERE id = ANY($2)', [own, [users.livreur, users.livreur2]]);
  await setSetting(db, 'shop', { ...DEFAULT_SETTINGS.shop, name: 'Pilotix Démo', defaultCompanyId: yal, savPhone: '0550 11 22 33' });
  const feeRows: unknown[][] = [];
  for (let w = 1; w <= 69; w++) {
    feeRows.push([yal, w, Math.round(grid[w].home * 0.85), Math.round(grid[w].desk * 0.85), 200]);
    feeRows.push([zr, w, Math.round(grid[w].home * 0.8), Math.round(grid[w].desk * 0.8), 250]);
  }
  await bulkInsert(db, 'delivery_fees', ['company_id', 'wilaya_id', 'home', 'desk', 'return_fee'], feeRows);
  for (const [w, communes] of PLACES.slice(0, 10)) {
    await db.query('INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address) VALUES ($1,$2,$3,$4,$5)', [yal, w, communes[0], `Yalidine ${communes[0]}`, 'Centre-ville']);
  }

  // catalog + stock
  const catalog: { id: number; name: string; price: number; cost: number; variants: { id: number; title: string }[] }[] = [];
  for (const p of PRODUCTS) {
    const pid = num(
      (await db.query('INSERT INTO products (name, sku, price, cost, weight_kg, packs, max_discount) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [p.name, p.sku, p.price, p.cost, p.w, JSON.stringify(p.packs), p.maxD]))[0].id,
    );
    const vs: { id: number; title: string }[] = [];
    for (const [k, t] of (p.variants.length ? p.variants : ['']).entries()) {
      const vid = num((await db.query('INSERT INTO product_variants (product_id, title, sku) VALUES ($1,$2,$3) RETURNING id', [pid, t, `${p.sku}-${k + 1}`]))[0].id);
      vs.push({ id: vid, title: t });
      const qty = chance(0.12) ? Math.floor(rnd() * 4) : 20 + Math.floor(rnd() * 120);
      await db.query('INSERT INTO stock (variant_id, warehouse_id, qty, alert_qty) VALUES ($1,$2,$3,$4)', [vid, wh1, qty, 5]);
      await db.query(`INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, user_id, created_at) VALUES ($1,$2,$3,'entry',$4,$5)`, [vid, wh1, qty + 60, users.depot, iso(now - 65 * 86_400_000)]);
    }
    catalog.push({ id: pid, name: p.name, price: p.price, cost: p.cost, variants: vs });
  }
  await db.query('UPDATE products SET linked = $2 WHERE id = $1', [catalog[0].id, [catalog[5].id, catalog[9].id]]);
  await db.query('UPDATE products SET linked = $2 WHERE id = $1', [catalog[1].id, [catalog[8].id, catalog[2].id]]);

  // orders
  const phones: string[] = [];
  const customers = new Map<string, { id: number; delivered: number; returned: number; orders: number; last: number }>();
  const orderRows: unknown[][] = [];
  const itemsByOrder: unknown[][][] = [];
  const eventsByOrder: unknown[][][] = [];
  const stamps: number[] = [];
  for (let i = 0; i < N; i++) stamps.push(now - Math.pow(rnd(), 1.7) * 60 * 86_400_000);
  stamps.sort((a, b) => a - b);

  for (let i = 0; i < N; i++) {
    const created = stamps[i];
    const age = (now - created) / 86_400_000;
    const [wilaya, communes] = pick(PLACES);
    const reuse = phones.length > 60 && chance(0.1);
    const phone = reuse ? pick(phones) : `0${pick(['5', '6', '7'])}${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`;
    if (!reuse) phones.push(phone);
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    let c = customers.get(phone);
    if (!c) {
      c = { id: num((await db.query('INSERT INTO customers (phone, name, wilaya_id) VALUES ($1,$2,$3) RETURNING id', [phone, name, wilaya]))[0].id), delivered: 0, returned: 0, orders: 0, last: 0 };
      customers.set(phone, c);
    }
    c.orders++;
    c.last = created;

    const lines = chance(0.82) ? 1 : 2;
    const items = Array.from({ length: lines }, (_, k) => {
      const p = pick(catalog);
      const v = pick(p.variants);
      const qty = chance(0.86) ? 1 : 2;
      return { p, v, qty, upsell: k === 1 && chance(0.5) };
    });
    const isDesk = chance(0.22);
    const fee = isDesk ? grid[wilaya].desk : grid[wilaya].home;
    const subtotal = items.reduce((s, it) => s + it.p.price * it.qty, 0);
    const discount = chance(0.12) ? 200 : 0;

    // where the order ended up, by age
    const r = rnd();
    let conf: ConfStatus;
    let follow: FollowStatus | null = null;
    if (age < 0.4) conf = r < 0.6 ? 'new' : r < 0.75 ? 'no_answer' : r < 0.82 ? 'busy' : r < 0.9 ? 'callback' : 'confirmed';
    else if (age < 2) conf = r < 0.1 ? 'new' : r < 0.2 ? 'no_answer' : r < 0.26 ? 'callback' : r < 0.3 ? 'postponed' : r < 0.33 ? 'to_check' : r < 0.82 ? 'confirmed' : r < 0.84 ? 'no_stock' : r < 0.94 ? 'cancelled' : r < 0.97 ? 'duplicate' : 'wrong_number';
    else conf = r < 0.78 ? 'confirmed' : r < 0.9 ? 'cancelled' : r < 0.95 ? 'duplicate' : r < 0.98 ? 'fake' : 'wrong_number';
    if (conf === 'confirmed') {
      const f = rnd();
      if (age < 0.5) follow = 'to_prepare';
      else if (age < 1.5) follow = f < 0.4 ? 'to_prepare' : f < 0.7 ? 'prepared' : 'shipped';
      else if (age < 4) follow = f < 0.08 ? 'prepared' : f < 0.35 ? 'shipped' : f < 0.6 ? 'out_for_delivery' : f < 0.68 ? 'failed' : f < 0.73 ? 'alert' : f < 0.92 ? 'delivered' : 'returning';
      else if (age < 9) follow = f < 0.05 ? 'out_for_delivery' : f < 0.08 ? 'alert' : f < 0.12 ? 'returning' : f < 0.82 ? 'delivered' : f < 0.95 ? 'returned' : 'in_exchange';
      else follow = f < 0.8 ? 'delivered' : f < 0.95 ? 'returned' : f < 0.98 ? 'exchanged' : 'lost';
    }
    const agent = conf === 'new' && chance(0.5) ? null : pick(agents);
    const company = follow && follow !== 'to_prepare' ? (chance(0.12) ? own : chance(0.6) ? yal : zr) : follow ? yal : null;
    const livreur = company === own ? pick([users.livreur, users.livreur2]) : null;
    const attempts = ['no_answer', 'busy'].includes(conf) ? 1 + Math.floor(rnd() * 2) : conf === 'confirmed' && chance(0.3) ? 1 : 0;
    const tConfirm = created + (0.2 + rnd() * 6) * 3_600_000;
    const tPrep = tConfirm + (2 + rnd() * 16) * 3_600_000;
    const tShip = tPrep + (1 + rnd() * 12) * 3_600_000;
    const tDone = tShip + (24 + rnd() * 72) * 3_600_000;
    const cap = (t: number) => Math.min(t, now - 60_000);
    const shippedLike = follow && !['to_prepare', 'prepared'].includes(follow);
    const delivered = follow === 'delivered' || follow === 'exchanged';
    const returned = follow === 'returned';
    if (delivered) c.delivered++;
    if (returned) c.returned++;
    const cost = company === own ? 250 : Math.round(fee * 0.85);
    const nextCall = conf === 'callback' || conf === 'postponed' ? iso(now + (rnd() * 30 - 6) * 3_600_000) : null;

    orderRows.push([
      `PX${1001 + i}`, iso(created), iso(cap(delivered || returned ? tDone : shippedLike ? tShip : conf === 'confirmed' ? tConfirm : created + 3_600_000)), agent ?? users.conf1, c.id, name, phone,
      chance(0.1) ? `0${pick(['5', '6', '7'])}${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}` : null,
      wilaya, pick(communes), chance(0.7) ? `Cité ${pick(['des Oliviers', '1er Novembre', 'El Amel', 'Les Pins', '500 Logements'])}, bât. ${1 + Math.floor(rnd() * 30)}` : '',
      isDesk, pick(['site', 'site', 'facebook', 'facebook', 'instagram', 'tiktok', 'whatsapp', 'appel']),
      conf, agent, attempts, attempts ? iso(cap(created + rnd() * 5 * 3_600_000)) : null, nextCall, agent ? iso(created + 600_000) : null,
      conf === 'confirmed' || conf === 'no_stock' ? iso(cap(tConfirm)) : null,
      follow, follow === 'alert' ? null : null, company, follow ? wh1 : null, livreur,
      shippedLike && company !== own ? fakeTracking(company === yal ? 'yalidine' : 'zr', `PX${1001 + i}`, 0) : null, // the courier's own number
      follow === 'failed' ? 1 : 0, subtotal, fee, discount, subtotal - discount + fee, shippedLike ? cost : 0,
      delivered && age > 6 && chance(0.85), delivered && age > 6 ? iso(cap(tDone + 3 * 86_400_000)) : null,
      chance(0.06) ? 'Appeler après 17h' : null, chance(0.05) ? 'Sonner deux fois' : null, null,
      items.some((it) => it.upsell),
      follow && follow !== 'to_prepare' ? iso(cap(tPrep)) : null, shippedLike ? iso(cap(tShip)) : null, delivered ? iso(cap(tDone)) : null, returned ? iso(cap(tDone + 86_400_000)) : null,
    ]);
    itemsByOrder.push(items.map((it) => [it.p.id, it.v.id, it.p.name, it.v.title, it.qty, it.p.price, it.p.cost, it.upsell]));
    const ev: unknown[][] = [[iso(created), null, 'created', null, 'new', null]];
    if (attempts) ev.push([iso(cap(created + 1_800_000)), agent, 'conf_status', 'new', 'no_answer', null]);
    if (conf !== 'new') ev.push([iso(cap(conf === 'confirmed' ? tConfirm : created + 3_600_000)), agent, 'conf_status', attempts ? 'no_answer' : 'new', conf, conf === 'cancelled' ? pick(['Prix trop cher', 'Frais de livraison trop chers', 'A commandé ailleurs', 'Changé d’avis']) : null]);
    const path: FollowStatus[] = [];
    if (follow) {
      const seq: FollowStatus[] = ['to_prepare', 'prepared', 'shipped', 'out_for_delivery'];
      const end = seq.indexOf(follow);
      if (end >= 0) path.push(...seq.slice(0, end + 1));
      else {
        path.push(...seq);
        if (follow === 'returned') path.push('returning', 'returned');
        else if (follow === 'exchanged') path.push('in_exchange', 'exchanged');
        else path.push(follow);
      }
    }
    const tFor = (k: number) => cap([tConfirm, tPrep, tShip, tShip + 86_400_000, tDone, tDone + 86_400_000][Math.min(k, 5)]);
    path.forEach((s, k) => ev.push([iso(tFor(k)), k === 0 ? agent : k <= 2 ? users.depot : livreur ?? users.suivi, 'follow_status', k ? path[k - 1] : null, s, s === 'failed' ? 'Client absent' : null]));
    eventsByOrder.push(ev);
  }

  const inserted = await bulkInsert(
    db,
    'orders',
    ['ref', 'created_at', 'updated_at', 'created_by', 'customer_id', 'customer_name', 'phone', 'phone2', 'wilaya_id', 'commune', 'address', 'is_stopdesk', 'channel',
      'conf_status', 'agent_id', 'attempts', 'last_call_at', 'next_call_at', 'assigned_at', 'confirmed_at', 'follow_status', 'sub_status', 'company_id', 'warehouse_id', 'livreur_id',
      'tracking', 'delivery_attempts', 'subtotal', 'delivery_fee', 'discount', 'total', 'delivery_cost', 'cashed', 'cashed_at', 'customer_note', 'delivery_note', 'internal_note',
      'has_upsell', 'prepared_at', 'shipped_at', 'delivered_at', 'returned_at'],
    orderRows,
    'RETURNING id',
  );
  const itemRows: unknown[][] = [];
  const eventRows: unknown[][] = [];
  inserted.forEach((o, k) => {
    for (const it of itemsByOrder[k]) itemRows.push([num(o.id), ...it]);
    for (const e of eventsByOrder[k]) eventRows.push([num(o.id), ...e]);
  });
  await bulkInsert(db, 'order_items', ['order_id', 'product_id', 'variant_id', 'name', 'variant_title', 'qty', 'unit_price', 'purchase_price', 'is_upsell'], itemRows);
  await bulkInsert(db, 'order_events', ['order_id', 'at', 'user_id', 'kind', 'from_value', 'to_value', 'note'], eventRows);
  await db.query(`SELECT setval('order_ref_seq', $1)`, [1001 + N]);
  for (const c of customers.values()) {
    await db.query('UPDATE customers SET orders=$2, delivered=$3, returned=$4, last_order_at=$5 WHERE id=$1', [c.id, c.orders, c.delivered, c.returned, iso(c.last)]);
  }
  const bad = [...customers.values()].filter((c) => c.returned >= 2);
  if (bad.length) await db.query(`UPDATE customers SET blacklisted = true, blacklist_reason = 'Refuse les colis' WHERE id = ANY($1)`, [bad.map((c) => c.id)]);

  // a few SAV tickets, alerts handled, a chat with a livreur, a cash handover
  const someDelivered = await db.query(`SELECT id, customer_name, phone FROM orders WHERE follow_status='delivered' ORDER BY delivered_at DESC LIMIT 12`);
  const types = ['defect', 'missing', 'wrong', 'late', 'exchange', 'help'];
  for (const [k, o] of someDelivered.entries()) {
    const status = k < 4 ? 'open' : k < 8 ? 'progress' : k < 10 ? 'resolved' : 'closed';
    await db.query(
      `INSERT INTO complaints (ref, order_id, customer_name, phone, type, wish, details, status, assigned_to, created_by, created_at) VALUES ('SAV-' || lpad(nextval('complaint_ref_seq')::text, 4, '0'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [o.id, o.customer_name, o.phone, types[k % types.length], pick(['exchange', 'refund', 'part', 'info']), pick(['Taille trop petite', 'Roue cassée à la livraison', 'Il manque un body dans le lot', 'Couleur différente de la photo']), status, users.manager1, users.suivi, iso(now - (k + 1) * 0.7 * 86_400_000)],
    );
  }
  await db.query(`INSERT INTO chat_messages (livreur_id, user_id, body, created_at) VALUES ($1,$2,'Bonjour, le client de Kouba demande à être livré après 16h.',$3), ($1,$1,'D’accord, je passe vers 16h30.',$4)`, [users.livreur, users.suivi, iso(now - 5_400_000), iso(now - 4_800_000)]);
  const cashed = await db.query(`SELECT id, total, delivery_cost FROM orders WHERE cashed AND company_id = $1 LIMIT 40`, [yal]);
  if (cashed.length) {
    const collected = cashed.reduce((s: number, o: any) => s + num(o.total), 0);
    const fees = cashed.reduce((s: number, o: any) => s + num(o.delivery_cost), 0);
    const h = await db.query('INSERT INTO cash_handovers (company_id, orders, collected, fees, net, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [yal, cashed.map((o: any) => num(o.id)), collected, fees, collected - fees, users.admin, iso(now - 3 * 86_400_000)]);
    await db.query('UPDATE orders SET handover_id=$1 WHERE id = ANY($2)', [h[0].id, cashed.map((o: any) => num(o.id))]);
  }
  await db.query(`SELECT setval('complaint_ref_seq', (SELECT count(*) FROM complaints) + 1)`);

  // ads: two ad sets with 30 days of results
  await db.query(`INSERT INTO adsets (id, name, campaign, product_ids, marketer_id, status) VALUES ('120200001','Poussette — Algérie 25-45','Bébé confort',$1,$3,'ACTIVE'), ('120200002','Ensemble bébé — mamans','Vêtements',$2,$3,'ACTIVE')`, [[catalog[0].id], [catalog[1].id], users.marketer]);
  const insights: unknown[][] = [];
  for (let d = 30; d >= 1; d--) {
    const day = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
    insights.push([day, '120200001', 1800 + Math.floor(rnd() * 900), 9000 + Math.floor(rnd() * 4000), 180 + Math.floor(rnd() * 90), 6 + Math.floor(rnd() * 6), 2500 + Math.floor(rnd() * 800)]);
    insights.push([day, '120200002', 900 + Math.floor(rnd() * 500), 6000 + Math.floor(rnd() * 3000), 120 + Math.floor(rnd() * 60), 5 + Math.floor(rnd() * 5), 1700 + Math.floor(rnd() * 500)]);
  }
  await bulkInsert(db, 'ad_insights', ['day', 'adset_id', 'spend_cents', 'impressions', 'clicks', 'purchases', 'video_3s'], insights);
  const ym = new Date(now).toISOString().slice(0, 7);
  await db.query('INSERT INTO fx_rates (ym, rate) VALUES ($1, 250)', [ym]);

  // feature seeds
  await seed_orders(db, users, now);
  await seed_confirmation(db, users, now);
  await seed_stats(db, users, now);
  await seed_catalog(db, users, now);
  await seed_stock(db, users, now);
  await seed_customers(db, users, now);
  await seed_suivi(db, users, now);
  await seed_sav(db, users, now);
  await seed_delivery(db, users, now);
  await seed_zr(db, users, now);
  await seed_cash(db, users, now);
  await seed_admin(db, users, now);
  await seed_ads(db, users, now);
  await seed_dellal(db, users, now);
  await seed_cm(db, users, now);
  // every demo order (written straight into the database) keeps what the customer first ordered: the upsell is counted against it
  for (const q of UPSELL_BACKFILL) await db.query(q);
  await seed_notify(db, users, now);

  return { users, orders: N, todo: CONF_TODO.length };
}
