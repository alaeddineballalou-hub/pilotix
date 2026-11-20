// Every card with a title folds (owner's choice, 20 Nov 2026: design 4 « Résumé »). A click on its title line folds
// the card to that line, a second click opens it again. Work pages start open; the settings pages listed in
// START_SHUT start folded, and their cards show a short state on the title line (<span class="chip fold-sum">).
// Pilotix remembers, on this device, what each person folded on each page.
//
// Done once here for the whole app (like ui/motion): no page has to say anything. A card folds when its first child is
// its title: an <h2>, or a head (.card-head, .pd-tools…) whose own child is an <h2>, and it has something under it.
// Only data attributes are written (React leaves attributes it did not set alone): data-fold="open|shut" on the card,
// data-fold-head on its title line, data-fold-title on the <h2> (focusable: Enter or Space folds it too).
// styles/fold.css hides what is under the title line of a folded card and draws the small arrow.
import { currentRoute } from '../lib/route';

type State = 'open' | 'shut';

/** the pages whose cards start folded (the route's first words): settings, set once and checked at a glance */
const START_SHUT: readonly string[][] = [['landing', 'reglages']];
/** never folded: cards inside a window (modal, sheet) or that opt out with data-fold="none" */
const NEVER = '.modal, [role="dialog"], .sheet, [data-fold="none"]';
/** what keeps its own job inside a title line: a click there never folds the card */
const CONTROLS = 'button, a, input, select, textarea, label, summary, [role="switch"], [role="checkbox"], [contenteditable="true"]';
const STORE = 'pilotix.fold.v1';
/** at most this many remembered cards (the oldest are forgotten first) */
const MAX = 400;

let owner = '';
let saved: Record<string, State> = load();

/** Who is looking (boutique + person): each person's folded cards are their own. Set by the Shell. */
export function setFoldOwner(who: string) {
  owner = who;
}

function load(): Record<string, State> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function remember(key: string, state: State) {
  delete saved[key];
  saved[key] = state;
  const keys = Object.keys(saved);
  for (let i = 0; i < keys.length - MAX; i++) delete saved[keys[i]];
  try {
    localStorage.setItem(STORE, JSON.stringify(saved));
  } catch {
    /* private window or full storage: the card still folds, it is just not remembered */
  }
}

const route = () => currentRoute();
const startsShut = () => {
  const r = route();
  return START_SHUT.some((p) => p.every((w, i) => r[i] === w));
};

/** The card's title line: its first child when that is an <h2>, or a head holding an <h2> as its own child. */
function headOf(card: HTMLElement): HTMLElement | null {
  const first = card.firstElementChild as HTMLElement | null;
  if (!first) return null;
  if (first.tagName === 'H2') return first;
  if ((first.tagName === 'DIV' || first.tagName === 'HEADER') && first.querySelector(':scope > h2')) return first;
  return null;
}

const titleOf = (head: HTMLElement): HTMLElement => (head.tagName === 'H2' ? head : (head.querySelector(':scope > h2') as HTMLElement));

/** What names the card on its page: data-fold-key, else its title's words (without the state chip). */
function keyOf(card: HTMLElement, head: HTMLElement): string {
  let name = card.getAttribute('data-fold-key') ?? '';
  if (!name) {
    titleOf(head).childNodes.forEach((n) => {
      if (n instanceof Element && n.classList.contains('fold-sum')) return;
      name += n.textContent ?? '';
    });
  }
  return `${owner}|${route().join('/')}|${name.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}

function undo(card: HTMLElement) {
  card.removeAttribute('data-fold');
  card.querySelectorAll(':scope > [data-fold-head]').forEach((h) => h.removeAttribute('data-fold-head'));
  card.querySelectorAll('[data-fold-title]').forEach((h) => {
    if (h.closest('.card') !== card) return;
    h.removeAttribute('data-fold-title');
    h.removeAttribute('tabindex');
    h.removeAttribute('role');
    h.removeAttribute('aria-expanded');
  });
}

function setup(card: HTMLElement) {
  const head = headOf(card);
  if (!head || card.children.length < 2 || card.getAttribute('data-fold') === 'none' || card.closest(NEVER)) {
    if (card.hasAttribute('data-fold') && card.getAttribute('data-fold') !== 'none') undo(card);
    return;
  }
  // the title line may have been drawn again by React: mark the one that is there now
  if (!head.hasAttribute('data-fold-head')) {
    card.querySelectorAll(':scope > [data-fold-head]').forEach((h) => h.removeAttribute('data-fold-head'));
    head.setAttribute('data-fold-head', '');
  }
  const title = titleOf(head);
  if (!title.hasAttribute('data-fold-title')) {
    title.setAttribute('data-fold-title', '');
    title.setAttribute('tabindex', '0');
    title.setAttribute('role', 'button');
  }
  if (!card.hasAttribute('data-fold')) card.setAttribute('data-fold', saved[keyOf(card, head)] ?? (startsShut() ? 'shut' : 'open'));
  const open = card.getAttribute('data-fold') !== 'shut' ? 'true' : 'false';
  if (title.getAttribute('aria-expanded') !== open) title.setAttribute('aria-expanded', open);
}

function toggle(card: HTMLElement) {
  const head = headOf(card);
  if (!head) return;
  const next: State = card.getAttribute('data-fold') === 'shut' ? 'open' : 'shut';
  card.setAttribute('data-fold', next);
  titleOf(head).setAttribute('aria-expanded', next === 'open' ? 'true' : 'false');
  // what comes back under the title slides in (styles/fold.css; nothing with « reduce motion »)
  if (next === 'open') {
    card.setAttribute('data-fold-in', '');
    setTimeout(() => card.removeAttribute('data-fold-in'), 300);
  }
  remember(keyOf(card, head), next);
}

function cardOfHead(el: Element | null): HTMLElement | null {
  const head = el?.closest('[data-fold-head]');
  const card = head?.parentElement;
  return card && card.hasAttribute('data-fold') && card.getAttribute('data-fold') !== 'none' ? card : null;
}

export function installCardFold() {
  let queued = false;
  const run = () => {
    queued = false;
    document.querySelectorAll<HTMLElement>('.card').forEach(setup);
  };
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  };
  new MutationObserver(soon).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const card = cardOfHead(target);
    if (!card || target?.closest(CONTROLS)) return;
    toggle(card);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement | null;
    if (!target?.hasAttribute('data-fold-title')) return;
    const card = cardOfHead(target);
    if (!card) return;
    e.preventDefault();
    toggle(card);
  });
  soon();
}
