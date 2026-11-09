// Every list to choose from (<select>) of the app opens our own list, in the Doux look, instead of the phone's or the
// computer's grey one: a round white card with big rows a finger can hit, the chosen row in peach with a check, and a
// search field when the list is long (the wilayas, the communes…). The <select> itself stays in the page as it is (its
// value, its label, the keyboard, what the screen reader says): picking a row sets it and sends « change », so every
// page keeps working unchanged. A <select data-native> keeps the system list.
import { RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Float } from './Float';
import { Icon } from './kit';

/** a list longer than this gets a search field */
const SEARCH_FROM = 12;

type Row = { i: number; label: string; disabled: boolean; group: string | null };

/** the <select> a click or a key lands on, when it is one we open */
function ours(t: EventTarget | null): HTMLSelectElement | null {
  const s = t instanceof Element ? t.closest('select') : null;
  if (!s || s.multiple || s.size > 1 || s.disabled || s.hasAttribute('data-native')) return null;
  return s;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

export function SelectPicker() {
  const [sel, setSel] = useState<HTMLSelectElement | null>(null);
  /** each opening is a new list (its search and its row start again) */
  const [n, setN] = useState(0);
  const anchor = useRef<HTMLElement | null>(null);
  const openRef = useRef<HTMLSelectElement | null>(null);
  openRef.current = sel;
  /** opened by a mouse (the search field takes the keyboard) or a finger (no keyboard pops up by itself) */
  const [mouse, setMouse] = useState(true);

  useEffect(() => {
    const open = (s: HTMLSelectElement, byMouse: boolean) => {
      anchor.current = s;
      setMouse(byMouse);
      setN((x) => x + 1);
      setSel(s);
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const s = ours(e.target);
      if (!s) return;
      // no system list: ours instead
      e.preventDefault();
      if (e.pointerType === 'mouse') s.focus({ preventScroll: true });
      if (openRef.current === s) setSel(null);
      else open(s, e.pointerType === 'mouse');
    };
    // the system list also opens on these (a touch's mouse events, a click): stopped on our selects
    const stop = (e: Event) => {
      if (ours(e.target)) e.preventDefault();
    };
    const key = (e: KeyboardEvent) => {
      if (openRef.current) return;
      const s = ours(e.target);
      if (!s) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
        e.preventDefault();
        open(s, true);
      }
    };
    // another page: the list closes
    const away = () => setSel(null);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('mousedown', stop, true);
    document.addEventListener('click', stop, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('hashchange', away);
    window.addEventListener('popstate', away);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('mousedown', stop, true);
      document.removeEventListener('click', stop, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('hashchange', away);
      window.removeEventListener('popstate', away);
    };
  }, []);

  // the select left the page (its window closed, the page changed): the list goes too
  useEffect(() => {
    if (!sel) return;
    const t = window.setInterval(() => {
      if (!sel.isConnected || sel.disabled) setSel(null);
    }, 400);
    return () => window.clearInterval(t);
  }, [sel]);

  if (!sel) return null;
  // closed only if it is still this select's list (a tap on another select has just opened that one's)
  return <List key={n} sel={sel} anchor={anchor} mouse={mouse} onClose={() => setSel((c) => (c === sel ? null : c))} />;
}

function List({ sel, anchor, mouse, onClose }: { sel: HTMLSelectElement; anchor: RefObject<HTMLElement>; mouse: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const rows = useMemo<Row[]>(
    () =>
      [...sel.options]
        .map((o, i) => ({ o, i }))
        .filter(({ o }) => !o.hidden)
        .map(({ o, i }) => ({ i, label: (o.label || o.text).trim(), disabled: o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled), group: o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : null })),
    [sel],
  );
  const cur = sel.selectedIndex;
  const [q, setQ] = useState('');
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  const shown = words.length ? rows.filter((r) => words.every((w) => norm(r.label).includes(w))) : rows;
  const pickable = shown.filter((r) => !r.disabled);
  const [k, setK] = useState(() => Math.max(0, pickable.findIndex((r) => r.i === cur)));
  const box = useRef<HTMLDivElement>(null);
  const search = rows.length > SEARCH_FROM;

  const pick = (r: Row) => {
    if (r.disabled) return;
    onClose();
    if (sel.selectedIndex !== r.i) {
      sel.selectedIndex = r.i;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (mouse) sel.focus({ preventScroll: true });
  };

  // the chosen row in view when the list opens
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('.pxs-it.cur')?.scrollIntoView({ block: 'center' });
  }, []);
  // the keyboard: arrows move, Enter picks, Escape / Tab close
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        if (e.key === 'Escape') e.preventDefault();
        onClose();
        if (mouse) sel.focus({ preventScroll: true });
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!pickable.length) return;
        const n = (k + (e.key === 'ArrowDown' ? 1 : -1) + pickable.length) % pickable.length;
        setK(n);
        box.current?.querySelector<HTMLElement>(`[data-k="${n}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' || (e.key === ' ' && !search)) {
        e.preventDefault();
        if (pickable[k]) pick(pickable[k]);
      }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  });

  const label = sel.getAttribute('aria-label') || (sel.labels?.[0]?.textContent ?? '').trim() || undefined;
  let lastGroup: string | null = null;
  return (
    <Float anchor={anchor} onClose={onClose} className="pxs-pick" minWidth={Math.max(220, sel.getBoundingClientRect().width)} maxHeight={search ? 440 : 400}>
      <div ref={box}>
        {search && (
          <div className="pxs-q">
            <Icon name="search" />
            <input
              type="search"
              value={q}
              autoFocus={mouse}
              placeholder={t('common.search')}
              aria-label={t('common.search')}
              onChange={(e) => {
                setQ(e.target.value);
                setK(0);
              }}
            />
          </div>
        )}
        <div role="listbox" aria-label={label}>
          {shown.length === 0 && <p className="pxf-none">{t('common.noResults')}</p>}
          {shown.map((r) => {
            const head = r.group !== lastGroup && r.group ? <div className="pxf-gh">{r.group}</div> : null;
            lastGroup = r.group;
            const n = pickable.indexOf(r);
            return (
              <div key={r.i}>
                {head}
                <button
                  type="button"
                  role="option"
                  aria-selected={r.i === cur}
                  disabled={r.disabled}
                  data-k={n}
                  className={`pxs-it${r.i === cur ? ' cur' : ''}${n === k && n >= 0 ? ' on' : ''}`}
                  onMouseEnter={() => n >= 0 && setK(n)}
                  onClick={() => pick(r)}
                >
                  <span>{r.label || '—'}</span>
                  {r.i === cur && <Icon name="check" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Float>
  );
}
