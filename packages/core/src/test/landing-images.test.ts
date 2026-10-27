// Landing page pictures from the compressor: the 720 width phones take, the tiny blurred placeholder shown at once,
// what the compressor did (shown in the editor); pictures stored before keep working.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
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
