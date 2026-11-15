// The pictures of a sales guide's answers (Guide de vente › a question or a hesitation › its images): added on a saved
// answer, kept like the product's HD photos but never among them, read with the guide (a small copy; the whole picture
// when the reader opens it), followed or removed by the guide's save, and sent by Dellal to the customer with the
// answer they belong to.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { getSetting, setSetting } from '../settings';
import { getRaw, setRaw } from '../modules/admin';
import { guidePhotos } from '../modules/dellalphotos';
import { guideText } from '../modules/guide';
import { EMAILS, setup } from './harness';

const JPEG = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-${tag}-`.padEnd(160, 'x'))]).toString('base64');
const THUMB = (tag: string) => `data:image/jpeg;base64,${JPEG(`thumb-${tag}`)}`;
const MINI = (tag: string) => `data:image/jpeg;base64,${JPEG(`mini-${tag}`)}`;

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let depot: Ctx, conf: Ctx, admin: Ctx;
let thermo: number, chair: number;

const GUIDE = {
  brief: 'Thermomètre sans contact, la température en une seconde.',
  faq: [
    { q: 'Il est de bonne qualité ?', a: 'Oui : garanti 12 mois et vendu en pharmacie.' },
    { q: 'Il marche avec des piles ?', a: 'Oui, 2 piles AAA fournies.' },
  ],
  doubts: [{ q: '« Ghali »', a: 'Il sert pour toute la famille, pendant des années.' }],
};
const QUALITY = GUIDE.faq[0].q;

before(async () => {
  ({ db, as } = await setup(30));
  depot = await as(EMAILS.depot);
  conf = await as(EMAILS.conf);
  admin = await as(EMAILS.admin);
  thermo = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-THE'`))[0].id);
  chair = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-CHA'`))[0].id);
  await call('catalog.saveGuide', depot, { id: thermo, guide: GUIDE });
});

const pic = (ctx: Ctx, part: 'faq' | 'doubts', q: string, tag: string, id = thermo) =>
  call('catalog.guidePhotoAdd', ctx, { id, part, q, data: JPEG(tag), w: 1200, h: 900, thumb: THUMB(tag), mini: MINI(tag) }) as Promise<any>;
const read = async (ctx: Ctx = depot) => (await call('catalog.guide', ctx, { id: thermo })) as any;
const rows = async () => (await db.query(`SELECT id FROM product_photos WHERE product_id = $1 AND kind = 'guide' ORDER BY id`, [thermo])).map((r: any) => Number(r.id));

