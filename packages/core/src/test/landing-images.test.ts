// Landing page pictures from the compressor: the 720 width phones take, the tiny blurred placeholder shown at once,
// what the compressor did (shown in the editor); pictures stored before keep working.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { landingDescriptionImageIds, landingDescriptionText, landingMetaDescription } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { plainText } from '../modules/metacatalog';
import { EMAILS, setup } from './harness';

let db: Db;
let marketer: Ctx;
let admin: Ctx;
let productId: number;
const SLUG = 'photos-test';
// tiny valid base64 payloads (the server stores what the editor made; it does not decode them)
const B = (s: string) => Buffer.from(s).toString('base64');
const INFO = {
  orig: 4_200_000,
  ow: 4000,
  oh: 3000,
  bytes: { t160: 3_100, w480: 18_000, w720: 34_000, w960: 52_000 },
  ssim: { t160: 0.971, w480: 0.987, w720: 0.986, w960: 0.9855 },
  preset: 'balanced' as const,
};

before(async () => {
  const s = await setup(50);
  db = s.db;
  marketer = await s.as(EMAILS.marketer);
  admin = await s.as(EMAILS.admin);
  productId = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-POU'`))[0].id);
});

const live = async () =>
  ((await call('landing.html', admin, { slug: SLUG, mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/' })) as any).html as string;

test('a compressed picture: 720 width in the srcset, blurred placeholder behind the main photo, info back in the editor', async () => {
  const img: any = await call('landing.addImage', marketer, { w: 960, h: 720, t160: B('t160'), w480: B('w480'), w720: B('w720'), w960: B('w960'), lqip: B('lqip'), info: INFO });
  assert.deepEqual(img.info, INFO);
  const old: any = await call('landing.addImage', marketer, { w: 960, h: 960, t160: B('o160'), w480: B('o480'), w960: B('o960') });
  assert.equal(old.info, null);
  const page: any = await call('landing.save', marketer, { productId, slug: SLUG, title: 'Photos', price: 9950, images: [{ id: img.id }, { id: old.id }] });

  const html = await live();
  assert.match(html, new RegExp(`srcset="/i/${img.id}/480\\.webp 480w, /i/${img.id}/720\\.webp 720w, /i/${img.id}/960\\.webp 960w"`));
  assert.match(html, new RegExp(`imagesrcset="/i/${img.id}/480\\.webp 480w, /i/${img.id}/720\\.webp 720w, /i/${img.id}/960\\.webp 960w"`), 'the preload asks for the same file');
  assert.ok(html.includes(`background-image:url(data:image/webp;base64,${B('lqip')})`), 'placeholder behind the main photo');
  // the older picture: no 720 in its srcset (thumbnail button data)
  assert.match(html, new RegExp(`data-ss="/i/${old.id}/480\\.webp 480w, /i/${old.id}/960\\.webp 960w"`));

  const got: any = await call('landing.get', marketer, { id: page.id });
  assert.deepEqual(got.images[0].info, INFO);
  assert.equal(got.images[1].info, null);
});

test('the 720 file: its own when made, the 960 one for a picture from before', async () => {
  const sys = admin;
  const img: any = await call('landing.addImage', marketer, { w: 960, h: 720, t160: B('a'), w480: B('b'), w720: B('c720'), w960: B('d960') });
  const old: any = await call('landing.addImage', marketer, { w: 960, h: 720, t160: B('a'), w480: B('b'), w960: B('old960') });
  assert.equal(((await call('landing.image', sys, { id: img.id, size: '720' })) as any).base64, B('c720'));
  assert.equal(((await call('landing.image', sys, { id: old.id, size: '720' })) as any).base64, B('old960'));
  assert.equal(((await call('landing.image', sys, { id: img.id, size: '960' })) as any).base64, B('d960'));
});

test('what the compressor sends is checked: bad quality scores, oversized placeholder, not base64', async () => {
  const base = { w: 960, h: 720, t160: B('a'), w480: B('b'), w960: B('c') };
  await assert.rejects(call('landing.addImage', marketer, { ...base, info: { ...INFO, ssim: { ...INFO.ssim, w960: 1.5 } } }));
  await assert.rejects(call('landing.addImage', marketer, { ...base, lqip: 'A'.repeat(5_000) }));
  await assert.rejects(call('landing.addImage', marketer, { ...base, w720: 'not base64!' }));
  await assert.rejects(call('landing.addImage', marketer, { ...base, info: { ...INFO, preset: 'ultra' } }));
});

test('the 320 width: in the srcset when made, added later to a picture from before (once), the 480 file until then', async () => {
  const sys = admin;
  const made: any = await call('landing.addImage', marketer, { w: 960, h: 720, t160: B('a'), w320: B('n320'), w480: B('n480'), w960: B('n960'), info: { ...INFO, bytes: { ...INFO.bytes, w320: 9_000 }, ssim: { ...INFO.ssim, w320: 0.988 } } });
  const old: any = await call('landing.addImage', marketer, { w: 960, h: 720, t160: B('a'), w480: B('p480'), w960: B('p960'), info: INFO });
  await call('landing.save', marketer, { productId, slug: 'photos-320', title: 'Photos 320', price: 9950, images: [{ id: made.id }, { id: old.id }] });
  const html = async () => ((await call('landing.html', admin, { slug: 'photos-320', mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/' })) as any).html as string;

  assert.match(await html(), new RegExp(`srcset="/i/${made.id}/320\\.webp 320w, /i/${made.id}/480\\.webp 480w, /i/${made.id}/960\\.webp 960w"`));
  assert.equal(((await call('landing.image', sys, { id: old.id, size: '320' })) as any).base64, B('p480'), 'no 320 yet: the 480 file');
  assert.doesNotMatch(await html(), new RegExp(`/i/${old.id}/320\\.webp`));

  const up: any = await call('landing.addW320', marketer, { id: old.id, w320: B('p320'), bytes: 8_000, ssim: 0.989 });
  assert.equal(up.ok, true);
  assert.equal(up.info.bytes.w320, 8_000);
  assert.equal(up.info.ssim.w320, 0.989);
  assert.equal(((await call('landing.image', sys, { id: old.id, size: '320' })) as any).base64, B('p320'));
  assert.match(await html(), new RegExp(`/i/${old.id}/320\\.webp 320w, /i/${old.id}/480\\.webp 480w`));
  // a second time changes nothing
  assert.equal(((await call('landing.addW320', marketer, { id: old.id, w320: B('other'), bytes: 1, ssim: 0.5 })) as any).ok, false);
  assert.equal(((await call('landing.image', sys, { id: old.id, size: '320' })) as any).base64, B('p320'));
});

test('a picture inside the description: its line « [image:N] » draws it there; a wrong number draws nothing; the line is never read as text; 12 at most', async () => {
  const img: any = await call('landing.addImage', marketer, { w: 960, h: 2400, t160: B('d160'), w480: B('d480'), w720: B('d720'), w960: B('d960'), lqip: B('dlq') });
  const text = `# Titre\nAvant\n[image:${img.id}]\nAprès\n\n[ IMAGE : 999999 ]\n- puce <b>`;
  const page: any = await call('landing.save', marketer, { productId, slug: 'desc-img', title: 'Desc', price: 5000, description: text, images: [] });
  const html = ((await call('landing.html', admin, { slug: 'desc-img', mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/' })) as any).html as string;

  // between what is written before and after it, with the light files phones take, loaded only when the customer gets there
  const at = (w: number) => `/i/${img.id}/${w}\\.webp`;
  assert.match(
    html,
    new RegExp(
      `<h3>Titre</h3><p>Avant</p><img class="di" style="background-image:url\\(data:image/webp;base64,${B('dlq')}\\)" src="${at(480)}" srcset="${at(480)} 480w, ${at(720)} 720w, ${at(960)} 960w" sizes="[^"]+" width="960" height="2400" alt="" loading="lazy" decoding="async"><p>Après</p><ul><li>puce &lt;b&gt;</li></ul>`,
    ),
  );
  // a number that is not one of the shop's pictures: nothing, and never the line itself
  assert.ok(!html.includes('999999'));
  assert.doesNotMatch(html, /\[\s*image\s*:/i);
  assert.equal((html.match(/class="di"/g) ?? []).length, 1);
  // the main photo keeps the page's first download: the description's picture is not preloaded
  assert.doesNotMatch(html, new RegExp(`rel="preload"[^>]*/i/${img.id}/`));

  // inside Pilotix (no pictures' address): the picture itself
  const inside = ((await call('landing.html', admin, { slug: 'desc-img', mode: 'parent', post: '', geo: '', lead: 'parent', imgBase: null })) as any).html as string;
  assert.ok(inside.includes(`<img class="di" src="data:image/webp;base64,${B('d480')}"`));

  // the editor gets the description's pictures back (small copies)
  const got: any = await call('landing.get', marketer, { id: page.id });
  assert.deepEqual(
    got.descImages.map((x: any) => [x.id, x.w, x.h, x.thumb, x.src]),
    [[img.id, 960, 2400, `data:image/webp;base64,${B('d160')}`, `data:image/webp;base64,${B('d480')}`]],
  );
  assert.equal(got.description, text, 'the text is kept as typed');

  // read as text (search snippet, the AI, the catalog): without the pictures' lines
  assert.deepEqual(landingDescriptionImageIds(text), [img.id, 999999]);
  assert.equal(landingDescriptionText(text), '# Titre\nAvant\nAprès\n\n- puce <b>');
  assert.equal(landingMetaDescription({ title: 'Desc', price: 5000, description: text }), 'Titre Avant Après puce <b>');
  assert.equal(plainText(landingDescriptionText(`Avant\n[image:${img.id}]\nAprès`)), 'Avant\nAprès');

  // 12 pictures at most in a description
  const many = (n: number) => Array.from({ length: n }, (_, k) => `[image:${k + 1}]`).join('\n');
  await assert.rejects(call('landing.save', marketer, { id: page.id, productId, slug: 'desc-img', title: 'Desc', price: 5000, description: many(13), images: [] }), /12 images au plus/);
  await call('landing.save', marketer, { id: page.id, productId, slug: 'desc-img', title: 'Desc', price: 5000, description: many(12), images: [] });
});


test('« Pourquoi nous »: one picture for the shop, on every page, before or after the description', async () => {
  const html = async () => ((await call('landing.html', admin, { slug: 'desc-img', mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/' })) as any).html as string;
  const why = `<section class="d dx"><img class="di"`;
  assert.ok(!(await html()).includes(why), 'nothing before a picture is chosen');
  const img: any = await call('landing.addImage', marketer, { w: 960, h: 1800, t160: B('y160'), w480: B('y480'), w720: B('y720'), w960: B('y960') });
  await assert.rejects(call('landing.why.save', marketer, { imageId: 999_999, first: false }), /Image introuvable/);
  await call('landing.why.save', marketer, { imageId: img.id, first: false });
  const got: any = await call('landing.why.get', marketer, {});
  assert.deepEqual([got.imageId, got.first, got.image.w, got.image.h], [img.id, false, 960, 1800]);
  // every page shows it, edge to edge, after the description by default
  let h = await html();
  assert.ok(h.includes(why) && h.includes(`/i/${img.id}/480.webp`));
  const desc = `<section class="card d`;
  assert.ok(h.indexOf(desc) > 0 && h.indexOf(desc) < h.indexOf(why));
  assert.ok(((await call('landing.html', admin, { slug: SLUG, mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/' })) as any).html.includes(why), 'another page of the shop too');
  // before the description when asked
  await call('landing.why.save', marketer, { imageId: img.id, first: true });
  h = await html();
  assert.ok(h.indexOf(why) < h.indexOf(desc));
  // other settings are kept, and the picture is taken off every page again
  assert.equal(((await call('landing.settings.get', marketer, {})) as any).settings.purchaseAt, 'confirmed');
  await call('landing.why.save', marketer, { imageId: null, first: true });
  assert.ok(!(await html()).includes(why));
});
