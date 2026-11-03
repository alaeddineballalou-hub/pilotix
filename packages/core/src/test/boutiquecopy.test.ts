// « Copier des réglages »: the owner of several boutiques gives one what another is set up with. The companies come with
// their keys (when asked), prices and bureaus, without the other boutique's webhook; people and products named in the
// settings are found again; nothing the other boutique never set changes; the orders' own things stay; only the owner
// of both boutiques copies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, pgliteTenancy, seedBase, shopCtx, shopStatus, Tenancy } from '../index';
import { copyIntoNewBoutique } from '../modules/boutiquecopy';
import { accountByEmail } from '../platform/accounts';
import { loadShop, platformSettings, provisionShop } from '../platform/shops';
import { DEFAULT_SETTINGS, getSetting, setSetting } from '../settings';

const OWNER = { email: 'karim@bebe.dz', password: 'Karim-Password-1' };
const OTHER = { email: 'nadia@sport.dz', password: 'Nadia-Password-1' };

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Karim' });
  await setSetting(t.shop('public'), 'shop', { ...(await getSetting(t.shop('public'), 'shop')), name: 'Bébé Confort' });
  await migrateAll(t);
  return t;
}

async function as(t: Tenancy, shopId: number, who: { email: string; password: string }): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  const st = shopStatus(s, Date.now(), (await platformSettings(t)).trial.graceDays);
  return { db, session: await login(db, who.email, who.password), now: () => Date.now(), emit: () => {}, t, shop: shopCtx(s, st) };
}

