// Protection › « Lancer un test d'attaque »: launches real attacks on a landing page, through the real fraud-scoring
// code (the same scoreOrder, device/phone history and « concurrent » marks the live page uses), and reports how many of
// each attack get blocked / sent to check / pass — plus 100 real customers as a control group that must not be blocked.
//
// SAFE on the live site: the whole test runs inside ONE transaction that is ALWAYS rolled back, so it creates no real
// order, no Meta/TikTok event and leaves nothing behind. It runs in a time window 100 days ahead, so real recent
// traffic does not interfere. Admin / marketer only.
import { z } from 'zod';
import { Db, num } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { FraudLevel, scoreOrder } from './fraud';
import { deviceMarks, handCounts, phoneHistory, recentCounts } from './landing';
import { landingSettings } from './landingquery';

const H = 3600_000;
const DAY = 24 * H;

// a repeatable pseudo-random world (same seed → same report, so two runs compare)
function rng(seed: number) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
}

const FIRST = ['Amina', 'Sarah', 'Yasmine', 'Meriem', 'Lina', 'Nour', 'Imane', 'Rania', 'Mohamed', 'Yacine', 'Karim', 'Sofiane', 'Walid', 'Amine', 'Bilal', 'Hamza', 'أمينة', 'مريم', 'محمد', 'ياسين', 'كريم', 'خديجة'];
const LAST = ['Benali', 'Haddad', 'Mansouri', 'Belkacem', 'Saidi', 'Bouzid', 'Cherif', 'Ferhat', 'Kaci', 'Meziane', 'Rahmani', 'Slimani', 'Taleb', 'Zerrouki', 'بن علي', 'حداد', 'منصوري', 'سعيدي', 'شريف', 'عمراني'];
const UAS = [
  'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; TECNO KJ5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0]',
];
const WIL = [16, 16, 16, 31, 31, 25, 9, 6, 19, 35, 42, 13, 5, 23, 2, 10, 34];
const fromAd = (r: () => number) => ({ utm_source: 'facebook', utm_medium: 'paid', fbclid: `IwAR${Math.floor(r() * 1e12).toString(36)}`, ad_id: '120210000000000123', adset_id: '120210000000000456' });

interface Visit {
  name?: string;
  phone?: string;
  wilaya?: number;
  did?: string;
  fp?: string;
  ip?: string;
  ua?: string;
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
  noPage?: boolean;
  /** automation Cloudflare's invisible check would catch (a real browser driven by a script) */
  bot?: boolean;
}

export interface AttackRow {
  group: string;
  name: string;
  how: string;
  sent: number;
  blocked: number;
  review: number;
  passed: number;
  attack: boolean;
}

export interface AttackReport {
  page: string;
  rows: AttackRow[];
  total: { sent: number; blocked: number; review: number; passed: number };
  real: { sent: number; blocked: number };
  turnstileOn: boolean;
  at: string;
}

