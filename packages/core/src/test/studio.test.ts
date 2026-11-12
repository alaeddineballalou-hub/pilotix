// Studio photo (Espace créateur): the shop's backgrounds (with their logo box), one version of a product's photo made by
// the AI on one of them (credits per image, given back when the AI fails; a version the check refuses is made once more,
// told what was wrong), the picked photo saved first for its colour and as its small picture, the poster as the
// product's main picture, and the shop's own key (an administrator's, never sent back).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, shopCtx, shopStatus, staffLogin } from '../index';
import { getRaw } from '../modules/admin';
import { checkPrompt, readCheck, readCopy, readLanding, readPosterTexts, studioPrompt } from '../modules/studio';
import { loadShop, passwordFromLink } from '../platform';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const JPEG = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-${tag}-`.padEnd(160, 'x'))]).toString('base64');
const URL_OF = (tag: string) => `data:image/jpeg;base64,${JPEG(tag)}`;

let t: Tenancy;
let db: Db;
let preview: Ctx;
let pid = 0;
let pink = 0;
const asked: { action: string; args: any }[] = [];
let checks: string[] = [];
let imageFails = false;
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args: any) => {
    asked.push({ action, args });
    if (action === 'studioImage') return imageFails ? { ok: false, error: 'quota' } : { ok: true, image: JPEG(`made-${asked.length}`), w: 1080, h: 1350, model: args.model };
    if (action === 'studioCheck') return { ok: true, text: checks.shift() ?? '{"ok": true, "problems": []}', model: args.model };
    return { ok: true };
  },
};

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  await staffLogin(t, OWNER.email, OWNER.password);
  db = t.shop('public');
  const s1 = (await loadShop(t, { primary: true }))!;
  const session = await login(db, OWNER.email, OWNER.password);
  preview = { db, session, now: () => Date.now(), emit: () => undefined, server: undefined, t: undefined, shop: undefined } as any;
  void s1;
  pid = Number((await db.query(`INSERT INTO products (name, sku, price) VALUES ('Vélo Su bébé', 'VB-1', 16950) RETURNING id`))[0].id);
  pink = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, 'Rose', 'VB-1-R') RETURNING id`, [pid]))[0].id);
});

test('the AI is told the logo box, the surface and what went wrong; its checks and poster words are read safely', () => {
  const p = studioPrompt({ product: 'Vélo', variant: 'Rose', surface: 'table', logo: { x: 0.4, y: 0.3, w: 0.2, h: 0.15 }, photos: 3, again: ['le logo est caché'] });
  assert.match(p, /IMAGES 2 to 4 are the SAME real product/);
  assert.match(p, /from 40% to 60% of the width and from 30% to 45% of the height/);
  assert.match(p, /on the wooden table/);
  assert.match(p, /avoid them: le logo est caché/);
  assert.match(studioPrompt({ product: 'Parc', variant: null, surface: 'floor', logo: null, photos: 1 }), /on the floor of the room/);
  assert.match(checkPrompt({ product: 'Vélo', logo: null, photos: 2 }), /"ok": true or false/);

  assert.deepEqual(readCheck('```json\n{"ok": false, "problems": ["flotte", "", "logo caché"]}\n```'), { ok: false, problems: ['flotte', 'logo caché'] });
  assert.equal(readCheck('pas du JSON'), null);
  assert.equal(readCheck('{"problems": []}'), null, 'no ok: not checked');
  assert.deepEqual(readPosterTexts('{"title": "أناقة ومتانة!", "subtitle": "من 7 إلى 14 سنة", "features": ["مقعد مريح", "عجلات جانبية", "سلة", "متين", "زائد"]}'), {
    title: 'أناقة ومتانة!',
    subtitle: 'من 7 إلى 14 سنة',
    features: ['مقعد مريح', 'عجلات جانبية', 'سلة', 'متين'],
  });
  assert.equal(readPosterTexts('{"title": "", "features": ["a", "b"]}'), null);
});

