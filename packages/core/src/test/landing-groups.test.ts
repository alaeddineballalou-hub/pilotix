// Landing pages › Groupes: several products on one page; a product opens its own landing page with « back to all the
// products »; five designs; the best seller the shop picks; clicks and orders per product; addresses never shared.
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
  pages = (await db.query('SELECT id, slug FROM landing_pages WHERE active ORDER BY id LIMIT 3')).map((r: any) => ({ id: Number(r.id), slug: String(r.slug) }));
  assert.equal(pages.length, 3);
});

const html = async (slug: string, extra: Record<string, unknown> = {}) =>
  ((await call('landing.html', admin, { slug, mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/', ...extra })) as any).html as string;

test('groups: saved, shown at their address, each product opens its own landing page', async () => {
  const g: any = await call('landing.groupSave', marketer, {
    slug: 'mes-produits',
    title: 'كل ما يحتاجه طفلك',
    subtitle: 'اختر المنتج',
    theme: 'grid',
    items: pages.map((p) => ({ pageId: p.id })),
  });
  assert.equal(g.items.length, 3);
  assert.equal(g.theme, 'grid');
  const h = await html('mes-produits');
  for (const p of pages) assert.ok(h.includes(`href="${p.slug}?g=mes-produits"`), p.slug);
  assert.match(h, /كل ما يحتاجه طفلك/);
  assert.equal(Number((await db.query(`SELECT views FROM landing_groups WHERE slug = 'mes-produits'`))[0].views), 1);

  // the product page opened from the group: the « back » bar, and a click counted
  const prod = await html(pages[1].slug, { group: 'mes-produits' });
  assert.match(prod, /id="bk" href="mes-produits"/);
  assert.match(prod, /رجوع إلى كل المنتجات/);
  // opened straight from an ad (or from a group that does not have it): as before, no bar
  assert.doesNotMatch(await html(pages[1].slug), /id="bk"/);
  assert.doesNotMatch(await html(pages[1].slug, { group: 'nope-group' }), /id="bk"/);
  const list: any[] = (await call('landing.groups', marketer, {})) as any;
  const mine = list.find((x) => x.slug === 'mes-produits');
  assert.equal(mine.clicks, 1);
  assert.equal(mine.items.find((x: any) => x.pageId === pages[1].id).clicks, 1);

  // an order that came through the group (its utm « g ») counts for the group and the product
  const o = (await db.query('SELECT id FROM orders ORDER BY id DESC LIMIT 1'))[0];
  await db.query(`UPDATE orders SET utm = '{"g":"mes-produits"}', landing_id = $2 WHERE id = $1`, [o.id, pages[1].id]);
  const again: any = ((await call('landing.groups', marketer, {})) as any[]).find((x) => x.slug === 'mes-produits');
  assert.equal(again.orders, 1);
  assert.equal(again.items.find((x: any) => x.pageId === pages[1].id).orders, 1);

  // offline: gone for customers, still in Pilotix
  await call('landing.groupSave', marketer, { id: g.id, slug: 'mes-produits', title: 'x', active: false, items: pages.map((p) => ({ pageId: p.id })) });
  await assert.rejects(html('mes-produits'), /introuvable/);
  assert.doesNotMatch(await html(pages[1].slug, { group: 'mes-produits' }), /id="bk"/);
});

test('groups: the best seller the shop picks is shown big at the top', async () => {
  const g: any = await call('landing.groupSave', marketer, {
    slug: 'best-test',
    title: 'Best',
    theme: 'best',
    bestPageId: pages[2].id,
    items: pages.map((p) => ({ pageId: p.id, note: p.id === pages[2].id ? 'خفيفة 5 كغ' : '' })),
  });
  assert.equal(g.bestPageId, pages[2].id);
  const h = await html('best-test');
  const hero = h.indexOf('class="it hero"');
  assert.ok(hero > 0);
  assert.ok(h.indexOf(`href="${pages[2].slug}?g=best-test"`) === h.indexOf('href=', hero));
  assert.match(h, /الأكثر طلباً/);
  assert.match(h, /خفيفة 5 كغ/);
  await assert.rejects(call('landing.groupSave', marketer, { slug: 'best-2', title: 'B', theme: 'best', bestPageId: 999999, items: [{ pageId: pages[0].id }] }), /best-seller/);
});

test('groups: addresses are never shared with a landing page, a product only once', async () => {
  await assert.rejects(call('landing.groupSave', marketer, { slug: pages[0].slug, title: 'X', items: [{ pageId: pages[0].id }] }), /déjà prise/);
  await assert.rejects(call('landing.groupSave', marketer, { slug: 'dup-test', title: 'X', items: [{ pageId: pages[0].id }, { pageId: pages[0].id }] }), /deux fois/);
  const pid = Number((await db.query('SELECT product_id FROM landing_pages WHERE id = $1', [pages[0].id]))[0].product_id);
  await assert.rejects(call('landing.save', marketer, { productId: pid, slug: 'best-test', title: 'x', images: [] }), /groupe/);
  const s: any = await call('landing.groupSlug', marketer, { title: 'Best Test' });
  assert.equal(s.slug, 'best-test-2');
  // agents (confirmation) do not edit groups
  await assert.rejects(call('landing.groups', await as(EMAILS.conf), {}), /Accès refusé/);
});

test('groups: the designs (tabs and search, sold out at the end, the editor preview)', async () => {
  const img = null;
  const items = [
    { slug: 'a', title: 'Alpha', price: 1000, oldPrice: 1500, image: img, tab: 'Mode', soldOut: true },
    { slug: 'b', title: 'Beta', price: 2000, oldPrice: null, image: img, tab: 'Maison' },
  ];
  const tabs = renderGroup({ slug: 'g', title: 'T', subtitle: '', color: '#0f766e', theme: 'tabs', items, shopName: 'S' }, { mode: 'live' });
  assert.match(tabs, /data-t="Mode"/);
  assert.match(tabs, /id="sr"/);
  assert.ok(tabs.indexOf('href="b?g=g"') < tabs.indexOf('href="a?g=g"'), 'sold out at the end');
  assert.match(tabs, /-33%/);
  for (const theme of ['grid', 'big', 'best', 'list'] as const) assert.match(renderGroup({ slug: 'g', title: 'T', subtitle: '', color: '#0f766e', theme, items, shopName: 'S' }, { mode: 'live' }), /href="b\?g=g"/);
  const draft: any = await call('landing.groupDraft', marketer, { slug: '', title: 'Brouillon', theme: 'list', items: pages.map((p) => ({ pageId: p.id })) });
  assert.match(draft.html, /Brouillon/);
  assert.match(draft.html, /noindex/);
});
