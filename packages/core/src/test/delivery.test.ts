// Delivery + cash rules: sending (demo simulation), credentials never returned, cash receive, livreur scope, chat.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { fillJson } from '../couriers/custom';
import { resolveStatus } from '../couriers/load';
import { ADAPTERS } from '../couriers/adapters';
import { bestMatch } from '../couriers/util';
import { courierWordsAt } from '../modules/delivery';
import { autoSourceOf, courierWho, createOrder } from '../modules/orders';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(400));
});

const companyId = async (kind: string) => Number((await db.query('SELECT id FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1', [kind]))[0].id);

test('delivery.send in demo mode gives a tracking number and keeps the follow status', async () => {
  const admin = await as(EMAILS.admin);
  const yal = await companyId('yalidine');
  const o = (await db.query(`SELECT id, ref, follow_status FROM orders WHERE conf_status='confirmed' AND follow_status='prepared' AND tracking IS NULL LIMIT 1`))[0];
  await db.query('UPDATE orders SET company_id=$2 WHERE id=$1', [o.id, yal]);
  const r: any = await call('delivery.send', admin, { ids: [Number(o.id)] });
  assert.equal(r.sent, 1, JSON.stringify(r));
  assert.match(r.results[0].tracking, /^yal-[0-9A-Z]{6}$/); // the courier's own number, not the order's
  const after = (await db.query('SELECT tracking, follow_status, ext_status FROM orders WHERE id=$1', [o.id]))[0];
  assert.equal(after.tracking, r.results[0].tracking);
  assert.equal(after.follow_status, 'prepared');
  assert.ok(after.ext_status);
  // sending twice is refused per order
  const again: any = await call('delivery.send', admin, { ids: [Number(o.id)] });
  assert.equal(again.sent, 0);
});

test('delivery.send uses the server courier hook when present', async () => {
  const calls: unknown[] = [];
  const server = { courier: async (action: string, args: any) => (calls.push([action, args]), args.ids.map((id: number) => ({ id, ok: true, tracking: 'SRV-1', extId: 'x', labelUrl: null }))), meta: async () => null, hashPassword: async (s: string) => s };
  const depot = await as(EMAILS.depot, server as any);
  const zr = await companyId('zr');
  const o = (await db.query(`SELECT id FROM orders WHERE conf_status='confirmed' AND follow_status='to_prepare' AND tracking IS NULL LIMIT 1`))[0];
  const r: any = await call('delivery.send', depot, { ids: [Number(o.id)], companyId: zr });
  assert.equal(r.sent, 1);
  assert.equal((calls[0] as any)[0], 'send');
  assert.equal((await db.query('SELECT tracking, company_id FROM orders WHERE id=$1', [o.id]))[0].tracking, 'SRV-1');
});

test('credentials are write-only: never returned, hasKeys says if they are set', async () => {
  const admin = await as(EMAILS.admin);
  const c: any = await call('delivery.saveCompany', admin, { name: 'DHD test', kind: 'ecotrack', settings: { base_url: 'https://dhd.ecotrack.dz' }, secret: { token: 'SECRET-123' } });
  assert.equal(c.hasKeys, true);
  assert.deepEqual(c.keysSet, ['token']);
  const list: any[] = (await call('delivery.companies', admin, {})) as any[];
  const json = JSON.stringify(list);
  assert.ok(!json.includes('SECRET-123'));
  assert.ok(list.every((x) => !('credentials' in x) && !('secret' in x)));
  // saving again without keys keeps them
  const again: any = await call('delivery.saveCompany', admin, { id: c.id, name: 'DHD', kind: 'ecotrack', settings: { base_url: 'https://dhd.ecotrack.dz' }, secret: { token: '' } });
  assert.equal(again.hasKeys, true);
  const raw = (await db.query('SELECT credentials FROM delivery_companies WHERE id=$1', [c.id]))[0].credentials;
  assert.equal((typeof raw === 'string' ? JSON.parse(raw) : raw).token, 'SECRET-123');
  // only admins manage companies
  await assert.rejects(call('delivery.saveCompany', await as(EMAILS.suivi), { name: 'x', kind: 'manual' }), /Accès refusé/);
});

