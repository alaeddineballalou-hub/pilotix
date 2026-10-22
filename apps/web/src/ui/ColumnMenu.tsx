import { DragEvent, useMemo, useRef, useState } from 'react';
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
export function ColResize({ label, onStart, onLive, onDone, onAuto }: { label: string; onStart: (th: HTMLElement) => void; onLive: (w: number) => void; onDone: (w: number) => void; onAuto: (th: HTMLElement) => void }) {
  return (
    <span
      className="px-rz"
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
          w = Math.max(48, Math.min(900, Math.round(w0 + (rtl ? -1 : 1) * (ev.clientX - x0))));
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

/**
 * Resizable columns for one table. Once a user sets a width, the table keeps every column's width
 * (fixed layout): a column can then be made narrower than its content (the text ends with "…").
 * `keys`: every column of the table in display order, the extra ones too (e.g. '_exp', '_ck', '_act').
 */
export function useResizable(stored: Record<string, number>, save: (m: Record<string, number> | null) => void, label: string) {
  const [live, setLive] = useState<Record<string, number> | null>(null);
  const liveRef = useRef<Record<string, number> | null>(null);
  const setL = (m: Record<string, number> | null) => {
    liveRef.current = m;
    setLive(m);
  };
  const W = live ?? stored;
  const fixed = Object.keys(W).length > 0;
  /** the widths on screen now, for every column (stored ones win) */
  const measure = (th: HTMLElement) => {
    const m: Record<string, number> = {};
    for (const x of Array.from(th.parentElement!.children) as HTMLElement[]) if (x.dataset.col) m[x.dataset.col] = Math.round(x.getBoundingClientRect().width);
    return { ...m, ...stored };
  };
  /** the width the column's content needs (header and cells), within 60–600 px */
  const fit = (th: HTMLElement) => {
    const tr = th.parentElement!;
    const i = Array.from(tr.children).indexOf(th);
    const table = th.closest('table')!;
    let w = th.scrollWidth;
    for (const td of Array.from(table.querySelectorAll(`tbody > tr:not(.qdetail) > td:nth-child(${i + 1})`)) as HTMLElement[]) w = Math.max(w, td.scrollWidth + 2);
    return Math.max(60, Math.min(600, Math.ceil(w)));
  };
  const handle = (k: string) => (
    <ColResize
      label={label}
      onStart={(th) => setL(measure(th))}
      onLive={(w) => setL(w < 0 ? null : { ...(liveRef.current ?? stored), [k]: w })}
      onDone={(w) => {
        const m = { ...(liveRef.current ?? stored), [k]: w };
        setL(null);
        save(m);
      }}
      onAuto={(th) => save({ ...measure(th), [k]: fit(th) })}
    />
  );
  return {
    fixed,
    handle,
    /** the table's width and the <col> list, in fixed layout */
    tableStyle: (keys: string[]) => (fixed ? { tableLayout: 'fixed' as const, width: keys.reduce((s, k) => s + (W[k] ?? 140), 0) } : undefined),
    cols: (keys: string[]) => (fixed ? <colgroup>{keys.map((k) => <col key={k} style={{ width: W[k] ?? 140 }} />)}</colgroup> : null),
  };
}
