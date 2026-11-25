// Pilotix's phone app checked on a test Android phone (an emulator on GitHub), the way a person uses it, with nobody
// there (owner's ask, 25 Nov 2026: « find a way to test the APK without me »):
//  1. the app the phones have now, installed and opened: Pilotix (the live site) offers the new version;
//  2. « Mettre à jour »: the app downloads it, Android asks « Update? », the finger says yes: the new version must
//     really be installed (on 25 Nov a phone kept 31 and Pilotix offered 33 again and again);
//  3. the new app opens, nothing crashed, and the offer does not come back;
//  4. a real Firebase ring (the « Tester la sonnerie » message) with the phone locked: the ring screen shows.
// A picture of each step goes to --out, with summary.md. The page is read and touched through the app's own WebView
// (Chrome's DevTools: a test app allows it), Android's own screens through uiautomator, as a finger would.
// Used by .github/workflows/app-check.yml.
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    old: { type: 'string' }, // the app installed first (the one phones have now)
    new: { type: 'string' }, // the new app: put in by cable only when the update through the app failed (to still test the ring)
    expect: { type: 'string' }, // the new app's build
    out: { type: 'string', default: 'shots' },
  },
});
const PKG = 'com.pilotix.app';
const out = opt.out;
mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- the report
const lines = [];
let failed = false;
const say = (mark, t) => {
  console.log(`${mark} ${t}`);
  lines.push(`${mark} ${t}`);
};
const ok = (t) => say('✅', t);
const bad = (t) => {
  failed = true;
  say('❌', t);
};
const warn = (t) => say('⚠️', t);
const note = (t) => say('  ·', t);