test('backgrounds: added with their logo box, edited, at most 8, removed', async () => {
  let r: any = await call('createur.studioAddBg', preview, { name: 'Showroom', data: JPEG('bg'), thumb: URL_OF('bg-t'), w: 1280, h: 1600, logo: { x: 0.4, y: 0.3, w: 0.2, h: 0.15 } });
  assert.equal(r.backgrounds.length, 1);
  assert.deepEqual(r.backgrounds[0].logo, { x: 0.4, y: 0.3, w: 0.2, h: 0.15 });
  assert.equal(r.backgrounds[0].surface, 'table');
  assert.ok(!('data' in r.backgrounds[0]), 'the list never carries the big picture');
  const id = r.backgrounds[0].id;
  r = await call('createur.studioEditBg', preview, { id, surface: 'floor', logo: null });
  assert.equal(r.backgrounds[0].surface, 'floor');
  assert.equal(r.backgrounds[0].logo, null);
  r = await call('createur.studioEditBg', preview, { id, name: 'Boutique' });
  assert.equal(r.backgrounds[0].name, 'Boutique');
  assert.equal(r.backgrounds[0].surface, 'floor', 'what was not sent stays');
  assert.equal(((await call('createur.studioBg', preview, { id })) as any).data, JPEG('bg'));
  await assert.rejects(call('createur.studioAddBg', preview, { name: 'PNG', data: Buffer.from('\x89PNG\r\n\x1a\n'.padEnd(200, 'x')).toString('base64'), thumb: URL_OF('x'), w: 900, h: 900 }), /JPEG/);
  for (let k = 0; k < 7; k++) await call('createur.studioAddBg', preview, { name: `Fond ${k}`, data: JPEG(`bg${k}`), thumb: URL_OF(`t${k}`), w: 900, h: 900 });
  await assert.rejects(call('createur.studioAddBg', preview, { name: 'Trop', data: JPEG('x'), thumb: URL_OF('x'), w: 900, h: 900 }), /8 fonds au plus/);
  const all: any = await call('createur.studio', preview, {});
  for (const b of all.backgrounds.slice(1)) await call('createur.studioRemoveBg', preview, { id: b.id });
  const st: any = await call('createur.studio', preview, {});
  assert.equal(st.backgrounds.length, 1);
  assert.equal(st.server, false);
  assert.deepEqual(
    st.products.find((p: any) => p.id === pid).variants.map((v: any) => v.title),
    ['Rose'],
  );
});

test('the preview draws its own example; the picked photo goes first for its colour, and the poster becomes the main picture', async () => {
  const bg = ((await call('createur.studio', preview, {})) as any).backgrounds[0].id;
  const made: any = await call('createur.studioMake', preview, { productId: pid, variantId: pink, backgroundId: bg, photos: [{ mime: 'image/jpeg', data: JPEG('p1') }] });
  assert.deepEqual(made, { demo: true });

  await call('photos.add', preview, { productId: pid, variantId: pink, kind: 'photo', data: JPEG('old'), w: 900, h: 900, thumb: URL_OF('old-t') });
  await call('createur.studioSave', preview, { productId: pid, variantId: pink, data: JPEG('studio'), w: 1080, h: 1350, thumb: URL_OF('studio-t'), small: URL_OF('studio-s') });
  const photos: any = await call('photos.list', preview, { productId: pid });
  const mine = photos.photos.filter((p: any) => p.variantId === pink).sort((a: any, b: any) => a.position - b.position);
  assert.equal(mine[0].thumb, URL_OF('studio-t'), 'the Studio photo is the one Dellal sends first');
  assert.equal((await db.query(`SELECT photo FROM product_variants WHERE id = $1`, [pink]))[0].photo, URL_OF('studio-s'));

  await call('createur.studioSave', preview, { productId: pid, variantId: pink, main: true, data: JPEG('poster'), w: 1080, h: 1350, thumb: URL_OF('poster-t'), small: URL_OF('poster-s') });
  assert.equal((await db.query(`SELECT photo FROM products WHERE id = $1`, [pid]))[0].photo, URL_OF('poster-s'));
  const after: any = await call('photos.list', preview, { productId: pid });
  assert.equal(after.photos.find((p: any) => p.thumb === URL_OF('poster-t')).variantId, null, 'the poster is the whole product’s');

  const words: any = await call('createur.studioTexts', preview, { productId: pid });
  assert.equal(words.demo, true);
  assert.equal(words.features.length, 4);
});

