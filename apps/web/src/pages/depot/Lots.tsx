// Lots (Management › Stock › « Lots et dates d'expiration »): what is left of each lot, the lot to send first per
// product and depot (it expires first: the stock leaving takes it first), and the lots past their date or close to it.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, n } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Filters } from '../ai/agent';
import { DepotSelect, nameOf, Toolbar } from './stockui';

type F = 'all' | 'expired' | 'soon';

export function Lots() {
  const { t } = useTranslation();
  const [wh, setWh] = useState('');
  const [f, setF] = useState<F>('all');
  const q = useRpc('stock.batches', { warehouseId: wh ? Number(wh) : undefined, filter: 'all' });
  const all = q.data?.rows ?? [];
  const list = all.filter((r) => f === 'all' || r.status === f);
  return (
    <section className="card pd-card">
      <Toolbar action={<DepotSelect value={wh} onChange={setWh} all={t('produits.ui.allDepots')} label={t('produits.stock.depot')} />}>
        <Filters<F>
          value={f}
          onChange={setF}
          label={t('produits.lots.filters')}
          items={[
            { value: 'all', label: t('produits.lots.fAll'), count: all.length },
            { value: 'expired', label: t('produits.lots.expired'), count: all.filter((r) => r.status === 'expired').length, alert: true },
            { value: 'soon', label: t('produits.lots.soon', { count: q.data?.warnDays ?? 30 }), count: all.filter((r) => r.status === 'soon').length },
          ]}
        />
      </Toolbar>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !list.length ? (
        <div className="ai-empty pd-allgood">
          <Icon name="checkcircle" />
          <p>{all.length ? t('produits.lots.noneHere') : t('produits.lots.none')}</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl pd-fc">
            <thead>
              <tr>
                <th>{t('produits.fc.product')}</th>
                <th>{t('produits.lots.lot')}</th>
                <th>{t('produits.stock.depot')}</th>
                <th>{t('produits.lots.expires')}</th>
                <th className="num">{t('produits.lots.left')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="wide">
                    <b>{nameOf(r)}</b>
                    {r.first && <span className="pd-first">{t('produits.lots.first')}</span>}
                    <small className="pd-fc-sub ltr">{r.sku}</small>
                  </td>
                  <td className="ltr">
                    {r.lot}
                    {r.purchaseRef && r.purchaseRef !== r.lot && <small className="pd-fc-sub">{r.purchaseRef}</small>}
                  </td>
                  <td>{r.warehouseName}</td>
                  <td>
                    {r.expiresOn ? (
                      <>
                        <span className={`pd-lots-st ${r.status}`}>
                          {r.status === 'expired' ? t('produits.lots.since', { count: -(r.daysLeft ?? 0) }) : r.daysLeft === 0 ? t('produits.lots.today') : t('produits.fc.inDays', { count: r.daysLeft ?? 0 })}
                        </span>
                        <small className="pd-fc-sub">{dateOnly(r.expiresOn)}</small>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num ltr">
                    <b>{n(r.qty)}</b>
                    <small className="pd-fc-sub">/ {n(r.received)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="pd-note">{t('produits.lots.help')}</p>
    </section>
  );
}
