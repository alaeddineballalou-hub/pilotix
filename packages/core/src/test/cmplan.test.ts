// AI social media manager: the rules Meta checks, the demo week, planning and posting (Facebook then Instagram, a network
// that failed tried again alone), the public photo address, the AI caption, deleting and editing a post that went out;
// the post score, the Algerian calendar, the fixed times, the administrator's yes, moving a post, « Post again »,
// « Fill my week », the results, the first comment, stories and Meta's numbers.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, ServerHooks } from '../index';
import { captionSystem, cleanCaption, demoCaption, fixCaption, hashtagCount, planError, planProblems, VIDEO_CHUNK } from '../modules/cmplan';
import { dzEvents, dzYear, faststartPieces, mp4Info, nextSlot, piecesSize, postScore } from '@pilotix/shared';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(120));
  // the demo asks for the administrator's yes; these tests plan as a marketer without it (one test turns it on)
  await db.query(`UPDATE settings SET value = jsonb_set(value, '{approval}', 'false') WHERE key = 'social'`);
});

/** a small real JPEG (its first bytes) in base64: what the browser sends after cropping */
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** A fake server: Meta's answers are recorded; `fail` makes one network refuse. */
function fakeServer(log: { action: string; args: any }[], opts: { fail?: 'facebook' | 'instagram'; caption?: string; igWait?: number } = {}): ServerHooks {
  let waits = opts.igWait ?? 0;
  return {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (p) => p,
    publicUrl: 'https://pilotix.test',
    media: async (action, args) => {
      log.push({ action: `media.${action}`, args });
      return { ok: true };
    },
    dellal: async (action, args: any) => {
      if (action === 'complete') return { content: [{ type: 'text', text: opts.caption ?? '« 🔥 Poussette légère\n#dz »' }], stop_reason: 'end_turn' };
      log.push({ action, args });
      if (action === 'planCheck') return waits-- > 0 ? { done: false } : { done: true, id: '17990000000000777', url: 'https://www.instagram.com/reel/x/' };
      if (action === 'planComment') return { id: `cmt_${log.length}` };
      if (action === 'planStats')
        return { items: (args.items ?? []).map((it: any) => ({ ...it, views: 100, reach: 80, likes: 7, comments: 2, shares: 1, saves: 3, insights: true, error: null })), followers: args.followers ? { facebook: 5000, instagram: 2600 } : {} };
      if (action === 'planPublish') {
        if (opts.fail === args.channel) throw Object.assign(new Error('Instagram : (#10) Application does not have permission for this action'), { metaCode: 10 });
        if (args.video && args.channel === 'instagram') return { pending: true, container: 'cont_1' };
        return args.channel === 'facebook' ? { id: `1029384756_${700 + log.length}`, url: 'https://www.facebook.com/x' } : { id: `1790${log.length}`, url: 'https://www.instagram.com/p/x/' };
      }
      return { ok: true };
    },
  };
}

async function linkPage() {
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, secrets: { ai: 'sk-ant-test-plan' } });
  await db.query(`UPDATE settings SET value = jsonb_set(jsonb_set(value, '{messengerPageId}', '"1029384756"'), '{instagramId}', '"17841400000000001"') WHERE key = 'dellal'`);
}
const soon = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const range = { from: new Date(Date.now() - 10 * 86_400_000).toISOString(), to: new Date(Date.now() + 40 * 86_400_000).toISOString() };

test('the rules Meta checks: networks, a photo for Instagram, its length and hashtags', () => {
  assert.deepEqual(planProblems({ caption: 'Salam', photos: 1, channels: ['facebook', 'instagram'] }), []);
  assert.match(planProblems({ caption: 'Salam', photos: 0, channels: ['instagram'] })[0], /une photo ou une vidéo/);
  assert.deepEqual(planProblems({ caption: 'Reel', photos: 0, videos: 1, videoReady: true, channels: ['instagram'] }), []);
  assert.match(planProblems({ caption: 'Reel', photos: 2, videos: 1, channels: ['facebook'] })[0], /photos ou une vidéo/);
  assert.deepEqual(planProblems({ caption: 'Texte seul', photos: 0, channels: ['facebook'] }), []);
  assert.match(planProblems({ caption: '', photos: 0, channels: ['facebook'] })[0], /photo, une vidéo ou un texte/);
  assert.match(planProblems({ caption: 'x', photos: 1, channels: [] })[0], /Facebook, Instagram/);
  assert.ok(planProblems({ caption: 'a'.repeat(2300), photos: 1, channels: ['instagram'] }).some((p) => /2200/.test(p)));
  assert.deepEqual(planProblems({ caption: 'a'.repeat(2300), photos: 1, channels: ['facebook'] }), []);
  const tags = Array.from({ length: 31 }, (_, k) => `#t${k}`).join(' ');
  assert.equal(hashtagCount(tags), 31);
  assert.equal(hashtagCount('prix 1#2 &#39; #الجزائر #dz'), 2);
  assert.ok(planProblems({ caption: tags, photos: 1, channels: ['instagram'] }).some((p) => /hashtags/.test(p)));
});

