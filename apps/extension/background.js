// Pilotix Spy service worker.
//  - Searches: the bridge on a Pilotix page (bridge.js) or the popup opens a port named 'pilotix-search' and sends
//    { type: 'search', query, country, max }. Searches run one at a time: Facebook's public Ad Library opens in a
//    background tab, the ads are read from the page, the tab is closed, small pictures are made, and the port gets
//    { type: 'progress', step } messages ('open' | 'read' | 'pictures'), then { type: 'result', count, ads } or
//    { type: 'error', message }.
//  - Pilotix addresses: the popup adds and removes them; each one gets bridge.js registered as a content script.
import { checkSearch, fromLibrary, libraryUrl, readAdLibrary } from './parse.js';
import { addPictures } from './pictures.js';
import { SITES_KEY, originPattern, pilotixOrigin, scriptId } from './sites.js';

const SEARCH_TIMEOUT = 75_000; // ms for a whole search
const LOAD_TIMEOUT = 35_000; // ms waiting for the tab to load (then we try to read anyway)
const READ_TIMEOUT = 20_000; // ms trying to find the ads in the loaded page
const GAP = 1_500; // ms between two searches

const MSG = {
  noLibrary:
    'Facebook n’a pas montré la bibliothèque de pubs (connexion ou vérification demandée). Ouvrez facebook.com/ads/library une fois dans Chrome, puis réessayez.',
  timeout: 'Facebook met trop de temps à répondre. Réessayez dans un instant.',
  closed: 'L’onglet Facebook a été fermé avant la fin. Réessayez.',
  cancelled: 'Recherche annulée.',
  refused: 'Cette page n’est pas une adresse Pilotix ajoutée dans l’extension.',
};

/** An error whose message is shown to the user as is (French). */
class SearchError extends Error {}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      clearTimeout(t);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', stop, { once: true });
  });

const messageOf = (e) => {
  if (e instanceof SearchError) return e.message;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return MSG.timeout;
  return `Erreur de l’extension : ${String(e?.message ?? e).slice(0, 200)}`;
};

// ---------------------------------------------------------------- the queue (one search at a time)
let chain = Promise.resolve();
let lastEnd = 0;
let pending = 0;
let keepAlive = null;

/** Calling an extension API every 20 s keeps the service worker awake while searches are waiting or running. */
function busy(delta) {
  pending += delta;
  if (pending > 0 && !keepAlive) keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError), 20_000);
  if (pending <= 0 && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
}

function enqueue(job) {
  busy(+1);
  const run = chain.then(async () => {
    try {
      if (job.cancelled) return;
      const wait = lastEnd + GAP - Date.now();
      if (wait > 0) await sleep(wait);
      if (job.cancelled) return;
      await runSearch(job);
    } finally {
      lastEnd = Date.now();
      busy(-1);
    }
  });
  chain = run.catch(() => {});
}

// ---------------------------------------------------------------- one search
async function runSearch(job) {
  const ctl = new AbortController();
  const deadline = Date.now() + SEARCH_TIMEOUT;
  const timer = setTimeout(() => ctl.abort(new SearchError(MSG.timeout)), SEARCH_TIMEOUT);
  job.abort = (reason) => ctl.abort(reason);
  let tabId = null;
  try {
    job.send({ type: 'progress', step: 'open' });
    const tab = await chrome.tabs.create({ url: libraryUrl(job.query, job.country), active: false });
    tabId = tab.id;
    chrome.tabs.update(tabId, { muted: true }).catch(() => {});
    await waitForLoad(tabId, ctl.signal);

    job.send({ type: 'progress', step: 'read' });
    const page = await readWithRetry(tabId, job.max, ctl.signal);
    await closeTab(tabId); // the pictures do not need the tab
    tabId = null;

    // Every item becomes a RawAd; Pilotix groups the copies itself.
    const ads = page.items.map(fromLibrary).filter(Boolean);
    if (ads.some((a) => a.mediaUrl)) {
      ctl.signal.throwIfAborted();
      clearTimeout(timer); // from here the pictures stop on their own before the deadline
      job.send({ type: 'progress', step: 'pictures' });
      await addPictures(ads, deadline - 2_000, () => job.cancelled);
    }
    if (job.cancelled) return;
    job.send({ type: 'result', count: page.count, ads });
  } catch (e) {
    job.send({ type: 'error', message: messageOf(e) });
  } finally {
    clearTimeout(timer);
    if (tabId !== null) await closeTab(tabId);
  }
}

