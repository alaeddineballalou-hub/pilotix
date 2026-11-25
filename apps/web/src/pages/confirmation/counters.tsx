// Confirmation: the counters over each list (the owner's design, 25 Nov 2026). Each one is a filter: a tap shows only
// those orders (it stays highlighted), a tap again shows them all; the numbers stay the whole list's.
// - Nouvelles « En retard · À appeler vite · À temps », En cours « À rappeler · Plus tard · Reportées »: counted by the
//   server over the whole list with its search, filters and switch (confirmation.list › buckets).
// - Confirmées: where the orders are in the dépôt (« À préparer · En dispatch · Dispatchées », and « Sans stock » when
//   there is one), the numbers of confirmation.counts › stages.
// On a phone they replace the small « N en retard · N à traiter » badges.
import { useTranslation } from 'react-i18next';
import { n } from '../../lib/format';
import './counters.css';

export type CounterTone = 'late' | 'soon' | 'ok' | 'off' | 'info';
export interface CounterItem<K extends string> {
  k: K;
  n: number;
  tone: CounterTone;
  label: string;
}

export function Counters<K extends string>({ items, value, onChange, className }: { items: CounterItem<K>[]; value: K | null; onChange: (k: K | null) => void; className?: string }) {
  const { t } = useTranslation();
  if (!items.length) return null;
  return (
    <div className={`cfk n${items.length}${className ? ` ${className}` : ''}`} role="group" aria-label={t('confirmation.counters.label')} data-g="conf-counters">
      {items.map((x) => (
        <button key={x.k} type="button" className={`cfk2 ${x.tone}${value === x.k ? ' on' : ''}`} aria-pressed={value === x.k} onClick={() => onChange(value === x.k ? null : x.k)}>
          <b className="ltr">{n(x.n)}</b>
          <small>{x.label}</small>
        </button>
      ))}
    </div>
  );
}

/** The tries of an order of En cours: one dot per try the shop allows (« annuler après N tentatives »), filled for
 *  those made, then « 2/5 ». */
export function TryDots({ made, max }: { made: number; max: number }) {
  const { t } = useTranslation();
  const m = Math.max(1, max);
  return (
    <span className="cfdots" title={t('confirmation.tries.title', { count: made, max: m })} aria-label={t('confirmation.tries.title', { count: made, max: m })}>
      {Array.from({ length: m }, (_, k) => (
        <b key={k} className={k < made ? 'on' : ''} aria-hidden="true" />
      ))}
      <small className="ltr" aria-hidden="true">
        {made}/{m}
      </small>
    </span>
  );
}
