// End-to-end check of the two Doctors (after scripts/smoke-test.sh, same demo server, built server in apps/server/dist):
//   1. the server Doctor's memory (errors grouped, shops read from the line, caps, jobs late / failing / off) — in-process
//   2. the logger: every warning and error the server writes reaches the Doctor
//   3. POST /api/platform/doctor: who may call it, the shape of the answer, Redis, the database, the jobs really
//      running, a warning written by the server showing up
//   4. stats.doctor (Co-Pilot of a shop) over HTTP: the admin gets the whole shop, an agent only their own work
//   5. every sentence the app needs exists in French, English and Arabic
//   API=http://localhost:3000/api node scripts/doctor-test.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staffLogin } from './mailbox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'apps/server/package.json'));
const API = process.env.API || 'http://localhost:3000/api';
let failed = 0;
function check(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
  if (!cond) failed++;
}
const step = (s) => console.log(`→ ${s}`);
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 1. the Doctor's memory
step('server Doctor: what it keeps');
const doc = require(join(ROOT, 'apps/server/dist/doctor.js'));
{
  const s = new doc.DoctorState();
  s.record('warn', 'Courier sync', '[shop-a] 3 problem(s): ZR 401 for parcel 123');
  s.record('warn', 'Courier sync', '[shop-a] 5 problem(s): ZR 401 for parcel 98765');
  let e = s.errors();
  check(e.length === 1 && e[0].count === 2, 'the same line with other numbers is one group, seen twice', e);
  check(e[0].shop === 'shop-a' && e[0].message.startsWith('5 problem(s)'), 'the shop is read from [slug], the last text is kept', e[0]);
  s.record('warn', 'Courier sync', '[shop-b] 3 problem(s): ZR 401 for parcel 123');
  s.record('error', 'Courier sync', '[shop-a] 3 problem(s): ZR 401 for parcel 123');
  e = s.errors();
  check(e.length === 3, 'another shop or another level is another group', e.length);
  check(e[0].level === 'error', 'errors come before warnings');
  s.record('error', 'API', new Error('Cannot read properties of undefined'));
  s.record('error', 'API', { code: 42 });
  s.record('error', 'API', '');
  e = s.errors();
  check(e.some((x) => x.message === 'Cannot read properties of undefined'), 'an Error is kept by its message');
  check(e.some((x) => x.message === '{"code":42}'), 'an object is kept as JSON');
  check(e.length === 5, 'an empty line is ignored', e.length);
  check(s.inLast(MIN, 'error') === 3 && s.inLast(MIN, 'warn') === 3, 'counts per level in the last minute');
  check(s.errors(Date.now() + 25 * 60 * MIN).length === 0, 'after 24 h everything is forgotten');
  const many = new doc.DoctorState();
  for (let i = 0; i < 600; i++) many.record('error', 'API', 'same');
  check(many.errors()[0].count === 500, 'one group keeps at most 500 times (memory stays small)', many.errors()[0].count);
  for (let i = 0; i < 450; i++) many.record('warn', `S${i}`, 'x');
  check(many.errors().length <= 400, 'at most 400 groups: the oldest go', many.errors().length);
  const long = new doc.DoctorState();
  long.record('error', 'API', 'x'.repeat(5000));
  check(long.errors()[0].message.length === 400, 'a long message is cut to 400 characters');
}

step('server Doctor: the jobs');
{
  const s = new doc.DoctorState();
  const t0 = s.startedAt;
  const st = (list, name) => list.find((j) => j.name === name)?.state;
  let l = s.jobList(t0 + MIN);
  check(l.length === 12 && l.every((j) => j.state === 'waiting'), 'just started: every job is waiting', l.map((j) => j.state));
  l = s.jobList(t0 + 6 * MIN);
  check(st(l, 'notify-run') === 'late' && st(l, 'courier-sync') === 'waiting', 'a job never seen after 3 runs + 2 min is late; a slow one still waits', l);
  s.job('notify-run', true);
  check(st(s.jobList(Date.now() + MIN), 'notify-run') === 'ok', 'a job that ran is OK');
  check(st(s.jobList(Date.now() + 10 * MIN), 'notify-run') === 'late', 'and late when it stops running');
  s.job('cm-sweep', true);
  s.job('cm-sweep', false, 'boom');
  l = s.jobList();
  const cm = l.find((j) => j.name === 'cm-sweep');
  check(cm.state === 'failing' && cm.lastError === 'boom' && cm.fails === 1 && cm.runs === 2, 'its last run failed: failing, with the error', cm);
  await sleep(5);
  s.job('cm-sweep', true);
  check(st(s.jobList(), 'cm-sweep') === 'ok', 'a good run after a failure: OK again');
  const off = spawnSync(process.execPath, ['-e', `const d=require(${JSON.stringify(join(ROOT, 'apps/server/dist/doctor.js'))});const s=new d.DoctorState();console.log(JSON.stringify(s.jobList().map(j=>j.state)))`], {
    env: { ...process.env, REDIS_URL: '' },
    encoding: 'utf8',
  });
  const offStates = JSON.parse(off.stdout.trim() || '[]');
  check(offStates.length === 12 && offStates.every((x) => x === 'off'), 'without Redis every job is "off"', off.stderr || offStates);
}

