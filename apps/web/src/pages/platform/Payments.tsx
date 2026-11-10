// Every payment received, by month and by way of paying (BaridiMob, CCP, cash…). On top, « À vérifier »: the stores'
// « J'ai payé » (their receipt's photo), to accept (a real payment, like « Enregistrer un paiement ») or refuse (a reason).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadCsv } from '../../lib/files';
import { da, dateOnly } from '../../lib/format';
import { POut, Staff, usePAction, usePRpc } from '../../lib/platform';
import { Modal } from '../../ui/modal';
import { ErrorBox, Icon, Kpi, Kpis, Loading } from '../../ui/kit';
import { can, Empty, METHODS } from './bits';

export function Payments({ staff }: { staff: Staff }) {
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
      {can(staff, 'manager') && <ClaimsToCheck />}
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

type Claim = POut<'p.claims.list'>[number];

/** What happened to the WhatsApp message to the team. */
function WaState({ s }: { s: string | null }) {
  const { t } = useTranslation();
  if (!s) return <small className="muted">{t('platform.claims.waWait')}</small>;
  if (s === 'sent') return <small>{t('platform.claims.waSent')}</small>;
  if (s === 'off') return <small className="muted">{t('platform.claims.waOff')}</small>;
  return <small className="pp-bad">{t('platform.claims.waError', { error: s.replace(/^erreur : /, '') })}</small>;
}

/** The receipt, big (asked alone: the list never carries the photos). */
function ClaimPhoto({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const q = usePRpc('p.claims.photo', { id });
  return (
    <Modal title={t('platform.claims.photo')} onClose={onClose} wide>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data?.photo ? <img src={q.data.photo} alt={t('platform.claims.photo')} style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }} /> : <Empty>{t('platform.claims.noPhoto')}</Empty>}
    </Modal>
  );
}

/** « Refuser »: a short reason (the store sees it). */
function RefuseClaim({ c, onClose }: { c: Claim; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const refuse = usePAction('p.claims.refuse', { success: t('platform.claims.refused'), onDone: onClose });
  return (
    <Modal
      title={t('platform.claims.refuseTitle', { shop: c.shop.name })}
      onClose={onClose}
      footer={
        <button type="button" className="btn danger" disabled={reason.trim().length < 2 || refuse.isPending} onClick={() => refuse.mutate({ id: c.id, reason: reason.trim() })}>
          {t('platform.claims.refuse')}
        </button>
      }
    >
      <label className="field">
        <span className="lab">{t('platform.claims.reason')}</span>
        <input autoFocus maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('platform.claims.reasonPh')} />
        <span className="hint">{t('platform.claims.reasonHint')}</span>
      </label>
    </Modal>
  );
}

function ClaimsToCheck() {
  const { t } = useTranslation();
  const q = usePRpc('p.claims.list', { status: 'pending' });
  const [photo, setPhoto] = useState<number | null>(null);
  const [refuse, setRefuse] = useState<Claim | null>(null);
  const accept = usePAction('p.claims.accept', { success: (r) => t('platform.claims.accepted', { no: r.receiptNo, date: dateOnly(r.paidUntil) }) });
  const rows = q.data ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {t('platform.claims.title')} {rows.length > 0 && <span className="badge">{rows.length}</span>}
        </h2>
      </div>
      <p className="small muted">{t('platform.claims.help')}</p>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <Empty>{t('platform.claims.none')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl pp-tbl">
            <thead>
              <tr>
                <th>{t('platform.p.date')}</th>
                <th>{t('platform.col.shop')}</th>
                <th className="num">{t('platform.p.amount')}</th>
                <th>{t('platform.p.method')}</th>
                <th>{t('platform.p.reference')}</th>
                <th>{t('platform.claims.sentBy')}</th>
                <th>{t('platform.claims.photo')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td data-l={t('platform.p.date')}>{dateOnly(c.createdAt)}</td>
                  <td data-l={t('platform.col.shop')}>
                    <a href={`#/platform/shops/${c.shop.id}`}>{c.shop.name}</a>
                    <br />
                    <small>
                      {c.plan ?? ''} · {c.months === 12 ? t('platform.claims.year') : t('platform.claims.month')}
                    </small>
                  </td>
                  <td className="num ltr" data-l={t('platform.p.amount')}>
                    <b>{da(c.amount)}</b>
                  </td>
                  <td data-l={t('platform.p.method')}>{t(`platform.method.${c.method}`)}</td>
                  <td data-l={t('platform.p.reference')}>
                    <small className="ltr">{c.reference ?? ''}</small>
                  </td>
                  <td data-l={t('platform.claims.sentBy')}>
                    <small>{c.sentBy ?? ''}</small>
                    <br />
                    <WaState s={c.waStatus} />
                  </td>
                  <td data-l={t('platform.claims.photo')}>
                    {c.hasPhoto ? (
                      <button type="button" className="btn small" onClick={() => setPhoto(c.id)}>
                        <Icon name="image" /> {t('platform.claims.see')}
                      </button>
                    ) : (
                      <small className="muted">{t('platform.claims.noPhoto')}</small>
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={accept.isPending}
                        onClick={() => window.confirm(t('platform.claims.acceptAsk', { shop: c.shop.name, amount: da(c.amount), months: c.months })) && accept.mutate({ id: c.id })}
                      >
                        ✓ {t('platform.claims.accept')}
                      </button>
                      <button type="button" className="btn small" onClick={() => setRefuse(c)}>
                        ✗ {t('platform.claims.refuse')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {photo !== null && <ClaimPhoto id={photo} onClose={() => setPhoto(null)} />}
      {refuse && <RefuseClaim c={refuse} onClose={() => setRefuse(null)} />}
    </div>
  );
}
