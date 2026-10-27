// Confirmation agencies: Pilotix checks each one before it can work with stores (« Vérifier »), and can suspend it
// (its agents stop at once in every store). The control room sees its name, code, owner and how many sellers it has.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, when } from '../../lib/format';
import { Staff, usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { can, Empty } from './bits';
import '../agency/agency.css';

export function Agencies({ staff }: { staff: Staff }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const list = usePRpc('p.agencies.list', { q }, { refetchInterval: 60_000 });
  const verify = usePAction('p.agencies.verify', { success: t('platform.ag.saved') });
  const status = usePAction('p.shops.setStatus', { success: t('platform.ag.saved') });
  const [suspend, setSuspend] = useState<{ id: number; name: string } | null>(null);
  const [reason, setReason] = useState('');
  const manager = can(staff, 'manager');
  if (list.isLoading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={() => list.refetch()} />;
  const rows = list.data!;
  const waiting = rows.filter((a) => !a.verifiedAt && a.status === 'active').length;
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.agencies')}</h1>
          <p className="muted">{t('platform.ag.sub')}</p>
        </div>
        <label className="pp-search">
          <Icon name="search" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('platform.ag.search')} aria-label={t('platform.ag.search')} />
        </label>
      </div>
      {waiting > 0 && (
        <p className="pp-preview">
          <Icon name="shield" /> {t('platform.ag.waiting', { count: waiting })}
        </p>
      )}
      <Card>
        {rows.length ? (
          <div className="agx-scroll">
            <table className="agx-table">
              <thead>
                <tr>
                  <th>{t('platform.ag.agency')}</th>
                  <th>{t('platform.ag.owner')}</th>
                  <th>{t('platform.ag.sellers')}</th>
                  <th>{t('platform.ag.check')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <b>{a.name}</b>
                      <small className="muted ltr" style={{ display: 'block' }}>
                        {a.code ?? '—'} · {t('platform.ag.since', { d: dateOnly(a.createdAt) })}
                      </small>
                    </td>
                    <td>
                      {a.owner.name}
                      <small className="muted ltr" style={{ display: 'block' }}>
                        {a.owner.email}
                        {a.owner.phone ? ` · ${a.owner.phone}` : ''}
                      </small>
                    </td>
                    <td className="ltr">
                      {t('platform.ag.links', { active: a.activeLinks, pending: a.pendingLinks })}
                      {a.lastActiveAt && <small className="muted" style={{ display: 'block' }}>{when(a.lastActiveAt)}</small>}
                    </td>
                    <td>
                      {a.status !== 'active' ? (
                        <span className="chip agx-st agx-st-bad">{t(`platform.state.${a.status}`)}</span>
                      ) : a.verifiedAt ? (
                        <span className="chip pp-chip-ok">
                          <Icon name="shield" /> {t('platform.ag.verified')}
                        </span>
                      ) : (
                        <span className="chip pp-chip-warn">{t('platform.ag.toCheck')}</span>
                      )}
                    </td>
                    <td className="agx-row-act">
                      {manager && a.status === 'active' && (
                        <button type="button" className={`btn small ${a.verifiedAt ? '' : 'primary'}`} disabled={verify.isPending} onClick={() => verify.mutate({ id: a.id, verified: !a.verifiedAt })}>
                          {a.verifiedAt ? t('platform.ag.unverify') : t('platform.ag.verify')}
                        </button>
                      )}
                      {manager &&
                        (a.status === 'suspended' ? (
                          <button type="button" className="btn small" disabled={status.isPending} onClick={() => status.mutate({ id: a.id, status: 'active' })}>
                            {t('platform.ag.reactivate')}
                          </button>
                        ) : (
                          a.status === 'active' && (
                            <button type="button" className="btn small ghost danger" onClick={() => (setReason(''), setSuspend({ id: a.id, name: a.name }))}>
                              {t('platform.ag.suspend')}
                            </button>
                          )
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{t('platform.ag.none')}</Empty>
        )}
      </Card>
      {suspend && (
        <Modal
          title={t('platform.ag.suspendTitle', { name: suspend.name })}
          onClose={() => setSuspend(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setSuspend(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn danger" disabled={status.isPending} onClick={() => status.mutate({ id: suspend.id, status: 'suspended', reason: reason.trim() || undefined }, { onSuccess: () => setSuspend(null) })}>
                {t('platform.ag.suspend')}
              </button>
            </>
          }
        >
          <p>{t('platform.ag.suspendText')}</p>
          <label className="field">
            <span className="lab">{t('platform.ag.reason')}</span>
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
        </Modal>
      )}
    </div>
  );
}
