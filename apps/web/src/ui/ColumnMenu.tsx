import { DragEvent, useState } from 'react';
import { store } from '../lib/store';
import { useTranslation } from 'react-i18next';
import { rpc } from '../lib/backend';
import { useRpc } from '../lib/query';
import { useSession } from '../lib/session';
import { Icon } from './kit';
import { toast } from './toast';

/**
 * Column picker with the shared, locked presets. The same presets show in Confirmation and Suivi:
 * a preset keeps the columns a table has and ignores the others.
 */
export function ColumnMenu<K extends string>({ cols, visible, onChange, onReset, open, onToggle, order, onOrder }: {
  cols: { k: K; label: string }[];
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
  const [pName, setPName] = useState('');
  const has = (k: string): k is K => cols.some((c) => c.k === k);
  const listed = order ? order.map((k) => cols.find((c) => c.k === k)!).filter(Boolean) : cols;
  const drag = order && onOrder ? colDrag(order, onOrder) : null;
  const add = async () => {
    const name = pName.trim();
    if (!name) return;
    try {
      await rpc('confirmation.addColPreset', { name, cols: listed.filter((c) => visible.has(c.k)).map((c) => c.k) });
      setPName('');
      toast(t('confirmation.presets.saved', { name }), 'ok');
      presets.refetch();
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  const del = async (id: string) => {
    try {
      await rpc('confirmation.deleteColPreset', { id });
      toast(t('confirmation.presets.deleted'), 'ok');
      presets.refetch();
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
            {(presets.data ?? []).map((p) => {
              const keep = p.cols.filter(has);
              const on = keep.length > 0 && keep.length === visible.size && keep.every((k) => visible.has(k));
              return (
                <div key={p.id} className={`px-pre-it ${on ? 'on' : ''}`}>
                  <button type="button" className="px-pre-go" title={t('confirmation.presets.locked')} aria-label={t('confirmation.presets.apply', { name: p.name })} disabled={!keep.length} onClick={() => (onChange(new Set(keep)), order && onOrder?.([...keep, ...order.filter((k) => !keep.includes(k))]))}>
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
          <div className="px-pre-h">{t('confirmation.presets.cols')}</div>
          {listed.map((c) => (
            <label key={c.k} className={`px-qpop-it ${drag ? 'px-drag' : ''}`} {...(drag ? drag(c.k) : {})}>
              {drag && <Icon name="grip" className="px-grip" />}
              <span>{c.label}</span>
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
            </label>
          ))}
          <button type="button" className="btn small ghost" onClick={onReset}>
            {t('common.showAll')}
          </button>
        </div>
      )}
    </span>
  );
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
