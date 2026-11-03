// The sales guide of a product (Produits & stock › a product › Guide de vente): saved with the product form, read by the
// agents within their products (a « Guide » button during the call), used by Dellal (its product_guide tool) and CM AI,
// and drafted by « Écrire avec l'IA » without inventing facts.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, makeSession, ServerHooks } from '../index';
import { getSetting, setSetting } from '../settings';
import { guideText, TO_FILL } from '../modules/guide';
import { draftSystem, readDraft, rulesDraft } from '../modules/guidedraft';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let depot: Ctx, conf: Ctx, admin: Ctx;
let chair: number, thermo: number;

before(async () => {
  ({ db, as } = await setup(30));
  depot = await as(EMAILS.depot);
  conf = await as(EMAILS.conf);
  admin = await as(EMAILS.admin);
  chair = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-CHA'`))[0].id);
  thermo = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-THE'`))[0].id);
});

const GUIDE = {
  brief: '  Thermomètre sans contact, la température en une seconde.  ',
  strengths: ['Sans contact : bébé ne se réveille pas', '', 'Mesure en 1 seconde'],
  faq: [{ q: 'Il marche avec des piles ?', a: 'Oui, 2 piles AAA fournies.' }, { q: 'Garantie ?', a: TO_FILL }, { q: '', a: 'perdue' }],
  doubts: [{ q: '« Ghali »', a: 'Il sert pour toute la famille.' }],
  upsell: '',
  never: ['Qu’il remplace le médecin.'],
};

test('the demo shop: five products have a guide, flagged in the lists, the form reads it', async () => {
  const list: any[] = await call('catalog.products', depot, {});
  assert.equal(list.filter((p) => p.hasGuide).length, 5);
  assert.equal(list.find((p) => p.id === chair).hasGuide, true);
  assert.equal(list.find((p) => p.id === thermo).hasGuide, false);
  const one: any = await call('catalog.product', depot, { id: chair });
  assert.match(one.guide.brief, /6 mois/);
  assert.ok(one.guide.faq.some((p: any) => p.a === TO_FILL), 'an answer still to write stays visible to the team');
  assert.ok(one.guideAt && one.guideBy);
  const none: any = await call('catalog.product', depot, { id: thermo });
  assert.equal(none.guide, null);
});

test('saved with the product form: cleaned, the same guide keeps its date, an empty one is removed, too long refused', async () => {
  const p: any = await call('catalog.product', depot, { id: thermo });
  const base = { id: p.id, name: p.name, price: p.price, cost: p.cost, maxDiscount: p.maxDiscount };
  const saved: any = await call('catalog.saveProduct', depot, { ...base, guide: GUIDE });
  assert.equal(saved.hasGuide, true);
  const g: any = (await call('catalog.product', depot, { id: thermo })).guide;
  assert.equal(g.brief, 'Thermomètre sans contact, la température en une seconde.');
  assert.deepEqual(g.strengths, ['Sans contact : bébé ne se réveille pas', 'Mesure en 1 seconde']);
  assert.equal(g.faq.length, 2, 'a pair without a question is dropped');
  const at = (await db.query('SELECT updated_at FROM product_guides WHERE product_id = $1', [thermo]))[0].updated_at;
  await new Promise((r) => setTimeout(r, 20));
  await call('catalog.saveProduct', admin, { ...base, guide: GUIDE });
  const again = await db.query('SELECT updated_at, updated_by FROM product_guides WHERE product_id = $1', [thermo]);
  assert.equal(String(again[0].updated_at), String(at), 'nothing changed: not even who wrote it');
  assert.equal(Number(again[0].updated_by), depot.session.profile.id);
  // saving the product without the guide field leaves the guide alone
  await call('catalog.saveProduct', depot, { ...base, price: p.price });
  assert.ok((await call('catalog.product', depot, { id: thermo }) as any).guide);
  // too long in all (each part within its own size)
  const long = { ...GUIDE, faq: Array.from({ length: 20 }, (_, k) => ({ q: `Question ${k} ${'q'.repeat(150)}`, a: 'r'.repeat(600) })) };
  await assert.rejects(call('catalog.saveProduct', depot, { ...base, guide: long }), /trop long/);
  // emptied: removed
  const cleared: any = await call('catalog.saveProduct', depot, { ...base, guide: { brief: '', strengths: [], faq: [], doubts: [], upsell: '', never: [] } });
  assert.equal(cleared.hasGuide, false);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM product_guides WHERE product_id = $1', [thermo]))[0].n, 0);
  // only the depot side writes it
  await assert.rejects(call('catalog.saveProduct', conf, { ...base, guide: GUIDE }), /Accès refusé/);
});

