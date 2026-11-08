// Point de vente: off until an administrator turns it on (Management › Modules); a sale priced from the catalogue with
// its packs, out of the counter's dépôt, its money into « Caisse boutique » (or the caisse Réglages gives its payment);
// cancelling; the clôture and its gap; the customer at the counter; the counter of the preview opened in Claude.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { packTotal } from '@pilotix/shared';
import { call, Ctx, Db, seedPos } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(250));
});

const bal = async (ctx: Ctx, caisse: string) => ((await call('caisse.view', ctx, { caisse })) as any).balance as number;
const qty = async (variantId: number, warehouseId: number) => Number((await db.query('SELECT qty FROM stock WHERE variant_id = $1 AND warehouse_id = $2', [variantId, warehouseId]))[0]?.qty ?? 0);
const variantOf = (st: any, sku: string, title = '') => st.products.find((p: any) => p.sku === sku).variants.find((v: any) => v.title === title).id as number;

test('off until an administrator turns it on in Management › Modules; only an administrator turns it on or off', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const vendeur = await as(EMAILS.vendeur);
  assert.deepEqual(await call('modules.get', karim, {}), { pos: false });
  await assert.rejects(call('pos.state', admin, {}), /Point de vente est éteint/);
  await assert.rejects(call('pos.sell', admin, { lines: [{ variantId: 1, qty: 1 }], method: 'cash' }), /éteint/);
  await assert.rejects(call('pos.close', karim, { counted: 0 }), /éteint/);
  await assert.rejects(call('modules.set', karim, { module: 'pos', on: true }), /Accès refusé/);
  await assert.rejects(call('modules.set', vendeur, { module: 'pos', on: true }), /Accès refusé/);
  await assert.rejects(call('modules.set', admin, { module: 'gps', on: true }), /Champ invalide/);
  assert.deepEqual(await call('modules.set', admin, { module: 'pos', on: true }), { pos: true });
  assert.deepEqual(await call('modules.get', karim, {}), { pos: true });
  // off again: refused again, its sales and settings kept for the day it comes back
  await call('modules.set', admin, { module: 'pos', on: false });
  await assert.rejects(call('pos.state', karim, {}), /éteint/);
});

test('packTotal: packs as many times as they help, singles for the rest', () => {
  assert.deepEqual(packTotal(1500, 3, [{ qty: 3, price: 3900 }]), { total: 3900, saved: 600, packs: [{ qty: 3, times: 1 }] });
  assert.equal(packTotal(1500, 5, [{ qty: 3, price: 3900 }]).total, 3900 + 2 * 1500);
  const two = [{ qty: 2, price: 5200 }, { qty: 3, price: 7500 }];
  assert.equal(packTotal(2900, 4, two).total, 10400);
  assert.equal(packTotal(2900, 6, two).total, 15000);
  assert.deepEqual(packTotal(2900, 6, two).packs, [{ qty: 3, times: 2 }]);
  assert.equal(packTotal(2900, 1, two).total, 2900);
  // a « pack » dearer than the singles is never used
  assert.equal(packTotal(1000, 2, [{ qty: 2, price: 2500 }]).total, 2000);
  assert.equal(packTotal(1000, 0, two).total, 0);
});