test('the demo week: posts out, one Instagram refused, planned ones, a draft', async () => {
  const mk = await as(EMAILS.marketer);
  const r: any = await call('cm.plan.list', mk, range);
  assert.ok(r.accounts.demo && r.accounts.facebook && r.accounts.instagram);
  const by = (s: string) => r.rows.filter((p: any) => p.status === s);
  // the carousel out two days ago (and, before it, the posts of the last days of the demo's history)
  const out = by('published').find((p: any) => p.facebook?.url?.endsWith('_90001'));
  assert.ok(out && out.photos.length === 2 && out.instagram.done && out.facebook.done);
  assert.ok(by('published').length >= 4 && by('published').some((p: any) => p.kind === 'story'));
  const failed = by('failed')[0];
  assert.ok(failed.facebook.done && !failed.instagram.done && /télécharger la photo/.test(failed.instagram.error));
  // the file it was, to find it again
  assert.equal(failed.photos[0].name, 'IMG_2034.jpg');
  assert.equal(by('scheduled').filter((p: any) => p.kind === 'post').length, 4);
  assert.equal(by('scheduled').filter((p: any) => p.kind === 'story').length, 1);
  assert.equal(r.review.length, 1);
  const reel = by('scheduled').find((p: any) => p.photos[0]?.kind === 'video');
  assert.ok(reel && reel.photos[0].duration === 14 && reel.photos[0].video === null && reel.photos[0].url.startsWith('data:image/svg+xml'));
  assert.equal(r.drafts.length, 1);
  assert.ok(r.drafts[0].photos[0].url.startsWith('data:image/svg+xml'));
  assert.ok(r.products.length > 0);
  assert.ok(r.bestHours.length >= 1 && r.bestHours.every((h: any) => h.hour >= 0 && h.hour <= 23));
  // the posts that went out are posts CM AI knows, with their product
  const known = await db.query(`SELECT product_id FROM cm_posts WHERE external_id = '1029384756_90001'`);
  assert.ok(known[0]?.product_id);
});

test('roles: a confirmation agent does not plan posts', async () => {
  const conf = await as(EMAILS.conf);
  await assert.rejects(call('cm.plan.list', conf, range), /forbidden|interdit|accès|droit/i);
});

test('photos: JPEG only, between 4:5 and 1.91:1, and their public address needs the key', async () => {
  const log: any[] = [];
  const mk = await as(EMAILS.marketer, fakeServer(log));
  await assert.rejects(call('cm.plan.photo', mk, { jpeg: 'iVBORw0KGgo=', thumb: JPEG, w: 1080, h: 1080 }), /JPEG/);
  await assert.rejects(call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1800 }), /4:5/);
  const ph: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1350 });
  assert.match(ph.url, /^https:\/\/pilotix\.test\/api\/lp\/pic\/\d+\/[a-f0-9]{24}-s\.jpg$/);
  const key = ph.url.match(/([a-f0-9]{24})-s\.jpg$/)[1];
  const admin = await as(EMAILS.admin);
  const img: any = await call('cm.plan.image', admin, { id: ph.id, key });
  assert.equal(img.base64, JPEG);
  await assert.rejects(call('cm.plan.image', admin, { id: ph.id, key: 'a'.repeat(24) }), /introuvable/i);
});

test('planning and posting: Facebook then Instagram, the photos from Pilotix, CM AI knows the product', async () => {
  await linkPage();
  const log: { action: string; args: any }[] = [];
  const mk = await as(EMAILS.marketer, fakeServer(log));
  const a: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080 });
  const b: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080 });
  const product = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-SAC'`))[0].id);
  // Instagram without a photo, or a time already past, is refused when planning (a draft is kept as it is)
  await assert.rejects(call('cm.plan.save', mk, { caption: 'Salam', photos: [], channels: ['instagram'], publishAt: soon(30), schedule: true }), /photo/);
  await assert.rejects(call('cm.plan.save', mk, { caption: 'Salam', photos: [a.id], channels: ['facebook'], publishAt: soon(-5), schedule: true }), /heure à venir/);
  const draft: any = await call('cm.plan.save', mk, { caption: '', photos: [], channels: ['instagram'] });
  assert.equal(draft.status, 'draft');
  const s: any = await call('cm.plan.save', mk, { caption: 'Sac à langer ✨ #dz', photos: [a.id, b.id], channels: ['instagram', 'facebook'], productId: product, publishAt: soon(30), schedule: true });
  assert.equal(s.status, 'scheduled');
  // not yet: nothing goes out (the job runs as the shop's system account: an admin)
  const job = await as(EMAILS.admin, fakeServer(log));
  const first: any = await call('cm.plan.run', job, {});
  assert.deepEqual({ published: first.published, failed: first.failed }, { published: 0, failed: 0 });
  // 31 minutes later it goes out
  const later = { ...job, now: () => Date.now() + 31 * 60_000 };
  const run: any = await call('cm.plan.run', later, {});
  assert.equal(run.published >= 1, true);
  const sent = log.filter((l) => l.action === 'planPublish');
  assert.deepEqual(
    sent.map((l) => l.args.channel),
    ['facebook', 'instagram'],
  );
  assert.equal(sent[0].args.images.length, 2);
  assert.ok(sent[0].args.images.every((u: string) => /^https:\/\/pilotix\.test\/api\/lp\/pic\/\d+\/[a-f0-9]{24}\.jpg$/.test(u)));
  assert.equal(sent[1].args.igId, '17841400000000001');
  const p: any = await call('cm.plan.get', mk, { id: s.id });
  assert.equal(p.status, 'published');
  assert.ok(p.facebook.done && p.instagram.done && p.publishedAt);
  const known = await db.query(`SELECT channel, product_id FROM cm_posts WHERE external_id IN ($1, $2) ORDER BY channel`, [
    (await db.query(`SELECT fb_id FROM cm_planned WHERE id = $1`, [s.id]))[0].fb_id,
    (await db.query(`SELECT ig_id FROM cm_planned WHERE id = $1`, [s.id]))[0].ig_id,
  ]);
  assert.deepEqual(
    known.map((k: any) => [k.channel, Number(k.product_id)]),
    [
      ['facebook', product],
      ['instagram', product],
    ],
  );
  // a post that went out keeps its place: no second save
  await assert.rejects(call('cm.plan.save', mk, { id: s.id, caption: 'x', photos: [a.id], channels: ['facebook'], publishAt: soon(60), schedule: true }), /déjà sorti/);
});

