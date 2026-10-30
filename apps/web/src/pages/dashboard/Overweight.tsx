// Dashboard › Suivi › « Surpoids » : the period's parcels a company took a weight fee for, on the weight it found (only
// its weight counts, never the products') — per product, how many, the weights found, what it cost.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { da } from '../../lib/format';
import { Icon, Loading } from '../../ui/kit';

export function OverweightStats({ range }: { range: { from: string; to: string } }) {
  const { t } = useTranslation();
  const q = useRpc('delivery.overweight', range, { refetchInterval: 120_000 });
  const d = q.data;
  const kg = (a: number, b: number) => (a === b ? t('dashboard.over.kg', { n: a }) : t('dashboard.over.kgRange', { a, b }));
  return (
    <section className="tb-mo tb-ow" aria-labelledby="tb-ow-h">
      <header>
        <h3 id="tb-ow-h">
          <Icon name="package" /> {t('dashboard.over.title')}
        </h3>
        <small className="muted">{t('dashboard.over.sub')}</small>
      </header>
      {!d ? (
        <Loading />
      ) : !d.total.parcels ? (
        <p className="muted small">{t('dashboard.over.empty')}</p>
      ) : (
        <>
          <p className="tb-ow-sum">
            <b className="ltr">{da(d.total.fees)}</b>
            <span>{t('dashboard.over.sum', { count: d.total.parcels })}</span>
          </p>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('dashboard.over.product')}</th>
                  <th className="num">{t('dashboard.over.parcels')}</th>
                  <th className="num">{t('dashboard.over.weighed')}</th>
                  <th className="num">{t('dashboard.over.fees')}</th>
                </tr>
              </thead>
              <tbody>
                {d.products.map((p) => (
                  <tr key={p.productId}>
                    <td data-l={t('dashboard.over.product')}>
                      <b>{p.name}</b>
                    </td>
                    <td className="num" data-l={t('dashboard.over.parcels')}>
                      <span className="ltr">{p.parcels}</span>
                    </td>
                    <td className="num" data-l={t('dashboard.over.weighed')}>
                      <span className="ltr">{kg(p.zrMin, p.zrMax)}</span>
                    </td>
                    <td className="num" data-l={t('dashboard.over.fees')}>
                      <b className="ltr">{da(p.fees)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small tb-ow-note">{t('dashboard.over.note')}</p>
        </>
      )}
    </section>
  );
}
