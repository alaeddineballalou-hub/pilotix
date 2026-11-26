// ZR gives its swap to its own site only, not to API keys (its « Jetons API » page, read 26 Nov 2026). When it refuses
// Pilotix's key, the swap is made in ZR › « Swaps »: what to type there, ready to copy, a link to the page, then
// « J’ai fait le swap dans ZR » — Pilotix reads the parcel at once and puts it on the order whose number was typed in ZR
// (the courier sync does it by itself too). Shared by the computer window and the phone sheet.
import type { Order } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { wilayaName } from '../../lib/format';
import { trackOf } from '../../lib/items';
import { useAction } from '../../lib/query';
import { copyText } from '../../ui/kit';
import { toast } from '../../ui/toast';

/** ZR's own « Swaps » page (its supplier space). */
export const ZR_SWAPS_URL = 'https://app.zrexpress.app/parcel-swap';

export function SwapZrSpace({ o, to, onCaught }: { o: Order; to: Order; onCaught: () => void }) {
  const { t } = useTranslation();
  const [notYet, setNotYet] = useState(false);
  const check = useAction('delivery.syncOne', {
    onDone: (r) => {
      if (r.swaps.length) {
        toast(t('suivi.swapM.zr.caught', { what: r.swaps.join(', ') }), 'ok');
        onCaught();
      } else setNotYet(true);
    },
  });
  // what ZR's « Créer un swap » asks for, in its order
  const rows = (
    [
      ['old', trackOf(o) || ''],
      ['name', to.customerName || ''],
      ['phone', to.phone || ''],
      ['phone2', to.phone2 || ''],
      ['wilaya', to.wilayaId ? wilayaName(to.wilayaId) : ''],
      ['commune', to.commune || ''],
      ['address', to.isStopdesk ? '' : to.address || ''],
      ['total', String(Math.round(to.total))],
    ] as [string, string][]
  ).filter(([, v]) => v);
  const copy = async (v: string) => {
    if (await copyText(v)) toast(t('suivi.sheet.copiedVal', { v }), 'ok');
  };
  return (
    <div className="bjsv-zr">
      <p>
        <b>{t('suivi.swapM.zr.how', { tracking: trackOf(o) || '—' })}</b>
      </p>
      {to.isStopdesk && <p className="warnbox">{t('suivi.swapM.zr.desk')}</p>}
      <div className="bjsv-sheet">
        {rows.map(([k, v]) => {
          const label = t(`suivi.swapM.zr.f.${k}`);
          return (
            <div key={k} className="bjsv-f">
              <span className="bjsv-l">{label}</span>
              <input type="text" readOnly value={v} className="ltr" aria-label={label} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn small bjsv-cp" title={t('suivi.swapM.zr.copy', { label: label.toLowerCase() })} onClick={() => copy(v)}>
                📋
              </button>
            </div>
          );
        })}
      </div>
      <div className="row bjsv-zr-go">
        <a className="btn" href={ZR_SWAPS_URL} target="_blank" rel="noopener noreferrer">
          {t('suivi.swapM.zr.open')}
        </a>
        <button
          type="button"
          className="btn primary"
          disabled={check.isPending}
          onClick={() => {
            setNotYet(false);
            check.mutate({ orderId: o.id });
          }}
        >
          {check.isPending ? t('suivi.swapM.zr.checking') : t('suivi.swapM.zr.done')}
        </button>
      </div>
      {notYet && <p className="warnbox">{t('suivi.swapM.zr.notYet', { ref: to.ref })}</p>}
      <p className="muted small">{t('suivi.swapM.zr.after', { ref: to.ref })}</p>
    </div>
  );
}
