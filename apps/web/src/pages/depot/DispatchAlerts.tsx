// « En dispatch », on top: what needs the depot — parcels the courier refused (« Renvoyer » / « Autre société »),
// parcels of cancelled orders to cancel by hand in the courier's space (« C'est fait »), parcels waiting over 24 h.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { rpc } from '../../lib/backend';
import { wilayaName } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import './dispatch.css';

type Alerts = Out<'depot.dispatchAlerts'>;
type Row = Alerts['refused'][number];

export function DispatchAlerts() {
  const { t } = useTranslation();
  const q = useRpc('depot.dispatchAlerts', {}, { refetchInterval: 60_000 });
  const companies = useRpc('depot.companies', {});
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const [showLate, setShowLate] = useState(false);
  const a = q.data;
  if (!a || (!a.refused.length && !a.byHand.length && !a.late.length)) return null;
  const act = async (oid: number, fn: () => Promise<unknown>, ok: string) => {
    setBusy(oid);
    try {
      await fn();
      toast(ok, 'ok');
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(null);
    }
  };
  const hours = (r: Row) => (r.since ? Math.max(0, Math.floor((Date.now() - new Date(r.since).getTime()) / 3_600_000)) : 0);
  const who = (r: Row) => (
    <span className="da-who">
      <b className="ltr">{r.ref}</b> · {r.customerName} · {wilayaName(r.wilayaId)}
    </span>
  );
  return (
    <section className="da" aria-label={t('depot.da.title')}>
      {a.refused.map((r) => (
        <div key={`r${r.id}`} className="da-row bad">
          <Icon name="alert" />
          <div className="da-txt">
            {who(r)}
            <span className="da-why">{t('depot.da.refused', { co: r.companyName ?? '', why: r.error ?? '' })}</span>
          </div>
          <div className="da-act">
            <button type="button" className="btn small" disabled={busy === r.id} onClick={() => act(r.id, () => rpc('depot.resend', { ids: [r.id] }), t('depot.da.resent', { ref: r.ref }))}>
              <Icon name="send" /> {t('depot.da.resend')}
            </button>
            <select
              aria-label={t('depot.da.other')}
              value=""
              disabled={busy === r.id}
              onChange={(e) => e.target.value && act(r.id, () => rpc('depot.dispatch', { ids: [r.id], companyId: Number(e.target.value) }), t('depot.da.moved', { ref: r.ref }))}
            >
              <option value="">{t('depot.da.other')}</option>
              {(companies.data ?? [])
                .filter((c) => c.kind !== 'own' && c.id !== r.companyId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
      ))}
      {a.byHand.map((r) => (
        <div key={`h${r.id}`} className="da-row warn">
          <Icon name="ban" />
          <div className="da-txt">
            {who(r)}
            <span className="da-why">{t('depot.da.byHand', { co: r.companyName ?? '', code: r.tracking ?? '' })}</span>
          </div>
          <div className="da-act">
            <button type="button" className="btn small" disabled={busy === r.id} onClick={() => act(r.id, () => rpc('depot.cancelDone', { id: r.id }), t('depot.da.doneOk', { ref: r.ref }))}>
              <Icon name="check" /> {t('depot.da.done')}
            </button>
          </div>
        </div>
      ))}
      {a.late.length > 0 && (
        <div className="da-row info">
          <Icon name="clock" />
          <div className="da-txt">
            <span className="da-who">{t('depot.da.late', { count: a.late.length })}</span>
            {showLate && (
              <ul className="da-late">
                {a.late.map((r) => (
                  <li key={r.id}>
                    {who(r)} — {r.companyName ?? ''} · {t('depot.da.since', { count: hours(r) })}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="da-act">
            <button type="button" className="btn small ghost" onClick={() => setShowLate(!showLate)}>
              {showLate ? t('depot.da.hide') : t('depot.da.show')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
