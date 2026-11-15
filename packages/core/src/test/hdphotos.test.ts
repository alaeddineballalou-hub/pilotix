// HD product photos for Dellal: one or more for each colour or size, or for the product, and the size chart. On the
// server each photo goes once to Pilotix's Cloudflare R2 bucket and the shop keeps only its name there and a small copy;
// Meta downloads it from the bucket by a link valid for an hour. The browser preview keeps its photos itself. Dellal
// sends the colour asked first, and the size chart when the customer asks which size to take.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, login, migrate, migrateAll, pgliteTenancy, seedBase, ServerHooks, staffLogin } from '../index';
import { runDellal, setPhotosPause } from '../dellal-server';
import { getRaw, setRaw } from '../modules/admin';
import { runAgent } from '../modules/dellal';
import { followProduct } from '@pilotix/shared';
import { productPhotos } from '../modules/dellalphotos';
import { productPhotoSets } from '../modules/landing';
import { presign, saveStore, signQuery, storeStatus } from '../photostore';
import { savePilotConfig } from '../platform/pilotai';
import { loadShop } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const JPEG = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-${tag}-`.padEnd(160, 'x'))]).toString('base64');
const THUMB = (tag: string) => `data:image/jpeg;base64,${JPEG(`thumb-${tag}`)}`;
const MINI = (tag: string) => `data:image/jpeg;base64,${JPEG(`mini-${tag}`)}`;
const R2 = { account: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', bucket: 'pilotix-photos', keyId: 'f3a1c2b4d5e6f708192a3b4c5d6e7f80', secret: 'Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg' };

let t: Tenancy;
let db: Db;
let server: Ctx;
let preview: Ctx;
let pid = 0;
let red = 0;
let blue = 0;
const asked: { action: string; args: any }[] = [];
let brain: (req: any) => any = () => ({ content: [{ type: 'text', text: 'Saha 😊' }], stop_reason: 'end_turn' });
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args: any) => {
    asked.push({ action, args });
    if (action === 'complete') return brain(args);
    if (action === 'photos') return { ok: true, sent: args.photos.length, errors: [] };
    return { ok: true };
  },
};

/** R2, as the tests see it: every request is noted and answered 200 */
const r2calls: { method: string; url: string; bytes: number; type: string | null }[] = [];
const realFetch = globalThis.fetch;
function fakeR2() {
  r2calls.length = 0;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (u.startsWith(`https://${R2.account}.r2.cloudflarestorage.com/`)) {
      r2calls.push({ method: init.method ?? 'GET', url: u, bytes: init.body ? (init.body as Uint8Array).length : 0, type: init.headers?.['Content-Type'] ?? null });
      return new Response('', { status: 200 });
    }
    if (u === 'https://graph.facebook.com/v21.0/1122/messages') return new Response(JSON.stringify({ messages: [{ id: 'wamid.hd' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }) as any;
}

before(async () => {
  setPhotosPause(0);
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  await staffLogin(t, OWNER.email, OWNER.password);
  db = t.shop('public');
  const s1 = (await loadShop(t, { primary: true }))!;
  const session = await login(db, OWNER.email, OWNER.password);
  server = { db, session, now: () => Date.now(), emit: () => undefined, server: hooks, t, shop: { id: s1.id, slug: 'boutique', primary: true, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null } };
  preview = { ...server, server: undefined, t: undefined, shop: undefined } as any;
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-test-key-0123456789');
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), enabled: true }, Number(admin.id));
  pid = Number((await db.query(`INSERT INTO products (name, sku, price) VALUES ('Robe Lina', 'RL-1', 5900) RETURNING id`))[0].id);
  red = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, 'Rouge', 'RL-1-R') RETURNING id`, [pid]))[0].id);
  blue = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, 'Bleu', 'RL-1-B') RETURNING id`, [pid]))[0].id);
});

const add = (ctx: Ctx, o: { variantId?: number | null; kind?: 'photo' | 'sizes'; tag: string }) =>
  call('photos.add', ctx, { productId: pid, variantId: o.variantId ?? null, kind: o.kind ?? 'photo', data: JPEG(o.tag), w: 2048, h: 1536, thumb: THUMB(o.tag), mini: MINI(o.tag) }) as Promise<any>;

