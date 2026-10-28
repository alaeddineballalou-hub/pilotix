// The platform's settings: free trial and grace days, sign-ups (open, stores per person), reminders e-mailed before the
// end, the referral reward, the control room's two-step login, how shops pay you (and the receipts' header), a message to
// every shop, the terms of use and privacy page, the demo button.
import type { ShopInfo } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PayInfo } from '../../layout/ShopBanner';
import { POut, Staff, usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Field, Loading } from '../../ui/kit';
import { CloudflareBox } from './CloudflareBox';

type S = POut<'p.settings.get'>;

export function Settings({ staff }: { staff: Staff }) {
  const { t } = useTranslation();
  const q = usePRpc('p.settings.get', {});
  const plans = usePRpc('p.plans.list', {});
  const [f, setF] = useState<S | null>(null);
  useEffect(() => {
    if (q.data) setF(structuredClone(q.data));
  }, [q.data]);
  const save = usePAction('p.settings.save', { success: t('platform.saved') });
  const owner = staff.role === 'owner';
  if (q.isLoading || !f) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const dirty = JSON.stringify(f) !== JSON.stringify(q.data);
  // how a shop sees the payment details (the banner and the lock screen)
  const sample: ShopInfo = {
    id: 0,
    slug: 'ma-boutique',
    name: t('platform.set.sampleShop'),
    primary: false,
    demo: false,
    state: 'grace',
    plan: plans.data?.find((p) => p.code === f.trial.planCode)?.name ?? null,
    planPrice: plans.data?.find((p) => p.code === f.trial.planCode)?.priceMonth ?? null,
    trialEndsAt: null,
    paidUntil: null,
    daysLeft: 2,
    locked: false,
    features: null,
    maxUsers: null,
    maxDrivers: null,
    maxOrdersMonth: null,
    ordersMonth: null,
    planPriceYear: null,
    payment: f.payment.text.trim() || f.payment.phone.trim() || f.payment.whatsapp.trim() ? f.payment : null,
    notice: null,
    owner: true,
    ownerProfileId: null,
    stores: 0,
    canAddStore: false,
    supportUnread: 0,
  };
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Number(v) || 0));
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.settings')}</h1>
          <p className="muted">{t('platform.settingsSub')}</p>
        </div>
        {owner && (
          <button type="button" className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(f)}>
            {t('common.save')}
          </button>
        )}
      </div>
      <CloudflareBox owner={owner} />
      <div className="pp-grid">
        <Card title={t('platform.set.trialTitle')} help={t('platform.set.trialHelp')}>
          <div className="grid2 pp-form">
            <Field label={t('platform.set.trialDays')}>
              <input disabled={!owner} type="number" min={0} max={90} value={f.trial.days} onChange={(e) => setF({ ...f, trial: { ...f.trial, days: Math.max(0, Math.min(90, Number(e.target.value) || 0)) } })} />
            </Field>
            <Field label={t('platform.set.graceDays')} hint={t('platform.set.graceHint')}>
              <input disabled={!owner} type="number" min={0} max={30} value={f.trial.graceDays} onChange={(e) => setF({ ...f, trial: { ...f.trial, graceDays: Math.max(0, Math.min(30, Number(e.target.value) || 0)) } })} />
            </Field>
            <Field label={t('platform.set.defaultPlan')}>
              <select disabled={!owner} value={f.trial.planCode} onChange={(e) => setF({ ...f, trial: { ...f.trial, planCode: e.target.value } })}>
                {(plans.data ?? [])
                  .filter((p) => !p.system && p.active)
                  .map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        </Card>
        <Card title={t('platform.set.signupTitle')} help={t('platform.set.signupHelp')}>
          <label className="check">
            <input disabled={!owner} type="checkbox" checked={f.signup.open} onChange={(e) => setF({ ...f, signup: { ...f.signup, open: e.target.checked } })} /> {t('platform.set.signupOpen')}
          </label>
          <Field label={t('platform.set.maxStores')} hint={t('platform.set.maxStoresHint')}>
            <input disabled={!owner} type="number" min={1} max={100} value={f.signup.maxStores} onChange={(e) => setF({ ...f, signup: { ...f.signup, maxStores: num(e.target.value, 1, 100) } })} />
          </Field>
          <p className="small muted">
            <a href="#/inscription" target="_blank" rel="noreferrer">
              {t('platform.set.signupLink')}
            </a>
          </p>
        </Card>
        <Card title={t('platform.set.remindTitle')} help={t('platform.set.remindHelp')}>
          <label className="check">
            <input disabled={!owner} type="checkbox" checked={f.reminders.on} onChange={(e) => setF({ ...f, reminders: { ...f.reminders, on: e.target.checked } })} /> {t('platform.set.remindOn')}
          </label>
          <Field label={t('platform.set.remindDays')}>
            <input disabled={!owner} type="number" min={1} max={30} value={f.reminders.daysBefore} onChange={(e) => setF({ ...f, reminders: { ...f.reminders, daysBefore: num(e.target.value, 1, 30) } })} />
          </Field>
        </Card>
        <Card title={t('platform.set.refTitle')} help={t('platform.set.refHelp')}>
          <label className="check">
            <input disabled={!owner} type="checkbox" checked={f.referral.on} onChange={(e) => setF({ ...f, referral: { ...f.referral, on: e.target.checked } })} /> {t('platform.set.refOn')}
          </label>
          <Field label={t('platform.set.refMonths')}>
            <input disabled={!owner} type="number" min={0} max={12} value={f.referral.months} onChange={(e) => setF({ ...f, referral: { ...f.referral, months: num(e.target.value, 0, 12) } })} />
          </Field>
        </Card>
        <Card title={t('platform.set.secTitle')} help={t('platform.set.secHelp')}>
          <label className="check">
            <input disabled={!owner} type="checkbox" checked={f.security.twoStep} onChange={(e) => setF({ ...f, security: { twoStep: e.target.checked } })} /> {t('platform.set.secTwoStep')}
          </label>
        </Card>
        <Card title={t('platform.set.socialTitle')} help={t('platform.set.socialHelp')}>
          <div className="pp-form">
            <Field label={t('platform.set.socialGoogle')} hint={t('platform.set.socialGoogleHint', { site: location.origin })}>
              <input disabled={!owner} dir="ltr" maxLength={200} value={f.social?.googleClientId ?? ''} onChange={(e) => setF({ ...f, social: { googleClientId: e.target.value.trim(), facebookAppId: f.social?.facebookAppId ?? '' } })} placeholder="1234567890-abc.apps.googleusercontent.com" />
            </Field>
            <Field label={t('platform.set.socialFacebook')} hint={t('platform.set.socialFacebookHint', { site: location.origin })}>
              <input disabled={!owner} dir="ltr" inputMode="numeric" maxLength={30} value={f.social?.facebookAppId ?? ''} onChange={(e) => setF({ ...f, social: { googleClientId: f.social?.googleClientId ?? '', facebookAppId: e.target.value.replace(/\D/g, '') } })} placeholder="123456789012345" />
            </Field>
          </div>
        </Card>
        <Card title={t('platform.set.demoTitle')} help={t('platform.set.demoHelp')}>
          <label className="check">
            <input disabled={!owner} type="checkbox" checked={f.demo.public} onChange={(e) => setF({ ...f, demo: { public: e.target.checked } })} /> {t('platform.set.demoPublic')}
          </label>
          <p className="small muted">
            <a href="#/platform/demo">{t('platform.set.demoLink')}</a>
          </p>
        </Card>
      </div>
      <Card title={t('platform.set.payTitle')} help={t('platform.set.payHelp')}>
        <div className="pp-pay-edit">
          <div className="pp-form">
            <Field label={t('platform.set.payText')} hint={t('platform.set.payTextHint')}>
              <textarea disabled={!owner} rows={6} maxLength={1500} value={f.payment.text} onChange={(e) => setF({ ...f, payment: { ...f.payment, text: e.target.value } })} placeholder={t('platform.set.payTextPh')} />
            </Field>
            <div className="grid2">
              <Field label={t('platform.set.payPhone')}>
                <input disabled={!owner} dir="ltr" maxLength={40} value={f.payment.phone} onChange={(e) => setF({ ...f, payment: { ...f.payment, phone: e.target.value } })} placeholder="0550 12 34 56" />
              </Field>
              <Field label={t('platform.set.payWa')} hint={t('platform.set.payWaHint')}>
                <input disabled={!owner} dir="ltr" maxLength={40} value={f.payment.whatsapp} onChange={(e) => setF({ ...f, payment: { ...f.payment, whatsapp: e.target.value } })} placeholder="0550 12 34 56" />
              </Field>
            </div>
          </div>
          <div className="pp-pay-prev">
            <span className="lab">{t('platform.set.preview')}</span>
            <PayInfo shop={sample} />
          </div>
        </div>
      </Card>
      <Card title={t('platform.set.companyTitle')} help={t('platform.set.companyHelp')}>
        <div className="grid2 pp-form">
          <Field label={t('platform.set.coName')}>
            <input disabled={!owner} maxLength={120} value={f.company.name} onChange={(e) => setF({ ...f, company: { ...f.company, name: e.target.value } })} />
          </Field>
          <Field label={t('platform.set.coTax')}>
            <input disabled={!owner} dir="ltr" maxLength={80} value={f.company.taxId} onChange={(e) => setF({ ...f, company: { ...f.company, taxId: e.target.value } })} />
          </Field>
          <Field label={t('platform.set.coAddress')} wide>
            <input disabled={!owner} maxLength={300} value={f.company.address} onChange={(e) => setF({ ...f, company: { ...f.company, address: e.target.value } })} />
          </Field>
          <Field label={t('platform.set.payPhone')}>
            <input disabled={!owner} dir="ltr" maxLength={40} value={f.company.phone} onChange={(e) => setF({ ...f, company: { ...f.company, phone: e.target.value } })} />
          </Field>
          <Field label={t('login.email')}>
            <input disabled={!owner} dir="ltr" maxLength={200} value={f.company.email} onChange={(e) => setF({ ...f, company: { ...f.company, email: e.target.value } })} />
          </Field>
        </div>
      </Card>
      <Card title={t('platform.set.legalTitle')} help={t('platform.set.legalHelp')}>
        <Field label={t('platform.set.legalText')} hint={t('platform.set.legalHint')}>
          <textarea disabled={!owner} rows={8} maxLength={30000} value={f.legal.text} onChange={(e) => setF({ ...f, legal: { text: e.target.value } })} placeholder={t('platform.set.legalPh')} />
        </Field>
        <p className="small muted">
          <a href="#/conditions" target="_blank" rel="noreferrer">
            {t('platform.set.legalLink')}
          </a>
        </p>
      </Card>
      <Card title={t('platform.set.noticeTitle')} help={t('platform.set.noticeHelp')}>
        <div className="pp-form">
          <Field label={t('platform.set.noticeText')}>
            <textarea disabled={!owner} rows={2} maxLength={400} value={f.notice.text} onChange={(e) => setF({ ...f, notice: { ...f.notice, text: e.target.value } })} placeholder={t('platform.set.noticePh')} />
          </Field>
          <div className="grid2">
            <Field label={t('platform.set.noticeTone')}>
              <select disabled={!owner} value={f.notice.tone} onChange={(e) => setF({ ...f, notice: { ...f.notice, tone: e.target.value as 'info' | 'warn' } })}>
                <option value="info">{t('platform.set.toneInfo')}</option>
                <option value="warn">{t('platform.set.toneWarn')}</option>
              </select>
            </Field>
            <Field label={t('platform.set.noticeUntil')} hint={t('platform.set.noticeUntilHint')}>
              <input disabled={!owner} type="date" value={f.notice.until ? f.notice.until.slice(0, 10) : ''} onChange={(e) => setF({ ...f, notice: { ...f.notice, until: e.target.value ? new Date(`${e.target.value}T23:00:00Z`).toISOString() : null } })} />
            </Field>
          </div>
          {f.notice.text.trim() && <div className={`px-ban ${f.notice.tone === 'warn' ? 'px-ban-warn' : 'px-ban-info'}`}>{f.notice.text}</div>}
        </div>
      </Card>
    </div>
  );
}
