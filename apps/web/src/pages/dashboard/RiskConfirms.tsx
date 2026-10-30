// Dashboard › Confirmation › « Clients risqués confirmés »: each agent's orders confirmed while the customer was
// « Risqué » (the warning said so and they pressed « Confirmer quand même »), and what became of those parcels — with the
// return rate of every parcel confirmed in the same period, to see whether these choices cost more.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { Icon, Loading } from '../../ui/kit';

const rate = (returned: number, delivered: number) => (returned + delivered ? Math.round((returned / (returned + delivered)) * 100) : null);

export function RiskConfirmStats({ range }: { range: { from: string; to: string } }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.riskStats', range, { refetchInterval: 120_000 });
  const d = q.data;
  const base = d ? rate(d.baseline.returned, d.baseline.delivered) : null;
  /** worse than usual by 10 points: red; worse: orange; as good or better: green */
  const tone = (p: number | null) => (p === null || base === null ? '' : p >= base + 10 ? 't-bad' : p > base ? 't-warn' : 't-ok');
  const cell = (p: number | null) => (p === null ? <span className="muted">—</span> : <span className={`badge ${tone(p)}`}>{p} %</span>);
  return (
    <section className="tb-mo tb-rk" aria-labelledby="tb-rk-h">
      <header>
        <h3 id="tb-rk-h">
          <Icon name="alert" /> {t('dashboard.risk.title')}
        </h3>
        <small className="muted">{t('dashboard.risk.sub')}</small>
      </header>
      {!d ? (
        <Loading />
      ) : !d.total.n ? (
        <p className="muted small">{t('dashboard.risk.empty')}</p>
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('dashboard.risk.agent')}</th>
                  <th className="num">{t('dashboard.risk.n')}</th>
                  <th className="num">{t('dashboard.risk.delivered')}</th>
                  <th className="num">{t('dashboard.risk.returned')}</th>
                  <th className="num">{t('dashboard.risk.cancelled')}</th>
                  <th className="num">{t('dashboard.risk.open')}</th>
                  <th className="num">{t('dashboard.risk.rate')}</th>
                </tr>
              </thead>
              <tbody>
                {d.agents.map((a) => (
                  <tr key={a.id ?? 'auto'}>
                    <td data-l={t('dashboard.risk.agent')}>
                      <b>{a.name ?? t('dashboard.risk.auto')}</b>
                      <small className="muted">{t('dashboard.risk.avg', { n: a.score })}</small>
                    </td>
                    <td className="num" data-l={t('dashboard.risk.n')}>
                      <b>{a.n}</b>
                    </td>
                    <td className="num" data-l={t('dashboard.risk.delivered')}>
                      {a.delivered}
                    </td>
                    <td className="num" data-l={t('dashboard.risk.returned')}>
                      {a.returned ? <b className="tb-rk-bad">{a.returned}</b> : <span className="muted">0</span>}
                    </td>
                    <td className="num" data-l={t('dashboard.risk.cancelled')}>
                      {a.cancelled}
                    </td>
                    <td className="num" data-l={t('dashboard.risk.open')}>
                      {a.open}
                    </td>
                    <td className="num" data-l={t('dashboard.risk.rate')}>
                      {cell(rate(a.returned, a.delivered))}
                    </td>
                  </tr>
                ))}
              </tbody>
              {d.agents.length > 1 && (
                <tfoot>
                  <tr>
                    <th scope="row">{t('dashboard.risk.total')}</th>
                    <td className="num">
                      <b>{d.total.n}</b>
                    </td>
                    <td className="num">{d.total.delivered}</td>
                    <td className="num">{d.total.returned}</td>
                    <td className="num">{d.total.cancelled}</td>
                    <td className="num">{d.total.open}</td>
                    <td className="num">{cell(rate(d.total.returned, d.total.delivered))}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="muted small tb-rk-base">
            {base === null
              ? t('dashboard.risk.baseNone')
              : t('dashboard.risk.base', { p: base, r: d.baseline.returned, f: d.baseline.returned + d.baseline.delivered })}
          </p>
        </>
      )}
    </section>
  );
}
