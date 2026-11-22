// Pilotix Spy: « Lire le prix de cette page » (price.js), without Chrome. Run: node apps/extension/test/price.test.mjs
// What a shop page shows (its text after its scripts ran, its JSON-LD, its meta tags) gives the product's price and its
// crossed price, like Pilotix's server reads a page; pages the popup must not read are left alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceOf, pricesIn, readablePage } from '../price.js';

test('the price a shop page shows, and its crossed price', () => {
  assert.deepEqual(priceOf({ text: 'Poussette 3 en 1\n9,800.00 DZD\n13,900.00 DZD\nCommander' }), { price: 9800, oldPrice: 13900 });
  assert.deepEqual(priceOf({ text: 'سرير قابل للطي\n12900 دج بدل 18000 دج\nاطلب الآن' }), { price: 12900, oldPrice: 18000 });
  assert.deepEqual(priceOf({ text: 'Chaise haute évolutive\n7 900 DA\nLivraison 58 wilayas' }), { price: 7900, oldPrice: null });
  // nothing in DA on screen: the shop's own data (JSON-LD offers, then a meta tag)
  assert.deepEqual(priceOf({ text: 'Lit parapluie', ld: '{"@type":"Product","offers":{"@type":"Offer","price":"14500.00","priceCurrency":"DZD"}}' }), { price: 14500, oldPrice: null });
  assert.deepEqual(priceOf({ text: 'Lit parapluie', metas: ['16500.00'] }), { price: 16500, oldPrice: null });
  // no price: nothing sent
  assert.equal(priceOf({ text: 'Livraison 58 wilayas, appelez le 0770 12 34 56' }), null);
  assert.equal(priceOf(null), null);
  assert.deepEqual(pricesIn('3 500 دج بدل 4 500 دج'), { price: 3500, old: 4500 });
});

test('the popup reads web pages only: not Facebook, not a Pilotix address, not Chrome’s own pages', () => {
  assert.equal(readablePage('https://shop.youcan.store/products/poussette'), true);
  assert.equal(readablePage('https://www.facebook.com/ads/library/?id=1'), false);
  assert.equal(readablePage('https://pilotix.online/baby-joy-dz/spy', ['https://pilotix.online']), false);
  assert.equal(readablePage('chrome://extensions'), false);
  assert.equal(readablePage('pas une adresse'), false);
});
