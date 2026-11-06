// Marketing › Catalogue: the shop's lists of products sent to its Meta catalog (product sets), and to its TikTok catalog
// when « Envoyer aussi à TikTok » is on; the lines each gets (one per colour / size), what stops a product (no page, a
// small or not yet JPEG picture), the demo, and the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from '../index';
import { setRaw, META_TOKEN_KEY } from '../modules/admin';
import { GUARD_DEFAULTS, hashOf, hiddenWhy, itemsOf, levelOf, noEmoji, plainText, problemOf, ttItemsOf } from '../modules/metacatalog';
import { AppError } from '../rpc';
import { ttCatalogError, ttLogOf, TT_NO_REGION } from '../social-server';
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
      { id: 20, title: 'Gris', price: null, left: 4 },
      { id: 21, title: 'Rose', price: null, left: 0 },
    ],
    tracked: true,
    level: null,
  };
  const w = { pages: 'https://go.test', store: 'bebe', api: 'https://pilotix.test/api', brand: 'Bébé Confort', demo: false, guard: GUARD_DEFAULTS };
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
  // the link says it is a catalog ad (its visits and orders are counted)
  assert.equal(gris.link, 'https://go.test/bebe/poussette?px_cat=meta');
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
  // the same lines in TikTok's names: numbers for the prices, no emoji in the title, the first picture apart
  const tt = ttItemsOf({ ...p, page: { ...p.page, title: '🔥 عربة أطفال 🔥' } }, w).map((x) => x.data as any);
  assert.equal(tt.length, 2);
  assert.equal(tt[0].sku_id, '7-20');
  assert.equal(tt[0].item_group_id, '7');
  assert.equal(tt[0].title, 'عربة أطفال – Gris');
  assert.equal(tt[0].availability, 'IN_STOCK');
  assert.equal(tt[1].availability, 'OUT_OF_STOCK');
  assert.deepEqual(tt[0].price_info, { price: 12900, currency: 'DZD', sale_price: 9950 });
  assert.deepEqual(tt[0].product_detail, { condition: 'NEW', color: 'Gris' });
  assert.equal(tt[0].image_url, 'https://pilotix.test/api/lp/img/3/meta.jpg');
  assert.deepEqual(tt[0].additional_image_urls, ['https://pilotix.test/api/lp/img/4/meta.jpg']);
  assert.equal(tt[1].image_url, 'https://pilotix.test/api/lp/img/4/meta.jpg');
  assert.deepEqual(tt[0].landing_page, { landing_page_url: 'https://go.test/bebe/poussette?px_cat=tiktok' });
  assert.equal(tt[0].brand, 'Bébé Confort');
  assert.equal(noEmoji('Promo 🇩🇿 ✅ تخفيض 👶🏽'), 'Promo تخفيض');
  // « stock bas »: 3 or fewer left (the shop's level), or the product's own; a product whose stock is not counted always goes
  assert.deepEqual(GUARD_DEFAULTS, { on: true, min: 3 });
  assert.equal(hiddenWhy(p, { left: 4 }, GUARD_DEFAULTS), null);
  assert.equal(hiddenWhy(p, { left: 3 }, GUARD_DEFAULTS), 'low');
  assert.equal(hiddenWhy(p, { left: 0 }, GUARD_DEFAULTS), 'out');
  assert.equal(hiddenWhy({ ...p, level: 10 }, { left: 8 }, GUARD_DEFAULTS), 'low');
  assert.equal(hiddenWhy({ ...p, level: 10 }, { left: 8 }, { on: false, min: 3 }), null);
  assert.equal(levelOf({ level: null }, { on: false, min: 3 }), 0);
  assert.equal(hiddenWhy({ ...p, tracked: false }, { left: 0 }, GUARD_DEFAULTS), null);
  const low = itemsOf({ ...p, variants: [{ id: 20, title: 'Gris', price: null, left: 2 }, { id: 21, title: 'Rose', price: null, left: 9 }] }, w).map((x) => x.data as any);
  assert.deepEqual(low.map((x) => x.availability), ['out of stock', 'in stock']);
  assert.equal(ttItemsOf({ ...p, tracked: false }, w)[1].data.availability, 'IN_STOCK');
  // TikTok's answers in plain words
  assert.match(ttCatalogError(40105, 'x').message, /Reliez TikTok/);
  assert.match(ttCatalogError(40001, 'x').message, /Catalog Management/);
  assert.equal(ttCatalogError(40100, 'x').code, 'conflict');
  assert.match(ttCatalogError(40002, 'bad price').message, /TikTok : bad price/);
  const log = ttLogOf({
    product_feed_log: {
      process_status: 'SUCCESS',
      feed_log_data: { error_affected_products: [{ issue: 'Image trop petite', suggestion: 'Ajoutez une image de 500 px', affected_product_item_list: [{ sku_id: '7-20' }] }] },
    },
  });
  assert.deepEqual(log, { done: true, failed: false, errors: [{ id: '7-20', message: 'Image trop petite — Ajoutez une image de 500 px' }] });
  assert.deepEqual(ttLogOf({ product_feed_log: { process_status: 'PROCESSING' } }), { done: false, failed: false, errors: [] });
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
  // the same lists on TikTok
  assert.equal(b.tiktok.on, true);
  assert.equal(b.tiktok.connected, true);
  assert.equal(b.tiktok.articles, b.articles);
  assert.equal(prod('Poussette canne pliable').tiktok, 'ok');
  assert.equal(by('Bébé 0-6 mois').metaState, 'ok');
  assert.equal(by('Bébé 0-6 mois').tiktokState, 'ok');
  assert.equal(by('Nouveautés').tiktokState, null);
  // off: nothing more goes to TikTok, the lists say only Meta; on again: the sent lists go at once
  assert.equal(((await call('metacatalog.tiktok', mk, { on: false })) as any).on, false);
  const off: any = await call('metacatalog.board', mk, {});
  assert.equal(off.lists.find((l: any) => l.name === 'Bébé 0-6 mois').tiktokState, null);
  assert.equal(off.products.find((p: any) => p.name === 'Poussette canne pliable').tiktok, null);
  const on: any = await call('metacatalog.tiktok', mk, { on: true });
  assert.equal(on.on, true);
  assert.equal(on.error, null);
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
  assert.match(d.link, /^https:\/\/go\.pilotix\.test\/.+\/ensemble-bebe-3-pieces\?px_cat=meta$/);
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

