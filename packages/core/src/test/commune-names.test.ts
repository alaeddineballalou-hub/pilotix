// A commune a company writes its own way, that no rule finds (same name, sound, Arabic name): the owner links it by
// hand (28 Nov 2026, PX1465 « ZR ne trouve pas la commune « Mahelma » (16 Alger) »: ZR writes « Maalma »).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchCommune } from '../couriers/util';

const zr = [{ name: 'Maalma', ar: null }, { name: 'Draria', ar: null }, { name: 'Zeralda', ar: null }, { name: 'Khraissia', ar: null }];

test('Mahelma (Alger) is ZR’s « Maalma », typed in French or in Arabic', () => {
  assert.equal(matchCommune('Mahelma', zr, 16)?.name, 'Maalma');
  assert.equal(matchCommune('mahelma', zr, 16)?.name, 'Maalma');
  assert.equal(matchCommune('محالمة', zr, 16)?.name, 'Maalma');
});

test('the other communes are found as before', () => {
  assert.equal(matchCommune('Draria', zr, 16)?.name, 'Draria');
  assert.equal(matchCommune('Zeralda', zr, 16)?.name, 'Zeralda');
});