test('Instagram refuses: Facebook keeps its post, « Réessayer » sends Instagram only', async () => {
  await linkPage();
  const log: { action: string; args: any }[] = [];
  const mk = await as(EMAILS.marketer, fakeServer(log, { fail: 'instagram' }));
  const a: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080 });
  const s: any = await call('cm.plan.save', mk, { caption: 'Chaise haute 👶', photos: [a.id], channels: ['facebook', 'instagram'] });
  const r1: any = await call('cm.plan.publishNow', mk, { id: s.id });
  assert.equal(r1.status, 'failed');
  assert.ok(r1.post.facebook.done);
  assert.match(r1.post.instagram.error, /instagram_content_publish/);
  const ok = await as(EMAILS.marketer, fakeServer(log));
  const r2: any = await call('cm.plan.publishNow', ok, { id: s.id });
  assert.equal(r2.status, 'published');
  assert.deepEqual(
    log.filter((l) => l.action === 'planPublish').map((l) => l.args.channel),
    ['facebook', 'instagram', 'instagram'],
  );
});

test('a post that went out: its Facebook text changes, then it is deleted on both networks', async () => {
  await linkPage();
  const log: { action: string; args: any }[] = [];
  const mk = await as(EMAILS.marketer, fakeServer(log));
  const a: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080 });
  const s: any = await call('cm.plan.save', mk, { caption: 'Avant', photos: [a.id], channels: ['facebook', 'instagram'] });
  await call('cm.plan.publishNow', mk, { id: s.id });
  await call('cm.plan.editPosted', mk, { id: s.id, caption: 'Après' });
  const edit = log.find((l) => l.action === 'planEdit');
  assert.equal(edit?.args.caption, 'Après');
  assert.equal(((await call('cm.plan.get', mk, { id: s.id })) as any).caption, 'Après');
  await call('cm.plan.delete', mk, { id: s.id });
  assert.deepEqual(
    log.filter((l) => l.action === 'planDelete').map((l) => l.args.channel),
    ['facebook', 'instagram'],
  );
  await assert.rejects(call('cm.plan.get', mk, { id: s.id }), /introuvable/i);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM cm_media WHERE id = $1`, [a.id]))[0].n, 0);
});

test('the caption: the AI through the shop key, an example without AI', async () => {
  const product = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-POU'`))[0].id);
  const plain = await as(EMAILS.marketer);
  const d: any = await call('cm.plan.caption', plain, { productId: product, lang: 'fr', idea: 'Promo du week-end' });
  assert.equal(d.by, 'demo');
  assert.match(d.caption, /Poussette/i);
  assert.match(d.caption, /\d[\d ]* DA/);
  assert.match(d.caption, /Promo du week-end/);
  assert.match(demoCaption('darija', { name: 'Chaise', price: 9900 }), /9 900 دج/);
  await linkPage();
  const mk = await as(EMAILS.marketer, fakeServer([]));
  const ai: any = await call('cm.plan.caption', mk, { productId: product, lang: 'darija' });
  assert.equal(ai.by, 'ai');
  assert.equal(ai.caption, '🔥 Poussette légère\n#dz');
  assert.match(captionSystem({ lang: 'darija', channels: ['instagram'], tone: '', notes: 'Jamais de promo' }), /lettres arabes[\s\S]*Jamais de promo/);
  assert.equal(cleanCaption('```\nLégende : « Salam »\n```'), 'Salam');
});

test('Meta refusals become what to do', () => {
  assert.match(planError(Object.assign(new Error('Facebook : (#200) not authorized'), { metaCode: 200 }), 'facebook'), /pages_manage_posts/);
  assert.match(planError(new Error('Instagram : (#10) permission'), 'instagram', 'delete'), /instagram_manage_contents/);
  assert.match(planError(Object.assign(new Error('Instagram : The aspect ratio is not supported.'), { metaCode: 36003 }), 'instagram'), /4:5/);
});

