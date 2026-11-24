// Pilotix extension popup: « Lire la page » on a competitor's site, the Pilotix addresses (Pilotix's own are always
// there; a shop's own server can be added) and a test search. Address changes go to the service worker
// (chrome.runtime.sendMessage); the test search uses the same port ('pilotix-search') as the Pilotix page's bridge.
// « Lire la page » reads the open tab (Chrome's activeTab: given by this click on the extension, for that tab only) and
// hands what it shows to the open Pilotix page, which saves it on the ads of that page.
import { pageData, priceOf, readablePage } from './price.js';
import { BUILT_IN, originPattern, pilotixOrigin } from './sites.js';

const $ = (id) => document.getElementById(id);
const STEPS = {
  open: 'Ouverture de la bibliothèque de pubs…',
  read: 'Lecture des pubs…',
  pictures: 'Préparation des images…',
};

$('version').textContent = `Version ${chrome.runtime.getManifest().version}`;

function say(el, text, kind = '') {
  el.className = `msg ${kind}`.trim();
  el.textContent = text;
}

function status(text, kind) {
  const s = $('status');
  s.textContent = text;
  s.className = `pill ${kind}`;
}

let testing = false;
/** Pilotix open in a tab of this Chrome (the extension goes through it for everything it shows or saves) */
let pilotixOpen = null;

function showStatus() {
  if (testing) return;
  if (pilotixOpen === null) return status('…', '');
  status(pilotixOpen ? 'Prête' : 'Ouvrez Pilotix', pilotixOpen ? 'ok' : 'warn');
  $('openMsg').hidden = pilotixOpen;
}

function render(sites) {
  const row = (origin, own) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = origin.replace(/^https:\/\//, '');
    name.title = origin;
    li.append(name);
    if (own) {
      const tag = document.createElement('small');
      tag.textContent = 'toujours là';
      li.append(tag);
    } else {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'small';
      remove.textContent = 'Retirer';
      remove.addEventListener('click', () => removeSite(origin, remove));
      li.append(remove);
    }
    return li;
  };
  $('sites').replaceChildren(...BUILT_IN.map((o) => row(o, true)), ...sites.filter((o) => !BUILT_IN.includes(o)).map((o) => row(o, false)));
  if (sites.some((o) => !BUILT_IN.includes(o))) $('more').open = true;
}

async function call(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (!r?.ok) throw new Error(r?.message || 'L’extension ne répond pas.');
  return r;
}

async function refresh() {
  try {
    render((await call({ type: 'sites' })).sites);
    pilotixOpen = (await call({ type: 'status' })).open > 0;
  } catch (e) {
    say($('siteMsg'), e.message, 'bad');
  }
  showStatus();
}

// Ajouter: Chrome's permission question must start right in the click (user gesture), before anything async.
$('add').addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = $('siteMsg');
  let origin;
  try {
    origin = pilotixOrigin($('site').value);
  } catch (err) {
    say(msg, err.message, 'bad');
    return;
  }
  say(msg, 'Autorisez l’accès dans la fenêtre de Chrome…');
  chrome.permissions.request({ origins: [originPattern(origin)] }).then(
    async (granted) => {
      if (!granted) return say(msg, 'Accès refusé : l’extension doit pouvoir parler à votre page Pilotix.', 'bad');
      try {
        render((await call({ type: 'add', origin })).sites);
        $('site').value = '';
        say(msg, `${origin} ajoutée. Rechargez la page Pilotix si elle était ouverte.`, 'ok');
      } catch (err) {
        say(msg, err.message, 'bad');
      }
    },
    (err) => say(msg, String(err?.message ?? err), 'bad'),
  );
});

async function removeSite(origin, button) {
  button.disabled = true;
  try {
    render((await call({ type: 'remove', origin })).sites);
    say($('siteMsg'), `${origin} retirée.`);
  } catch (e) {
    button.disabled = false;
    say($('siteMsg'), e.message, 'bad');
  }
}

const plural = (n) => (n === 0 ? 'Aucune pub trouvée' : n === 1 ? '1 pub trouvée' : `${n} pubs trouvées`);