async function setup() {
  const t = await server();
  const s1 = (await loadShop(t, { primary: true }))!;
  const s2 = await provisionShop(t, { name: 'Maison Karim', kind: 'store', planId: null, trialDays: 30, owner: { name: 'Karim', email: OWNER.email }, password: OWNER.password, verified: true });
  const s3 = await provisionShop(t, { name: 'Sport Nadia', kind: 'store', planId: null, trialDays: 30, owner: { name: 'Nadia', email: OTHER.email }, password: OTHER.password, verified: true });
  const a = t.shop(s1.schema);
  const b = t.shop(s2.schema);
  // the same product (by SKU) and the same agent (by e-mail) in both; one product only in the first
  for (const db of [a, b]) {
    await db.query(`INSERT INTO products (name, sku, price) VALUES ('Poussette 3 en 1', 'POU-1', 12900)`);
    await db.query(`INSERT INTO profiles (name, email, password_hash, roles) VALUES ('Samira', 'samira@bebe.dz', 'x', '{confirmation}')`);
  }
  await a.query(`INSERT INTO products (name, sku, price) VALUES ('Siège auto', 'SIE-1', 9900)`);
  const pid = async (db: typeof a, sku: string) => Number((await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0].id);
  const samira = async (db: typeof a) => Number((await db.query(`SELECT id FROM profiles WHERE email = 'samira@bebe.dz'`))[0].id);

  // the first boutique, set up: two companies (Yalidine with its keys and its webhook), prices, bureaus, rules…
  const yal = Number(
    (
      await a.query(`INSERT INTO delivery_companies (name, kind, credentials, config) VALUES ('Yalidine', 'yalidine', $1, $2) RETURNING id`, [
        JSON.stringify({ api_id: 'ID-1', api_token: 'TOKEN-1' }),
        JSON.stringify({ settings: { webhook_id: 'WH-A', from_wilaya: 'Alger' }, statusMap: { 'En attente': 'shipped' }, swap: { same: 60, other: 120 } }),
      ])
    )[0].id,
  );
  const own = Number((await a.query(`INSERT INTO delivery_companies (name, kind) VALUES ('Livraison privée', 'own') RETURNING id`))[0].id);
  await a.query(`INSERT INTO delivery_fees (company_id, wilaya_id, home, desk, return_fee) VALUES ($1, 16, 400, 300, 200), ($1, 31, 700, 450, 250)`, [yal]);
  await a.query(`INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address, ext_id) VALUES ($1, 16, 'Kouba', 'Yalidine Kouba', 'Rue 1', '160101'), ($1, 31, 'Oran', 'Yalidine Oran', 'Rue 2', NULL)`, [yal]);
  await setSetting(a, 'pilot', {
    mode: 'auto',
    rules: [
      { id: 'r1', wilayas: [16], except: false, communes: [], products: [], to: own, strict: true, on: true },
      { id: 'r2', wilayas: [], except: false, communes: [], products: [await pid(a, 'POU-1')], to: yal, strict: false, on: true },
      { id: 'r3', wilayas: [31], except: false, communes: [], products: [await pid(a, 'SIE-1')], to: yal, strict: true, on: true },
    ],
    clashes: [
      { a: 'r1', b: 'r2', win: 'r1' },
      { a: 'r1', b: 'r3', win: 'assign' },
    ],
  });
  await setSetting(a, 'shop', { ...(await getSetting(a, 'shop')), fromWilayaId: 31, defaultCompanyId: yal, whatsappTemplate: 'Salam {nom}, {boutique} ici.', savPhone: '0550 00 00 01' });
  await setSetting(a, 'prefs', { ...DEFAULT_SETTINGS.prefs, strictLock: false, privateBackup: { on: true, hours: 12, companyId: yal }, suiviTries: { calls: 5, gapMinutes: 30 } });
  await setSetting(a, 'clientFees', { Standard: { '16': { home: 500, desk: 350 } } });
  await setSetting(a, 'customStatuses', [{ key: 'c_rappel', track: 'conf', label: 'Rappeler demain', tone: 'warn', behavesLike: 'callback' }]);
  await setSetting(a, 'autoAssign', {
    ...DEFAULT_SETTINGS.autoAssign,
    conf: { ...DEFAULT_SETTINGS.autoAssign.conf, mode: 'load', rotation: { ...DEFAULT_SETTINGS.autoAssign.conf.rotation, on: true, target: await samira(a) } },
    agents: { [await samira(a)]: { out: false, weight: 2, channels: [], products: [await pid(a, 'POU-1')], from: 9, to: 17, langs: [], senior: true, shops: [], woman: true } },
    order: [await samira(a)],
  });
  await a.query(`INSERT INTO settings (key, value) VALUES ('notify', $1)`, [JSON.stringify({ enabled: true, texts: { shipped: { dz: 'Colis ra7 🚚' } }, hookKey: 'HOOK-A', wabaId: 'WABA-A' })]);
  await a.query(`INSERT INTO settings (key, value) VALUES ('dellal', $1)`, [JSON.stringify({ enabled: true, name: 'Lina', tone: 'Douce', whatsappPhoneId: 'PHONE-A', verifyToken: 'VT-A' })]);
  await a.query(`INSERT INTO settings (key, value) VALUES ('cm', $1)`, [JSON.stringify({ enabled: true, tone: 'Très court', delaySec: 30 })]);
  await setSetting(a, 'landing', { ...(await getSetting(a, 'landing')), purchaseAt: 'delivered', pixelId: 'PIX-A', abandonAfterMin: 45 });

  // the second boutique has its own status, its own landing link and an order on a bureau
  await setSetting(b, 'customStatuses', [{ key: 'c_vip', track: 'conf', label: 'Client VIP', tone: 'ok', behavesLike: 'confirmed' }]);
  await setSetting(b, 'landing', { ...(await getSetting(b, 'landing')), pixelId: 'PIX-B' });
  return { t, s1, s2, s3, a, b, pid, samira };
}

