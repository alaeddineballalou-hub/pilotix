// Pilotix extension — Pilotix's numbers in Meta's Ads Manager. Next to each ad of the table: the confirmed orders it
// brought these last 7 days, the delivered ones, what one confirmed order cost, and where that cost stands against the
// product's bid limit (Pilotix's « Lancer une pub »). And a « Pilotix » button that opens the list of every ad with its
// numbers (adspanel.html, the extension's own page in a frame: Meta's page cannot read it).
// An ad is found in a row by its id (the « ID de la publicité » column) or by its name, as Pilotix knows it. The numbers
// come from the open Pilotix tab (customers' orders never leave Pilotix: only these counts are drawn here, in a closed
// shadow root). Nothing is clicked or changed in Ads Manager.
(() => {
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  if (globalThis.__pilotixAds?.alive?.()) return;
  globalThis.__pilotixAds?.remove?.();

  const DAYS = 7;
  const REFRESH = 5 * 60_000;
  const PANEL = chrome.runtime.getURL('adspanel.html');
  const ORIGIN = new URL(PANEL).origin;
  /** Pilotix's numbers: by ad id, and by name (only names that one ad has) */
  let byId = new Map();
  let byName = new Map();
  let loadedAt = 0;
  let loading = false;
  let error = '';
  const badges = new Map(); // row element → { host, key }

  const send = (msg) =>
    new Promise((ok) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => ok(chrome.runtime.lastError ? { ok: false, message: 'L’extension a été mise à jour : rechargez cette page.' } : r));
      } catch {
        ok({ ok: false, message: 'L’extension a été mise à jour : rechargez cette page.' });
      }
    });

  async function load() {
    if (loading) return;
    loading = true;
    const r = await send({ kind: 'pilotix', name: 'ads.extNumbers', input: { days: DAYS, all: true } });
    loading = false;
    loadedAt = Date.now();
    if (!r?.ok) {
      error = r?.message || 'Pilotix ne répond pas.';
      return;
    }
    error = '';
    byId = new Map(r.out.ads.map((a) => [a.id, a]));
    const count = new Map();
    for (const a of r.out.ads) count.set(norm(a.name), (count.get(norm(a.name)) ?? 0) + 1);
    byName = new Map(r.out.ads.filter((a) => count.get(norm(a.name)) === 1).map((a) => [norm(a.name), a]));
    scan();
  }
  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  // ---------------------------------------------------------------- the badge next to an ad's name
  const da = (n) => `${Math.round(n).toLocaleString('fr-FR').replace(/ | /g, ' ')} DA`;
  const LEVEL = { good: 'sous le bid limit', over: 'au-dessus du bid limit', alert: 'au-dessus de l’alert limit', stop: 'au-dessus du stop limit' };
  const CSS = `
:host { all: initial; display: inline-flex; vertical-align: middle; margin-inline-start: 8px; }
span.b { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border: 1px solid #dde2ec; border-radius: 999px; background: #f7f9fc;
  font: 600 11.5px/1 system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #1b2a47; white-space: nowrap; }
i { width: 7px; height: 7px; border-radius: 50%; background: #9aa6bd; }
.good { border-color: #1f9d57; } .good i { background: #1f9d57; }
.over { border-color: #f2b544; } .over i { background: #f2b544; }
.alert { border-color: #f28b1e; } .alert i { background: #f28b1e; }
.stop { border-color: #d6453d; background: #fce7e5; color: #b42318; } .stop i { background: #d6453d; }
b { font-weight: 800; }`;
  function text(a) {
    const parts = [`${a.confirmed} conf.`, `${a.delivered} livr.`];
    if (a.costConfirmed !== null) parts.push(`${da(a.costConfirmed)}/conf.`);
    return parts.join(' · ');
  }
  function title(a) {
    const t = [`Pilotix, ${DAYS} derniers jours : ${a.orders} commande(s), ${a.confirmed} confirmée(s), ${a.delivered} livrée(s)`];
    if (a.spendDzd !== null) t.push(`dépense ${da(a.spendDzd)}`);
    if (a.costConfirmed !== null) t.push(`${da(a.costConfirmed)} par commande confirmée`);
    if (a.bidLimit) t.push(`bid limit ${da(a.bidLimit)}${a.level ? ` : ${LEVEL[a.level]}` : ''}`);
    else t.push('bid limit pas encore réglé (Pilotix › Lancer une pub)');
    return t.join(' · ');
  }
  function badge(a) {
    const host = document.createElement('span');
    host.className = 'pilotix-ad-numbers';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><span class="b ${a.level ?? ''}"><i></i><b>P</b><span></span></span>`;
    root.querySelector('span.b').title = title(a);
    root.querySelector('span.b > span').textContent = text(a);
    return host;
  }

  // ---------------------------------------------------------------- the table's rows
  /** the element holding exactly this text (the ad's name in its row) */
  function holder(row, name) {
    let best = null;
    for (const el of row.querySelectorAll('a, span, div')) if (norm(el.textContent) === name && (!best || best.contains(el))) best = el;
    return best;
  }
  /** found by its id under another name (renamed at Meta): next to the name's link, else in the cell with most words */
  function nameSpot(row) {
    const link = [...row.querySelectorAll('a')].find((a) => (a.textContent || '').trim().length >= 2);
    if (link) return link;
    let best = null;
    let most = 0;
    for (const c of row.querySelectorAll('[role="gridcell"]')) {
      const n = (c.innerText || '').trim().length;
      if (n > most) {
        most = n;
        best = c;
      }
    }
    return best?.firstElementChild ?? null;
  }
  function scan() {
    if (!alive()) return stop();
    if (Date.now() - loadedAt > REFRESH) load();
    for (const [row, b] of badges) if (!row.isConnected || !b.host.isConnected) badges.delete(row);
    for (const row of document.querySelectorAll('[role="row"]')) {
      if (row.querySelector('[role="columnheader"]')) continue;
      const txt = row.innerText || '';
      let ad = null;
      for (const m of txt.matchAll(/\b(\d{12,20})\b/g)) if (byId.has(m[1])) ad = byId.get(m[1]);
      let place = null;
      if (!ad)
        for (const line of txt.split('\n')) {
          const a = byName.get(norm(line));
          if (a) {
            ad = a;
            place = holder(row, norm(line));
            break;
          }
        }
      const was = badges.get(row);
      if (!ad) {
        if (was) {
          was.host.remove();
          badges.delete(row);
        }
        continue;
      }
      const key = `${ad.id}:${text(ad)}:${ad.level}`;
      if (was && was.key === key && was.host.isConnected) continue;
      was?.host.remove();
      const host = badge(ad);
      place = place ?? holder(row, norm(ad.name)) ?? nameSpot(row);
      if (place) place.after(host);
      else row.querySelector('[role="gridcell"]')?.append(host);
      badges.set(row, { host, key });
    }
  }

  // ---------------------------------------------------------------- the « Pilotix » button and its list
  const frameHost = document.createElement('div');
  frameHost.id = 'pilotix-ads';
  const shadow = frameHost.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  frame.title = 'Pilotix';
  frame.src = PANEL;
  Object.assign(frame.style, { border: '0', width: '100%', height: '100%', display: 'block', background: 'transparent', colorScheme: 'normal' });
  shadow.append(frame);
  Object.assign(frameHost.style, { position: 'fixed', right: '10px', bottom: '10px', width: '150px', height: '52px', zIndex: '2147483000' });
  document.documentElement.append(frameHost);
  function onPanel(e) {
    if (e.source !== frame.contentWindow || e.origin !== ORIGIN || e.data?.pilotixAds !== 'size') return;
    frameHost.style.width = `${Math.max(60, Math.min(560, Number(e.data.w) || 150))}px`;
    frameHost.style.height = `${Math.max(40, Math.min(window.innerHeight - 40, Number(e.data.h) || 52))}px`;
  }
  window.addEventListener('message', onPanel);

  let timer = null;
  const later = () => {
    if (!timer)
      timer = setTimeout(() => {
        timer = null;
        scan();
      }, 800);
  };
  const obs = new MutationObserver(later);
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  const tick = setInterval(later, 30_000);
  function stop() {
    obs.disconnect();
    clearInterval(tick);
    window.removeEventListener('message', onPanel);
  }
  load();

  globalThis.__pilotixAds = {
    alive,
    remove: () => {
      stop();
      frameHost.remove();
      for (const b of badges.values()) b.host.remove();
    },
  };
})();
