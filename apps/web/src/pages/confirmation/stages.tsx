// Confirmation › Confirmées: where each confirmed order is in the dépôt, in the Dépôt's own words — sans stock › en
// préparation › en dispatch › dispatchées (handed over, its company has not taken it yet). Read-only: a stage only filters
// the list. Once the company has the parcel it leaves Confirmées for Commandes › En livraison (the owner's ask, 25 Nov 2026).
import { CONF_TONE, FOLLOW_TONE, menuTabName, type Order } from '@pilotix/shared';
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

const TONE: Record<ConfStage, string> = { nostock: CONF_TONE.no_stock, preparer: FOLLOW_TONE.to_prepare, prepares: FOLLOW_TONE.prepared, dispatchees: FOLLOW_TONE.shipped };

/** One order's stage (the list's « Livraison » column, a phone's card); anything else: its status as before. */
export function StageTag({ o }: { o: Pick<Order, 'confStatus' | 'followStatus' | 'subStatus'> }) {
  const { t } = useTranslation();
  const k = confStage(o);
  if (!k) return <StatusBadge kind="follow" status={o.followStatus} sub={o.subStatus} />;
  const label = k === 'nostock' ? t('confirmation.stages.nostock') : k === 'dispatchees' ? t('confirmation.stages.dispatchee') : t(menuTabName('depot', k));
  return <span className={`badge t-${TONE[k]}`}>{label}</span>;
}

/** The stages over the list, with what is at each: « Toutes », then « Sans stock », then the Dépôt's way. */
export function ConfirmedStages({ stage, onChange, counts, total }: { stage: ConfStage | null; onChange: (s: ConfStage | null) => void; counts?: Partial<Record<ConfStage, number>>; total?: number }) {
  const { t } = useTranslation();
  const pill = (k: ConfStage | null, label: string, n: number | undefined) => (
    <button type="button" role="radio" aria-checked={stage === k} className={`bjm-p ${stage === k ? 'on' : ''}`} onClick={() => onChange(k)}>
      <span className="bjm-l">{label}</span>
      {n !== undefined && <b className="bjm-n ltr">{n}</b>}
    </button>
  );
  return (
    <nav className="bjm-bar flow cf-stages" role="radiogroup" aria-label={t('confirmation.stages.label')} data-g="conf-stages">
      {pill(null, t('confirmation.stages.all'), total)}
      <span className="bjm-sep" aria-hidden="true" />
      {pill('nostock', t('confirmation.stages.nostock'), counts?.nostock)}
      <span className="bjm-sep" aria-hidden="true" />
      {(['preparer', 'prepares', 'dispatchees'] as const).map((k, i) => (
        <span key={k} style={{ display: 'contents' }}>
          {i > 0 && (
            <span className="bjm-ar" aria-hidden="true">
              ›
            </span>
          )}
          {pill(k, t(menuTabName('depot', k)), counts?.[k])}
        </span>
      ))}
    </nav>
  );
}
