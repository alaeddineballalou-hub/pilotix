// Pilotix Spy popup: the Pilotix addresses (add / remove) and a test search.
// Address changes go to the service worker (chrome.runtime.sendMessage); the test search uses the same port
// ('pilotix-search') as the Pilotix page's bridge.
import { originPattern, pilotixOrigin } from './sites.js';

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

function render(sites) {
  const list = $('sites');
  list.replaceChildren(
    ...sites.map((origin) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = origin;
      name.title = origin;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'small';
      remove.textContent = 'Retirer';
      remove.addEventListener('click', () => removeSite(origin, remove));
      li.append(name, remove);
      return li;
    }),
  );
  $('noSite').hidden = sites.length > 0;
  if (!testing) status(sites.length ? 'Prête' : 'À configurer', sites.length ? 'ok' : 'warn');
}

async function call(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (!r?.ok) throw new Error(r?.message || 'L’extension ne répond pas.');
  return r;
}

async function refresh() {
  try {
    render((await call({ type: 'sites' })).sites);
  } catch (e) {
    say($('siteMsg'), e.message, 'bad');
  }
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

refresh();
