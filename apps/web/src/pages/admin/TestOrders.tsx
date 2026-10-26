// "Commandes de test": fake orders (customers « TEST … », numbers 0500…, no message sent) to try the live shop,
// and one button to remove them afterwards.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { Help } from '../../ui/kit';
import { ConfirmButton } from './bits';

export function TestOrders() {
  const { t } = useTranslation();
  const [n, setN] = useState(5);
  const count = useRpc('admin.testOrders.count', {});
  const create = useAction('admin.testOrders.create', { success: (r) => t('admin.testOrders.created', { count: r.created }) });
  const del = useAction('admin.testOrders.delete', {
    success: (r) => (r.kept.length ? t('admin.testOrders.deletedKept', { count: r.deleted, refs: r.kept.join(', ') }) : t('admin.testOrders.deleted', { count: r.deleted })),
  });
  const have = count.data?.count ?? 0;
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          🧪 {t('admin.testOrders.title')}
          <Help text={t('admin.testOrders.help')} />
        </h2>
      </div>
      <p className="muted small" style={{ margin: '0 0 10px' }}>
        {t('admin.testOrders.text')}
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={n} onChange={(e) => setN(Number(e.target.value))} aria-label={t('admin.testOrders.howMany')} style={{ width: 'auto' }}>
          {[1, 5, 10, 20].map((k) => (
            <option key={k} value={k}>
              {t('admin.testOrders.option', { count: k })}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={create.isPending} onClick={() => create.mutate({ count: n })}>
          {create.isPending ? '…' : t('admin.testOrders.create')}
        </button>
        {have > 0 && (
          <>
            <a className="btn" href="#/confirmation/nouvelles">
              {t('admin.testOrders.see', { count: have })}
            </a>
            <ConfirmButton className="btn danger" question={t('admin.testOrders.deleteConfirm', { count: have })} onConfirm={() => del.mutate({})}>
              {t('admin.testOrders.delete')}
            </ConfirmButton>
          </>
        )}
      </div>
    </div>
  );
}