// ---------------------------------------------------------------- videos
/** A tiny MP4 as phones write it: ftyp, then the pictures (mdat), then the index (moov) whose stco points into mdat. */
function phoneMp4(turned = false): Uint8Array {
  const box = (type: string, ...parts: Uint8Array[]) => {
    const body = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(8 + body);
    new DataView(out.buffer).setUint32(0, 8 + body);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    let at = 8;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const bytes = (n: number, f: (v: DataView) => void) => {
    const b = new Uint8Array(n);
    f(new DataView(b.buffer));
    return b;
  };
  const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isomiso2'));
  const mdat = box('mdat', new Uint8Array(1000).map((_, k) => k % 251));
  const mdatAt = ftyp.length;
  // two chunks inside mdat
  const stco = box('stco', bytes(16, (v) => (v.setUint32(4, 2), v.setUint32(8, mdatAt + 8), v.setUint32(12, mdatAt + 508))));
  const mvhd = box('mvhd', bytes(100, (v) => (v.setUint32(12, 1000), v.setUint32(16, 14_500))));
  const tkhd = box(
    'tkhd',
    bytes(84, (v) => {
      // the matrix at 40: a quarter turn (b = 1.0) when `turned`; the size at 76 and 80 (16.16)
      v.setInt32(40, turned ? 0 : 65536);
      v.setInt32(44, turned ? 65536 : 0);
      v.setUint32(76, 1920 * 65536);
      v.setUint32(80, 1080 * 65536);
    }),
  );
  const moov = box('moov', mvhd, box('trak', tkhd, box('mdia', box('minf', box('stbl', stco)))));
  const file = new Uint8Array(ftyp.length + mdat.length + moov.length);
  file.set(ftyp, 0);
  file.set(mdat, ftyp.length);
  file.set(moov, ftyp.length + mdat.length);
  return file;
}
const reader = (f: Uint8Array) => async (s: number, e: number) => f.slice(s, e);

test('a video keeps every byte: only its index moves to the front, the chunk addresses with it', async () => {
  const f = phoneMp4();
  const pieces = (await faststartPieces(f.length, reader(f)))!;
  assert.ok(pieces);
  assert.equal(piecesSize(pieces), f.length);
  const out = new Uint8Array(f.length);
  let at = 0;
  for (const p of pieces) {
    const b = p instanceof Uint8Array ? p : f.slice(p.from, p.to);
    out.set(b, at);
    at += b.length;
  }
  const type = (o: number) => String.fromCharCode(...out.slice(o + 4, o + 8));
  const v = new DataView(out.buffer);
  const moovAt = v.getUint32(0); // after ftyp
  assert.equal(type(moovAt), 'moov');
  const moovSize = v.getUint32(moovAt);
  assert.equal(type(moovAt + moovSize), 'mdat');
  // the first chunk's address is still the first byte of the pictures
  const stco = [...out.keys()].find((k) => type(k - 4) === 'stco')! - 4;
  const first = v.getUint32(stco + 8 + 8);
  assert.equal(first, moovAt + moovSize + 8);
  assert.deepEqual([...out.slice(first, first + 5)], [0, 1, 2, 3, 4]);
  // already first: sent as it is
  assert.equal(await faststartPieces(out.length, reader(out)), null);
  // its length and size, read from the index (a phone's portrait video is stored turned)
  assert.deepEqual(await mp4Info(f.length, reader(f)), { duration: 14.5, w: 1920, h: 1080 });
  const tall = phoneMp4(true);
  assert.deepEqual(await mp4Info(tall.length, reader(tall)), { duration: 14.5, w: 1080, h: 1920 });
});

test('a video post: sent in pieces, a Reel Instagram prepares, then out on both networks', async () => {
  await linkPage();
  const log: { action: string; args: any }[] = [];
  const mk = await as(EMAILS.marketer, fakeServer(log, { igWait: 1 }));
  const thumb = JPEG;
  await assert.rejects(call('cm.plan.videoStart', mk, { mime: 'video/mp4', size: 1000, w: 1080, h: 1920, duration: 2, thumb }), /3 secondes/);
  await assert.rejects(call('cm.plan.videoStart', mk, { mime: 'video/mp4', size: 400 * 1024 * 1024, w: 1080, h: 1920, duration: 20, thumb }));
  const v: any = await call('cm.plan.videoStart', mk, { mime: 'video/quicktime', size: 20 * 1024 * 1024, w: 1080, h: 1920, duration: 21.4, thumb });
  assert.equal(v.upload, true);
  assert.equal(v.chunk, VIDEO_CHUNK);
  assert.equal(v.ready, false);
  assert.match(v.url, /\/lp\/pic\/\d+\/[a-f0-9]{24}-s\.jpg$/);
  // the server reads what it needs to take the pieces (the job's Instagram still prepares the Reel at its first look)
  const admin = await as(EMAILS.admin, fakeServer(log, { igWait: 1 }));
  const file: any = await call('cm.plan.videoFile', admin, { id: v.id, key: v.key });
  assert.deepEqual({ ext: file.ext, size: file.size, ready: file.ready }, { ext: 'mov', size: 20 * 1024 * 1024, ready: false });
  // not whole yet: it cannot be planned
  const photo: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080 });
  await assert.rejects(call('cm.plan.save', mk, { caption: 'Reel', photos: [v.id, photo.id], channels: ['instagram'] }), /photos ou une vidéo/);
  await assert.rejects(call('cm.plan.save', mk, { caption: 'Reel', photos: [v.id], channels: ['instagram'], publishAt: soon(30), schedule: true }), /pas encore arrivée/);
  const done: any = await call('cm.plan.videoDone', mk, { id: v.id });
  assert.equal(done.ready, true);
  assert.match(done.video, /^https:\/\/pilotix\.test\/api\/lp\/vid\/\d+\/[a-f0-9]{24}\.mov$/);
  assert.deepEqual(log.find((l) => l.action === 'media.finish')?.args, { id: v.id, key: v.key, ext: 'mov', size: 20 * 1024 * 1024 });
  const s: any = await call('cm.plan.save', mk, { caption: 'Reel 🎬', photos: [v.id], channels: ['facebook', 'instagram'], publishAt: soon(30), schedule: true });
  // its time: Facebook takes the video, Instagram prepares the Reel
  const later = { ...admin, now: () => Date.now() + 31 * 60_000 };
  await call('cm.plan.run', later, {});
  const sent = log.filter((l) => l.action === 'planPublish');
  assert.deepEqual(
    sent.map((l) => [l.args.channel, l.args.images.length, /\/lp\/vid\/.+\.mov$/.test(l.args.video?.url ?? '')]),
    [
      ['facebook', 0, true],
      ['instagram', 0, true],
    ],
  );
  let p: any = await call('cm.plan.get', mk, { id: s.id });
  assert.equal(p.status, 'publishing');
  assert.ok(p.facebook.done && !p.instagram.done);
  // a minute later still preparing, then ready: out on both networks
  await call('cm.plan.run', later, {});
  assert.equal(((await call('cm.plan.get', mk, { id: s.id })) as any).status, 'publishing');
  await call('cm.plan.run', later, {});
  p = await call('cm.plan.get', mk, { id: s.id });
  assert.equal(p.status, 'published');
  assert.ok(p.instagram.done && p.instagram.url);
  assert.equal(log.filter((l) => l.action === 'planCheck').length, 2);
  // deleted: both posts, then the file on the server
  await call('cm.plan.delete', mk, { id: s.id });
  assert.ok(log.some((l) => l.action === 'media.remove' && l.args.id === v.id));
});

