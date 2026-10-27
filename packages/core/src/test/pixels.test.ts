// Réglages › Pixels: named Meta and TikTok pixels; each landing page picks one of each (default, a chosen one, none);
// real orders reach both from the server (TikTok's Events API: CompletePayment, phone in E.164 hashed); tokens stay on
// the server and only the administrator sets them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, test } from 'node:test';
import { call, Ctx, Db, ServerHooks } from '../index';
import { sendMetaEvents } from '../modules/landing';
import { landingSettings, queuePurchase } from '../modules/landingquery';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let marketer: Ctx;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let pages: { id: number; slug: string }[];
const META_A = '111111111111111';
const META_B = '222222222222222';
const TT = 'CQTESTPIXEL12345AB';

before(async () => {
  const s = await setup(30);
  db = s.db;
  as = s.as;
  admin = await as(EMAILS.admin);
  marketer = await as(EMAILS.marketer);
  pages = (await db.query('SELECT id, slug FROM landing_pages WHERE active ORDER BY id LIMIT 2')).map((r: any) => ({ id: Number(r.id), slug: String(r.slug) }));
});

const live = async (slug: string) => ((await call('landing.html', admin, { slug, mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/' })) as any).html as string;
const cfg = (html: string) => JSON.parse(/window\.__LP=(\{.*?\})<\/script>/.exec(html)![1].replace(/\\u003c/g, '<'));

test('pixels: named, one default per platform, chosen per page; tokens only by the administrator, never shown', async () => {
  const a: any = await call('landing.pixelSave', marketer, { platform: 'meta', name: 'Pixel A', pixelId: META_A, isDefault: true });
  assert.equal(a.isDefault, true);
  const b: any = await call('landing.pixelSave', admin, { platform: 'meta', name: 'Pixel B', pixelId: META_B, token: 'EAAB-secret-b' });
  assert.equal(b.isDefault, false);
  assert.equal(b.hasToken, true);
  await assert.rejects(call('landing.pixelSave', marketer, { platform: 'tiktok', name: 'TT', pixelId: TT, token: 'x' }), /administrateur/);
  const tt: any = await call('landing.pixelSave', admin, { platform: 'tiktok', name: 'TikTok bébé', pixelId: TT.toLowerCase(), token: 'tt-secret', testCode: 'TEST1' });
  assert.equal(tt.pixelId, TT);
  assert.equal(tt.isDefault, true, 'the first pixel of a platform is its default');
  await assert.rejects(call('landing.pixelSave', marketer, { platform: 'meta', name: 'X', pixelId: 'abc' }), /Pixel Meta/);
  await assert.rejects(call('landing.pixelSave', marketer, { platform: 'meta', name: 'X', pixelId: META_A }), /déjà/);
  const list = JSON.stringify(await call('landing.pixels', marketer, {}));
  assert.doesNotMatch(list, /secret/);

  // page 1: Pixel B and the TikTok pixel; page 2: the defaults, no TikTok
  const p1: any = await call('landing.get', marketer, { id: pages[0].id });
  await call('landing.save', marketer, { ...p1, id: p1.id, images: [], metaPixelRef: b.id, tiktokPixelRef: tt.id, pixelId: '' });
  const p2: any = await call('landing.get', marketer, { id: pages[1].id });
  await call('landing.save', marketer, { ...p2, id: p2.id, images: [], metaPixelRef: null, tiktokPixelRef: 0, pixelId: '' });
  const c1 = cfg(await live(pages[0].slug));
  assert.equal(c1.px, META_B);
  assert.equal(c1.tt, TT);
  const c2 = cfg(await live(pages[1].slug));
  assert.equal(c2.px, META_A);
  assert.equal(c2.tt, '');
  assert.match(await live(pages[0].slug), /analytics\.tiktok\.com/);
});

test('pixels: a real order reaches the page’s Meta pixel and TikTok pixel from the server', async () => {
  const o = (await db.query(`SELECT id, ref, phone FROM orders WHERE NOT is_exchange ORDER BY id DESC LIMIT 1`))[0];
  await db.query(`UPDATE orders SET landing_id = $2, conf_status = 'confirmed' WHERE id = $1`, [o.id, pages[0].id]);
  await queuePurchase(db, await landingSettings(db), Number(o.id), Date.now());
  const rows = await db.query(`SELECT platform, pixel_id, event_name FROM meta_events WHERE order_id = $1 ORDER BY platform`, [o.id]);
  assert.deepEqual(rows.map((r: any) => `${r.platform}:${r.pixel_id}:${r.event_name}`), [`meta:${META_B}:Purchase`, `tiktok:${TT}:Purchase`]);

  const log: { action: string; args: any }[] = [];
  const server: ServerHooks = {
    courier: async () => ({}),
    hashPassword: async (p) => p,
    dellal: async () => ({}),
    meta: async (action, args) => {
      log.push({ action, args });
      return { received: 1 };
    },
  };
  const ctx = await as(EMAILS.admin, server);
  await db.query(`UPDATE meta_events SET send_after = now() - interval '1 minute' WHERE order_id = $1`, [o.id]);
  const r = await sendMetaEvents(ctx);
  assert.ok(r.sent >= 2, JSON.stringify(r));
  const m = log.find((x) => x.action === 'capi' && x.args.pixelId === META_B);
  assert.ok(m, 'Meta');
  assert.equal(m!.args.token, 'EAAB-secret-b', 'the pixel’s own token');
  const t = log.find((x) => x.action === 'tiktok');
  assert.ok(t, 'TikTok');
  assert.equal(t!.args.pixelCode, TT);
  assert.equal(t!.args.token, 'tt-secret');
  assert.equal(t!.args.testEventCode, 'TEST1');
  const ev = t!.args.events.find((x: any) => x.event_id === `purchase-${o.ref}`);
  assert.equal(ev.event, 'CompletePayment');
  assert.equal(ev.user.phone, createHash('sha256').update(`+213${String(o.phone).replace(/^0/, '')}`).digest('hex'));
  assert.equal(ev.properties.currency, 'DZD');
});

test('pixels: a deleted pixel — its pages take the default again', async () => {
  const list: any[] = (await call('landing.pixels', marketer, {})) as any;
  const b = list.find((p) => p.pixelId === META_B);
  assert.equal(b.pages, 1);
  await call('landing.pixelRemove', marketer, { id: b.id });
  assert.equal(cfg(await live(pages[0].slug)).px, META_A);
  assert.equal((await db.query(`SELECT 1 FROM settings WHERE key = $1`, [`secret_pixel_${b.id}`])).length, 0);
});

test('thank-you screen: the WhatsApp button with the shop’s own message (off by default)', async () => {
  assert.doesNotMatch(await live(pages[0].slug), /id="wa"/);
  const g: any = await call('landing.settings.get', admin, {});
  await assert.rejects(call('landing.settings.save', admin, { ...g.settings, whatsapp: { on: true, number: '12', label: '', message: '' } }), /WhatsApp/);
  await call('landing.settings.save', admin, { ...g.settings, whatsapp: { on: true, number: '0661 23 45 67', label: 'كلمنا', message: 'سلام، أنا {nom}، طلبت {produit}' } });
  const h = await live(pages[0].slug);
  assert.match(h, /id="wa" class="wa" href="https:\/\/wa\.me\/213661234567"/);
  assert.match(h, /كلمنا/);
  assert.equal(cfg(h).wa.n, '213661234567');
  assert.equal(cfg(h).wa.m, 'سلام، أنا {nom}، طلبت {produit}');
  await call('landing.settings.save', admin, { ...g.settings, whatsapp: { on: false, number: '0661234567', label: '', message: '' } });
  assert.doesNotMatch(await live(pages[0].slug), /id="wa"/);
});