test('agents read the guide of their products only, and the call screen knows which products have one', async () => {
  const give = async (products: number[]) => {
    const config = await getSetting(db, 'autoAssign');
    config.agents[String(conf.session.profile.id)] = { ...config.agents[String(conf.session.profile.id)], products } as any;
    await setSetting(db, 'autoAssign', config);
  };
  await give([thermo]);
  await assert.rejects(call('catalog.guide', conf, { id: chair }), /pas confié/);
  await give([chair]);
  const r: any = await call('catalog.guide', conf, { id: chair });
  assert.equal(r.name, 'Chaise haute évolutive');
  assert.match(r.guide.faq[0].a, /6 mois/);
  assert.ok(r.updatedBy);
  const cat: any[] = await call('confirmation.catalog', conf, {});
  assert.deepEqual(cat.map((p) => [p.id, p.hasGuide]), [[chair, true]]);
  const assigned: any = await call('catalog.assigned', conf, {});
  assert.equal(assigned.rows[0].hasGuide, true);
  await assert.rejects(call('catalog.guide', await as(EMAILS.livreur), { id: chair }), /Accès refusé/);
  await assert.rejects(call('catalog.guide', await as(EMAILS.marketer), { id: chair }), /Accès refusé|pas confié/);
  assert.equal((await call('catalog.guide', depot, { id: thermo }) as any).guide, null);
});

test('what the AI agents read: the guide in its own words, never an answer still to write', () => {
  const text = guideText({ brief: 'B', strengths: ['S1', TO_FILL], faq: [{ q: 'Q1', a: 'A1' }, { q: 'Q2', a: TO_FILL }], doubts: [{ q: '« Ghali »', a: 'D1' }], upsell: '', upsellIds: [], never: ['N1'], sizes: [] });
  assert.match(text, /EN BREF : B/);
  assert.match(text, /- Q1 → A1/);
  assert.match(text, /- « Ghali » → D1/);
  assert.match(text, /À NE JAMAIS PROMETTRE NI DIRE :\n- N1/);
  assert.doesNotMatch(text, /Q2|compléter|VENTE EN PLUS/);
});

test('Dellal: the catalog marks the products with a guide, and product_guide reads it before answering', async () => {
  const reqs: any[] = [];
  const page = async (req: any) => {
    reqs.push(req);
    if (!req.tools.length) return { content: [{ type: 'text' as const, text: String(req.messages[0].content).match(/«\n([\s\S]*?)\n»/)?.[1] ?? '' }], stop_reason: 'end_turn' };
    const g = await req.runTool('product_guide', { product_id: chair });
    const none = await req.runTool('product_guide', { product_id: thermo });
    assert.match(g.guide, /HÉSITATIONS/);
    assert.doesNotMatch(g.guide, /compléter/);
    assert.match(none.error, /Pas de guide/);
    return { content: [{ type: 'text' as const, text: 'Tsla7 men 6 chhour 7ta 3 snin.' }], stop_reason: 'end_turn' };
  };
  const inPage = { ...(await as(EMAILS.admin)), dellalAi: page };
  await call('dellal.test', inPage, { reset: true });
  const r: any = await call('dellal.test', inPage, { body: 'la chaise haute tsla7 men 9eddach ?' });
  assert.match(reqs[0].system, /#\d+ Chaise haute évolutive : 8900 DA.* · guide/);
  assert.match(reqs[0].system, /Guides de vente : un produit marqué « guide »/);
  assert.ok(reqs[0].tools.some((x: any) => x.name === 'product_guide'));
  const lines = r.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.body);
  assert.ok(lines.includes(`product_guide #${chair} → guide de vente lu`));
});

test('Dellal without AI (preview): a question about the product is answered from its guide', async () => {
  const conf2 = await as(EMAILS.conf2);
  await call('dellal.test', conf2, { reset: true });
  const r: any = await call('dellal.test', conf2, { body: 'Salam, la chaise haute évolutive fiha ceinture ? w l age ?' });
  const bodies = r.messages.map((m: any) => `${m.role}: ${m.body}`).join('\n');
  assert.match(bodies, new RegExp(`tool: product_guide #${chair} → guide de vente lu`));
  assert.match(bodies, /agent: .*(harnais 5 points|6 mois)/);
  const r2: any = await call('dellal.test', conf2, { body: 'ghali bezzaf' });
  assert.match(r2.messages.filter((m: any) => m.role === 'agent').pop().body, /trois achats/);
  // a price question still goes to the catalog
  const r3: any = await call('dellal.test', conf2, { body: 'ch7al la chaise haute évolutive ?' });
  assert.match(r3.messages.filter((m: any) => m.role === 'agent').pop().body, /8900 DA/);
});