test('delivery.sync advances parcels on the road (demo)', async () => {
  const suivi = await as(EMAILS.suivi);
  const before = (await db.query(`SELECT count(*)::int n FROM orders WHERE follow_status='delivered'`))[0].n;
  let changed = 0;
  for (let i = 0; i < 3; i++) changed += ((await call('delivery.sync', suivi, {})) as any).changed;
  assert.ok(changed > 0);
  const after = (await db.query(`SELECT count(*)::int n FROM orders WHERE follow_status='delivered'`))[0].n;
  assert.ok(after >= before);
});

test('courier sync keeps each parcel’s original wording in the order history', async () => {
  const company = await companyId('zr');
  const parcels = await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND tracking IS NULL ORDER BY id DESC LIMIT 2`);
  assert.equal(parcels.length, 2);
  await db.query(`UPDATE orders SET company_id = $1, conf_status = 'confirmed', follow_status = 'shipped',
    tracking = 'ZR-HISTORY-' || id, shipped_at = now(), sub_status = NULL
    WHERE id = ANY($2)`, [company, parcels.map(parcel => Number(parcel.id))]);
  const labels = new Map([
    [Number(parcels[0].id), 'Dispatch vers agence'],
    [Number(parcels[1].id), 'Pris en charge par le livreur'],
  ]);
  const suivi = await as(EMAILS.suivi, {
    courier: async (action: string) => action === 'track'
      ? [...labels].map(([id, status]) => ({ id, status, mapped: 'out_for_delivery', at: null }))
      : [],
    meta: async () => null,
    hashPassword: async (value: string) => value,
  });
  await call('delivery.sync', suivi, { companyId: company });
  const events = await db.query(`SELECT DISTINCT ON (e.order_id) e.order_id, e.note, c.name
    FROM order_events e JOIN orders o ON o.id = e.order_id JOIN delivery_companies c ON c.id = o.company_id
    WHERE e.order_id = ANY($1) AND e.kind = 'follow_status' AND e.to_value = 'out_for_delivery'
    ORDER BY e.order_id, e.id DESC`, [[...labels.keys()]]);
  assert.equal(events.length, 2);
  for (const event of events) assert.equal(event.note, `${event.name} : ${labels.get(Number(event.order_id))}`);
});

test('courierWordsAt: the company’s words at a moment of its journey', () => {
  const t0 = Date.parse('2026-11-23T10:00:00Z');
  const m = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const steps = [
    { at: m(0), key: 'vers_wilaya', status: 'Vers wilaya', situations: [] },
    { at: m(60), key: 'sortie_en_livraison', status: 'Sortie en livraison', situations: [] },
    { at: m(120), key: 'echec_livraison', status: 'Échec de livraison', situations: [{ name: 'Client injoignable', at: m(121) }, { name: 'Reporté', at: m(200) }] },
    { at: m(125), key: 'sortie_en_livraison', status: 'Sortie en livraison', situations: [] },
  ];
  const leadsTo = (words: string, key: string | null) => resolveStatus(ADAPTERS.zr.statuses, {}, { key: key ?? undefined, status: words });
  const at = (min: number) => t0 + min * 60_000;
  assert.equal(courierWordsAt(steps, at(30), 'shipped', leadsTo), 'Vers wilaya');
  assert.equal(courierWordsAt(steps, at(65), 'out_for_delivery', leadsTo), 'Sortie en livraison');
  // the situation added by then, not the later one
  assert.equal(courierWordsAt(steps, at(123), 'failed', leadsTo), 'Échec de livraison · Client injoignable');
  // the company moved again while the sync was writing the line: the status that led there
  assert.equal(courierWordsAt(steps, at(127), 'failed', leadsTo), 'Échec de livraison · Client injoignable');
  // no status leads there (ZR's « retour » is told apart from the status): the status of that moment
  assert.equal(courierWordsAt(steps, at(30), 'returning', leadsTo), 'Vers wilaya');
  // the journey starts after the line: not this parcel's status
  assert.equal(courierWordsAt(steps, at(-30), 'shipped', leadsTo), null);
  // the reason ZR gave under an earlier step and kept on the parcel (Préférences send it to the alerts)
  const own = { 'Sortie en livraison · Appel téléphonique': 'alert', 'Sortie en livraison · Ne répond pas 2': 'alert' };
  const kept = [
    { at: m(0), key: 'en_livraison', status: 'En livraison', situations: [{ name: 'Appel téléphonique', at: m(30) }] },
    { at: m(60), key: 'sortie_en_livraison', status: 'Sortie en livraison', situations: [] },
    { at: m(120), key: 'dispatch', status: 'Dispatch dans une autre wilaya', situations: [] },
  ];
  const leadsOwn = (words: string, key: string | null) => resolveStatus(ADAPTERS.zr.statuses, own, { key: key ?? undefined, status: words });
  assert.equal(courierWordsAt(kept, at(90), 'alert', leadsOwn), 'Sortie en livraison · Appel téléphonique');
  // the step alone when that is what led there
  assert.equal(courierWordsAt(kept, at(90), 'out_for_delivery', leadsOwn), 'Sortie en livraison');
  // nothing tells (ZR's « retour » is told apart from its status): the status with the last reason ZR gave
  assert.equal(courierWordsAt(kept, at(125), 'returning', leadsOwn), 'Dispatch dans une autre wilaya · Appel téléphonique');
});

test('old « Statut ZR » history lines get the courier’s words of that moment (server sync, a few each run)', async () => {
  const zrId = await companyId('zr');
  const name = String((await db.query('SELECT name FROM delivery_companies WHERE id = $1', [zrId]))[0].name);
  const old = `Statut ${name}`;
  await db.query(`DELETE FROM settings WHERE key LIKE 'courier_notes_filled%'`);
  const rows = await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND tracking IS NULL ORDER BY id DESC LIMIT 4`);
  assert.equal(rows.length, 4);
  const [a, gone, later, onlyOne] = rows.map((r: any) => Number(r.id));
  await db.query(`UPDATE orders SET company_id = $1, conf_status = 'confirmed', follow_status = 'failed', tracking = 'ZR-OLD-' || id, ext_id = 'uuid-' || id, shipped_at = now() WHERE id = ANY($2)`, [
    zrId,
    [a, gone, later, onlyOne],
  ]);
  const now = Date.now();
  const h = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const line = (orderId: number, at: string, from: string, to: string) =>
    db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note, data, at) VALUES ($1, NULL, 'follow_status', $2, $3, $4, '{"courier":true}', $5)`, [orderId, from, to, old, at]);
  await line(a, h(5), 'prepared', 'shipped');
  await line(a, h(3), 'shipped', 'out_for_delivery');
  await line(a, h(1), 'out_for_delivery', 'failed');
  await line(gone, h(2), 'prepared', 'shipped');
  await line(later, h(2), 'prepared', 'shipped');
  await line(onlyOne, h(4), 'prepared', 'shipped');
  // a line an agent wrote by hand is never touched
  await db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note, at) VALUES ($1, NULL, 'follow_status', 'failed', 'alert', 'Client injoignable', $2)`, [a, h(0.5)]);
  const journey = () => [
    { at: new Date(now - 5.5 * 3_600_000).toISOString(), key: 'vers_wilaya', status: 'Vers wilaya', situations: [] },
    { at: new Date(now - 3.2 * 3_600_000).toISOString(), key: 'sortie_en_livraison', status: 'Sortie en livraison', situations: [] },
    { at: new Date(now - 1.1 * 3_600_000).toISOString(), key: 'echec_livraison', status: 'Échec de livraison', situations: [{ name: 'Client injoignable', at: new Date(now - 1.05 * 3_600_000).toISOString() }] },
  ];
  let laterUp = false;
  const asked: number[] = [];
  const server = {
    courier: async (action: string, args: any) => {
      if (action === 'track') return [];
      if (action !== 'steps') throw new Error('pas dans ce test');
      asked.push(args.item.id);
      if (args.item.id === gone) throw Object.assign(new Error('ZR : introuvable'), { status: 404 });
      if (args.item.id === later && !laterUp) throw Object.assign(new Error('ZR : erreur 502'), { status: 502 });
      return journey();
    },
    meta: async () => null,
    hashPassword: async (value: string) => value,
  };
  const admin = await as(EMAILS.admin, server as any);
  const notes = async (orderId: number) => (await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'follow_status' ORDER BY at`, [orderId])).map((r: any) => r.note);
  // an agent's « Actualiser » never does it (it stays quick)
  await call('delivery.sync', admin, { fast: true });
  assert.equal(asked.length, 0);
  const r: any = await call('delivery.sync', admin, { fast: true, oldNotes: true });
  assert.deepEqual(r.oldNotes, { filled: 4, notFound: 1, left: true });
  assert.deepEqual((await notes(a)).slice(-4), [`${name} : Vers wilaya`, `${name} : Sortie en livraison`, `${name} : Échec de livraison · Client injoignable`, 'Client injoignable']);
  assert.deepEqual(await notes(gone), [`${name} : statut non retrouvé`]);
  // still the company's (« ↶ Annuler » refuses it, the history shows the company), the hand-written line untouched
  const marks = await db.query(`SELECT note, data->>'courier' AS courier, data->>'by' AS by FROM order_events WHERE order_id = $1 AND kind = 'follow_status' ORDER BY at`, [a]);
  assert.deepEqual(marks.slice(-4).map((m: any) => [m.courier, m.by]), [['true', name], ['true', name], ['true', name], [null, null]]);
  assert.deepEqual(await notes(onlyOne), [`${name} : Vers wilaya`]);
  // ZR did not answer for this one: asked again at the next run
  assert.deepEqual(await notes(later), [old]);
  assert.equal((await db.query(`SELECT data->>'noteTries' AS n FROM order_events WHERE order_id = $1 AND kind = 'follow_status'`, [later]))[0].n, '1');
  laterUp = true;
  const r2: any = await call('delivery.sync', admin, { fast: true, oldNotes: true });
  assert.deepEqual(r2.oldNotes, { filled: 1, notFound: 0, left: true });
  // 2 h ago ZR said « Sortie en livraison » (it led elsewhere, but it is what ZR said then)
  assert.deepEqual(await notes(later), [`${name} : Sortie en livraison`]);
  // nothing left: the search stops for good (one look at a mark, no question to ZR)
  const r3: any = await call('delivery.sync', admin, { fast: true, oldNotes: true });
  assert.deepEqual(r3.oldNotes, { filled: 0, notFound: 0, left: false });
  const before = asked.length;
  await db.query(`UPDATE order_events SET note = $2 WHERE order_id = $1 AND kind = 'follow_status'`, [onlyOne, old]);
  const r4: any = await call('delivery.sync', admin, { fast: true, oldNotes: true });
  assert.deepEqual(r4.oldNotes, { filled: 0, notFound: 0, left: false });
  assert.equal(asked.length, before);
});

test('lines filled before the reason kept from an earlier step was read are filled again, once', async () => {
  const zrId = await companyId('zr');
  const name = String((await db.query('SELECT name FROM delivery_companies WHERE id = $1', [zrId]))[0].name);
  const cfg = (await db.query('SELECT config FROM delivery_companies WHERE id = $1', [zrId]))[0].config;
  await db.query(`UPDATE delivery_companies SET config = $2 WHERE id = $1`, [zrId, JSON.stringify({ ...(typeof cfg === 'string' ? JSON.parse(cfg) : cfg ?? {}), statusMap: { 'Sortie en livraison · Appel téléphonique': 'alert' } })]);
  await db.query(`DELETE FROM settings WHERE key LIKE 'courier_notes_filled%'`);
  await db.query(`SELECT ensure_events_partition('2026-11-24'::date)`);
  const id = Number((await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND tracking IS NULL ORDER BY id DESC OFFSET 8 LIMIT 1`))[0].id);
  await db.query(`UPDATE orders SET company_id = $1, conf_status = 'confirmed', follow_status = 'alert', tracking = 'ZR-AGAIN-' || id, ext_id = 'uuid-again-' || id, shipped_at = now() WHERE id = $2`, [zrId, id]);
  const line = async (at: string, from: string, to: string, note: string, data: object) =>
    Number((await db.query(`INSERT INTO order_events (order_id, kind, from_value, to_value, note, data, at) VALUES ($1, 'follow_status', $2, $3, $4, $5, $6) RETURNING id`, [id, from, to, note, JSON.stringify(data), at]))[0].id);
  // filled this afternoon by the first version: the reason is missing
  const first = await line('2026-11-24T07:54:19Z', 'shipped', 'out_for_delivery', `${name} : En livraison`, { courier: true, by: name });
  const alert = await line('2026-11-24T10:30:03Z', 'out_for_delivery', 'alert', `${name} : Sortie en livraison`, { courier: true, by: name });
  // written live with ZR's own words since: never touched
  const live = await line('2026-11-24T13:45:00Z', 'alert', 'returning', `${name} : Dispatch dans une autre wilaya · Commande annulée`, { courier: true });
  const server = {
    courier: async (action: string) => {
      if (action === 'track') return [];
      if (action !== 'steps') throw new Error('pas dans ce test');
      return [
        { at: '2026-11-24T07:50:00.000Z', key: 'en_livraison', status: 'En livraison', situations: [{ name: 'Appel téléphonique', at: '2026-11-24T09:10:00.000Z' }] },
        { at: '2026-11-24T09:40:00.000Z', key: 'sortie_en_livraison', status: 'Sortie en livraison', situations: [] },
      ];
    },
    meta: async () => null,
    hashPassword: async (value: string) => value,
  };
  const admin = await as(EMAILS.admin, server as any);
  await call('delivery.sync', admin, { fast: true, oldNotes: true });
  const note = async (eid: number) => (await db.query('SELECT note, data FROM order_events WHERE id = $1', [eid]))[0];
  assert.equal((await note(first)).note, `${name} : En livraison`);
  assert.equal((await note(alert)).note, `${name} : Sortie en livraison · Appel téléphonique`);
  assert.equal((await note(live)).note, `${name} : Dispatch dans une autre wilaya · Commande annulée`);
  assert.equal((await note(alert)).data.noteFill, 2);
  // done once: the next run asks ZR nothing more for it
  const again: any = await call('delivery.sync', admin, { fast: true, oldNotes: true });
  assert.equal(again.oldNotes.filled, 0);
  await db.query(`UPDATE delivery_companies SET config = $2 WHERE id = $1`, [zrId, typeof cfg === 'string' ? cfg : JSON.stringify(cfg ?? {})]);
});

