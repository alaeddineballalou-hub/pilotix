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
    </section>
  );
}
