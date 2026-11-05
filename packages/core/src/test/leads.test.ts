// Marketing › Formulaires: the ads' lead forms become orders. What a question asks, where the customer lives (« Bordj »:
// which one?), the demo page, fixing a wilaya or a number, choosing a form's product, duplicates, « Garder à vérifier »,
// Meta's webhook, a lead Facebook would not give, the safety net and who may see it.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, ServerHooks } from '../index';
import { parseMetaLeads } from '../dellal-server';
import { fieldOf, MetaLead, metaTime, placeOf, readAnswers, variantOf, wilayaCandidates } from '../modules/leads';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(150));
});

const feed = async (input: Record<string, unknown> = {}, server?: ServerHooks) => (await call('leads.feed', await as(EMAILS.marketer, server), input)) as any;
const formByName = async (part: string) => (await feed()).forms.find((f: any) => f.name.includes(part));

test('what a question asks: Meta types, French, Arabic and English words', () => {
  assert.equal(fieldOf({ key: 'full_name', type: 'FULL_NAME' }), 'name');
  assert.equal(fieldOf({ key: 'phone_number', type: 'PHONE' }), 'phone');
  assert.equal(fieldOf({ key: 'quelle_est_votre_wilaya_?', label: 'Quelle est votre wilaya ?' }), 'wilaya');
  assert.equal(fieldOf({ key: 'x1', label: 'الولاية' }), 'wilaya');
  assert.equal(fieldOf({ key: 'x2', label: 'البلدية' }), 'commune');
  assert.equal(fieldOf({ key: 'adresse', label: 'Adresse (rue, numéro)' }), 'address', 'an address with « numéro » is not a phone');
  assert.equal(fieldOf({ key: 'numero', label: 'Numéro de téléphone' }), 'phone');
  assert.equal(fieldOf({ key: 'رقم_الهاتف', label: 'رقم الهاتف' }), 'phone');
  assert.equal(fieldOf({ key: 'couleur', label: 'Couleur' }), 'variant');
  assert.equal(fieldOf({ key: 'x3', label: 'المقاس' }), 'variant');
  assert.equal(fieldOf({ key: 'nombre', label: 'Nombre de pièces' }), 'qty', '« nombre » is a quantity, not a name');
  assert.equal(fieldOf({ key: 'nom_et_prenom', label: 'Nom et prénom' }), 'name');
  assert.equal(fieldOf({ key: 'prenom', label: 'Prénom' }), 'first');
  assert.equal(fieldOf({ key: 'email', type: 'EMAIL' }), 'note');
  assert.equal(fieldOf({ key: 'quand', label: 'Quand voulez-vous être livré ?' }), 'note');
  const a = readAnswers([
    { key: 'first_name', label: '', value: 'Amina' },
    { key: 'last_name', label: '', value: 'Boukhalfa' },
    { key: 'phone_number', label: '', value: '+213 661 34 50 12' },
    { key: 'wilaya', label: 'Wilaya', value: 'bordj_bou_arreridj' },
    { key: 'qte', label: 'Quantité', value: '٢' },
    { key: 'couleur', label: 'Couleur', value: 'Rose' },
    { key: 'message', label: 'Message', value: 'Livrer après 17h' },
  ]);
  assert.equal(a.name, 'Amina Boukhalfa');
  assert.equal(a.wilaya, 'bordj bou arreridj');
  assert.equal(a.qty, 2, 'Arabic digits');
  assert.equal(a.variant, 'Rose');
  assert.deepEqual(a.notes, ['Couleur : Rose', 'Message : Livrer après 17h']);
});