test('CM AI: the guide of the comment\'s product is in its instructions', async () => {
  const seen: string[] = [];
  const page = async (req: any) => {
    seen.push(req.system);
    return { content: [{ type: 'text' as const, text: '{"intent":"question","hide":false,"public_reply":"Jawbnakom f l privé 🙏","private_reply":"Tsla7 men 6 chhour.","handoff":false,"reason":"âge"}' }], stop_reason: 'end_turn' };
  };
  const cm: any = await call('cm.test', { ...(await as(EMAILS.admin)), dellalAi: page }, { body: 'la chaise haute évolutive men 9eddach ?' });
  assert.equal(cm.facts.product, 'Chaise haute évolutive');
  assert.equal(cm.facts.guide, true);
  assert.match(seen[0], /Guide de vente de ce produit/);
  assert.match(seen[0], /harnais 5 points/);
  assert.doesNotMatch(seen[0], /compléter/);
});

test('« Écrire avec l\'IA »: Claude drafts from the shop\'s facts, the unknown stays to fill, nothing is saved', async () => {
  const asked: any[] = [];
  const server: ServerHooks = {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (x) => x,
    dellal: async (action, args: any) => {
      if (action !== 'complete') return { ok: true };
      asked.push(args);
      return {
        content: [
          {
            type: 'text',
            text: 'Voici :\n{"brief":"Thermomètre frontal sans contact.","strengths":["Sans contact","En 1 seconde"],"faq":[{"q":"Garantie ?","a":"[À compléter]"},{"q":"Piles ?","a":"' + 'x'.repeat(900) + '"}],"doubts":[{"q":"« Ghali »","a":"Pour toute la famille."}],"upsell":"","never":["Qu’il remplace le médecin."]}',
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 900, output_tokens: 400 },
      };
    },
  };
  // the shop's own AI key: no Pilot AI in this test (aiKeyed)
  const g0: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g0.settings, notes: 'Échange sous 7 jours si le produit est neuf.', secrets: { ai: 'sk-ant-test-1234567890' } });
  const d: any = await call('catalog.guideDraft', await as(EMAILS.depot, server), { productId: thermo, lang: 'fr', name: 'Thermomètre frontal', price: 2400, packs: [{ qty: 2, price: 4400 }] });
  assert.equal(d.by, 'ai');
  assert.equal(d.guide.faq[0].a, TO_FILL);
  assert.equal(d.guide.faq[1].a.length, 600, 'a long answer is cut to the guide\'s size');
  assert.equal(asked[0].model, 'claude-sonnet-5-5');
  assert.equal(asked[0].feature, 'dellal');
  assert.match(asked[0].system, /N’invente AUCUN fait/);
  assert.match(asked[0].messages[0].content, /Thermomètre frontal · prix 2 400 DA/);
  assert.match(asked[0].messages[0].content, /Packs : 2 pour 4 400 DA/);
  assert.match(asked[0].messages[0].content, /Échange sous 7 jours/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM product_guides WHERE product_id = $1', [thermo]))[0].n, 0, 'a draft is not saved');
  // no AI here (the preview without Claude): the plain draft from the same facts
  const plain: any = await call('catalog.guideDraft', depot, { name: 'Thermomètre frontal', description: 'Mesure sans contact.\n- Écran rétroéclairé\n- Alarme de fièvre', variants: [] });
  assert.equal(plain.by, 'rules');
  assert.deepEqual(plain.guide.strengths, ['Écran rétroéclairé', 'Alarme de fièvre']);
  assert.ok(plain.guide.faq.some((p: any) => p.a === TO_FILL));
  await assert.rejects(call('catalog.guideDraft', conf, { name: 'X' }), /agences de confirmation/);
  await call('dellal.settings.save', admin, { ...g0.settings, secrets: { ai: null } });
});

