// « Envoyer des photos » (Confirmation): the agent picks the products (the order's, with their colour, or others) and
// their photos go in a page whose link the WhatsApp message carries. Only the shop's products and photos: never the
// customer's data; the agent's own orders and products only; old pages removed.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { photoPageHtml, sharePhotos } from '../modules/photoshare';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (e: string) => Promise<Ctx>;
let samira: Ctx;
let admin: Ctx;

before(async () => {
  ({ db, as } = await setup(60));
  [samira, admin] = await Promise.all([as(EMAILS.conf), as(EMAILS.admin)]);
});

/** a tiny PNG (as the shop's photos are kept: a data: link) */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** a product with a photo and colours, and an order with it (given to Samira) */
const withPhoto = async () => {
  const p = (
    await db.query(`SELECT p.id, (SELECT v.id FROM product_variants v WHERE v.product_id = p.id AND v.active ORDER BY v.id LIMIT 1) AS vid FROM products p
       WHERE p.active AND NOT p.is_service AND EXISTS (SELECT 1 FROM order_items i WHERE i.product_id = p.id)
       ORDER BY p.id LIMIT 1`)
  )[0];
  assert.ok(p, 'a product ordered in the demo');
  await db.query('UPDATE products SET photo = $2 WHERE id = $1', [p.id, PNG]);
  const o = (await db.query(`SELECT o.id FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.product_id = $1 ORDER BY o.id LIMIT 1`, [p.id]))[0];
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [o.id, samira.session.profile.id]);
  return { productId: Number(p.id), variantId: p.vid == null ? null : Number(p.vid), orderId: Number(o.id) };
};

test('the window: each product and colour with its photos and its name', async () => {
  const { productId, variantId } = await withPhoto();
  const r: any = await call('confirmation.photoThumbs', samira, { items: [{ productId, variantId }, { productId, variantId }] });
  assert.equal(r.length, 1, 'the same product and colour once');
  assert.ok(r[0].count >= 1);
  assert.ok(r[0].thumbs.length >= 1);
  assert.match(r[0].label, /\S/);
});

test('a send: its page holds the products chosen and their photos — the preview has no public link', async () => {
  const { productId, variantId, orderId } = await withPhoto();
  const r: any = await call('confirmation.photoShare', samira, { orderId, items: [{ productId, variantId }] });
  assert.equal(r.url, null, 'no public address in the preview');
  assert.equal(r.items.length, 1);
  const row = (await db.query('SELECT id, key, order_id, created_by FROM photo_pages ORDER BY id DESC LIMIT 1'))[0];
  assert.equal(Number(row.order_id), orderId);
  assert.equal(Number(row.created_by), samira.session.profile.id);
  const page: any = await call('photos.page', admin, { id: Number(row.id), key: String(row.key) });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].label, r.items[0].label);
  await assert.rejects(call('photos.page', admin, { id: Number(row.id), key: '0'.repeat(24) }), /introuvable/);
  // the page is read by the server only (the system), never by an agent
  await assert.rejects(call('photos.page', samira, { id: Number(row.id), key: String(row.key) }));
});