test('where the customer lives: a name, a number, Arabic, a commune, or the wilayas to choose from', () => {
  assert.equal(placeOf('Sétif', '').wilayaId, 19);
  assert.equal(placeOf('wilaya 16', '').wilayaId, 16, 'its number');
  assert.equal(placeOf('ولاية وهران', '').wilayaId, 31, 'in Arabic');
  assert.equal(placeOf('Tizi', 'Azazga').wilayaId, 15, 'one wilaya starts with it');
  assert.equal(placeOf('Tlemcan', '').wilayaId, 13, 'a letter wrong');
  const bordj = placeOf('Bordj', 'Cité 20 Août');
  assert.equal(bordj.wilayaId, null);
  assert.deepEqual(bordj.candidates, [34, 50], '« Bordj »: Bordj Bou Arréridj or Bordj Badji Mokhtar');
  assert.equal(bordj.wrote, 'Bordj');
  assert.equal(placeOf('Bordj', 'Medjana').wilayaId, 34, 'its commune says which one');
  assert.equal(placeOf('', 'Bab Ezzouar').wilayaId, 16, 'no wilaya asked: the commune says it, even written another way');
  assert.deepEqual(placeOf('', 'Ain Benian').candidates, [16, 44], 'a commune of two wilayas: the choice');
  assert.deepEqual(placeOf('Ain Benian', '').candidates, [16, 44], 'written as the wilaya too');
  assert.equal(placeOf('Bab Ezzouar', '').wilayaId, 16, 'a commune written as the wilaya');
  assert.deepEqual(wilayaCandidates('Bourdj'), [34, 50], 'written another way');
  assert.equal(placeOf('xyz', '').wilayaId, null);
  const vars = [
    { id: 1, title: 'Gris' },
    { id: 2, title: 'Bleu marine' },
    { id: 3, title: 'Rose' },
  ];
  assert.equal(variantOf(vars, 'rose'), 3);
  assert.equal(variantOf(vars, 'bleu_marine'), 2);
  assert.equal(variantOf(vars, 'vert'), null);
  assert.equal(metaTime(1762180320), '2025-11-03T14:32:00.000Z');
  assert.equal(metaTime('2025-11-03T14:32:00+0000'), '2025-11-03T14:32:00.000Z');
});

test('Meta webhook: the form sent (leadgen), nothing else', () => {
  const body = {
    object: 'page',
    entry: [
      {
        id: '1029384756',
        time: 1762180320,
        changes: [
          { field: 'leadgen', value: { ad_id: '238400001', form_id: '771204503310001', leadgen_id: '9001', created_time: 1762180320, page_id: '1029384756', adgroup_id: '238400002' } },
          { field: 'feed', value: { item: 'comment', verb: 'add' } },
          { field: 'leadgen', value: { leadgen_id: 'not-a-number' } },
        ],
      },
    ],
  };
  assert.deepEqual(parseMetaLeads(body), [{ leadgenId: '9001', formId: '771204503310001', pageId: '1029384756', adId: '238400001', adsetId: '238400002', createdTime: 1762180320 }]);
  assert.deepEqual(parseMetaLeads({ object: 'instagram', entry: body.entry }), []);
});

test('the demo page: orders from forms, leads to fix, waiting, a duplicate and the test lead', async () => {
  const d = await feed({ limit: 200 });
  assert.ok(d.counts.created >= 1, 'recent Facebook and Instagram orders came from forms');
  assert.equal(d.counts.fix, 2, 'a wilaya and a number to fix');
  assert.equal(d.counts.waiting, 3, 'the form without a product');
  assert.equal(d.counts.dup, 1);
  const bordj = d.rows.find((r: any) => r.problem === 'wilaya');
  assert.equal(bordj.wrote, 'Bordj');
  assert.deepEqual(bordj.candidates.map((c: any) => c.id), [34, 50]);
  const phone = d.rows.find((r: any) => r.problem === 'phone');
  assert.equal(phone.phone, '0557 3');
  assert.ok(d.rows.some((r: any) => r.status === 'test' && r.isTest), 'Meta’s test lead');
  const created = d.rows.find((r: any) => r.status === 'created');
  const o = (await db.query(`SELECT source, utm FROM orders WHERE id = $1`, [created.order.id]))[0];
  assert.match(o.source, /^Formulaire « /);
  assert.equal(o.utm.utm_medium, 'lead_form');
  const dup = d.rows.find((r: any) => r.status === 'dup');
  assert.ok(dup.dup.ref, 'the order of the same number');
  const pou = d.forms.find((f: any) => f.name.startsWith('Poussette'));
  assert.equal(pou.productId, null);
  assert.equal(pou.waiting, 3);
  assert.ok(d.forms.some((f: any) => !f.active), 'a form switched off');
  // the chips
  const fix = await feed({ filter: 'fix' });
  assert.ok(fix.rows.every((r: any) => ['fix', 'error'].includes(r.status)));
});

