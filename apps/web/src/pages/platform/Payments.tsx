// Every payment received, by month and by way of paying (BaridiMob, CCP, cash…).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadCsv } from '../../lib/files';
import { da, dateOnly } from '../../lib/format';
import { Staff, usePRpc } from '../../lib/platform';
import { ErrorBox, Icon, Kpi, Kpis, Loading } from '../../ui/kit';
import { Empty, METHODS } from './bits';

export function Payments({ staff: _staff }: { staff: Staff }) {
  const { t } = useTranslation();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [method, setMethod] = useState<'' | (typeof METHODS)[number]>('');
  const [withVoid, setWithVoid] = useState(false);
  const q = usePRpc('p.payments.list', { month: month || undefined, method: method || undefined, withVoid });
  const d = q.data;
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.payments')}</h1>
          <p className="muted">{t('platform.paymentsSub')}</p>
        </div>
        {d && d.rows.length > 0 && (
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadCsv(
                `pilotix-paiements-${month || 'tout'}.csv`,
                [
                  [t('platform.p.date'), t('platform.col.shop'), t('platform.p.amount'), t('platform.p.method'), t('platform.p.months'), t('platform.p.reference'), t('platform.untilDate', { date: '' }).trim(), t('platform.p.by')],
                  ...d.rows.filter((p) => !p.voidAt).map((p) => [dateOnly(p.paidAt), p.shop.name, String(p.amount), t(`platform.method.${p.method}`), String(p.months), p.reference ?? '', dateOnly(p.periodTo), p.by ?? '']),
                ],
              )
            }
          >
            <Icon name="download" /> CSV
          </button>
        )}
      </div>
      <div className="pp-toolbar">
        <label className="field pp-inline">
          <span className="lab">{t('platform.p.month')}</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <label className="field pp-inline">
          <span className="lab">{t('platform.p.method')}</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="">{t('platform.filter.all')}</option>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`platform.method.${m}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={withVoid} onChange={(e) => setWithVoid(e.target.checked)} /> {t('platform.p.withVoid')}
        </label>
        {month && (
          <button type="button" className="btn small" onClick={() => setMonth('')}>
            {t('platform.p.allMonths')}
          </button>
        )}
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <Kpis>
            <Kpi label={t('platform.p.total')} value={da(d!.total)} icon="coins" sub={t('platform.p.count', { count: d!.count })} />
            {d!.byMethod
              .filter((b) => b.amount > 0)
              .map((b) => (
                <Kpi key={b.method} label={t(`platform.method.${b.method}`)} value={da(b.amount)} />
              ))}
          </Kpis>
          <div className="card">
            {d!.rows.length === 0 ? (
              <Empty>{t('platform.pay.none')}</Empty>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl pp-tbl">
                  <thead>
                    <tr>
                      <th>{t('platform.p.date')}</th>
                      <th>{t('platform.col.shop')}</th>
                      <th className="num">{t('platform.p.amount')}</th>
                      <th>{t('platform.p.method')}</th>
                      <th>{t('platform.p.period')}</th>
                      <th>{t('platform.p.reference')}</th>
                      <th>{t('platform.p.by')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d!.rows.map((p) => (
                      <tr key={p.id} className={p.voidAt ? 'pp-void' : ''}>
                        <td data-l={t('platform.p.date')}>{dateOnly(p.paidAt)}</td>
                        <td data-l={t('platform.col.shop')}>
                          <a href={`#/platform/shops/${p.shop.id}`}>{p.shop.name}</a>
                        </td>
                        <td className="num ltr" data-l={t('platform.p.amount')}>
                          <b>{da(p.amount)}</b>
                        </td>
                        <td data-l={t('platform.p.method')}>{t(`platform.method.${p.method}`)}</td>
                        <td data-l={t('platform.p.period')}>
                          <small>
                            {t('platform.p.monthsN', { count: p.months })} · {t('platform.untilDate', { date: dateOnly(p.periodTo) })}
                          </small>
                        </td>
                        <td data-l={t('platform.p.reference')}>
                          <small className="ltr">{p.reference ?? ''}</small>
                          {p.voidAt && <small className="pp-bad"> {t('platform.pay.voided', { reason: p.voidReason ?? '' })}</small>}
                        </td>
                        <td data-l={t('platform.p.by')}>
                          <small>{p.by ?? ''}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