test('on the server: credits per image, a refused version made once more, the AI failing gives the credits back; the own key', async () => {
  // a real shop on a plan with 100 credits a month (the AI tools take them from its wallet)
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;
  const { id: planId } = await p('p.plans.save', { name: 'Mensuel', priceMonth: 3000, features: ['*'], maxUsers: 5, maxDrivers: 2, maxOrdersMonth: 1000, maxStores: 1, public: true, active: true });
  const made = await p('p.shops.create', { name: 'Baby Shop', ownerName: 'Salim', ownerEmail: 'salim@shops.dz', planId, trialDays: 14 });
  if (made.mail?.token) await passwordFromLink(t, made.mail.token, 'Boutique-Password-1');
  await t.platform.query('UPDATE platform.accounts SET email_verified_at = now() WHERE email = $1', ['salim@shops.dz']);
  const got = await p('p.credits.get');
  await p('p.credits.save', { config: { ...got.config, planCredits: { [planId]: 100 } } });
  const s = (await loadShop(t, { id: made.id }))!;
  const sdb = t.shop(s.schema);
  const server: Ctx = { db: sdb, session: await login(sdb, 'salim@shops.dz', 'Boutique-Password-1'), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t, server: hooks };
  const pid = Number((await sdb.query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VB-1', 16950) RETURNING id`))[0].id);
  const pink = Number((await sdb.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, 'Rose', 'VB-1-R') RETURNING id`, [pid]))[0].id);
  await call('createur.studioAddBg', server, { name: 'Showroom', data: JPEG('bg'), thumb: URL_OF('bg-t'), w: 1280, h: 1600 });
  const bg = ((await call('createur.studio', server, {})) as any).backgrounds[0].id;
  const photos = [{ mime: 'image/jpeg', data: JPEG('p1') }, { mime: 'image/jpeg', data: JPEG('p2') }];
  const wallet = async () => ((await call('createur.state', server, {})) as any).wallet;
  const before0 = await wallet();

  asked.length = 0;
  checks = ['{"ok": false, "problems": ["le produit flotte"]}', '{"ok": true, "problems": []}'];
  const r: any = await call('createur.studioMake', server, { productId: pid, variantId: pink, backgroundId: bg, photos });
  assert.equal(r.demo, false);
  assert.equal(r.redone, true);
  assert.deepEqual(r.check, { ok: true, problems: [] });
  const imgs = asked.filter((x) => x.action === 'studioImage');
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].args.images.length, 3, 'the background first, then the 2 photos');
  assert.equal(imgs[0].args.images[0].data, JPEG('bg'));
  assert.equal(imgs[0].args.key, null, 'Pilotix’s key');
  assert.match(imgs[1].args.prompt, /avoid them: le produit flotte/);
  const spent = before0.left - (await wallet()).left;
  assert.equal(spent, 20, 'two images: 2 × 10 credits');

  imageFails = true;
  const left = (await wallet()).left;
  await assert.rejects(call('createur.studioMake', server, { productId: pid, variantId: pink, backgroundId: bg, photos }), /quota/);
  assert.equal((await wallet()).left, left, 'the credits came back');
  imageFails = false;

  // the shop's own Gemini key: no credits, the key goes with the call, never back to the page
  await assert.rejects(call('createur.studioKey', server, { mode: 'gemini', key: 'short' }), /Collez la clé/);
  const k: any = await call('createur.studioKey', server, { mode: 'gemini', key: 'AIzaSyD-own-key-0123456789abcdef' });
  assert.deepEqual(k, { mode: 'gemini', has: true, model: '' });
  assert.equal(((await getRaw<any>(sdb, 'secret_studio_key', null)) as any).key, 'AIzaSyD-own-key-0123456789abcdef');
  const st: any = await call('createur.studio', server, {});
  assert.deepEqual(st.key, { mode: 'gemini', has: true, model: '' });
  assert.ok(!JSON.stringify(st).includes('own-key'));
  asked.length = 0;
  const before1 = (await wallet()).left;
  const own: any = await call('createur.studioMake', server, { productId: pid, variantId: pink, backgroundId: bg, photos, check: false });
  assert.equal(own.own, true);
  assert.equal(own.check, null);
  assert.equal(asked.find((x) => x.action === 'studioImage')!.args.key, 'AIzaSyD-own-key-0123456789abcdef');
  assert.ok(!asked.some((x) => x.action === 'studioCheck'));
  assert.equal((await wallet()).left, before1, 'own key: no credits');
  // a background from the words alone (no picture sent), with the shop's own key
  asked.length = 0;
  const bgm: any = await call('createur.studioMakeBg', server, { note: 'murs roses' });
  assert.equal(bgm.demo, false);
  const a0 = asked.find((x) => x.action === 'studioImage')!.args;
  assert.equal(a0.images.length, 0);
  assert.equal(a0.textOnly, true);
  assert.match(a0.prompt, /empty interior[\s\S]*The shop adds: murs roses/);
  // the same mode again without a key keeps the saved one; back to credits forgets it
  assert.equal(((await call('createur.studioKey', server, { mode: 'gemini' })) as any).has, true);
  assert.equal(((await call('createur.studioKey', server, { mode: 'credits' })) as any).has, false);
});

test('step 0: each kind has Pilotix’s words, the shop may write its own and go back; the texts and the background', async () => {
  let st: any = await call('createur.studio', preview, {});
  assert.deepEqual(Object.keys(st.prompts), ['photo', 'copy', 'landing', 'background']);
  assert.equal(st.prompts.photo.custom, false);
  assert.equal(st.prompts.photo.text, st.defaults.photo);
  await assert.rejects(call('createur.studioPrompt', preview, { kind: 'photo', text: 'court' }), /trop court/);
  let r: any = await call('createur.studioPrompt', preview, { kind: 'photo', text: 'Keep the product exactly. Make it bright and warm, on the table.' });
  assert.equal(r.prompts.photo.custom, true);
  assert.match(studioPrompt({ product: 'X', variant: null, surface: 'table', logo: null, photos: 2, rules: r.prompts.photo.text }), /Make it bright and warm/);
  r = await call('createur.studioPrompt', preview, { kind: 'photo', text: null });
  assert.equal(r.prompts.photo.custom, false, 'back to Pilotix’s words');
  r = await call('createur.studioPrompt', preview, { kind: 'copy', text: st.defaults.copy });
  assert.equal(r.prompts.copy.custom, false, 'the same words as Pilotix’s are not a change');

  st = await call('createur.studio', preview, {});
  const pid0 = st.products[0].id;
  const copy: any = await call('createur.studioCopy', preview, { productId: pid0 });
  assert.equal(copy.demo, true);
  assert.equal(copy.angles.length, 3);
  const land: any = await call('createur.studioLanding', preview, { productId: pid0, lang: 'fr' });
  assert.equal(land.benefits.length, 4);
  assert.deepEqual(await call('createur.studioMakeBg', preview, {}), { demo: true });

  assert.deepEqual(readCopy('{"post": "Salam", "angles": [{"name": "Prix", "hook": "Moins cher"}, {"name": "", "hook": "x"}]}'), { post: 'Salam', angles: [{ name: 'Prix', hook: 'Moins cher' }] });
  assert.equal(readCopy('{"post": "", "angles": []}'), null);
  assert.equal(readLanding('{"title": "T", "benefits": [{"title": "a"}]}'), null, 'at least 2 benefits');
});
