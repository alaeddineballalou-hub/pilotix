// « Écrire avec l'IA » next to a landing page's title: Claude's titles are checked before they are shown (no invented
// number, no price, no fake urgency, no delivery talk, Arabic letters, Dellal's Darija check), the ones already shown
// never come back, and the preview without Claude gives example titles from the product's name.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { noSafeTitle, readTitles, retryQuestion, rulesTitles, tidyTitle, TITLE_PROMPT, titleKey, titleProblem } from '../modules/landingtitle';
import { rightsNeeded } from '../modules/rights';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
let productId: number;
let productName: string;

before(async () => {
  const s = await setup(50);
  db = s.db;
  as = s.as;
  const p = (await db.query(`SELECT id, name FROM products WHERE sku = 'PX-POU'`))[0];
  productId = Number(p.id);
  productName = String(p.name);
});

const facts = (allow: string, price: number | null = 12900, oldPrice: number | null = null) => ({ allow, price, oldPrice });
const POINTS = `- وزن خفيف: 6 كغ فقط، سهلة الحمل في الحافلة والسيارة
- طي سريع بيد واحدة في ثانيتين
✅ ضمان 6 أشهر`;

test('a title is tidied: no quotes, hashtags or long dashes, at most 2 emojis', () => {
  assert.equal(tidyTitle('« عربة أطفال خفيفة » — تتطوى بيد وحدة #بيبي'), 'عربة أطفال خفيفة تتطوى بيد وحدة');
  assert.equal(tidyTitle('عربة أطفال 👶 خفيفة ✨ تتطوى 🚗 بيد وحدة.'), 'عربة أطفال 👶 خفيفة ✨ تتطوى بيد وحدة');
  assert.equal(titleKey('عربة أطفال 👶 خفيفة'), titleKey('عربة  أطفال خفيفة ✨'));
});

test('a title the shop’s words do not back is refused', () => {
  const f = facts(`عربة أطفال\n${POINTS}`);
  assert.equal(titleProblem('عربة أطفال خفيفة 6 كغ 👶 تتطوى بيد وحدة', f), null);
  assert.equal(titleProblem('عربة أطفال خفيفة 8 كغ 👶 تتطوى بيد وحدة', f), 'chiffre inventé');
  assert.equal(titleProblem('عربة أطفال بـ 12 900 👶 خفيفة وتتطوى', f), 'prix');
  assert.equal(titleProblem('عربة أطفال خفيفة 👶 بتخفيض -30%', f), 'prix');
  assert.equal(titleProblem('عربة أطفال خفيفة 👶 والتوصيل لباب الدار', f), 'livraison');
  assert.equal(titleProblem('كمية محدودة من عربة الأطفال الخفيفة 👶', f), 'urgence');
  assert.equal(titleProblem('عربة أطفال أصلية 👶 خفيفة وتتطوى بيد وحدة', f), 'original');
  assert.equal(titleProblem('Poussette légère pliable 👶 top qualité', f), 'pas en lettres arabes');
  assert.equal(titleProblem('عربة الأطفال دابا عندنا 👶 خفيفة وتتطوى', f), 'darija');
  assert.equal(titleProblem('عربة 👶', f), 'trop court');
  assert.equal(titleProblem(`عربة أطفال خفيفة ${'بزاف '.repeat(14)}👶`, f), 'trop long');
  // the shop wrote its guarantee: a title may say it; another shop's page without it may not
  assert.equal(titleProblem('عربة أطفال خفيفة بضمان 6 أشهر 👶', f), null);
  assert.equal(titleProblem('عربة أطفال خفيفة بضمان 6 أشهر 👶', facts('عربة أطفال خفيفة 6 كغ')), 'garantie');
  // a word the shop’s Darija lessons forbid
  assert.equal(titleProblem('كرسي الطوموبيل للأطفال 🚗 أمان وراحة', facts('كرسي'), [{ term: 'الطوموبيل', use: 'السيارة' }]), 'darija');
  assert.equal(titleProblem('كرسي الطوموبيل للأطفال 🚗 أمان وراحة', facts('كرسي')), null);
});

