// « API Livraison »: every delivery company one card each, with its own logo — those of a shared platform (EcoTrack,
// Yalidine, Procolis) by their own name, never the platform; a shop's company is recognized by its card, else by the
// whole host of its API address (« rex.ecotrack.dz » is not « chronorex.ecotrack.dz »).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { courierCardOf, hostMatches, urlHost } from '@pilotix/shared';
import { CARDS, KINDS } from '../couriers/kinds';

const LOGOS = join(__dirname, '../../../../apps/web/public/couriers');

test('one card per company: unique, the platforms never shown, every logo there', () => {
  assert.ok(CARDS.length > 80, `${CARDS.length} cards`);
  assert.equal(new Set(CARDS.map((c) => c.id)).size, CARDS.length, 'ids unique');
  assert.ok(!CARDS.some((c) => /ecotrack|procolis/i.test(c.title) && c.id !== 'zr-procolis'), 'no platform as a company');
  assert.ok(!CARDS.some((c) => /^Autre société/.test(c.title)), 'no « Autre société EcoTrack »');
  for (const c of CARDS) {
    assert.ok(KINDS[c.kind]?.api, `${c.id}: an API kind`);
    if (c.logo) assert.ok(existsSync(join(LOGOS, `${c.logo}.webp`)), `${c.id}: couriers/${c.logo}.webp`);
    // the dark theme shows a logo's « on dark » version (scripts/courier-logos-dark.py); a white logo as it is
    if (c.logo && !c.dark) assert.ok(existsSync(join(LOGOS, 'dark', `${c.logo}.webp`)), `${c.id}: couriers/dark/${c.logo}.webp (run scripts/courier-logos-dark.py)`);
  }
  assert.ok(CARDS.filter((c) => c.logo).length >= 85, 'almost all have a logo');
  // the most used first, « Autre API » last
  assert.deepEqual(CARDS.slice(0, 3).map((c) => c.id), ['zr', 'yalidine', 'noest']);
  assert.equal(CARDS.at(-1)!.id, 'custom');
  // each EcoTrack and Yalidine company has its own address set by Pilotix
  for (const c of CARDS.filter((x) => x.kind === 'ecotrack' || (x.kind === 'yalidine' && x.id !== 'yalidine'))) assert.match(c.settings?.base_url ?? '', /^https:\/\//, c.id);
  // the dead ones are left out
  for (const id of ['anderson', 'mars-express', 'tawsil-star', 'ecotrack']) assert.ok(!CARDS.some((c) => c.id === id), id);
});

test('a shop’s company is recognized: by its card, else by the whole host of its address', () => {
  const of = (kind: string, base_url: string, card?: string) => courierCardOf(CARDS, { kind, settings: { base_url, ...(card ? { card } : {}) } })?.id ?? null;
  assert.equal(of('ecotrack', 'https://rex.ecotrack.dz'), 'rex-livraison');
  assert.equal(of('ecotrack', 'https://chronorex.ecotrack.dz/'), 'chronorex');
  assert.equal(of('ecotrack', 'https://dhd.ecotrack.dz'), 'dhd', 'DHD’s old address');
  assert.equal(of('ecotrack', 'https://platform.dhd-dz.com'), 'dhd');
  assert.equal(of('ecotrack', 'https://app.conexlog-dz.com'), 'conexlog');
  assert.equal(of('ecotrack', 'https://nobody.ecotrack.dz'), null, 'an address no card has');
  assert.equal(of('yalidine', ''), 'yalidine', 'no address: Yalidine');
  assert.equal(of('yalidine', 'https://api.guepex.app/v1/'), 'guepex');
  assert.equal(of('yalidine', 'https://api.yalitec.me/v1/'), 'yalitec');
  assert.equal(of('zr_legacy', 'https://procolis.com/api_v1'), 'zr-procolis');
  assert.equal(of('zr_legacy', 'https://abex.procolis.com/api_v1'), 'abex', 'ABEX’s old address');
  assert.equal(of('zr_legacy', 'https://procolis.com/api_v1', 'colilog'), 'colilog', 'same address: by its card');
  assert.equal(of('ecotrack', 'https://rex.ecotrack.dz', 'dhd'), 'dhd', 'its card first');
  assert.equal(of('zr', ''), 'zr');
  // hosts compared whole
  assert.equal(urlHost('https://API.Guepex.app/v1/'), 'api.guepex.app');
  assert.equal(urlHost('guepex.app'), 'guepex.app');
  assert.equal(urlHost(''), '');
  assert.ok(hostMatches('guepex.app', 'https://api.guepex.app/v1/'));
  assert.ok(!hostMatches('rex.ecotrack.dz', 'https://chronorex.ecotrack.dz'));
  assert.ok(hostMatches('!guepex.app,yalitec.me', ''));
  assert.ok(!hostMatches('!guepex.app,yalitec.me', 'https://api.yalitec.me/v1/'));
});
