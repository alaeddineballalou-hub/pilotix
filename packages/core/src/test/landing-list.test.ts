// Landing pages › Pages and Groupes lists: duplicate (an offline copy with a new free address), delete; a group's
// product badges (one product per badge, so the customer is not misled); the pages never wider than the phone and
// every product photo at 4:5.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { renderGroup } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let marketer: Ctx;
let admin: Ctx;
let pages: { id: number; slug: string }[];
let as: (email: string) => Promise<Ctx>;

before(async () => {
  const s = await setup(50);
  db = s.db;
  as = s.as;
  marketer = await s.as(EMAILS.marketer);
  admin = await s.as(EMAILS.admin);
  pages = (await db.query('SELECT id, slug FROM landing_pages WHERE active ORDER BY id LIMIT 2')).map((r: any) => ({ id: Number(r.id), slug: String(r.slug) }));
  assert.equal(pages.length, 2);
});

const html = async (slug: string) => ((await call('landing.html', admin, { slug, mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/' })) as any).html as string;

test('pages: a duplicate is an offline copy (same product, text, photos) at a new free address; delete removes it', async () => {
  const src = (await db.query('SELECT * FROM landing_pages WHERE id = $1', [pages[0].id]))[0];
  const a: any = await call('landing.duplicate', marketer, { id: pages[0].id });
  assert.notEqual(a.id, pages[0].id);
  assert.equal(a.active, false);
  assert.equal(a.slug, `${pages[0].slug}-2`);
  assert.match(a.title, /\(copie\)$/);
  const row = (await db.query('SELECT * FROM landing_pages WHERE id = $1', [a.id]))[0];
  for (const k of ['product_id', 'color', 'price', 'old_price', 'description', 'variant_label', 'fraud_level', 'stock_mode']) assert.deepEqual(row[k], src[k], k);
  assert.deepEqual(row.images, src.images);
  // a second copy: the next free address
  const b: any = await call('landing.duplicate', marketer, { id: pages[0].id });
  assert.equal(b.slug, `${pages[0].slug}-3`);
  // offline: customers cannot open it yet
  await assert.rejects(() => html(a.slug));
  // the original is untouched
  assert.equal((await db.query('SELECT active, slug FROM landing_pages WHERE id = $1', [pages[0].id]))[0].active, true);
  await call('landing.remove', marketer, { id: a.id });
  await call('landing.remove', marketer, { id: b.id });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM landing_pages WHERE id = ANY($1)', [[a.id, b.id]]))[0].n, 0);
  await assert.rejects(() => call('landing.duplicate', marketer, { id: 999999 }));
  // agents (confirmation) cannot
  const agent = await as(EMAILS.conf);
  await assert.rejects(() => call('landing.duplicate', agent, { id: pages[0].id }));
});

test('groups: badges above the photo, one product per badge, kept on save, copied by duplicate', async () => {
  // the same badge on two products: refused (even written differently)
  await assert.rejects(
    () =>
      call('landing.groupSave', marketer, {
        slug: 'badges-x',
        title: 'X',
        items: [
          { pageId: pages[0].id, badge: { text: 'أفضل سعر', color: '#dc2626' } },
          { pageId: pages[1].id, badge: { text: ' أفضل  سعر ', color: '#2563eb' } },
        ],
      }),
    /un seul produit/,
  );
  const g: any = await call('landing.groupSave', marketer, {
    slug: 'badges',
    title: 'Badges',
    items: [
      { pageId: pages[0].id, badge: { text: 'أفضل سعر', color: '#DC2626' } },
      // empty text: no badge
      { pageId: pages[1].id, badge: { text: '  ', color: '#2563eb' } },
    ],
  });
  assert.deepEqual(g.items[0].badge, { text: 'أفضل سعر', color: '#dc2626' });
  assert.equal(g.items[1].badge, null);
  const h = await html('badges');
  assert.match(h, /<span class="bd" style="--bd:#dc2626">أفضل سعر<\/span>/);
  assert.equal((h.match(/class="bd"/g) ?? []).length, 1);
  // its « اطلب الآن » button takes the badge's colour (the others keep the group's)
  assert.match(h, /<a class="it hb" style="--bd:#dc2626"/);
  assert.match(h, /\.it\.hb:not\(\.out\) \.go\{background:var\(--bd\)\}/);
  // the product without a badge keeps the same height (photos stay level)
  assert.match(h, /<main class="w hb-on">/);
  // a bad colour: refused
  await assert.rejects(() => call('landing.groupSave', marketer, { slug: 'badges-y', title: 'Y', items: [{ pageId: pages[0].id, badge: { text: 'جديد', color: 'red' } }] }));

  // duplicate: offline copy, same products and badges, new address; delete
  const c: any = await call('landing.groupDuplicate', marketer, { id: g.id });
  assert.equal(c.active, false);
  assert.equal(c.slug, 'badges-2');
  assert.match(c.title, /\(copie\)$/);
  assert.deepEqual(
    c.items.map((x: any) => [x.pageId, x.badge]),
    g.items.map((x: any) => [x.pageId, x.badge]),
  );
  await call('landing.groupRemove', marketer, { id: c.id });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM landing_groups WHERE id = $1', [c.id]))[0].n, 0);
  // a group saved before badges existed (no badge in its items) still opens
  await db.query(`UPDATE landing_groups SET items = $2 WHERE id = $1`, [g.id, JSON.stringify([{ pageId: pages[0].id, tab: '', note: '' }])]);
  assert.doesNotMatch(await html('badges'), /class="bd"/);
});

test('pages and groups: never wider than the phone, product photos at 4:5', async () => {
  const p = await html(pages[0].slug);
  assert.match(p, /\.g\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(p, /\.g>\*\{min-width:0\}/);
  assert.match(p, /--r:4\/5/);
  const g = renderGroup({ slug: 'g', title: 'G', theme: 'grid', items: [], color: '#0f766e' } as any, { mode: 'preview' } as any);
  assert.match(g, /\.im\{display:block;width:100%;height:auto;aspect-ratio:4\/5/);
  assert.match(g, /repeat\(2,minmax\(0,1fr\)\)/);
});

test('pages and groups: the tab icon is the shop logo, else the Pilotix icon', async () => {
  const at = async (slug: string, imgBase: string | null) =>
    ((await call('landing.html', admin, { slug, mode: imgBase ? 'live' : 'preview', post: '/o', geo: '/g/', lead: '/l', imgBase })) as any).html as string;
  await db.query(`UPDATE settings SET value = $1 WHERE key = 'logo'`, [JSON.stringify({ url: null, updatedAt: null })]);
  // no logo: the Pilotix icon (its address next to the pictures; inside the page in the preview)
  assert.match(await at(pages[0].slug, '/api/lp/img/'), /<link rel="icon" href="\/api\/lp\/icon\/pilotix">/);
  assert.match(await at(pages[0].slug, null), /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.equal(await call('landing.icon', admin, {}), null);
  // a logo: its own address, a new one when the logo changes
  const logo = 'data:image/png;base64,iVBORw0KGgo=';
  await db.query(`INSERT INTO settings (key, value) VALUES ('logo', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ url: logo, updatedAt: '2026-11-13T20:00:00.000Z' })]);
  const v = `l${Date.parse('2026-11-13T20:00:00.000Z').toString(36)}`;
  assert.match(await at(pages[0].slug, '/api/lp/img/'), new RegExp(`<link rel="icon" href="/api/lp/icon/${v}">`));
  assert.match(await at('badges', '/s/shop/api/lp/img/'), new RegExp(`<link rel="icon" href="/s/shop/api/lp/icon/${v}">`));
  assert.match(await at(pages[0].slug, null), /<link rel="icon" href="data:image\/png;base64,iVBORw0KGgo=">/);
  assert.deepEqual(await call('landing.icon', admin, {}), { type: 'image/png', base64: 'iVBORw0KGgo=' });
});

test('pages follow their product: its photo, a new variant photo, an off variant leaves (choice and photos)', async () => {
  const pg = (await db.query('SELECT id, slug, product_id FROM landing_pages WHERE id = $1', [pages[1].id]))[0];
  const pid = Number(pg.product_id);
  const png = (n: number) => `data:image/png;base64,${Buffer.from(`photo-${n}`).toString('base64')}`;
  // the product: a main photo, two colours with their own photo (a third colour without)
  await db.query('UPDATE products SET photo = $2 WHERE id = $1', [pid, png(1)]);
  await db.query(`DELETE FROM landing_blocked WHERE landing_id = $1`, [pg.id]).catch(() => null);
  const vs = (await db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND title <> '' ORDER BY id`, [pid])).map((r: any) => Number(r.id));
  let [a, b] = vs;
  if (!b) {
    a = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku, active) VALUES ($1, 'أحمر', $2, true) RETURNING id`, [pid, `T-${pid}-A`]))[0].id);
    b = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku, active) VALUES ($1, 'أزرق', $2, true) RETURNING id`, [pid, `T-${pid}-B`]))[0].id);
  }
  await db.query('UPDATE product_variants SET active = true, photo = NULL WHERE product_id = $1', [pid]);
  await db.query('UPDATE product_variants SET photo = $2 WHERE id = $1', [a, png(2)]);
  await db.query('UPDATE product_variants SET photo = $2 WHERE id = $1', [b, png(3)]);
  // the page: its own poster (a link) for colour b, and an old copy of an old product photo
  await db.query('UPDATE landing_pages SET active = true, images = $2 WHERE id = $1', [pg.id, JSON.stringify([{ url: 'https://cdn.example/poster.jpg', w: 1080, h: 1350 }, { url: 'https://cdn.example/b.jpg', w: 1080, h: 1350, v: b }, { url: png(99), w: 960, h: 1200 }])]);
  const live = async () => ((await call('landing.html', admin, { slug: String(pg.slug), mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/api/lp/img/' })) as any).html as string;

  let h = await live();
  const poster = h.indexOf('https://cdn.example/poster.jpg');
  const main = h.indexOf(`/api/lp/pp/${pid}/m-`);
  assert.ok(poster > 0 && main > poster, 'own poster first, then the product photo');
  assert.match(h, new RegExp(`/api/lp/pp/${pid}/v${a}-[a-z0-9]+\\.png`));
  // colour b has its own poster on the page: not its product photo as well
  assert.doesNotMatch(h, new RegExp(`/api/lp/pp/${pid}/v${b}-`));
  assert.match(h, /cdn\.example\/b\.jpg/);
  // the old copy is gone, and no product photo is inside the page
  for (const n of [1, 2, 3, 99]) assert.ok(!h.includes(Buffer.from(`photo-${n}`).toString('base64')), `photo ${n} inside the page`);

  // a new main photo: a new address (browsers fetch the new one)
  const before = h.match(new RegExp(`/api/lp/pp/${pid}/m-[a-z0-9]+\\.png`))![0];
  await db.query('UPDATE products SET photo = $2 WHERE id = $1', [pid, png(4)]);
  h = await live();
  const after = h.match(new RegExp(`/api/lp/pp/${pid}/m-[a-z0-9]+\\.png`))![0];
  assert.notEqual(after, before);
  assert.deepEqual(await call('landing.productPhoto', admin, { productId: pid, key: 'm' }), { type: 'image/png', base64: Buffer.from('photo-4').toString('base64') });
  assert.deepEqual(await call('landing.productPhoto', admin, { productId: pid, key: `v${a}` }), { type: 'image/png', base64: Buffer.from('photo-2').toString('base64') });
  assert.equal(await call('landing.productPhoto', admin, { productId: pid, key: 'v999999' }), null);

  // colour b off: its choice and its poster leave the page; colour a off: its product photo too
  await db.query('UPDATE product_variants SET active = false WHERE id = $1', [b]);
  h = await live();
  assert.doesNotMatch(h, /cdn\.example\/b\.jpg/);
  assert.doesNotMatch(h, /أزرق/);
  await db.query('UPDATE product_variants SET active = false WHERE id = $1', [a]);
  h = await live();
  assert.doesNotMatch(h, new RegExp(`/api/lp/pp/${pid}/v${a}-`));
  // back on: back on the page
  await db.query('UPDATE product_variants SET active = true WHERE id = ANY($1)', [[a, b]]);
  h = await live();
  assert.match(h, /cdn\.example\/b\.jpg/);
  assert.match(h, new RegExp(`/api/lp/pp/${pid}/v${a}-`));
  // the preview (no server address): the photos themselves
  const pv = ((await call('landing.html', admin, { slug: String(pg.slug), mode: 'preview', post: '/o', geo: '/g/', lead: '/l', imgBase: null })) as any).html as string;
  assert.ok(pv.includes(png(4)));
  // HD photos (Produits › Photos HD): the product's own and colour a's are used before the small photos, by the server's light copies
  const thumb = (n: number) => `data:image/jpeg;base64,${Buffer.from(`thumb-${n}`).toString('base64')}`;
  const hdMain = Number((await db.query(`INSERT INTO product_photos (product_id, variant_id, kind, store, data, w, h, bytes, thumb, position) VALUES ($1, NULL, 'photo', 'local', 'AAAA', 2000, 2500, 3, $2, 0) RETURNING id`, [pid, thumb(1)]))[0].id);
  const hdA = Number((await db.query(`INSERT INTO product_photos (product_id, variant_id, kind, store, data, w, h, bytes, thumb, position) VALUES ($1, $2, 'photo', 'local', 'AAAA', 2000, 2000, 3, $3, 1) RETURNING id`, [pid, a, thumb(2)]))[0].id);
  h = await live();
  assert.doesNotMatch(h, new RegExp(`/api/lp/pp/${pid}/(m|v${a})-`), 'the small photos give way to the HD ones');
  const tagOf = (id: number) => h.match(new RegExp(`/api/lp/hd/${id}/720-([a-z0-9]+)\\.webp`))?.[1];
  assert.ok(tagOf(hdMain) && tagOf(hdA));
  assert.match(h, new RegExp(`/api/lp/hd/${hdA}/480-[a-z0-9]+\\.webp 480w, /api/lp/hd/${hdA}/720-[a-z0-9]+\\.webp 720w, /api/lp/hd/${hdA}/960-[a-z0-9]+\\.webp 960w`));
  assert.ok(h.indexOf('https://cdn.example/poster.jpg') < h.indexOf(`/api/lp/hd/${hdMain}/`), 'own poster still first');
  // the copies: without a server (here) the 320 px copy; a wrong tag or width: nothing
  assert.deepEqual(await call('landing.hdPhoto', admin, { id: hdA, w: 720, tag: tagOf(hdA)! }), { type: 'image/jpeg', base64: Buffer.from('thumb-2').toString('base64') });
  assert.equal(await call('landing.hdPhoto', admin, { id: hdA, w: 720, tag: 'wrong' }), null);
  await assert.rejects(() => call('landing.hdPhoto', admin, { id: hdA, w: 300, tag: tagOf(hdA)! }));
  // the editor gets the same photos (HD included)
  const cx: any = await call('landing.context', admin, { productId: pid });
  assert.equal(cx.photos.hd.id, hdMain);
  assert.equal(cx.photos.variants.find((v: any) => v.id === a).hd.id, hdA);
  // colour a off: its HD photo leaves too
  await db.query('UPDATE product_variants SET active = false WHERE id = $1', [a]);
  assert.doesNotMatch(await live(), new RegExp(`/api/lp/hd/${hdA}/`));
  await db.query('UPDATE product_variants SET active = true WHERE id = $1', [a]);
  // an HD photo removed: back to the small photo
  await db.query('DELETE FROM product_photos WHERE id = $1', [hdA]);
  assert.match(await live(), new RegExp(`/api/lp/pp/${pid}/v${a}-`));

  // the list's picture and a group's: the page's first photo (its poster)
  const row: any = (await call('landing.list', admin, {}) as any[]).find((x: any) => x.id === Number(pg.id));
  assert.equal(row.thumb, 'https://cdn.example/poster.jpg');
});

test('colour names in Arabic on the page: translated by themselves, or the Arabic name written in Produits', async () => {
  const { arabicName } = await import('@pilotix/shared');
  assert.equal(arabicName('Rose'), 'وردي');
  assert.equal(arabicName('Bleu clair'), 'أزرق فاتح');
  assert.equal(arabicName('bleu-marine'), 'أزرق كحلي');
  assert.equal(arabicName('Rose et Gris'), 'وردي ورمادي');
  assert.equal(arabicName('Doré'), 'ذهبي');
  assert.equal(arabicName('Couleur'), 'اللون');
  assert.equal(arabicName('أحمر'), 'أحمر');
  assert.equal(arabicName('6-12 mois'), '6-12 mois');
  assert.equal(arabicName('Rose XL'), 'Rose XL');
  // a product with colours: the page's list shows them in Arabic; one with its own Arabic name shows that
  const pg = (await db.query('SELECT id, slug, product_id FROM landing_pages WHERE id = $1', [pages[0].id]))[0];
  const pid = Number(pg.product_id);
  const p: any = await call('catalog.product', admin, { id: pid });
  const named = p.variants.filter((v: any) => v.title !== '');
  const mk = (title: string, titleAr?: string, x?: any) => ({ ...(x ? { id: x.id } : {}), title, sku: x?.sku ?? null, active: true, ...(titleAr !== undefined ? { titleAr } : {}) });
  await call('catalog.saveProduct', admin, {
    id: pid, name: p.name, sku: p.sku, price: p.price, cost: p.cost || 100, active: true,
    variants: [mk('Rose', undefined, named[0]), mk('Bleu clair', 'سماوي', named[1]), mk('Taupe foncé spécial')],
  });
  const after: any = await call('catalog.product', admin, { id: pid });
  assert.equal(after.variants.find((v: any) => v.title === 'Bleu clair').titleAr, 'سماوي');
  assert.equal(after.variants.find((v: any) => v.title === 'Rose').titleAr, '');
  await db.query('UPDATE landing_pages SET active = true WHERE id = $1', [pg.id]);
  const h = await html(String(pg.slug));
  assert.match(h, />وردي</);
  assert.match(h, />سماوي</);
  assert.doesNotMatch(h, />Rose</);
  assert.match(h, />Taupe foncé spécial( — |<)/);
  // the thumbnails: small and centred
  assert.match(h, /\.th img\{width:40px;height:50px/);
  assert.match(h, /\.th:before,\.th:after\{content:'';margin:auto\}/);
});

test('conversion: a browser counts once a day; robots, previews and no cookie do not; orders since that day ÷ visitors', async () => {
  const c: any = await call('landing.duplicate', marketer, { id: pages[0].id });
  await db.query('UPDATE landing_pages SET active = true WHERE id = $1', [c.id]);
  const row = async () => ((await call('landing.list', marketer, {})) as any[]).find((r) => r.id === c.id);
  assert.equal((await row()).unique, 0);
  assert.equal((await row()).conversion, null);
  const open = (visitor?: string, mode: 'live' | 'preview' = 'live') =>
    call('landing.html', admin, { slug: c.slug, mode, post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/', ...(visitor ? { visitor } : {}) });
  await open('aaaaaaaaaaaa11');
  await open('aaaaaaaaaaaa11'); // the same browser again the same day
  await open('bbbbbbbbbbbb22');
  await open(); // a robot (the server gives it no code)
  await open('NOT-A-CODE!'); // not a code the server makes
  await open('cccccccccccc33', 'preview'); // Pilotix itself, not a customer
  let r = await row();
  assert.equal(r.unique, 2);
  assert.equal(r.convOrders, 0);
  assert.equal(r.conversion, 0);
  // one real order on the page since the first counted day: 1 ÷ 2 = 50 %
  await db.query(
    `UPDATE orders SET landing_id = $1, created_at = (SELECT min(day) FROM landing_visits WHERE landing_id = $1)::timestamp + interval '2 hours' WHERE id = (SELECT id FROM orders WHERE landing_id IS NULL ORDER BY id LIMIT 1)`,
    [c.id],
  );
  r = await row();
  assert.equal(r.convOrders, 1);
  assert.equal(r.conversion, 50);
  assert.match(String(r.uniqueSince), /^\d{4}-\d\d-\d\d$/);
  // delete: its visits go with it
  await db.query('UPDATE orders SET landing_id = NULL WHERE landing_id = $1', [c.id]);
  await call('landing.remove', marketer, { id: c.id });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM landing_visits WHERE landing_id = $1', [c.id]))[0].n, 0);
  // the demo shows rates on its pages
  const demo = ((await call('landing.list', marketer, {})) as any[]).filter((x) => x.unique > 0);
  assert.ok(demo.length > 0);
  for (const x of demo) assert.ok(x.conversion >= 0 && x.conversion < 20, `${x.slug}: ${x.conversion}`);
});
