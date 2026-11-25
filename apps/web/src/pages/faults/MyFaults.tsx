// « Mes erreurs » on an agent's own dashboard (the owner's rule, 25 Nov 2026: an agent sees his errors, never anyone
// else's): how many problems were his over the period, next to his team's share (no one's name), and each one, with
// « Pas moi ». Statistics only: nothing here touches the pay.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, n, pct } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';
import { ContestButton } from './parts';
import './faults.css';

export function MyFaults({ range }: { range: { from: string; to: string } }) {
  const { t } = useTranslation();
  const q = useRpc('faults.mine', range);
  const [all, setAll] = useState(false);
  const d = q.data;
  if (!d) return null;
  const list = all ? d.list : d.list.slice(0, 3);
  return (
    <section className="tb-card tb-myc pxn-card pxf-card" aria-labelledby="pxf-mh">
      <header className="pxn-h">
        <h3 id="pxf-mh">
          <Icon name="flag" /> {t('faults.mine.title')}
        </h3>
      </header>
      <div className="pxf-two">
        <div>
          <b className="ltr">{n(d.n)}</b>
          <small>{d.rate !== null ? t('faults.mine.rate', { v: pct(d.rate, 1) }) : t('faults.mine.count')}</small>
        </div>
        <div>
          <b className="ltr">{d.teamRate !== null ? pct(d.teamRate, 1) : '—'}</b>
          <small>{t('faults.mine.team')}</small>
        </div>
      </div>
      <p className="pxf-note">
        <Icon name="lock" /> {t('faults.mine.note')}
      </p>
      {d.n === 0 ? (
        <p className="pxn-empty">{t('faults.mine.none')}</p>
      ) : (
        <div>
          {list.map((x) => (
            <div key={x.id} className="pxf-li" role="button" tabIndex={0} onClick={() => openOrder(x.orderId)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openOrder(x.orderId))}>
              <b>
                <span className="ltr">{x.order?.ref}</span> · {x.order?.customer}
              </b>
              <span className="w" dir="auto">
                « {t(`faults.reason.${x.reason}`)} »
              </span>
              <small>
                {t(`faults.moment.${x.moment}`)} · {dateOnly(x.at)}
              </small>
              {!x.decided && <ContestButton id={x.id} sent={x.contested} />}
            </div>
          ))}
          {d.list.length > 3 && (
            <button type="button" className="pxf-more" onClick={() => setAll(!all)}>
              {all ? t('faults.mine.less') : t('faults.mine.all', { n: d.list.length })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
