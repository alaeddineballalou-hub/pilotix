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
