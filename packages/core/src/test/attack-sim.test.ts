// The attack simulator: real attacks on a landing page, through the very path a real order takes (signed challenge,
// proof of work, the fake-order score, the device and phone history), on a copy of the demo shop. Robots (dumb,
// headless, smart), pranks, a competitor alone, a careless team, a smart team (a new browser each time), a wave, refusers,
// and 200 real customers as the control group (they must not be blocked). Writes the report to ATTACK_OUT
// (default /tmp/attack-report.md) and prints it.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { communesOf } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { LANDING_POW_BITS, makeChallenge } from '../modules/landing';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let slug = '';
let variantId: number | null = null;
let clock = Date.now();
const H = 3600_000;

// ------------------------------------------------------------------ a random but repeatable world
let seed = 20261028;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const FIRST = ['Amina', 'Sarah', 'Yasmine', 'Meriem', 'Lina', 'Khadidja', 'Nour', 'Imane', 'Fatima', 'Rania', 'Mohamed', 'Yacine', 'Karim', 'Sofiane', 'Walid', 'Amine', 'Bilal', 'Hamza', 'Riad', 'Nassim', 'أمينة', 'مريم', 'سارة', 'محمد', 'ياسين', 'كريم', 'فاطمة', 'خديجة', 'عبد القادر', 'إيمان'];
const LAST = ['Benali', 'Haddad', 'Mansouri', 'Belkacem', 'Saidi', 'Bouzid', 'Cherif', 'Djebbar', 'Ferhat', 'Hamidi', 'Kaci', 'Larbi', 'Meziane', 'Nouri', 'Ouali', 'Rahmani', 'Slimani', 'Taleb', 'Yahiaoui', 'Zerrouki', 'بن علي', 'حداد', 'منصوري', 'بلقاسم', 'سعيدي', 'بوزيد', 'شريف', 'عمراني', 'براهيمي', 'خليفي'];
const fullName = () => `${pick(FIRST)} ${pick(LAST)}`;
const PREFIX = ['055', '056', '054', '066', '065', '069', '067', '077', '079', '078', '070'];
const usedPhones = new Set<string>();
function phone(): string {
  for (;;) {
    const p = pick(PREFIX) + String(int(0, 9_999_999)).padStart(7, '0');
    if (/(\d)\1{4,}/.test(p) || usedPhones.has(p)) continue;
    usedPhones.add(p);
    return p;
  }
}
const UAS = [
  'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; TECNO KJ5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0]',
];
const ip = () => `${pick(['105.98', '105.101', '41.111', '41.200', '154.121', '197.200'])}.${int(1, 254)}.${int(1, 254)}`;
const id = () => Math.floor(rnd() * 1e12).toString(36) + Math.floor(rnd() * 1e12).toString(36);
const WILAYAS = [16, 16, 16, 31, 31, 25, 9, 6, 15, 19, 35, 42, 13, 5, 23, 26, 2, 10, 34, 39];
const solve = (ch: string) => {
  for (let n = 0; ; n++) {
    const h = createHash('sha256').update(`${ch}:${n}`).digest('hex');
    let bits = 0;
    for (const c of h) {
      const v = parseInt(c, 16);
      if (v === 0) bits += 4;
      else {
        bits += v < 2 ? 3 : v < 4 ? 2 : v < 8 ? 1 : 0;
        break;
      }
    }
    if (bits >= LANDING_POW_BITS) return String(n);
  }
};
const fromAd = () => ({ utm_source: 'facebook', utm_medium: 'paid', fbclid: `IwAR${id()}`, ad_id: '120210000000000123', adset_id: '120210000000000456' });

interface Visit {
  name?: string;
  phone?: string;
  wilaya?: number;
  /** a browser: its device id (kept in the browser) and fingerprint; a network address */
  did?: string;
  fp?: string;
  ip?: string;
  ua?: string;
  /** seconds between the page opening and the order; keys typed; how far down they scrolled */
  secs?: number;
  keys?: number | null;
  scroll?: number | null;
  touch?: number;
  tz?: string;
  pasted?: boolean;
  ad?: boolean;
  qty?: number;
  honeypot?: string;
  webdriver?: boolean;
  /** no page at all: a script posting straight to the order address */
  noPage?: boolean;
}

