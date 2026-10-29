// Dashboard › Suivi › « Motifs du Suivi »: how the period's alerts ended — each « Résolu » motif with how many of those
// parcels were then delivered, each « Perdu » motif with its share of the lost parcels (which reasons lose the most).
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { when } from '../../lib/format';
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

/** Dashboard › Suivi: per delivery company (and our livreurs), the open claims, those without an answer after 48 h, and those at the manager. */
export function ClaimsLateCard() {
  const { t } = useTranslation();
  const q = useRpc('suivi.claimsLate', {}, { refetchInterval: 120_000 });
  const rows = q.data ?? [];
  return (
    <section className="tb-mo" aria-labelledby="tb-cl-h">
      <header>
        <h3 id="tb-cl-h">
          <Icon name="copy" /> {t('dashboard.claimsLate.title')}
        </h3>
        <small className="muted">{t('dashboard.claimsLate.sub')}</small>
      </header>
      {!q.data ? (
        <Loading />
      ) : !rows.length ? (
        <p className="muted small">{t('dashboard.claimsLate.none')}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('dashboard.claimsLate.company')}</th>
                <th className="num">{t('dashboard.claimsLate.open')}</th>
                <th className="num">{t('dashboard.claimsLate.late')}</th>
                <th className="num">{t('dashboard.claimsLate.manager')}</th>
                <th>{t('dashboard.claimsLate.oldest')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td data-l={t('dashboard.claimsLate.company')}>
                    <b>{r.name}</b>
                  </td>
                  <td className="num" data-l={t('dashboard.claimsLate.open')}>
                    {r.open}
                  </td>
                  <td className="num" data-l={t('dashboard.claimsLate.late')}>
                    {r.late ? <span className="badge t-warn">{r.late}</span> : <span className="muted">0</span>}
                  </td>
                  <td className="num" data-l={t('dashboard.claimsLate.manager')}>
                    {r.manager ? <span className="badge t-bad">{r.manager}</span> : <span className="muted">0</span>}
                  </td>
                  <td data-l={t('dashboard.claimsLate.oldest')}>{r.oldest ? when(r.oldest) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
