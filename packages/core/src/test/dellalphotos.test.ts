// Dellal and photos. A customer's photo (Messenger, Instagram, WhatsApp) is kept with where it is; before Dellal answers,
// Pilot AI looks at it with the catalogue's photos and says what it shows and which product it is; the message becomes
// that, and Dellal answers about that product. The shop's product photos: Dellal looks at them (product_photos, as
// pictures that are never stored in the chat) and sends the real ones when a customer asks (send_photos: the colour asked
// first, sent before the words, never twice the same day, as JPEG at a public address nobody can guess).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, login, migrate, migrateAll, pgliteTenancy, seedBase, ServerHooks, staffLogin } from '../index';
import { parseMetaWebhook, runDellal, sniffImage } from '../dellal-server';
import { getRaw, setRaw } from '../modules/admin';
import { pilotTry, runAgent, seePhotos } from '../modules/dellal';
import { catalogueThumbs, fromDataUrl, mimeOf, productPhotos, readPhotoAnswer } from '../modules/dellalphotos';
import { savePilotConfig } from '../platform/pilotai';
import { loadShop } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
// tiny « pictures »: what matters here is their first bytes (JPEG / WebP), not what they show
const JPEG = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-${tag}-`.padEnd(48, 'x'))]).toString('base64');
const WEBP = (tag: string) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(`VP8-${tag}-`.padEnd(48, 'y'))]).toString('base64');

let t: Tenancy;
let db: Db;
let shop: Ctx;
let pid = 0;
let blue = 0;
let red = 0;
/** what the fake server was asked, and what its AI answers next */
const asked: { action: string; args: any }[] = [];
let brain: (req: any) => any = () => ({ content: [{ type: 'text', text: 'Saha 😊' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } });
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args: any) => {
    asked.push({ action, args });
    if (action === 'complete') return brain(args);
    if (action === 'media') return { ok: true, mime: 'image/jpeg', data: JPEG('client'), thumb: `data:image/jpeg;base64,${JPEG('small')}` };
    if (action === 'photos') return { ok: true, sent: args.photos.length, errors: [] };
    return { ok: true };
  },
};
const said = (req: any) => JSON.stringify(req.messages);

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
  shop = { db, session, now: () => Date.now(), emit: () => undefined, server: hooks, t, shop: { id: s1.id, slug: 'boutique', primary: true, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null } };
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-test-key-0123456789');
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), enabled: true }, Number(admin.id));
  // a stroller in two colours: its own photo, the red one's photo, and a landing page whose photos are tagged by colour
  pid = Number((await db.query(`INSERT INTO products (name, sku, price, photo) VALUES ('Poussette Luxe', 'PL-1', 12900, $1) RETURNING id`, [`data:image/webp;base64,${WEBP('product')}`]))[0].id);
  blue = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, 'Bleu', 'PL-1-B') RETURNING id`, [pid]))[0].id);
  red = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku, photo) VALUES ($1, 'Rouge', 'PL-1-R', $2) RETURNING id`, [pid, `data:image/jpeg;base64,${JPEG('red')}`]))[0].id);
  const img = async (tag: string) => Number((await db.query(`INSERT INTO landing_images (w, h, t160, w480, w960, w320) VALUES (960, 960, $1, $2, $3, $4) RETURNING id`, [WEBP(`${tag}-160`), WEBP(`${tag}-480`), WEBP(`${tag}-960`), WEBP(`${tag}-320`)]))[0].id);
  const front = await img('front');
  const blueSide = await img('blue');
  await db.query(`INSERT INTO landing_pages (product_id, slug, images) VALUES ($1, 'poussette-luxe', $2::jsonb)`, [pid, JSON.stringify([{ id: front }, { id: blueSide, v: blue }])]);
  await db.query(`INSERT INTO products (name, sku, price) VALUES ('Lit bébé', 'LB-1', 15900)`);
});

test('a photo’s real type from its first bytes; data URLs; the AI’s answer read safely', () => {
  assert.equal(sniffImage(Buffer.from(JPEG('a'), 'base64')), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from(WEBP('a'), 'base64')), 'image/webp');
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0])), 'image/png');
  assert.equal(sniffImage(Buffer.from('<html><body>not a photo</body></html>')), null);
  assert.equal(mimeOf(WEBP('x')), 'image/webp');
  // what the data URL says is not trusted: the bytes are
  assert.deepEqual(fromDataUrl(`data:image/webp;base64,${JPEG('x')}`)?.mime, 'image/jpeg');
  assert.equal(fromDataUrl('data:text/html;base64,PGgxPg=='), null);
  assert.equal(fromDataUrl('https://example.com/a.jpg'), null);
  const r = readPhotoAnswer('```json\n{"what":"Capture d’écran d’une pub : poussette bleue","text":"12 900 DA","product_id":7,"sure":true,"variant":"bleu","kind":"ad"}\n```', [7, 8]);
  assert.deepEqual(r, { what: 'Capture d’écran d’une pub : poussette bleue', text: '12 900 DA', productId: 7, sure: true, variant: 'bleu', kind: 'ad' });
  // a product that is not in the catalogue is none, and none is never « sure »
  assert.deepEqual(readPhotoAnswer('{"what":"un colis","product_id":99,"sure":true,"kind":"parcel"}', [7])?.productId, null);
  assert.equal(readPhotoAnswer('{"what":"un colis","product_id":99,"sure":true}', [7])?.sure, false);
  assert.equal(readPhotoAnswer('je ne sais pas', [7]), null);
});

test('a product’s photos: the colour asked first (its page photos, then its own), only that colour when sending', async () => {
  const look = await productPhotos(db, pid, { size: 'look', max: 6 });
  assert.equal(look.length, 4, 'the page’s two photos, the red one’s, the product’s');
  assert.ok(look[0].src.startsWith('li:'), 'the page’s photos first');
  assert.equal(look[0].mime, 'image/webp');
  const sendBlue = await productPhotos(db, pid, { variantId: blue, size: 'send', max: 3 });
  assert.equal(sendBlue.length, 1, 'only the blue photo');
  assert.equal(sendBlue[0].variantId, blue);
  assert.match(String(sendBlue[0].src), /^li:\d+:w960$/, 'the biggest copy for the customer');
  const sendRed = await productPhotos(db, pid, { variantId: red, size: 'send', max: 3 });
  assert.equal(sendRed.length, 1);
  assert.equal(sendRed[0].mime, 'image/jpeg');
  assert.equal(sendRed[0].variantId, red);
  // a colour without photos: the product’s (never another colour’s)
  const other = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, 'Gris', 'PL-1-G') RETURNING id`, [pid]))[0].id);
  const grey = await productPhotos(db, pid, { variantId: other, size: 'send', max: 3 });
  assert.ok(grey.length >= 1);
  assert.ok(grey.every((p) => p.variantId === null), 'the product’s own photos');
  await db.query('DELETE FROM product_variants WHERE id = $1', [other]);
  // the catalogue a customer's photo is compared with: one per product with a photo
  const cat = await catalogueThumbs(db);
  assert.deepEqual(cat.map((c) => c.name), ['Poussette Luxe'], 'a product without photo is not in it');
});