test('a picture on an answer: written on it, read with the guide, never among the product’s photos', async () => {
  // the answer is found by its question, as saved (capitals and spaces aside)
  const p1 = await pic(depot, 'faq', '  il est de bonne QUALITÉ ?', 'q1');
  assert.equal(p1.thumb, MINI('q1'), 'the screens get the small copy');
  const p2 = await pic(depot, 'faq', QUALITY, 'q2');
  const d1 = await pic(depot, 'doubts', '« Ghali »', 'd1');
  const g = await read();
  assert.deepEqual(g.guide.faq[0].photos, [p1.id, p2.id]);
  assert.equal(g.guide.faq[1].photos, undefined, 'an answer without pictures is written as before');
  assert.deepEqual(g.guide.doubts[0].photos, [d1.id]);
  assert.deepEqual(g.pics, { [p1.id]: MINI('q1'), [p2.id]: MINI('q2'), [d1.id]: MINI('d1') });
  // the product form reads them too
  const form: any = await call('catalog.product', depot, { id: thermo });
  assert.deepEqual(form.guide.faq[0].photos, [p1.id, p2.id]);
  assert.equal(form.guidePics[p2.id], MINI('q2'));

  // kept like an HD photo (the preview keeps the file itself), under its own kind: the Photos box never shows it
  const row = (await db.query(`SELECT kind, store, variant_id, data, bytes FROM product_photos WHERE id = $1`, [p1.id]))[0];
  assert.deepEqual({ ...row, bytes: Number(row.bytes) }, { kind: 'guide', store: 'local', variant_id: null, data: JPEG('q1'), bytes: Buffer.from(JPEG('q1'), 'base64').length });
  const box: any = await call('photos.list', depot, { productId: thermo });
  assert.equal(box.photos.length, 0);
  assert.equal(box.bytes, 0);
  await assert.rejects(call('photos.remove', depot, { id: p1.id }), /introuvable/);
  await assert.rejects(call('photos.update', depot, { id: p1.id, kind: 'photo' }), /introuvable/);
  assert.equal((await db.query(`SELECT photo FROM products WHERE id = $1`, [thermo]))[0].photo, form.photo, 'the product’s own picture did not move');

  // the reader opens it whole
  const whole: any = await call('catalog.guidePhoto', depot, { id: p1.id });
  assert.equal(whole.src, `data:image/jpeg;base64,${JPEG('q1')}`);
  assert.deepEqual([whole.w, whole.h], [1200, 900]);
  await assert.rejects(call('catalog.guidePhoto', depot, { id: 987654 }), /introuvable/);

  // refused: a question the saved guide does not have, something that is not a JPEG, a seventh picture on one answer
  await assert.rejects(pic(depot, 'faq', 'Il est livré quand ?', 'x'), /pas dans le guide enregistré/);
  await assert.rejects(pic(depot, 'doubts', QUALITY, 'x'), /pas dans le guide enregistré/, 'a question’s picture is not a hesitation’s');
  await assert.rejects(call('catalog.guidePhotoAdd', depot, { id: thermo, part: 'faq', q: QUALITY, data: Buffer.from('GIF89a'.padEnd(200, 'x')).toString('base64'), w: 10, h: 10, thumb: THUMB('x') }), /JPEG/);
  for (let k = 3; k <= 6; k++) await pic(depot, 'faq', QUALITY, `q${k}`);
  await assert.rejects(pic(depot, 'faq', QUALITY, 'q7'), /6 images au plus pour une réponse/);
  assert.equal((await rows()).length, 7, 'nothing kept of what was refused');
});

test('only the guide’s writers add a picture; an agent opens the pictures of their products’ guides only', async () => {
  await assert.rejects(pic(conf, 'faq', QUALITY, 'agent'), /agences de confirmation/);
  const give = async (products: number[]) => {
    const config = await getSetting(db, 'autoAssign');
    config.agents[String(conf.session.profile.id)] = { ...config.agents[String(conf.session.profile.id)], products } as any;
    await setSetting(db, 'autoAssign', config);
  };
  const [first] = await rows();
  await give([chair]);
  await assert.rejects(call('catalog.guidePhoto', conf, { id: first }), /pas confié/);
  await give([thermo]);
  assert.match(((await call('catalog.guidePhoto', conf, { id: first })) as any).src, /^data:image\/jpeg;base64,/);
  assert.equal((await read(conf)).pics[first], MINI('q1'));
});

test('what the AI agents read: the pictures of an answer are named only to the one that sends them', async () => {
  const g = await read();
  const ids = g.guide.faq[0].photos;
  assert.doesNotMatch(guideText(g.guide), /guide_images/, 'CM AI and the planner read the words only');
  const forDellal = guideText(g.guide, [], { pics: true });
  assert.ok(forDellal.includes(`- ${QUALITY} → Oui : garanti 12 mois et vendu en pharmacie. [images de cette réponse : guide_images ${JSON.stringify(ids)}]`));
  assert.ok(forDellal.includes(`- Il marche avec des piles ? → Oui, 2 piles AAA fournies.\n`), 'an answer without pictures reads as before');
  assert.match(forDellal, /« Ghali » → Il sert pour toute la famille, pendant des années\. \[images de cette réponse : guide_images \[\d+\]\]/);
  // ready to be sent, in the answer's order
  const ph = await guidePhotos(db, thermo, [ids[1], ids[0], 987654]);
  assert.deepEqual(
    ph.map((p) => [p.src, p.data, p.thumb]),
    [
      [`hd:${ids[1]}`, JPEG('q2'), MINI('q2')],
      [`hd:${ids[0]}`, JPEG('q1'), MINI('q1')],
    ],
  );
  assert.deepEqual(await guidePhotos(db, chair, ids), [], 'another product’s guide never sends them');
});