test('Claude’s answer: the safe titles in its order, never one already shown', () => {
  const f = facts(`عربة أطفال\n${POINTS}`);
  const answer = '```json\n{"titles": ["عربة أطفال خفيفة 6 كغ 👶 تتطوى بيد وحدة", "كمية محدودة من عربة الأطفال 👶", "ما تبقاوش تهزو عربة ثقيلة 👶 هادي غير 6 كغ", "خرجات البيبي ولاو ساهلين 👶 مع عربة تتطوى بيد وحدة"]}\n```';
  const r = readTitles(answer, f, { avoid: ['خرجات البيبي ولاو ساهلين ✨ مع عربة تتطوى بيد وحدة'] });
  assert.deepEqual(r.titles, ['عربة أطفال خفيفة 6 كغ 👶 تتطوى بيد وحدة', 'ما تبقاوش تهزو عربة ثقيلة 👶 هادي غير 6 كغ']);
  assert.deepEqual(
    r.refused.map((x) => x.why),
    ['urgence', 'déjà proposé'],
  );
  assert.deepEqual(readTitles('pas de JSON ici', f).titles, []);
  assert.deepEqual(readTitles('{"title": "عربة أطفال خفيفة 6 كغ 👶 تتطوى بيد وحدة"}', f).titles, ['عربة أطفال خفيفة 6 كغ 👶 تتطوى بيد وحدة']);
});

test('the button needs the right to edit landing pages', () => {
  assert.deepEqual(rightsNeeded('landing.aiTitle', {}, {} as Ctx), [['page:landing'], ['act:landing.edit']]);
});

test('the preview without Claude: example titles from the product’s name, a new one after those shown', async () => {
  const mk = await as(EMAILS.marketer);
  const r: any = await call('landing.aiTitle', mk, { productId });
  assert.equal(r.by, 'rules');
  assert.equal(r.titles.length, 3);
  for (const x of r.titles) assert.ok(x.startsWith(tidyTitle(productName).slice(0, 40)), x);
  const again: any = await call('landing.aiTitle', mk, { productId, avoid: r.titles.slice(0, 2) });
  assert.deepEqual(again.titles, [r.titles[2]]);
  assert.deepEqual(rulesTitles('Siège auto bébé').map((x) => x.includes('🚗')), [true, true, false]);
  await assert.rejects(call('landing.aiTitle', mk, { productId: 999999 }), /Produit introuvable/);
});

test('with Claude: the instructions, the page as typed, the titles already shown; only safe titles come back', async () => {
  const reqs: any[] = [];
  const page = async (req: any) => {
    reqs.push(req);
    return { content: [{ type: 'text' as const, text: '{"titles": ["عربة أطفال خفيفة 9 كغ 👶 تتطوى بيد وحدة", "عربة أطفال خفيفة 6 كغ 👶 تتطوى بيد وحدة", "عربة البيبي تتطوى في ثانيتين 👶 وتهزها بيد وحدة"]}' }], stop_reason: 'end_turn' };
  };
  const mk = { ...(await as(EMAILS.marketer)), dellalAi: page } as Ctx;
  const r: any = await call('landing.aiTitle', mk, { productId, title: 'عربة أطفال', description: POINTS, price: 12900, oldPrice: 15900, avoid: ['عربة خفيفة ليك ولولادك 👶'] });
  assert.equal(r.by, 'ai');
  assert.deepEqual(r.titles, ['عربة أطفال خفيفة 6 كغ 👶 تتطوى بيد وحدة', 'عربة البيبي تتطوى في ثانيتين 👶 وتهزها بيد وحدة']);
  const req = reqs[0];
  assert.ok(req.system.startsWith(TITLE_PROMPT.slice(0, 60)));
  assert.match(req.system, /RÈGLES DE DARIJA DE PILOTIX/);
  assert.equal(req.tools.length, 0);
  const q = String(req.messages[0].content);
  assert.match(q, /Écris 3 titres/);
  assert.match(q, /طي سريع بيد واحدة/);
  assert.match(q, /Titre actuel de la page : عربة أطفال/);
  assert.match(q, /pour le ton seulement/);
  assert.match(q, /Déjà proposés[\s\S]*- عربة خفيفة ليك ولولادك 👶[\s\S]*- عربة أطفال$/);
  // nothing safe in Claude's answer: an error to click again, never an unchecked title
  const bad = { ...mk, dellalAi: async () => ({ content: [{ type: 'text' as const, text: '{"titles": ["كمية محدودة من العربة 👶 سارع"]}' }], stop_reason: 'end_turn' }) } as Ctx;
  await assert.rejects(call('landing.aiTitle', bad, { productId }), /pas donné de titre sûr/);
});