test('« 34 · Bordj Bou Arréridj »: the wilaya chosen, the order is created', async () => {
  const d = await feed({ filter: 'fix' });
  const bordj = d.rows.find((r: any) => r.problem === 'wilaya');
  const r: any = await call('leads.fix', await as(EMAILS.marketer), { id: bordj.id, wilayaId: 34 });
  assert.equal(r.status, 'created');
  const o = (await db.query(`SELECT o.wilaya_id, o.channel, o.phone, o.customer_name, o.source, i.variant_title FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.id = $1`, [r.order.id]))[0];
  assert.equal(o.wilaya_id, 34);
  assert.equal(o.channel, 'facebook');
  assert.equal(o.phone, '0661345012');
  assert.equal(o.customer_name, 'Amina Boukhalfa');
  assert.equal(o.variant_title, 'Gris', 'the colour she chose');
  await assert.rejects(call('leads.fix', await as(EMAILS.marketer), { id: bordj.id, wilayaId: 34 }), /déjà une commande/);
});

test('« Corriger le numéro »: a wrong number is refused, the right one makes the order', async () => {
  const d = await feed({ filter: 'fix' });
  const l = d.rows.find((r: any) => r.problem === 'phone');
  await assert.rejects(call('leads.fix', await as(EMAILS.marketer), { id: l.id, phone: '0557 3' }), /invalide/);
  const r: any = await call('leads.fix', await as(EMAILS.marketer), { id: l.id, phone: '0557 31 44 08' });
  assert.equal(r.status, 'created');
  assert.equal(r.platform, 'ig');
  const o = (await db.query(`SELECT channel, wilaya_id FROM orders WHERE id = $1`, [r.order.id]))[0];
  assert.equal(o.channel, 'instagram');
  assert.equal(o.wilaya_id, 15);
});

test('« Choisir le produit »: the waiting leads become orders with the colour each one chose', async () => {
  const pou = await formByName('Poussette');
  const product = (await db.query(`SELECT id FROM products WHERE sku = 'PX-POU'`))[0].id;
  const r: any = await call('leads.formSave', await as(EMAILS.marketer), { id: pou.id, productId: Number(product), variantId: null, active: true, mode: 'order', dupDays: 7 });
  assert.equal(r.created, 3);
  const rows = await db.query(
    `SELECT l.customer_name, i.variant_title FROM leads l JOIN order_items i ON i.order_id = l.order_id WHERE l.form_id = $1 ORDER BY l.customer_name`,
    [pou.formId],
  );
  assert.deepEqual(
    rows.map((x: any) => `${x.customer_name}: ${x.variant_title}`),
    ['Hocine Larbi: Gris', 'Khaled Mansouri: Rose', 'Souad Bensaid: Bleu marine'],
  );
  await assert.rejects(call('leads.formSave', await as(EMAILS.marketer), { ...pou, id: pou.id, productId: Number(product), variantId: 999999, active: true, mode: 'order', dupDays: 7 }), /variante/);
});