test('the webhook keeps the customer’s photos (each its own message), not Messenger’s stickers', () => {
  const fb = parseMetaWebhook({
    object: 'page',
    entry: [
      {
        messaging: [
          { sender: { id: 'U1' }, recipient: { id: 'PAGE' }, message: { mid: 'm.1', attachments: [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/a.jpg' } }, { type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/b.jpg' } }] } },
          { sender: { id: 'U1' }, recipient: { id: 'PAGE' }, message: { mid: 'm.2', attachments: [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/like.png', sticker_id: 369239263222822 } }] } },
        ],
      },
    ],
  });
  assert.equal(fb.length, 3);
  assert.deepEqual(fb[0].media, { kind: 'image', url: 'https://scontent.xx.fbcdn.net/a.jpg' });
  assert.equal(fb[0].text, '[photo envoyée]');
  assert.equal(fb[1].messageId, 'm.1#2', 'the second photo of the same message');
  assert.equal(fb[2].text, '[sticker]');
  assert.equal(fb[2].media, undefined);
  const wa = parseMetaWebhook({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P1' }, messages: [{ from: '213661000001', id: 'wamid.p', type: 'image', image: { id: 'IMG42', mime_type: 'image/jpeg', caption: '3andkom hadi ?' } }] } }] }],
  });
  assert.equal(wa[0].text, '[photo envoyée] 3andkom hadi ?');
  assert.deepEqual(wa[0].media, { kind: 'image', id: 'IMG42', mime: 'image/jpeg' });
});

test('a customer’s photo is read before Dellal answers: what it shows, the product, the words with it', async () => {
  const r: any = await call('dellal.receive', shop, { channel: 'whatsapp', externalId: '213661000071', text: '[photo envoyée] 3andkom hadi ?', messageId: 'wamid.ph1', media: { kind: 'image', id: 'IMG71', mime: 'image/jpeg' } });
  let m = (await db.query('SELECT body, meta FROM conv_messages WHERE id = $1', [r.messageId]))[0];
  assert.equal(m.meta.photo.status, 'pending');
  asked.length = 0;
  let reading: any = null;
  brain = (req) => {
    if (req.system.includes('Tu regardes UNE photo')) {
      reading = req;
      return { content: [{ type: 'text', text: `{"what":"Capture d’écran d’une publicité : une poussette bleue","text":"Promo","product_id":${pid},"sure":true,"variant":"bleu","kind":"ad"}` }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 40 } };
    }
    return { content: [{ type: 'text', text: 'Ih 3andna la Poussette Luxe 😊 b 12 900 DA. Men ayya wilaya ?' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  };
  await call('dellal.answer', shop, { id: r.conversationId });
  assert.deepEqual(asked.find((a) => a.action === 'media')?.args.media, { id: 'IMG71', mime: 'image/jpeg' }, 'the server fetched it from WhatsApp');
  assert.ok(reading, 'Pilot AI looked at it');
  assert.equal(reading.model, 'claude-haiku-5-5');
  const pics = reading.messages[0].content.filter((b: any) => b.type === 'image');
  assert.equal(pics.length, 2, 'the customer’s photo and the catalogue’s');
  assert.equal(pics[0].source.data, JPEG('client'));
  assert.match(JSON.stringify(reading.messages[0].content), /Le client a écrit avec : « 3andkom hadi \? »/);
  m = (await db.query('SELECT body, meta FROM conv_messages WHERE id = $1', [r.messageId]))[0];
  assert.equal(m.body, '[photo] Capture d’écran d’une publicité : une poussette bleue · Texte dessus : « Promo » · Message : 3andkom hadi ?');
  assert.equal(m.meta.photo.status, 'done');
  assert.equal(m.meta.photo.productId, pid);
  assert.equal(m.meta.photo.productName, 'Poussette Luxe');
  assert.equal(m.meta.photo.data, undefined, 'the photo itself is not kept');
  assert.match(String(m.meta.photo.thumb), /^data:image\/jpeg;base64,/, 'its small copy is');
  const answer = asked.filter((a) => a.action === 'complete').at(-1)!.args;
  assert.match(said(answer), /\[photo envoyée par le client, regardée par l’IA : Capture d’écran d’une publicité : une poussette bleue[^\]]*→ produit du catalogue #\d+ Poussette Luxe \(bleu\)\]/);
  assert.match(answer.system, /Photo envoyée par le client : elle t’arrive décrite entre crochets/);
  assert.match(answer.system, new RegExp(`#${pid} Poussette Luxe : 12900 DA.* · photos`), 'the catalogue says which products have photos');

  // not readable: Dellal asks what it shows (and never says it sees it)
  brain = (req) => (req.system.includes('Tu regardes UNE photo') ? { content: [{ type: 'text', text: 'désolé' }], stop_reason: 'end_turn' } : { content: [{ type: 'text', text: 'Chkoun had l’produit ?' }], stop_reason: 'end_turn' });
  const r2: any = await call('dellal.receive', shop, { channel: 'messenger', externalId: 'U-photo', text: '[photo envoyée]', messageId: 'm.ph2', media: { kind: 'image', url: 'https://scontent.xx.fbcdn.net/x.jpg' } });
  await call('dellal.answer', shop, { id: r2.conversationId });
  m = (await db.query('SELECT body, meta FROM conv_messages WHERE id = $1', [r2.messageId]))[0];
  assert.equal(m.meta.photo.status, 'failed');
  assert.match(said(asked.filter((a) => a.action === 'complete').at(-1)!.args), /photo que tu n’as pas pu voir : demande gentiment au client ce qu’elle montre/);
});

test('send_photos: the photos go before the words, as their own message; product_photos: pictures for the AI only', async () => {
  const r: any = await call('dellal.receive', shop, { channel: 'whatsapp', externalId: '213661000072', text: 'ab3athli tswira ta3 la poussette lbleu', messageId: 'wamid.s1' });
  let round = 0;
  let lookResult: any = null;
  brain = (req) => {
    round++;
    if (round === 1) return { content: [{ type: 'tool_use', id: 'tu1', name: 'product_photos', input: { product_id: pid, variant_id: blue } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
    if (round === 2) {
      lookResult = req.messages.at(-1).content[0];
      return { content: [{ type: 'tool_use', id: 'tu2', name: 'send_photos', input: { product_id: pid, variant_id: blue } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
    }
    return { content: [{ type: 'text', text: 'Ha hiya la bleu 👆 Men ayya wilaya ?' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  };
  asked.length = 0;
  await call('dellal.answer', shop, { id: r.conversationId });
  // the AI saw the blue photos as pictures; the chat keeps no bytes
  assert.ok(Array.isArray(lookResult.content));
  assert.equal(lookResult.content[0].type, 'text');
  assert.equal(lookResult.content[1].type, 'image');
  assert.equal(lookResult.content[1].source.media_type, 'image/webp');
  const tools = await db.query(`SELECT body, meta FROM conv_messages WHERE conversation_id = $1 AND role = 'tool' ORDER BY id`, [r.conversationId]);
  assert.match(tools[0].body, /product_photos #\d+ → \d photo\(s\) regardée\(s\)/);
  assert.equal(JSON.stringify(tools[0].meta).includes(WEBP('blue-480')), false, 'never a photo’s bytes in the chat');
  assert.match(tools[1].body, /send_photos #\d+ → 1 photo\(s\) envoyée\(s\)/);
  // sent before the words
  const sent = asked.filter((a) => a.action === 'photos' || a.action === 'send');
  assert.deepEqual(sent.map((a) => a.action), ['photos', 'send']);
  assert.equal(sent[0].args.photos.length, 1);
  assert.equal(sent[0].args.photos[0].data, WEBP('blue-960'));
  const out = await db.query(`SELECT body, meta FROM conv_messages WHERE conversation_id = $1 AND role = 'agent' ORDER BY id`, [r.conversationId]);
  assert.equal(out[0].body, '📷 Poussette Luxe — Bleu (1)');
  assert.equal(out[0].meta.photos[0].variantId, blue);
  assert.match(String(out[0].meta.photos[0].thumb), /^data:image\/webp;base64,/);
  assert.equal(out[1].body, 'Ha hiya la bleu 👆 Men ayya wilaya ?');

  // asked again the same day: not the same photos twice
  await call('dellal.receive', shop, { channel: 'whatsapp', externalId: '213661000072', text: 'mazal ab3athli tswira', messageId: 'wamid.s2' });
  round = 1;
  let again: any = null;
  brain = (req) => {
    round++;
    if (round === 2) return { content: [{ type: 'tool_use', id: 'tu3', name: 'send_photos', input: { product_id: pid, variant_id: blue } }], stop_reason: 'tool_use' };
    again = req.messages.at(-1).content[0];
    return { content: [{ type: 'text', text: 'Rahi lfo9 👆' }], stop_reason: 'end_turn' };
  };
  asked.length = 0;
  await call('dellal.answer', shop, { id: r.conversationId });
  assert.match(String(again.content), /"already":true/);
  assert.equal(asked.some((a) => a.action === 'photos'), false);
  // what Dellal reads of it next time
  const history = asked.filter((a) => a.action === 'complete').at(-1)!.args;
  assert.match(said(history), /\[tu as envoyé 1 photo\(s\) au client : Poussette Luxe — Bleu\]/);
});

test('the shop turns photo sending off: Dellal says so and sends none', async () => {
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), photos: false }, Number(admin.id));
  const r: any = await call('dellal.receive', shop, { channel: 'whatsapp', externalId: '213661000073', text: 'tswira stp', messageId: 'wamid.off1' });
  let round = 0;
  let res: any = null;
  let system = '';
  brain = (req) => {
    round++;
    system = req.system;
    if (round === 1) return { content: [{ type: 'tool_use', id: 'tu9', name: 'send_photos', input: { product_id: pid } }], stop_reason: 'tool_use' };
    res = req.messages.at(-1).content[0];
    return { content: [{ type: 'text', text: 'Ma n9derch nab3at tsawer hna' }], stop_reason: 'end_turn' };
  };
  asked.length = 0;
  await call('dellal.answer', shop, { id: r.conversationId });
  assert.match(String(res.content), /n’envoie pas de photos/);
  assert.match(system, /La boutique n’envoie pas de photos dans le chat/);
  assert.equal(asked.some((a) => a.action === 'photos'), false);
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), photos: true }, Number(admin.id));
});

test('the control room’s test chat: a photo as the customer, read like a real one; the photos Dellal sends stay in the chat', async () => {
  brain = (req) => {
    if (req.system.includes('Tu regardes UNE photo')) return { content: [{ type: 'text', text: `{"what":"Une poussette rouge","text":"","product_id":${pid},"sure":true,"variant":"rouge","kind":"product"}` }], stop_reason: 'end_turn' };
    return { content: [{ type: 'text', text: 'Hadi la Poussette Luxe rouge 😊' }], stop_reason: 'end_turn' };
  };
  asked.length = 0;
  const r = await pilotTry(shop, { staffId: 1, name: 'Pilotix', body: 'ch7al ?', reset: true, book: null, lab: 'live', photo: { data: JPEG('mine'), mime: 'image/jpeg', thumb: `data:image/jpeg;base64,${JPEG('mine-small')}` } });
  const mine = r.messages.find((m) => m.role === 'customer')!;
  assert.equal(mine.meta.photo.status, 'done');
  assert.equal(mine.meta.photo.data, undefined);
  assert.equal(mine.meta.photo.thumb, `data:image/jpeg;base64,${JPEG('mine-small')}`);
  assert.match(mine.body, /^\[photo\] Une poussette rouge · Message : ch7al \?$/);
  assert.equal(asked.some((a) => a.action === 'media'), false, 'its own bytes: nothing to fetch');
  assert.equal(asked.some((a) => a.action === 'send' || a.action === 'photos'), false, 'a test chat sends nothing');
});

test('the preview (no AI): a customer’s photo that is the catalogue’s is that product; send_photos for « tswira »', async () => {
  const preview: Ctx = { ...shop, server: undefined, t: undefined, shop: undefined } as any;
  const c = Number((await db.query(`INSERT INTO conversations (channel, external_id) VALUES ('test', 'preview-photo') RETURNING id`))[0].id);
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body, meta) VALUES ($1, 'customer', '[photo envoyée]', $2::jsonb)`, [c, JSON.stringify({ photo: { status: 'pending', mime: 'image/webp', data: WEBP('front-320') } })]);
  assert.equal(await seePhotos(preview, c, null), 1);
  const m = (await db.query(`SELECT body, meta FROM conv_messages WHERE conversation_id = $1`, [c]))[0];
  assert.equal(m.meta.photo.productId, pid);
  assert.match(m.body, /Poussette Luxe/);
  const out = await runAgent(preview, c);
  assert.match(String(out.reply), /C’est bien Poussette Luxe/);
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body) VALUES ($1, 'customer', 'tswira ta3 la poussette rouge stp')`, [c]);
  await runAgent(preview, c);
  const photos = (await db.query(`SELECT body, meta FROM conv_messages WHERE conversation_id = $1 AND role = 'agent' AND meta ? 'photos'`, [c]))[0];
  assert.equal(photos.body, '📷 Poussette Luxe — Rouge (1)');
});

test('the server: a WhatsApp photo with the shop’s token; Meta’s links only; a product photo becomes a JPEG at a public address', async () => {
  const s1 = (await loadShop(t, { primary: true }))!;
  const ctx: any = { db, t, shop: { id: s1.id }, session: shop.session, now: () => Date.now(), emit: () => {}, server: { ...hooks, publicApi: 'https://pilotix.online/api' } };
  await setRaw(db, 'secret_dellal_wa_token', 'EAAG-whatsapp-token');
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), whatsappPhoneId: '1122' });
  const real = globalThis.fetch;
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === 'https://graph.facebook.com/v21.0/IMG42') return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=42' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.startsWith('https://lookaside.fbsbx.com/')) return new Response(Buffer.from(JPEG('wa'), 'base64'), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    if (u === 'https://graph.facebook.com/v21.0/1122/messages') return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }) as any;
  try {
    const got: any = await runDellal('media', { channel: 'whatsapp', media: { id: 'IMG42' } }, ctx);
    assert.equal(got.ok, true);
    assert.equal(got.mime, 'image/jpeg');
    assert.equal(got.data, JPEG('wa'));
    assert.equal(calls[1].init.headers.Authorization, 'Bearer EAAG-whatsapp-token', 'WhatsApp’s file needs the token');
    assert.deepEqual(await runDellal('media', { channel: 'messenger', media: { url: 'http://169.254.169.254/latest' } }, ctx), { ok: false, error: 'bad_url' });
    // a JPEG product photo goes as it is when the server has no image tool; at a public address with a random key
    calls.length = 0;
    const r: any = await runDellal('photos', { channel: 'whatsapp', externalId: '213661000099', photos: [{ src: 'pv:9:test', mime: 'image/jpeg', data: JPEG('send'), url: null }] }, ctx);
    assert.equal(r.sent, 1, JSON.stringify(r));
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.type, 'image');
    const m = String(body.image.link).match(/^https:\/\/pilotix\.online\/api\/lp\/dp\/(\d+)\/([a-f0-9]{24})\.jpg$/);
    assert.ok(m, body.image.link);
    const file: any = await call('dellal.photoFile', shop, { id: Number(m![1]), key: m![2] });
    assert.equal(file.base64.length > 0, true);
    await assert.rejects(call('dellal.photoFile', shop, { id: Number(m![1]), key: 'a'.repeat(24) }), /introuvable/);
    // the same picture again: the same file
    calls.length = 0;
    await runDellal('photos', { channel: 'whatsapp', externalId: '213661000099', photos: [{ src: 'pv:9:test', mime: 'image/jpeg', data: JPEG('send'), url: null }] }, ctx);
    assert.equal(JSON.parse(calls[0].init.body).image.link, body.image.link);
  } finally {
    globalThis.fetch = real;
  }
});