test('on the server: the photos go by their public JPEG copies, the link is the page', async () => {
  const { productId, variantId, orderId } = await withPhoto();
  const asked: any[] = [];
  const server = {
    publicApi: 'https://shop.test/api',
    dellal: async (action: string, args: any) => {
      asked.push({ action, n: args.photos.length });
      return { urls: args.photos.map((_: unknown, k: number) => `https://shop.test/api/lp/dp/${900 + k}/${'ab'.repeat(12)}.jpg`) };
    },
  };
  const ctx = { ...samira, server: { ...(samira.server ?? {}), ...server } } as unknown as Ctx;
  const r = await sharePhotos(ctx, orderId, [{ productId, variantId }]);
  assert.equal(asked[0].action, 'photoLinks');
  assert.match(String(r.url), /^https:\/\/shop\.test\/api\/lp\/ph\/\d+\/[a-f0-9]{24}$/);
  const [, idp, key] = /\/lp\/ph\/(\d+)\/([a-f0-9]{24})$/.exec(String(r.url))!;
  const page: any = await call('photos.page', admin, { id: Number(idp), key });
  assert.match(page.items[0].photos[0], /^https:\/\/shop\.test\/api\/lp\/dp\/900\//);
  const html = photoPageHtml(page);
  assert.match(html, /<meta property="og:image" content="https:\/\/shop\.test\/api\/lp\/dp\/900\//);
  assert.match(html, /noindex/);
});

test('only the agent’s own orders and products; at most 10 products; a product without photo says so', async () => {
  const { productId, variantId, orderId } = await withPhoto();
  // another agent's order
  const other = (await db.query(`SELECT id FROM profiles WHERE email <> $1 AND roles @> '{confirmation}' AND active ORDER BY id LIMIT 1`, [EMAILS.conf]))[0];
  if (other) {
    await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [orderId, other.id]);
    await assert.rejects(call('confirmation.photoShare', samira, { orderId, items: [{ productId, variantId }] }));
    await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [orderId, samira.session.profile.id]);
  }
  await assert.rejects(call('confirmation.photoShare', samira, { orderId, items: Array.from({ length: 11 }, () => ({ productId, variantId })) }));
  // a colour of another product
  const wrong = (await db.query('SELECT id FROM product_variants WHERE product_id <> $1 ORDER BY id LIMIT 1', [productId]))[0];
  await assert.rejects(call('confirmation.photoShare', samira, { orderId, items: [{ productId, variantId: Number(wrong.id) }] }), /Variante introuvable/);
  // a product of hers without any photo: said, nothing made
  const mine: any[] = (await call('confirmation.catalog', samira, {})) as any[];
  let bare: number | null = null;
  for (const p of mine.filter((x) => x.id !== productId && !x.isService)) {
    const th: any = await call('confirmation.photoThumbs', samira, { items: [{ productId: p.id, variantId: null }] });
    if (th[0].count === 0) {
      bare = p.id;
      break;
    }
  }
  assert.ok(bare, 'a product without photo in the demo');
  const n0 = Number((await db.query('SELECT count(*)::int AS n FROM photo_pages'))[0].n);
  await assert.rejects(call('confirmation.photoShare', samira, { orderId, items: [{ productId: bare!, variantId: null }] }), /Pas de photo/);
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM photo_pages'))[0].n), n0);
  // with one that has photos: the page has that one, the other is said missing
  const r: any = await call('confirmation.photoShare', samira, { orderId, items: [{ productId, variantId }, { productId: bare!, variantId: null }] });
  assert.equal(r.items.length, 1);
  assert.equal(r.missing.length, 1);
});

/** a product of Samira's with test colours added: each `photos` her own photos (HD), `photo`: the colour's photo */
const withColours = async (colours: { title: string; photo?: boolean; hd?: number }[]) => {
  const { orderId } = await withPhoto();
  const mine: any[] = (await call('confirmation.catalog', samira, {})) as any[];
  const productId = Number(mine.find((p) => !p.isService).id);
  const made: number[] = [];
  for (const [k, c] of colours.entries()) {
    const v = (await db.query(`INSERT INTO product_variants (product_id, title, sku, photo) VALUES ($1, $2, $3, $4) RETURNING id`, [productId, c.title, `TST-ALL-${Date.now()}-${k}`, c.photo ? `data:image/png;base64,iVBORw0KGgo${'A'.repeat(40 + k * 4)}` : null]))[0];
    made.push(Number(v.id));
    for (let j = 0; j < (c.hd ?? 0); j++) {
      const data = `/9j/${'B'.repeat(60 + (k * 40 + j) * 4)}`;
      await db.query(`INSERT INTO product_photos (product_id, variant_id, kind, store, data, thumb, position) VALUES ($1, $2, 'photo', 'local', $3, $4, $5)`, [productId, v.id, data, `data:image/jpeg;base64,${data}`, j]);
    }
  }
  const done = async () => {
    await db.query('DELETE FROM product_photos WHERE variant_id = ANY($1)', [made]);
    await db.query('DELETE FROM product_variants WHERE id = ANY($1)', [made]);
  };
  return { productId, orderId, done };
};

test('« Toutes les couleurs »: each colour with its own photos, the colours named; a colour without photo left out', async () => {
  const { productId, orderId, done } = await withColours([{ title: 'Test Rouge', photo: true }, { title: 'Test Noir', photo: true }, { title: 'Test Vide' }]);
  try {
    const [th]: any = await call('confirmation.photoThumbs', samira, { items: [{ productId, variantId: null, all: true }] });
    assert.equal(th.all, true);
    assert.ok(th.colours.includes('Test Rouge') && th.colours.includes('Test Noir'));
    assert.ok(!th.colours.includes('Test Vide'), 'a colour without its own photo is not listed');
    assert.ok(th.count >= 2);
    assert.match(th.label, / — .*Test Rouge.*Test Noir/);
    // the same product once for « all », once for a colour: two lines
    const two: any = await call('confirmation.photoThumbs', samira, { items: [{ productId, variantId: null, all: true }, { productId, variantId: null, all: true }, { productId, variantId: null }] });
    assert.equal(two.length, 2);
    const r: any = await call('confirmation.photoShare', samira, { orderId, items: [{ productId, variantId: null, all: true }] });
    const labels = r.items.map((i: any) => i.label);
    assert.ok(labels.some((l: string) => l.endsWith(' — Test Rouge')) && labels.some((l: string) => l.endsWith(' — Test Noir')), 'one block per colour on the page');
    assert.ok(!labels.some((l: string) => l.endsWith(' — Test Vide')));
    assert.equal(r.photos.length, r.items.reduce((s: number, i: any) => s + i.photos, 0), 'the photos handed to the phone are the page’s');
    assert.equal(r.cut, 0);
  } finally {
    await done();
  }
});