/** One order sent to the landing page, as the browser (or the robot) does; the verdict Pilotix gave it. */
async function visit(v: Visit): Promise<{ verdict: 'allow' | 'review' | 'block'; orderId: number | null; device: string }> {
  const w = v.wilaya ?? pick(WILAYAS);
  const communes = communesOf(w);
  const secs = v.secs ?? int(25, 140);
  const served = clock - secs * 1000;
  const ch = v.noPage ? '' : await makeChallenge(db, slug, served);
  const did = v.did ?? id();
  const body = {
    slug,
    name: v.name ?? fullName(),
    phone: v.phone ?? phone(),
    wilaya: w,
    commune: communes.length ? String(pick(communes)[1]) : 'Centre',
    variant: variantId,
    qty: v.qty ?? 1,
    hp: v.honeypot ?? '',
    ch,
    pw: v.noPage ? '' : solve(ch),
    t: v.noPage ? null : secs * 1000,
    ki: v.keys === undefined ? int(25, 80) : v.keys,
    wd: !!v.webdriver,
    sc: v.scroll === undefined ? int(20, 100) : v.scroll,
    ps: !!v.pasted,
    tz: v.tz ?? 'Africa/Algiers',
    mt: v.touch ?? 5,
    fp: v.fp ?? id(),
    did,
    vid: id(),
    utm: v.ad === false ? null : fromAd(),
    meta: { ip: v.ip ?? ip(), ua: v.ua ?? pick(UAS), country: 'DZ' },
  };
  const ctx: Ctx = { ...admin, now: () => clock };
  await call('landing.submit', ctx, body as any);
  const r = (await db.query(`SELECT verdict, order_id FROM landing_submits ORDER BY id DESC LIMIT 1`))[0];
  return { verdict: r.verdict, orderId: r.order_id ? Number(r.order_id) : null, device: `d:${did}` };
}

// ------------------------------------------------------------------ the report
interface Row {
  group: string;
  name: string;
  how: string;
  sent: number;
  blocked: number;
  review: number;
  passed: number;
  attack: boolean;
}
const rows: Row[] = [];
async function run(group: string, name: string, how: string, attack: boolean, visits: (() => Promise<{ verdict: string }>)[]) {
  const r: Row = { group, name, how, sent: 0, blocked: 0, review: 0, passed: 0, attack };
  for (const f of visits) {
    const x = await f();
    r.sent++;
    if (x.verdict === 'block') r.blocked++;
    else if (x.verdict === 'review') r.review++;
    else r.passed++;
  }
  rows.push(r);
  return r;
}
const times = <T>(n: number, f: (k: number) => T) => Array.from({ length: n }, (_, k) => f(k));
/** the next window of time for a scenario (each one alone, as if on another day) */
const nextDay = () => (clock += 3 * 24 * H);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');

before(async () => {
  const s = await setup(60);
  db = s.db;
  admin = await s.as(EMAILS.admin);
  const marketer = await s.as(EMAILS.marketer);
  // a dedicated page on a product that has a variant (so a real order never fails for a missing variant)
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE v.title <> '' AND p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  variantId = Number(p.vid);
  slug = 'attack-test';
  await call('landing.save', marketer, { productId: Number(p.id), slug, title: 'عربة أطفال', color: '#0f766e', price: 9950, description: '- خفيفة\n- قابلة للطي' });
});

