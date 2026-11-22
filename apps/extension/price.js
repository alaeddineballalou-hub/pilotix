// Pilotix Spy: the price on the page the user has open (the popup's « Lire le prix de cette page »), for a competitor's
// site that Pilotix's server could not read (its « no robots » rule, a protection wall). The user opens the page
// themself; clicking the extension gives it that one tab for a moment (Chrome's activeTab), nothing else.
//  - pageData() runs IN the page (chrome.scripting.executeScript): what the page shows, after its own scripts ran.
//  - priceOf() reads the price here, like Pilotix's server reads a page (packages/core/src/spy-server.ts readSite).
// No network, nothing kept: the price goes to the open Pilotix page (background.js → bridge.js), which saves it.

/** What the open page shows. Runs inside the page: it uses nothing from this file. */
export function pageData() {
  const text = (document.body?.innerText || '').slice(0, 40000);
  const metas = [...document.querySelectorAll('meta[property="product:price:amount"],meta[property="og:price:amount"],meta[itemprop="price"]')]
    .map((m) => m.getAttribute('content') || '')
    .filter(Boolean)
    .slice(0, 5);
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => s.textContent || '')
    .join('\n')
    .slice(0, 60000);
  return { url: location.href, title: (document.title || '').slice(0, 200), text, metas, ld };
}

/** Prices in DA written in a text: « 12900 دج », « 9,800 DA », « DZD4,400 », « 3 500 دج بدل 4 500 دج » (core's pricesIn). */
export function pricesIn(text) {
  const t = String(text || '').replace(/[‎‏]/g, '');
  const vals = [];
  const val = (s) => Number(s.replace(/[\s.,  ]/g, ''));
  const after = /(\d{1,3}(?:[\s.,  ]\d{3})+|\d{3,6})(?:[.,]00)?\s*(?:دج|د\.ج|دينار|DZD|DA|Da|da)(?![a-zA-Z])/g;
  const before = /(?:DZD|دج)\s*(\d{1,3}(?:[\s.,  ]\d{3})+|\d{3,6})/g;
  for (const re of [after, before]) for (const m of t.matchAll(re)) vals.push(val(m[1]));
  const ok = [...new Set(vals.filter((v) => v >= 300 && v <= 400000))];
  if (!ok.length) return { price: null, old: null };
  if (ok.length >= 2 && /(بدل|بدلا|عوض|au lieu|barr|بدلاً|avant|ancien prix|prix normal)/i.test(t)) return { price: Math.min(...ok), old: Math.max(...ok) };
  return { price: ok[0], old: null };
}

/** The product's price (and its crossed price) from what the page shows; null when it shows none in DA. */
export function priceOf(d) {
  // the first price block of the page is the product's (« 11,900.00 دج 15,000.00 دج »)
  const head = String(d?.text || '').slice(0, 6000);
  const pr = pricesIn(head);
  const nums = [...head.matchAll(/(\d{1,3}(?:[\s.,  ]\d{3})+|\d{3,6})(?:[.,]00)?\s*(?:دج|د\.ج|DZD|DA)(?![a-zA-Z])/g)]
    .map((m) => Number(m[1].replace(/[\s.,  ]/g, '')))
    .filter((v) => v >= 300 && v <= 400000);
  let price = pr.price;
  let oldPrice = pr.old;
  if (!oldPrice && nums.length >= 2 && nums[0] !== nums[1]) {
    price = Math.min(nums[0], nums[1]);
    oldPrice = Math.max(nums[0], nums[1]);
  }
  // else the shop's own data: the price it gives search engines (JSON-LD offers, meta tags)
  if (!price) {
    const json = /"(?:price|lowPrice|sale_price|salePrice)"\s*:\s*"?(\d{3,6})(?:\.\d+)?"?/.exec(String(d?.ld || ''));
    const meta = (d?.metas || []).map((x) => Number(String(x).replace(/[^\d.]/g, ''))).find((v) => v >= 300 && v <= 400000);
    price = json ? Number(json[1]) : meta ? Math.round(meta) : null;
    oldPrice = null;
  }
  if (!price || price < 300 || price > 400000) return null;
  return { price, oldPrice: oldPrice && oldPrice > price ? oldPrice : null };
}

/** A page the popup may read: a site on the web, not Facebook (its ads are read elsewhere), not a Pilotix address. */
export function readablePage(url, pilotixOrigins = []) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (/(^|\.)(facebook\.com|fbcdn\.net|fb\.com|instagram\.com|chromewebstore\.google\.com)$/i.test(u.hostname)) return false;
  return !pilotixOrigins.includes(u.origin);
}
