// « Traiter » an alert, after calling the customer: « Résolu » (the delivery company — or our livreur — is asked to
// deliver again: through its API, or a message to send) or « Perdu » (after the seller's calls, or the customer said it
// himself, or « annulé trop tôt » with a reason). Always with a motif from Management › Statuts › Suivi.
import type { Order } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import i18n from '../../lib/i18n';
import { when } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { SendModal, useTarget } from './Claims';
import type { SentClaim } from './claimKit';
import type { AlertTries } from './PhoneSuivi';
import './traiter.css';

type Outcome = 'resolved' | 'lost';

export function Traiter({ o, reason, tries, own, onClose }: { o: Order; reason: string | null; tries?: AlertTries | null; own?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const motifs = useRpc('suivi.motifs', {}, { staleTime: 5 * 60_000 }).data;
  const { target, shop, api } = useTarget(o, !!own);
  const [out, setOut] = useState<Outcome | null>(null);
  const [motif, setMotif] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [relance, setRelance] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<SentClaim | null>(null);
  const list = (out && motifs ? motifs[out] : []).filter((m) => m.on);
  const chosen = list.find((m) => m.key === motif) ?? null;
  const name = (m: { fr: string; ar: string }) => (i18n.language === 'ar' && m.ar ? m.ar : m.fr);
  const short = !!tries && tries.done < tries.need;
  const early = out === 'lost' && short && !!chosen && !chosen.client;
  const ready = !!chosen && (!early || note.trim().length >= 3);
  const how = own ? 'livreur' : api ? 'api' : 'direct';

  const go = async () => {
    if (!out || !chosen) return;
    setBusy(true);
    try {
      const r = await rpc('suivi.resolve', { id: o.id, outcome: out, motif: chosen.key, date: date || null, note: note.trim() || null, early, relance: out === 'resolved' && relance });
      qc.invalidateQueries();
      if (out === 'lost') {
        toast(t('suivi.tr.lostDone', { ref: o.ref }), 'ok');
        return onClose();
      }
      if (r.claimError) toast(t('suivi.tr.claimFail', { msg: r.claimError }), 'bad');
      const c = r.claim as SentClaim | null;
      if (c && !c.extId && target) return setSent(c);
      toast(c?.extId ? t('suivi.tr.sentApi', { name: c.companyName ?? '', n: c.extRef ?? '' }) : t('suivi.tr.resolvedDone', { ref: o.ref }), 'ok');
      onClose();
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  // « Résolu » with a company without an API (or our livreur): the message to send, as in Réclamation
  if (sent && target) return <SendModal claim={sent} order={o} target={target} shop={shop} again={false} onClose={onClose} />;

  return (
    <Modal
      sheet
      title={t('suivi.tr.title', { ref: o.ref })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={out ? () => (setOut(null), setMotif('')) : onClose}>
            {out ? t('common.back') : t('common.cancel')}
          </button>
          {out && (
            <button type="button" className={`btn ${out === 'lost' ? 'danger' : 'primary'}`} disabled={!ready || busy} onClick={go}>
              {busy ? '…' : out === 'resolved' ? t('suivi.tr.okResolved') : early ? t('suivi.tries.cancelAnyway') : t('suivi.tr.okLost')}
            </button>
          )}
        </>
      }
    >
      <p className="muted small tr-who">
        {o.customerName} · <span className="ltr">{o.tracking || o.ref}</span>
        {reason ? ` · ${reason}` : ''}
      </p>
      {!out ? (
        <div className="tr-two">
          <button type="button" className="tr-out resolved" onClick={() => setOut('resolved')}>
            <Icon name="refresh" />
            <b>{t('suivi.tr.resolved')}</b>
            <small>{t('suivi.tr.resolvedHint')}</small>
          </button>
          <button type="button" className="tr-out lost" onClick={() => setOut('lost')}>
            <Icon name="undo" />
            <b>{t('suivi.tr.lost')}</b>
            <small>{t('suivi.tr.lostHint')}</small>
          </button>
        </div>
      ) : (
        <>
          <span className={`tr-badge ${out}`}>
            <Icon name={out === 'resolved' ? 'refresh' : 'undo'} /> {t(`suivi.tr.${out}`)}
          </span>
          <fieldset className="tr-motifs">
            <legend>{t('suivi.tr.motif')}</legend>
            {list.map((m) => (
              <label key={m.key} className={`tr-chip ${motif === m.key ? 'on' : ''}`}>
                <input type="radio" name="tr-motif" checked={motif === m.key} onChange={() => setMotif(m.key)} />
                {name(m)}
              </label>
            ))}
          </fieldset>
          {out === 'resolved' && (
            <label className="tr-field">
              <span>{t('suivi.tr.date')}</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          )}
          {out === 'lost' && tries && (
            <div className={`sv-tries ${short ? 'short' : 'ok'}`}>
              <span className="sv-dots" aria-hidden="true">
                {Array.from({ length: tries.need }, (_, k) => (
                  <i key={k} className={k < tries.done ? 'on' : ''} />
                ))}
              </span>
              <b>{t('suivi.tries.count', { done: tries.done, need: tries.need })}</b>
              {short && (
                <small>
                  {chosen?.client
                    ? t('suivi.tr.clientOk')
                    : tries.nextAt
                      ? t('suivi.tries.nextAt', { count: tries.need - tries.done, at: when(tries.nextAt) })
                      : t('suivi.tries.left', { count: tries.need - tries.done })}
                </small>
              )}
            </div>
          )}
          <label className="tr-field">
            <span>{early ? t('suivi.tries.whyLabel') : t('suivi.tr.note')}</span>
            <textarea rows={2} maxLength={1000} value={note} placeholder={early ? t('suivi.tries.whyPh') : ''} onChange={(e) => setNote(e.target.value)} />
            {early && <small className="muted">{t('suivi.tries.earlyNote')}</small>}
          </label>
          {out === 'resolved' && o.companyId && (
            <label className="tr-relance">
              <input type="checkbox" checked={relance} onChange={(e) => setRelance(e.target.checked)} />
              <span>
                <b>{t(`suivi.tr.relance_${how}`, { name: target?.name ?? o.companyName ?? '' })}</b>
                <small>{t(`suivi.tr.relanceHint_${how}`)}</small>
              </span>
            </label>
          )}
        </>
      )}
    </Modal>
  );
}
