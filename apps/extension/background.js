// Pilotix extension — the service worker.
//  - AI Spy searches: the bridge on a Pilotix page (bridge.js) or the popup opens a port named 'pilotix-search' and sends
//    { type: 'search', query, country, max }. Searches run one at a time: Facebook's public Ad Library opens in a
//    background tab, the ads are read from the page, the tab is closed, small pictures are made, and the port gets
//    { type: 'progress', step } messages ('open' | 'read' | 'pictures'), then { type: 'result', count, ads } or
//    { type: 'error', message }.
//  - Pilotix addresses: pilotix.online and direct.pilotix.online always (the manifest's content script); the popup adds
//    and removes others (a shop's own Pilotix server), each one gets bridge.js registered as a content script.
//  - Asking Pilotix: a price the popup read on the user's open page, or an action another site's script needs (the
//    customer card on WhatsApp Web, buttons on Facebook's ad library, numbers in Ads Manager), is handed to the open
//    Pilotix tabs (bridge.js); the first Pilotix page that can do it answers.
//  - Facebook's ad library (library.js): an ad tagged or its page followed there is read from the page's data here
//    ('library-save') and kept in AI Spy by the open Pilotix tab.
//  - Meta's Ads Manager (adsmanager.js, adspanel.html): Pilotix's numbers of each ad, asked like any other action.
//  - Envoyer photos on WhatsApp Web: wa.js. The customer card on WhatsApp Web: wa-card.js puts card.html beside the
//    chat; its quick replies come back here ('wa-insert') to go into that chat's message box.
import { checkSearch, fbVideoUrl, fromLibrary, libraryUrl, readAdLibrary } from './parse.js';
import { addPictures } from './pictures.js';
import { BUILT_IN, SITES_KEY, originPattern, pilotixOrigin, scriptId } from './sites.js';
import { PILOTIX_ACTIONS } from './actions.js';
import './wa.js';

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
    const origin = new URL(sender.url).origin;
    return BUILT_IN.includes(origin) || (await storedSites()).includes(origin);
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
    if (BUILT_IN.includes(origin)) return syncRegistrations(); // always there (the manifest)
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

// ---------------------------------------------------------------- asking the open Pilotix page
/** The Pilotix tabs open in this Chrome (built-in addresses and the ones the user added). */
async function pilotixTabs() {
  const sites = [...BUILT_IN, ...(await storedSites())];
  return (await chrome.tabs.query({ url: sites.map(originPattern) })).filter((t) => t.id !== undefined);
}

/**
 * Hands { type: 'site-price' | 'rpc', … } to the Pilotix tabs open here; the first page that does it answers. No Pilotix
 * tab, or none able to answer (logged out, an old page): a message saying what to do.
 */
async function askPilotix(msg) {
  const tabs = await pilotixTabs();
  let refused = '';
  for (const t of tabs) {
    const r = await chrome.tabs.sendMessage(t.id, msg).catch(() => null);
    if (r?.ok) return r;
    if (r?.message) refused = r.message;
  }
  if (refused) throw new Error(refused);
  throw new Error(tabs.length ? 'Pilotix n’a pas répondu : rechargez l’onglet Pilotix, puis réessayez.' : 'Ouvrez Pilotix dans ce Chrome (et connectez-vous), puis réessayez.');
}

/** A price the popup read on the user's open page (and what the page says, for « Lire la page »). */
async function sendSitePrice(msg) {
  const price = msg?.price === null || msg?.price === undefined ? null : Math.round(Number(msg.price));
  if (price !== null && (!Number.isFinite(price) || price < 100)) throw new Error('Prix illisible.');
  const oldPrice = msg?.oldPrice === null || msg?.oldPrice === undefined ? null : Math.round(Number(msg.oldPrice));
  const page = msg?.page && typeof msg.page === 'object' ? { text: String(msg.page.text ?? '').slice(0, 8000) } : null;
  if (price === null && !page) throw new Error('Aucun prix en DA sur cette page.');
  const r = await askPilotix({
    type: 'site-price',
    url: String(msg?.url ?? '').slice(0, 2000),
    price,
    oldPrice: Number.isFinite(oldPrice) ? oldPrice : null,
    title: msg?.title ? String(msg.title).slice(0, 200) : null,
    page,
  });
  return { saved: Number(r.saved) || 0, read: r.read ?? null };
}

/** The site a message comes from: the tab's page (a content script there, or an extension frame inside it). */
function siteOf(sender) {
  try {
    return new URL(sender.tab?.url || '').hostname;
  } catch {
    return '';
  }
}

// Pilotix actions asked by the extension's pieces on other sites (WhatsApp Web, Facebook's ad library, Ads Manager):
// only the actions listed in actions.js, only from the sites listed with them
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.kind !== 'pilotix') return false;
  const action = Object.hasOwn(PILOTIX_ACTIONS, msg.name) ? PILOTIX_ACTIONS[msg.name] : null;
  const host = siteOf(sender);
  if (!action || !host || !action.from.includes(host)) {
    reply({ ok: false, message: 'Action refusée.' });
    return false;
  }
  askPilotix({ type: 'rpc', name: msg.name, input: msg.input ?? {} }).then(
    (r) => reply({ ok: true, out: r.out ?? null }),
    (e) => reply({ ok: false, message: String(e?.message ?? e) }),
  );
  return true; // the reply comes later
});

