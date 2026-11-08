// Point de vente › Ventes du jour: today's (or yesterday's) sales, the newest first, what they brought by payment, each
// ticket printed again, and a sale of the open drawer cancelled by the owner (its products back in the dépôt).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, da, n } from '../../lib/format';
import i18n from '../../lib/i18n';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Icon, Kpi, Kpis, Loading } from '../../ui/kit';
import { ConfirmButton } from '../admin/bits';
import { printTicket } from './ticket';
import { POS_METHODS, PosSale } from './shared';

/** A day in Algiers as YYYY-MM-DD (0: today, -1: yesterday). */
const dayOf = (k: number) => new Date(Date.now() + 3_600_000 + k * 86_400_000).toISOString().slice(0, 10);
/** « Samedi 7 novembre » */
export function longDay(k: number) {
  const s = new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR', { timeZone: 'Africa/Algiers', weekday: 'long', day: 'numeric', month: 'long', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(Date.parse(`${dayOf(k)}T12:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function Sales() {
  const { t } = useTranslation();
  const [day, setDay] = useState<0 | -1>(0);
  const q = useRpc('pos.sales', day ? { date: dayOf(-1) } : {});
  const st = useRpc('pos.state', {});
  const cancel = useAction('pos.cancel', { success: t('pos.sales.cancelledOk') });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data || !st.data) return <Loading />;
  const d = q.data;
  const s = st.data;
  const what = (x: PosSale) => {
    const [first, ...more] = x.lines;
    const name = first ? `${first.name}${first.variant ? ` · ${first.variant}` : ''}${first.qty > 1 ? ` × ${first.qty}` : ''}` : '';
    return more.length ? t('pos.sales.andMore', { name, count: more.length }) : name;
  };
  return (
    <div className="pos-day">
      <div className="pos-day-head">
        <div className="pos-grow">
          <h2>{longDay(day)}</h2>
          <p className="muted">
            {s.session ? t('pos.sales.drawerOpen', { time: clock(s.session.openedAt), by: s.session.who ?? '—', v: da(s.session.opening) }) : t('pos.sales.drawerClosed')}
          </p>
        </div>
        <div className="pos-chips" role="group" aria-label={t('pos.sales.whichDay')}>
          <button type="button" className={`pos-chip ${day === 0 ? 'on' : ''}`} aria-pressed={day === 0} onClick={() => setDay(0)}>
            {t('pos.sales.todayShort')}
          </button>
          <button type="button" className={`pos-chip ${day === -1 ? 'on' : ''}`} aria-pressed={day === -1} onClick={() => setDay(-1)}>
            {t('pos.sales.yesterday')}
          </button>
        </div>
        <a className="btn primary" href="#/pos/vendre">
          <Icon name="plus" />
          {t('pos.sell.newSale')}
        </a>
      </div>
      <Kpis>
        <Kpi label={t('pos.sales.count')} value={n(d.count)} sub={t('pos.sell.items', { count: d.items })} icon="receipt" />
        <Kpi label={t('pos.sales.total')} value={da(d.total)} sub={d.saved ? t('pos.sales.packsGiven', { v: da(d.saved) }) : undefined} icon="coins" />
        {POS_METHODS.map((m) => (
          <Kpi key={m} label={t(`pos.method.${m}`)} value={da(d.by[m])} sub={m === 'cash' ? t('pos.sales.inDrawer') : t('pos.sales.notInDrawer')} />
        ))}
      </Kpis>
      <section className="card">
        <div className="pos-list-head">
          <h2>{t('pos.sales.title')}</h2>
          <span className="muted pos-count">{t('pos.sales.n', { count: d.count })}</span>
          {d.cancelled > 0 && <span className="pos-pill bad">{t('pos.sales.nCancelled', { count: d.cancelled })}</span>}
        </div>
        {d.sales.length ? (
          <div className="pos-list" role="table" aria-label={t('pos.sales.title')}>
            <div className="pos-list-h" role="row">
              <span role="columnheader">{t('pos.sales.time')}</span>
              <span role="columnheader">{t('pos.sales.no')}</span>
              <span role="columnheader">{t('pos.sales.what')}</span>
              <span role="columnheader">{t('pos.sales.by')}</span>
              <span role="columnheader">{t('pos.sales.paid')}</span>
              <span role="columnheader" className="end">
                {t('pos.sales.amount')}
              </span>
              <span role="columnheader" className="pos-vh">
                {t('pos.sales.actions')}
              </span>
            </div>
            {d.sales.map((x) => {
              const off = !!x.cancelledAt;
              const canCancel = s.manage && !off && s.session?.id === x.sessionId;
              return (
                <div key={x.id} className={`pos-list-r ${off ? 'off' : ''}`} role="row">
                  <span role="cell" className="ltr pos-time">
                    {clock(x.at)}
                  </span>
                  <span role="cell" className="ltr muted">
                    {x.no}
                  </span>
                  <span role="cell" className="pos-what">
                    <b>{what(x)}</b>
                    {x.customer && <small className="muted">{x.customer.name}</small>}
                    {off && <span className="pos-pill bad">{t('pos.sales.cancelled')}</span>}
                  </span>
                  <span role="cell" className="muted">
                    {x.seller ?? '—'}
                  </span>
                  <span role="cell" className="muted">
                    {t(`pos.method.${x.method}`)}
                  </span>
                  <b role="cell" className="ltr end">
                    {off ? <s>{da(x.total)}</s> : da(x.total)}
                  </b>
                  <span role="cell" className="pos-acts">
                    <button type="button" className="btn small" onClick={() => printTicket(x, s.ticket)} title={t('pos.sales.printAgain')}>
                      <Icon name="printer" />
                      <span className="pos-acts-l">{t('pos.sales.ticket')}</span>
                    </button>
                    {canCancel && (
                      <ConfirmButton className="btn small ghost danger" question={t('pos.sales.cancelAsk', { no: x.no })} onConfirm={() => cancel.mutate({ id: x.id })} disabled={cancel.isPending}>
                        {t('pos.sales.cancel')}
                      </ConfirmButton>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty>{day ? t('pos.sales.noneYesterday') : t('pos.sales.none')}</Empty>
        )}
      </section>
    </div>
  );
}
