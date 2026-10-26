// The platform's settings: free trial and grace days, how shops pay you, a message to every shop, the demo button.
import type { ShopInfo } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PayInfo } from '../../layout/ShopBanner';
import { POut, Staff, usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Field, Loading } from '../../ui/kit';

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
    payment: f.payment.text.trim() || f.payment.phone.trim() || f.payment.whatsapp.trim() ? f.payment : null,
    notice: null,
    support: null,
  };
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
        <Card title={t('platform.set.demoTitle')} help={t('platform.set.demoHelp')}>
          <label className="check">
            <input disabled={!owner} type="checkbox" checked={f.demo.public} onChange={(e) => setF({ ...f, demo: { public: e.target.checked } })} /> {t('platform.set.demoPublic')}
          </label>
          <p className="small muted">
            <a href="#/platform/demo">{t('platform.set.demoLink')}</a>
          </p>
        </Card>
        <Card title={t('platform.set.signupTitle')} help={t('platform.set.signupHelp')}>
          <label className="check">
            <input disabled={!owner} type="checkbox" checked={f.signup.open} onChange={(e) => setF({ ...f, signup: { ...f.signup, open: e.target.checked } })} /> {t('platform.set.signupOpen')}
          </label>
          <div className="grid2 pp-form">
            <Field label={t('platform.set.signupMax')}>
              <input disabled={!owner} type="number" min={1} max={50} value={f.signup.maxShopsPerEmail} onChange={(e) => setF({ ...f, signup: { ...f.signup, maxShopsPerEmail: Math.max(1, Math.min(50, Number(e.target.value) || 1)) } })} />
            </Field>
            <Field label={t('platform.set.signupPerIp')}>
              <input disabled={!owner} type="number" min={1} max={100} value={f.signup.perIpPerDay} onChange={(e) => setF({ ...f, signup: { ...f.signup, perIpPerDay: Math.max(1, Math.min(100, Number(e.target.value) || 1)) } })} />
            </Field>
          </div>
          <p className="small muted">{t('platform.set.signupLink', { url: `${location.origin}/#/inscription` })}</p>
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
