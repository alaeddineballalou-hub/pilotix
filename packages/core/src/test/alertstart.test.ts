// Suivi › Réglages › « Quand une alerte commence » (the owner, 26 Nov 2026): one choice for every delivery company. A
// failed try before the chosen one, or a status that is no try, no cancel and no problem, is never an alert (« never
// ever » for a parcel out for delivery); the chosen try and a cancel are; a problem goes to Suivi › Erreurs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { courierEvent, decideAlert, ordinalFr, START_TRY } from '../couriers/alertstart';

const base = { start: 't2' as const, problems: 'errors' as const, seen: 0, fresh: true };

test('ZR: the try number, the cancel and the problem come from its situation', () => {
  assert.deepEqual(courierEvent('Sortie en livraison · Ne répond pas 2', 'out_for_delivery'), { kind: 'try', n: 2 });
  assert.deepEqual(courierEvent('Confirmé au bureau · Commande annulée', 'shipped'), { kind: 'cancel' });
  assert.deepEqual(courierEvent('Sortie en livraison · Commune erronée', 'out_for_delivery'), { kind: 'problem' });
  for (const s of ['Sortie en livraison', 'Sortie en livraison · Reportée à une date ultérieure', 'Sortie en livraison · rendez-vous-client', 'Confirmé au bureau · Appel téléphonique'])
    assert.equal(courierEvent(s, 'out_for_delivery'), null, s);
});

test('other companies: their numbered words, else what their status means', () => {
  assert.deepEqual(courierEvent('Ne Réponde pas #3', 'failed'), { kind: 'try', n: 3 });
  assert.deepEqual(courierEvent('Appel sans réponse 1', 'failed'), { kind: 'try', n: 1 });
  assert.deepEqual(courierEvent('Annuler x3', 'failed'), { kind: 'cancel' }, 'E-COM: a cancel, not a try');
  assert.deepEqual(courierEvent('Tentative échouée', 'failed'), { kind: 'try', n: null }, 'Yalidine: counted by Pilotix');
  assert.deepEqual(courierEvent('Bloqué', 'alert'), { kind: 'problem' });
  assert.deepEqual(courierEvent('Reporté Commune Erronée', 'alert'), { kind: 'problem' });
  assert.equal(courierEvent('Vers Wilaya', 'shipped'), null);
});

test('the advised choice (2nd try): try 1 is not an alert, try 2 is, a cancel always is', () => {
  assert.equal(START_TRY.t2, 2);
  const one = decideAlert({ ...base, to: 'out_for_delivery', plain: 'out_for_delivery', status: 'Sortie en livraison · Ne répond pas 1' });
  assert.equal(one.to, 'out_for_delivery');
  assert.equal(one.tryN, 1);
  const two = decideAlert({ ...base, to: 'out_for_delivery', plain: 'out_for_delivery', status: 'Sortie en livraison · Ne répond pas 2' });
  assert.equal(two.to, 'alert');
  assert.equal(two.problem, false);
  const cancel = decideAlert({ ...base, start: 'cancel', to: 'out_for_delivery', plain: 'shipped', status: 'Confirmé au bureau · Commande annulée' });
  assert.equal(cancel.to, 'alert');
});

test('« only at the cancel »: ZR « Ne répond pas 3 » (its own alert before) is no longer one', () => {
  const d = decideAlert({ ...base, start: 'cancel', to: 'alert', plain: 'out_for_delivery', status: 'Sortie en livraison · Ne répond pas 3' });
  assert.equal(d.to, 'out_for_delivery');
});

test('a status ticked once for Alertes (« Reportée », « Sortie en livraison ») is never an alert now', () => {
  const d = decideAlert({ ...base, start: 't1', to: 'alert', plain: 'out_for_delivery', status: 'Sortie en livraison · Reportée à une date ultérieure' });
  assert.equal(d.to, 'out_for_delivery');
  const e = decideAlert({ ...base, start: 't1', to: 'alert', plain: 'out_for_delivery', status: 'Sortie en livraison' });
  assert.equal(e.to, 'out_for_delivery');
});

test('a problem goes to Erreurs, or with the alerts', () => {
  const d = decideAlert({ ...base, to: 'out_for_delivery', plain: 'out_for_delivery', status: 'Sortie en livraison · Commune erronée' });
  assert.deepEqual([d.to, d.problem], ['alert', true]);
  const e = decideAlert({ ...base, problems: 'alert', to: 'out_for_delivery', plain: 'out_for_delivery', status: 'Sortie en livraison · Commune erronée' });
  assert.deepEqual([e.to, e.problem], ['alert', false]);
});

test('a company that does not number its tries: Pilotix counts the new ones', () => {
  const first = decideAlert({ ...base, to: 'failed', plain: 'failed', status: 'Tentative échouée', seen: 0 });
  assert.deepEqual([first.to, first.tryN], ['failed', 1]);
  const second = decideAlert({ ...base, to: 'failed', plain: 'failed', status: 'Tentative échouée', seen: 1 });
  assert.deepEqual([second.to, second.tryN], ['alert', 2]);
  const again = decideAlert({ ...base, to: 'failed', plain: 'failed', status: 'Tentative échouée', seen: 1, fresh: false });
  assert.deepEqual([again.to, again.tryN], ['failed', 1], 'the same status read again is not a new try');
});

test('an end, a return or a status before the company has the parcel: as before', () => {
  for (const to of ['delivered', 'returning', 'returned', 'lost', 'in_exchange'] as const) assert.equal(decideAlert({ ...base, to, plain: to, status: 'Commande annulée' }).to, to);
  assert.equal(decideAlert({ ...base, to: null, plain: null, status: 'Pas encore expédiées · Commande annulée' }).to, null);
});

test('« 1re », « 2e »', () => {
  assert.equal(ordinalFr(1), '1re');
  assert.equal(ordinalFr(2), '2e');
});
