// Produits & stock: what the tabs share — a product's name, the depots, a quantity stepper, a row's "more" menu,
// a product picker, a stock level bar and the toolbar above a list.
import { ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, n } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { Float } from '../../ui/Float';
import { Icon } from '../../ui/kit';
import { SearchBox } from '../ai/agent';

export type StockRowT = Out<'catalog.stock'>[number];
export type ProductT = Out<'catalog.products'>[number];

/** "Poussette canne pliable Gris" */
export const nameOf = (r: { productName: string; variantTitle: string }) => (r.variantTitle ? `${r.productName} ${r.variantTitle}` : r.productName);

/** Lower case, without accents: "Écharpe" matches "echarpe". */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const matches = (q: string, ...fields: (string | null | undefined)[]) => {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const hay = fold(fields.filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
};

/** The active depots, the default one first. */
export function useDepots() {
  const q = useRpc('catalog.warehouses', {});
  return { depots: q.data ?? [], many: (q.data?.length ?? 0) > 1, loading: q.isLoading };
}

/** Whole numbers only; '' while the box is empty. */
export const toInt = (v: string): number | '' => {
  const d = v.replace(/[^\d]/g, '');
  return d === '' ? '' : Math.min(1_000_000, Number(d));
};

/** −  12  + : a quantity typed with the number pad or changed with a finger. */
export function Stepper({ value, onChange, min = 0, max, label, onEnter, size = 'md', inputRef, placeholder }: {
  value: number | '';
  onChange: (v: number | '') => void;
  min?: number;
  max?: number;
  label: string;
  onEnter?: () => void;
  size?: 'md' | 'lg';
  inputRef?: (el: HTMLInputElement | null) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const v = value === '' ? null : value;
  const clamp = (x: number) => Math.max(min, max !== undefined ? Math.min(max, x) : x);
  return (
    <span className={`pd-step ${size}`}>
      <button type="button" tabIndex={-1} aria-label={t('produits.ui.less', { name: label })} disabled={v === null || v <= min} onClick={() => onChange(clamp((v ?? min) - 1))}>
        <Icon name="minus" />
      </button>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        enterKeyHint="next"
        autoComplete="off"
        aria-label={label}
        placeholder={placeholder}
        value={value === '' ? '' : String(value)}
        onChange={(e) => {
          const x = toInt(e.target.value);
          onChange(x === '' ? '' : clamp(x));
        }}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <button type="button" tabIndex={-1} aria-label={t('produits.ui.more', { name: label })} disabled={max !== undefined && v !== null && v >= max} onClick={() => onChange(clamp((v ?? min - 1) + 1))}>
        <Icon name="plus" />
      </button>
    </span>
  );
}

/** A money box: whole dinars, the "DA" after the number. */
export function MoneyInput({ value, onChange, label, placeholder, disabled, changed }: { value: number | ''; onChange: (v: number | '') => void; label: string; placeholder?: string; disabled?: boolean; changed?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={`pd-money ${changed ? 'changed' : ''} ${disabled ? 'off' : ''}`}>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        value={value === '' ? '' : n(value)}
        onChange={(e) => onChange(toInt(e.target.value))}
        onFocus={(e) => e.currentTarget.select()}
      />
      <i aria-hidden="true">{t('produits.ui.da')}</i>
    </span>
  );
}

/** The ⋯ button of a row: the actions that do not fit beside it. */
export function RowMenu({ label, items }: { label: string; items: { label: string; icon: string; onClick: () => void }[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} type="button" className="btn small pd-more" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <Float anchor={ref} onClose={() => setOpen(false)} minWidth={210} className="pd-menu">
          <div role="menu" aria-label={label}>
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                <Icon name={it.icon} />
                {it.label}
              </button>
            ))}
          </div>
        </Float>
      )}
    </>
  );
}

/** What is left against the alert level: a short bar, red when nothing is left, amber under the level. */
export function LevelBar({ available, alert }: { available: number; alert: number }) {
  const top = Math.max(alert * 2, available, 1);
  const w = Math.max(0, Math.min(1, available / top));
  const tone = available <= 0 ? 'out' : alert > 0 && available <= alert ? 'low' : 'ok';
  return (
    <span className={`pd-level ${tone}`} aria-hidden="true">
      <i style={{ width: `${w * 100}%` }} />
      {alert > 0 && <em style={{ insetInlineStart: `${Math.min(1, alert / top) * 100}%` }} />}
    </span>
  );
}

export type PickItem = { variantId: number; label: string; sku: string; cost: number; stock?: number; note?: string };

/** Finds a product by its name, its colour / size or its code, and adds it to a list. */
export function ProductPicker({ items, onPick, placeholder, taken }: { items: PickItem[]; onPick: (it: PickItem) => void; placeholder: string; taken?: Set<number> }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const res = q.trim() ? items.filter((it) => matches(q, it.label, it.sku)).slice(0, 8) : [];
  return (
    <div className="pd-pick">
      <SearchBox value={q} onChange={setQ} placeholder={placeholder} />
      {q.trim() !== '' && (
        <ul className="pd-pick-list">
          {res.length ? (
            res.map((it) => (
              <li key={it.variantId}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(it);
                    setQ('');
                  }}
                >
                  <span>
                    <b>{it.label}</b>
                    <small className="ltr">{it.sku}</small>
                  </span>
                  <span className="pd-pick-r">
                    {it.note && <small>{it.note}</small>}
                    {taken?.has(it.variantId) ? <em>{t('produits.ui.inList')}</em> : <Icon name="plus" />}
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li className="pd-pick-none">{t('produits.ui.noMatch')}</li>
          )}
        </ul>
      )}
    </div>
  );
}

/** The bar above a list: search, filters, and the main button of the tab at the end. */
export function Toolbar({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="pd-tools">
      <div className="pd-tools-f">{children}</div>
      {action && <div className="pd-tools-a">{action}</div>}
    </div>
  );
}

/** A name or an amount put inside a sentence keeps its own direction (a French supplier in an Arabic sentence). */
export const bidi = (s: string | number | null | undefined) => `\u2068${s ?? ''}\u2069`;

/** −8 500 DA / +1 200 DA: money that went down or up, with a real minus sign. */
export const signedDa = (v: number) => (v < 0 ? `−${da(-v)}` : v > 0 ? `+${da(v)}` : da(0));

/** +3 / −2 / 0 with its colour. */
export function Delta({ v, zero = '0' }: { v: number; zero?: string }) {
  return <b className={`pd-delta ltr ${v > 0 ? 'up' : v < 0 ? 'down' : 'eq'}`}>{v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : zero}</b>;
}

/** A depot select that only shows when there are several depots. */
export function DepotSelect({ value, onChange, all, label }: { value: string; onChange: (v: string) => void; all?: string; label: string }) {
  const { depots, many } = useDepots();
  if (!many) return null;
  return (
    <select className="pd-sel" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {all !== undefined && <option value="">{all}</option>}
      {depots.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
