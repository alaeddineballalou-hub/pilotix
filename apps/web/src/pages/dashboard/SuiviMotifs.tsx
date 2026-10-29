// Dashboard › Suivi › « Motifs du Suivi »: how the period's alerts ended — each « Résolu » motif with how many of those
// parcels were then delivered, each « Perdu » motif with its share of the lost parcels (which reasons lose the most).
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { Icon, Loading } from '../../ui/kit';

export function SuiviMotifStats({ range }: { range: { from: string; to: string } }) {
  const { t } = useTranslation();
  const q = useRpc('suivi.motifStats', range, { refetchInterval: 120_000 });
  const d = q.data;
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  return (
    <section className="tb-mo" aria-labelledby="tb-mo-h">
      <header>
        <h3 id="tb-mo-h">
          <Icon name="list" /> {t('dashboard.motifs.title')}
        </h3>
        <small className="muted">{t('dashboard.motifs.sub')}</small>
      </header>
      {!d ? (
        <Loading />
      ) : !d.totalResolved && !d.totalLost ? (
        <p className="muted small">{t('dashboard.motifs.empty')}</p>
      ) : (
        <div className="tb-mo-cols">
          <div className="tb-mo-side ok">
            <h4>
              <Icon name="refresh" /> {t('dashboard.motifs.resolved', { count: d.totalResolved })}
            </h4>
            <ul>
              {d.resolved.map((r) => (
                <li key={r.key}>
                  <span className="tb-mo-l">{r.label}</span>
                  <span className="tb-mo-bar" aria-hidden="true">
                    <i style={{ width: `${pct(r.count, d.totalResolved)}%` }} />
                  </span>
                  <b className="ltr">{r.count}</b>
                  <small className={`tb-mo-d ${pct(r.delivered, r.count) >= 60 ? 'good' : pct(r.delivered, r.count) >= 35 ? 'mid' : 'bad'}`}>{t('dashboard.motifs.delivered', { n: r.delivered, p: pct(r.delivered, r.count) })}</small>
                </li>
              ))}
            </ul>
          </div>
          <div className="tb-mo-side bad">
            <h4>
              <Icon name="undo" /> {t('dashboard.motifs.lost', { count: d.totalLost })}
            </h4>
            <ul>
              {d.lost.map((r) => (
                <li key={r.key}>
                  <span className="tb-mo-l">{r.label}</span>
                  <span className="tb-mo-bar" aria-hidden="true">
                    <i style={{ width: `${pct(r.count, d.totalLost)}%` }} />
                  </span>
                  <b className="ltr">{r.count}</b>
                  <small className="tb-mo-d">{t('dashboard.motifs.share', { p: pct(r.count, d.totalLost) })}</small>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {!!d?.agents.length && (
        <div className="tbl-wrap tb-mo-ag">
          <table className="tbl">
            <caption>{t('dashboard.motifs.byAgent')}</caption>
            <thead>
              <tr>
                <th>{t('dashboard.motifs.agent')}</th>
                <th className="num">{t('dashboard.motifs.colResolved')}</th>
                <th className="num">{t('dashboard.motifs.colDelivered')}</th>
                <th className="num">{t('dashboard.motifs.colLost')}</th>
                <th className="num">{t('dashboard.motifs.colEarly')}</th>
                <th>{t('dashboard.motifs.colTop')}</th>
              </tr>
            </thead>
            <tbody>
              {d.agents.map((a) => {
                const p = pct(a.delivered, a.resolved);
                return (
                  <tr key={a.id}>
                    <td data-l={t('dashboard.motifs.agent')}>
                      <b>{a.name}</b>
                    </td>
                    <td className="num" data-l={t('dashboard.motifs.colResolved')}>
                      {a.resolved}
                    </td>
                    <td className="num" data-l={t('dashboard.motifs.colDelivered')}>
                      {a.resolved ? <span className={`badge ${p >= 60 ? 't-ok' : p >= 35 ? 't-warn' : 't-bad'}`}>{`${a.delivered} · ${p} %`}</span> : '—'}
                    </td>
                    <td className="num" data-l={t('dashboard.motifs.colLost')}>
                      {a.lost}
                    </td>
                    <td className="num" data-l={t('dashboard.motifs.colEarly')}>
                      {a.early ? <span className="badge t-bad">{a.early}</span> : <span className="muted">0</span>}
                    </td>
                    <td data-l={t('dashboard.motifs.colTop')}>{a.topLost ?? <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
