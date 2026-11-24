// « Annuler le swap »: a swap Pilotix made alone (the company or the livreur was to be told by hand) goes back — the
// parcel and its number return to the order it came from, and the order that had received it waits at the depot again
// for its own parcel. A swap made at the company by API (ZR) is never undone: the server says so.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { rightOn } from '../../lib/rights';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';

export function UnswapButton({ id, from, to, small = true, onDone }: { id: number; from?: string; to?: string; small?: boolean; onDone?: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!rightOn('act:suivi.swap')) return null;
  const go = async () => {
    setBusy(true);
    try {
      await rpc('suivi.unswap', { id });
      toast(t('suivi.unswap.done'), 'ok');
      setAsk(false);
      void qc.invalidateQueries();
      onDone?.();
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad', 7000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={`btn${small ? ' small' : ''} ghost danger nowrap`} disabled={busy} onClick={() => setAsk(true)}>
        ↶ {t('suivi.unswap.btn')}
      </button>
      {ask && (
        <Modal
          title={t('suivi.unswap.askT')}
          onClose={() => setAsk(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAsk(false)}>
                {t('suivi.unswap.no')}
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={go}>
                ↶ {t('suivi.unswap.yes')}
              </button>
            </>
          }
        >
          <ul className="bjsv-done">
            <li>{from ? t('suivi.unswap.fxFrom', { ref: from }) : t('suivi.unswap.fxFrom0')}</li>
            <li>{to ? t('suivi.unswap.fxTo', { ref: to }) : t('suivi.unswap.fxTo0')}</li>
          </ul>
          <p className="muted small">{t('suivi.unswap.note')}</p>
        </Modal>
      )}
    </>
  );
}
