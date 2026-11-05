// Personal details kept out of the server's log and the Doctor (maskPersonal).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskPersonal } from '../index';

test('phones: any way of writing an Algerian mobile keeps only its operator and last two digits', () => {
  assert.equal(maskPersonal('client 0661234567 introuvable'), 'client 0661••••67 introuvable');
  assert.equal(maskPersonal('appel 0661 23 45 67.'), 'appel 0661••••67.');
  assert.equal(maskPersonal('tel +213661234567'), 'tel 0661••••67');
  assert.equal(maskPersonal('tel +213 661 23 45 67'), 'tel 0661••••67');
  assert.equal(maskPersonal('tel 213-661-234-567'), 'tel 0661••••67');
  assert.equal(maskPersonal('{"phone":"0771122334","phone2":"0558899001"}'), '{"phone":"0771••••34","phone2":"0558••••01"}');
});

test('phones: other numbers are left alone (order refs, amounts, tracking numbers, landlines, longer numbers)', () => {
  for (const s of ['CMD-000123', 'montant 4500 DA', 'colis yal-8A61234567', '06612345678901', 'fixe 021234567', 'id 123456789012', 'ref 10661234567'])
    assert.equal(maskPersonal(s), s, s);
});

test('e-mails keep their first letter and domain', () => {
  assert.equal(maskPersonal('login refused for amina.benali@gmail.com'), 'login refused for a***@gmail.com');
  assert.equal(maskPersonal('to x@shop.example.dz, y.z@mail.co'), 'to x***@shop.example.dz, y***@mail.co');
});