const closeTab = (tabId) => chrome.tabs.remove(tabId).catch(() => {});

/** Resolves when the tab has loaded (or after LOAD_TIMEOUT: we then try to read it anyway). */
function waitForLoad(tabId, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(new SearchError(MSG.closed));
    };
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(), LOAD_TIMEOUT);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return finish(signal.reason);
    // It may have loaded before the listeners were added.
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete' && /^https:\/\/[^/]*facebook\.com\//.test(t.url ?? '')) finish();
      })
      .catch(() => finish(new SearchError(MSG.closed)));
  });
}

/**
 * Runs in the Facebook tab (self-contained): the page's own HTML as the server sent it, fetched again from the page
 * (same origin, the user's own session). Used once, when the page's scripts no longer hold the data.
 */
function pageHtml() {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 10_000);
  return fetch(location.href, { credentials: 'include', signal: ctl.signal })
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '');
}

/** Reads the ads in the tab, again every second while the page is not ready, for up to READ_TIMEOUT. */
async function readWithRetry(tabId, max, signal) {
  const started = Date.now();
  const until = started + READ_TIMEOUT;
  let fetched = false;
  for (;;) {
    signal.throwIfAborted();
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: readAdLibrary, args: [max, null] });
      if (r?.result?.found) return r.result;
      // Still nothing 3 s after the load: in case the page removed its data scripts, parse its HTML once.
      if (!fetched && Date.now() - started >= 3_000) {
        fetched = true;
        const [h] = await chrome.scripting.executeScript({ target: { tabId }, func: pageHtml });
        const fromHtml = typeof h?.result === 'string' && h.result ? readAdLibrary(max, h.result) : null;
        if (fromHtml?.found) return fromHtml;
      }
    } catch {
      // the page is navigating, or it is not a page we may read (login, checkpoint): try again
      const alive = await chrome.tabs.get(tabId).then(
        () => true,
        () => false,
      );
      if (!alive) throw new SearchError(MSG.closed);
    }
    if (Date.now() >= until) throw new SearchError(MSG.noLibrary);
    await sleep(1_000, signal);
  }
}

// ---------------------------------------------------------------- searches from the bridge and the popup
const isExtensionPage = (url) => typeof url === 'string' && url.startsWith(chrome.runtime.getURL(''));

/** The popup, or a content script on a Pilotix address the user added. */
async function senderAllowed(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  if (isExtensionPage(sender.url)) return true;
  try {
    return (await storedSites()).includes(new URL(sender.url).origin);
  } catch {
    return false;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pilotix-search') return;
  const allowed = senderAllowed(port.sender);
  let job = null;
  let open = true;
  const send = (m) => {
    if (!open) return;
    try {
      port.postMessage(m);
    } catch {
      open = false;
    }
  };
  port.onMessage.addListener(async (msg) => {
    if (job || msg?.type !== 'search') return; // one search per port
    job = { cancelled: false, abort: null, send };
    if (!(await allowed)) return send({ type: 'error', message: MSG.refused });
    try {
      Object.assign(job, checkSearch(msg));
    } catch (e) {
      return send({ type: 'error', message: e.message });
    }
    enqueue(job);
  });
  port.onDisconnect.addListener(() => {
    open = false;
    if (job) {
      job.cancelled = true;
      job.abort?.(new SearchError(MSG.cancelled));
    }
  });
});

// ---------------------------------------------------------------- Pilotix addresses (content script registrations)
async function storedSites() {
  const v = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY];
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
}
const saveSites = (list) => chrome.storage.local.set({ [SITES_KEY]: [...new Set(list)].sort() });

const scriptFor = (origin) => ({
  id: scriptId(origin),
  matches: [originPattern(origin)],
  js: ['bridge.js'],
  runAt: 'document_start',
  allFrames: false,
  persistAcrossSessions: true,
});

// Site changes run one after the other (the popup and permissions.onAdded may both add the same address).
let siteLock = Promise.resolve();
const locked = (fn) => {
  const run = siteLock.then(fn);
  siteLock = run.catch(() => {});
  return run;
};