test('attack simulator: robots, pranks, competitors, refusers — and real customers are not blocked', { timeout: 20 * 60_000, skip: process.env.RUN_ATTACK ? false : 'set RUN_ATTACK=1 to run the attack simulator' }, async () => {
  let done = false;
  try {
  // ---------------------------------------------------------------- 0. real customers (the control group), over 3 days
  nextDay();
  const real = await run('Vrais clients', '200 vrais clients', 'chacun son téléphone, lit la page, tape son nom et son numéro, souvent depuis la pub', false, times(200, (k) => async () => {
    clock += int(4, 40) * 60_000;
    // a few share a phone (a family: two numbers on one device), some paste their number, some come without the ad
    return visit({ pasted: rnd() < 0.1, ad: rnd() < 0.85, did: k % 40 === 1 ? 'family-device' : undefined, qty: rnd() < 0.1 ? 2 : 1 });
  }));

  // ---------------------------------------------------------------- 1. robots
  nextDay();
  await run('Robots', 'Script simple', 'envoie direct à l’adresse de commande, sans ouvrir la page (python-requests)', true, times(50, () => async () => {
    clock += 20_000;
    return visit({ noPage: true, ua: 'python-requests/2.31', keys: 0, scroll: null, ad: false });
  }));
  nextDay();
  await run('Robots', 'Navigateur robot (Selenium)', 'ouvre la page, résout la preuve, mais navigateur piloté et rapide (2 s)', true, times(50, () => async () => {
    clock += 30_000;
    return visit({ webdriver: true, secs: 2, keys: 0, scroll: 0, touch: 0, ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0 Safari/537.36', ad: false });
  }));
  nextDay();
  await run('Robots', 'Robot qui remplit tout', 'remplit aussi le champ piège caché', true, times(30, () => async () => {
    clock += 60_000;
    return visit({ honeypot: 'http://site.com', secs: int(5, 20) });
  }));
  nextDay();
  await run('Robots', 'Robot rapide', 'page normale, mais envoie en 1 à 3 secondes', true, times(30, () => async () => {
    clock += 45_000;
    return visit({ secs: int(1, 2), keys: 3, scroll: 0 });
  }));
  nextDay();
  await run('Robots', 'Robot intelligent (le pire)', 'imite un humain : résout la preuve, attend 20–60 s, tape, défile, téléphone Android, nouvelle adresse IP et nouvel appareil à chaque commande, vrais noms, numéros au hasard', true, times(100, () => async () => {
    clock += int(3, 15) * 60_000;
    return visit({ secs: int(20, 60) });
  }));

  // ---------------------------------------------------------------- 2. pranks
  nextDay();
  const FAKE_NUMBERS = ['0555555555', '0666666666', '0777777777', '0512345678', '0612345678', '0698765432', '0660606060', '0770707070', '0550000000', '0699999999'];
  await run('Blagues', 'Faux numéros', 'une personne tape 0555555555, 0612345678…', true, times(20, (k) => async () => {
    clock += 10 * 60_000;
    return visit({ phone: FAKE_NUMBERS[k % FAKE_NUMBERS.length] });
  }));
  nextDay();
  await run('Blagues', 'Faux nom', 'nom tapé au hasard (« azerty », « xxx », « test »)', true, times(15, (k) => async () => {
    clock += 15 * 60_000;
    return visit({ name: ['azerty', 'xxxx', 'test', 'qsdfg', 'aaa'][k % 5] });
  }));

  // ---------------------------------------------------------------- 3. competitors by hand
  nextDay();
  {
    const did = 'comp-alone';
    const myIp = ip();
    await run('Concurrent à la main', 'Concurrent seul', 'un téléphone, 15 commandes en 3 heures avec des numéros différents', true, times(15, () => async () => {
      clock += 12 * 60_000;
      return visit({ did, fp: 'fp-alone', ip: myIp, secs: int(15, 40) });
    }));
  }
  nextDay();
  {
    // 5 people, each on their own phone, 6 orders each in a day; numbers that look alike; sometimes the same name
    const team = times(5, (k) => ({ did: `team-${k}`, ip: ip(), base: pick(PREFIX) + String(int(10000, 99999)) }));
    let n = 0;
    await run('Concurrent à la main', 'Équipe négligente (5 personnes)', '5 téléphones, 6 commandes chacun dans la journée, numéros presque pareils, parfois le même nom', true, times(30, (k) => async () => {
      clock += int(10, 30) * 60_000;
      const m = team[k % 5];
      return visit({ did: m.did, ip: m.ip, phone: `${m.base}${String(n++ % 100).padStart(2, '0')}`, name: k % 3 === 0 ? 'Karim Mansouri' : undefined });
    }));
  }
  nextDay();
  {
    // 10 people, private browsing (a new device id each time), mobile data (a new address), real-looking names, 2 orders
    // per person per day over 3 days. Phase 1: alone. Phase 2: the agents call, find them fake and press « 🕵️ Concurrent »
    // on what reached them; the attackers keep going with the same phones (same browser fingerprint).
    const team = times(10, (k) => ({ fp: `smart-fp-${k}`, ua: pick(UAS) }));
    const reached: number[] = [];
    await run('Concurrent à la main', 'Équipe intelligente — avant les agents', '10 personnes, navigation privée (nouvel appareil), nouvelle IP, vrais noms, 2 commandes/jour/personne', true, times(30, (k) => async () => {
      clock += int(30, 90) * 60_000;
      const m = team[k % 10];
      const r = await visit({ fp: m.fp, ua: m.ua });
      if (r.orderId) reached.push(r.orderId);
      return r;
    }));
    // the agents mark what they called as fake (« 🕵️ Concurrent »)
    for (const oid of reached.slice(0, 10)) await call('orders.setConf', admin, { ids: [oid], status: 'fake', reason: '🕵️ Concurrent' });
    await run('Concurrent à la main', 'Équipe intelligente — après « 🕵️ Concurrent »', 'la même équipe continue après que les agents ont marqué 10 de leurs commandes', true, times(30, (k) => async () => {
      clock += int(30, 90) * 60_000;
      const m = team[k % 10];
      return visit({ fp: m.fp, ua: m.ua });
    }));
  }
  nextDay();
  {
    // a sudden wave: 25 orders of the same product in one wilaya in 30 minutes, each from another phone
    await run('Concurrent à la main', 'Vague dans une wilaya', '25 commandes du même produit dans la même wilaya en 30 minutes', true, times(25, () => async () => {
      clock += 70_000;
      return visit({ wilaya: 31 });
    }));
  }

  // ---------------------------------------------------------------- 4. refusers (parcels refused before)
  nextDay();
  {
    const refusers: { phone: string; n: number }[] = [];
    for (const n of [1, 2, 3]) for (let k = 0; k < 5; k++) refusers.push({ phone: phone(), n });
    for (const r of refusers) {
      const c = (await db.query(`INSERT INTO customers (phone, name, wilaya_id, refusals, blacklisted, blacklist_auto, stopdesk_only) VALUES ($1,'Refus Test',16,$2,$3,$3,$4) RETURNING id`, [r.phone, r.n, r.n >= 3, r.n >= 2]))[0];
      for (let k = 0; k < r.n; k++)
        await db.query(
          `INSERT INTO orders (ref, customer_id, customer_name, phone, wilaya_id, commune, conf_status, follow_status, returned_at, subtotal, delivery_fee, discount, total, channel)
           VALUES ('RF' || nextval('order_ref_seq'), $1, 'Refus Test', $2, 16, 'Kouba', 'confirmed', 'returned', now(), 1000, 0, 0, 1000, 'site')`,
          [c.id, r.phone],
        );
    }
    for (const n of [1, 2, 3])
      await run('Refuseurs', `A refusé ${n} colis`, n === 1 ? 'revient commander' : n === 2 ? 'revient commander (stop-desk seulement)' : 'mis en liste noire par Pilotix, revient commander', true, refusers.filter((r) => r.n === n).map((r) => async () => {
        clock += 20 * 60_000;
        return visit({ phone: r.phone, name: 'Refus Test' });
      }));
  }

  // ---------------------------------------------------------------- the report
  const attacks = rows.filter((r) => r.attack);
  const sum = (k: 'sent' | 'blocked' | 'review' | 'passed') => attacks.reduce((n, r) => n + r[k], 0);
  const lines = [
    '# Pilotix — attack test',
    '',
    `Cloudflare (invisible) was **off** in this test: on the real site it stops even more robots. ${sum('sent')} attack orders, ${real.sent} real customers.`,
    '',
    '| Group | Attack | How | Sent | 🚫 Blocked | 🟡 To check | 🟢 Passed | Stopped (🚫+🟡) |',
    '|---|---|---|---:|---:|---:|---:|---:|',
    ...rows.map((r) => `| ${r.group} | ${r.name} | ${r.how} | ${r.sent} | ${r.blocked} | ${r.review} | ${r.passed} | ${r.attack ? pct(r.blocked + r.review, r.sent) : '—'} |`),
    '',
    `**All attacks:** ${sum('sent')} sent · ${sum('blocked')} blocked (${pct(sum('blocked'), sum('sent'))}) · ${sum('review')} to check (${pct(sum('review'), sum('sent'))}) · ${sum('passed')} passed (${pct(sum('passed'), sum('sent'))}).`,
    `**Real customers:** ${real.sent} · ${real.passed} passed · ${real.review} to check · ${real.blocked} blocked by mistake (${pct(real.blocked, real.sent)}).`,
  ];
  const md = lines.join('\n');
  writeFileSync(process.env.ATTACK_OUT || '/tmp/attack-report.md', md);
  console.log(md);
  writeFileSync((process.env.ATTACK_OUT || '/tmp/attack-report.md').replace(/\.md$/, '.json'), JSON.stringify({ rows }, null, 2));
  done = true;

  // what must hold whatever the tuning: the simple robots never get through, real customers are (almost) never blocked
  for (const r of rows.filter((x) => x.group === 'Robots' && !x.name.includes('intelligent'))) assert.equal(r.passed, 0, r.name);
  assert.ok(real.blocked / real.sent <= 0.03, `real customers blocked: ${real.blocked}`);
  } finally {
    if (!done && rows.length) {
      const mdF = ['# Pilotix — attack test (partial if interrupted)', '', '| Group | Name | Sent | Blocked | To check | Passed |', '|---|---|---:|---:|---:|---:|', ...rows.map((r) => `| ${r.group} | ${r.name} | ${r.sent} | ${r.blocked} | ${r.review} | ${r.passed} |`)].join('\n');
      try { writeFileSync(process.env.ATTACK_OUT || '/tmp/attack-report.md', mdF); console.log(mdF); } catch {}
    }
  }
});