test('one send: 30 photos at most (the rest counted), 10 of one colour at most, the same photo once', async () => {
  const { productId, orderId, done } = await withColours(['A', 'B', 'C', 'D'].map((x) => ({ title: `Test ${x}`, hd: 12 })));
  try {
    const [th]: any = await call('confirmation.photoThumbs', samira, { items: [{ productId, variantId: null, all: true }] });
    assert.ok(th.count >= 40, '10 photos of each of the 4 colours');
    const r: any = await call('confirmation.photoShare', samira, { orderId, items: [{ productId, variantId: null, all: true }] });
    assert.equal(r.photos.length, 30);
    assert.equal(r.cut, th.count - 30);
    assert.equal(r.missing.length, 0, 'photos left past the 30 are not « without photo »');
    // a colour already chosen on its own, then « all »: its photos go once
    const first = (await db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND title = 'Test A'`, [productId]))[0];
    const r2: any = await call('confirmation.photoShare', samira, { orderId, items: [{ productId, variantId: Number(first.id) }, { productId, variantId: null, all: true }] });
    assert.equal(r2.items.filter((i: any) => i.label.endsWith(' — Test A')).length, 1);
    assert.equal(r2.photos.length, 30);
  } finally {
    await done();
  }
});

test('pages older than 90 days are removed; the page never shows a customer or a price', async () => {
  const { productId, variantId, orderId } = await withPhoto();
  const old = (await db.query(`INSERT INTO photo_pages (key, items, created_at) VALUES ($1, '[]', now() - interval '100 days') RETURNING id`, ['cd'.repeat(12)]))[0];
  await call('confirmation.photoShare', samira, { orderId, items: [{ productId, variantId }] });
  assert.equal((await db.query('SELECT 1 FROM photo_pages WHERE id = $1', [old.id])).length, 0);
  const html = photoPageHtml({ shop: 'Ma <Boutique>', items: [{ label: 'Robe "rouge" <b>', photos: ['https://a.test/1.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://a.test/x" onerror="alert(1)'] }] });
  assert.match(html, /Ma &lt;Boutique&gt;/);
  assert.match(html, /Robe &quot;rouge&quot; &lt;b&gt;/);
  assert.equal((html.match(/<img /g) ?? []).length, 1, 'only our https photos');
  assert.doesNotMatch(html, /javascript:|onerror|data:image/);
  assert.doesNotMatch(html, /DA\b|PX\d/);
});

test('the small pictures of the cart and « Ajouter un produit »: the colour’s photo first, then the product’s; the agent’s products only', async () => {
  const { productId, variantId } = await withPhoto();
  const all: any = await call('confirmation.thumbs', samira, {});
  assert.equal(all.products[productId], PNG, 'the product’s own photo');
  // a colour with its own photo: that one for the colour, the product keeps its own
  if (variantId !== null) {
    const RED = PNG.replace('ggg==', 'ggh==');
    await db.query('UPDATE product_variants SET photo = $2 WHERE id = $1', [variantId, RED]);
    const r: any = await call('confirmation.thumbs', samira, { ids: [productId] });
    assert.equal(r.variants[variantId], RED);
    assert.equal(r.products[productId], PNG);
    assert.deepEqual(Object.keys(r.products).map(Number), [productId], 'these products only');
    await db.query('UPDATE product_variants SET photo = NULL WHERE id = $1', [variantId]);
  }
  // a picture too big for a list, or not an image, is left out
  await db.query('UPDATE products SET photo = $2 WHERE id = $1', [productId, 'javascript:alert(1)']);
  const bad: any = await call('confirmation.thumbs', samira, { ids: [productId] });
  assert.notEqual(bad.products[productId], 'javascript:alert(1)');
  await db.query('UPDATE products SET photo = $2 WHERE id = $1', [productId, PNG]);
});