test('a video Instagram takes too long to prepare: not out, with what to do', async () => {
  await linkPage();
  const log: { action: string; args: any }[] = [];
  const mk = await as(EMAILS.marketer, fakeServer(log, { igWait: 1000 }));
  const v: any = await call('cm.plan.videoStart', mk, { mime: 'video/mp4', size: 1024, w: 1080, h: 1920, duration: 9, thumb: JPEG });
  await call('cm.plan.videoDone', mk, { id: v.id });
  const s: any = await call('cm.plan.save', mk, { caption: 'Reel', photos: [v.id], channels: ['instagram'] });
  const now: any = await call('cm.plan.publishNow', mk, { id: s.id });
  assert.equal(now.status, 'publishing');
  const admin = await as(EMAILS.admin, fakeServer(log, { igWait: 1000 }));
  await call('cm.plan.run', { ...admin, now: () => Date.now() + 31 * 60_000 }, {});
  const p: any = await call('cm.plan.get', mk, { id: s.id });
  assert.equal(p.status, 'failed');
  assert.match(p.instagram.error, /30 minutes/);
});

test('the post score: what makes a post sell, out of 10', () => {
  const good = '🔥 Poussette pliable à 12 900 DA\n✅ Légère\n🚚 Livraison dans les 58 wilayas\n💵 Paiement à la livraison\n📩 Commentez « prix » pour commander\n#Algérie #dz';
  const at20 = '2026-11-10T19:00:00.000Z'; // 20:00 in Algeria
  assert.equal(postScore({ caption: good, media: [{ kind: 'photo', w: 1080, h: 1080 }], price: 12900, at: at20, hours: [20] }).score, 10);
  const weak = postScore({ caption: 'joli', media: [{ kind: 'photo', w: 640, h: 640 }], price: 12900, at: '2026-11-10T03:00:00.000Z', hours: [20] });
  assert.deepEqual(
    weak.checks.filter((c) => !c.ok).map((c) => c.key),
    ['hook', 'price', 'delivery', 'cod', 'cta', 'hashtags', 'quality', 'hour'],
  );
  assert.equal(weak.score, 2);
  // a post for the shop (no product): no price asked, but its product is missing
  const shop = postScore({ caption: good.replace('à 12 900 DA', ''), media: [{ kind: 'video', w: 1080, h: 1920 }], price: null, at: at20, hours: [] });
  assert.deepEqual(
    shop.checks.filter((c) => !c.ok).map((c) => c.key),
    ['product'],
  );
  // a story: its picture, its hour, its product
  const st = postScore({ kind: 'story', caption: '', media: [{ kind: 'photo', w: 1080, h: 1920 }], price: 9900, at: at20, hours: [21] });
  assert.equal(st.checks.length, 4);
  assert.equal(st.score, 10);
  // without AI, « Fix it » adds the lines a caption misses
  const fixed = fixCaption('Chaise haute', ['delivery', 'cod', 'cta', 'hashtags'], 'fr', { name: 'Chaise haute', price: 9900 });
  const after = postScore({ caption: fixed, media: [{ kind: 'photo', w: 1080, h: 1350 }], price: 9900, at: at20, hours: [20] });
  assert.ok(['delivery', 'cod', 'cta', 'hashtags'].every((k) => after.checks.find((c) => c.key === k)!.ok), fixed);
});

