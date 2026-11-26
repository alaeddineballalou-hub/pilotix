// ZR's money (« Trésorerie » in its app, 25 Nov 2026): « Solde prêt » 93 420 DA — what we can ask for — and
// « Paiements en attente de récupération » 0 DA. Pilotix's « Prêt à payer » must be the first one: it read the second
// one, showed 0 and never asked for the payment by itself.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { zr } from '../couriers/zr';
import type { CourierCompany } from '../couriers/types';

const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));

const company = { id: 901, name: 'ZR', kind: 'zr', secret: { api_key: 'k', tenant: 't' }, settings: {}, statusMap: {}, shop: { name: 'S', fromWilayaId: 16, fromWilaya: 'Alger' } } as unknown as CourierCompany;

test('« Prêt à payer » is ZR’s « Solde prêt », not its payments waiting at the office', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    calls.push(`${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`);
    return new Response(
      JSON.stringify({ totalAmountPaid: 0, totalAmountReadyToBePaid: 0, totalAmountDelivered: 277_010, totalAmountNotReadyCashed: 183_590, totalAmountReadyToBeCashed: 93_420 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const b = await zr.payments!.balance(company);
  assert.deepEqual(calls, ['GET /supplier-payment/supplier-balance']);
  assert.deepEqual(b, { paid: 0, ready: 93_420, delivered: 277_010, notReady: 183_590 });
});
