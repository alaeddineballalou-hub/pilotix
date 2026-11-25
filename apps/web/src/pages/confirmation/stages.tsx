// Confirmation › Confirmées: where each confirmed order is in the dépôt — sans stock › à préparer › en dispatch ›
// dispatchées (handed over, its company has not taken it yet), the Dépôt's words for the last two. Read-only: a stage only filters
// the list. Once the company has the parcel it leaves Confirmées for Commandes › En livraison (the owner's ask, 25 Nov 2026).
import { CONF_TONE, FOLLOW_TONE, menuTabName, type Order } from '@pilotix/shared';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBadge } from '../../ui/kit';
import './confirmation.css';

export const CONF_STAGES = ['nostock', 'preparer', 'prepares', 'dispatchees'] as const;
export type ConfStage = (typeof CONF_STAGES)[number];

/** The stage of an order of Confirmées (its list holds no parcel a company has taken); null: not in the dépôt yet. */
export function confStage(o: Pick<Order, 'confStatus' | 'followStatus'>): ConfStage | null {
  if (!o.followStatus) return o.confStatus === 'no_stock' ? 'nostock' : null;
  if (o.followStatus === 'to_prepare') return 'preparer';
  if (o.followStatus === 'prepared') return 'prepares';
  if (o.followStatus === 'shipped') return 'dispatchees';
  return null;
}

/** A stage's name: the bar's (« Dispatchées »), or one order's (« Dispatchée »). « À préparer » (not the Dépôt's « En
 *  préparation »): the word the agents know, and it fits the list's « Livraison » column. */
function stageName(t: (k: string) => string, k: ConfStage, one = false): string {
  if (k === 'nostock') return t('confirmation.stages.nostock');
  if (k === 'preparer') return t('status.follow.to_prepare');
  if (k === 'dispatchees' && one) return t('confirmation.stages.dispatchee');
  return t(menuTabName('depot', k));
}

const TONE: Record<ConfStage, string> = { nostock: CONF_TONE.no_stock, preparer: FOLLOW_TONE.to_prepare, prepares: FOLLOW_TONE.prepared, dispatchees: FOLLOW_TONE.shipped };

/** One order's stage (the list's « Livraison » column, a phone's card); anything else: its status as before. */
export function StageTag({ o }: { o: Pick<Order, 'confStatus' | 'followStatus' | 'subStatus'> }) {
  const { t } = useTranslation();
  const k = confStage(o);
  if (!k) return <StatusBadge kind="follow" status={o.followStatus} sub={o.subStatus} />;
  return <span className={`badge t-${TONE[k]}`}>{stageName(t, k, true)}</span>;
}

/** The stages over the list, with what is at each: « Toutes », then « Sans stock », then the dépôt's way. */
export function ConfirmedStages({ stage, onChange, counts, total }: { stage: ConfStage | null; onChange: (s: ConfStage | null) => void; counts?: Partial<Record<ConfStage, number>>; total?: number }) {
  const { t } = useTranslation();
  // a phone shows two or three stages at a time: the one picked is brought into view (again once the numbers are in)
  const bar = useRef<HTMLElement>(null);
  const nums = CONF_STAGES.map((k) => counts?.[k] ?? '').join();
  useLayoutEffect(() => {
    const el = bar.current;
    const on = el?.querySelector<HTMLElement>('.bjm-p.on');
    if (!el || !on || el.scrollWidth <= el.clientWidth + 1) return;
    const r = el.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    if (b.left >= r.left + 8 && b.right <= r.right - 8) return;
    el.scrollBy({ left: b.left + b.width / 2 - (r.left + r.width / 2) });
  }, [stage, nums, total]);
  const pill = (k: ConfStage | null, label: string, n: number | undefined) => (
    <button type="button" role="radio" aria-checked={stage === k} className={`bjm-p ${stage === k ? 'on' : ''}`} onClick={() => onChange(k)}>
      <span className="bjm-l">{label}</span>
      {n !== undefined && <b className="bjm-n ltr">{n}</b>}
    </button>
  );
  return (
    <nav ref={bar} className="bjm-bar flow cf-stages" role="radiogroup" aria-label={t('confirmation.stages.label')} data-g="conf-stages">
      {pill(null, t('confirmation.stages.all'), total)}
      <span className="bjm-sep" aria-hidden="true" />
      {pill('nostock', stageName(t, 'nostock'), counts?.nostock)}
      <span className="bjm-sep" aria-hidden="true" />
      {(['preparer', 'prepares', 'dispatchees'] as const).map((k, i) => (
        <span key={k} style={{ display: 'contents' }}>
          {i > 0 && (
            <span className="bjm-ar" aria-hidden="true">
              ›
            </span>
          )}
          {pill(k, stageName(t, k), counts?.[k])}
        </span>
      ))}
    </nav>
  );
}
