// Confirmation agencies (and, on their own page, marketers): Pilotix checks each one before it can work with stores
// (« Vérifier »), and can suspend it (its people stop at once in every store). The control room sees its name, code,
// owner and how many sellers it has.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, when } from '../../lib/format';
import { Staff, usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { can, Empty } from './bits';
import '../agency/agency.css';

export function Agencies({ staff, kind = 'agency' }: { staff: Staff; kind?: 'agency' | 'marketer' }) {
  const { t } = useTranslation();
  /** a marketer's own words (platform.mk.*), else the agency's */
  const tk = (key: string, o?: Record<string, unknown>) => (kind === 'marketer' ? t(`platform.mk.${key}`, { ...o, defaultValue: t(`platform.ag.${key}`, o) }) : t(`platform.ag.${key}`, o));
  const [q, setQ] = useState('');
  const list = usePRpc('p.agencies.list', { q, kind }, { refetchInterval: 60_000 });
  const verify = usePAction('p.agencies.verify', { success: t('platform.ag.saved') });
  const status = usePAction('p.shops.setStatus', { success: t('platform.ag.saved') });
  const [suspend, setSuspend] = useState<{ id: number; name: string } | null>(null);
  const [pro, setPro] = useState<{ id: number; name: string; verified: boolean } | null>(null);
  const stopPro = usePAction('p.pro.stop', { success: t('platform.pro.stopped') });
  const [reason, setReason] = useState('');
  const manager = can(staff, 'manager');
  if (list.isLoading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={() => list.refetch()} />;
  const rows = list.data!;
  const waiting = rows.filter((a) => !a.verifiedAt && a.status === 'active').length;
  const proAsked = rows.filter((a) => a.pro?.askedAt && a.status === 'active').length;
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t(kind === 'marketer' ? 'platform.nav.marketers' : 'platform.nav.agencies')}</h1>
          <p className="muted">{tk('sub')}</p>
        </div>
        <label className="pp-search">
          <Icon name="search" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tk('search')} aria-label={tk('search')} />
        </label>
      </div>
      {waiting > 0 && (
        <p className="pp-preview">
          <Icon name="shield" /> {tk('waiting', { count: waiting })}
        </p>
      )}
      {kind === 'marketer' && proAsked > 0 && (
        <p className="pp-preview">
          <Icon name="medal" /> {t('platform.pro.asked', { count: proAsked })}
        </p>
      )}
      <Card>
        {rows.length ? (
          <div className="agx-scroll">
            <table className="agx-table">
              <thead>
                <tr>
                  <th>{tk('agency')}</th>
                  <th>{t('platform.ag.owner')}</th>
                  <th>{t('platform.ag.sellers')}</th>
                  <th>{t('platform.ag.check')}</th>
                  {kind === 'marketer' && <th>{t('platform.pro.col')}</th>}
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
                          <Icon name="shield" /> {tk('verified')}
                        </span>
                      ) : (
                        <span className="chip pp-chip-warn">{t('platform.ag.toCheck')}</span>
                      )}
                    </td>
                    {kind === 'marketer' && (
                      <td>
                        {a.pro?.active ? (
                          <span className="chip pp-chip-ok">
                            <Icon name="medal" /> {t('platform.pro.until', { d: dateOnly(a.pro.until) })}
                          </span>
                        ) : a.pro?.askedAt ? (
                          <span className="chip pp-chip-warn">{t('platform.pro.askedOn', { d: dateOnly(a.pro.askedAt) })}</span>
                        ) : (
                          <span className="muted small">{a.pro?.until ? t('platform.pro.ended', { d: dateOnly(a.pro.until) }) : '—'}</span>
                        )}
                        {manager && a.status === 'active' && (
                          <span className="row" style={{ gap: 6, marginTop: 6 }}>
                            <button type="button" className={`btn small ${a.pro?.askedAt ? 'primary' : ''}`} onClick={() => setPro({ id: a.id, name: a.name, verified: !!a.verifiedAt })}>
                              {a.pro?.active ? t('platform.pro.prolong') : t('platform.pro.activate')}
                            </button>
                            {(a.pro?.active || a.pro?.askedAt) && (
                              <button type="button" className="btn small ghost danger" disabled={stopPro.isPending} onClick={() => stopPro.mutate({ id: a.id })}>
                                {a.pro?.active ? t('platform.pro.stop') : t('platform.pro.refuse')}
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                    )}
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
          <Empty>{tk('none')}</Empty>
        )}
      </Card>
      {pro && <ProModal m={pro} onClose={() => setPro(null)} />}
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
          <p>{tk('suspendText')}</p>
          <label className="field">
            <span className="lab">{t('platform.ag.reason')}</span>
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
        </Modal>
      )}
    </div>
  );
}

/** « Activer Pro » / « Prolonger »: the months paid, the amount, how; the payments already made below. */
function ProModal({ m, onClose }: { m: { id: number; name: string; verified: boolean }; onClose: () => void }) {
  const { t } = useTranslation();
  const set = usePRpc('p.settings.get', {});
  const pays = usePRpc('p.pro.payments', { id: m.id });
  const [months, setMonths] = useState(1);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<'baridimob' | 'ccp' | 'cash' | 'virement' | 'autre'>('baridimob');
  const [note, setNote] = useState('');
  const go = usePAction('p.pro.activate', { success: (r) => t('platform.pro.done', { d: dateOnly(r.until) }), onDone: onClose });
  const price = set.data?.pro.price ?? 0;
  const total = amount ?? price * months;
  return (
    <Modal
      title={t('platform.pro.title', { name: m.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!m.verified || go.isPending} onClick={() => go.mutate({ id: m.id, months, amount: total, method, ...(note.trim() ? { note: note.trim() } : {}) })}>
            <Icon name="medal" /> {t('platform.pro.confirm')}
          </button>
        </>
      }
    >
      {!m.verified && <p className="form-err">{t('platform.pro.verifyFirst')}</p>}
      <p className="muted">{t('platform.pro.text')}</p>
      <div className="grid2">
        <label className="field">
          <span className="lab">{t('platform.pro.months')}</span>
          <select value={months} onChange={(e) => (setMonths(Number(e.target.value)), setAmount(null))}>
            {[1, 2, 3, 6, 12].map((n) => (
              <option key={n} value={n}>
                {t('platform.pro.nMonths', { count: n })}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lab">{t('platform.pro.amount')}</span>
          <input type="number" min={0} value={total} onChange={(e) => setAmount(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
        </label>
        <label className="field">
          <span className="lab">{t('platform.pro.method')}</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {(['baridimob', 'ccp', 'cash', 'virement', 'autre'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`platform.method.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lab">{t('platform.pro.note')}</span>
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {!!pays.data?.length && (
        <>
          <h4>{t('platform.pro.history')}</h4>
          <ul className="small">
            {pays.data.map((p) => (
              <li key={p.id}>
                {dateOnly(p.at)} · {t('platform.pro.nMonths', { count: p.months })} · <span className="ltr">{p.amount} DA</span> · {t(`platform.method.${p.method}`, { defaultValue: p.method })} → {dateOnly(p.to)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
