// Google Sheets channel: column guess, CSV reading, each line once, problems reported per line; test orders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call } from '../index';
import { guessMapping, parseCsv, sheetCsvUrl } from '../modules/sheets';
import { EMAILS, setup } from './harness';

test('sheet links, CSV and column guess', () => {
  assert.equal(sheetCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml?gid=12'), 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv&gid=12');
  assert.equal(sheetCsvUrl('https://docs.google.com/spreadsheets/d/1AbC_d-9/edit#gid=0'), 'https://docs.google.com/spreadsheets/d/1AbC_d-9/export?format=csv&gid=0');
  assert.throws(() => sheetCsvUrl('https://evil.example.com/spreadsheets/d/x'), /feuille Google/);
  assert.deepEqual(parseCsv('﻿a,"b, c","d ""e"""\r\n1,"2\n3",4\n\n'), [['a', 'b, c', 'd "e"'], ['1', '2\n3', '4']]);
  const g = guessMapping(['Date', 'Nom complet', 'Téléphone', 'Tel 2', 'Wilaya', 'Commune', 'Adresse', 'Produit', 'Quantité', 'Prix', 'Remarque', 'الولاية']);
  assert.equal(g['Nom complet'], 'name');
  assert.equal(g['Téléphone'], 'phone');
  assert.equal(g['Tel 2'], 'phone2');
  assert.equal(g['Wilaya'], 'wilaya');
  assert.equal(g['Produit'], 'product');
  assert.equal(g['Quantité'], 'qty');
  assert.equal(g['Prix'], 'total');
  assert.equal(g['Remarque'], 'note');
  assert.equal(g['Date'], 'ignore');
  assert.equal(g['الولاية'], 'ignore'); // wilaya already taken
});

test('sheet channel: choose the columns, then each line becomes an order once', async () => {
  const { db, as } = await setup(5);
  const admin = await as(EMAILS.admin);
  const product = (await db.query('SELECT p.name FROM products p WHERE p.active AND NOT p.is_service AND (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id AND v.active) <= 1 ORDER BY p.id LIMIT 1'))[0].name;
  let csv = `N°,Client,Téléphone,Wilaya,Commune,Produit,Qté,Prix\n1001,Karim Test,0661 23 45 67,16 - Alger,Bab Ezzouar,"${product}",2,7000\n1002,Sans Wilaya,0770112233,Nulle Part,,"${product}",1,3500\n`;
  const ctx = { ...admin, server: { sheetCsv: async () => csv } as any };
  const ch: any = await call('admin.channels.save', admin, { kind: 'sheets', name: 'Feuille test', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pubhtml' });

  await assert.rejects(call('channels.sheet.sync', ctx, { id: ch.id }), /colonne va où/);
  const r: any = await call('channels.sheet.read', ctx, { id: ch.id });
  assert.deepEqual(r.headers, ['N°', 'Client', 'Téléphone', 'Wilaya', 'Commune', 'Produit', 'Qté', 'Prix']);
  assert.equal(r.mapping['Client'], 'name');
  assert.equal(r.lines, 2);
  await assert.rejects(call('channels.sheet.saveMapping', ctx, { id: ch.id, mapping: { ...r.mapping, Client: 'ignore' } }), /Nom du client/);
  await assert.rejects(call('channels.sheet.saveMapping', ctx, { id: ch.id, mapping: { ...r.mapping, Commune: 'name' } }), /même endroit/);
  await call('channels.sheet.saveMapping', ctx, { id: ch.id, mapping: { ...r.mapping, 'N°': 'ref' } });

  const s1: any = await call('channels.sheet.sync', ctx, { id: ch.id });
  assert.equal(s1.created, 1);
  assert.equal(s1.errorCount, 1);
  assert.equal(s1.errors[0].line, 3);
  assert.match(s1.errors[0].error, /Wilaya inconnue/);
  const o = (await db.query("SELECT o.*, (SELECT qty FROM order_items i WHERE i.order_id = o.id LIMIT 1) AS qty, (SELECT unit_price FROM order_items i WHERE i.order_id = o.id LIMIT 1) AS unit FROM orders o WHERE o.customer_name = 'Karim Test'"))[0];
  assert.equal(o.phone, '0661234567');
  assert.equal(Number(o.wilaya_id), 16);
  assert.equal(o.source, 'Feuille test');
  assert.equal(Number(o.qty), 2);
  assert.equal(Number(o.unit), 3500);

  // again: nothing twice; the fixed line comes in
  csv = csv.replace('Nulle Part', 'Oran');
  const s2: any = await call('channels.sheet.sync', ctx, { id: ch.id });
  assert.equal(s2.created, 1);
  assert.equal(s2.already, 1);
  assert.equal(s2.errorCount, 0);

  // "only new lines": the lines already there are skipped
  const ch2: any = await call('admin.channels.save', admin, { kind: 'sheets', name: 'Feuille 2', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-y/pubhtml' });
  const k: any = await call('channels.sheet.saveMapping', ctx, { id: ch2.id, mapping: { ...r.mapping, 'N°': 'ref' }, skipExisting: true });
  assert.equal(k.skipped, 2);
  assert.equal(((await call('channels.sheet.sync', ctx, { id: ch2.id })) as any).created, 0);

  // renaming keeps the columns; every channel is synced by the server's job
  await call('admin.channels.save', admin, { id: ch.id, kind: 'sheets', name: 'Feuille renommée', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pubhtml' });
  assert.equal(((await call('channels.sheet.read', ctx, { id: ch.id })) as any).saved, true);
  const all: any[] = (await call('channels.sheet.syncAll', ctx, {})) as any[];
  assert.equal(all.length, 2);
  assert.ok(all.every((c) => !c.error && c.created === 0));

  // a product with several variants needs a Variante column
  const multi = (await db.query('SELECT p.name FROM products p WHERE p.active AND (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id AND v.active) > 1 ORDER BY p.id LIMIT 1'))[0]?.name;
  if (multi) {
    csv = `N°,Client,Téléphone,Wilaya,Commune,Produit,Qté,Prix\n2001,Lina Test,0661 00 11 22,Oran,,"${multi}",1,3000\n`;
    const s3: any = await call('channels.sheet.sync', ctx, { id: ch.id });
    assert.match(s3.errors[0].error, /colonne Variante/);
  }

  // only the administrator
  await assert.rejects(call('channels.sheet.sync', await as(EMAILS.manager), { id: ch.id }), /refusé/);
});

test('test orders: made with fake customers, then removed', async () => {
  const { db, as } = await setup(5);
  const admin = await as(EMAILS.admin);
  const r: any = await call('admin.testOrders.create', admin, { count: 3 });
  assert.equal(r.created, 3);
  const rows = await db.query("SELECT customer_name, phone, conf_status FROM orders WHERE source = 'Test Pilotix'");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x: any) => x.customer_name.startsWith('TEST ') && x.phone.startsWith('0500')));
  assert.equal(((await call('admin.testOrders.count', admin, {})) as any).count, 3);
  const d: any = await call('admin.testOrders.delete', admin, {});
  assert.equal(d.deleted, 3);
  assert.equal(((await call('admin.testOrders.count', admin, {})) as any).count, 0);
  await assert.rejects(call('admin.testOrders.create', await as(EMAILS.conf), { count: 1 }), /refusé/);
});