test('a sale: priced from the catalogue with its packs, out of the counter dépôt, its money into « Caisse boutique »', async () => {
  const admin = await as(EMAILS.admin);
  await call('modules.set', admin, { module: 'pos', on: true });
  const st: any = await call('pos.state', admin, {});
  assert.equal(st.caisse.key, null, '« Caisse boutique » is made on the first sale');
  assert.equal(st.session, null);
  assert.equal(st.next, '0001');
  assert.ok(st.manage);
  const bib = variantOf(st, 'PX-BIB');
  const pou = variantOf(st, 'PX-POU', 'Gris');
  const b0 = await qty(bib, st.depot.id);
  const p0 = await qty(pou, st.depot.id);
  // the same product twice on the ticket: one line, the pack counted on the whole quantity
  const sale: any = await call('pos.sell', admin, { lines: [{ variantId: bib, qty: 2 }, { variantId: pou, qty: 1 }, { variantId: bib, qty: 1 }], method: 'cash' });
  assert.equal(sale.no, '0001');
  assert.equal(sale.total, 3900 + 12900);
  assert.equal(sale.saved, 600);
  assert.equal(sale.items, 4);
  assert.deepEqual(sale.lines.map((l: any) => [l.sku, l.variant, l.qty, l.unit, l.total]), [['PX-BIB-1', '', 3, 1500, 3900], ['PX-POU-1', 'Gris', 1, 12900, 12900]]);
  assert.equal(await qty(bib, st.depot.id), b0 - 3);
  assert.equal(await qty(pou, st.depot.id), p0 - 1);
  const mv = await db.query(`SELECT reason, note, delta FROM stock_movements WHERE variant_id = $1 ORDER BY id DESC LIMIT 1`, [bib]);
  assert.deepEqual([mv[0].reason, mv[0].note, Number(mv[0].delta)], ['pos_sale', 'Vente n° 0001', -3]);
  const after: any = await call('pos.state', admin, {});
  assert.match(after.caisse.key, /^c\d+$/);
  assert.equal(after.caisse.name, 'Caisse boutique');
  assert.equal(sale.caisse.key, after.caisse.key);
  assert.equal(await bal(admin, after.caisse.key), 16800);
  const v: any = await call('caisse.view', admin, { caisse: after.caisse.key });
  assert.match(JSON.stringify(v.moves), /Vente n° 0001 · Espèces/);
  // the drawer opened by itself with no float
  assert.equal(after.session.opening, 0);
  assert.deepEqual(after.today, { sales: 1, items: 4, total: 16800, by: { cash: 16800, baridimob: 0, card: 0 } });
  assert.equal(after.next, '0002');
  // a product no longer for sale is refused
  await db.query(`UPDATE products SET active = false WHERE sku = 'PX-THE'`);
  await assert.rejects(call('pos.sell', admin, { lines: [{ variantId: variantOf(st, 'PX-THE'), qty: 1 }], method: 'cash' }), /plus en vente/);
  await db.query(`UPDATE products SET active = true WHERE sku = 'PX-THE'`);
});

test('Réglages: the dépôt and the caisse of each payment; depot staff sell but neither change them nor cancel', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const st: any = await call('pos.state', karim, {});
  assert.equal(st.manage, false);
  const oran = (await db.query(`SELECT id FROM warehouses WHERE name = 'Dépôt Oran'`))[0].id;
  const set = { warehouseId: Number(oran), into: { cash: null, baridimob: 'bank', card: null }, title: 'Bébé Confort', phone: '0550 11 22 33', address: 'Bab Ezzouar', footer: 'Échange sous 7 jours', autoPrint: true };
  await assert.rejects(call('pos.settings', karim, set), /Accès refusé/);
  await assert.rejects(call('pos.settings', admin, { ...set, into: { ...set.into, card: 'c999999' } }), /Caisse inconnue/);
  await call('pos.settings', admin, set);
  const st2: any = await call('pos.state', karim, {});
  assert.equal(st2.depot.name, 'Dépôt Oran');
  assert.equal(st2.into.baridimob.key, 'bank');
  assert.equal(st2.into.cash.key, st2.caisse.key);
  assert.equal(st2.ticket.title, 'Bébé Confort');
  assert.equal(st2.ticket.autoPrint, true);
  const ens = variantOf(st2, 'PX-ENS', '3-6 mois');
  const bank0 = await bal(admin, 'bank');
  const o0 = await qty(ens, Number(oran));
  const sale: any = await call('pos.sell', karim, { lines: [{ variantId: ens, qty: 2 }], method: 'baridimob' });
  assert.equal(sale.total, 5200);
  assert.equal(sale.seller, 'Karim');
  assert.equal(await bal(admin, 'bank'), bank0 + 5200);
  assert.equal(await qty(ens, Number(oran)), o0 - 2, 'out of the dépôt chosen in Réglages (negative stock allowed: the product is on the counter)');
  await assert.rejects(call('pos.cancel', karim, { id: sale.id }), /Accès refusé/);
  // back to the default dépôt for the next tests
  await call('pos.settings', admin, { ...set, warehouseId: null, into: { cash: null, baridimob: null, card: null } });
});