test('server: the same lists on TikTok — its catalog, products, sets, answers, refusals', async () => {
  const { db, as } = await setup(120);
  const calls: { action: string; args: any }[] = [];
  let setup1: () => any = () => ({ bcId: 'bc1', bcName: 'Ma boutique BC', catalogId: 'tt1', pixelBound: true });
  let log: any = { done: true, failed: false, errors: [] };
  let setFails = false;
  const server: any = {
    publicUrl: 'https://pilotix.test',
    publicApi: 'https://pilotix.test/api',
    pagesUrl: () => 'https://go.pilotix.test',
    courier: async () => null,
    hashPassword: async (x: string) => x,
    meta: async (action: string, args: any) => {
      calls.push({ action, args });
      throw new AppError('bad_request', 'Meta n’est pas connecté');
    },
    social: async (action: string, args: any) => {
      calls.push({ action, args });
      if (action === 'ttCatalogSetup') return setup1();
      if (action === 'ttCatalogUpload') return { logId: `log${calls.length}` };
      if (action === 'ttCatalogDelete') return { logId: `del${calls.length}` };
      if (action === 'ttCatalogLog') return log;
      if (action === 'ttCatalogSet') {
        if (setFails) throw new AppError('conflict', 'TikTok limite les demandes pour l’instant.');
        return { setId: args.setId ?? 'ttset1' };
      }
      return { ok: true };
    },
  };
  const mk = await as(EMAILS.marketer, server);
  const admin = await as(EMAILS.admin, server);
  // a clean shop: no catalog yet, Meta not linked, TikTok linked (Pilot AI › Comptes) with its pixel
  await db.query(`DELETE FROM meta_catalog_lists`);
  await db.query(`DELETE FROM meta_catalog_items`);
  await db.query(`DELETE FROM tiktok_catalog_items`);
  await db.query(`DELETE FROM settings WHERE key IN ('metacatalog', 'ttcatalog')`);
  const list: any = await call('metacatalog.listSave', mk, { name: 'Bébé 0-6 mois · sortie de maternité' });
  const pid = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-ENS'`))[0].id);
  const img = Number((await db.query(`INSERT INTO landing_images (w, h, t160, w480, w960, jpg) VALUES (900, 900, 'x', 'y', 'z', $1) RETURNING id`, [JPEG]))[0].id);
  await db.query(`UPDATE landing_pages SET images = $2 WHERE product_id = $1`, [pid, JSON.stringify([{ id: img }])]);
  await call('metacatalog.add', mk, { listId: list.id, productId: pid });
  // not linked yet: nothing can go
  let board: any = await call('metacatalog.board', mk, {});
  assert.equal(board.tiktok.linked, false);
  await assert.rejects(call('metacatalog.tiktok', mk, { on: true }), /TikTok Ads/);
  await assert.rejects(call('metacatalog.send', mk, { id: list.id }), /Reliez/);
  await setRaw(db, 'secret_tiktok_ads_token', 'ttok');
  await setRaw(db, 'social_tiktok_ads', { advertiserId: '7001', advertisers: [{ advertiserId: '7001', name: 'Pub' }] });
  await db.query(`INSERT INTO tracking_pixels (platform, name, pixel_id, is_default) VALUES ('tiktok', 'Boutique', 'CABC123DEF4567890', true)`);
  // TikTok has no catalog ads for Algeria: the switch stays off and the page says why
  setup1 = () => {
    throw new AppError('bad_request', TT_NO_REGION);
  };
  const no: any = await call('metacatalog.tiktok', mk, { on: true });
  assert.equal(no.on, false);
  assert.match(no.error, /Algérie/);
  board = await call('metacatalog.board', mk, {});
  assert.equal(board.tiktok.on, false);
  assert.match(board.tiktok.error, /Algérie/);
  // it is open: the catalog is made, with the shop's pixel; no list was sent yet
  setup1 = () => ({ bcId: 'bc1', bcName: 'Ma boutique BC', catalogId: 'tt1', pixelBound: true });
  calls.length = 0;
  const yes: any = await call('metacatalog.tiktok', mk, { on: true });
  assert.deepEqual([yes.on, yes.error], [true, null]);
  assert.deepEqual(calls.map((c) => c.action), ['ttCatalogSetup']);
  assert.equal(calls[0].args.pixelCode, 'CABC123DEF4567890');
  board = await call('metacatalog.board', mk, {});
  assert.deepEqual([board.tiktok.on, board.tiktok.connected, board.tiktok.bcName, board.tiktok.error], [true, true, 'Ma boutique BC', null]);
  // « Envoyer »: only TikTok (Meta is not linked): the 3 sizes, then the list as a product set of the product
  calls.length = 0;
  const r1: any = await call('metacatalog.send', mk, { id: list.id });
  assert.equal(r1.meta, false);
  assert.deepEqual(r1.tiktok, { sent: 3, error: null });
  assert.deepEqual(calls.map((c) => c.action), ['ttCatalogUpload', 'ttCatalogSet']);
  const up = calls[0].args;
  assert.deepEqual([up.bcId, up.catalogId, up.products.length], ['bc1', 'tt1', 3]);
  const d = up.products[0];
  assert.equal(d.item_group_id, String(pid));
  assert.deepEqual(d.price_info, { price: 2900, currency: 'DZD' });
  assert.equal(d.product_detail.size, '0-3 mois');
  assert.equal(d.image_url, `https://pilotix.test/api/lp/img/${img}/meta.jpg`);
  assert.match(d.landing_page.landing_page_url, /^https:\/\/go\.pilotix\.test\/.+\/ensemble-bebe-3-pieces\?px_cat=tiktok$/);
  assert.deepEqual(calls[1].args.groupIds, [String(pid)]);
  assert.equal(calls[1].args.setId, null);
  let l = (await db.query(`SELECT * FROM meta_catalog_lists WHERE id = $1`, [list.id]))[0];
  assert.equal(l.tt_set_id, 'ttset1');
  assert.ok(l.tt_sent_at);
  assert.equal(l.set_id, null);
  board = await call('metacatalog.board', mk, {});
  let bl = board.lists.find((x: any) => x.id === list.id);
  assert.deepEqual([bl.state, bl.metaState, bl.tiktokState], ['pending', null, 'pending']);
  // TikTok's answer, a minute later: one size refused
  const sku = `${pid}-${(await db.query(`SELECT min(id) AS v FROM product_variants WHERE product_id = $1 AND active`, [pid]))[0].v}`;
  log = { done: true, failed: false, errors: [{ id: sku, message: 'Image trop petite — Ajoutez une image de 500 px' }] };
  await db.query(`UPDATE tiktok_catalog_batches SET sent_at = sent_at - interval '5 minutes'`);
  await db.query(`UPDATE tiktok_catalog_items SET sent_at = sent_at - interval '5 minutes'`);
  calls.length = 0;
  await call('metacatalog.run', admin, {});
  assert.deepEqual(calls.map((c) => c.action), ['ttCatalogLog']);
  const st = await db.query(`SELECT sku_id, status, error FROM tiktok_catalog_items WHERE product_id = $1 ORDER BY sku_id`, [pid]);
  assert.equal(st.find((x: any) => x.sku_id === sku).status, 'error');
  assert.ok(st.filter((x: any) => x.sku_id !== sku).every((x: any) => x.status === 'ok'));
  board = await call('metacatalog.board', mk, {});
  bl = board.lists.find((x: any) => x.id === list.id);
  assert.deepEqual([bl.state, bl.tiktokState], ['fix', 'fix']);
  const bp = board.products.find((p: any) => p.id === pid);
  assert.equal(bp.tiktok, 'error');
  assert.match(bp.problemText, /^TikTok : Image trop petite/);
  // nothing changed: the refused size waits (no upload every few minutes); « Envoyer » tries it again
  calls.length = 0;
  await call('metacatalog.run', admin, {});
  assert.deepEqual(calls.filter((c) => c.action === 'ttCatalogUpload'), []);
  await call('metacatalog.send', mk, { id: list.id });
  assert.deepEqual(calls.filter((c) => c.action === 'ttCatalogUpload').map((c) => c.args.products.map((x: any) => x.sku_id)), [[sku]]);
  // an upload TikTok never answers: after a few hours it goes again
  log = { done: false, failed: false, errors: [] };
  await db.query(`UPDATE tiktok_catalog_batches SET sent_at = sent_at - interval '7 hours' WHERE done_at IS NULL`);
  await db.query(`UPDATE tiktok_catalog_items SET sent_at = sent_at - interval '7 hours' WHERE sku_id = $1`, [sku]);
  await call('metacatalog.run', admin, {});
  const late = (await db.query(`SELECT status, error, hash FROM tiktok_catalog_items WHERE sku_id = $1`, [sku]))[0];
  assert.equal(late.status, 'error');
  assert.match(late.error, /pas répondu/);
  assert.equal(late.hash, null);
  calls.length = 0;
  await call('metacatalog.run', admin, {});
  assert.deepEqual(calls.filter((c) => c.action === 'ttCatalogUpload').map((c) => c.args.products.length), [1]);
  // TikTok refuses the set for a while: Meta's sending goes on, the page says why, the next run sends the list again
  setFails = true;
  await db.query(`UPDATE landing_pages SET price = 2700 WHERE product_id = $1`, [pid]);
  const r2: any = await call('metacatalog.send', mk, { id: list.id });
  assert.match(r2.tiktok.error, /limite/);
  assert.equal((await db.query(`SELECT tt_sent_at FROM meta_catalog_lists WHERE id = $1`, [list.id]))[0].tt_sent_at, null);
  board = await call('metacatalog.board', mk, {});
  assert.match(board.tiktok.error, /limite/);
  setFails = false;
  calls.length = 0;
  await call('metacatalog.run', admin, {});
  assert.ok(calls.some((c) => c.action === 'ttCatalogSet' && c.args.setId === 'ttset1'));
  assert.ok((await db.query(`SELECT tt_sent_at FROM meta_catalog_lists WHERE id = $1`, [list.id]))[0].tt_sent_at);
  board = await call('metacatalog.board', mk, {});
  assert.equal(board.tiktok.error, null);
  // taken out of its only list: the next run takes its sizes out of TikTok's catalog
  await call('metacatalog.remove', mk, { listId: list.id, productId: pid });
  calls.length = 0;
  await call('metacatalog.run', admin, {});
  const del = calls.filter((c) => c.action === 'ttCatalogDelete');
  assert.equal(del.length, 1);
  assert.equal(del[0].args.skuIds.length, 3);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM tiktok_catalog_items WHERE product_id = $1 AND status <> 'deleted'`, [pid]))[0].n, 0);
  // Meta was never asked (not linked)
  assert.equal(calls.filter((c) => c.action.startsWith('catalog')).length, 0);
  // the list goes away: its TikTok set too
  calls.length = 0;
  await call('metacatalog.listRemove', mk, { id: list.id });
  assert.deepEqual(calls.filter((c) => c.action === 'ttCatalogSetDelete').map((c) => c.args.setId), ['ttset1']);
});

test('résultats: visits and orders from the catalog ads, « stock bas » (the shop\u2019s level, a product\u2019s own, off), stock not counted', async () => {
  const { db, as } = await setup(120);
  const mk = await as(EMAILS.marketer);
  const admin = await as(EMAILS.admin);
  const pid = async (sku: string) => Number((await db.query(`SELECT id FROM products WHERE sku = $1`, [sku]))[0].id);
  const pou = await pid('PX-POU');
  // the demo: a month of catalog ads, the baby set with its own level (30)
  let r: any = await call('metacatalog.results', mk, { days: 30 });
  assert.ok(r.totals.visits > 0 && r.totals.orders > 0);
  assert.equal(r.totals.meta.orders + r.totals.tiktok.orders, r.totals.orders);
  assert.ok(r.since);
  assert.deepEqual(r.guard, { on: true, min: 3 });
  const ensId = await pid('PX-ENS');
  assert.ok(r.hidden.some((h: any) => h.productId === ensId && h.why === 'low' && h.level === 30 && h.variant === '3-6 mois'));
  assert.ok(r.products.every((p: any, i: number, a: any[]) => i === 0 || a[i - 1].cash >= p.cash), 'by money');
  // a clean count: two visits from a Meta catalog ad and one from TikTok, today
  await db.query(`DELETE FROM catalog_visits`);
  await db.query(`UPDATE orders SET utm = utm - 'px_cat' WHERE utm ? 'px_cat'`);
  const slug = String((await db.query(`SELECT slug FROM landing_pages WHERE product_id = $1 AND active ORDER BY id LIMIT 1`, [pou]))[0].slug);
  for (const catalog of ['meta', 'meta', 'tiktok']) await call('landing.html', admin, { slug, mode: 'live', catalog });
  await call('landing.html', admin, { slug, mode: 'live' });
  await call('landing.html', admin, { slug, mode: 'preview', catalog: 'meta' });
  // three orders: one delivered (2 strollers at 9 950), one waiting, one duplicate (not counted)
  const ords = (
    await db.query(`SELECT DISTINCT o.id FROM orders o JOIN order_items i ON i.order_id = o.id AND NOT i.is_upsell WHERE i.product_id = $1 AND (SELECT count(*) FROM order_items x WHERE x.order_id = o.id) = 1 ORDER BY o.id LIMIT 3`, [pou])
  ).map((x: any) => Number(x.id));
  assert.equal(ords.length, 3);
  await db.query(`UPDATE orders SET created_at = now() - interval '1 day', utm = jsonb_build_object('px_cat', 'meta'), conf_status = 'confirmed', follow_status = 'delivered' WHERE id = $1`, [ords[0]]);
  await db.query(`UPDATE order_items SET qty = 2, unit_price = 9950 WHERE order_id = $1`, [ords[0]]);
  await db.query(`UPDATE orders SET created_at = now() - interval '2 days', utm = jsonb_build_object('px_cat', 'tiktok'), conf_status = 'new', follow_status = NULL WHERE id = $1`, [ords[1]]);
  await db.query(`UPDATE orders SET created_at = now() - interval '2 days', utm = jsonb_build_object('px_cat', 'meta'), conf_status = 'duplicate' WHERE id = $1`, [ords[2]]);
  r = await call('metacatalog.results', mk, { days: 7 });
  const p = r.products.find((x: any) => x.id === pou);
  assert.deepEqual([p.visits, p.meta.visits, p.tiktok.visits], [3, 2, 1]);
  assert.deepEqual([p.orders, p.delivered, p.cash, p.meta.orders, p.tiktok.orders], [2, 1, 19900, 1, 1]);
  assert.equal(r.products[0].id, pou);
  assert.deepEqual([r.totals.visits, r.totals.orders, r.totals.cash], [3, 2, 19900]);
  // a product's page: its orders day by day
  const one: any = await call('metacatalog.product', mk, { id: pou, days: 7 });
  assert.equal(one.daily.length, 7);
  assert.equal(one.daily.reduce((n: number, d: any) => n + d.meta + d.tiktok, 0), 2);
  assert.equal(one.numbers.orders, 2);
  assert.equal((await call('metacatalog.product', mk, { id: pou, days: 0 }) as any).daily.length, 30);
  // « stock bas »: the navy stroller has 2 left (nothing promised): out of the ads, the others stay
  const navy = Number((await db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND title = 'Bleu marine'`, [pou]))[0].id);
  await db.query(`UPDATE stock SET qty = 2 WHERE variant_id = $1`, [navy]);
  r = await call('metacatalog.results', mk, { days: 7 });
  assert.equal(r.products.find((x: any) => x.id === pou).state, 'some');
  assert.deepEqual(r.hidden.filter((h: any) => h.productId === pou).map((h: any) => [h.variant, h.left, h.why, h.level]), [['Bleu marine', 2, 'low', 3]]);
  assert.equal(((await call('metacatalog.board', mk, {})) as any).products.find((x: any) => x.id === pou).hidden, 1);
  // its own level (1): it stays in the ads; the shop's rule off: nothing hidden for little stock
  await call('metacatalog.productGuard', mk, { id: pou, level: 1 });
  r = await call('metacatalog.results', mk, { days: 7 });
  assert.equal(r.products.find((x: any) => x.id === pou).state, 'ads');
  await call('metacatalog.productGuard', mk, { id: pou, level: null });
  await call('metacatalog.guard', mk, { on: false, min: 3 });
  r = await call('metacatalog.results', mk, { days: 7 });
  assert.equal(r.products.find((x: any) => x.id === pou).state, 'ads');
  assert.ok(r.hidden.every((h: any) => h.why === 'out'));
  await call('metacatalog.guard', mk, { on: true, min: 3 });
  // a product whose stock is not counted (no stock line): always in the ads
  const sac = await pid('PX-SAC');
  await db.query(`DELETE FROM stock WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`, [sac]);
  r = await call('metacatalog.results', mk, { days: 7 });
  const sp = r.products.find((x: any) => x.id === sac);
  assert.deepEqual([sp.left, sp.state], [null, 'ads']);
  await assert.rejects(call('metacatalog.guard', mk, { on: true, min: -1 }));
  await assert.rejects(call('metacatalog.results', await as(EMAILS.conf), { days: 7 }));
});

