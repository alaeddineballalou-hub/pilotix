// Where the road is cut (shared/roads, Control room › Doctor › Coupures): every verdict from what answered on the
// screen, the code carried through the backup door's address, the colours, and the internet companies' names.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ispName, parseRoadCode, roadCode, RoadTest, roadTone, roadVerdict, ROAD_VERDICTS } from '@pilotix/shared';

/** o answered, x did not, n not tested — in the order edge, cf, direct, net, app. */
const r = (code: string): RoadTest => parseRoadCode(code)!;

describe('roadVerdict', () => {
  test('nothing answers at all: the device had no internet', () => {
    assert.equal(roadVerdict(r('xxxxx')), 'offline');
    assert.equal(roadVerdict(r('xxxxn')), 'offline');
  });
  test('internet and the backup door answer, nothing on Cloudflare does: the internet company blocks Cloudflare', () => {
    assert.equal(roadVerdict(r('xxoox')), 'isp_cloudflare');
  });
  test('Cloudflare answers, only Pilotix\'s own Cloudflare addresses do not: blocked for Pilotix only', () => {
    assert.equal(roadVerdict(r('xooox')), 'isp_pilotix');
  });
  test('Cloudflare answers for Pilotix, the server does not even without Cloudflare: the server', () => {
    assert.equal(roadVerdict(r('ooxox')), 'server');
    assert.equal(roadVerdict(r('onxnx')), 'server');
  });
  test('the screen reaches Cloudflare and the server, but not Pilotix through Cloudflare: Cloudflare to the server', () => {
    assert.equal(roadVerdict(r('oooox')), 'cf_to_server');
  });
  test('only plain internet answers: the roads abroad', () => {
    assert.equal(roadVerdict(r('xxxox')), 'international');
  });
  test('Pilotix\'s Cloudflare addresses and the backup door cut, cloudflare.com fine', () => {
    assert.equal(roadVerdict(r('xoxox')), 'both');
  });
  test('everything answers: the cut was over before the test', () => {
    assert.equal(roadVerdict(r('ooooo')), 'ok');
    assert.equal(roadVerdict(r('oooon')), 'ok');
  });
  test('not tested or not enough answers: unknown', () => {
    assert.equal(roadVerdict(r('nnnnn')), 'unknown');
    assert.equal(roadVerdict(r('xnoon')), 'unknown');
  });
  test('every answer gives one of the known verdicts', () => {
    const letters = ['o', 'x', 'n'];
    for (let i = 0; i < 3 ** 5; i++) {
      const code = [0, 1, 2, 3, 4].map((k) => letters[Math.floor(i / 3 ** k) % 3]).join('');
      assert.ok(ROAD_VERDICTS.includes(roadVerdict(r(code))), code);
    }
  });
});

describe('roadCode', () => {
  test('five letters for the backup door\'s address, and back', () => {
    const t: RoadTest = { edge: false, cf: true, direct: true, net: null, app: false };
    assert.equal(roadCode(t), 'xoonx');
    assert.deepEqual(parseRoadCode(roadCode(t)), t);
  });
  test('anything else in the address is ignored', () => {
    for (const bad of [null, undefined, '', 'oxo', 'oxoxox', 'OXOXO', 'ab12c', 'o x o']) assert.equal(parseRoadCode(bad), null, String(bad));
  });
});

describe('roadTone', () => {
  test('red for a real cut, orange for Pilotix only, grey for the device or no answer', () => {
    assert.equal(roadTone('isp_cloudflare'), 'bad');
    assert.equal(roadTone('server'), 'bad');
    assert.equal(roadTone('cf_to_server'), 'bad');
    assert.equal(roadTone('international'), 'bad');
    assert.equal(roadTone('isp_pilotix'), 'warn');
    assert.equal(roadTone('both'), 'warn');
    assert.equal(roadTone('offline'), 'off');
    assert.equal(roadTone('ok'), 'off');
    assert.equal(roadTone('unknown'), 'off');
  });
});

describe('ispName', () => {
  test('the Algerian internet companies by their usual names', () => {
    assert.equal(ispName('ALGTEL-AS, DZ'), 'Algérie Télécom');
    assert.equal(ispName('Algerie Telecom SPA'), 'Algérie Télécom');
    assert.equal(ispName('MOBILIS-AS, DZ'), 'Mobilis');
    assert.equal(ispName('ATM Mobilis'), 'Mobilis');
    assert.equal(ispName('Algerie Telecom Mobile'), 'Mobilis');
    assert.equal(ispName('OTA-AS Djezzy, DZ'), 'Djezzy');
    assert.equal(ispName('Optimum Telecom Algerie'), 'Djezzy');
    assert.equal(ispName('WATANIYA-TELECOM-ALGERIE, DZ'), 'Ooredoo');
    assert.equal(ispName('Ooredoo Algeria'), 'Ooredoo');
  });
  test('another network keeps its own name, without the country', () => {
    assert.equal(ispName('ICOSNET-AS, DZ'), 'ICOSNET-AS');
    assert.equal(ispName('CLOUDFLARENET, US'), 'CLOUDFLARENET');
  });
  test('no holder: unknown', () => {
    assert.equal(ispName(''), null);
    assert.equal(ispName(null), null);
    assert.equal(ispName(undefined), null);
  });
});