test('autoSourceOf / courierWho: the words shown in place of a name', () => {
  assert.equal(autoSourceOf({ landing: true, source: 'Landing · velo-star' }), 'Page de vente « velo-star »');
  assert.equal(autoSourceOf({ landing: true, source: 'Landing · velo-star · abandonnée' }), 'Page de vente « velo-star » (abandonnée)');
  assert.equal(autoSourceOf({ landing: true, source: 'Landing · abandonnée' }), 'Page de vente (abandonnée)');
  assert.equal(autoSourceOf({ chat: true, source: 'Dellal · messenger · pub 1234' }), 'Dellal · Messenger');
  assert.equal(autoSourceOf({ chat: true, source: 'Dellal · instagram · commande auto' }), 'Dellal · Instagram · commande auto');
  assert.equal(autoSourceOf({ lead: true, source: 'Formulaire « Vélo »' }), 'Formulaire Meta « Vélo »');
  assert.equal(autoSourceOf({ sheet: true, source: 'Commandes site' }), 'Google Sheets « Commandes site »');
  assert.equal(autoSourceOf({ site: true, source: 'site' }), 'Site web');
  assert.equal(autoSourceOf({ site: true, source: 'Ma boutique Woo' }), 'Site « Ma boutique Woo »');
  // typed by a person (the form, a duplicate, an SAV exchange): their name stays
  assert.equal(autoSourceOf({ source: 'Landing · velo-star' }), null);
  assert.equal(courierWho('follow_status', 'Statut ZR', null, 'ZR Express'), 'ZR');
  assert.equal(courierWho('follow_status', 'ZR : En livraison', { courier: true }, 'ZR'), 'ZR');
  assert.equal(courierWho('follow_status', 'Payé par la société (paiement P1)', null, 'ZR'), 'ZR');
  assert.equal(courierWho('follow_status', 'Client injoignable', { prev: {} }, 'ZR'), null);
  assert.equal(courierWho('note', 'Statut ZR', null, 'ZR'), null);
});

