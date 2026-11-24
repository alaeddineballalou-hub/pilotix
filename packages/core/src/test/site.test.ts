// Landing pages › Website: a site starts from a design, is saved as the shop types (customers see nothing), and reaches
// the boutique's own domain only once published; its cards open the products' landing pages, best sellers first.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { renderSite, siteFromDesign, siteMissing, SiteDoc } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let marketer: Ctx;
let admin: Ctx;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  const s = await setup(80);
  db = s.db;
  as = s.as;
  marketer = await s.as(EMAILS.marketer);
  admin = await s.as(EMAILS.admin);
});

const live = async (lang?: string) =>
  ((await call('site.html', admin, { imgBase: 'https://shop.dz/api/lp/img/', base: '/', url: 'https://shop.dz/', ...(lang ? { lang } : {}), langHref: { ar: '/', fr: '/?lang=fr', en: '/?lang=en' } })) as any).html as string | null;

test('website: nothing published at first; a design starts the editor copy; only « Publier » shows it to customers', async () => {
  assert.equal(await live(), null);
  const g: any = await call('site.get', marketer, {});
  assert.equal(g.draft, null);
  assert.ok(g.designs.length >= 2);
  assert.ok(g.view.products.length > 0, 'the demo shop has pages online');

  const s: any = await call('site.start', marketer, { design: 'candy', langs: ['ar', 'fr'] });
  assert.equal(s.draft.design, 'candy');
  assert.deepEqual(s.draft.langs, ['ar', 'fr']);
  // a second start does not wipe the shop's work by accident
  await assert.rejects(call('site.start', marketer, { design: 'cloud', langs: ['fr'] }), /existe déjà/);
  // saved, still not public
  const doc: SiteDoc = { ...s.draft, home: s.draft.home.map((b: any) => (b.type === 'hero' ? { ...b, title: { ar: 'أهلا بكم', fr: 'Bienvenue' } } : b)) };
  await call('site.save', marketer, { doc });
  assert.equal(await live(), null);

  const p: any = await call('site.publish', marketer, {});
  assert.ok(p.at);
  const html = (await live())!;
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /أهلا بكم/);
  // no script on the live page, and the editor's marks are not there
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /data-b=/);
  // the French version: its own language, left to right, its own text
  const fr = (await live('fr'))!;
  assert.match(fr, /<html lang="fr" dir="ltr">/);
  assert.match(fr, /Bienvenue/);
  // a language the site does not have: its main one
  assert.match((await live('en'))!, /<html lang="ar"/);

  // each card opens a product's page online (best sellers first)
  const slugs = new Set((await db.query(`SELECT l.slug FROM landing_pages l JOIN products p ON p.id = l.product_id WHERE l.active AND p.active`)).map((r: any) => String(r.slug)));
  const hrefs = [...html.matchAll(/class="card" href="\/([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0);
  for (const h of hrefs) assert.ok(slugs.has(h), h);

  // a later change waits in the editor until it is published again
  await call('site.save', marketer, { doc: { ...doc, home: doc.home.map((b: any) => (b.type === 'hero' ? { ...b, title: { ar: 'عرض جديد', fr: 'Nouveau' } } : b)) } });
  assert.match((await live())!, /أهلا بكم/);
  const g2: any = await call('site.get', marketer, {});
  assert.equal(g2.live.same, false);
  await call('site.publish', marketer, {});
  assert.match((await live())!, /عرض جديد/);

  await call('site.unpublish', marketer, {});
  assert.equal(await live(), null);
});

test('website: what the editor saves is checked (block kinds, sizes, names), and agents cannot change it', async () => {
  const doc = siteFromDesign('cloud', ['fr']);
  await assert.rejects(call('site.save', marketer, { doc: { ...doc, home: [...doc.home, { id: 'x1', type: 'script', html: '<script>' } as any] } }));
  await assert.rejects(call('site.save', marketer, { doc: { ...doc, home: [doc.home[0], { ...doc.home[1], id: doc.home[0].id }] } }), /même nom/);
  await assert.rejects(call('site.save', marketer, { doc: { ...doc, langs: ['fr', 'fr'] } }), /double/);
  await assert.rejects(call('site.save', marketer, { doc: { ...doc, theme: { ...doc.theme, palette: 'gold' as any } } }));
  const agent = await as(EMAILS.conf);
  await assert.rejects(call('site.save', agent, { doc }), /Accès refusé/);
});

test('website: best sellers come first (delivered pieces), texts are escaped, missing languages are listed', async () => {
  const g: any = await call('site.get', marketer, {});
  const v = g.view;
  const doc = siteFromDesign('candy', ['ar', 'fr', 'en']);
  doc.home = doc.home.map((b) => (b.type === 'hero' ? { ...b, title: { ar: '<img src=x onerror=alert(1)>', fr: 'Bonjour', en: '' } } : b));
  const html = renderSite({ doc, lang: 'en', ...v }, { mode: 'edit', base: '/', selected: 'hr', hints: { noProducts: '-', noWhatsapp: '-', hidden: 'Hidden' } });
  assert.doesNotMatch(html, /<img src=x/);
  // English empty: the page shows the main language's text instead of a hole
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-b="hr"/);
  assert.ok(siteMissing(doc).some((m) => m.lang === 'en' && m.blocks.includes('hr')));
  if (v.best.length) {
    const first = v.products.find((p: any) => p.id === v.best[0]);
    if (first) {
      const m = /class="card" href="([^"]+)"/.exec(html.slice(html.indexOf('class="cards"')));
      assert.equal(m?.[1], `/${first.slug}`);
    }
  }
});
