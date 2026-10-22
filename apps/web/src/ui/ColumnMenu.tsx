import { DragEvent, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { store } from '../lib/store';
import { useTranslation } from 'react-i18next';
import { rpc } from '../lib/backend';
import { useRpc } from '../lib/query';
import { useSession } from '../lib/session';
import { useUiPrefs } from '../lib/ui';
import { Icon } from './kit';
import { toast } from './toast';

/**
 * Column picker with the shared, locked presets. The same presets show in Confirmation and Suivi:
 * a preset keeps the columns a table has and ignores the others.
 */
export function ColumnMenu<K extends string>({ cols, visible, onChange, onReset, open, onToggle, order, onOrder, presetId, onPreset, locked, widthsSet, onResetWidths }: {
  cols: { k: K; label: string }[];
  /** only an admin shows or hides columns: the others only reorder them */
  locked?: boolean;
  /** this user resized columns: offer to go back to the automatic widths */
  widthsSet?: boolean;
  onResetWidths?: () => void;
  /** the preset in use for this list (it stays until the user changes the columns) */
  presetId?: string | null;
  /** choosing a preset: saved with the account and used by every list */
  onPreset?: (id: string) => void;
  visible: Set<K>;
  onChange: (s: Set<K>) => void;
  onReset: () => void;
  open: boolean;
  onToggle: () => void;
  /** the columns in display order (drag them in the list to move them) */
  order?: K[];
  onOrder?: (o: K[]) => void;
}) {
  const { t } = useTranslation();
  const { session } = useSession();
  const presets = useRpc('confirmation.colPresets', {}, { staleTime: 60_000 });
  const qc = useQueryClient();
  const [pName, setPName] = useState('');
  const has = (k: string): k is K => cols.some((c) => c.k === k);
  const listed = (order ? order.map((k) => cols.find((c) => c.k === k)!).filter(Boolean) : cols).filter((c) => !locked || visible.has(c.k));
  const drag = order && onOrder ? colDrag(order, onOrder) : null;
  const add = async () => {
    const name = pName.trim();
    if (!name) return;
    try {
      await rpc('confirmation.addColPreset', { name, cols: listed.filter((c) => visible.has(c.k)).map((c) => c.k) });
      setPName('');
      toast(t('confirmation.presets.savedAll', { name }), 'ok');
      presets.refetch();
      qc.invalidateQueries({ queryKey: ['confirmation.colActive'] });
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  const del = async (id: string) => {
    try {
      await rpc('confirmation.deleteColPreset', { id });
      toast(t('confirmation.presets.deleted'), 'ok');
      presets.refetch();
      qc.invalidateQueries({ queryKey: ['confirmation.colActive'] });
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  return (
    <span className="px-qpop-wrap">
      <button type="button" className={`px-qb ${open ? 'on' : ''}`} aria-expanded={open} title={`${t('common.columns')} (${visible.size}/${cols.length})`} aria-label={t('common.columns')} onClick={onToggle}>
        <Icon name="columns" />
      </button>
      {open && (
        <div className="px-qpop" role="dialog" aria-label={t('common.columns')}>
          <div className="px-pre">
            <div className="px-pre-h">{t('confirmation.presets.title')}</div>
            {(presets.data ?? []).length === 0 && <div className="px-pre-none">{t('confirmation.presets.none')}</div>}
            {locked && <div className="px-pre-note">{t('confirmation.presets.lockedNote')}</div>}
            {(presets.data ?? []).map((p) => {
              const keep = p.cols.filter(has);
              const on = onPreset ? presetId === p.id : keep.length > 0 && keep.length === visible.size && keep.every((k) => visible.has(k));
              return (
                <div key={p.id} className={`px-pre-it ${on ? 'on' : ''}`}>
                  <button type="button" className="px-pre-go" title={locked ? t('confirmation.presets.byAdmin') : t('confirmation.presets.applyAll')} aria-label={t('confirmation.presets.apply', { name: p.name })} disabled={!keep.length || locked} onClick={() => (onPreset ? onPreset(p.id) : (onChange(new Set(keep)), order && onOrder?.([...keep, ...order.filter((k) => !keep.includes(k))])))}>
                    <Icon name="lock" />
                    <span>{p.name}</span>
                    <small>{keep.length}</small>
                  </button>
                  {session?.isAdmin && (
                    <button type="button" className="px-pre-del" title={t('confirmation.presets.del', { name: p.name })} aria-label={t('confirmation.presets.del', { name: p.name })} onClick={() => del(p.id)}>
                      <Icon name="trash" />
                    </button>
                  )}
                </div>
              );
            })}
            {session?.isAdmin && (
              <form
                className="px-pre-new"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <input value={pName} maxLength={40} placeholder={t('confirmation.presets.name')} aria-label={t('confirmation.presets.saveAs')} title={t('confirmation.presets.saveAs')} onChange={(e) => setPName(e.target.value)} />
                <button type="submit" className="btn small primary" disabled={!pName.trim() || !visible.size}>
                  {t('confirmation.presets.save')}
                </button>
              </form>
            )}
          </div>
          <div className="px-pre-h">{locked ? t('confirmation.presets.colsOrder') : t('confirmation.presets.cols')}</div>
          {listed.map((c) => (
            <label key={c.k} className={`px-qpop-it ${drag ? 'px-drag' : ''}`} {...(drag ? drag(c.k) : {})}>
              {drag && <Icon name="grip" className="px-grip" />}
              <span>{c.label}</span>
              {!locked && (
                <input
                  type="checkbox"
                  checked={visible.has(c.k)}
                  onChange={(e) => {
                    const s2 = new Set(visible);
                    if (e.target.checked) s2.add(c.k);
                    else s2.delete(c.k);
                    onChange(s2);
                  }}
                />
              )}
            </label>
          ))}
          <div className="px-qpop-acts">
            {!locked && (
              <button type="button" className="btn small ghost" onClick={onReset}>
                {t('common.showAll')}
              </button>
            )}
            {widthsSet && onResetWidths && (
              <button type="button" className="btn small ghost" onClick={onResetWidths}>
                {t('confirmation.presets.resetWidths')}
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

/** Puts columns added later in their place (before the column that follows them by default). */
function fixOrder<K extends string>(o: readonly K[] | null | undefined, all: readonly K[]): K[] {
  const out = (o ?? []).filter((k) => all.includes(k));
  all.forEach((k, i) => {
    if (out.includes(k)) return;
    const after = all.slice(i + 1).find((x) => out.includes(x));
    out.splice(after ? out.indexOf(after) : out.length, 0, k);
  });
  return out;
}

/**
 * The columns of one list.
 * - Which columns show: the preset an admin put in use for every team (or the default columns). Only an admin changes them.
 * - Their order and width: each user's own, saved with the account (they stay after a reload and on every device).
 * An admin's own column choice and the preset in use: the newest of the two wins on the admin's screen.
 */
export function useTableColumns<K extends string>(table: string, all: K[], opts: { defaults?: K[]; legacy?: () => { cols?: K[] | null; order?: K[] | null } | null } = {}) {
  const prefs = useUiPrefs();
  const qc = useQueryClient();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const presets = useRpc('confirmation.colPresets', {}, { staleTime: 60_000 });
  const activeQ = useRpc('confirmation.colActive', {}, { staleTime: 60_000 });
  const defaults = opts.defaults ?? all;
  // an admin's own choice of columns (and the order saved with it before order had its own key)
  const own = prefs.get<{ cols: K[]; order: K[]; at: number }>(`cols.t.${table}`);
  const savedOrder = prefs.get<K[]>(`cols.o.${table}`);
  // choices made before they were saved with the account (this browser only)
  const legacy = useMemo(() => (own || savedOrder ? null : opts.legacy?.() ?? null), [table, !!own, !!savedOrder]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = activeQ.data ?? null;
  const preset = active ? presets.data?.find((p) => p.id === active.id) : undefined;
  const keep = preset ? (preset.cols.filter((k) => all.includes(k as K)) as K[]) : [];
  const adminOwn = admin ? own ?? (legacy?.cols ? { cols: legacy.cols, order: legacy.order ?? all, at: 0 } : null) : null;
  const usePreset = keep.length > 0 && (!adminOwn || active!.at >= adminOwn.at);
  const visible = new Set<K>(usePreset ? keep : adminOwn ? adminOwn.cols.filter((k) => all.includes(k)) : defaults);
  const mine = savedOrder ?? own?.order ?? legacy?.order ?? null;
  const order = mine ? fixOrder(mine, all) : usePreset ? [...keep, ...all.filter((k) => !keep.includes(k))] : [...all];
  const widths: Record<string, number> = prefs.get<Record<string, number>>(`cols.w.${table}`) ?? {};
  return {
    visible,
    order,
    /** only an admin shows or hides columns */
    locked: !admin,
    presetId: keep.length ? preset!.id : null,
    setVisible: (s: Set<K>) => admin && prefs.set(`cols.t.${table}`, { cols: order.filter((k) => s.has(k)), order, at: Date.now() }),
    setOrder: (o: K[]) => prefs.set(`cols.o.${table}`, o),
    /** "Tout afficher" (admin) */
    reset: () => admin && prefs.set(`cols.t.${table}`, { cols: [...all], order, at: Date.now() }),
    /** an admin puts a preset in use for every team */
    applyPreset: async (id: string) => {
      if (!admin) return;
      try {
        await rpc('confirmation.setColActive', { id });
        await qc.invalidateQueries({ queryKey: ['confirmation.colActive'] });
      } catch (e: any) {
        toast(e.message, 'bad');
      }
    },
    /** this user's column widths in pixels (empty: automatic widths) */
    widths,
    setWidths: (m: Record<string, number> | null) => prefs.set(`cols.w.${table}`, m && Object.keys(m).length ? m : null),
    resetWidths: () => prefs.set(`cols.w.${table}`, null),
  };
}

/** Column order kept per list (new columns go at the end). */
export function useColumnOrder<K extends string>(key: string, all: K[]): [K[], (o: K[]) => void] {
  const fix = (o: K[] | null) => {
    const out = (o ?? []).filter((k) => all.includes(k));
    // a column added later goes before the column that follows it by default
    all.forEach((k, i) => {
      if (out.includes(k)) return;
      const after = all.slice(i + 1).find((x) => out.includes(x));
      out.splice(after ? out.indexOf(after) : out.length, 0, k);
    });
    return out;
  };
  const [order, setOrder] = useState<K[]>(() => fix(store.json<K[] | null>(key, null)));
  const fixed = fix(order);
  return [
    fixed,
    (o: K[]) => {
      setOrder(o);
      store.set(key, JSON.stringify(o));
    },
  ];
}

let dragging: string | null = null;
/** Drag-and-drop props that move a column before the one it is dropped on (headers and the column list). */
export function colDrag<K extends string>(order: K[], onOrder: (o: K[]) => void) {
  return (k: K) => ({
    draggable: true,
    'data-col': k,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      dragging = k;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', k);
      e.currentTarget.classList.add('px-dragging');
    },
    onDragEnd: (e: DragEvent<HTMLElement>) => {
      dragging = null;
      e.currentTarget.classList.remove('px-dragging');
      document.querySelectorAll('.px-drop').forEach((x) => x.classList.remove('px-drop'));
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!dragging || dragging === k) return;
      e.preventDefault();
      e.currentTarget.classList.add('px-drop');
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => e.currentTarget.classList.remove('px-drop'),
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.currentTarget.classList.remove('px-drop');
      const from = (dragging ?? e.dataTransfer.getData('text/plain')) as K;
      dragging = null;
      if (!from || from === k || !order.includes(from)) return;
      const o = order.filter((x) => x !== from);
      const at = o.indexOf(k);
      o.splice(at < 0 ? o.length : order.indexOf(from) < order.indexOf(k) ? at + 1 : at, 0, from);
      onOrder(o);
    },
  });
}

export type Density = 's' | 'm' | 'l';
export function useDensity(): [Density, (d: Density) => void] {
  const [d, setD] = useState<Density>(() => (['s', 'm', 'l'].includes(store.get('px-density') ?? '') ? (store.get('px-density') as Density) : 'm'));
  return [d, (x: Density) => (setD(x), store.set('px-density', x))];
}

/** Three small buttons: compact, normal and large rows. */
export function DensitySwitch({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  const { t } = useTranslation();
  const bars = (gap: number) => (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <rect key={i} x="2" y={8 - gap + i * gap - 1} width="12" height="2" rx="1" fill="currentColor" />
      ))}
    </svg>
  );
  return (
    <div className="px-dens" role="radiogroup" aria-label={t('common.density')}>
      {(
        [
          ['s', 3, t('common.dens.s')],
          ['m', 4.5, t('common.dens.m')],
          ['l', 6, t('common.dens.l')],
        ] as const
      ).map(([k, g, l]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? 'on' : ''} title={l} aria-label={l} onClick={() => onChange(k)}>
          {bars(g)}
        </button>
      ))}
    </div>
  );
}

/**
 * The handle on a header's edge: drag it to set the column's width (saved for this user);
 * a double click puts the automatic width back.
 */
export function ColResize({ label, side = 'end', onStart, onLive, onDone, onAuto }: { label: string; side?: 'start' | 'end'; onStart: (th: HTMLElement) => void; onLive: (w: number) => void; onDone: (w: number) => void; onAuto: (th: HTMLElement) => void }) {
  return (
    <span
      className={`px-rz px-rz-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      draggable={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        const th = e.currentTarget.closest('th');
        if (th) onAuto(th);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget;
        const th = el.closest('th');
        if (!th) return;
        const rtl = getComputedStyle(th).direction === 'rtl';
        const x0 = e.clientX;
        const w0 = th.getBoundingClientRect().width;
        onStart(th);
        const wasDraggable = th.draggable;
        th.draggable = false;
        el.setPointerCapture(e.pointerId);
        el.classList.add('on');
        document.body.classList.add('px-resizing');
        let w = w0;
        const move = (ev: PointerEvent) => {
          // dragging an edge outwards makes the column wider (the left edge to the left, the right edge to the right)
          const dir = (side === 'end' ? 1 : -1) * (rtl ? -1 : 1);
          w = Math.max(1, Math.round(w0 + dir * (ev.clientX - x0)));
          onLive(w);
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          el.classList.remove('on');
          document.body.classList.remove('px-resizing');
          th.draggable = wasDraggable;
          if (Math.round(w) !== Math.round(w0)) onDone(w);
          else onLive(-1);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
    />
  );
}

/** Narrowest a column can be made (px), so what it shows stays readable; the longest word of its header is a minimum too (measured). */
const COL_MIN = 64;
/** Widest a column can be made (px). */
const COL_MAX = 600;
const MIN_W: Record<string, number> = {
  order: 92, source: 76, tracking: 96, creator: 76, channel: 76, product: 90, sku: 76, chrono: 96, name: 92, phone: 104, wilaya: 92, commune: 92,
  agent: 106, fagent: 106, total: 84, time: 88, created: 84, stock: 72, desk: 72, passed: 76, confirmed: 84, follow: 96, next: 88, status: 128, since: 72,
};
/** Each column's comfortable width (px): used when the card has room; with less room, every column gives up the same part of its spare width. */
const NAT_W: Record<string, number> = {
  order: 100, source: 100, tracking: 130, creator: 96, channel: 92, product: 210, variant: 130, sku: 120, chrono: 110, name: 150, phone: 170,
  wilaya: 110, commune: 110, agent: 112, fagent: 104, total: 100, time: 118, created: 132, stock: 98, desk: 92, passed: 98, confirmed: 132,
  follow: 130, next: 130, status: 140, since: 96,
};
/**
 * Smallest a column may get when the card is short of room (px; otherwise 80% of its minimum): long values then end with "…".
 * Never narrower than its header's longest word. Below that, the table scrolls sideways.
 */
// agent / fagent: the name chip turns into « ✕ Retirer » on hover, which needs this room.
const HARD_W: Record<string, number> = { phone: 104, chrono: 94, total: 84, status: 108, order: 84, agent: 104, fagent: 104 };
/** Columns showing a pill, a badge or buttons: their size does not follow the row size (compact, normal, large). The widths above are for normal rows (14 px text). */
const PILL_K = new Set(['status', 'chrono', 'agent', 'fagent', 'stock', 'desk', 'since', 'phone']);
/** Text columns: on a wide screen they get the room left over. */
const TEXT_K = new Set(['product', 'variant', 'name', 'wilaya', 'commune', 'source', 'creator', 'follow']);
/** Width of the small columns that are never resized (expand, tick box, row buttons) until their content is measured (px). */
const FIXED_W: Record<string, number> = { _exp: 40, _ck: 34, _act: 104 };
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

/**
 * The width (px, padding included) each element's content needs: on one line ('max'), or with every line break it allows ('min').
 * All the copies are put in first and read together, so the page is laid out once.
 */
function naturalAll(items: { el: HTMLElement; mode: 'max' | 'min' }[]) {
  const probes = items.map(({ el, mode }) => {
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;width:${mode}-content;white-space:${mode === 'max' ? 'nowrap' : 'normal'}`;
    el.childNodes.forEach((n) => {
      if (!(n instanceof HTMLElement && (n.classList.contains('px-rz') || n.classList.contains('sr-only')))) probe.appendChild(n.cloneNode(true));
    });
    el.appendChild(probe);
    return probe;
  });
  const out = items.map(({ el }, i) => {
    const cs = getComputedStyle(el);
    return Math.ceil(probes[i].getBoundingClientRect().width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight));
  });
  probes.forEach((p) => p.remove());
  return out;
}

/** Saved widths: each column's share of the table (0–1). Older saves held px (and the small fixed columns), read as shares. */
function readWidths(stored: Record<string, number>) {
  const share: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of Object.entries(stored)) {
    if (k === '~v' || k.startsWith('_') || !(v > 0)) continue;
    share[k] = v;
    total += v;
  }
  if (stored['~v'] !== 2 && total > 0) for (const k of Object.keys(share)) share[k] /= total;
  return share;
}

/** Default widths: every column at its comfortable width, all of them closer to their minimum when the card is short of room; extra room goes to the text columns. */
function defaults(data: string[], mins: number[], comfy: number[], area: number) {
  const nats = comfy.map((n, i) => Math.max(mins[i], n));
  const sMin = sum(mins);
  const sNat = sum(nats);
  if (area <= sMin) return mins.slice();
  if (area <= sNat) {
    const t = (area - sMin) / (sNat - sMin || 1);
    return mins.map((m, i) => m + (nats[i] - m) * t);
  }
  const grow = data.some((k) => TEXT_K.has(k)) ? data.map((k) => TEXT_K.has(k)) : data.map(() => true);
  const gw = sum(nats.filter((_, i) => grow[i])) || 1;
  return nats.map((n, i) => (grow[i] ? n + ((area - sNat) * n) / gw : n));
}

/** Widths that add up to `area`, each between its minimum and COL_MAX: what one column cannot take or give is shared by the others. */
function settle(want: number[], mins: number[], area: number) {
  let px = want.map((w, i) => Math.min(COL_MAX, Math.max(mins[i], w)));
  for (let pass = 0; pass < 10; pass++) {
    const diff = area - sum(px);
    if (Math.abs(diff) < 0.5) break;
    // growing: in proportion to the width; shrinking: in proportion to the width above the minimum
    const room = px.map((w, i) => (diff > 0 ? (w < COL_MAX ? w : 0) : Math.max(0, w - mins[i])));
    const total = sum(room);
    if (total <= 0) break;
    px = px.map((w, i) => Math.min(COL_MAX, Math.max(mins[i], w + (diff * room[i]) / total)));
  }
  // every column at its widest and still room left (very few columns): the table still fills the card
  const left = area - sum(px);
  if (left > 0.5) {
    const s = sum(px) || 1;
    px = px.map((w) => w + (left * w) / s);
  }
  return px;
}

/**
 * Resizable columns for one table. The table always keeps the width of its card: dragging the line between two columns
 * gives width to one and takes it from its neighbour, each staying between its minimum and COL_MAX. Each user's widths are
 * saved as shares of the table, so they fit any screen. `keys`: every column in display order, with the small fixed ones
 * ('_exp', '_ck', '_act'), which keep the width of their content. A card too narrow for every column at its minimum scrolls sideways.
 */
export function useResizable(stored: Record<string, number>, save: (m: Record<string, number> | null) => void, label: string, keys: string[], dens = '') {
  const [wrap, setWrap] = useState<HTMLElement | null>(null);
  const [cw, setCw] = useState(0);
  useLayoutEffect(() => {
    if (!wrap) return;
    const ro = new ResizeObserver(() => setCw(wrap.clientWidth));
    ro.observe(wrap);
    setCw(wrap.clientWidth);
    return () => ro.disconnect();
  }, [wrap]);
  const [live, setLive] = useState<Record<string, number> | null>(null);
  const data = keys.filter((k) => !k.startsWith('_'));
  const fixedKeys = keys.filter((k) => k.startsWith('_'));

  // measured when the columns, the language, the row size or the rows change: the fixed columns' content, each header's
  // longest word, and the rows' text size (`fr`: 1 for normal rows)
  const [meas, setMeas] = useState<{ fixed: Record<string, number>; head: Record<string, number>; fr: number }>({ fixed: {}, head: {}, fr: 1 });
  const sig = useRef('');
  const [, remeasure] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let on = true;
    document.fonts?.ready.then(() => {
      if (!on) return;
      sig.current = '';
      remeasure();
    });
    return () => {
      on = false;
    };
  }, []);
  useLayoutEffect(() => {
    const table = wrap?.querySelector<HTMLTableElement>(':scope > table');
    if (!table) return;
    const rows = Array.from(table.tBodies[0]?.rows ?? []).filter((r) => !r.classList.contains('qdetail'));
    const fs = parseFloat(getComputedStyle(rows[0]?.cells[0] ?? table).fontSize) || 14;
    const s = `${keys.join(',')}|${label}|${dens}|${fs}|${rows.length}|${(rows[0]?.textContent ?? '').slice(0, 80)}`;
    if (s === sig.current) return;
    sig.current = s;
    const fixed: Record<string, number> = {};
    const head: Record<string, number> = {};
    const items: { el: HTMLElement; mode: 'max' | 'min'; k: string; fx: boolean }[] = [];
    Array.from(table.tHead?.rows[0]?.cells ?? []).forEach((th, i) => {
      const k = th.dataset.col;
      if (!k) return;
      const fx = k.startsWith('_');
      items.push({ el: th, mode: fx ? 'max' : 'min', k, fx });
      if (fx) for (const r of rows.slice(0, 30)) if (r.cells[i]) items.push({ el: r.cells[i], mode: 'max', k, fx });
    });
    naturalAll(items).forEach((w, i) => {
      const { k, fx } = items[i];
      if (fx) fixed[k] = Math.max(fixed[k] ?? 0, w);
      else head[k] = w + 2;
    });
    const next = { fixed, head, fr: Math.round((fs / 14) * 1000) / 1000 };
    setMeas((o) => (JSON.stringify(o) === JSON.stringify(next) ? o : next));
  });

  /** text grows and shrinks with the row size; pills and buttons keep theirs */
  const sz = (k: string, w: number) => Math.round(PILL_K.has(k) ? w : w * meas.fr);
  const minOf = (k: string) => Math.max(sz(k, MIN_W[k] ?? COL_MIN), meas.head[k] ?? 0);
  /** a small fixed column keeps the width of its content, up to 30% of the card (wider row buttons go onto two lines) */
  const fixedW = (k: string, width: number) => Math.min(meas.fixed[k] ?? FIXED_W[k] ?? 60, Math.max(120, Math.round(width * 0.3)));
  const saved = readWidths(stored);
  const custom = Object.keys(saved).length > 0;

  /**
   * px widths for every column, filling the card, and how narrow each column may be dragged (`min`). When the card is short of
   * room, the minimums come down together towards the smallest widths (HARD_W); still short, the table is wider than the card.
   */
  const layout = (width: number) => {
    const avail = width - sum(fixedKeys.map((k) => fixedW(k, width)));
    const soft = data.map(minOf);
    const hard = data.map((k, i) => Math.max(meas.head[k] ?? 0, Math.min(soft[i], sz(k, HARD_W[k] ?? (MIN_W[k] ?? COL_MIN) * 0.8))));
    let mins = soft;
    if (avail < sum(soft)) {
      const t = Math.min(1, Math.max(0, (avail - sum(hard)) / (sum(soft) - sum(hard) || 1)));
      mins = soft.map((m, i) => Math.floor(hard[i] + (m - hard[i]) * t));
    }
    const area = Math.max(avail, sum(mins));
    let want: number[];
    if (custom) {
      // each column's saved share of the table (a column added since gets the average share)
      const known = data.filter((k) => saved[k] > 0);
      const avg = known.length ? sum(known.map((k) => saved[k])) / known.length : 1;
      const f = data.map((k) => (saved[k] > 0 ? saved[k] : avg));
      const s = sum(f) || 1;
      want = f.map((x) => (x / s) * area);
    } else
      want = defaults(
        data,
        mins,
        data.map((k) => sz(k, NAT_W[k] ?? 120)),
        area,
      );
    const r = settle(want, mins, area).map((w) => Math.round(w));
    // whole pixels that still add up to the area
    const diff = Math.round(area) - sum(r);
    if (diff && r.length) r[r.indexOf(Math.max(...r))] += diff;
    const px: Record<string, number> = {};
    const min: Record<string, number> = {};
    for (const k of fixedKeys) px[k] = fixedW(k, width);
    data.forEach((k, i) => ((px[k] = r[i]), (min[k] = mins[i])));
    return { px, min };
  };
  const width = cw || wrap?.clientWidth || 1200;
  const W = live ?? layout(width).px;

  const toSaved = (px: Record<string, number>) => {
    const area = sum(data.map((k) => px[k] || 0)) || 1;
    const m: Record<string, number> = { '~v': 2 };
    for (const k of data) m[k] = Math.round((px[k] / area) * 10000) / 10000;
    return m;
  };
  /** move the line between column k and its neighbour: k gets `delta` px, the neighbour gives them (both stay within their limits) */
  const shift = (base: Record<string, number>, min: Record<string, number>, k: string, nb: string, delta: number) => {
    const a0 = base[k];
    const b0 = base[nb];
    const lo = Math.max(min[k], a0 + b0 - COL_MAX);
    const hi = Math.min(COL_MAX, a0 + b0 - min[nb]);
    if (lo > hi) return base;
    const a = Math.round(Math.min(hi, Math.max(lo, a0 + delta)));
    return { ...base, [k]: a, [nb]: a0 + b0 - a };
  };
  /** the width the column's content needs on one line (header and cells) */
  const fit = (th: HTMLElement) => {
    const i = Array.from(th.parentElement!.children).indexOf(th);
    const table = th.closest('table')!;
    const rows = Array.from(table.tBodies[0]?.rows ?? []).filter((r) => !r.classList.contains('qdetail'));
    const cells = [th, ...rows.slice(0, 60).map((r) => r.cells[i]).filter(Boolean)] as HTMLElement[];
    return Math.max(...naturalAll(cells.map((el) => ({ el, mode: 'max' as const })))) + 2;
  };
  const one = (k: string, side: 'start' | 'end') => {
    const i = data.indexOf(k);
    const nb = side === 'end' ? data[i + 1] : data[i - 1];
    if (i < 0 || !nb) return null;
    let base = { px: {} as Record<string, number>, min: {} as Record<string, number> };
    // the header's width when the drag starts (what the handle measures from)
    let w0 = 0;
    return (
      <ColResize
        key={side}
        label={label}
        side={side}
        onStart={(th) => {
          w0 = th.getBoundingClientRect().width;
          base = layout(wrap?.clientWidth || width);
          setLive(base.px);
        }}
        onLive={(w) => setLive(w < 0 ? null : shift(base.px, base.min, k, nb, w - w0))}
        onDone={(w) => {
          const m = shift(base.px, base.min, k, nb, w - w0);
          setLive(null);
          save(toSaved(m));
        }}
        onAuto={(th) => {
          const b = layout(wrap?.clientWidth || width);
          save(toSaved(shift(b.px, b.min, k, nb, fit(th) - b.px[k])));
        }}
      />
    );
  };
  /** the grips on the header's edges (none on the table's outer edges: the table keeps its width) */
  const handle = (k: string) => (
    <>
      {one(k, 'start')}
      {one(k, 'end')}
    </>
  );
  return {
    fixed: true,
    handle,
    /** put on the element around the table (its width is the table's width) */
    wrapRef: setWrap,
    tableStyle: () => ({ tableLayout: 'fixed' as const, width: '100%' }),
    cols: () => <colgroup>{keys.map((k) => <col key={k} style={{ width: W[k] ?? FIXED_W[k] ?? COL_MIN }} />)}</colgroup>,
  };
}