test('the Algerian calendar and the fixed times', () => {
  const y = dzYear(2027);
  const day = (k: string) => y.find((e) => e.key === k)!;
  assert.equal(day('yennayer').date, '2027-01-12');
  assert.ok(day('ramadan').approx && day('ramadan').date >= '2027-02-05' && day('ramadan').date <= '2027-02-12', day('ramadan').date);
  assert.ok(day('fitr').date >= '2027-03-07' && day('fitr').date <= '2027-03-13', day('fitr').date);
  assert.ok(day('adha').date >= '2027-05-13' && day('adha').date <= '2027-05-19', day('adha').date);
  assert.equal(dzYear(2026).find((e) => e.key === 'blackfriday')!.date, '2026-11-27');
  assert.deepEqual(
    dzEvents('2026-11-01', '2026-11-30').map((e) => e.key),
    ['revolution', 'blackfriday'],
  );
  const every20 = [{ days: [0, 1, 2, 3, 4, 5, 6], time: '20:00' }];
  // Thursday 5 November 2026, 19:00 in Algeria: 20:00 the same day, then the next day when it is taken
  const t = Date.parse('2026-11-05T18:00:00.000Z');
  assert.equal(new Date(nextSlot(every20, t)!).toISOString(), '2026-11-05T19:00:00.000Z');
  assert.equal(new Date(nextSlot(every20, t, [Date.parse('2026-11-05T19:10:00.000Z')])!).toISOString(), '2026-11-06T19:00:00.000Z');
  // the weekend only (Friday 5, Saturday 6), at 13:00
  assert.equal(new Date(nextSlot([{ days: [5, 6], time: '13:00' }], t)!).toISOString(), '2026-11-06T12:00:00.000Z');
  assert.equal(nextSlot([], t), null);
});

test('the administrator’s yes: a marketer’s post waits, comes back with a word, then is planned', async () => {
  const admin = await as(EMAILS.admin);
  const mk = await as(EMAILS.marketer);
  const st: any = await call('cm.plan.settings', mk, {});
  await assert.rejects(call('cm.plan.saveSettings', mk, { ...st, approval: true }), /forbidden|interdit|accès|droit|réservé/i);
  await call('cm.plan.saveSettings', admin, { ...st, approval: true });
  try {
    const ph: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080 });
    const s: any = await call('cm.plan.save', mk, { caption: 'Salam #dz', photos: [ph.id], channels: ['facebook'], publishAt: soon(90), schedule: true });
    assert.equal(s.status, 'review');
    await assert.rejects(call('cm.plan.publishNow', mk, { id: s.id }), /oui de l’administrateur/);
    await assert.rejects(call('cm.plan.review', mk, { id: s.id, approve: true }), /forbidden|interdit|accès|droit|réservé/i);
    const back: any = await call('cm.plan.review', admin, { id: s.id, approve: false, note: 'Ajoutez le prix' });
    assert.equal(back.status, 'draft');
    assert.equal(back.reviewNote, 'Ajoutez le prix');
    await call('cm.plan.save', mk, { id: s.id, caption: 'Salam, 9 900 DA #dz', photos: [ph.id], channels: ['facebook'], publishAt: soon(90), schedule: true });
    const list: any = await call('cm.plan.list', admin, range);
    assert.ok(list.review.some((p: any) => p.id === s.id));
    const ok: any = await call('cm.plan.review', admin, { id: s.id, approve: true });
    assert.equal(ok.status, 'scheduled');
    assert.ok(ok.approvedAt && !ok.reviewNote);
    // the administrator's own post needs no yes
    const own: any = await call('cm.plan.save', admin, { caption: 'Salam #dz', photos: [ph.id], channels: ['facebook'], publishAt: soon(120), schedule: true });
    assert.equal(own.status, 'scheduled');
    await call('cm.plan.delete', admin, { id: own.id });
    await call('cm.plan.delete', admin, { id: s.id });
  } finally {
    await call('cm.plan.saveSettings', admin, { ...st, approval: false });
  }
});