test('R2 links: the AWS example signs the same; a link names the account, the bucket and the photo; the settings check their fields', async () => {
  // the example of AWS's documentation (Signature V4, query string): the same signature
  const q = await signQuery({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1', keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
  assert.match(q, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  const url = await presign(R2, 'GET', 'boutique/p1/abc.jpg', 3600, new Date('2026-11-05T10:00:00Z'));
  assert.match(url, new RegExp(`^https://${R2.account}\\.r2\\.cloudflarestorage\\.com/pilotix-photos/boutique/p1/abc\\.jpg\\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${R2.keyId}%2F20261105%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261105T100000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$`));
  await assert.rejects(presign(R2, 'GET', '../secret', 60), /invalide/);

  await assert.rejects(saveStore(t.platform, { account: 'not-an-account', bucket: 'x' }), /32 caractères/);
  assert.equal((await storeStatus(t.platform)).configured, false);
});

test('the preview keeps its HD photos; Dellal sends the colour asked first, and the size chart when the customer asks for it', async () => {
  let v: any = await add(preview, { variantId: red, tag: 'red-1' });
  assert.equal(v.store, 'local');
  await add(preview, { variantId: red, tag: 'red-2' });
  await add(preview, { variantId: blue, tag: 'blue-1' });
  await add(preview, { variantId: null, tag: 'all-1' });
  v = await add(preview, { kind: 'sizes', variantId: red, tag: 'chart' });
  assert.equal(v.photos.length, 5);
  const chart = v.photos.find((p: any) => p.kind === 'sizes');
  assert.equal(chart.variantId, null, 'the size chart is the product’s');
  assert.match(chart.thumb, /^data:image\/jpeg;base64,/);
  assert.equal(v.photos[0].bytes, Buffer.from(JPEG('red-1'), 'base64').length);

  // the colour asked: its own HD photos only, in their order, with their bytes (the preview has no bucket)
  let ph = await productPhotos(db, pid, { variantId: red, size: 'send', max: 3 });
  assert.deepEqual(
    ph.map((p) => p.data),
    [JPEG('red-1'), JPEG('red-2')],
  );
  assert.ok(ph.every((p) => p.src.startsWith('hd:') && !p.key));
  assert.equal(ph[0].thumb, MINI('red-1'), 'the chat that sends it keeps the 160 px copy');
  // no colour asked: the product's photos (the colours' come after)
  ph = await productPhotos(db, pid, { size: 'send', max: 2 });
  assert.equal(ph[0].data, JPEG('all-1'));
  // the AI looks at their small copies; the size chart only when asked for
  ph = await productPhotos(db, pid, { variantId: blue, size: 'look', max: 4 });
  assert.equal(ph[0].data, JPEG('thumb-blue-1'));
  assert.ok(!ph.some((p) => p.data === JPEG('thumb-chart')));
  assert.deepEqual(
    (await productPhotos(db, pid, { size: 'send', max: 2, kind: 'sizes' })).map((p) => p.data),
    [JPEG('chart')],
  );

  // a photo moved to the other colour, then first
  const blue1 = v.photos.find((p: any) => p.variantId === blue);
  v = await call('photos.update', preview, { id: blue1.id, variantId: red, position: 0 });
  assert.equal(v.photos.find((p: any) => p.id === blue1.id).variantId, red);
  ph = await productPhotos(db, pid, { variantId: red, size: 'send', max: 3 });
  assert.equal(ph[0].data, JPEG('blue-1'));
  v = await call('photos.update', preview, { id: blue1.id, variantId: blue });

  // Dellal on the server: the catalogue says « guide des tailles »; send_photos with sizes sends the chart
  asked.length = 0;
  let step = 0;
  brain = (req) => {
    step++;
    if (step === 1) {
      assert.match(req.system, new RegExp(`#${pid} Robe Lina : 5900 DA.* · photos · guide des tailles`));
      assert.match(req.system, /Taille : un produit marqué « guide des tailles »/);
      return { content: [{ type: 'tool_use', id: 'tu1', name: 'send_photos', input: { product_id: pid, sizes: true } }], stop_reason: 'tool_use' };
    }
    return { content: [{ type: 'text', text: 'Ha guide des tailles 👆 Chhal tlabssi d’habitude ?' }], stop_reason: 'end_turn' };
  };
  const c = Number((await db.query(`INSERT INTO conversations (channel, external_id) VALUES ('whatsapp', '213661000123') RETURNING id`))[0].id);
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body) VALUES ($1, 'customer', 'chhal men taille nakhod ?')`, [c]);
  await runAgent(server, c);
  const sent = asked.find((a) => a.action === 'photos')!.args;
  assert.equal(sent.photos.length, 1);
  assert.equal(sent.photos[0].data, JPEG('chart'));
  const m = (await db.query(`SELECT body FROM conv_messages WHERE conversation_id = $1 AND role = 'agent' AND meta ? 'photos'`, [c]))[0];
  assert.equal(m.body, '📷 Robe Lina — guide des tailles (1)');
  const kept = (await db.query(`SELECT meta FROM conv_messages WHERE conversation_id = $1 AND role = 'agent' AND meta ? 'photos'`, [c]))[0].meta.photos[0];
  assert.equal(kept.thumb, MINI('chart'));

  // the limits: 8 photos for one colour
  for (let i = 3; i <= 8; i++) await add(preview, { variantId: red, tag: `red-${i}` });
  await assert.rejects(add(preview, { variantId: red, tag: 'red-9' }), /8 photos au plus/);
  await assert.rejects(call('photos.add', preview, { productId: pid, variantId: null, kind: 'photo', data: Buffer.from('GIF89a'.padEnd(200, 'x')).toString('base64'), w: 10, h: 10, thumb: THUMB('x') }), /JPEG/);
  await db.query(`DELETE FROM product_photos`);
});

test('on the server: refused until the bucket is set; then each photo goes once to R2 (not kept here), and leaves it when removed', async () => {
  fakeR2();
  try {
    await assert.rejects(add(server, { variantId: red, tag: 'srv-1' }), /pas encore activé/);
    assert.equal(r2calls.length, 0);
    assert.equal((await saveStore(t.platform, R2)).configured, true);
    const st = await storeStatus(t.platform);
    assert.equal(st.secretSet, true);
    assert.equal((st as any).secret, undefined, 'the secret never goes back to the page');

    let v: any = await add(server, { variantId: red, tag: 'srv-1' });
    assert.equal(v.store, 'r2');
    assert.equal(r2calls.length, 1);
    const put = r2calls[0];
    assert.equal(put.method, 'PUT');
    assert.equal(put.type, 'image/jpeg');
    assert.equal(put.bytes, Buffer.from(JPEG('srv-1'), 'base64').length);
    const key = new URL(put.url).pathname.replace('/pilotix-photos/', '');
    assert.match(key, new RegExp(`^boutique/p${pid}/[a-f0-9]{24}\\.jpg$`));
    const row = (await db.query(`SELECT store, key, data FROM product_photos WHERE id = $1`, [v.photos[0].id]))[0];
    assert.deepEqual({ ...row }, { store: 'r2', key, data: null }, 'only its name in the bucket is kept here');

    // Dellal sends it: the server gives Meta a link to the bucket, valid for an hour
    const s1 = (await loadShop(t, { primary: true }))!;
    const ctx: any = { db, t, shop: { id: s1.id }, session: server.session, now: () => Date.now(), emit: () => {}, server: { ...hooks, publicApi: 'https://pilotix.online/api' } };
    await setRaw(db, 'secret_dellal_wa_token', 'EAAG-whatsapp-token');
    await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), whatsappPhoneId: '1122' });
    const [hd] = await productPhotos(db, pid, { variantId: red, size: 'send', max: 1 });
    assert.equal(hd.key, key);
    const calls: any[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return inner(url, init);
    }) as any;
    const r: any = await runDellal('photos', { channel: 'whatsapp', externalId: '213661000099', photos: [{ src: hd.src, mime: hd.mime, data: hd.data, url: hd.url, key: hd.key }] }, ctx);
    globalThis.fetch = inner;
    assert.equal(r.sent, 1, JSON.stringify(r));
    const body = JSON.parse(calls.find((c) => c.url.endsWith('/1122/messages')).init.body);
    assert.match(body.image.link, new RegExp(`^https://${R2.account}\\.r2\\.cloudflarestorage\\.com/pilotix-photos/${key.replace(/\./g, '\\.')}\\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Expires=3600&.*X-Amz-Signature=[0-9a-f]{64}$`));
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM dellal_photos`))[0].n, 0, 'nothing copied on the server');

    // removed: it leaves the bucket at once
    r2calls.length = 0;
    v = await call('photos.remove', server, { id: v.photos[0].id });
    assert.equal(v.photos.length, 0);
    assert.deepEqual(
      r2calls.map((c) => [c.method, new URL(c.url).pathname]),
      [['DELETE', `/pilotix-photos/${key}`]],
    );
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM product_photo_trash`))[0].n, 0);

    // a deleted product: its photos' files leave the bucket the next time the photos are opened
    await add(server, { variantId: null, tag: 'srv-2' });
    const k2 = String((await db.query(`SELECT key FROM product_photos`))[0].key);
    const other = Number((await db.query(`INSERT INTO products (name, sku, price) VALUES ('Sac', 'SC-1', 3000) RETURNING id`))[0].id);
    await db.query(`DELETE FROM products WHERE id = $1`, [pid]);
    assert.equal((await db.query(`SELECT key FROM product_photo_trash`))[0]?.key, k2);
    r2calls.length = 0;
    await call('photos.list', server, { productId: other });
    assert.deepEqual(
      r2calls.map((c) => [c.method, new URL(c.url).pathname]),
      [['DELETE', `/pilotix-photos/${k2}`]],
    );
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM product_photo_trash`))[0].n, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('one upload feeds the screens: a line’s first photo is its picture, the product’s first photo its main picture', async () => {
  const SMALL = (tag: string) => `data:image/webp;base64,${Buffer.from(`small-${tag}`.padEnd(60, 'x')).toString('base64')}`;
  const made: any = await call('catalog.saveProduct', preview, { name: 'Vélo Star', sku: 'VS-1', price: 9500, cost: 7500, variants: [{ title: '12P / Noir' }, { title: '12P / Rouge' }, { title: '12P / Bleu' }] });
  const p2 = made.id as number;
  const [black, redLine, blueLine] = ['12P / Noir', '12P / Rouge', '12P / Bleu'].map((title) => made.variants.find((v: any) => v.title === title).id as number);
  // pictures from before (the old « Image » and per-line buttons): small ones, kept until a real photo replaces them
  await db.query(`UPDATE products SET photo = $2 WHERE id = $1`, [p2, SMALL('old-main')]);
  await db.query(`UPDATE product_variants SET photo = $2 WHERE id = $1`, [black, SMALL('old-black')]);
  await db.query(`UPDATE product_variants SET photo = $2 WHERE id = $1`, [blueLine, SMALL('old-blue')]);
  const put = (o: { variantId: number | null; tag: string; small?: boolean; kind?: 'photo' | 'sizes' }) =>
    call('photos.add', preview, { productId: p2, variantId: o.variantId, kind: o.kind ?? 'photo', data: JPEG(o.tag), w: 2048, h: 1536, thumb: THUMB(o.tag), mini: MINI(o.tag), ...(o.small ? { small: SMALL(o.tag) } : {}) }) as Promise<any>;
  const pics = async () => {
    const lines = new Map<number, string | null>((await db.query(`SELECT id, photo FROM product_variants WHERE product_id = $1`, [p2])).map((r: any) => [Number(r.id), r.photo]));
    return { product: (await db.query(`SELECT photo FROM products WHERE id = $1`, [p2]))[0].photo as string | null, black: lines.get(black), red: lines.get(redLine), blue: lines.get(blueLine) };
  };

  // the size chart is never a picture
  let v: any = await put({ variantId: null, tag: 'chart', kind: 'sizes' });
  assert.deepEqual(v.changed, { variants: {} });
  assert.equal((await pics()).product, SMALL('old-main'));

  // the product's first photo, for « 12P / Noir »: that line's picture and the main one (the page's lighter copy)
  v = await put({ variantId: black, tag: 'n1', small: true });
  assert.deepEqual(v.changed, { product: SMALL('n1'), variants: { [black]: SMALL('n1') } });
  assert.deepEqual(await pics(), { product: SMALL('n1'), black: SMALL('n1'), red: null, blue: SMALL('old-blue') });
  // Dellal sends the real photo, not its small copy too; a line that only has an old small picture still sends it
  const b64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);
  assert.deepEqual((await productPhotos(db, p2, { variantId: black, size: 'send', max: 5 })).map((p) => p.data), [JPEG('n1')]);
  assert.deepEqual((await productPhotos(db, p2, { variantId: blueLine, size: 'send', max: 5 })).map((p) => p.data), [b64(SMALL('old-blue'))]);
  assert.deepEqual((await productPhotos(db, p2, { size: 'send', max: 5 })).map((p) => p.data), [JPEG('n1'), b64(SMALL('old-blue'))]);
  // its landing pages: the main photo is that photo, sharp, once (tied to its line), not its small copy
  const set = (await productPhotoSets(db, [p2])).get(p2)!;
  assert.equal(set.hd?.thumb, THUMB('n1'));
  assert.deepEqual(
    followProduct([], set).add.map((a) => [a.key, a.v, a.hd ? 'hd' : a.url]),
    [
      ['m', black, 'hd'],
      [`v${blueLine}`, blueLine, SMALL('old-blue')],
    ],
  );

  // another photo of the same line changes nothing; another line's first photo is that line's (no lighter copy sent: its 320 px one)
  v = await put({ variantId: black, tag: 'n2', small: true });
  assert.deepEqual(v.changed, { variants: {} });
  v = await put({ variantId: redLine, tag: 'r1' });
  assert.deepEqual(v.changed, { variants: { [redLine]: THUMB('r1') } });
  assert.deepEqual(await pics(), { product: SMALL('n1'), black: SMALL('n1'), red: THUMB('r1'), blue: SMALL('old-blue') });
  await assert.rejects(call('photos.add', preview, { productId: p2, variantId: redLine, kind: 'photo', data: JPEG('bad'), w: 10, h: 10, thumb: THUMB('bad'), small: 'data:image/png;base64,' + 'A'.repeat(60) }), /Petite copie invalide/);

  // « Photo principale »: the red one goes first, it is the main picture
  const r1 = v.photos.find((p: any) => p.variantId === redLine);
  v = await call('photos.update', preview, { id: r1.id, position: 0 });
  assert.equal(v.photos.filter((p: any) => p.kind === 'photo')[0].id, r1.id);
  assert.deepEqual(v.changed, { product: THUMB('r1'), variants: {} });

  // moved to another line: its old line has no photo left, the new one has it first; and back
  v = await call('photos.update', preview, { id: r1.id, variantId: black });
  assert.deepEqual(v.changed, { variants: { [redLine]: null, [black]: THUMB('r1') } });
  v = await call('photos.update', preview, { id: r1.id, variantId: redLine });
  assert.deepEqual(v.changed, { variants: { [redLine]: THUMB('r1'), [black]: THUMB('n1') } });

  // the product form cannot change the pictures the photos feed (a page opened earlier sends what it knew);
  // a line without photo keeps the form's
  await call('catalog.saveProduct', preview, {
    id: p2,
    name: 'Vélo Star',
    price: 9500,
    cost: 7500,
    photo: SMALL('stale'),
    variants: [
      { id: black, title: '12P / Noir', photo: SMALL('stale') },
      { id: redLine, title: '12P / Rouge', photo: null },
      { id: blueLine, title: '12P / Bleu', photo: SMALL('new-blue') },
    ],
  });
  assert.deepEqual(await pics(), { product: THUMB('r1'), black: THUMB('n1'), red: THUMB('r1'), blue: SMALL('new-blue') });

  // removed: the main picture is the next photo's; a line left without photo loses its picture
  v = await call('photos.remove', preview, { id: r1.id });
  assert.deepEqual(v.changed, { product: THUMB('n1'), variants: { [redLine]: null } });
  const n1 = v.photos.find((p: any) => p.thumb === THUMB('n1'));
  v = await call('photos.remove', preview, { id: n1.id });
  assert.deepEqual(v.changed, { product: THUMB('n2'), variants: { [black]: THUMB('n2') } });
  // a photo of the whole product put first (Studio's poster does this): the main picture, no line's
  v = await call('photos.update', preview, { id: (await put({ variantId: null, tag: 'all' })).photos.find((p: any) => p.thumb === THUMB('all')).id, position: 0 });
  assert.deepEqual(v.changed, { product: THUMB('all'), variants: {} });
  // the last ones removed: no picture left, and the form sets them again
  for (const p of v.photos.filter((x: any) => x.kind === 'photo')) v = await call('photos.remove', preview, { id: p.id });
  assert.deepEqual(await pics(), { product: null, black: null, red: null, blue: SMALL('new-blue') });
  await call('catalog.saveProduct', preview, { id: p2, name: 'Vélo Star', price: 9500, cost: 7500, photo: SMALL('by-form'), variants: [{ id: black, title: '12P / Noir', photo: SMALL('by-form-black') }] });
  assert.deepEqual(await pics(), { product: SMALL('by-form'), black: SMALL('by-form-black'), red: null, blue: SMALL('new-blue') });
});
