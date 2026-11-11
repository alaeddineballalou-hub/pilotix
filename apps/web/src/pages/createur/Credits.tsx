// Espace créateur: the credits left (top of the page) and « Acheter des crédits »: a pack, the way it was paid, a
// reference and the receipt's photo. Pilotix's team checks it (control room › Paiements › À vérifier), then the
// credits arrive. The price is the server's.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PayClaimPhoto } from './PayPhoto';
import { da, dateOnly } from '../../lib/format';
import { Out } from '../../lib/backend';
import { useAction } from '../../lib/query';
import { Field, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';

export type CrState = Out<'createur.state'>;
const K = 'createur.cr.';
const METHODS = ['baridimob', 'ccp', 'virement'] as const;

export function CreditPill({ s, onBuy }: { s: CrState; onBuy: () => void }) {
  const { t } = useTranslation();
  if (s.preview) return <span className="cr-pill">⚡ {t(K + 'preview')}</span>;
  const w = s.wallet;
  if (!w) return null;
  return (
    <span className="cr-pill" title={w.allowance < 0 ? '' : t(K + 'month', { used: w.used, of: w.allowance, bonus: w.bonus })}>
      ⚡ <b className="ltr">{w.left < 0 ? '∞' : w.left}</b> {t(K + 'credits')}
      {s.canBuy && s.packs.length > 0 && (
        <button type="button" className="btn small primary" onClick={onBuy}>
          {t(K + 'buy')}
        </button>
      )}
    </span>
  );
}

export function BuyCredits({ s, onClose }: { s: CrState; onClose: () => void }) {
  const { t } = useTranslation();
  const [pack, setPack] = useState(s.packs.find((p) => p.best)?.key ?? s.packs[0]?.key ?? '');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('baridimob');
  const [reference, setReference] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const buy = useAction('createur.buy', { success: t(K + 'sent'), onDone: onClose });
  const wait = s.claim?.status === 'pending';
  const minutes = (credits: number) => {
    const w = s.tools.find((x) => x.key === 'subtitles');
    return w && w.credits > 0 ? Math.floor(credits / w.credits) : null;
  };
  return (
    <Modal
      title={t(K + 'title')}
      onClose={onClose}
      footer={
        wait ? (
          <button type="button" className="btn" onClick={onClose}>
            {t(K + 'close')}
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t(K + 'cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!photo || !pack || buy.isPending}
              onClick={() => photo && buy.mutate({ pack, method, reference: reference.trim() || undefined, photo })}
            >
              <Icon name="check" /> {t(K + 'send')}
            </button>
          </>
        )
      }
    >
      {wait ? (
        <p role="status">
          <Icon name="clock" /> {t(K + 'waiting', { credits: s.claim!.credits, amount: da(s.claim!.amount), date: dateOnly(s.claim!.createdAt) })}
        </p>
      ) : (
        <div className="cr-buy">
          {s.claim?.status === 'refused' && <p className="form-err">{t(K + 'refused', { reason: s.claim.reason ?? '' })}</p>}
          <div className="cr-packs" role="radiogroup" aria-label={t(K + 'title')}>
            {s.packs.map((p) => (
              <label key={p.key} className={`cr-pack${pack === p.key ? ' on' : ''}`}>
                <input type="radio" name="cr-pack" checked={pack === p.key} onChange={() => setPack(p.key)} />
                {p.best && <span className="cr-best">{t(K + 'best')}</span>}
                <b>{p.name}</b>
                <span className="cr-pack-n">
                  <b className="ltr">{p.credits}</b> {t(K + 'credits')}
                </span>
                {minutes(p.credits) !== null && <small>{t(K + 'minutes', { n: minutes(p.credits) })}</small>}
                <span className="cr-pack-price ltr">{da(p.price)}</span>
              </label>
            ))}
          </div>
          <p className="small muted">{t(K + 'help')}</p>
          <div className="grid2">
            <Field label={t('shop.claim.method')}>
              <select value={method} onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`shop.claim.m_${m}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('shop.claim.reference')} hint={t('shop.claim.referenceHint')}>
              <input dir="ltr" maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
          <PayClaimPhoto photo={photo} onPhoto={setPhoto} />
        </div>
      )}
    </Modal>
  );
}