test('Dellal: it sends an answer’s pictures with the answer, once a day, and only the ones the guide names', async () => {
  const g = await read();
  const ids: number[] = g.guide.faq[0].photos;
  const seen: any = {};
  const page = async (req: any) => {
    if (!req.tools.length) return { content: [{ type: 'text' as const, text: String(req.messages[0].content).match(/«\n([\s\S]*?)\n»/)?.[1] ?? '' }], stop_reason: 'end_turn' };
    seen.system = req.system;
    seen.tool = req.tools.find((x: any) => x.name === 'send_photos');
    seen.guide = await req.runTool('product_guide', { product_id: thermo });
    seen.sent = await req.runTool('send_photos', { product_id: thermo, guide_images: ids.slice(0, 2) });
    seen.again = await req.runTool('send_photos', { product_id: thermo, guide_images: [ids[2], 987654] });
    seen.wrong = await req.runTool('send_photos', { product_id: chair, guide_images: ids });
    return { content: [{ type: 'text' as const, text: 'Ih, garantie 12 chhar w yetba3 f les pharmacies 👆' }], stop_reason: 'end_turn' };
  };
  const inPage = { ...(await as(EMAILS.admin)), dellalAi: page };
  await call('dellal.test', inPage, { reset: true });
  let r: any = await call('dellal.test', inPage, { body: 'le thermomètre sans contact mli7 ? qualité ta3ou ?' });
  assert.match(seen.system, /Une réponse du guide suivie de « images de cette réponse »/);
  assert.ok(seen.tool.input_schema.properties.guide_images);
  assert.match(seen.guide.guide, /guide_images \[/);
  assert.match(seen.guide.images, /send_photos/);
  assert.deepEqual([seen.sent.ok, seen.sent.sent, seen.sent.of], [true, 2, 'Thermomètre frontal — guide']);
  assert.match(seen.sent.note, /réponse du guide/);
  assert.equal(seen.again.sent, 1, 'a number the guide does not name is left out');
  assert.match(seen.wrong.error, /pas \(ou plus\) dans le guide de ce produit/);
  // they left before the words, with their small copies kept in the chat
  const out = r.messages.filter((m: any) => m.role === 'agent');
  assert.equal(out[out.length - 2].body, '📷 Thermomètre frontal — guide (3)');
  assert.deepEqual(
    out[out.length - 2].meta.photos.map((p: any) => [p.src, p.thumb]),
    [
      [`hd:${ids[0]}`, MINI('q1')],
      [`hd:${ids[1]}`, MINI('q2')],
      [`hd:${ids[2]}`, MINI('q3')],
    ],
  );
  assert.match(out[out.length - 1].body, /garantie 12 chhar/);
  const lines = r.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.body);
  assert.ok(lines.includes(`send_photos #${thermo} → 2 image(s) du guide envoyée(s)`), lines.join(' | '));

  // the same question again that day: the answer, not the same pictures
  r = await call('dellal.test', inPage, { body: 'w la qualité ?' });
  assert.equal(seen.sent.already, true);
  assert.match(seen.sent.note, /sans les renvoyer/);
  assert.equal(r.messages.filter((m: any) => m.meta?.photos).length, 1);

  // a shop that sends no photo in the chat: the guide says nothing of its pictures, and none leaves
  const dellal = await getRaw<Record<string, unknown>>(db, 'dellal', {});
  await setRaw(db, 'dellal', { ...dellal, photos: false }, admin.session.profile.id);
  await call('dellal.test', inPage, { reset: true });
  await call('dellal.test', inPage, { body: 'le thermomètre sans contact mli7 ?' });
  assert.doesNotMatch(seen.system, /images de cette réponse/);
  assert.doesNotMatch(seen.guide.guide, /guide_images/);
  assert.equal(seen.guide.images, undefined);
  assert.match(seen.sent.error, /n’envoie pas de photos/);
  await setRaw(db, 'dellal', dellal, admin.session.profile.id);
});