test('server: a colour that runs low leaves the ads even in a list not « mise à jour toute seule », and comes back', async () => {
  const { db, as } = await setup(120);
  const calls: { action: string; args: any }[] = [];
  const server: any = {
    publicUrl: 'https://pilotix.test',
    publicApi: 'https://pilotix.test/api',
    pagesUrl: () => 'https://go.pilotix.test',
    courier: async () => null,
    hashPassword: async (x: string) => x,
    meta: async (action: string, args: any) => {
      calls.push({ action, args });
      if (action === 'catalogSetup') return { catalogId: 'cat1', businessId: 'b1', businessName: 'Ma boutique', pixelsLinked: true };
      if (action === 'catalogBatch') return { handle: `h${calls.length}`, errors: [] };
      if (action === 'catalogSet') return { setId: args.setId ?? 'set1' };
      if (action === 'catalogStatus') return { done: true, errors: [] };
      return { ok: true };
    },
  };
  const mk = await as(EMAILS.marketer, server);
  const admin = await as(EMAILS.admin, server);
  await db.query(`DELETE FROM meta_catalog_lists`);
  await db.query(`DELETE FROM meta_catalog_items`);
  await db.query(`DELETE FROM settings WHERE key IN ('metacatalog', 'ttcatalog')`);
  await setRaw(db, META_TOKEN_KEY, 'tok');
  await setRaw(db, 'meta', { adAccountId: '123', hasToken: true });
  const pid = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-ENS'`))[0].id);
  await db.query(`DELETE FROM catalog_guard`);
  const img = Number((await db.query(`INSERT INTO landing_images (w, h, t160, w480, w960, jpg) VALUES (900, 900, 'x', 'y', 'z', $1) RETURNING id`, [JPEG]))[0].id);
  await db.query(`UPDATE landing_pages SET images = $2 WHERE product_id = $1`, [pid, JSON.stringify([{ id: img }])]);
  const list: any = await call('metacatalog.listSave', mk, { name: 'Bébé' });
  await call('metacatalog.add', mk, { listId: list.id, productId: pid });
  await call('metacatalog.listAuto', mk, { id: list.id, on: false });
  await call('metacatalog.send', mk, { id: list.id });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM meta_catalog_items WHERE product_id = $1 AND in_stock`, [pid]))[0].n, 3);
  // nothing moved: nothing goes
  calls.length = 0;
  await call('metacatalog.run', admin, {});
  assert.deepEqual(calls.filter((c) => c.action === 'catalogBatch'), []);
  // 0-3 mois: 2 left
  const v = Number((await db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND title = '0-3 mois'`, [pid]))[0].id);
  const before = Number((await db.query(`SELECT qty FROM stock WHERE variant_id = $1`, [v]))[0].qty);
  await db.query(`UPDATE stock SET qty = 2 WHERE variant_id = $1`, [v]);
  calls.length = 0;
  await call('metacatalog.run', admin, {});
  const sentNow = calls.filter((c) => c.action === 'catalogBatch').flatMap((c) => c.args.requests);
  assert.equal(sentNow.find((x: any) => x.data.id === `${pid}-${v}`).data.availability, 'out of stock');
  assert.equal((await db.query(`SELECT in_stock FROM meta_catalog_items WHERE retailer_id = $1`, [`${pid}-${v}`]))[0].in_stock, false);
  // the stock comes back: so does it
  await db.query(`UPDATE stock SET qty = $2 WHERE variant_id = $1`, [v, before]);
  calls.length = 0;
  await call('metacatalog.run', admin, {});
  const back = calls.filter((c) => c.action === 'catalogBatch').flatMap((c) => c.args.requests);
  assert.equal(back.find((x: any) => x.data.id === `${pid}-${v}`).data.availability, 'in stock');
});