test('« طبيعي » (natural) is not a health word; « طبي » (medical) is', () => {
  assert.equal(titleProblem('كرسي أطفال للسيارة 🚗 أمان طبيعي لصغارك', facts('كرسي')), null);
  assert.equal(titleProblem('كرسي طبي للأطفال 🚗 راحة لصغارك', facts('كرسي')), 'santé');
  assert.equal(titleProblem('كرسي الأطفال الطبية 🚗 راحة لصغارك', facts('كرسي')), 'santé');
});

test('every title refused: Claude is told why and writes 3 more (once); still none: the seller is told why', async () => {
  const seat = 'مقعد جلوس للاطفال سيارة';
  const invented = '{"titles": ["كرسي السيارة للأطفال 🚗 من 0 حتى 4 سنين", "كرسي السيارة 🚗 لولادك حتى 18 كغ"]}';
  const good = '{"titles": ["كرسي السيارة لولادك 🚗 سوق وانت مرتاح البال"]}';
  const reqs: any[] = [];
  const answers = [invented, good];
  const mk = await as(EMAILS.marketer);
  const second = {
    ...mk,
    dellalAi: async (req: any) => {
      reqs.push({ ...req, messages: [...req.messages] });
      return { content: [{ type: 'text' as const, text: answers[reqs.length - 1] ?? good }], stop_reason: 'end_turn' };
    },
  } as Ctx;
  const r: any = await call('landing.aiTitle', second, { productId, title: seat });
  assert.deepEqual(r.titles, ['كرسي السيارة لولادك 🚗 سوق وانت مرتاح البال']);
  assert.equal(reqs.length, 2);
  // the second question: Claude's first answer, then each refused title and why (the numbers the page does not give)
  const [, again] = reqs;
  assert.equal(again.messages[1].role, 'assistant');
  assert.equal(again.messages[1].content, invented);
  const told = String(again.messages[2].content);
  assert.match(told, /Pilotix a refusé ces titres/);
  assert.match(told, /من 0 حتى 4 سنين » : un chiffre que les informations ne donnent pas[^\n]*\(ici : 0, 4\)/);
  assert.match(told, /\(ici : 18\)/);
  // both answers refused: the error says why and what to do
  const never = { ...mk, dellalAi: async () => ({ content: [{ type: 'text' as const, text: invented }], stop_reason: 'end_turn' }) } as Ctx;
  await assert.rejects(call('landing.aiTitle', never, { productId, title: seat }), /pas donné de titre sûr : ses titres avaient des chiffres que la page ne donne pas/);
  // not JSON: Claude is asked for the JSON; an unknown reason keeps the general message
  assert.match(retryQuestion([], facts('كرسي')), /UNIQUEMENT avec \{"titles"/);
  assert.match(noSafeTitle([{ why: 'urgence' }]), /recliquez pour réessayer/);
});