test('the draft helpers: JSON read leniently, Darija instructions only for darija, the rules draft keeps to the facts', () => {
  assert.equal(readDraft('pas de JSON'), null);
  assert.equal(readDraft('{"brief": ""}'), null);
  assert.deepEqual(readDraft('```json\n{"brief":"B","strengths":"pas une liste","faq":[{"q":"Q","a":"A"}]}\n```'), { brief: 'B', strengths: [], faq: [{ q: 'Q', a: 'A' }], doubts: [], upsell: '', upsellIds: [], never: [], sizes: [] });
  assert.match(draftSystem('dz', 'GUIDE DARIJA'), /lettres latines[\s\S]*GUIDE DARIJA/);
  assert.doesNotMatch(draftSystem('fr'), /Pour écrire la darija/);
  const r = rulesDraft({ name: 'Biberon', variants: ['Rose', 'Bleu'], packs: [{ qty: 3, price: 3900 }], linked: ['Goupillon'], linkedIds: [7], services: [], page: null });
  assert.match(r.faq.find((p) => /couleurs/.test(p.q))!.a, /Rose, Bleu/);
  assert.match(r.upsell, /3 pour 3 900 DA/);
  assert.doesNotMatch(r.upsell, /Goupillon/, 'the products that go with it are picked, not written');
  assert.deepEqual(r.upsellIds, [7]);
  // sizes: a size that says its age gets it, the weights stay for the team
  const b = rulesDraft({ name: 'Body', variants: [], packs: [], linked: [], services: [], page: null, options: [{ name: 'Taille', values: ['3-6 mois', 'XL'] }, { name: 'Couleur', values: ['Blanc'] }] });
  assert.deepEqual(b.sizes, [{ size: '3-6 mois', age: '3-6 mois', weight: '' }]);
  assert.ok(b.faq.some((p) => /taille/.test(p.q)));
  assert.match(r.doubts[0].a, /pack/);
});

test('Produits & stock › Guide de vente: every product and where its guide stands; the depot side saves only the guide', async () => {
  const list: any = await call('catalog.guides', depot, {});
  assert.equal(list.total, list.rows.length);
  const row = list.rows.find((r: any) => r.id === chair);
  assert.equal(row.hasGuide, true);
  assert.equal(row.toFill, 1, 'the warranty answer is still to write');
  assert.match(row.brief, /6 mois/);
  assert.deepEqual(row.parts, { strengths: 4, faq: 5, doubts: 3, never: 3, upsell: 1, sizes: 0 });
  assert.ok(list.rows.every((r: any) => !('cost' in r) && typeof r.hasGuide === 'boolean'));
  const plain = list.rows.find((r: any) => r.id === thermo);
  assert.equal(plain.hasGuide, false);
  assert.equal(plain.toFill, 0);
  // saving the guide alone (the tab's « Modifier »), nothing else of the product
  const before: any = await call('catalog.product', depot, { id: thermo });
  const saved: any = await call('catalog.saveGuide', depot, { id: thermo, guide: { brief: 'Thermomètre sans contact.', strengths: ['Mesure en 1 seconde'], faq: [{ q: 'Garantie ?', a: TO_FILL }] } });
  assert.equal(saved.guide.brief, 'Thermomètre sans contact.');
  assert.ok(saved.updatedAt && saved.updatedBy);
  const after: any = await call('catalog.product', depot, { id: thermo });
  assert.deepEqual({ ...after, guide: null, guideAt: null, guideBy: null, hasGuide: false }, { ...before, guide: null, guideAt: null, guideBy: null, hasGuide: false });
  assert.equal(((await call('catalog.guides', depot, {})) as any).rows.find((r: any) => r.id === thermo).toFill, 1);
  await assert.rejects(call('catalog.saveGuide', depot, { id: 999999, guide: {} }), /introuvable/);
  // agents read their own products only, and never write
  const config = await getSetting(db, 'autoAssign');
  config.agents[String(conf.session.profile.id)] = { ...config.agents[String(conf.session.profile.id)], products: [chair] } as any;
  await setSetting(db, 'autoAssign', config);
  assert.deepEqual(((await call('catalog.guides', conf, {})) as any).rows.map((r: any) => r.id), [chair]);
  await assert.rejects(call('catalog.saveGuide', conf, { id: chair, guide: {} }), /agences de confirmation/);
  await assert.rejects(call('catalog.guides', await as(EMAILS.livreur), {}), /Accès refusé/);
  await call('catalog.saveGuide', depot, { id: thermo, guide: {} });
  assert.equal(((await call('catalog.guides', depot, {})) as any).rows.find((r: any) => r.id === thermo).hasGuide, false);
});

