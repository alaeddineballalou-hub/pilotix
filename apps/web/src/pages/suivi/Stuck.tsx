// Suivi › Bloqués: a parcel with no new status for the Préférences' days. The agent calls the company, the livreur or
// the customer, then says what he did: « Relancé », « Réclamation » (a claim « en retard », through the company's
// API when it has one, else the message to send) or « Client rappelé ». 2 days later without news: a claim by itself.
import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { SendModal, useTarget } from './Claims';
import type { SentClaim } from './claimKit';
import './traiter.css';

export type StuckInfo = { days: number; since: string; handled: string | null; autoClaimIn: number | null };
type Act = 'relance' | 'claim' | 'client';
const ACTS: { k: Act; icon: string }[] = [
  { k: 'relance', icon: 'phone' },
  { k: 'claim', icon: 'copy' },
  { k: 'client', icon: 'user' },
];

/** « Sans nouvelles · 6 j », what was done, and when the claim goes by itself. */
export function StuckChips({ s }: { s?: StuckInfo | null }) {
  const { t } = useTranslation();
  if (!s) return null;
  return (
    <>
      <span className={`sv-clock ${s.days >= 5 ? 'late' : 'soon'}`}>
        <Icon name="clock" />
        {t('suivi.stuck.days', { n: s.days })}
      </span>
      {s.handled ? (
        <span className="sv-clock ok">
          <Icon name="checkcircle" />
          {t(`suivi.stuck.done_${s.handled}`, { defaultValue: s.handled })}
        </span>
      ) : (
        s.autoClaimIn !== null && (
          <span className="sv-clock tries">
            <Icon name="copy" />
            {s.autoClaimIn === 0 ? t('suivi.stuck.autoNow') : t('suivi.stuck.autoIn', { n: s.autoClaimIn })}
          </span>
        )
      )}
    </>
  );
}

export function StuckDialog({ o, s, own, onClose, onDone }: { o: Order; s?: StuckInfo | null; own?: boolean; onClose: () => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { target, shop } = useTarget(o, !!own);
  const [act, setAct] = useState<Act | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<SentClaim | null>(null);
  const go = async () => {
    if (!act) return;
    setBusy(true);
    try {
      const r = await rpc('suivi.stuckDone', { id: o.id, action: act, note: note.trim() || null });
      qc.invalidateQueries();
      if (r.claimError) toast(t('suivi.tr.claimFail', { msg: r.claimError }), 'bad');
      const c = r.claim as SentClaim | null;
      if (c && !c.extId && target) return setSent(c);
      toast(c?.extId ? t('suivi.tr.sentApi', { name: c.companyName ?? '', n: c.extRef ?? '' }) : t('suivi.stuck.saved', { ref: o.ref }), 'ok');
      onDone?.();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  if (sent && target)
    return (
      <SendModal
        claim={sent}
        order={o}
        target={target}
        shop={shop}
        again={false}
        onClose={() => {
          onDone?.();
          onClose();
        }}
      />
    );
  return (
    <Modal
      sheet
      title={t('suivi.stuck.title', { ref: o.ref })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!act || busy} onClick={go}>
            {busy ? '…' : t('suivi.stuck.ok')}
          </button>
        </>
      }
    >
      <p className="muted small tr-who">
        {o.customerName} · <span className="ltr">{o.tracking || o.ref}</span> · {o.companyName || o.livreurName || '—'}
        {s ? ` · ${t('suivi.stuck.days', { n: s.days })}` : ''}
      </p>
      <fieldset className="tr-motifs">
        <legend>{t('suivi.stuck.what')}</legend>
        {ACTS.map((a) => (
          <label key={a.k} className={`tr-chip ${act === a.k ? 'on' : ''}`}>
            <input type="radio" name="st-act" checked={act === a.k} onChange={() => setAct(a.k)} />
            <Icon name={a.icon} />
            &nbsp;{t(`suivi.stuck.act_${a.k}`)}
          </label>
        ))}
      </fieldset>
      {act === 'claim' && <p className="pxk-info">{t('suivi.stuck.claimHint')}</p>}
      <label className="tr-field">
        <span>{t('suivi.tr.note')}</span>
        <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('suivi.stuck.notePh')} />
      </label>
    </Modal>
  );
}