test('Dellal without AI (preview): the pictures of the answer leave first, then its words', async () => {
  const conf2 = await as(EMAILS.conf2);
  await call('dellal.test', conf2, { reset: true });
  const r: any = await call('dellal.test', conf2, { body: 'Salam, le thermomètre frontal sans contact : il est de bonne qualité ?' });
  const bodies = r.messages.map((m: any) => `${m.role}: ${m.body}`);
  const at = (re: RegExp) => bodies.findIndex((b: string) => re.test(b));
  assert.ok(at(/^tool: product_guide #\d+ → guide de vente lu/) >= 0, bodies.join('\n'));
  assert.ok(at(/^tool: send_photos #\d+ → \d image\(s\) du guide envoyée\(s\)/) > at(/^tool: product_guide/), bodies.join('\n'));
  assert.ok(at(/^agent: 📷 Thermomètre frontal — guide \(6\)/) >= 0, bodies.join('\n'));
  assert.ok(at(/^agent: Oui : garanti 12 mois/) > at(/^agent: 📷/), 'the words come after the pictures');
  // an answer without pictures: its words only
  const r2: any = await call('dellal.test', conf2, { body: 'et la garantie ? il marche avec des piles ?' });
  assert.match(r2.messages.filter((m: any) => m.role === 'agent').pop().body, /2 piles AAA/);
  assert.equal(r2.messages.filter((m: any) => m.meta?.photos).length, 1);
});

test('the guide’s save: pictures follow their answer, and leave when it lets them go', async () => {
  const before = await read();
  const ids: number[] = before.guide.faq[0].photos;
  const [ghali] = before.guide.doubts[0].photos;
  const save = async (guide: any, ctx: Ctx = depot) => (await call('catalog.saveGuide', ctx, { id: thermo, guide })) as any;

  // a page opened before pictures existed (it says nothing of them): every answer keeps its own
  let s = await save(GUIDE);
  assert.deepEqual(s.guide.faq[0].photos, ids);
  assert.deepEqual(s.guide.doubts[0].photos, [ghali]);
  assert.equal(s.pics[ids[0]], MINI('q1'));
  assert.equal((await rows()).length, 7);

  // the question reworded, its pictures said: they stay on it; one taken off: it is removed
  s = await save({ ...GUIDE, faq: [{ q: 'La qualité est bonne ?', a: GUIDE.faq[0].a, photos: ids.slice(1) }, GUIDE.faq[1]], doubts: [{ ...GUIDE.doubts[0], photos: [ghali] }] });
  assert.deepEqual(s.guide.faq[0].photos, ids.slice(1));
  assert.deepEqual(await rows(), [...ids.slice(1), ghali].sort((a, b) => a - b));
  assert.equal(s.pics[ids[0]], undefined);

  // a number from nowhere is dropped, and a picture belongs to one answer
  const other = await pic(depot, 'faq', 'Chaise', 'other', chair).catch(() => null);
  assert.equal(other, null, 'the chair’s guide has no such question');
  s = await save({ ...GUIDE, faq: [{ q: 'La qualité est bonne ?', a: GUIDE.faq[0].a, photos: [ids[1], 987654, ghali] }, { ...GUIDE.faq[1], photos: [ids[1]] }], doubts: [{ ...GUIDE.doubts[0], photos: [ghali] }] });
  assert.deepEqual(s.guide.faq[0].photos, [ids[1], ghali]);
  assert.equal(s.guide.faq[1].photos, undefined);
  assert.equal(s.guide.doubts[0].photos, undefined);
  assert.deepEqual(await rows(), [ids[1], ghali].sort((a, b) => a - b), 'the pictures no answer names any more are removed');

  // the same guide again: nothing moves, not even its date
  const at = String((await db.query('SELECT updated_at FROM product_guides WHERE product_id = $1', [thermo]))[0].updated_at);
  await new Promise((r) => setTimeout(r, 20));
  await save(s.guide, admin);
  assert.equal(String((await db.query('SELECT updated_at FROM product_guides WHERE product_id = $1', [thermo]))[0].updated_at), at);

  // the product form saves the guide the same way: an answer removed takes its pictures with it
  const p: any = await call('catalog.product', depot, { id: thermo });
  await call('catalog.saveProduct', depot, { id: p.id, name: p.name, price: p.price, cost: p.cost, maxDiscount: p.maxDiscount, guide: { ...GUIDE, faq: [GUIDE.faq[1]], doubts: [{ ...GUIDE.doubts[0], photos: [] }] } });
  assert.deepEqual(await rows(), []);
  assert.deepEqual((await read()).pics, {});

  // the guide emptied: its pictures go with it
  await save(GUIDE);
  await pic(depot, 'faq', QUALITY, 'last');
  assert.equal((await rows()).length, 1);
  await save({ brief: '' });
  assert.equal((await read()).guide, null);
  assert.deepEqual(await rows(), []);
});