test('the owner copies one boutique’s settings into another: companies with keys, prices, bureaus, rules, messages, agents', async () => {
  const { t, s1, s2, a, b, pid, samira } = await setup();
  const k = await as(t, s1.id, OWNER);

  const pre: any = await call('boutiques.copyPreview', k, { from: s1.id, to: s2.id });
  assert.deepEqual(pre.companies.map((c: any) => [c.name, c.keys, c.there]), [
    ['Yalidine', true, false],
    ['Livraison privée', false, false],
  ]);
  assert.deepEqual(pre.set, { couriers: true, fees: true, statuses: true, work: true, messages: true, pages: true, ai: true });

  const r: any = await call('boutiques.copy', k, { from: s1.id, to: s2.id, parts: ['couriers', 'fees', 'statuses', 'work', 'messages', 'pages', 'ai'], keys: true });
  assert.deepEqual(r.added, ['Yalidine', 'Livraison privée']);
  assert.deepEqual(r.updated, []);

  // the companies, with the same keys, without the first boutique's webhook
  const yal = (await b.query(`SELECT * FROM delivery_companies WHERE name = 'Yalidine'`))[0];
  assert.deepEqual(yal.credentials, { api_id: 'ID-1', api_token: 'TOKEN-1' });
  assert.deepEqual(yal.config.settings, { from_wilaya: 'Alger' });
  assert.deepEqual(yal.config.statusMap, { 'En attente': 'shipped' });
  assert.deepEqual(yal.config.swap, { same: 60, other: 120 });
  const yid = Number(yal.id);
  const ownB = Number((await b.query(`SELECT id FROM delivery_companies WHERE kind = 'own'`))[0].id);
  assert.deepEqual((await b.query('SELECT wilaya_id, home, desk, return_fee FROM delivery_fees WHERE company_id = $1 ORDER BY wilaya_id', [yid])).map((x: any) => [x.wilaya_id, x.home, x.desk, x.return_fee]), [
    [16, 400, 300, 200],
    [31, 700, 450, 250],
  ]);
  assert.deepEqual((await b.query('SELECT name, ext_id FROM stopdesks WHERE company_id = $1 ORDER BY name', [yid])).map((x: any) => [x.name, x.ext_id]), [
    ['Yalidine Kouba', '160101'],
    ['Yalidine Oran', null],
  ]);

  // Pilot Auto Assign: this boutique's companies and products; the rule for a product sold only there is left out
  const pilot = await getSetting(b, 'pilot');
  assert.equal(pilot.mode, 'auto');
  assert.deepEqual(
    pilot.rules.map((x) => [x.id, x.to, x.products]),
    [
      ['r1', ownB, []],
      ['r2', yid, [await pid(b, 'POU-1')]],
    ],
  );
  assert.deepEqual(pilot.clashes, [{ a: 'r1', b: 'r2', win: 'r1' }]);

  // its sending wilaya, default company, the companies' preferences; the SAV number stays this boutique's
  const shop = await getSetting(b, 'shop');
  assert.equal(shop.name, 'Maison Karim');
  assert.equal(shop.fromWilayaId, 31);
  assert.equal(shop.defaultCompanyId, yid);
  assert.equal(shop.whatsappTemplate, 'Salam {nom}, {boutique} ici.');
  assert.equal(shop.savPhone, '');
  const prefs = await getSetting(b, 'prefs');
  assert.equal(prefs.strictLock, false);
  assert.deepEqual(prefs.privateBackup, { on: true, hours: 12, companyId: yid });
  assert.deepEqual(prefs.suiviTries, { calls: 5, gapMinutes: 30 });

  // prices; statuses (this boutique's own one stays)
  assert.deepEqual(await getSetting(b, 'clientFees'), { Standard: { '16': { home: 500, desk: 350 } } });
  assert.deepEqual((await getSetting(b, 'customStatuses')).map((x) => x.key), ['c_rappel', 'c_vip']);

  // automatic assignment: Samira found again by her e-mail, her product by its SKU
  const aa = await getSetting(b, 'autoAssign');
  const sb = await samira(b);
  assert.equal(aa.conf.mode, 'load');
  assert.equal(aa.conf.rotation.target, sb);
  assert.deepEqual(Object.keys(aa.agents), [String(sb)]);
  assert.deepEqual(aa.agents[String(sb)].products, [await pid(b, 'POU-1')]);
  assert.deepEqual(aa.order, [sb]);

  // messages to customers: the texts, not the SMS hook or the WhatsApp account
  const notify = (await b.query(`SELECT value FROM settings WHERE key = 'notify'`))[0].value;
  assert.equal(notify.enabled, true);
  assert.deepEqual(notify.texts, { shipped: { dz: 'Colis ra7 🚚' } });
  assert.equal(notify.hookKey, undefined);
  assert.equal(notify.wabaId, undefined);
  // the landing pages: how they work, not their pixel
  const landing = await getSetting(b, 'landing');
  assert.equal(landing.purchaseAt, 'delivered');
  assert.equal(landing.abandonAfterMin, 45);
  assert.equal(landing.pixelId, 'PIX-B');
  // the agents: how they talk, never on by itself, never the other boutique's WhatsApp
  const dellal = (await b.query(`SELECT value FROM settings WHERE key = 'dellal'`))[0].value;
  assert.equal(dellal.name, 'Lina');
  assert.equal(dellal.tone, 'Douce');
  assert.equal(dellal.enabled, undefined);
  assert.equal(dellal.whatsappPhoneId, undefined);
  assert.equal(dellal.verifyToken, undefined);
  const cm = (await b.query(`SELECT value FROM settings WHERE key = 'cm'`))[0].value;
  assert.deepEqual(cm, { tone: 'Très court', delaySec: 30 });

  // the same copy again: the companies are updated (not twice), their bureaus not doubled; this boutique's webhook stays
  await b.query(`UPDATE delivery_companies SET config = jsonb_set(config, '{settings,webhook_id}', '"WH-B"'), credentials = credentials || '{"webhook_key":"WK-B"}' WHERE id = $1`, [yid]);
  await a.query(`UPDATE delivery_fees SET home = 450 WHERE wilaya_id = 16`);
  await a.query(`UPDATE delivery_companies SET credentials = credentials || '{"webhook_key":"WK-A"}' WHERE id = $1`, [await a.query(`SELECT id FROM delivery_companies WHERE name = 'Yalidine'`).then((x) => x[0].id)]);
  const again: any = await call('boutiques.copy', k, { from: s1.id, to: s2.id, parts: ['couriers'], keys: true });
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.updated, ['Yalidine', 'Livraison privée']);
  assert.equal(Number((await b.query('SELECT count(*)::int AS n FROM delivery_companies'))[0].n), 2);
  assert.equal(Number((await b.query('SELECT count(*)::int AS n FROM stopdesks'))[0].n), 2);
  assert.equal((await b.query('SELECT home FROM delivery_fees WHERE company_id = $1 AND wilaya_id = 16', [yid]))[0].home, 450);
  const same = (await b.query('SELECT credentials, config FROM delivery_companies WHERE id = $1', [yid]))[0];
  assert.equal(same.config.settings.webhook_id, 'WH-B');
  assert.deepEqual(same.credentials, { api_id: 'ID-1', api_token: 'TOKEN-1', webhook_key: 'WK-B' });
  // the first boutique is unchanged
  assert.equal((await a.query(`SELECT config FROM delivery_companies WHERE name = 'Yalidine'`))[0].config.settings.webhook_id, 'WH-A');

  // another account's keys here: the first boutique's replace them, and the webhook made for that other account goes
  await b.query(`UPDATE delivery_companies SET credentials = $2 WHERE id = $1`, [yid, JSON.stringify({ api_id: 'ID-B', api_token: 'TOKEN-B', webhook_key: 'WK-B' })]);
  await call('boutiques.copy', k, { from: s1.id, to: s2.id, parts: ['couriers'], keys: true });
  const other = (await b.query('SELECT credentials, config FROM delivery_companies WHERE id = $1', [yid]))[0];
  assert.deepEqual(other.credentials, { api_id: 'ID-1', api_token: 'TOKEN-1' });
  assert.equal(other.config.settings.webhook_id, undefined);
});