test('cancelling a sale puts its products back and takes its money out of the caisse', async () => {
  const admin = await as(EMAILS.admin);
  const st: any = await call('pos.state', admin, {});
  const sac = variantOf(st, 'PX-SAC', 'Noir');
  const s0 = await qty(sac, st.depot.id);
  const c0 = await bal(admin, st.caisse.key);
  const sale: any = await call('pos.sell', admin, { lines: [{ variantId: sac, qty: 1 }], method: 'card' });
  assert.equal(await bal(admin, st.caisse.key), c0 + 4500);
  const back: any = await call('pos.cancel', admin, { id: sale.id });
  assert.ok(back.cancelledAt);
  assert.equal(await qty(sac, st.depot.id), s0);
  assert.equal(await bal(admin, st.caisse.key), c0);
  await assert.rejects(call('pos.cancel', admin, { id: sale.id }), /déjà annulée/);
  const day: any = await call('pos.sales', admin, {});
  assert.equal(day.cancelled, 1);
  assert.equal(day.count, 2);
  assert.equal(day.total, 16800 + 5200);
  assert.deepEqual(day.by, { cash: 16800, baridimob: 5200, card: 0 });
  assert.equal(day.sales[0].no, '0003');
});

test('the clôture: the cash counted against the float + the cash sales; a gap needs a note and goes into the caisse', async () => {
  const admin = await as(EMAILS.admin);
  await assert.rejects(call('pos.open', admin, { opening: 5000 }), /déjà ouverte/);
  const d: any = await call('pos.drawer', admin, {});
  assert.equal(d.open.expected, 16800, 'opening 0 + the cash sales (the card sale was cancelled, BaridiMob is not in the drawer)');
  assert.equal(d.open.sales, 2);
  const caisse = ((await call('pos.state', admin, {})) as any).caisse.key;
  const c0 = await bal(admin, caisse);
  await assert.rejects(call('pos.close', admin, { counted: 16700 }), /raison de l’écart/);
  await assert.rejects(call('pos.close', admin, { counted: 16700, counts: { '2000': 8 }, note: 'x' }), /ne correspond pas/);
  const c: any = await call('pos.close', admin, { counted: 16700, counts: { '2000': 8, '500': 1, '200': 1 }, note: 'Monnaie rendue en trop' });
  assert.equal(c.gap, -100);
  assert.equal(await bal(admin, caisse), c0 - 100);
  const v: any = await call('caisse.view', admin, { caisse });
  assert.match(JSON.stringify(v.moves), /Écart à la clôture · Monnaie rendue en trop/);
  const d2: any = await call('pos.drawer', admin, {});
  assert.equal(d2.open, null);
  assert.deepEqual([d2.closed[0].expected, d2.closed[0].counted, d2.closed[0].gap, d2.closed[0].sales], [16800, 16700, -100, 2]);
  // a closed drawer's sale is not cancelled any more; a new drawer counts from its own float
  const first = ((await call('pos.sales', admin, {})) as any).sales.find((s: any) => s.no === '0001');
  await assert.rejects(call('pos.cancel', admin, { id: first.id }), /clôturée/);
  await call('pos.open', admin, { opening: 5000 });
  const st: any = await call('pos.state', admin, {});
  await call('pos.sell', admin, { lines: [{ variantId: variantOf(st, 'PX-THE'), qty: 1 }], method: 'cash' });
  const d3: any = await call('pos.drawer', admin, {});
  assert.deepEqual([d3.open.opening, d3.open.by.cash, d3.open.expected], [5000, 2400, 7400]);
  // a gap-free clôture needs no note
  await call('pos.close', admin, { counted: 7400 });
  assert.equal(((await call('pos.drawer', admin, {})) as any).closed[0].gap, 0);
});