/** Makes the registered content scripts match the stored list (forgetting addresses whose access was removed). */
async function syncRegistrations() {
  const stored = await storedSites();
  const sites = [];
  for (const o of stored) if (await chrome.permissions.contains({ origins: [originPattern(o)] })) sites.push(o);
  if (sites.length !== stored.length) await saveSites(sites);
  const want = new Map(sites.map((o) => [scriptId(o), o]));
  const have = (await chrome.scripting.getRegisteredContentScripts()).filter((s) => s.id.startsWith('pilotix-'));
  const stale = have.filter((s) => !want.has(s.id) || s.matches?.[0] !== originPattern(want.get(s.id)) || s.persistAcrossSessions === false);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale.map((s) => s.id) });
  const kept = new Set(have.filter((s) => !stale.includes(s)).map((s) => s.id));
  const missing = sites.filter((o) => !kept.has(scriptId(o))).map(scriptFor);
  if (missing.length) await chrome.scripting.registerContentScripts(missing);
  return sites;
}

/** Puts the bridge in the Pilotix tabs already open (bridge.js ignores a second copy). */
async function injectIntoOpenTabs(origin) {
  try {
    for (const t of await chrome.tabs.query({ url: originPattern(origin) }))
      if (t.id !== undefined) await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['bridge.js'] }).catch(() => {});
  } catch {
    // the tab is reloaded later anyway
  }
}

const addSite = (input) =>
  locked(async () => {
    const origin = pilotixOrigin(input);
    if (!(await chrome.permissions.contains({ origins: [originPattern(origin)] })))
      throw new Error('Chrome n’a pas donné l’accès à cette adresse. Cliquez sur Ajouter et acceptez la demande de Chrome.');
    const sites = await storedSites();
    if (!sites.includes(origin)) await saveSites([...sites, origin]);
    const list = await syncRegistrations();
    await injectIntoOpenTabs(origin);
    return list;
  });

const forgetSite = (origin) =>
  locked(async () => {
    await saveSites((await storedSites()).filter((o) => o !== origin));
    return syncRegistrations();
  });

async function removeSite(input) {
  const origin = pilotixOrigin(input);
  const list = await forgetSite(origin);
  await chrome.permissions.remove({ origins: [originPattern(origin)] }).catch(() => {});
  return list;
}

/** "https://app.maboutique.dz/*" → "https://app.maboutique.dz" (null for wide patterns and Facebook's own). */
function originOfPattern(p) {
  const m = /^(https?:\/\/[^/*]+)\/\*$/.exec(p);
  if (!m) return null;
  try {
    return pilotixOrigin(m[1]);
  } catch {
    return null;
  }
}

// Access granted to an address (from the popup's Ajouter, even when Chrome closed the popup during its question).
chrome.permissions.onAdded.addListener(({ origins = [] }) => {
  for (const o of origins.map(originOfPattern).filter(Boolean)) addSite(o).catch(() => {});
});
// Access removed (popup's Retirer, or the user in chrome://extensions): the address is forgotten.
chrome.permissions.onRemoved.addListener(({ origins = [] }) => {
  for (const o of origins.map(originOfPattern).filter(Boolean)) forgetSite(o).catch(() => {});
});

// Messages from the popup only (a Pilotix page cannot add or remove addresses).
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !isExtensionPage(sender.url)) return false;
  const actions = {
    sites: () => locked(syncRegistrations),
    add: () => addSite(msg.origin),
    remove: () => removeSite(msg.origin),
  };
  const act = actions[msg?.type];
  if (!act) return false;
  act().then(
    (sites) => reply({ ok: true, sites, busy: pending }),
    (e) => reply({ ok: false, message: String(e?.message ?? e) }),
  );
  return true; // the reply comes later
});

// Each time the service worker starts (browser start, install, update, wake-up): registrations = stored list.
locked(syncRegistrations).catch(() => {});
// After an update or a reload, the open Pilotix pages get a fresh bridge (the old one is cut off from the worker).
chrome.runtime.onInstalled.addListener(() =>
  locked(syncRegistrations)
    .then((sites) => Promise.all(sites.map(injectIntoOpenTabs)))
    .catch(() => {}),
);
chrome.runtime.onStartup.addListener(() => locked(syncRegistrations).catch(() => {}));