test('without the keys; only the parts ticked; what the other boutique never set stays', async () => {
  const { t, s1, s2, a, b } = await setup();
  const k = await as(t, s1.id, OWNER);
  await setSetting(b, 'weightFees', { fromKg: 3, perKg: 80 });
  await call('boutiques.copy', k, { from: s1.id, to: s2.id, parts: ['couriers', 'fees'], keys: false });
  const yal = (await b.query(`SELECT credentials FROM delivery_companies WHERE name = 'Yalidine'`))[0];
  assert.deepEqual(yal.credentials, {});
  // keys typed here stay: without « the same keys », and when the first boutique has none for that company
  await b.query(`UPDATE delivery_companies SET credentials = $1 WHERE name = 'Yalidine'`, [JSON.stringify({ api_id: 'ID-B', api_token: 'TOKEN-B' })]);
  await call('boutiques.copy', k, { from: s1.id, to: s2.id, parts: ['couriers'], keys: false });
  assert.deepEqual((await b.query(`SELECT credentials FROM delivery_companies WHERE name = 'Yalidine'`))[0].credentials, { api_id: 'ID-B', api_token: 'TOKEN-B' });
  await a.query(`UPDATE delivery_companies SET credentials = '{}' WHERE name = 'Yalidine'`);
  await call('boutiques.copy', k, { from: s1.id, to: s2.id, parts: ['couriers'], keys: true });
  assert.deepEqual((await b.query(`SELECT credentials FROM delivery_companies WHERE name = 'Yalidine'`))[0].credentials, { api_id: 'ID-B', api_token: 'TOKEN-B' });
  // fees: the grid came; the overweight rule the first boutique never set stays this one's
  assert.deepEqual(await getSetting(b, 'clientFees'), { Standard: { '16': { home: 500, desk: 350 } } });
  assert.deepEqual(await getSetting(b, 'weightFees'), { fromKg: 3, perKg: 80 });
  // not ticked: statuses, messages, agents
  assert.deepEqual((await getSetting(b, 'customStatuses')).map((x) => x.key), ['c_vip']);
  assert.equal((await b.query(`SELECT 1 FROM settings WHERE key IN ('notify', 'dellal', 'cm')`)).length, 0);
  assert.equal((await getSetting(b, 'shop')).whatsappTemplate, DEFAULT_SETTINGS.shop.whatsappTemplate);
});

