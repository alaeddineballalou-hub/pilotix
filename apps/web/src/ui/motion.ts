// Motion for the whole app, in one place (styles/motion.css holds the keyframes). Nothing here changes how a page
// looks at rest: it only says how things arrive.
//   · a page change: the old page melts into the new one, and the menu's orange mark slides to its new line
//   · lists (rows, cards, columns): the first ones come in one after the other, when a page opens or its data lands
//   · the big numbers of a number box count up to their value
// Charts grow by CSS alone (motion.css). « Reduce motion » on the device: no slide, no count, a plain short fade.
import { currentRoute, setRouteMotion } from '../lib/route';

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const NAV_NAME = 'px-nav-on';
/** what never gets a list entrance: drawings, menus and pickers, table heads and cells, the bars of buttons */
const STILL = 'svg, select, thead, tr, nav, [role="listbox"], [role="menu"], .pxs-pick, .px-grp-bar, .modal-foot, .pager, [data-px-still]';
const ITEM_TAGS = new Set(['TR', 'DIV', 'LI', 'ARTICLE', 'SECTION', 'A']);
/** the big numbers that count up (ui/kit Kpi, the ads boxes, the dashboard's, the quality lead, the goal gauge) */
const COUNT = '.kpi .v, .kpi .val, .ov-big, .pp-q-lead b, .ov-gv, [data-count]';
const MAX_ITEMS = 12;

let last = '';
let bootUntil = 0;
/** until when a new list may come in with an entrance (a page just opened) */
let openUntil = 0;
const seen = new WeakSet<Element>();
const counted = new WeakSet<Element>();

/** The menu line that carries the orange mark, when it is in view on a wide screen. */
function activeNav(): HTMLElement | null {
  if (innerWidth < 900) return null;
  const side = document.getElementById('side');
  if (!side) return null;
  const el =
    side.querySelector<HTMLElement>('.nav-item.on') ??
    side.querySelector<HTMLElement>('.nav-item[aria-current="page"]:not(.nav-group-head)') ??
    (side.closest('.px-folded') ? side.querySelector<HTMLElement>('.nav-group.bjcn-on > .nav-group-head') : null);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const s = side.getBoundingClientRect();
  return r.height > 0 && r.top >= s.top && r.bottom <= s.bottom ? el : null;
}

/** A page change: the address already moved, « apply » tells React. Wrapped in a view transition when the browser has one. */
function routeMotion(apply: () => void) {
  const now = currentRoute().slice(0, 2).join('/');
  const moved = now !== last;
  last = now;
  const page = document.getElementById('page');
  const start = (document as unknown as { startViewTransition?: (cb: () => Promise<void>) => { ready: Promise<void>; finished: Promise<void> } }).startViewTransition;
  if (!moved || !page) return apply();
  openUntil = performance.now() + 1600;
  if (reduce() || document.hidden || !start || performance.now() < bootUntil) {
    apply();
    // no view transition here: the new page fades in by itself
    page.removeAttribute('data-px-page');
    void page.offsetWidth;
    page.setAttribute('data-px-page', '');
    return;
  }
  const from = activeNav();
  from?.style.setProperty('view-transition-name', NAV_NAME);
  let to: HTMLElement | null = null;
  const vt = start.call(
    document,
    () =>
      new Promise<void>((done) => {
        let ended = false;
        let wait = 0;
        const finish = () => {
          if (ended) return;
          ended = true;
          mo.disconnect();
          clearTimeout(wait);
          clearTimeout(cap);
          from?.style.removeProperty('view-transition-name');
          to = from ? activeNav() : null;
          to?.style.setProperty('view-transition-name', NAV_NAME);
          done();
        };
        // the new page is on screen a moment after React is told (a transition): wait for it, never for long
        const mo = new MutationObserver(() => {
          clearTimeout(wait);
          wait = window.setTimeout(finish, 24);
        });
        const side = document.getElementById('side');
        mo.observe(page, { childList: true, subtree: true });
        if (side) mo.observe(side, { attributes: true, attributeFilter: ['aria-current', 'class'], subtree: true });
        const cap = window.setTimeout(finish, 260);
        apply();
      }),
  );
  const clean = () => {
    from?.style.removeProperty('view-transition-name');
    to?.style.removeProperty('view-transition-name');
  };
  vt.ready.catch(() => {});
  vt.finished.then(clean, clean);
}

/** "1 555 850", "12,5", "42.5", "1,204": the number in a text, with what it takes to write it the same way again. */
function readNumber(raw: string): { value: number; write: (v: number) => string } | null {
  const dm = raw.match(/^(.*\d)([.,])(\d{1,2})$/);
  const whole = dm ? dm[1] : raw;
  const dec = dm ? dm[3].length : 0;
  const sep = whole.match(/\D/)?.[0] ?? '';
  const digits = whole.replace(/\D/g, '');
  if (!digits || digits.length > 12) return null;
  const value = Number(digits) + (dm ? Number(dm[3]) / 10 ** dec : 0);
  const write = (v: number) => {
    const f = v.toFixed(dec);
    const [i, d] = f.split('.');
    const grouped = sep ? i.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : i;
    return d ? `${grouped}${dm![2]}${d}` : grouped;
  };
  // only a number we can write back exactly as it was (a phone number, a date or an odd grouping stays still)
  return write(value) === raw ? { value, write } : null;
}

