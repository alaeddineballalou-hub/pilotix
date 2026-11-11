// « J'ai payé » in the pay window (banners, lock screen): the store's admin picks 1 month or 1 year, the way it paid
// (BaridiMob, CCP, virement), an optional reference and the receipt's photo (made smaller here: 1280 px at most, JPEG).
// Pilotix's team checks it in the control room; meanwhile the store sees « Paiement envoyé » (and keeps working). A
// refused one shows the reason, and the form again. The amount shown is the server's (the plan's).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateOnly } from '../lib/format';
import { useAction, useRpc } from '../lib/query';
import { Field, Icon } from '../ui/kit';

const METHODS = ['baridimob', 'ccp', 'virement'] as const;
const MAX_SIDE = 1280;
const MAX_BYTES = 900 * 1024;

/** A picture made smaller (1280 px at most on its longest side), as a JPEG data URL; null when it is not a picture. */
export async function smallJpeg(file: File): Promise<{ url: string; bytes: number } | null> {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, ko) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => ko(new Error('image'));
      i.src = src;
    });
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff'; // a PNG's see-through parts: white, not black
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.8);
    const b64 = url.slice(url.indexOf(',') + 1);
    return { url, bytes: Math.floor((b64.length * 3) / 4) };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(src);
  }
}

export function PayClaim() {
  const { t } = useTranslation();
  const q = useRpc('billing.claims', {});
  const [months, setMonths] = useState<1 | 12>(1);
  const [method, setMethod] = useState<(typeof METHODS)[number]>('baridimob');
  const [reference, setReference] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [again, setAgain] = useState(false);
  const send = useAction('billing.claim', {
    success: t('shop.claim.sent'),
    onDone: () => {
      setPhoto(null);
      setReference('');
      setAgain(false);
    },
  });
  const d = q.data;
  if (!d || d.prices.month === null) return null;
  const last = d.claims[0];
  const period = (m: number) => (m === 12 ? t('shop.claim.year') : t('shop.claim.month'));

  if (last?.status === 'pending')
    return (
      <div className="px-claim px-claim-wait" role="status">
        <p>
          <Icon name="clock" /> <b>{t('shop.claim.waitTitle')}</b>
        </p>
        <p className="small">{t('shop.claim.waitText', { date: dateOnly(last.createdAt), amount: da(last.amount), period: period(last.months) })}</p>
      </div>
    );

  const pick = async (f: File | undefined) => {
    setErr(null);
    setPhoto(null);
    if (!f) return;
    if (!f.type.startsWith('image/')) return setErr(t('shop.claim.notImage'));
    const r = await smallJpeg(f);
    if (!r) return setErr(t('shop.claim.notImage'));
    if (r.bytes > MAX_BYTES) return setErr(t('shop.claim.tooBig'));
    setPhoto(r.url);
  };
  const refused = last?.status === 'refused';
  const accepted = last?.status === 'accepted';
  // after a « validé »: a button opens the form again (to pay the next period)
  if (accepted && !again)
    return (
      <div className="px-claim px-claim-ok" role="status">
        <p className="small">
          <Icon name="check" /> {t('shop.claim.okText', { date: dateOnly(last.decidedAt ?? last.createdAt), amount: da(last.amount), period: period(last.months) })}
        </p>
        <button type="button" className="btn small" onClick={() => setAgain(true)}>
          {t('shop.claim.payAgain')}
        </button>
      </div>
    );

  return (
    <div className="px-claim">
      <h4>{t('shop.claim.title')}</h4>
      {refused && (
        <p className="form-err" role="alert">
          {t('shop.claim.refused', { date: dateOnly(last.decidedAt ?? last.createdAt), reason: last.reason ?? '' })}
        </p>
      )}
      <p className="small muted">{t('shop.claim.help')}</p>
      <div className="px-claim-periods" role="radiogroup" aria-label={t('shop.claim.period')}>
        {([1, 12] as const).map((m) => (
          <label key={m} className={`check px-claim-period${months === m ? ' on' : ''}`}>
            <input type="radio" name="px-claim-months" checked={months === m} onChange={() => setMonths(m)} /> {period(m)} : <b className="ltr">{da(m === 1 ? d.prices.month : d.prices.year)}</b>
          </label>
        ))}
      </div>
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
      <Field label={t('shop.claim.photo')} hint={t('shop.claim.photoHint')}>
        <input type="file" accept="image/*" onChange={(e) => void pick(e.target.files?.[0])} />
      </Field>
      {err && <p className="form-err">{err}</p>}
      {photo && <img className="px-claim-thumb" src={photo} alt={t('shop.claim.photo')} style={{ maxWidth: 160, maxHeight: 160, borderRadius: 8 }} />}
      <button
        type="button"
        className="btn primary"
        disabled={!photo || send.isPending}
        onClick={() => photo && send.mutate({ months, method, reference: reference.trim() || undefined, photo })}
      >
        <Icon name="check" /> {send.isPending ? t('shop.claim.sending') : t('shop.claim.send')}
      </button>
      {!photo && <p className="small muted">{t('shop.claim.needPhoto')}</p>}
    </div>
  );
}