test('the size guide (a product with a « Taille » option) and Vente en plus (products picked): saved, read, said to the AI', async () => {
  const bod = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-BOD'`))[0].id);
  const ens = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-ENS'`))[0].id);
  const facts: any = await call('catalog.guideFacts', depot, { id: bod });
  assert.deepEqual(facts.options, [{ name: 'Taille', values: ['Naissance', '3 mois', '6 mois', '12 mois'] }]);
  const r: any = await call('catalog.guide', depot, { id: bod });
  assert.equal(r.guide.sizes.length, 4);
  assert.deepEqual(r.guide.sizes[1], { size: '3 mois', age: '1 à 3 mois', weight: '4 à 6 kg' });
  assert.deepEqual(r.upsell.map((p: any) => p.id), [ens]);
  assert.ok(r.upsell[0].name && r.upsell[0].price > 0);
  // saving: a size without age nor weight is dropped, the product itself and an unknown product leave Vente en plus
  const g: any = await call('catalog.saveGuide', depot, { id: bod, guide: { ...r.guide, sizes: [...r.guide.sizes, { size: 'Vide' }], upsellIds: [ens, bod, 999999] } });
  assert.equal(g.guide.sizes.length, 4);
  assert.deepEqual(g.guide.upsellIds, [ens]);
  // the AI agents: the size guide (ask age and weight) and the products to offer, with their price
  const page = async (req: any) => {
    if (!req.tools.length) return { content: [{ type: 'text' as const, text: String(req.messages[0].content).match(/«\n([\s\S]*?)\n»/)?.[1] ?? '' }], stop_reason: 'end_turn' };
    const out = await req.runTool('product_guide', { product_id: bod });
    assert.match(out.guide, /GUIDE DES TAILLES \(demande l’âge et le poids[^\n]*\n- Naissance : âge 0 à 1 mois, poids 2,5 à 4 kg/);
    assert.match(out.guide, new RegExp(`VENTE EN PLUS : propose aussi #${ens} Ensemble bébé 3 pièces \\(\\d+ DA\\) — Pour un cadeau`));
    return { content: [{ type: 'text' as const, text: 'Chhal 3omrou ?' }], stop_reason: 'end_turn' };
  };
  const inPage = { ...(await as(EMAILS.admin)), dellalAi: page };
  await call('dellal.test', inPage, { reset: true });
  await call('dellal.test', inPage, { body: 'lot de 6 bodies wach men taille ?' });
  // a draft keeps the product's own sizes only, and picks its Produits liés for Vente en plus
  const d: any = await call('catalog.guideDraft', depot, { productId: bod, name: 'Lot de 6 bodies coton', options: facts.options, linkedIds: [ens, bod] });
  assert.equal(d.by, 'rules');
  assert.deepEqual(d.guide.upsellIds, [ens]);
  assert.ok(d.guide.sizes.every((x: any) => facts.options[0].values.includes(x.size)));
});

test('a confirmation agency writes the guides of the products it works on, and only those', async () => {
  const bib = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-BIB'`))[0].id);
  await db.query(`INSERT INTO agency_routes (agency_id, task, product_id) VALUES (900, 'confirmation', $1), (900, 'confirmation', $2)`, [chair, bib]);
  const agency: Ctx = { ...conf, session: makeSession({ ...conf.session.profile, agencyId: 900, agencyProducts: null, roles: ['confirmation'] } as any) };
  assert.deepEqual(((await call('catalog.guides', agency, {})) as any).rows.map((r: any) => r.id).sort((a: number, b: number) => a - b), [chair, bib].sort((a, b) => a - b));
  const facts: any = await call('catalog.guideFacts', agency, { id: bib });
  assert.equal(facts.name, 'Biberon anti-colique 260 ml');
  assert.ok(!('cost' in facts));
  const cur: any = await call('catalog.guide', agency, { id: bib });
  const saved: any = await call('catalog.saveGuide', agency, { id: bib, guide: { ...cur.guide, brief: 'Biberon 260 ml anti-colique (écrit par l’agence).', upsellIds: [chair, thermo] } });
  assert.match(saved.guide.brief, /agence/);
  assert.deepEqual(saved.guide.upsellIds, [chair], 'Vente en plus among the agency’s products only');
  await assert.rejects(call('catalog.saveGuide', agency, { id: thermo, guide: { brief: 'x' } }), /pas confié/);
  await assert.rejects(call('catalog.guideFacts', agency, { id: thermo }), /pas confié/);
  // the store's own agents still read only
  await assert.rejects(call('catalog.saveGuide', conf, { id: chair, guide: { brief: 'x' } }), /agences de confirmation/);
  await assert.rejects(call('catalog.guideFacts', conf, { id: chair }), /agences de confirmation/);
  await db.query('DELETE FROM agency_routes WHERE agency_id = 900');
});
