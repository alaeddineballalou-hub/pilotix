import { ReactNode, useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useBackLayer } from '../lib/backLayer';
import { Icon } from './kit';
import './sheet.css';

/**
 * A phone sheet rising from the bottom: a title (and what it is about), a body that scrolls, and the actions kept
 * at the thumb. Closes with ✕, a tap above it, Échap or the phone's back (only the sheet: the page under it stays).
 */
export function Sheet({ title, sub, onClose, children, foot, tall, className = '' }: { title: ReactNode; sub?: ReactNode; onClose: () => void | boolean; children: ReactNode; foot?: ReactNode; tall?: boolean; className?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useBackLayer(onClose);
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    ref.current?.focus({ preventScroll: true });
    // Échap closes the top sheet only
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('.pxk-sheet');
      if (all[all.length - 1] === ref.current?.parentElement) closeRef.current();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      // the page behind scrolls again once nothing is open above it
      if (!document.querySelector('.pxk-sheet, .pxp-order, .modal-wrap')) document.body.style.overflow = '';
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <div className={`pxk-sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby={id}>
      <button type="button" className="pxk-dim" aria-label={t('common.close')} tabIndex={-1} onClick={onClose} />
      <div ref={ref} className={`pxk-sh${tall ? ' tall' : ''}`} tabIndex={-1}>
        <div className="pxk-head">
          <span className="pxk-grab" aria-hidden="true" />
          <div className="pxk-tt">
            <span>
              <b id={id}>{title}</b>
              {sub && <small>{sub}</small>}
            </span>
            <button type="button" className="pxk-x" aria-label={t('common.close')} onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="pxk-body">{children}</div>
        {foot && <div className="pxk-foot">{foot}</div>}
      </div>
    </div>
  );
}

/** One choice among a few, as big tiles: an icon, its name and (often) what it is today. */
export function Tiles<K extends string>({ value, onChange, items, label, cols = 2 }: { value: K | null; onChange: (k: K) => void; items: { k: K; icon: string; label: ReactNode; now?: ReactNode; off?: ReactNode }[]; label: string; cols?: 2 | 3 | 4 }) {
  return (
    <div className={`pxk-tiles c${cols}`} role="radiogroup" aria-label={label}>
      {items.map((x) => (
        <button key={x.k} type="button" role="radio" aria-checked={value === x.k} className={`pxk-tile${value === x.k ? ' on' : ''}`} disabled={!!x.off} onClick={() => onChange(x.k)}>
          <Icon name={x.icon} />
          <b>{x.label}</b>
          {(x.off || x.now) && <small>{x.off || x.now}</small>}
        </button>
      ))}
    </div>
  );
}

/** A list of answers to tap (one), each on its own line. */
export function Options<K extends string>({ value, onChange, items, label }: { value: K | null; onChange: (k: K) => void; items: { k: K; label: ReactNode; icon?: string; hint?: ReactNode }[]; label: string }) {
  return (
    <div className="pxk-opts" role="radiogroup" aria-label={label}>
      {items.map((x) => (
        <button key={x.k} type="button" role="radio" aria-checked={value === x.k} className={`pxk-opt${value === x.k ? ' on' : ''}`} onClick={() => onChange(x.k)}>
          <i aria-hidden="true" />
          {x.icon && <Icon name={x.icon} />}
          <span>
            {x.label}
            {x.hint && <small>{x.hint}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Two or three ways, side by side (Stop desk | Domicile). */
export function Seg<K extends string>({ value, onChange, items, label }: { value: K; onChange: (k: K) => void; items: { k: K; label: ReactNode; icon?: string }[]; label: string }) {
  return (
    <div className="pxk-seg" role="radiogroup" aria-label={label}>
      {items.map((x) => (
        <button key={x.k} type="button" role="radio" aria-checked={value === x.k} className={value === x.k ? 'on' : ''} onClick={() => onChange(x.k)}>
          {x.icon && <Icon name={x.icon} />}
          {x.label}
        </button>
      ))}
    </div>
  );
}
