// Product options (Taille, Couleur, Genre…): saved with the product, given back to the form; the variants made from them
// are ordinary variants (orders, stock).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call } from '../index';
import { EMAILS, setup } from './harness';

test('product options are saved and the variants made from them', async () => {
  const { as } = await setup(5);
  const admin = await as(EMAILS.admin);
  const base = { name: 'VELO CUIR', price: 12950, cost: 7500, weightKg: 7, alertQty: 5 };
  const options = [
    { name: 'Taille', values: ['12P', '16P'] },
    { name: 'Couleur', values: ['Blanc', 'Rose'] },
  ];
  const variants = [
    { title: '12P / Blanc', sku: 'VELO-CUIR-12P-BLANC', price: null, active: true },
    { title: '12P / Rose', sku: 'VELO-CUIR-12P-ROSE', price: null, active: true },
    { title: '16P / Blanc', sku: 'VELO-CUIR-16P-BLANC', price: 14950, active: true },
  ];
  const p: any = await call('catalog.saveProduct', admin, { ...base, options, variants });
  assert.deepEqual(p.options, options);
  assert.deepEqual(p.variants.filter((v: any) => v.title).map((v: any) => [v.title, v.sku, v.price]), [
    ['12P / Blanc', 'VELO-CUIR-12P-BLANC', null],
    ['12P / Rose', 'VELO-CUIR-12P-ROSE', null],
    ['16P / Blanc', 'VELO-CUIR-16P-BLANC', 14950],
  ]);
  // given back by the product screen
  const again: any = await call('catalog.product', admin, { id: p.id });
  assert.deepEqual(again.options, options);
  // saved without options (an older screen): they stay
  const kept: any = await call('catalog.saveProduct', admin, { ...base, id: p.id, variants: again.variants.filter((v: any) => v.title) });
  assert.deepEqual(kept.options, options);
  // a value with « / », the same name twice, the same value twice, more than 3 options: refused
  await assert.rejects(call('catalog.saveProduct', admin, { ...base, name: 'X1', options: [{ name: 'Taille', values: ['12/14'] }] }), /« \/ »/);
  await assert.rejects(call('catalog.saveProduct', admin, { ...base, name: 'X2', options: [{ name: 'Taille', values: ['12P'] }, { name: 'taille', values: ['16P'] }] }), /même nom/);
  await assert.rejects(call('catalog.saveProduct', admin, { ...base, name: 'X3', options: [{ name: 'Couleur', values: ['Rose', 'rose'] }] }), /même valeur/);
  await assert.rejects(call('catalog.saveProduct', admin, { ...base, name: 'X4', options: [1, 2, 3, 4].map((k) => ({ name: `O${k}`, values: ['a'] })) }), /3 options/);
  // a product without options: an empty list
  const plain: any = await call('catalog.saveProduct', admin, { ...base, name: 'Simple' });
  assert.deepEqual(plain.options, []);
});
