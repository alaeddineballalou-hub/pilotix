// « Créer ma boutique »: a shop by its owner, on a free trial (the platform's plan and days). The owner is logged in at
// once; a welcome e-mail brings the link that confirms the e-mail.
import { FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { signup, SignupInfo } from '../lib/backend';
import { da } from '../lib/format';
import { useSession } from '../lib/session';
import { SlugField, useSlug } from './Shops';

export function Signup({ info, onBack }: { info: SignupInfo; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const { adopt } = useSession();
  const opened = useRef(Date.now());
  const [f, setF] = useState({ shopName: '', name: '', email: '', phone: '', password: '', again: '', website: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const s = useSlug(f.shopName);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (f.password.length < 10) return setError(t('shop.signup.short'));
    if (f.password !== f.again) return setError(t('login.resetMismatch'));
    if (!s.ok) return setError(t('shop.signup.slugInvalid'));
    setBusy(true);
    try {
      const r = await signup({
        shopName: f.shopName.trim(),
        slug: s.slug,
        name: f.name.trim(),
        email: f.email.trim(),
        phone: f.phone.trim() || undefined,
        password: f.password,
        website: f.website,
        elapsed: Date.now() - opened.current,
        language: i18n.language,
      });
      adopt(r.session);
    } catch (err: any) {
      setError(err?.message || t('common.error'));
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <form className="card login-card px-signup" onSubmit={submit}>
        <span className="brand-big" role="img" aria-label="Pilotix">
          Pilotix
        </span>
        <h2 className="login-title">{t('shop.signup.title')}</h2>
        <p className="login-note">
          {t('shop.signup.trial', { count: info.trialDays })}
          {info.plan ? ` · ${t('shop.signup.plan', { plan: info.plan.name, price: da(info.plan.priceMonth) })}` : ''}
        </p>
        <label className="field">
          <span className="lab">{t('shop.signup.shopName')}</span>
          <input id="su-shop" value={f.shopName} maxLength={80} required autoFocus placeholder={t('shop.signup.shopNamePh')} onChange={(e) => set('shopName', e.target.value)} />
        </label>
        <SlugField s={s} base={info.publicUrl || location.origin} />
        <label className="field">
          <span className="lab">{t('shop.signup.name')}</span>
          <input id="su-name" value={f.name} maxLength={80} required autoComplete="name" onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field">
          <span className="lab">{t('login.email')}</span>
          <input id="su-email" type="email" dir="ltr" required autoComplete="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        </label>
        <label className="field">
          <span className="lab">{t('shop.signup.phone')}</span>
          <input id="su-phone" type="tel" dir="ltr" autoComplete="tel" value={f.phone} maxLength={20} onChange={(e) => set('phone', e.target.value)} />
        </label>
        <label className="field">
          <span className="lab">{t('login.password')}</span>
          <input id="su-pw" type="password" dir="ltr" required minLength={10} autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} />
          <span className="hint">{t('shop.signup.short')}</span>
        </label>
        <label className="field">
          <span className="lab">{t('login.resetAgain')}</span>
          <input id="su-pw2" type="password" dir="ltr" required autoComplete="new-password" value={f.again} onChange={(e) => set('again', e.target.value)} />
        </label>
        {/* robots fill every field: people never see this one */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label>
            Website
            <input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set('website', e.target.value)} />
          </label>
        </div>
        {error && <p className="form-err">{error}</p>}
        <button className="btn primary big" disabled={busy}>
          {busy ? t('shop.signup.creating') : t('shop.signup.create')}
        </button>
        <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>
          {t('shop.signup.terms')}
        </p>
        <button type="button" className="login-link" onClick={onBack}>
          {t('shop.signup.haveAccount')}
        </button>
      </form>
    </div>
  );
}