test('moving a post, « Post again », « Fill my week » and planning its drafts', async () => {
  const mk = await as(EMAILS.marketer);
  const r: any = await call('cm.plan.list', mk, range);
  const sched = r.rows.find((p: any) => p.status === 'scheduled' && p.kind === 'post');
  const moved: any = await call('cm.plan.move', mk, { id: sched.id, publishAt: new Date(Date.parse(sched.publishAt) + 3 * 86_400_000).toISOString() });
  assert.equal(Date.parse(moved.publishAt) - Date.parse(sched.publishAt), 3 * 86_400_000);
  await assert.rejects(call('cm.plan.move', mk, { id: sched.id, publishAt: soon(-60) }), /à venir/);
  const out = r.rows.find((p: any) => p.facebook?.url?.endsWith('_90001'));
  await assert.rejects(call('cm.plan.move', mk, { id: out.id, publishAt: soon(600) }), /déjà sorti/);
  // « Post again »: a new draft, same photos and product, on a fixed time (20:00 or 13:00 in Algeria)
  const again: any = await call('cm.plan.again', mk, { id: out.id });
  assert.equal(again.post.status, 'draft');
  assert.equal(again.post.againOf, out.id);
  assert.deepEqual(
    again.post.photos.map((p: any) => p.id),
    out.photos.map((p: any) => p.id),
  );
  assert.equal(again.post.productId, out.productId);
  assert.ok(again.post.caption.length > 10 && again.post.publishAt);
  assert.ok(['20:00', '13:00'].includes(new Date(Date.parse(again.post.publishAt) + 3_600_000).toISOString().slice(11, 16)));
  await call('cm.plan.delete', mk, { id: again.post.id });
  // the photos stay: the post that went out still has them
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM cm_media WHERE id = ANY($1)`, [out.photos.map((p: any) => p.id)]))[0].n, 2);
  // « Fill my week »: drafts on the fixed times, each with its product, its caption and the first comment
  const fill: any = await call('cm.plan.fillWeek', mk, { count: 3, lang: 'fr' });
  assert.equal(fill.posts.length, 3);
  assert.ok(fill.posts.every((p: any) => p.status === 'draft' && p.publishAt && p.caption.length > 10 && p.firstComment));
  assert.ok(fill.posts.filter((p: any) => p.productId).length >= 2);
  assert.equal(new Set(fill.posts.map((p: any) => p.publishAt)).size, 3);
  const many: any = await call('cm.plan.planMany', mk, { ids: fill.posts.map((p: any) => p.id) });
  assert.equal(many.planned + many.skipped.length, 3);
  // a draft without a photo cannot go on Instagram: it says why
  for (const sk of many.skipped) assert.match(sk.problem, /photo|vidéo/);
  for (const p of fill.posts) await call('cm.plan.delete', mk, { id: p.id });
});

test('results: what each post did, the best posts, hours and kinds, the followers, the week', async () => {
  const mk = await as(EMAILS.marketer);
  const st: any = await call('cm.plan.stats', mk, { days: 90 });
  assert.ok(st.posts.length >= 14);
  assert.ok(st.insights);
  assert.ok(st.totals.views > 50_000 && st.totals.orders > 0 && st.totals.revenue > 0);
  assert.equal(st.totals.orders, st.posts.reduce((a: number, p: any) => a + p.results.orders, 0));
  // a Reel sold most (the demo's), and the kinds are compared
  assert.equal(st.best[0].type, 'video');
  assert.ok(st.byType.some((g: any) => g.key === 'video') && st.byType.some((g: any) => g.key === 'story'));
  assert.ok(st.bestHour !== null && st.bestHour >= 0 && st.bestHour <= 23);
  assert.ok(st.followers.facebook.change > 0 && st.followers.instagram.now > 2000);
  assert.ok(st.week.tips.some((t: any) => t.key === 'again'));
  // a story's comments do not exist (its answers come as messages)
  assert.ok(st.posts.filter((p: any) => p.type === 'story').every((p: any) => p.results.cmComments === 0));
});

test('on the server: the first comment, a story, and Meta’s numbers once an hour', async () => {
  await linkPage();
  const log: { action: string; args: any }[] = [];
  const mk = await as(EMAILS.marketer, fakeServer(log));
  const ph: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080 });
  const tall: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1920, story: true });
  await assert.rejects(call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1920 }), /4:5/);
  const post: any = await call('cm.plan.save', mk, { caption: 'Poussette 12 900 DA #dz', photos: [ph.id], channels: ['facebook', 'instagram'], publishAt: soon(30), schedule: true, firstComment: 'Écrivez « prix » 👇' });
  // a tall photo cannot be an Instagram post: a story
  await assert.rejects(call('cm.plan.save', mk, { caption: 'x', photos: [tall.id], channels: ['instagram'], publishAt: soon(30), schedule: true }), /story/);
  const story: any = await call('cm.plan.save', mk, { kind: 'story', caption: '', photos: [tall.id], channels: ['facebook', 'instagram'], publishAt: soon(30), schedule: true, firstComment: 'ignored' });
  const job = await as(EMAILS.admin, fakeServer(log));
  await call('cm.plan.run', { ...job, now: () => Date.now() + 31 * 60_000 }, {});
  const pub = log.filter((l) => l.action === 'planPublish');
  assert.ok(pub.some((l) => l.args.story && l.args.channel === 'instagram' && l.args.images.length === 1 && l.args.caption === ''));
  assert.ok(pub.some((l) => !l.args.story && l.args.caption.startsWith('Poussette')));
  const comments = log.filter((l) => l.action === 'planComment');
  assert.deepEqual(comments.map((l) => l.args.channel).sort(), ['facebook', 'instagram']);
  assert.ok(comments.every((l) => l.args.text === 'Écrivez « prix » 👇'));
  const p: any = await call('cm.plan.get', mk, { id: post.id });
  assert.equal(p.status, 'published');
  assert.deepEqual(p.comment, { facebook: true, instagram: true, error: null });
  const s: any = await call('cm.plan.get', mk, { id: story.id });
  assert.equal(s.status, 'published');
  assert.equal(s.firstComment, null);
  // Meta's numbers: asked for the new posts, stored, not asked again before an hour
  const asked = log.filter((l) => l.action === 'planStats');
  assert.ok(asked.length >= 1);
  const fbId = String((await db.query(`SELECT fb_id FROM cm_planned WHERE id = $1`, [post.id]))[0].fb_id);
  const row = (await db.query(`SELECT external_id, views, insights FROM cm_post_stats WHERE channel = 'facebook' AND external_id = $1`, [fbId]))[0];
  assert.ok(row && row.views === 100 && row.insights);
  const before = log.filter((l) => l.action === 'planStats').length;
  await call('cm.plan.run', { ...job, now: () => Date.now() + 40 * 60_000 }, {});
  const again = log.filter((l) => l.action === 'planStats').slice(before);
  assert.ok(again.every((l) => !l.args.items.some((it: any) => it.id === row?.external_id)));
  // a story is deleted in Pilotix only (it leaves Meta by itself after 24 hours)
  const n = log.filter((l) => l.action === 'planDelete').length;
  await call('cm.plan.delete', mk, { id: story.id });
  assert.equal(log.filter((l) => l.action === 'planDelete').length, n);
});

test('a post that does not go out: its file’s name is kept, and its writer and the administrators are told (not while they watch)', async () => {
  await linkPage();
  const log: { action: string; args: any }[] = [];
  const pushes: { to: string[]; payload: any }[] = [];
  const withPush = (fail?: 'facebook' | 'instagram'): ServerHooks => ({
    ...fakeServer(log, { fail }),
    pushKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    push: async (_k, subs, payload) => {
      pushes.push({ to: subs.map((x) => x.endpoint), payload });
      return subs.map((x) => ({ endpoint: x.endpoint, ok: true, gone: false }));
    },
  });
  const mk = await as(EMAILS.marketer, withPush('instagram'));
  const job = await as(EMAILS.admin, withPush('instagram'));
  const mkPhone = 'https://fcm.googleapis.com/fcm/send/plan-marketer';
  const adPhone = 'https://fcm.googleapis.com/fcm/send/plan-admin';
  for (const [who, end] of [
    [mk.session.profile.id, mkPhone],
    [job.session.profile.id, adPhone],
  ] as const)
    await db.query(`INSERT INTO push_subs (profile_id, endpoint, p256dh, auth) VALUES ($1, $2, 'k', 'a') ON CONFLICT (endpoint) DO NOTHING`, [who, end]);
  // only the file's own name is kept (never the folder it was in)
  const a: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080, name: 'C:\\Users\\Baby Joy\\Vidéos\\IMG_2034.jpg' });
  assert.equal(a.name, 'IMG_2034.jpg');
  // « Publier maintenant »: the person watches, the result is on the screen, no notification
  const s1: any = await call('cm.plan.save', mk, { caption: 'Trottinette', photos: [a.id], channels: ['facebook', 'instagram'] });
  const r1: any = await call('cm.plan.publishNow', mk, { id: s1.id });
  assert.equal(r1.status, 'failed');
  assert.equal(r1.post.photos[0].name, 'IMG_2034.jpg');
  assert.equal(pushes.length, 0);
  // planned for later, nobody watching: the failure is told with the file's name, the network and why
  const b: any = await call('cm.plan.photo', mk, { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080, name: 'tricycle-rouge.jpg' });
  const s2: any = await call('cm.plan.save', mk, { caption: 'Tricycle', photos: [b.id], channels: ['instagram'], publishAt: soon(30), schedule: true });
  await call('cm.plan.run', { ...job, now: () => Date.now() + 31 * 60_000 }, {});
  const told = pushes.find((x) => x.payload.tag === `plan-fail-${s2.id}`);
  assert.ok(told, 'the failure is told');
  assert.match(told.payload.title, /tricycle-rouge\.jpg/);
  assert.match(told.payload.body, /^Instagram · Meta ne permet pas encore/);
  assert.ok(told.to.includes(mkPhone) && told.to.includes(adPhone));
  // the menu's red count on Pilot Content: the posts that did not go out
  const c: any = await call('orders.counts', job, {});
  assert.ok(c.ai.posts >= 2);
});