test('a duplicate: no second order, unless « Créer quand même »', async () => {
  const d = await feed({ filter: 'dup' });
  const l = d.rows[0];
  const before = (await db.query(`SELECT count(*)::int AS n FROM orders`))[0].n;
  const r: any = await call('leads.create', await as(EMAILS.marketer), { id: l.id });
  assert.equal(r.status, 'created');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders`))[0].n, before + 1);
});

/** A fake server: Meta gives these leads (or refuses), and the forms. */
function fakeServer(leads: Record<string, MetaLead>, o: { refuse?: boolean } = {}): ServerHooks {
  return {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (p) => p,
    dellal: async (action, args: any) => {
      if (action === 'lead') {
        if (o.refuse) throw new Error('Facebook : (#200) Requires leads_retrieval permission');
        const l = leads[args.leadgenId];
        if (!l) throw new Error('Facebook : lead introuvable');
        return l;
      }
      if (action === 'leadForm') return { id: args.formId, name: 'Écharpe – hiver', status: 'ACTIVE', questions: [{ key: 'votre_wilaya', label: 'Votre wilaya', type: 'CUSTOM' }] };
      if (action === 'leadForms') return [{ id: '771204503319999', name: 'Sac à langer – rentrée', status: 'ACTIVE', questions: [] }];
      if (action === 'formLeads') return Object.values(leads).filter((l) => l.formId === args.formId);
      return {};
    },
  };
}
const metaLead = (id: string, formId: string, phone: string, extra: Partial<MetaLead> = {}): MetaLead => ({
  id,
  createdTime: '2026-11-05T09:12:00+0000',
  formId,
  adId: '238400009',
  adName: 'Écharpe – vidéo',
  adsetId: '238400010',
  campaignId: '238400011',
  platform: 'fb',
  fieldData: [
    { name: 'full_name', values: ['Lamia Kaci'] },
    { name: 'phone_number', values: [phone] },
    { name: 'votre_wilaya', values: ['Constantine'] },
    { name: 'couleur', values: ['Vert sauge'] },
  ],
  ...extra,
});

test('Meta’s webhook: a new form is found, its first lead waits for its product, the next ones are orders', async () => {
  const leads = { '9101': metaLead('9101', '771204503318888', '+213 662 10 20 30'), '9102': metaLead('9102', '771204503318888', '0662 10 20 31') };
  const server = fakeServer(leads);
  const sys = await as(EMAILS.admin, server);
  await assert.rejects(call('leads.receive', await as(EMAILS.marketer, server), { leadgenId: '9101' }), /Accès refusé/, 'Meta only');
  const r: any = await call('leads.receive', sys, { leadgenId: '9101', formId: '771204503318888', pageId: '1029384756', adId: '238400009', adsetId: '238400010', createdTime: 1762333920 });
  assert.equal(r.status, 'waiting', 'a form Pilotix did not know: no product yet');
  assert.equal(await call('leads.receive', sys, { leadgenId: '9101', formId: '771204503318888' }), null, 'the same lead twice is stored once');
  const f = await formByName('Écharpe – hiver');
  assert.ok(f, 'the form, read from Meta');
  const ech = (await db.query(`SELECT id FROM products WHERE sku = 'PX-ECH'`))[0].id;
  const saved: any = await call('leads.formSave', await as(EMAILS.marketer, server), { id: f.id, productId: Number(ech), variantId: null, active: true, mode: 'order', dupDays: 7 });
  assert.equal(saved.created, 1);
  const r2: any = await call('leads.receive', sys, { leadgenId: '9102', formId: '771204503318888' });
  assert.equal(r2.status, 'created');
  const o = (await db.query(`SELECT o.adset_id, o.utm, o.wilaya_id, i.variant_title FROM leads l JOIN orders o ON o.id = l.order_id JOIN order_items i ON i.order_id = o.id WHERE l.leadgen_id = '9102'`))[0];
  assert.equal(o.adset_id, '238400010', 'Publicité counts it for its ad set');
  assert.equal(o.utm.ad_id, '238400009');
  assert.equal(o.utm.utm_content, 'Écharpe – vidéo');
  assert.equal(o.wilaya_id, 25);
  assert.equal(o.variant_title, 'Vert sauge');
});

test('a lead Facebook will not give waits with the reason, « Réessayer » reads it again', async () => {
  const leads = { '9201': metaLead('9201', '771204503318888', '0662 10 20 40') };
  const r: any = await call('leads.receive', await as(EMAILS.admin, fakeServer(leads, { refuse: true })), { leadgenId: '9201', formId: '771204503318888', createdTime: 1762333920 });
  assert.equal(r.status, 'error');
  const row = (await feed({ filter: 'fix' })).rows.find((x: any) => x.id === r.leadId);
  assert.match(row.error, /leads_retrieval/);
  const again: any = await call('leads.retry', await as(EMAILS.marketer, fakeServer(leads)), { id: r.leadId });
  assert.equal(again.status, 'created');
  assert.equal(again.name, 'Lamia Kaci');
});

test('« Garder à vérifier » and a form switched off: nothing is created until a person says so', async () => {
  const f = await formByName('Écharpe – hiver');
  const marketer = await as(EMAILS.marketer);
  await call('leads.formSave', marketer, { id: f.id, productId: f.productId, variantId: null, active: true, mode: 'review', dupDays: 7 });
  const sys = await as(EMAILS.admin, fakeServer({ '9301': metaLead('9301', '771204503318888', '0662 10 20 50') }));
  const r: any = await call('leads.receive', sys, { leadgenId: '9301', formId: '771204503318888' });
  assert.equal(r.status, 'waiting');
  const made: any = await call('leads.create', marketer, { id: r.leadId });
  assert.equal(made.status, 'created');
  await call('leads.formSave', marketer, { id: f.id, productId: f.productId, variantId: null, active: false, mode: 'order', dupDays: 7 });
  const sys2 = await as(EMAILS.admin, fakeServer({ '9302': metaLead('9302', '771204503318888', '0662 10 20 51') }));
  const off: any = await call('leads.receive', sys2, { leadgenId: '9302', formId: '771204503318888' });
  assert.equal(off.status, 'waiting');
  const on: any = await call('leads.formSave', marketer, { id: f.id, productId: f.productId, variantId: null, active: true, mode: 'order', dupDays: 7 });
  assert.equal(on.created, 1, 'switched on again: its waiting lead becomes an order');
  const ign: any = await call('leads.ignore', marketer, { id: (await feed({ filter: 'all' })).rows.find((x: any) => x.status === 'test').id });
  assert.equal(ign.status, 'ignored');
});

test('the safety net: the forms list, and the leads Meta did not send', async () => {
  await db.query(`INSERT INTO settings (key, value) VALUES ('dellal', '{"messengerPageId":"1029384756"}') ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`);
  await db.query(`DELETE FROM settings WHERE key = 'leads_sync'`);
  const leads = { '9401': metaLead('9401', '771204503318888', '0662 10 20 60', { createdTime: new Date().toISOString() }) };
  const r: any = await call('leads.catchUp', await as(EMAILS.admin, fakeServer(leads)), {});
  assert.equal(r.found, 1);
  assert.deepEqual(r.errors, []);
  assert.ok(await formByName('Sac à langer – rentrée'), 'the forms list was read');
  const again: any = await call('leads.catchUp', await as(EMAILS.admin, fakeServer(leads)), {});
  assert.equal(again.found, 0, 'already there');
  assert.deepEqual(await call('leads.catchUp', await as(EMAILS.admin), {}), { found: 0, forms: 0, errors: [], skipped: 'preview' });
});

test('who sees Formulaires: marketing, not the confirmation agents', async () => {
  await assert.rejects(call('leads.feed', await as(EMAILS.conf), {}), /Accès refusé/);
  await assert.rejects(call('leads.formSave', await as(EMAILS.livreur), { id: 1, productId: null, active: true }), /Accès refusé/);
  const d = await feed();
  assert.ok(d.today.leads >= d.today.orders);
  assert.equal(d.live, false, 'the preview: nothing to read from Meta');
});
