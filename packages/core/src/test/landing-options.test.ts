import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageOptionName, splitOptions } from '../modules/landing';

const opts = [
  { name: 'Taille', values: ['S', 'M', 'L'] },
  { name: 'Couleur', values: ['Rouge', 'Noir'] },
];

test('splitOptions: two options whose combinations are the variants', () => {
  const r = splitOptions(opts, [{ title: 'S / Rouge' }, { title: 'M / Rouge' }, { title: 'M / Noir' }]);
  // L is not used by any variant: not offered
  assert.deepEqual(r, [
    { name: 'المقاس', values: ['S', 'M'] },
    { name: 'اللون', values: ['Rouge', 'Noir'] },
  ]);
});

test('splitOptions: one option, or variants typed by hand, keep one list', () => {
  assert.equal(splitOptions([opts[0]], [{ title: 'S' }]), null);
  assert.equal(splitOptions(opts, [{ title: 'Rouge taille M' }]), null);
  assert.equal(splitOptions(opts, [{ title: 'S / Bleu' }]), null);
  assert.equal(splitOptions([], [{ title: 'S / Rouge' }]), null);
});

test('pageOptionName: the usual names in Arabic on the page, any other name as typed', () => {
  assert.equal(pageOptionName('Size'), 'المقاس');
  assert.equal(pageOptionName(' Colour '), 'اللون');
  assert.equal(pageOptionName('Couleur'), 'اللون');
  assert.equal(pageOptionName('Pointure'), 'المقاس');
  assert.equal(pageOptionName('Fille / Garçon'), 'الجنس');
  assert.equal(pageOptionName('Modèle'), 'الموديل');
  assert.equal(pageOptionName('Motif'), 'Motif');
  assert.equal(pageOptionName('المقاس'), 'المقاس');
});