// Tester: one real search for « poussette » in Algeria, through the service worker like a Pilotix page.
$('test').addEventListener('click', () => {
  const button = $('test');
  const out = $('testMsg');
  const thumbs = $('thumbs');
  const started = Date.now();
  let done = false;
  testing = true;
  button.disabled = true;
  thumbs.replaceChildren();
  status('Recherche…', 'warn');
  say(out, 'Recherche en attente…');

  const finish = () => {
    done = true;
    testing = false;
    button.disabled = false;
    refresh();
  };
  const port = chrome.runtime.connect({ name: 'pilotix-search' });
  port.onMessage.addListener((m) => {
    if (done || !m) return;
    if (m.type === 'progress') say(out, STEPS[m.step] ?? '…');
    else if (m.type === 'result') {
      const ads = Array.isArray(m.ads) ? m.ads : [];
      const pics = ads.filter((a) => a.media);
      out.className = 'msg ok';
      out.textContent = plural(ads.length);
      const more = document.createElement('small');
      const seconds = Math.round((Date.now() - started) / 1000);
      more.textContent = `${pics.length} image(s) · ${seconds} s${typeof m.count === 'number' && m.count > ads.length ? ` · Facebook en compte ${m.count}` : ''}`;
      out.append(more);
      thumbs.replaceChildren(
        ...pics.slice(0, 4).map((a) => {
          const img = document.createElement('img');
          img.src = a.media;
          img.alt = a.pageName || '';
          img.title = a.pageName || '';
          return img;
        }),
      );
      port.disconnect();
      finish();
    } else if (m.type === 'error') {
      say(out, String(m.message || 'Erreur de l’extension'), 'bad');
      port.disconnect();
      finish();
    }
  });
  port.onDisconnect.addListener(() => {
    if (done) return;
    say(out, 'L’extension s’est arrêtée pendant la recherche. Réessayez.', 'bad');
    finish();
  });
  port.postMessage({ type: 'search', query: 'poussette', country: 'DZ', max: 30 });
});

// ---------------------------------------------------------------- « Lire la page »
const da = (n) => `${Math.round(n).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ')} DA`;
let pageTab = null;

async function findPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const sites = (await call({ type: 'sites' }).catch(() => ({ sites: [] }))).sites ?? [];
    if (!tab?.id || !readablePage(tab.url, [...BUILT_IN, ...sites])) return;
    pageTab = tab;
    $('pageSec').hidden = false;
  } catch {
    // no page to read here
  }
}

/** What Pilotix read on the page (offers, delivery, why buy there), as short lines under the message. */
function showRead(read) {
  const list = $('pageRead');
  const lines = [];
  if (read && typeof read === 'object') {
    if (read.delivery === 0) lines.push(['Livraison', `gratuite${read.deliveryNote ? ` · ${read.deliveryNote}` : ''}`]);
    else if (typeof read.delivery === 'number') lines.push(['Livraison', `${da(read.delivery)}${read.deliveryNote ? ` · ${read.deliveryNote}` : ''}`]);
    else if (read.deliveryNote) lines.push(['Livraison', read.deliveryNote]);
    for (const o of (Array.isArray(read.offers) ? read.offers : []).slice(0, 4)) lines.push(['Offre', String(o)]);
    for (const w of (Array.isArray(read.whyUs) ? read.whyUs : []).slice(0, 4)) lines.push(['Promet', String(w)]);
  }
  list.replaceChildren(
    ...lines.map(([k, v]) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = k;
      const t = document.createElement('span');
      t.textContent = v;
      li.append(b, t);
      return li;
    }),
  );
  list.hidden = lines.length === 0;
}

$('readPage').addEventListener('click', async () => {
  const button = $('readPage');
  const out = $('pageMsg');
  if (!pageTab) return;
  button.disabled = true;
  showRead(null);
  say(out, 'Lecture de la page…');
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: pageTab.id }, func: pageData });
    const data = res?.result;
    if (!data || typeof data !== 'object') throw new Error('page vide');
    const found = priceOf(data);
    const shown = found ? (found.oldPrice ? `${da(found.price)} (avant ${da(found.oldPrice)})` : da(found.price)) : 'Pas de prix en DA';
    say(out, `${shown} · envoi à Pilotix…`);
    const r = await chrome.runtime.sendMessage({
      type: 'sitePrice',
      url: data.url,
      price: found?.price ?? null,
      oldPrice: found?.oldPrice ?? null,
      title: data.title,
      page: { text: String(data.text || '').slice(0, 8000) },
    });
    if (!r?.ok) say(out, `${shown}. ${r?.message || 'L’extension ne répond pas.'}`, 'bad');
    else if (r.saved > 0) {
      say(out, `${shown} · envoyé à AI Spy (${r.saved === 1 ? '1 pub' : `${r.saved} pubs`}).`, 'ok');
      showRead(r.read);
    } else say(out, `${shown}, mais aucune pub de cette page dans AI Spy.`, 'bad');
  } catch (e) {
    say(out, `Chrome n’a pas laissé lire cette page : ${String(e?.message ?? e).slice(0, 160)}`, 'bad');
  } finally {
    button.disabled = false;
  }
});

findPage();
refresh();
