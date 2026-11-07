import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderLanding } from '@pilotix/shared';
import { splitOptions } from '../modules/landing';

const opts = [
  { name: 'Taille', values: ['S', 'M', 'L'] },
  { name: 'Couleur', values: ['Rouge', 'Noir'] },
];

test('splitOptions: two options whose combinations are the variants', () => {
  const r = splitOptions(opts, [{ title: 'S / Rouge' }, { title: 'M / Rouge' }, { title: 'M / Noir' }]);
  // L is not used by any variant: not offered
  assert.deepEqual(r, [
    { name: 'Taille', values: ['S', 'M'] },
    { name: 'Couleur', values: ['Rouge', 'Noir'] },
  ]);
});

test('splitOptions: one option, or variants typed by hand, keep one list', () => {
  assert.equal(splitOptions([opts[0]], [{ title: 'S' }]), null);
  assert.equal(splitOptions(opts, [{ title: 'Rouge taille M' }]), null);
  assert.equal(splitOptions(opts, [{ title: 'S / Bleu' }]), null);
  assert.equal(splitOptions([], [{ title: 'S / Rouge' }]), null);
});
