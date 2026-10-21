// Pilotix UI kit — same markup and class names as the original app, so its stylesheet applies unchanged.
import { CONF_TONE, ConfStatus, FOLLOW_TONE, FollowStatus, SAV_TONE, SavStatus, Tone } from '@pilotix/shared';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import icons from './icons.json';

// ---------------------------------------------------------------- icons
const EXTRA: Record<string, string> = {
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  whatsapp: '<path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21"/><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  userminus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>',
  userplus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  swap: '<path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/>',
};
const ALL = { ...(icons as Record<string, string>), ...EXTRA };
export type IconName = keyof typeof ALL | string;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const body = ALL[name as string] ?? ALL.help;
  return (
    <span className={`bji ${className}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: body }} />
    </span>
  );
}

// ---------------------------------------------------------------- statuses
/** "Ticket SAV-0003": an exchange parcel belongs to a SAV ticket, not to the orders. */
export function TicketTag({ savRef }: { savRef: string | null | undefined }) {
  const { t } = useTranslation();
  if (!savRef) return null;
  return <span className="px-ticket ltr">{t('sav.tag', { ref: savRef })}</span>;
}

export function StatusBadge({ kind, status }: { kind: 'conf' | 'follow' | 'sav'; status: string | null | undefined }) {
  const { t } = useTranslation();
  if (!status) return <span className="muted">—</span>;
  const tone: Tone = kind === 'conf' ? CONF_TONE[status as ConfStatus] : kind === 'follow' ? FOLLOW_TONE[status as FollowStatus] : SAV_TONE[status as SavStatus];
  return <span className={`badge t-${tone ?? 'off'}`}>{t(`${kind === 'sav' ? 'sav.status' : kind === 'conf' ? 'status.conf' : 'status.follow'}.${status}`, { defaultValue: status })}</span>;
}

/** The coloured status pill that is also a select (confirmation queue). */
export function StatusSelect<T extends string>({ value, tone, options, onChange, label, disabled }: { value: T; tone: Tone; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <select className={`qst qst-pill t-${tone}`} aria-label={label} title={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} onClick={(e) => e.stopPropagation()}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------- layout blocks
export function Card({ title, help, actions, children, className = '', badge }: { title?: ReactNode; help?: string; actions?: ReactNode; children?: ReactNode; className?: string; badge?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <h2>
            {title}
            {badge !== undefined && <> {badge}</>}
            {help && <Help text={help} label={typeof title === 'string' ? title : ''} />}
          </h2>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** The "?" next to a title that explains a number. */
export function Help({ text, label = '' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return (
    <span ref={ref} className="bjq" tabIndex={0} role="button" aria-label={`? ${label}`} aria-expanded={open} onClick={(e) => (e.stopPropagation(), setOpen(!open))} onKeyDown={(e) => e.key === 'Enter' && setOpen(!open)} style={{ position: 'relative' }}>
      <Icon name="help" />
      {open && (
        <span className="bjcc" role="tooltip" style={{ position: 'absolute', top: '120%', insetInlineStart: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.45, width: 280, whiteSpace: 'normal' }}>
          {text}
        </span>
      )}
    </span>
  );
}

export function Kpis({ children }: { children: ReactNode }) {
  return <div className="kpis">{children}</div>;
}

export function Kpi({ label, value, sub, tone, onClick, active, big, help }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone; onClick?: () => void; active?: boolean; big?: boolean; help?: string }) {
  const cls = `kpi${tone ? ` t-${tone}` : ''}${big ? ' big' : ''}${active ? ' on' : ''}${onClick ? ' clickable' : ''}`;
  const body = (
    <>
      <span className="l">
        {label}
        {help && <Help text={help} />}
      </span>
      <span className="v ltr">{value}</span>
      {sub !== undefined && <span className="s">{sub}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-pressed={active} style={{ textAlign: 'start', font: 'inherit', cursor: 'pointer' }}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.value} type="button" role="tab" aria-selected={value === it.value} className={`tab ${value === it.value ? 'on' : ''}`} onClick={() => onChange(it.value)}>
          {it.label}
          {it.count !== undefined && <b className="ltr"> {it.count}</b>}
        </button>
      ))}
    </div>
  );
}

/** The stage bar under the top bar ("Nouvelles › En cours › Confirmées"). */
export function StageBar({ items, current, flow = true }: { items: { key: string; label: string; href: string; count?: number }[]; current: string; flow?: boolean }) {
  return (
    <nav className={`bjm-bar ${flow ? 'flow' : ''}`} aria-label="Étapes">
      {items.map((it, i) => (
        <span key={it.key} style={{ display: 'contents' }}>
          {i > 0 && flow && (
            <span className="bjm-ar" aria-hidden="true">
              ›
            </span>
          )}
          <a className={`bjm-p ${current === it.key ? 'on' : ''}`} href={it.href} aria-current={current === it.key ? 'page' : undefined}>
            <span className="bjm-l">{it.label}</span>
            {it.count !== undefined && <b className="bjm-n ltr">{it.count}</b>}
          </a>
        </span>
      ))}
    </nav>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return <div className="loading">{t('common.loading')}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-box">{children}</div>;
}

export function ErrorBox({ error, onRetry }: { error?: Error | null; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="empty-box">
      <p>{error?.message || t('common.error')}</p>
      {onRetry && (
        <button className="btn small" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Field({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span className="lab">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Pager({ page, pageSize, total, onPage, onSize, sizes = [20, 50, 100] }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onSize?: (s: number) => void; sizes?: number[] }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const id = useId();
  return (
    <div className="pager">
      <span className="muted">
        {t('common.total')} <span className="ltr">{total}</span>
      </span>
      <button className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('common.prev')}>
        ‹
      </button>
      <span className="ltr">
        {page} / {pages}
      </span>
      <button className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('common.next')}>
        ›
      </button>
      {onSize && (
        <select aria-label={t('common.perPage')} className="qsz" value={pageSize} onChange={(e) => onSize(Number(e.target.value))}>
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s} / {t('common.page')}
            </option>
          ))}
        </select>
      )}
      <label className="row nowrap qgol" htmlFor={id}>
        <span className="muted small">{t('common.goTo')}</span>
        <input id={id} type="number" min={1} max={pages} value={page} className="qgo" onChange={(e) => onPage(Math.min(pages, Math.max(1, Number(e.target.value) || 1)))} />
      </label>
    </div>
  );
}

/** Sortable column header with the ↕ ▲ ▼ arrows of the original app. */
export function SortTh<K extends string>({ k, sort, dir, onSort, children, num }: { k: K; sort: K; dir: 'asc' | 'desc'; onSort: (k: K) => void; children: ReactNode; num?: boolean }) {
  const on = sort === k;
  return (
    <th className={`${num ? 'num ' : ''}qsort`} aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="qsort-btn" onClick={() => onSort(k)}>
        {children}
        <span className="qarr" data-dir={on ? dir : 'none'} aria-hidden="true">
          {on ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

/** Sticky navy bar shown when rows are selected. */
export function BulkBar({ count, children, onClear }: { count: number; children: ReactNode; onClear: () => void }) {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <div className="bulkbar" role="toolbar">
      <b>{t('common.selected', { count })}</b>
      {children}
      <button className="btn small ghost" onClick={onClear} style={{ color: 'inherit' }}>
        {t('common.unselect')}
      </button>
    </div>
  );
}

/** Period picker shared by stats cards. */
export function PeriodSelect({ value, onChange, options = ['today', 'yesterday', '7d', '30d', 'month', 'lastmonth'] }: { value: string; onChange: (v: string) => void; options?: string[] }) {
  const { t } = useTranslation();
  return (
    <select className="bjkf-sel" aria-label={t('common.period')} value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto' }}>
      {options.map((o) => (
        <option key={o} value={o}>
          {t(`common.periods.${o}`)}
        </option>
      ))}
    </select>
  );
}

/** Copy to clipboard with a fallback (some app views refuse the clipboard). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  }
}