// ---------------------------------------------------------------- the phone
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function adb(args, { timeout = 60_000, buffer = false, quiet = false } = {}) {
  try {
    return execFileSync('adb', args, { encoding: buffer ? 'buffer' : 'utf8', timeout, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (quiet) return buffer ? Buffer.alloc(0) : `${e.stdout ?? ''}${e.stderr ?? ''}`;
    throw new Error(`adb ${args.join(' ')}: ${String(e.stderr || e.message).trim().slice(0, 400)}`);
  }
}
const sh = (cmd, o = {}) => adb(['shell', cmd], { quiet: true, ...o });

let shots = 0;
function shot(name) {
  const png = adb(['exec-out', 'screencap', '-p'], { buffer: true, quiet: true, timeout: 30_000 });
  if (png.length > 1000) writeFileSync(`${out}/${String(++shots).padStart(2, '0')}-${name}.png`, png);
}

const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** What is on screen: every element with its words, its app, and its middle. */
function ui() {
  for (let i = 0; i < 4; i++) {
    const r = sh('uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml', { timeout: 40_000 });
    if (r.includes('<hierarchy')) {
      return [...r.matchAll(/<node [^>]*>/g)].map(([n]) => {
        const a = (k) => n.match(new RegExp(`\\s${k}="([^"]*)"`))?.[1] ?? '';
        const b = a('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
        return {
          text: unxml(a('text')).trim(),
          desc: unxml(a('content-desc')).trim(),
          id: a('resource-id'),
          pkg: a('package'),
          clickable: a('clickable') === 'true',
          x: b ? (Number(b[1]) + Number(b[3])) / 2 : 0,
          y: b ? (Number(b[2]) + Number(b[4])) / 2 : 0,
        };
      });
    }
  }
  return [];
}
const words = (nodes) => [...new Set(nodes.map((n) => n.text || n.desc).filter(Boolean))].join(' | ').slice(0, 400);
const tap = (n) => sh(`input tap ${Math.round(n.x)} ${Math.round(n.y)}`);
const focus = () => sh('dumpsys window').match(/mCurrentFocus=[^\n]*/)?.[0] ?? '';
const build = () => Number(sh(`dumpsys package ${PKG}`).match(/versionCode=(\d+)/)?.[1] ?? 0);
const start = () => sh(`am start -W -n ${PKG}/.MainActivity`, { timeout: 60_000 });

async function until(what, fn, ms, every = 1500) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`${what}: still not after ${Math.round(ms / 1000)} s${last ? ` (${last.message})` : ''}`);
}

// ---------------------------------------------------------------- the page inside the app (Chrome DevTools)
let ws = null;
let wsPid = '';
let seq = 0;
const waiting = new Map();
async function connect() {
  const pid = sh(`pidof ${PKG}`).trim().split(/\s+/)[0];
  if (!pid) throw new Error('the app is not running');
  if (ws && wsPid === pid && ws.readyState === 1) return;
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  ws = null;
  adb(['forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`]);
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((t) => t.type === 'page' && /^https:\/\/(direct\.)?pilotix\.online\//.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page in the app yet');
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.onopen = res;
    sock.onerror = () => rej(new Error('DevTools did not open'));
  });
  sock.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    const f = waiting.get(m.id);
    if (f) {
      waiting.delete(m.id);
      f(m);
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    for (const f of waiting.values()) f({ error: { message: 'the page closed' } });
    waiting.clear();
  };
  ws = sock;
  wsPid = pid;
}
/** Runs a line of JavaScript in the app's page and gives its answer. */
async function js(expression, timeout = 20_000) {
  await connect();
  const id = ++seq;
  const answer = new Promise((res) => {
    waiting.set(id, res);
    setTimeout(() => waiting.delete(id) && res({ error: { message: 'no answer' } }), timeout);
  });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const m = await answer;
  if (m.error) throw new Error(m.error.message);
  const ex = m.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description?.split('\n')[0] ?? ex.text);
  return m.result?.result?.value;
}
const pilotixOpen = async () => /^(direct\.)?pilotix\.online$/.test(await js('location.host')) && (await js('document.readyState')) === 'complete';
const sheetText = () => js(`(() => { const s = document.querySelector('.au-sheet'); return s ? s.innerText.replace(/\\s+/g, ' ').trim() : '' })()`);

// the sheet's « allow » title in the three languages (apps/web/src/locales)
const allowTitles = ['fr', 'en', 'ar'].map((l) => {
  const j = JSON.parse(readFileSync(new URL(`../../apps/web/src/locales/${l}/common.json`, import.meta.url), 'utf8'));
  return j.appUpdate?.allowTitle ?? '';
});

// ---------------------------------------------------------------- Firebase: the « Tester la sonnerie » message
async function sendRing(token) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id });
  const claim = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key).toString('base64url');
  const t = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const access = (await t.json().catch(() => ({}))).access_token;
  if (!access) throw new Error(`Google refused the sign-in (${t.status})`);
  // packages/core confblock › phoneTest, as push.ts › fcmMessage sends it (every value a string, true → '1')
  const data = { title: '🔔 Test de la sonnerie Pilotix', body: 'Test automatique sur un téléphone de test.', tag: 'conf-test', url: '#/confirmation/nouvelles', alarm: '1', conf: '1', ring: '1' };
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '120s' } } }),
  });
  if (!r.ok) throw new Error(`Firebase refused the message (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------- the check
async function main() {
  const release = sh('getprop ro.build.version.release').trim();
  note(`Test phone: Android ${release} (API ${sh('getprop ro.build.version.sdk').trim()}), ${sh('getprop ro.product.model').trim()}`);
  sh('svc power stayon true');
  sh('input keyevent 224'); // awake
  sh('wm dismiss-keyguard');
  for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) sh(`settings put global ${k} 0`);
  // the old app goes in by cable without Play Protect's scan; the update below goes the phones' way, with it
  sh('settings put global verifier_verify_adb_installs 0');

  // 1. the app the phones have now
  adb(['install', '-r', opt.old], { timeout: 240_000 });
  const before = build();
  ok(`Old app installed: version ${before}`);
  const expect = Number(opt.expect) || 0;
  // « Autoriser cette source » for Pilotix: the person does it once in Android's settings
  sh(`appops set ${PKG} REQUEST_INSTALL_PACKAGES allow`);
  start();
  await until('Pilotix opens in the app', pilotixOpen, 150_000, 2000);
  ok(`Pilotix opened in the app (${await js('location.host')})`);
  await sleep(2500);
  shot('old-app');

  // 2. the offer, then « Mettre à jour »
  let offered = '';
  try {
    offered = await until('the « Nouvelle version » offer', sheetText, 90_000, 2000);
    ok(`Pilotix offers the new version: « ${offered.slice(0, 120)} »`);
    shot('offer');
  } catch (e) {
    bad(`${e.message} · the server says: ${String(await js("fetch('/api/app').then(r => r.text())").catch((x) => x.message)).slice(0, 300)}`);
  }
  let after = before;
  if (offered) {
    await js(`(() => { document.querySelector('.au-sheet .au-foot .btn.primary').click(); return true })()`);
    note('Tapped « Mettre à jour »');
    let seen = '';
    try {
      seen = await until(
        "Android's « Update? »",
        async () => {
          if (/packageinstaller/i.test(focus())) return 'installer';
          const s = await sheetText().catch(() => '');
          if (await js(`!!document.querySelector('.au-sheet .au-note.bad')`).catch(() => false)) return `failed: ${s}`;
          if (s && allowTitles.some((t) => t && s.startsWith(t))) return `allow: ${s}`;
          return '';
        },
        240_000,
        1500,
      );
    } catch (e) {
      bad(e.message);
      shot('no-installer');
    }
    if (seen.startsWith('failed') || seen.startsWith('allow')) {
      bad(`Pilotix stopped before Android: « ${seen} »`);
      shot('stopped');
    } else if (seen === 'installer') {
      await sleep(2000);
      shot('android-asks');
      const asks = ui();
      note(`Android shows: ${words(asks)}`);
      const yes =
        asks.find((n) => n.pkg !== PKG && n.clickable && /^(update|install|mettre à jour|installer|تحديث|تثبيت)$/i.test(n.text)) ??
        asks.find((n) => n.id === 'android:id/button1');
      if (!yes) bad("No « Update » button on Android's screen");
      else {
        tap(yes);
        note(`Tapped Android's « ${yes.text} »`);
        // Play Protect or Android may say something on the way: shown and noted, and its « install anyway » taken
        let taps = 0;
        let reason = '';
        after = await until(
          `version ${expect || 'new'} installed`,
          async () => {
            const b = build();
            if (b > before) return b;
            const now = ui();
            const said = words(now);
            if (/not installed|n'a pas été installée|pas installée|conflict|incompatible|invalid|blocked|bloqu|unsafe|dangereu/i.test(said)) {
              reason = said;
              return -1;
            }
            // never « OK » / « Annuler »: on Play Protect's screens they stop the install
            const go = now.find((n) => n.pkg !== PKG && n.clickable && /^(install anyway|install without scanning|installer quand même|installer sans analyse|more details|plus de détails|update anyway)$/i.test(n.text));
            if (go && taps < 3) {
              taps++;
              shot(`on-the-way-${taps}`);
              note(`On the way Android says: ${said} → tapped « ${go.text} »`);
              tap(go);
            }
            return 0;
          },
          150_000,
          2000,
        ).catch((e) => {
          reason ||= e.message;
          return before;
        });
        if (after === -1 || after <= before) {
          after = build();
          bad(`The update did NOT install (still version ${after}): ${reason}`);
          shot('not-installed');
          const log = adb(['logcat', '-d', '-v', 'brief'], { quiet: true, timeout: 30_000 })
            .split('\n')
            .filter((l) => /INSTALL_FAILED|PackageInstaller|installPackage|Failure \[/i.test(l))
            .slice(-12);
          if (log.length) note(`Android's log: ${log.join(' ⏎ ').slice(0, 1200)}`);
        } else {
          await sleep(2500);
          ok(`The update installed through the app: version ${before} → ${after}`);
          shot('installed');
        }
      }
    }
  }

  // the update failed: the new app put in by cable, to still check it opens and rings
  if (build() <= before && opt.new) {
    adb(['install', '-r', opt.new], { timeout: 240_000 });
    warn(`New app put in by cable to go on with the check (version ${build()})`);
  }

  // 3. the new app opens, without crash, and asks no more
  start();
  ws = null;
  await until('the new app opens Pilotix', pilotixOpen, 150_000, 2000);
  const info = await js(`window.Capacitor.nativePromise('AppUpdate', 'info')`);
  if (expect && Number(info?.build) !== expect) bad(`The app says version ${info?.build}, not ${expect}`);
  else ok(`The new app runs: version ${info?.build} (${info?.version})`);
  await sleep(20_000); // the page asks the server 8 s after it opens
  const again = await sheetText().catch(() => '');
  if (again) bad(`The offer came back after the update: « ${again.slice(0, 120)} »`);
  else ok('No more « Nouvelle version » offer');
  shot('new-app');

  // 4. a real ring through Firebase, the phone locked
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) warn('Ring not tested: no Firebase key here');
  else {
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh(`appops set ${PKG} USE_FULL_SCREEN_INTENT allow`);
    let st = null;
    try {
      st = await until(
        "this phone's Firebase address",
        async () => {
          const r = await js(`window.Capacitor.nativePromise('PilotixPush', 'enable', { ask: false })`, 60_000);
          if (r?.token) return r;
          throw new Error(r?.error || r?.state || 'no answer');
        },
        150_000,
        5000,
      );
    } catch (e) {
      warn(`Ring not tested on this test phone: ${e.message}`);
    }
    if (st) {
      ok(`Firebase address received · ring channel ${st.ring ? 'on' : 'OFF'} · full screen ${st.fullScreen ? 'allowed' : 'NOT allowed'} · alarm volume ${st.alarmVolume}`);
      sh('svc power stayon false');
      sh('input keyevent 223'); // the screen off: a locked phone in a pocket
      await sleep(4000);
      try {
        await sendRing(st.token);
        note('Ring sent through Firebase (the « Tester la sonnerie » message)');
        await until('the ring screen over the locked phone', () => /RingActivity/.test(focus()), 60_000, 1000);
        await sleep(1500);
        ok('The ring screen shows over the locked phone');
        shot('ring-locked');
      } catch (e) {
        bad(e.message);
        shot('no-ring');
      }
      const notes = sh('dumpsys notification --noredact');
      if (/pilotix_ring/.test(notes)) ok('Ring notification on the loud channel « pilotix_ring »');
      else bad('No notification on the ring channel');
      sh('input keyevent 224');
      sh('svc power stayon true');
    }
  }

  const crash = adb(['logcat', '-d', '-b', 'crash'], { quiet: true, timeout: 30_000 });
  if (crash.includes(PKG)) bad(`The app crashed: ${crash.split('\n').filter((l) => /Exception|Error|at com\.pilotix/.test(l)).slice(0, 6).join(' ⏎ ')}`);
  else ok('No crash');
}

try {
  await main();
} catch (e) {
  bad(`Stopped: ${e.message}`);
  shot('stopped');
}
const text = `${lines.join('\n')}\n\n${failed ? '❌ Something failed' : '✅ All good'}\n`;
writeFileSync(`${out}/summary.md`, text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${process.env.PHONE_NAME ?? 'Test phone'}\n\n${lines.join('\n\n')}\n`);
process.exit(failed ? 1 : 0);
