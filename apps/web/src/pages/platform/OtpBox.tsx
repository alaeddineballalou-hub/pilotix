// Control room › Réglages › Code WhatsApp: every account has its own phone number (one number = one account). Turned
// on, a 6-digit code sent by Pilotix's WhatsApp number proves it at the next login. The owner sets the number's ID, a
// permanent token (never shown again), the approved « Authentication » template; managers can send a test.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { shortWhen } from '../../lib/format';
import { OtpStatus, otpSave, otpStatus, otpTest } from '../../lib/platform';
import { Card, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';

export function OtpBox({ owner, manager }: { owner: boolean; manager: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery<OtpStatus, Error>({ queryKey: ['p', 'otp'], queryFn: otpStatus });
  const [f, setF] = useState({ on: false, phoneId: '', token: '', template: '', lang: 'fr', button: true });
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setF({ on: q.data.wanted, phoneId: q.data.phoneId, token: '', template: q.data.template, lang: q.data.lang, button: q.data.button });
  }, [q.data]);
  const s = q.data;
  const run = async (fn: () => Promise<OtpStatus>, ok: string) => {
    setBusy(true);
    try {
      qc.setQueryData(['p', 'otp'], await fn());
      toast(ok, 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('platform.otp.title')} help={t('platform.otp.help')}>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !s ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="dr-cf">
          <div className="dr-cf-lock">
            <span className="dr-cf-lock-i" aria-hidden="true">
              <Icon name={s.on ? 'lock' : 'phone'} />
            </span>
            <div>
              <b>{s.on ? t('platform.otp.isOn') : t('platform.otp.isOff')}</b>
              <small>{t('platform.otp.counts', { accounts: s.accounts, withPhone: s.withPhone, verified: s.verified })}</small>
              {s.lastSentAt && <small className="muted">{t('platform.otp.lastSent', { when: shortWhen(s.lastSentAt) })}</small>}
              {s.lastError && <small className="form-err">{s.lastError}</small>}
            </div>
          </div>
          {owner ? (
            <form
              className="dr-cf-f"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => otpSave({ ...f, token: f.token.trim() || undefined }), t('platform.saved'));
              }}
            >
              <ol className="dr-cf-steps">
                <li>{t('platform.otp.s1')}</li>
                <li>{t('platform.otp.s2')}</li>
                <li>{t('platform.otp.s3')}</li>
              </ol>
              <div className="grid2">
                <Field label={t('platform.otp.phoneId')} hint={t('platform.otp.phoneIdHint')}>
                  <input className="ltr" inputMode="numeric" value={f.phoneId} maxLength={25} autoComplete="off" onChange={(e) => setF({ ...f, phoneId: e.target.value.replace(/\D/g, '') })} />
                </Field>
                <Field label={t('platform.otp.token')} hint={s.tokenSet ? t('platform.otp.tokenKept') : t('platform.otp.tokenHint')}>
                  <input className="ltr" type="password" autoComplete="off" value={f.token} placeholder={s.tokenSet ? '••••••••' : ''} onChange={(e) => setF({ ...f, token: e.target.value })} />
                </Field>
                <Field label={t('platform.otp.template')} hint={t('platform.otp.templateHint')}>
                  <input className="ltr" value={f.template} maxLength={120} autoComplete="off" onChange={(e) => setF({ ...f, template: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
                </Field>
                <Field label={t('platform.otp.lang')} hint={t('platform.otp.langHint')}>
                  <input className="ltr" value={f.lang} maxLength={12} autoComplete="off" onChange={(e) => setF({ ...f, lang: e.target.value.trim() })} />
                </Field>
              </div>
              <label className="check">
                <input type="checkbox" checked={f.button} onChange={(e) => setF({ ...f, button: e.target.checked })} /> {t('platform.otp.button')}
              </label>
              <label className="check">
                <input type="checkbox" checked={f.on} onChange={(e) => setF({ ...f, on: e.target.checked })} /> <b>{t('platform.otp.turnOn')}</b>
              </label>
              <p className="muted small">{t('platform.otp.onNote')}</p>
              <div className="dr-cf-a">
                <button type="submit" className="btn primary small" disabled={busy}>
                  {busy ? '…' : t('common.save')}
                </button>
              </div>
            </form>
          ) : (
            <p className="muted">{t('platform.otp.ownerOnly')}</p>
          )}
          {(owner || manager) && s.ready && (
            <form
              className="dr-cf-a"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => otpTest(testTo.trim()), t('platform.otp.testSent'));
              }}
            >
              <input className="ltr" inputMode="tel" value={testTo} placeholder="0555 12 34 56" maxLength={30} onChange={(e) => setTestTo(e.target.value)} />
              <button type="submit" className="btn small" disabled={busy || testTo.trim().length < 9}>
                <Icon name="phone" /> {t('platform.otp.test')}
              </button>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