test('the customer at the counter: found by his phone with his level, or added', async () => {
  const admin = await as(EMAILS.admin);
  const c = (await db.query('SELECT id, name, phone FROM customers WHERE delivered > 0 ORDER BY id LIMIT 1'))[0];
  const intl = `+213 ${String(c.phone).slice(1, 4)} ${String(c.phone).slice(4)}`;
  const f: any = await call('pos.client', admin, { phone: intl });
  assert.equal(f.customer.id, Number(c.id));
  assert.equal(f.customer.name, c.name);
  assert.ok(['top', 'good', 'watch', 'risk', 'new'].includes(f.customer.level));
  assert.equal(((await call('pos.client', admin, { phone: '0699 00 00 01' })) as any).customer, null);
  await assert.rejects(call('pos.client', admin, { phone: '12345678' }), /invalide/);
  const n: any = await call('pos.clientNew', admin, { name: 'Amina Boudiaf', phone: '0699 00 00 01' });
  const st: any = await call('pos.state', admin, {});
  const sale: any = await call('pos.sell', admin, { lines: [{ variantId: variantOf(st, 'PX-TAP'), qty: 1 }], method: 'cash', customerId: n.id });
  assert.deepEqual(sale.customer, { id: n.id, name: 'Amina Boudiaf', phone: '0699000001' });
  // the same phone again keeps the customer and his name
  assert.equal(((await call('pos.clientNew', admin, { name: 'Autre nom', phone: '0699000001' })) as any).name, 'Amina Boudiaf');
});

test('the counter of the preview opened in Claude: on, yesterday closed 100 DA short, today open with 5 000 DA and six sales', async () => {
  const { db: demo, as: asDemo } = await setup(120);
  // 15:00 in Algiers
  const NOW = Date.UTC(2026, 10, 7, 14, 0);
  await seedPos(demo, NOW);
  await seedPos(demo, NOW);
  const admin = { ...(await asDemo(EMAILS.admin)), now: () => NOW };
  assert.deepEqual(await call('modules.get', admin, {}), { pos: true });
  const d: any = await call('pos.drawer', admin, {});
  assert.equal(d.open.opening, 5000);
  assert.equal(d.open.who, 'Karim', 'who opened the drawer (its sales by payment are `by`)');
  assert.equal(d.open.sales, 6);
  assert.deepEqual(d.open.by, { cash: 34600, baridimob: 5200, card: 3900 });
  assert.equal(d.open.expected, 39600);
  assert.equal(d.closed.length, 1);
  assert.deepEqual([d.closed[0].sales, d.closed[0].expected, d.closed[0].gap], [5, 28200, -100]);
  assert.equal(d.closed[0].who, 'Karim');
  const day: any = await call('pos.sales', admin, {});
  assert.equal(day.count, 6, 'seeding twice made nothing more');
  assert.equal(day.total, 43700);
  assert.equal(day.sales.at(-1).no, '0006');
  assert.ok(day.sales.every((s: any) => s.seller === 'Karim'));
  assert.ok(day.sales.some((s: any) => s.customer), 'one sale has its customer');
  const yesterday: any = await call('pos.sales', admin, { date: '2026-11-06' });
  assert.equal(yesterday.count, 5);
  const st: any = await call('pos.state', admin, {});
  assert.equal(await bal(admin, st.caisse.key), 36600 - 100 + 43700);
  assert.equal(st.next, '0012');
  // the stock's movements carry the sales' times
  const mv = await demo.query(`SELECT count(*)::int AS n FROM stock_movements WHERE reason = 'pos_sale' AND created_at < $1`, [new Date(NOW - 3_600_000).toISOString()]);
  assert.ok(mv[0].n >= 5);
});