/** Runs the attack test for one landing page, entirely inside a rolled-back transaction. */
export async function runAttackTest(ctx: Ctx, slug: string | null, level: FraudLevel, turnstile: 'auto' | 'on' | 'off'): Promise<AttackReport> {
  const page = (
    await ctx.db.query(
      slug
        ? `SELECT l.slug, l.product_id, l.fraud_level FROM landing_pages l WHERE l.slug = $1`
        : `SELECT l.slug, l.product_id, l.fraud_level FROM landing_pages l WHERE l.active ORDER BY l.id LIMIT 1`,
      slug ? [slug] : [],
    )
  )[0];
  if (!page) throw bad(slug ? 'Landing page introuvable' : 'Aucune landing page : créez-en une d’abord');
  const productId = num(page.product_id);
  const variantId = Number((await ctx.db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND title <> '' AND active ORDER BY id LIMIT 1`, [productId]))[0]?.id ?? 0) || null;
  const fraudLevel = level ?? (['relaxed', 'normal', 'strict'].includes(page.fraud_level) ? page.fraud_level : 'normal');
  // Cloudflare is on when the shop set its own key, or when Pilotix placed one for the page's address
  const configured = !!String((await landingSettings(ctx.db)).turnstileSiteKey ?? '').trim() || !!ctx.server?.turnstile;
  const turnstileOn = turnstile === 'on' ? true : turnstile === 'off' ? false : configured;

  const rows: AttackRow[] = [];
  const ROLLBACK = Symbol('rollback');
  try {
    await ctx.db.tx(async (tx) => {
      await runAll(tx, { productId, variantId, fraudLevel, rows, turnstileOn });
      throw ROLLBACK; // nothing is ever saved
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  const attacks = rows.filter((r) => r.attack);
  const real = rows.find((r) => !r.attack) ?? { sent: 0, blocked: 0 };
  const sum = (k: 'sent' | 'blocked' | 'review' | 'passed') => attacks.reduce((n, r) => n + r[k], 0);
  return {
    page: String(page.slug),
    rows,
    total: { sent: sum('sent'), blocked: sum('blocked'), review: sum('review'), passed: sum('passed') },
    real: { sent: real.sent, blocked: real.blocked },
    turnstileOn,
    at: new Date(ctx.now()).toISOString(),
  };
}

async function runAll(tx: Db, cfg: { productId: number; variantId: number | null; fraudLevel: FraudLevel; rows: AttackRow[]; turnstileOn: boolean }) {
  const { productId, fraudLevel, rows, turnstileOn } = cfg;
  void cfg.variantId;
  const r = rng(20261028);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const rid = () => Math.floor(r() * 1e12).toString(36) + Math.floor(r() * 1e12).toString(36);
  const used = new Set<string>();
  const phone = (): string => {
    for (;;) {
      const p = pick(['055', '056', '066', '065', '069', '077', '079', '078', '070']) + String(int(0, 9_999_999)).padStart(7, '0');
      if (/(\d)\1{4,}/.test(p) || used.has(p)) continue;
      used.add(p);
      return p;
    }
  };
  const ip = () => `${pick(['105.98', '105.101', '41.111', '41.200', '154.121', '197.200'])}.${int(1, 254)}.${int(1, 254)}`;
  const name = () => `${pick(FIRST)} ${pick(LAST)}`;

  // the clock: 100 days ahead of real traffic (so real recent orders never fall in the burst windows)
  let clock = Date.now() + 100 * DAY;

  // one simulated order: scored by the real engine, then written to landing_submits so later bursts see it (rolled back)
  async function visit(v: Visit): Promise<'allow' | 'review' | 'block'> {
    const w = v.wilaya ?? pick(WIL);
    const ipv = v.ip ?? ip();
    const did = v.did ?? rid();
    const fp = v.fp ?? rid();
    const device = did ? `d:${did}` : `f:${fp}:${ipv}`;
    const fphash = fp.slice(0, 24);
    const ph = v.phone ?? phone();
    const ua = v.ua ?? pick(UAS);
    const secs = v.secs ?? int(25, 140);
    const scroll = v.scroll === undefined ? int(20, 100) : v.scroll;
    const utm = v.ad === false ? null : fromAd(r);
    void utm;
    const nm = v.name ?? name();
    const facts = {
      name: nm,
      phoneRaw: ph,
      phone: ph,
      qty: v.qty ?? 1,
      honeypot: v.honeypot ?? '',
      servedMs: v.noPage ? null : secs * 1000,
      clientMs: v.noPage ? null : secs * 1000,
      inputs: v.keys === undefined ? int(25, 80) : v.keys,
      pow: (v.noPage ? 'missing' : 'ok') as 'ok' | 'missing' | 'bad' | 'replay',
      userAgent: ua,
      webdriver: !!v.webdriver,
      recent: {
        ...(await recentCounts(tx, { phone: ph, productId, ip: ipv, device, now: clock })),
        ...(await handCounts(tx, { phone: ph, productId, ip: ipv, device, fphash, name: nm, wilayaId: w, now: clock })),
      },
      history: await phoneHistory(tx, ph),
      marks: await deviceMarks(tx, device, fphash, ph, clock),
      // Cloudflare's invisible check: a robot (driven browser / script) fails it; a real person — even a competitor — passes
      turnstile: (turnstileOn ? ((v.noPage || v.webdriver || v.bot) && r() < 0.9 ? 'fail' : 'ok') : 'off') as 'ok' | 'fail' | 'off',
      ipCountry: 'DZ',
      ipWilaya: null,
      wilayaId: w,
      behavior: v.noPage ? null : { scroll: Math.max(0, Math.min(100, scroll ?? 50)), pasted: !!v.pasted, tz: v.tz ?? 'Africa/Algiers', touch: v.touch ?? 5, fromAd: v.ad !== false },
    };
    const res = scoreOrder(facts as any, fraudLevel);
    // record the submit so the next orders of a burst / wave see it (order_id null: no real order; rolled back anyway)
    await tx.query(
      `INSERT INTO landing_submits (landing_id, product_id, phone, ip, fp, fphash, verdict, score, at)
       VALUES ((SELECT id FROM landing_pages WHERE product_id = $1 ORDER BY id LIMIT 1), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [productId, ph, ipv, device, fphash, res.verdict, res.score, new Date(clock).toISOString()],
    );
    return res.verdict;
  }

  const run = async (group: string, nm: string, how: string, attack: boolean, n: number, make: (k: number) => Visit | Promise<Visit>, gap = () => int(2, 20) * 60_000) => {
    const row: AttackRow = { group, name: nm, how, sent: 0, blocked: 0, review: 0, passed: 0, attack };
    for (let k = 0; k < n; k++) {
      clock += gap();
      const v = await make(k);
      const verdict = await visit(v);
      row.sent++;
      if (verdict === 'block') row.blocked++;
      else if (verdict === 'review') row.review++;
      else row.passed++;
    }
    rows.push(row);
  };

  // 0. real customers (control group) — must not be blocked
  await run('Vrais clients', '100 vrais clients', 'chacun son téléphone, lit la page, tape son nom, souvent depuis la pub', false, 100, () => ({ pasted: r() < 0.1, ad: r() < 0.85, qty: r() < 0.1 ? 2 : 1 }), () => int(4, 40) * 60_000);
  clock += 3 * DAY;

  // 1. robots
  await run('Robots', 'Script simple (python-requests)', 'envoie direct à l’adresse de commande, sans ouvrir la page', true, 40, () => ({ noPage: true, ua: 'python-requests/2.31', keys: 0, scroll: null, ad: false }), () => 20_000);
  clock += 3 * DAY;
  await run('Robots', 'Navigateur robot (Selenium)', 'ouvre la page mais navigateur piloté et rapide', true, 40, () => ({ webdriver: true, secs: 2, keys: 0, scroll: 0, touch: 0, ua: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/129.0 Safari/537.36', ad: false }), () => 30_000);
  clock += 3 * DAY;
  await run('Robots', 'Robot qui remplit le champ piège', 'remplit aussi le champ caché', true, 25, () => ({ honeypot: 'http://x.com', secs: int(5, 20) }), () => 60_000);
  clock += 3 * DAY;
  await run('Robots', 'Robot rapide', 'envoie en 1 à 3 secondes', true, 25, () => ({ secs: int(1, 2), keys: 3, scroll: 0 }), () => 45_000);
  clock += 3 * DAY;
  await run('Robots', 'Robot intelligent (imite un humain)', 'attend, tape, défile, Android, nouvelle IP et nouvel appareil à chaque fois', true, 60, () => ({ secs: int(20, 60), bot: true }), () => int(3, 15) * 60_000);
  clock += 3 * DAY;

  // 2. pranks
  const FAKE_N = ['0555555555', '0666666666', '0777777777', '0512345678', '0612345678', '0698765432', '0660606060', '0770707070'];
  await run('Blagues', 'Faux numéros', 'tape 0555555555, 0612345678…', true, 16, (k) => ({ phone: FAKE_N[k % FAKE_N.length] }), () => 10 * 60_000);
  clock += 3 * DAY;
  const FAKE_NAME = ['azerty', 'xxxx', 'test', 'qsdfg', 'aaa'];
  await run('Blagues', 'Faux nom', 'nom tapé au hasard (azerty, xxx, test)', true, 15, (k) => ({ name: FAKE_NAME[k % FAKE_NAME.length] }), () => 15 * 60_000);
  clock += 3 * DAY;

  // 3. competitors by hand
  {
    const did = 'cmp-alone';
    const myIp = ip();
    const fp = 'fp-alone';
    await run('Concurrent à la main', 'Concurrent seul', 'un téléphone, 15 commandes en 3 h, numéros différents', true, 15, () => ({ did, fp, ip: myIp, secs: int(15, 40) }), () => 12 * 60_000);
  }
  clock += 3 * DAY;
  {
    const team = Array.from({ length: 5 }, (_, k) => ({ did: `team-${k}`, fp: `teamfp-${k}`, ip: ip(), base: pick(['055', '066', '077']) + String(int(10000, 99999)) }));
    let n = 0;
    await run('Concurrent à la main', 'Équipe négligente (5 personnes)', '5 téléphones, 6 commandes chacun, numéros presque pareils', true, 30, (k) => {
      const m = team[k % 5];
      return { did: m.did, fp: m.fp, ip: m.ip, phone: `${m.base}${String(n++ % 100).padStart(2, '0')}`, name: k % 3 === 0 ? 'Karim Mansouri' : undefined };
    }, () => int(10, 30) * 60_000);
  }
  clock += 3 * DAY;
  {
    // 10 people, private browsing: a NEW stored id each time, new IP each time, but the same physical device (same fingerprint)
    const team = Array.from({ length: 10 }, (_, k) => ({ fp: `smartfp-${k}`, ua: pick(UAS) }));
    await run('Concurrent à la main', 'Équipe intelligente — avant les agents', '10 personnes, navigation privée (nouvel appareil), nouvelle IP, vrais noms', true, 30, (k) => ({ fp: team[k % 10].fp, ua: team[k % 10].ua }), () => int(30, 90) * 60_000);
    // the agents call and mark « 🕵️ Concurrent »: the mark carries the device AND the fingerprint
    for (const m of team) await tx.query(`INSERT INTO fraud_marks (kind, value, reason, device, fphash) VALUES ('device', $1, 'competitor', $1, $2)`, [`mark-${m.fp}`, m.fp.slice(0, 24)]);
    await run('Concurrent à la main', 'Équipe intelligente — après « 🕵️ Concurrent »', 'la même équipe continue après que les agents ont marqué leurs commandes', true, 30, (k) => ({ fp: team[k % 10].fp, ua: team[k % 10].ua }), () => int(30, 90) * 60_000);
  }
  clock += 3 * DAY;
  await run('Concurrent à la main', 'Vague dans une wilaya', '25 commandes du même produit dans la même wilaya en 30 min', true, 25, () => ({ wilaya: 31 }), () => 70_000);
  clock += 3 * DAY;

  // 4. refusers (parcels refused before)
  for (const nref of [1, 2, 3] as const) {
    const made: string[] = [];
    for (let k = 0; k < 5; k++) {
      const ph = phone();
      made.push(ph);
      const c = (await tx.query(`INSERT INTO customers (phone, name, wilaya_id, refusals, blacklisted, blacklist_auto, stopdesk_only) VALUES ($1,'Refus Test',16,$2,$3,$3,$4) RETURNING id`, [ph, nref, nref >= 3, nref >= 2]))[0];
      for (let j = 0; j < nref; j++)
        await tx.query(
          `INSERT INTO orders (ref, customer_id, customer_name, phone, wilaya_id, commune, conf_status, follow_status, returned_at, subtotal, delivery_fee, discount, total, channel)
           VALUES ('ATK' || nextval('order_ref_seq'), $1, 'Refus Test', $2, 16, 'Kouba', 'confirmed', 'returned', now(), 1000, 0, 0, 1000, 'site')`,
          [c.id, ph],
        );
    }
    const label = nref === 1 ? 'A refusé 1 colis' : nref === 2 ? 'A refusé 2 colis (stop-desk)' : 'A refusé 3 colis (liste noire auto)';
    await run('Refuseurs', label, 'un client qui a déjà refusé des colis revient commander', true, 5, (k) => ({ phone: made[k], name: 'Refus Test' }), () => 20 * 60_000);
  }
}