// ---------------------------------------------------------------- Facebook's ad library: an ad kept in AI Spy from there
/** The ad as the library's own data has it (the page's data, else the page read again), else what its card shows. */
async function libraryAd(tabId, adId, dom) {
  const find = (page) => page?.items?.find((x) => String(x?.ad_archive_id ?? x?.adArchiveID ?? '') === adId) ?? null;
  let item = null;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: readAdLibrary, args: [500, null] });
    item = find(r?.result);
    if (!item) {
      const [h] = await chrome.scripting.executeScript({ target: { tabId }, func: pageHtml });
      if (typeof h?.result === 'string' && h.result) item = find(readAdLibrary(500, h.result));
    }
  } catch {
    item = null;
  }
  let ad = item ? fromLibrary(item) : null;
  if (!ad) {
    const d = dom && typeof dom === 'object' ? dom : {};
    const text = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
    ad = {
      id: adId,
      pageName: text(d.pageName, 200) ?? 'Page Facebook',
      pageUrl: text(d.pageUrl, 500),
      body: text(d.body, 6000),
      linkUrl: text(d.linkUrl, 3000),
      mediaUrl: text(d.mediaUrl, 4000),
      isVideo: !!d.isVideo,
      videoUrl: fbVideoUrl(d.videoUrl),
      active: true,
    };
  }
  if (ad.mediaUrl && !ad.media) await addPictures([ad], Date.now() + 15_000, () => false).catch(() => {});
  return ad;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.kind !== 'library-save') return false;
  let path = '';
  try {
    path = new URL(sender.tab?.url || '').pathname;
  } catch {
    path = '';
  }
  const host = siteOf(sender);
  const adId = String(msg.adId ?? '');
  if (!['www.facebook.com', 'web.facebook.com'].includes(host) || !path.startsWith('/ads/library') || !/^\d{8,20}$/.test(adId) || sender.tab?.id === undefined) {
    reply({ ok: false, message: 'Action refusée.' });
    return false;
  }
  libraryAd(sender.tab.id, adId, msg.dom)
    .then((ad) =>
      askPilotix({
        type: 'rpc',
        name: 'spy.libraryAd',
        input: { productId: Number(msg.productId), ad, tag: typeof msg.tag === 'string' ? msg.tag : null, ...(typeof msg.follow === 'boolean' ? { follow: msg.follow } : {}) },
      }),
    )
    .then(
      (r) => reply({ ok: true, out: r.out ?? null }),
      (e) => reply({ ok: false, message: String(e?.message ?? e) }),
    );
  return true;
});

// A quick reply clicked in the customer card (card.html, the extension's own page in a frame on WhatsApp Web): into the
// chat's message box of that tab (wa-card.js); the agent sends it
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.kind !== 'wa-insert' || typeof msg.text !== 'string') return false;
  if (!isExtensionPage(sender.url) || siteOf(sender) !== 'web.whatsapp.com' || sender.tab?.id === undefined) {
    reply({ ok: false });
    return false;
  }
  chrome.tabs.sendMessage(sender.tab.id, { action: 'insert', text: msg.text.slice(0, 4000) }, { frameId: 0 }).then(
    (r) => reply({ ok: !!r?.ok }),
    () => reply({ ok: false }),
  );
  return true;
});

// Messages from the popup only (a Pilotix page cannot add or remove addresses).
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !isExtensionPage(sender.url)) return false;
  const actions = {
    sites: () => locked(syncRegistrations),
    add: () => addSite(msg.origin),
    remove: () => removeSite(msg.origin),
    sitePrice: () => sendSitePrice(msg),
    status: async () => ({ open: (await pilotixTabs()).length }),
  };
  const act = actions[msg?.type];
  if (!act) return false;
  act().then(
    (out) => reply({ ok: true, ...(Array.isArray(out) ? { sites: out } : out), busy: pending }),
    (e) => reply({ ok: false, message: String(e?.message ?? e) }),
  );
  return true; // the reply comes later
});

// Each time the service worker starts (browser start, install, update, wake-up): registrations = stored list.
locked(syncRegistrations).catch(() => {});
// After an update or a reload, the open Pilotix pages get a fresh bridge (the old one is cut off from the worker), and
// the open pages of the other sites their fresh scripts.
chrome.runtime.onInstalled.addListener(({ reason }) =>
  locked(syncRegistrations)
    .then((sites) => (reason === 'install' || reason === 'update' ? Promise.all([...BUILT_IN, ...sites].map(injectIntoOpenTabs)).then(refreshOtherSites) : null))
    .catch(() => {}),
);

/** The manifest's scripts for other sites, put again in their open tabs (each script ignores a second live copy). */
async function refreshOtherSites() {
  for (const cs of chrome.runtime.getManifest().content_scripts ?? []) {
    if (cs.js?.includes('bridge.js')) continue;
    const tabs = await chrome.tabs.query({ url: cs.matches }).catch(() => []);
    for (const t of tabs)
      if (t.id !== undefined) await chrome.scripting.executeScript({ target: { tabId: t.id }, files: cs.js }).catch(() => {});
  }
}
chrome.runtime.onStartup.addListener(() => locked(syncRegistrations).catch(() => {}));
