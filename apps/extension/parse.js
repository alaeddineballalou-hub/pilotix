// Pilotix Spy: reading Facebook's Ad Library page and turning its items into Pilotix "RawAd" objects.
// Pure functions, shared by the service worker (background.js) and the Node test (test/parse.test.mjs).

/** Facebook's public Ad Library search for one keyword (active ads, every ad type, one country). */
export const libraryUrl = (query, country = 'DZ') =>
  `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(query)}&search_type=keyword_unordered&media_type=all`;

/**
 * Checks a search sent by the Pilotix page or the popup: query 1–60 characters, country 2 letters (DZ by default),
 * max 1–60 ads (30 by default). Throws an Error with a French message when the search cannot run.
 */
export function checkSearch(input) {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  if (query.length < 1 || query.length > 60) throw new Error('Le mot-clé doit faire entre 1 et 60 caractères.');
  const rawCountry = input?.country === undefined || input?.country === null || input?.country === '' ? 'DZ' : input.country;
  if (typeof rawCountry !== 'string' || !/^[A-Za-z]{2}$/.test(rawCountry)) throw new Error('Le pays doit être un code de 2 lettres (ex. DZ).');
  const n = Number(input?.max);
  const max = Number.isFinite(n) ? Math.max(1, Math.min(60, Math.round(n))) : 30;
  return { query, country: rawCountry.toUpperCase(), max };
}

/**
 * Finds the ads in the Ad Library page: one inline <script> holds `"search_results_connection":{ count, edges:[
 * { node:{ collated_results:[ item… ] } } ] }`. Returns { found, count, items } (items = Facebook's raw items, at most
 * `max`). `found` is false while the page has no such data (still loading, login wall, checkpoint, captcha).
 *
 * With `text` (a string) it only parses that text: this is what the tests call. Without it (null), it reads the
 * scripts of the page it runs in: the service worker runs it in the Facebook tab with chrome.scripting.executeScript,
 * which sends only this function's source. So it must stay SELF-CONTAINED: no reference to anything outside it.
 */
export function readAdLibrary(max, text) {
  const KEY = '"search_results_connection":';
  const limit = Math.max(1, Math.min(60, Number(max) || 30));

  // The JSON object starting at `from` (after optional spaces), by brace matching: braces inside strings do not
  // count, and a backslash escapes the next character inside a string. Returns its text, or null.
  const objectAt = (t, from) => {
    let i = from;
    while (i < t.length && (t[i] === ' ' || t[i] === '\n' || t[i] === '\r' || t[i] === '\t')) i++;
    if (t[i] !== '{') return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return t.slice(i, j + 1);
      }
    }
    return null; // cut short (the script is still streaming in)
  };

  // The first occurrence of the key followed by a parsable connection object.
  const connectionIn = (t) => {
    for (let at = t.indexOf(KEY); at >= 0; at = t.indexOf(KEY, at + KEY.length)) {
      const json = objectAt(t, at + KEY.length);
      if (!json) continue;
      try {
        const conn = JSON.parse(json);
        if (conn && typeof conn === 'object' && (Array.isArray(conn.edges) || typeof conn.count === 'number')) return conn;
      } catch {
        // not this one: try the next occurrence
      }
    }
    return null;
  };

  let conn = null;
  if (typeof text === 'string') conn = connectionIn(text);
  else {
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent;
      if (t && t.includes(KEY)) {
        conn = connectionIn(t);
        if (conn) break;
      }
    }
  }
  if (!conn) return { found: false, count: null, items: [] };

  const items = [];
  for (const edge of Array.isArray(conn.edges) ? conn.edges : []) {
    const list = edge && edge.node && Array.isArray(edge.node.collated_results) ? edge.node.collated_results : [];
    for (const item of list) if (items.length < limit && item && typeof item === 'object') items.push(item);
  }
  const count = typeof conn.count === 'number' && Number.isFinite(conn.count) ? conn.count : items.length;
  return { found: true, count, items };
}

// ---------------------------------------------------------------- fromLibrary (port of packages/core/src/modules/spy.ts)
const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

/**
 * One item of Facebook's library data (ad_archive_id, collation_count, start_date, snapshot{ body, link_url, images,
 * videos, cards… }) → RawAd, or null when it has no valid ad id. Same field logic as fromLibrary in
 * packages/core/src/modules/spy.ts (keep both in step); a few extra .slice() calls keep every field within
 * RawAdSchema's maximum lengths.
 */
export function fromLibrary(r) {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.ad_archive_id ?? r.adArchiveID ?? r.adArchiveId ?? r.id);
  if (!/^\d{5,30}$/.test(id)) return null;
  const s = r.snapshot ?? {};
  const cards = Array.isArray(s.cards) ? s.cards : [];
  const c0 = cards[0] ?? {};
  const img = (Array.isArray(s.images) ? s.images[0] : null) ?? {};
  const vid = (Array.isArray(s.videos) ? s.videos[0] : null) ?? {};
  const body = typeof s.body === 'string' ? s.body : str(s.body?.text ?? s.body?.markup?.__html ?? c0.body);
  const start = r.start_date ?? r.startDate ?? r.start_date_string;
  const startedAt =
    typeof start === 'number' ? Math.round(start > 1e12 ? start / 1000 : start) : start ? Math.round(Date.parse(String(start)) / 1000) || null : null;
  const plat = r.publisher_platform ?? r.publisherPlatform ?? r.publisher_platforms;
  const media = str(
    img.resized_image_url ?? img.original_image_url ?? c0.resized_image_url ?? c0.original_image_url ?? vid.video_preview_image_url ?? c0.video_preview_image_url ?? '',
  );
  // Dynamic (DCO) ads show templates such as {{product.name}}: no real text there.
  const clean = (t) => (/\{\{[^}]+\}\}/.test(t) ? '' : t).slice(0, 6000);
  return {
    id,
    collationId: str(r.collation_id ?? r.collationID ?? '').slice(0, 40) || null,
    copies: Math.max(1, Math.min(1000, Math.round(num(r.collation_count ?? r.collationCount ?? 1)) || 1)),
    pageId: str(r.page_id ?? s.page_id ?? '').slice(0, 40) || null,
    pageName: str(s.page_name ?? r.page_name ?? r.pageName ?? '').slice(0, 200) || '—',
    pageUrl: str(s.page_profile_uri ?? '').slice(0, 500) || null,
    startedAt,
    active: r.is_active === undefined && r.isActive === undefined ? true : !!(r.is_active ?? r.isActive),
    platforms: Array.isArray(plat) ? plat.map((p) => str(p).toUpperCase().slice(0, 40)).slice(0, 12) : [],
    body: clean(body || str(c0.body)),
    title: clean(str(s.title ?? c0.title ?? '')).slice(0, 600) || null,
    linkUrl: str(s.link_url ?? c0.link_url ?? '').slice(0, 3000) || null,
    cta: str(s.cta_text ?? c0.cta_text ?? '').slice(0, 100) || null,
    isVideo: !!(vid.video_sd_url || vid.video_hd_url || c0.video_sd_url || c0.video_hd_url || /VIDEO/i.test(str(s.display_format))),
    mediaUrl: media.slice(0, 4000) || null,
    media: null,
  };
}
