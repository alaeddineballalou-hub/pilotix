// After a deploy: the real site, from outside, without changing anything in it (no account, no store is made).
// The server and the website must be this version; each public door answers as it should.
//   SITE=https://pilotix.online node scripts/live-check.mjs
const SITE = (process.env.SITE || 'https://pilotix.online').replace(/\/+$/, '');
const API = `${SITE}/api`;
let failed = 0;
// Cloudflare's bot protection may answer « Just a moment… » to this checker (a robot) instead of the site: that is
// not the site being broken, only the checker not let in. Such answers are counted apart (a warning), never as failures.
let blocked = 0;
let lastChallenged = false;
const isChallenge = (status, text, headers) =>
  (status === 403 || status === 503 || status === 429) &&
  (headers?.get?.('cf-mitigated') === 'challenge' || /Just a moment\.\.\.|challenge-platform|cf_chl_|cf-chl-/i.test(String(text ?? '')));
const check = (cond, label, extra) => {
  if (!cond && lastChallenged) {
    blocked++;
    console.log(`? ${label} — not checked: Cloudflare asked the checker « Just a moment… » (bot protection)`);
    return;
  }
  console.log(`${cond ? '✓' : '✗'} ${label}${extra !== undefined ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 300)}` : ''}`);
  if (!cond) {
    failed++;
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Live check::${label}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
  }
};
const note = (label) => console.log(`• ${label}`);
async function get(path, opts = {}) {
  const r = await fetch(path.startsWith('http') ? path : API + path, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* text */
  }
  lastChallenged = isChallenge(r.status, text, r.headers);
  return { status: r.status, data, text, headers: r.headers, challenged: lastChallenged };
}
/** Cloudflare did not let the checker in at all: say so plainly (a warning, not a failure) and stop. The server checks
 *  itself during the update (the « Server: » line of the Deploy run), which is the proof when this happens. */
function stopBlocked(where) {
  const msg = `Cloudflare's bot protection answered « Just a moment… » to this checker at ${where}: the site cannot be checked from outside (it is not broken). The server's own check is the « Server: » line of the update.`;
  console.log(`\n⚠️  ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Live check not possible::${msg}`);
  process.exit(0);
}
const post = (path, body) => get(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const nobody = `nobody-${Date.now().toString(36)}@example.com`;

// the server answers (it may still be starting after the deploy: up to 5 minutes)
let up = false;
let last = '';
for (let i = 0; i < 30 && !up; i++) {
  const h = await get('/health').catch((e) => ({ status: 0, text: String(e?.cause?.code || e?.cause?.message || e?.message || e), challenged: false }));
  // Cloudflare stops the checker: waiting will not change it
  if (h.challenged) stopBlocked(`${SITE}/api/health`);
  up = h.status === 200;
  last = `${h.status} ${String(h.text ?? '').slice(0, 160)}`;
  if (!up) await new Promise((r) => setTimeout(r, 10_000));
}
check(up, `${SITE}/api/health answers`, up ? undefined : last);
if (!up) process.exit(1);

let r = await get('/legal');
check(r.status === 200 && typeof r.data?.company === 'string', 'the server is this version (/api/legal)', r.data);
r = await get('/auth/signup');
check(r.status === 200 && typeof r.data?.open === 'boolean' && r.data.trialDays > 0, '« Créer ma boutique »: its page answers', r.data);
note(r.data?.open ? 'sign-ups are open (e-mails work)' : 'sign-ups are closed, or the server cannot send e-mails');
r = await get('/auth/forgot');
check(r.status === 200 && typeof r.data?.available === 'boolean', '« Mot de passe oublié »: its page answers', r.data);
note(r.data?.available ? 'e-mails are set up on the server' : 'e-mails are NOT set up: no reset links, no login codes, no sign-up');
r = await get('/auth/store-name?name=Live%20Check');
check(r.status === 200 && typeof r.data?.slug === 'string' && typeof r.data?.free === 'boolean', 'a store name can be checked', r.data);
r = await get('/auth/store-name?name=x&slug=platform');
check(r.status === 200 && r.data?.free === false, 'Pilotix’s own words are never a store name', r.data);
r = await post('/auth/login', { email: nobody, password: 'Wrong-Password-1' });
check(r.status === 401 && r.data?.message === 'Email ou mot de passe incorrect', 'a login with an unknown e-mail is refused like a wrong password', r.data);
r = await post('/platform/auth/login', { email: nobody, password: 'Wrong-Password-1' });
check(r.status === 401, 'the control room refuses an unknown e-mail', r.data);
r = await post('/rpc/me.get', {});
check(r.status === 401, 'the app’s actions need a login', r.status);
r = await get('/platform/health');
check(r.status === 401, 'the control room’s pages need its own login', r.status);
r = await get('/auth/link/not-a-real-link');
check(r.status === 200 && r.data?.kind === null, 'a wrong e-mail link is just « no longer valid »', r.data);
r = await get('/domain-check?domain=no-such-shop.example');
check(r.status === 404, 'no HTTPS certificate for a domain no shop has', r.status);
r = await get('/llms.txt');
check(r.status === 200 && /^# /.test(r.text), 'llms.txt for AI assistants', r.text.slice(0, 80));
r = await get('/auth/demo');
check(r.status === 200 && typeof r.data?.available === 'boolean', 'the demo button’s info', r.data);

// the website: this version's app
r = await get(`${SITE}/`);
check(r.status === 200 && /<div id="root"/.test(r.text), 'the website answers', r.status);
const scripts = [...new Set(r.text.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/g) ?? [])];
let found = false;
for (const s of scripts) if (!found) found = (await get(`${SITE}${s}`)).text.includes('verify/send/ticket');
check(found, 'the website is this version', scripts.join(' '));
check(/data-skin="doux"/.test(r.text) && /family=Readex\+Pro/.test(r.text), 'the website shows the new look (Doux, Readex Pro)', r.text.match(/<html[^>]*>/)?.[0]);

if (blocked && process.env.GITHUB_ACTIONS) console.log(`::warning title=Live check::${blocked} check(s) not done: Cloudflare asked the checker « Just a moment… » (bot protection)`);
console.log(
  failed
    ? `\n❌ ${failed} check(s) failed on ${SITE}`
    : blocked
      ? `\n✅ ${SITE}: what could be checked is live with this version (${blocked} check(s) stopped by Cloudflare's bot protection)`
      : `\n✅ ${SITE}: the server and the website are live with this version`,
);
process.exit(failed ? 1 : 0);