/** A big number counts up to its value, once, when it arrives. React still owns the text: any change of it stops us. */
function countUp(el: Element) {
  if (counted.has(el)) return;
  counted.add(el);
  let node: Text | null = null;
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 3 && /\d/.test(c.nodeValue ?? '')) {
      node = c as Text;
      break;
    }
  }
  if (!node) return;
  const text = node;
  const full = text.nodeValue ?? '';
  const m = full.match(/\d[\d\s  .,]*\d|\d/);
  if (!m || m.index === undefined) return;
  const pre = full.slice(0, m.index);
  const post = full.slice(m.index + m[0].length);
  if (/\d/.test(pre + post)) return;
  const num = readNumber(m[0]);
  if (!num || num.value < 20) return;
  const from = num.value * 0.6;
  const t0 = performance.now();
  const D = 700;
  let wrote = full;
  const step = (t: number) => {
    if (!text.isConnected || text.nodeValue !== wrote) return;
    const k = Math.min(1, (t - t0) / D);
    const e = 1 - (1 - k) ** 4;
    wrote = k >= 1 ? full : pre + num.write(from + (num.value - from) * e) + post;
    text.nodeValue = wrote;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The lists inside what just arrived: children of one kind, big enough to be rows, cards or columns. */
function listsIn(added: Element[], page: Element): Set<Element> {
  const lists = new Set<Element>();
  let budget = 3000;
  const walk = (el: Element, depth: number) => {
    if (budget-- <= 0 || depth > 16 || el.matches(STILL)) return;
    const kids = el.children;
    if (kids.length) lists.add(el);
    for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
  };
  for (const root of added) {
    if (!page.contains(root)) continue;
    const parent = root.parentElement;
    if (root.tagName === 'TR') {
      if (parent?.tagName === 'TBODY') lists.add(parent);
      continue;
    }
    if (root.closest(STILL)) continue;
    if (parent && page.contains(parent)) lists.add(parent);
    walk(root, 0);
  }
  return lists;
}

/** Gives the first items of each new list their place in the entrance (data-px-in + --px-i). Reads first, writes after. */
function stagger(added: Element[], page: Element) {
  const todo: { el: HTMLElement; i: number; kind: 'r' | 'f' }[] = [];
  for (const list of listsIn(added, page)) {
    const first = list.firstElementChild as HTMLElement | null;
    if (!first || !ITEM_TAGS.has(first.tagName)) continue;
    const rows = first.tagName === 'TR';
    if (rows ? list.tagName !== 'TBODY' : !first.classList.length) continue;
    const items: HTMLElement[] = [];
    for (let k = 0; k < list.children.length && items.length < MAX_ITEMS; k++) {
      const c = list.children[k] as HTMLElement;
      if (c.tagName === first.tagName && (rows || c.classList[0] === first.classList[0])) items.push(c);
    }
    const fresh = items.filter((c) => !seen.has(c));
    if (!fresh.length || (!rows && items.length < 3)) continue;
    let kind: 'r' | 'f' = rows ? 'f' : 'r';
    if (!rows) {
      const r = fresh[0].getBoundingClientRect();
      // a row, a card: not a button, and not a whole panel of the page (those arrive with the page itself)
      if (r.height < 44 || r.height > 260 || r.width < 140 || (first.tagName === 'A' && r.height < 56)) continue;
      const cs = getComputedStyle(fresh[0]);
      if (cs.animationName !== 'none' || cs.position === 'fixed' || cs.display === 'contents' || cs.display.startsWith('inline')) continue;
      // an item placed by a transform (a long list drawn in part) keeps its place: it only fades
      if (cs.transform !== 'none' || cs.position === 'absolute' || cs.position === 'sticky') kind = 'f';
    }
    fresh.forEach((el, i) => todo.push({ el, i, kind }));
  }
  for (const { el, i, kind } of todo) {
    seen.add(el);
    el.style.setProperty('--px-i', String(i));
    el.setAttribute('data-px-in', kind);
  }
}

function watch() {
  new MutationObserver((records) => {
    const page = document.getElementById('page');
    if (!page) return;
    const added: Element[] = [];
    let landed = false;
    for (const r of records) {
      if (r.type !== 'childList') continue;
      for (const n of Array.from(r.removedNodes)) {
        // « Chargement… » left: what replaces it is data landing, a moment for an entrance too
        if (n.nodeType === 1 && ((n as Element).classList.contains('loading') || ((n as Element).childElementCount < 6 && (n as Element).querySelector('.loading')))) landed = true;
      }
      for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1 && page.contains(n)) added.push(n as Element);
    }
    if (!added.length || document.hidden) return;
    const still = reduce();
    if (!still) {
      for (const el of added) {
        if (el.matches(COUNT)) countUp(el);
        el.querySelectorAll(COUNT).forEach(countUp);
      }
    }
    if (landed || performance.now() < openUntil) stagger(added, page);
  }).observe(document.body, { childList: true, subtree: true });

  // an entrance played: its mark leaves, so showing the item again later (a tab, a filter) never replays it
  const done = (e: AnimationEvent) => {
    const el = e.target as HTMLElement | null;
    if (!el?.hasAttribute?.('data-px-in') && !el?.hasAttribute?.('data-px-page')) return;
    if (!e.animationName.startsWith('px-')) return;
    el.removeAttribute('data-px-in');
    el.removeAttribute('data-px-page');
    el.style.removeProperty('--px-i');
  };
  document.addEventListener('animationend', done, true);
  document.addEventListener('animationcancel', done, true);
}

export function installMotion() {
  last = currentRoute().slice(0, 2).join('/');
  bootUntil = performance.now() + 1500;
  openUntil = performance.now() + 2500;
  setRouteMotion(routeMotion);
  watch();
}
