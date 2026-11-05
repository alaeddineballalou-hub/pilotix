// Marketing › Catalogue: the shop's lists of products sent to its Meta catalog (product sets), the lines Meta gets
// (one per colour / size), what stops a product (no page, a small or not yet JPEG picture), the demo, and the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from '../index';
import { setRaw, META_TOKEN_KEY } from '../modules/admin';
import { hashOf, itemsOf, plainText, problemOf } from '../modules/metacatalog';
import { EMAILS, setup } from './harness';

const JPEG = '/9j/' + 'A'.repeat(200);

test('plain text, the lines of a product and the fingerprint', () => {
  assert.equal(plainText('# Titre\n- **léger** : 6 kg\n\n\n✅ Livraison'), 'Titre\n• léger : 6 kg\n\n✅ Livraison');
  const p: any = {
    id: 7,
    name: 'Poussette',
    brand: null,
    price: 12900,
    page: {
      slug: 'poussette',
      title: 'عربة أطفال',
      price: 9950,
      oldPrice: 12900,
      description: '# Légère\n- 6 kg',
      variantLabel: 'اللون',
      pics: [
        { id: 3, url: null, w: 900, h: 900, jpg: true, v: null },
        { id: 4, url: null, w: 900, h: 900, jpg: true, v: 21 },
        { id: 5, url: null, w: 300, h: 300, jpg: true, v: null },
      ],
    },
    variants: [
      { id: 20, title: 'Gris', price: null, stock: 4 },
      { id: 21, title: 'Rose', price: null, stock: 0 },
    ],
  };
  const w = { pages: 'https://go.test', store: 'bebe', api: 'https://pilotix.test/api', brand: 'Bébé Confort', demo: false };
  const items = itemsOf(p, w);
  assert.equal(items.length, 2);
  const [gris, rose] = items.map((x) => x.data as any);
  assert.equal(gris.id, '7-20');
  assert.equal(gris.item_group_id, '7');
  assert.equal(gris.title, 'عربة أطفال – Gris');
  assert.equal(gris.price, '12900 DZD');
  assert.equal(gris.sale_price, '9950 DZD');
  assert.equal(gris.availability, 'in stock');
  assert.equal(rose.availability, 'out of stock');
  assert.equal(gris.color, 'Gris');
  assert.equal(gris.size, undefined);
  assert.equal(gris.link, 'https://go.test/bebe/poussette');
  assert.equal(gris.brand, 'Bébé Confort');
  assert.equal(gris.description, 'Légère\n• 6 kg');
  // the small picture never goes; the pink one comes first for « Rose »
  assert.deepEqual(gris.image.map((x: any) => x.url), ['https://pilotix.test/api/lp/img/3/meta.jpg', 'https://pilotix.test/api/lp/img/4/meta.jpg']);
  assert.equal(rose.image[0].url, 'https://pilotix.test/api/lp/img/4/meta.jpg');
  // what stops a product
  assert.equal(problemOf({ ...p, page: null }), 'nopage');
  assert.equal(problemOf({ ...p, page: { ...p.page, pics: [{ id: 5, url: null, w: 300, h: 300, jpg: true, v: null }] } }), 'photo');
  assert.equal(problemOf({ ...p, page: { ...p.page, pics: [{ id: 3, url: null, w: 900, h: 900, jpg: false, v: null }] } }), 'jpeg');
  assert.equal(problemOf({ ...p, page: { ...p.page, pics: [{ id: null, url: 'data:image/svg+xml,x', w: 900, h: 900, jpg: false, v: null }] } }), 'photo');
  assert.equal(problemOf({ ...p, page: { ...p.page, pics: [{ id: null, url: 'data:image/svg+xml,x', w: 900, h: 900, jpg: false, v: null }] } }, true), null);
  assert.equal(problemOf(p), null);
  assert.equal(hashOf({ a: 1 }), hashOf({ a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
});

test('demo: the lists, their states and what stops a product', async () => {
  const { as } = await setup(120);
  const mk = await as(EMAILS.marketer);
  const b: any = await call('metacatalog.board', mk, {});
  assert.equal(b.catalog.connected, true);
  assert.deepEqual(b.lists.map((l: any) => l.name), ['Sortie et balade', 'Bébé 0-6 mois', 'Promo de la semaine', 'Nouveautés']);
  const by = (n: string) => b.lists.find((l: any) => l.name === n);
  assert.equal(by('Sortie et balade').state, 'fix');
  assert.equal(by('Sortie et balade').fix, 2);
  assert.equal(by('Bébé 0-6 mois').state, 'ok');
  assert.equal(by('Nouveautés').state, 'new');
  const prod = (n: string) => b.products.find((p: any) => p.name === n);
  assert.equal(prod('Lit parapluie').problem, 'photo');
  assert.equal(prod('Écharpe de portage').problem, 'nopage');
  assert.equal(prod('Poussette canne pliable').problem, null);
  assert.equal(prod('Poussette canne pliable').meta, 'ok');
  assert.ok(b.articles >= 10);
});

test('lists: make, drop, move, take out, send and remove (preview)', async () => {
  const { db, as } = await setup(120);
  const mk = await as(EMAILS.marketer);
  const pid = async (sku: string) => Number((await db.query(`SELECT id FROM products WHERE sku = $1`, [sku]))[0].id);
  const pou = await pid('PX-POU');
  const sac = await pid('PX-SAC');
  const ech = await pid('PX-ECH');
  const a: any = await call('metacatalog.listSave', mk, { name: 'Hiver' });
  const b: any = await call('metacatalog.listSave', mk, { name: 'Soldes' });
  await call('metacatalog.add', mk, { listId: a.id, productId: pou });
  await call('metacatalog.add', mk, { listId: a.id, productId: sac });
  await call('metacatalog.add', mk, { listId: a.id, productId: ech });
  assert.equal(((await call('metacatalog.add', mk, { listId: a.id, productId: pou })) as any).added, false, 'once per list');
  // moved from « Hiver » to « Soldes »
  await call('metacatalog.add', mk, { listId: b.id, productId: sac, fromListId: a.id });
  const board: any = await call('metacatalog.board', mk, {});
  const hiver = board.lists.find((l: any) => l.id === a.id);
  assert.deepEqual(hiver.productIds.sort(), [pou, ech].sort());
  assert.deepEqual(board.lists.find((l: any) => l.id === b.id).productIds, [sac]);
  const r: any = await call('metacatalog.send', mk, { id: a.id });
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].why, 'nopage');
  const l = (await db.query(`SELECT * FROM meta_catalog_lists WHERE id = $1`, [a.id]))[0];
  assert.ok(l.sent_at);
  assert.equal(l.set_id, `demo-set-${a.id}`);
  assert.equal(l.changed_at, null);
  // a product taken out of a list « mise à jour toute seule »: sent again at once in the preview
  await call('metacatalog.remove', mk, { listId: a.id, productId: ech });
  assert.equal((await db.query(`SELECT changed_at FROM meta_catalog_lists WHERE id = $1`, [a.id]))[0].changed_at, null);
  // not « toute seule »: it waits for « Envoyer à Meta »
  await call('metacatalog.listAuto', mk, { id: a.id, on: false });
  await call('metacatalog.add', mk, { listId: a.id, productId: ech });
  assert.ok((await db.query(`SELECT changed_at FROM meta_catalog_lists WHERE id = $1`, [a.id]))[0].changed_at);
  assert.equal(((await call('metacatalog.board', mk, {})) as any).lists.find((l: any) => l.id === a.id).state, 'fix');
  await assert.rejects(call('metacatalog.send', mk, { id: (await call('metacatalog.listSave', mk, { name: 'Vide' }) as any).id }), /vide/);
  await assert.rejects(call('metacatalog.listSave', mk, { name: 'x' }), /nom/);
  // the list goes away: its products leave the catalog when no other sent list has them
  await call('metacatalog.listRemove', mk, { id: a.id });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM meta_catalog_lists WHERE id = $1`, [a.id]))[0].n, 0);
  // the poussette is still in « Sortie et balade » and « Promo de la semaine »
  assert.ok((await db.query(`SELECT 1 FROM meta_catalog_items WHERE product_id = $1 AND status = 'ok'`, [pou])).length);
  // only marketers (and the admin)
  await assert.rejects(call('metacatalog.board', await as(EMAILS.conf), {}));
});

test('server: the catalog is made once, only what changed goes, product sets, Meta’s answers, pictures', async () => {
  const { db, as } = await setup(120);
  const calls: { action: string; args: any }[] = [];
  let validation: { id: string; message: string }[] = [];
  const server: any = {
    publicUrl: 'https://pilotix.test',
    publicApi: 'https://pilotix.test/api',
    pagesUrl: () => 'https://go.pilotix.test',
    courier: async () => null,
    hashPassword: async (x: string) => x,
    meta: async (action: string, args: any) => {
      calls.push({ action, args });
      if (action === 'catalogSetup') return { catalogId: 'cat1', businessId: 'b1', businessName: 'Ma boutique', pixelsLinked: true };
      if (action === 'catalogBatch') return { handle: `h${calls.length}`, errors: validation };
      if (action === 'catalogSet') return { setId: args.setId ?? 'set1' };
      if (action === 'catalogStatus') return { done: true, errors: [{ id: args.handle === 'nope' ? 'x' : 'zzz', message: 'non' }] };
      return { ok: true };
    },
  };
  const mk = await as(EMAILS.marketer, server);
  // a clean catalog (the demo's lists are the preview's)
  await db.query(`DELETE FROM meta_catalog_lists`);
  await db.query(`DELETE FROM meta_catalog_items`);
  const list: any = await call('metacatalog.listSave', mk, { name: 'Bébé' });
  const pid = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-ENS'`))[0].id);
  await call('metacatalog.add', mk, { listId: list.id, productId: pid });
  await assert.rejects(call('metacatalog.send', mk, { id: list.id }), /Reliez/);
  const admin = await as(EMAILS.admin, server);
  await setRaw(db, META_TOKEN_KEY, 'tok');
  await setRaw(db, 'meta', { adAccountId: '123', hasToken: true });
  await db.query(`DELETE FROM settings WHERE key = 'metacatalog'`);
  // the page's picture is stored by Pilotix: without its JPEG copy it cannot go yet
  const img = Number((await db.query(`INSERT INTO landing_images (w, h, t160, w480, w960) VALUES (900, 900, 'x', 'y', 'z') RETURNING id`))[0].id);
  await db.query(`UPDATE landing_pages SET images = $2 WHERE product_id = $1`, [pid, JSON.stringify([{ id: img }])]);
  let board: any = await call('metacatalog.board', mk, {});
  assert.deepEqual(board.needJpeg, [{ id: img, url: `https://pilotix.test/api/lp/img/${img}/960.webp` }]);
  assert.equal(board.products.find((p: any) => p.id === pid).preparing, true);
  await assert.rejects(call('metacatalog.photo', mk, { imageId: img, jpeg: 'iVBOR' + 'A'.repeat(200) }), /JPEG/);
  await call('metacatalog.photo', mk, { imageId: img, jpeg: JPEG });
  assert.equal(((await call('metacatalog.image', admin, { id: img })) as any).base64, JPEG);
  board = await call('metacatalog.board', mk, {});
  assert.deepEqual(board.needJpeg, []);
  // first send: the catalog is made, the 3 sizes go, the list becomes a product set
  validation = [];
  const r1: any = await call('metacatalog.send', mk, { id: list.id });
  assert.equal(r1.sent, 3);
  assert.deepEqual(calls.map((c) => c.action), ['catalogSetup', 'catalogBatch', 'catalogSet']);
  const batch = calls[1].args;
  assert.equal(batch.catalogId, 'cat1');
  const d = batch.requests[0].data;
  assert.equal(batch.requests[0].method, 'UPDATE');
  assert.equal(d.item_group_id, String(pid));
  assert.equal(d.price, '2900 DZD');
  assert.equal(d.size, '0-3 mois');
  assert.match(d.link, /^https:\/\/go\.pilotix\.test\/.+\/ensemble-bebe-3-pieces$/);
  assert.equal(d.image[0].url, `https://pilotix.test/api/lp/img/${img}/meta.jpg`);
  assert.deepEqual(calls[2].args.ids.length, 3);
  assert.equal((await db.query(`SELECT set_id FROM meta_catalog_lists WHERE id = $1`, [list.id]))[0].set_id, 'set1');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM meta_catalog_items WHERE product_id = $1 AND status = 'pending'`, [pid]))[0].n, 3);
  // sent again with nothing changed: no batch, the catalog is not made twice
  calls.length = 0;
  await call('metacatalog.send', mk, { id: list.id });
  assert.deepEqual(calls.map((c) => c.action), ['catalogSet']);
  // the page's price changes: only the 3 lines of that product go again (every few minutes, « mise à jour toute seule »)
  await db.query(`UPDATE landing_pages SET price = 2700 WHERE product_id = $1`, [pid]);
  calls.length = 0;
  validation = [{ id: `${pid}-x`, message: 'nope' }];
  const run: any = await call('metacatalog.run', admin, {});
  assert.equal(run.sent, 3);
  assert.equal(calls.filter((c) => c.action === 'catalogBatch')[0].args.requests[0].data.price, '2700 DZD');
  // Meta's answer, a little later: one line refused
  const firstVariant = (await db.query(`SELECT retailer_id FROM meta_catalog_items WHERE product_id = $1 ORDER BY retailer_id LIMIT 1`, [pid]))[0].retailer_id;
  server.meta = async (action: string, args: any) => {
    calls.push({ action, args });
    if (action === 'catalogStatus') return { done: true, errors: [{ id: firstVariant, message: 'Image trop petite' }] };
    if (action === 'catalogBatch') return { handle: 'hz', errors: [] };
    if (action === 'catalogSet') return { setId: args.setId ?? 'set1' };
    return {};
  };
  await db.query(`UPDATE meta_catalog_batches SET sent_at = now() - interval '5 minutes'`);
  await call('metacatalog.run', admin, {});
  const st = await db.query(`SELECT retailer_id, status, error FROM meta_catalog_items WHERE product_id = $1 ORDER BY retailer_id`, [pid]);
  assert.equal(st.find((x: any) => x.retailer_id === firstVariant).status, 'error');
  assert.equal(st.find((x: any) => x.retailer_id === firstVariant).error, 'Image trop petite');
  assert.ok(st.filter((x: any) => x.retailer_id !== firstVariant).every((x: any) => x.status === 'ok'));
  board = await call('metacatalog.board', mk, {});
  assert.equal(board.lists.find((l: any) => l.id === list.id).state, 'fix');
  assert.match(board.products.find((p: any) => p.id === pid).problemText, /Image trop petite/);
  // taken out of its only list: the next run takes it out of the catalog
  await call('metacatalog.remove', mk, { listId: list.id, productId: pid });
  calls.length = 0;
  await call('metacatalog.run', admin, {});
  const del = calls.filter((c) => c.action === 'catalogBatch').flatMap((c) => c.args.requests);
  assert.equal(del.length, 3);
  assert.ok(del.every((x: any) => x.method === 'DELETE'));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM meta_catalog_items WHERE product_id = $1 AND status <> 'deleted'`, [pid]))[0].n, 0);
});