// ---------------------------------------------------------------- 2. the logger
step('server Doctor: the logger');
{
  const before = doc.doctorState.errors().length;
  const log = new doc.DoctorLogger();
  log.setLogLevels(['error', 'warn']);
  log.warn('[shop-z] Commandes: 3 ligne(s) refusée(s)', 'Sheets sync');
  log.error('Something broke', 'Error: Something broke\n    at x (y.js:1:1)', 'API');
  log.error('No context given');
  const e = doc.doctorState.errors();
  check(e.length === before + 3, 'every warning and error reaches the Doctor', e.length - before);
  check(e.some((x) => x.source === 'Sheets sync' && x.shop === 'shop-z' && x.level === 'warn'), 'with the part of the server that wrote it and the shop');
  check(e.some((x) => x.source === 'API' && x.message === 'Something broke'), 'the stack is not taken for the source');
  check(e.some((x) => x.source === 'Pilotix' && x.message === 'No context given'), 'no context: "Pilotix"');
}

// ---------------------------------------------------------------- 3. the control room's Doctor over HTTP
async function req(path, body, token, headers = {}) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body ?? {}) });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

step('control room Doctor: who may open it');
// a demo server has no Pilotix staff (demo accounts never become staff): one is added for the test
const { Pool } = require('pg');
const bcrypt = require(createRequire(join(ROOT, 'packages/core/package.json')).resolve('bcryptjs'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const run = Date.now().toString(36);
const OWNER = { email: `owner-${run}@pilotix.test`, password: 'Owner-Password-1' };
await pool.query(`INSERT INTO platform.staff (name, email, password_hash, role) VALUES ('Owner Test', $1, $2, 'owner')`, [OWNER.email, await bcrypt.hash(OWNER.password, 10)]);
await pool.end();

check((await req('/platform/doctor')).status === 401, 'no token: refused');
let r = await req('/auth/login', { email: 'admin@demo.pilotix.dz', password: 'demo-pilotix' });
const SHOP_ADMIN = r.data.token;
check((await req('/platform/doctor', {}, SHOP_ADMIN)).status === 401, 'a shop token (even an admin) is not a staff token');
// with e-mails on the server, the control room asks for a code sent by e-mail (read from the test mailbox)
r = await staffLogin(API, OWNER.email, OWNER.password);
check(r.status === 201 && r.data.token, 'the owner logs in to the control room', r.data);
const OWN = r.data.token;
let SUPPORT = null;
for (const role of ['support', 'manager']) {
  const email = `${role}-${run}@pilotix.test`;
  r = await req('/platform/rpc/p.staff.save', { name: `Test ${role}`, email, role, active: true, password: 'Staff-Password-1' }, OWN);
  check(r.status === 201, `the owner adds a ${role}`, r.data);
  const tok = (await staffLogin(API, email, 'Staff-Password-1')).data.token;
  if (role === 'support') SUPPORT = tok;
  const d = await req('/platform/doctor', {}, tok);
  if (role === 'support') check(d.status === 403, 'support staff: refused', d);
  else check(d.status === 201 && Array.isArray(d.data.items), 'a manager: allowed', d.status);
}

step('control room Doctor: the answer');
// a warning the server writes itself: a request through a proxy while TRUST_PROXY is not set
await req('/auth/login', { email: 'admin@demo.pilotix.dz', password: 'demo-pilotix' }, undefined, { 'X-Forwarded-For': '10.1.2.3' });
r = await req('/platform/doctor', {}, OWN);
check(r.status === 201, 'the owner gets the report', r.status);
const R = r.data;
const LEVEL = { bad: 0, warn: 1, info: 2, ok: 3 };
const score = Math.max(5, 100 - R.items.reduce((s, i) => s + (i.level === 'bad' ? 15 : i.level === 'warn' ? 5 : 0), 0));
check(R.score === score, 'the score matches the items', { score: R.score, expected: score });
check(R.items.every((x, i, a) => i === 0 || LEVEL[a[i - 1].level] <= LEVEL[x.level]), 'worst first');
check(new Set(R.items.map((i) => i.id)).size === R.items.length, 'one item per check');
for (const g of ['cpu', 'memory', 'disk', 'dbConnections']) check(R.gauges[g] === null || (R.gauges[g] >= 0 && R.gauges[g] <= 1), `gauge ${g} between 0 and 1`, R.gauges[g]);
check(R.gauges.cpu !== null && R.gauges.memory !== null && R.gauges.dbConnections !== null, 'processor, memory and database are measured');
const F = R.facts;
check(F.cores >= 1 && F.memoryTotalMb > 0 && F.appUptimeS >= 0 && F.serverUptimeS > 0 && /^v\d+/.test(F.node), 'facts about the machine', F);
check(F.dbSizeMb > 0 && F.dbPingMs >= 0 && F.dbPingMs < 1000, 'the database answers and has a size', F);
const it = (id) => R.items.find((i) => i.id === id);
for (const id of ['cpu', 'memory', 'disk', 'restarted', 'dbPing', 'dbConnections', 'dbSlow', 'redis', 'jobs', 'errors', 'silentShops', 'config']) check(!!it(id), `check "${id}" answered`, R.items.map((i) => i.id));
check(!it('dbDown') && !it('redisDown') && !it('redisOff'), 'database and Redis are up');
check(it('redis')?.level === 'ok', 'Redis answers fast', it('redis'));
check(it('dbPing')?.level === 'ok', 'the database answers fast', it('dbPing'));
check(it('restarted')?.level === 'warn', 'the server just started: said', it('restarted'));
// CI runs without NODE_ENV=production nor TRUST_PROXY; e-mails go to the test mailbox when SMTP_HOST is set
check(
  it('config')?.level === 'warn' && it('config').list.some((l) => l.label.startsWith('SMTP_HOST')) === !process.env.SMTP_HOST && it('config').list.every((l) => l.unit === 'text'),
  'missing settings listed',
  it('config'),
);
check(['ok', 'warn'].includes(it('silentShops')?.level) && !(it('silentShops').list ?? []).some((l) => /démo|demo/i.test(l.label)), 'silent shops checked (the demo shop is never counted)', it('silentShops'));
check(R.jobs.length === 12 && R.jobs.every((j) => ['ok', 'late', 'failing', 'waiting', 'off'].includes(j.state)), 'the 12 jobs with a state', R.jobs);
check(R.errors.some((e) => e.level === 'warn' && /TRUST_PROXY/.test(e.message)), 'a warning the server wrote shows in the report', R.errors);
for (const i of R.items) for (const l of i.list ?? []) check(Number.isFinite(l.n) && typeof l.label === 'string', `${i.id}: a clean line`, l);

step('control room Doctor: the jobs really run (up to 2 minutes)');
let jobOk = false;
for (let i = 0; i < 24 && !jobOk; i++) {
  const d = (await req('/platform/doctor', {}, OWN)).data;
  jobOk = d.jobs.find((j) => j.name === 'notify-run')?.state === 'ok' && d.jobs.find((j) => j.name === 'landing-run')?.state === 'ok';
  if (!jobOk) await sleep(5000);
}
check(jobOk, 'the jobs that run every minute are seen running');

// ---------------------------------------------------------------- « Résolu » / « Ignorer »
step('control room Doctor: « Résolu » and « Ignorer » on the alerts no page can fix');
const DISMISSABLE = ['restarted', 'errors', 'courierSync', 'jobs', 'dbSlow', 'dbPoolFull', 'silentShops', 'config', 'redisOff'];
r = await req('/platform/doctor', {}, OWN);
let D1 = r.data;
check(D1.items.every((i) => !i.actions || (DISMISSABLE.includes(i.id) && ['bad', 'warn'].includes(i.level))), 'only those alerts, and only when they are a problem, have the buttons', D1.items.filter((i) => i.actions));
check(!D1.items.find((i) => i.id === 'cpu')?.actions, 'the processor has no button (nothing to hide)');
const restarted = D1.items.find((i) => i.id === 'restarted');
check(restarted?.level === 'warn' && restarted.actions?.includes('solve'), 'just after a start: « Pilotix vient de redémarrer » can be solved', restarted);
r = await req('/platform/doctor/dismiss', { id: 'restarted', kind: 'solve' }, OWN);
check(r.status === 201 && !r.data.items.some((i) => i.id === 'restarted'), '« Résolu »: the restart alert is gone', r.data.items?.map((i) => i.id));
r = await req('/platform/doctor', {}, OWN);
check(!r.data.items.some((i) => i.id === 'restarted'), '…and stays gone on the next check');
check(r.data.score === Math.max(5, 100 - r.data.items.reduce((s, i) => s + (i.level === 'bad' ? 15 : i.level === 'warn' ? 5 : 0), 0)), 'the score counts only what is shown');
r = await req('/platform/doctor/dismiss', { id: 'config', kind: 'ignore' }, OWN);
const cm = r.data.muted?.find((m) => m.id === 'config');
check(r.status === 201 && !r.data.items.some((i) => i.id === 'config') && cm && Date.parse(cm.until) - Date.now() > 6.9 * 86400000 && cm.by === 'Owner Test', '« Ignorer »: the settings alert is hidden 7 days, listed as ignored', r.data.muted);
r = await req('/platform/doctor/dismiss', { id: 'config', kind: 'restore' }, OWN);
check(r.data.items.some((i) => i.id === 'config') && !r.data.muted?.some((m) => m.id === 'config'), '« Ré-afficher »: it is back');
r = await req('/platform/doctor/dismiss', { id: 'errors', kind: 'solve' }, OWN);
check(r.status === 201 && r.data.items.find((i) => i.id === 'errors')?.level === 'ok', '« Résolu » on the errors: they are forgotten', r.data.items?.find((i) => i.id === 'errors'));
check((await req('/platform/doctor/dismiss', { id: 'config', kind: 'solve' }, OWN)).status === 400, 'an action the alert does not allow is refused');
check((await req('/platform/doctor/dismiss', { id: 'cpu', kind: 'ignore' }, OWN)).status === 400, 'an alert a page can fix cannot be hidden');
check((await req('/platform/doctor/dismiss', { id: 'config', kind: 'delete' }, OWN)).status === 400, 'an unknown action is refused');
check((await req('/platform/doctor/dismiss', { id: 'config', kind: 'ignore' })).status === 401, 'no token: refused');
check((await req('/platform/doctor/dismiss', { id: 'config', kind: 'ignore' }, SUPPORT)).status === 403, 'support staff cannot hide alerts');

// ---------------------------------------------------------------- 4. Pilotix Doctor of a shop over HTTP
step('Pilotix Doctor of a shop');
r = await req('/rpc/stats.doctor', {}, SHOP_ADMIN);
check(r.status === 201 && Array.isArray(r.data.items) && r.data.items.length === 14 && r.data.score >= 5, 'the shop admin gets the report', r.data);
const SHOP = r.data;
const agent = (await req('/auth/login', { email: 'samira@demo.pilotix.dz', password: 'demo-pilotix' })).data.token;
r = await req('/rpc/stats.doctor', {}, agent);
check(r.status === 201 && r.data.scope?.mine === true && r.data.items.every((i) => ['confirmation', 'team'].includes(i.area)), 'a confirmation agent gets only their own work', r.data);

// ---------------------------------------------------------------- 5. the sentences
step('every sentence exists in French, English and Arabic');
const SHOP_IDS = ['stockOut', 'stockSoon', 'notCalled', 'lateCallbacks', 'confRate', 'confRateDrop', 'fakeOrders', 'weakAgents', 'meVsTeam', 'notShipped', 'stuckParcels', 'openAlerts', 'returns', 'returnsUp', 'badWilayas', 'ordersDrop', 'ordersOk', 'cashLate'];
const SERVER_IDS = ['cpu', 'memory', 'disk', 'restarted', 'dbPing', 'dbConnections', 'dbSlow', 'dbDown', 'dbPoolFull', 'redisOff', 'redisDown', 'redis', 'jobs', 'errors', 'courierSync', 'silentShops', 'config', 'turnstile', 'turnstileOff'];
// the ids the code can give (read from its source): none may be missing from the lists above
const src = readFileSync(join(ROOT, 'packages/core/src/modules/doctor.ts'), 'utf8') + readFileSync(join(ROOT, 'apps/server/src/doctor.ts'), 'utf8');
const inCode = new Set([...src.matchAll(/\bid: (?:[^,{}]*\? )?'([a-zA-Z]+)'(?: : '([a-zA-Z]+)')?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean)));
for (const id of inCode) check(SHOP_IDS.includes(id) || SERVER_IDS.includes(id), `id "${id}" of the code is known to this test`);
const has = (o, path) => path.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o) !== undefined;
const hasText = (o, path) => has(o, path) || has(o, `${path}_one`) || has(o, `${path}_other`);
const seen = new Set([...SHOP.items, ...R.items].map((i) => i.id));
for (const lang of ['fr', 'en', 'ar']) {
  const L = JSON.parse(readFileSync(join(ROOT, `apps/web/src/locales/${lang}/doctor.json`), 'utf8'));
  const miss = [];
  for (const id of [...SHOP_IDS, ...SERVER_IDS]) {
    for (const k of ['title', 'short']) if (!hasText(L, `c.${id}.${k}`)) miss.push(`c.${id}.${k}`);
    // the checks that can be a problem need "why" and "fix"
    if (!['confRate', 'returns', 'ordersOk'].includes(id)) for (const k of ['why', 'fix']) if (!hasText(L, `c.${id}.${k}`)) miss.push(`c.${id}.${k}`);
  }
  for (const id of seen) if (!hasText(L, `c.${id}.title`)) miss.push(`seen ${id}`);
  for (const a of ['stock', 'confirmation', 'team', 'depot', 'delivery', 'sales', 'cash', 'server', 'database', 'jobs', 'code', 'shops', 'config']) if (!has(L, `area.${a}`)) miss.push(`area.${a}`);
  for (const j of R.jobs) if (!has(L, `job.${j.name}`)) miss.push(`job.${j.name}`);
  for (const st of ['ok', 'late', 'failing', 'waiting', 'off']) if (!has(L, `jobs.st.${st}`)) miss.push(`jobs.st.${st}`);
  for (const lv of ['bad', 'warn', 'ok', 'info']) if (!has(L, `tag.${lv}`)) miss.push(`tag.${lv}`);
  for (const k of ['say.bad', 'say.warn', 'u.days', 'u.hours', 'gauge.cores']) if (!hasText(L, k)) miss.push(k);
  if (lang === 'ar') for (const f of ['zero', 'one', 'two', 'few', 'many', 'other']) if (!has(L, `c.stockOut.title_${f}`)) miss.push(`plural ${f}`);
  check(!miss.length, `${lang}: every Doctor sentence is there`, miss);
  // {{x}} in a sentence must be a number the check sends (the sentences shown for each item's level)
  const bad = [];
  for (const i of [...SHOP.items, ...R.items]) {
    const c = L.c[i.id] ?? {};
    const keys = i.level === 'bad' || i.level === 'warn' ? ['title', i.params?.amount !== undefined ? 'whyMoney' : 'why', 'fix'] : [i.level === 'info' ? 'info' : 'okTitle', 'short'];
    for (const k of keys) {
      const texts = Object.entries(c).filter(([kk]) => kk === k || kk.startsWith(`${k}_`)).map(([, v]) => String(v));
      for (const t of texts) for (const m of t.matchAll(/\{\{(\w+)\}\}/g)) if (m[1] !== 'count' && !(m[1] in (i.params ?? {}))) bad.push(`${i.id} (${i.level}).${k}: {{${m[1]}}}`);
    }
  }
  check(!bad.length, `${lang}: no sentence waits for a number that never comes`, bad);
  const plat = JSON.parse(readFileSync(join(ROOT, `apps/web/src/locales/${lang}/platform.json`), 'utf8'));
  const dash = JSON.parse(readFileSync(join(ROOT, `apps/web/src/locales/${lang}/dashboard.json`), 'utf8'));
  check(!!plat.nav.doctor && !!dash.areas.doctor, `${lang}: the menu names (control room, dashboard tab)`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll Doctor checks passed');
process.exit(failed ? 1 : 0);