test('only the owner of both boutiques copies; a new boutique starts with another one’s settings', async () => {
  const { t, s1, s2, s3 } = await setup();
  const k = await as(t, s1.id, OWNER);
  // not his boutique (Nadia's), to or from
  await assert.rejects(call('boutiques.copy', k, { from: s1.id, to: s3.id, parts: ['fees'] }), /propriétaire/);
  await assert.rejects(call('boutiques.copyPreview', k, { from: s3.id, to: s1.id }), /propriétaire|introuvable/i);
  // the same boutique
  await assert.rejects(call('boutiques.copy', k, { from: s1.id, to: s1.id, parts: ['fees'] }), /autre boutique/);
  // Nadia: not hers
  const n = await as(t, s3.id, OTHER);
  await assert.rejects(call('boutiques.copy', n, { from: s1.id, to: s3.id, parts: ['fees'] }), /propriétaire/);

  // « Ajouter une boutique » with « Commencer avec les réglages de Bébé Confort »
  const karim = (await accountByEmail(t, OWNER.email))!;
  const s4 = await provisionShop(t, { name: 'Bébé Oran', kind: 'store', planId: null, trialDays: 30, owner: { name: 'Karim', email: OWNER.email }, password: OWNER.password, verified: true });
  const r = await copyIntoNewBoutique(t, karim, s1.id, s4);
  assert.deepEqual(r.added, ['Yalidine', 'Livraison privée']);
  const d = t.shop(s4.schema);
  assert.deepEqual((await d.query(`SELECT credentials FROM delivery_companies WHERE name = 'Yalidine'`))[0].credentials, { api_id: 'ID-1', api_token: 'TOKEN-1' });
  assert.equal((await getSetting(d, 'shop')).name, 'Bébé Oran');
  // another person's boutique cannot be the model
  const nadia = (await accountByEmail(t, OTHER.email))!;
  await assert.rejects(copyIntoNewBoutique(t, nadia, s1.id, s3), /vos propres boutiques/);
  await assert.rejects(copyIntoNewBoutique(t, karim, s2.id, s2), /autre boutique/);
});
