// Names that change keep working: a landing page's or a group's former address still opens it (and takes its orders),
// a renamed size keeps its row (stock, price list, code), the Dashboard counts a renamed product once under its name of
// today, and what still writes a former name or code (a Google Sheet, a Meta lead form, the website, an Excel import)
// finds the same product and size.
import { sha256Hex, zeroBits } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { findBySku } from '../modules/catalog';
import { LANDING_POW_BITS, makeChallenge } from '../modules/landing';
import { variantOf } from '../modules/leads';
import { EMAILS, setup } from './harness';

const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};
const page = (productId: number, slug: string, id?: number) => ({ ...(id ? { id } : {}), productId, slug, title: 'Page', color: '#db2777', price: 9950, description: 'x' });
const html = async (ctx: Ctx, slug: string) => ((await call('landing.html', ctx, { slug, mode: 'live', post: '/o', geo: '/g/', imgBase: null })) as any).html as string;

test('a landing page keeps its old address: it opens there, takes orders there, and no other page or group may take it', async () => {
  const s = await setup(20);
  const admin = await s.as(EMAILS.admin);
  const mk = await s.as(EMAILS.marketer);
  const pou = (await s.db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.sku = 'PX-POU' AND v.title <> '' ORDER BY v.id LIMIT 1`))[0];
  const cha = Number((await s.db.query(`SELECT id FROM products WHERE sku = 'PX-CHA'`))[0].id);
  const lp: any = await call('landing.save', mk, page(Number(pou.id), 'poussette-promo'));
  await call('landing.save', mk, page(Number(pou.id), 'poussette-ete', lp.id));
  assert.ok((await html(admin, 'poussette-ete')).length > 1000);
  // the ads already running still point to the old address: the same page opens
  assert.ok((await html(admin, 'poussette-promo')).length > 1000);

  // a form opened before the change sends its order to the old address: it arrives, on this page
  const t0 = Date.now() - 25_000;
  const ch = await makeChallenge(s.db, 'poussette-promo', t0);
  const phone = '0661987001';
  await call('landing.submit', admin, {
    slug: 'poussette-promo', name: 'Amina Benali', phone, wilaya: 16, commune: 'Hydra', variant: Number(pou.vid), qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false,
    fp: 'fpabc123', did: 'd1', meta: { ip: '10.0.0.9', ua: UA },
  });
  const o = (await s.db.query('SELECT landing_id FROM orders WHERE phone = $1', [phone]))[0];
  assert.equal(Number(o?.landing_id), lp.id);

  // nobody else takes the old address (its old links would open someone else's product)
  await assert.rejects(call('landing.save', mk, page(cha, 'poussette-promo')), /ancienne adresse d’une autre landing page/);
  await assert.rejects(call('landing.groupSave', mk, { slug: 'poussette-promo', title: 'G', items: [{ pageId: lp.id }] }), /ancienne adresse/);
  assert.notEqual(((await call('landing.freeSlug', mk, { name: 'poussette promo' })) as any).slug, 'poussette-promo');
  // the page itself may take it back: the other one becomes its old address
  await call('landing.save', mk, page(Number(pou.id), 'poussette-promo', lp.id));
  assert.ok((await html(admin, 'poussette-ete')).length > 1000);
  assert.deepEqual((await s.db.query('SELECT slug FROM landing_old_slugs WHERE page_id = $1 ORDER BY slug', [lp.id])).map((r: any) => r.slug), ['poussette-ete']);
  // a page removed frees its old addresses
  await call('landing.remove', mk, { id: lp.id });
  await assert.rejects(html(admin, 'poussette-ete'), /introuvable/);
  assert.equal(((await call('landing.freeSlug', mk, { name: 'poussette ete' })) as any).slug, 'poussette-ete');
});

test('a group page keeps its old address too, and its orders through the old address still count', async () => {
  const s = await setup(20);
  const admin = await s.as(EMAILS.admin);
  const mk = await s.as(EMAILS.marketer);
  const pou = Number((await s.db.query(`SELECT id FROM products WHERE sku = 'PX-POU'`))[0].id);
  const lp: any = await call('landing.save', mk, page(pou, 'poussette-groupe'));
  const g: any = await call('landing.groupSave', mk, { slug: 'bebe-promo', title: 'Promo bébé', items: [{ pageId: lp.id }] });
  // an order that came through the group's first address
  await s.db.query(`UPDATE orders SET utm = '{"g":"bebe-promo"}'::jsonb, landing_id = $1 WHERE id = (SELECT min(id) FROM orders)`, [lp.id]);
  await call('landing.groupSave', mk, { id: g.id, slug: 'bebe-soldes', title: 'Promo bébé', items: [{ pageId: lp.id }] });
  assert.ok((await html(admin, 'bebe-soldes')).includes('Promo bébé'));
  assert.ok((await html(admin, 'bebe-promo')).includes('Promo bébé'));
  const row = ((await call('landing.groups', mk, {})) as any[]).find((x) => x.id === g.id);
  assert.equal(row.slug, 'bebe-soldes');
  assert.equal(row.orders, 1);
  assert.equal(row.items[0].orders, 1);
  await assert.rejects(call('landing.save', mk, page(pou, 'bebe-promo')), /ancienne adresse d’un groupe/);
});

async function resave(ctx: Ctx, db: Db, id: number, ch: { name?: string; sku?: string; value?: [string, string]; vsku?: (sku: string) => string }) {
  const p = (await db.query('SELECT * FROM products WHERE id = $1', [id]))[0];
  const vs = await db.query("SELECT * FROM product_variants WHERE product_id = $1 AND title <> '' ORDER BY id", [id]);
  const swap = (x: string) => (ch.value && x === ch.value[0] ? ch.value[1] : x);
  const options = (typeof p.options === 'string' ? JSON.parse(p.options) : p.options ?? []).map((o: any) => ({ name: o.name, values: o.values.map(swap) }));
  return call('catalog.saveProduct', ctx, {
    id,
    name: ch.name ?? p.name,
    sku: ch.sku ?? p.sku,
    price: Number(p.price),
    cost: Number(p.cost),
    weightKg: Number(p.weight_kg),
    isService: !!p.is_service,
    active: !!p.active,
    fixedPrice: !!p.fixed_price,
    options,
    variants: vs.map((v: any) => ({ id: Number(v.id), title: v.title.split(' / ').map(swap).join(' / '), sku: ch.vsku ? ch.vsku(v.sku) : v.sku, active: !!v.active })),
  });
}

test('a size renamed keeps its row; former names and codes still find it (Google Sheet, website, lead forms, Excel import)', async () => {
  const s = await setup(20);
  const admin = await s.as(EMAILS.admin);
  const ens = (await s.db.query(`SELECT id, name FROM products WHERE sku = 'PX-ENS'`))[0];
  const pid = Number(ens.id);
  const v0 = (await s.db.query(`SELECT id, sku FROM product_variants WHERE product_id = $1 AND title = '0-3 mois'`, [pid]))[0];
  const vid = Number(v0.id);
  const stockOf = async () => Number((await s.db.query('SELECT COALESCE(sum(qty), 0) AS n FROM stock WHERE variant_id = $1', [vid]))[0].n);
  const stock0 = await stockOf();
  await s.db.query(`UPDATE product_variants SET fee_grid = 'Gros colis' WHERE id = $1`, [vid]);

  // « 0-3 mois » → « 0-3 m », the product's name and codes changed too
  await resave(admin, s.db, pid, { name: 'Ensemble naissance 3 pièces', sku: 'PX-ENS3', value: ['0-3 mois', '0-3 m'], vsku: (x) => x.replace('PX-ENS', 'PX-ENS3') });
  const v = (await s.db.query('SELECT * FROM product_variants WHERE id = $1', [vid]))[0];
  assert.equal(v.title, '0-3 m');
  assert.equal(await stockOf(), stock0, 'the stock stays with the size');
  assert.equal(v.fee_grid, 'Gros colis', 'so does its delivery price list');
  assert.deepEqual(v.old_titles, ['0-3 mois']);
  assert.deepEqual(v.old_skus, [v0.sku]);
  assert.equal(Number((await s.db.query("SELECT count(*) AS n FROM product_variants WHERE product_id = $1 AND title <> ''", [pid]))[0].n), 3, 'no new size beside it');
  const p = (await s.db.query('SELECT old_names, old_skus FROM products WHERE id = $1', [pid]))[0];
  assert.deepEqual(p.old_names, [ens.name]);
  assert.deepEqual(p.old_skus, ['PX-ENS']);

  // the codes: now, and before
  assert.deepEqual(await findBySku(s.db, `${String(v0.sku).replace('PX-ENS', 'PX-ENS3')}`), { productId: pid, variantId: vid, former: false });
  assert.deepEqual(await findBySku(s.db, v0.sku), { productId: pid, variantId: vid, former: true });
  assert.deepEqual(await findBySku(s.db, 'PX-ENS'), { productId: pid, variantId: null, former: true });
  assert.equal(await findBySku(s.db, 'NO-SUCH-CODE'), null);

  // a Meta lead form still offering « 0-3 mois »
  assert.equal(variantOf([{ id: 1, title: '3-6 mois' }, { id: vid, title: '0-3 m', oldTitles: ['0-3 mois'] }], '0-3 mois'), vid);

  // a Google Sheet written before the change: the old size code; the old product name with the old size name
  const csv = `N°,Client,Téléphone,Wilaya,Commune,SKU,Produit,Taille,Qté\n2001,Sara Haddad,0661 55 44 01,16 - Alger,Hydra,${v0.sku},,,1\n2002,Nadia Saidi,0661 55 44 02,16 - Alger,Hydra,,"${ens.name}",0-3 mois,1\n`;
  const ctx = { ...admin, server: { sheetCsv: async () => csv } as any };
  const chn: any = await call('admin.channels.save', admin, { kind: 'sheets', name: 'Feuille', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-y/pubhtml' });
  const r: any = await call('channels.sheet.read', ctx, { id: chn.id });
  await call('channels.sheet.saveMapping', ctx, { id: chn.id, mapping: { ...r.mapping, 'N°': 'ref', SKU: 'sku', Produit: 'product', Taille: 'variant', Qté: 'qty' } });
  const sync: any = await call('channels.sheet.sync', ctx, { id: chn.id });
  assert.equal(sync.errorCount, 0, JSON.stringify(sync.errors));
  assert.equal(sync.created, 2);
  for (const ph of ['0661554401', '0661554402']) {
    const it = (await s.db.query('SELECT i.product_id, i.variant_id FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.phone = $1', [ph]))[0];
    assert.deepEqual([Number(it.product_id), Number(it.variant_id)], [pid, vid], ph);
  }

  // an Excel import with the product's old code: the same product, not a second one
  const plan: any = await call('catalog.importProducts', admin, { rows: [{ line: 2, name: 'Ensemble bébé (fichier)', sku: 'PX-ENS', price: 1800 }] });
  assert.equal(plan.products[0].status, 'skip');
  assert.match(plan.products[0].warnings.join(' '), /ancien code/);

  // named back: its name of today leaves the old ones (and the name it had becomes one)
  await resave(admin, s.db, pid, { value: ['0-3 m', '0-3 mois'] });
  assert.deepEqual((await s.db.query('SELECT old_titles FROM product_variants WHERE id = $1', [vid]))[0].old_titles, ['0-3 m']);
});

test('Dashboard « Meilleurs produits »: a renamed product is one line, under its name of today', async () => {
  const s = await setup(300);
  const admin = await s.as(EMAILS.admin);
  const r = { from: new Date(Date.now() - 365 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
  const before: any = await call('stats.overview2', admin, r);
  const best = before.products.top[0];
  const pid = Number((await s.db.query('SELECT id FROM products WHERE name = $1', [best.name]))[0].id);
  // half of its orders were made under a name it no longer has
  await s.db.query("UPDATE order_items SET name = 'Ancien nom' WHERE product_id = $1 AND id % 2 = 0", [pid]);
  await s.db.query("UPDATE products SET name = 'Nom de maintenant' WHERE id = $1", [pid]);
  const after: any = await call('stats.overview2', admin, r);
  const lines = after.products.top.filter((x: any) => ['Ancien nom', 'Nom de maintenant', best.name].includes(x.name));
  assert.deepEqual(lines.map((x: any) => x.name), ['Nom de maintenant']);
  assert.equal(lines[0].value, best.value);
  assert.equal(lines[0].qty, best.qty);
});