test('history: ZR’s statuses say « ZR », an order that came by itself says where from — never the server’s account', async () => {
  const zrId = await companyId('zr');
  const company = String((await db.query('SELECT name FROM delivery_companies WHERE id = $1', [zrId]))[0].name);
  const admin = await as(EMAILS.admin);
  const adminName = String((await db.query('SELECT name FROM profiles WHERE email = $1', [EMAILS.admin]))[0].name);
  const lines = async (orderId: number) => (await call('orders.events', admin, { id: orderId })) as any[];
  // a new status from ZR's sync
  const [moved, old] = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND tracking IS NULL ORDER BY id DESC OFFSET 4 LIMIT 2`)).map((r: any) => Number(r.id));
  await db.query(`UPDATE orders SET company_id = $1, conf_status = 'confirmed', follow_status = 'shipped', tracking = 'ZR-WHO-' || id, shipped_at = now(), sub_status = NULL WHERE id = ANY($2)`, [zrId, [moved, old]]);
  const server = {
    courier: async (action: string) => (action === 'track' ? [{ id: moved, status: 'Sortie en livraison', mapped: 'out_for_delivery', at: null }] : []),
    meta: async () => null,
    hashPassword: async (value: string) => value,
  };
  await call('delivery.sync', await as(EMAILS.suivi, server as any), { companyId: zrId });
  const fromZr = (await lines(moved)).filter((e) => e.kind === 'follow_status').pop();
  assert.equal(fromZr.note, `${company} : Sortie en livraison`);
  assert.equal(fromZr.userName, company);
  assert.equal(fromZr.userId, null);
  // a line written before (« Statut ZR », under the server's account): ZR too
  const adminId = Number((await db.query('SELECT id FROM profiles WHERE email = $1', [EMAILS.admin]))[0].id);
  await db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note) VALUES ($1, $2, 'follow_status', 'shipped', 'out_for_delivery', 'Statut ZR')`, [old, adminId]);
  assert.equal((await lines(old)).filter((e) => e.kind === 'follow_status').pop().userName, 'ZR');
  // a person's own change keeps his name
  await call('orders.setFollow', admin, { ids: [old], status: 'alert', note: 'Client injoignable' });
  const byHand = (await lines(old)).filter((e) => e.kind === 'follow_status').pop();
  assert.equal(byHand.userName, adminName);
  assert.equal(byHand.userId, adminId);

  // an order from a landing page: « Page de vente « slug » », not the account the server works with
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.active AND v.active ORDER BY p.id LIMIT 1`))[0];
  const page = (await db.query(`SELECT id, slug FROM landing_pages ORDER BY id LIMIT 1`))[0];
  const item = { productId: Number(p.id), variantId: Number(p.vid), qty: 1 };
  const base = { customerName: 'Client page', wilayaId: 16, commune: 'Kouba', address: '', isStopdesk: false, items: [item], discount: 0, confirm: false, isExchange: false };
  const fromPage = await createOrder(admin, { ...base, phone: '0555 11 22 01', channel: 'landing', source: `Landing · ${page.slug}` } as any, db, { landingId: Number(page.id) });
  const created = (await lines(fromPage.id)).find((e) => e.kind === 'created');
  assert.equal(created.userName, `Page de vente « ${page.slug} »`);
  assert.equal(created.userId, null);
  // one made before the line said so (no « by » on it): found from the order itself
  await db.query(`UPDATE order_events SET data = NULL WHERE order_id = $1 AND kind = 'created'`, [fromPage.id]);
  assert.equal((await lines(fromPage.id)).find((e) => e.kind === 'created').userName, `Page de vente « ${page.slug} »`);
  // a Google Sheet's line, the shop's site
  const fromSheet = await createOrder(admin, { ...base, phone: '0555 11 22 02', channel: 'autre', source: 'Commandes site' } as any, db, { sheet: true });
  assert.equal((await lines(fromSheet.id)).find((e) => e.kind === 'created').userName, 'Google Sheets « Commandes site »');
  const fromSite = await createOrder(admin, { ...base, phone: '0555 11 22 03', channel: 'site', source: 'site', via: 'api' } as any, db);
  assert.equal((await lines(fromSite.id)).find((e) => e.kind === 'created').userName, 'Site web');
  // typed by a person: his name
  const typed: any = await call('orders.create', admin, { customerName: 'Client tapé', phone: '0555 11 22 04', wilayaId: 16, commune: 'Kouba', items: [item] });
  const mine = (await lines(typed.id)).find((e) => e.kind === 'created');
  assert.equal(mine.userName, adminName);
  assert.equal(mine.userId, adminId);
});

test('fees grid and status mapping', async () => {
  const admin = await as(EMAILS.admin);
  // a company with prices by API: they are its own, never typed here
  const yal = await companyId('yalidine');
  await assert.rejects(call('delivery.saveFees', admin, { companyId: yal, rows: [{ wilayaId: 16, home: 350, desk: 250, returnFee: 100 }] }), /viennent de son API/);
  const man = await companyId('manual');
  await call('delivery.saveFees', admin, { companyId: man, rows: [{ wilayaId: 16, home: 350, desk: 250, returnFee: 100 }] });
  const fees: any[] = (await call('delivery.fees', admin, { companyId: man })) as any[];
  assert.equal(fees.length, 69);
  assert.deepEqual(fees[15], { wilayaId: 16, name: 'Alger', home: 350, desk: 250, returnFee: 100 });
  assert.equal(resolveStatus(ADAPTERS.yalidine.statuses, {}, { status: 'Livré' }), 'delivered');
  assert.equal(resolveStatus(ADAPTERS.yalidine.statuses, { 'Livré': 'returned' }, { status: 'Livré' }), 'returned');
  assert.equal(resolveStatus(ADAPTERS.ecotrack.statuses, {}, { key: 'en_livraison', status: 'En livraison · client absent' }), 'out_for_delivery');
  assert.equal(bestMatch('Bab Ezzouar', ['BAB-EZZOUAR', 'Bordj El Kiffan']), 'BAB-EZZOUAR');
  assert.equal(fillJson('{"a":"{{ref}}","n":{{total}}}', { ref: 'PX"1', total: 5 }), '{"a":"PX\\"1","n":5}');
});

test('cash.receive creates a versement and marks the orders cashed; cancel puts them back', async () => {
  const admin = await as(EMAILS.admin);
  const due: any = await call('cash.due', admin, {});
  const g = due.groups.find((x: any) => !x.livreurId && x.count >= 2);
  const oids = g.orders.slice(0, 2).map((o: any) => o.id);
  const r: any = await call('cash.receive', admin, { ids: oids });
  assert.equal(r.handovers.length, 1);
  const rows = await db.query('SELECT cashed, handover_id FROM orders WHERE id = ANY($1)', [oids]);
  assert.ok(rows.every((x: any) => x.cashed && Number(x.handover_id) === r.handovers[0]));
  const h = (await db.query('SELECT collected, fees, net FROM cash_handovers WHERE id=$1', [r.handovers[0]]))[0];
  assert.equal(Number(h.net), g.orders.slice(0, 2).reduce((s: number, o: any) => s + o.net, 0));
  await assert.rejects(call('cash.receive', admin, { ids: oids }), /déjà encaissée/);
  const hist: any[] = (await call('cash.history', admin, {})) as any[];
  assert.ok(hist.some((x) => x.id === r.handovers[0] && x.orders.length === 2));
  await call('cash.cancel', admin, { handoverId: r.handovers[0] });
  assert.ok((await db.query('SELECT cashed FROM orders WHERE id = ANY($1)', [oids])).every((x: any) => !x.cashed));
  await assert.rejects(call('cash.due', await as(EMAILS.suivi), {}), /Accès refusé/);
});

test('a livreur only sees his own round, cash and chat', async () => {
  const lamine = await as(EMAILS.livreur);
  const me = lamine.session.profile.id;
  const t: any = await call('delivery.tournee', lamine, {});
  assert.ok(t.toDeliver.length > 0);
  assert.ok([...t.toDeliver, ...t.pickup].every((o: any) => o.livreurId === me));
  const walid = Number((await db.query(`SELECT id FROM profiles WHERE email='walid@demo.pilotix.dz'`))[0].id);
  const t2: any = await call('delivery.tournee', lamine, { livreurId: walid });
  assert.equal(t2.livreur.id, me);
  const cash: any = await call('cash.livreurs', lamine, {});
  assert.deepEqual(cash.livreurs.map((l: any) => l.id), [me]);
  await assert.rejects(call('cash.chat', lamine, { livreurId: walid }), /Accès refusé/);
  await call('cash.chatSend', lamine, { body: 'Bonjour le bureau' });
  const suivi = await as(EMAILS.suivi);
  const msgs: any[] = (await call('cash.chat', suivi, { livreurId: me })) as any[];
  assert.ok(msgs.some((m) => m.body === 'Bonjour le bureau' && m.fromLivreur));
  await call('cash.chatSend', suivi, { livreurId: me, body: 'Bien reçu' });
  // livreur marks a parcel delivered with orders.setFollow
  const o = t.toDeliver[0];
  await call('orders.setFollow', lamine, { ids: [o.id], status: 'delivered' });
  const other = (await db.query(`SELECT id FROM orders WHERE livreur_id <> $1 AND follow_status='out_for_delivery' LIMIT 1`, [me]))[0];
  if (other) await assert.rejects(call('orders.setFollow', lamine, { ids: [Number(other.id)], status: 'delivered' }));
  // the office collects Lamine's cash, his share kept
  const admin = await as(EMAILS.admin);
  const r: any = await call('cash.livreurCollect', admin, { livreurId: me, all: true });
  assert.ok(r.orders >= 1);
  const h = (await db.query('SELECT fees, collected, net FROM cash_handovers WHERE id=$1', [r.handovers[0]]))[0];
  assert.ok(Number(h.fees) > 0 && Number(h.net) === Number(h.collected) - Number(h.fees));
});

test('route sheet and preview', async () => {
  const lamine = await as(EMAILS.livreur);
  const s: any = await call('delivery.routeSheet', lamine, {});
  assert.ok(s.orders.length > 0);
  const admin = await as(EMAILS.admin);
  const c: any = await call('delivery.saveCompany', admin, {
    name: 'Ma société API', kind: 'custom', secret: { token: 'abcdef123' },
    settings: { base_url: 'https://api.example.dz', auth: { name: 'Authorization', prefix: 'Bearer ' }, create: { method: 'POST', path: '/orders', format: 'json', body: '{"ref":"{{ref}}","amount":{{total}}}', tracking_path: 'data.tracking' } },
  });
  const p: any = await call('delivery.preview', admin, { companyId: c.id });
  assert.equal(p.request.url, 'https://api.example.dz/orders');
  assert.equal(p.request.headers.Authorization, 'Bearer…');
  assert.equal(typeof p.request.body.amount, 'number');
});
