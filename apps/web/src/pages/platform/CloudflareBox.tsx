// Control room › Réglages › Cloudflare (robots): the Cloudflare account Pilotix uses to keep every shop's robot check.
// Locked once connected: no « edit », no « delete ». Only the owner replaces it, by pasting a new Account ID and a new
// token; the new one is checked with Cloudflare first, so a wrong one never switches the protection off.
import type { DoctorTurnstile } from '@pilotix/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { shortWhen } from '../../lib/format';
import { turnstileSave, turnstileStatus } from '../../lib/platform';
import { Card, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';

export function CloudflareBox({ owner }: { owner: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery<DoctorTurnstile, Error>({ queryKey: ['p', 'turnstile'], queryFn: turnstileStatus });
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const ts = q.data;
  const submit = async () => {
    setBusy(true);
    try {
      await turnstileSave({ accountId: accountId.trim(), token: token.trim() });
      toast(t('doctor.cf.savedOk'), 'ok');
      setAccountId('');
      setToken('');
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ['p'] });
    } catch (e) {
      // the old connection stays as it was
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const showForm = owner && ts && (!ts.configured || open);
  return (
    <Card title={t('doctor.cf.setTitle')} help={t('doctor.cf.help')}>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !ts ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="dr-cf">
          {ts.configured ? (
            <div className="dr-cf-lock">
              <span className="dr-cf-lock-i" aria-hidden="true">
                <Icon name="lock" />
              </span>
              <div>
                <b>{t('doctor.cf.locked')}</b>
                <small>
                  {t('doctor.cf.account')} <span className="ltr">{ts.accountId}</span> · {t('doctor.cf.domainsUsed', { domains: ts.domains, max: ts.maxDomains })} · {t('doctor.cf.synced')} {ts.lastSyncAt ? shortWhen(ts.lastSyncAt) : '—'}
                </small>
                <small className="muted">{owner ? t('doctor.cf.lockedOwner') : t('doctor.cf.lockedOthers')}</small>
              </div>
              {owner && !open && (
                <button type="button" className="btn small" onClick={() => setOpen(true)}>
                  <Icon name="refresh" /> {t('doctor.cf.replace')}
                </button>
              )}
            </div>
          ) : (
            <p className="muted">{owner ? t('doctor.cf.off') : t('doctor.cf.offOthers')}</p>
          )}
          {showForm && (
            <form
              className="dr-cf-f"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              {ts.configured && <p className="dr-cf-up">{t('doctor.cf.replaceHelp')}</p>}
              <ol className="dr-cf-steps">
                <li>{t('doctor.cf.s1')}</li>
                <li>{t('doctor.cf.s2')}</li>
                <li>{t('doctor.cf.s3')}</li>
              </ol>
              <div className="grid2">
                <Field label={t('doctor.cf.accountId')} hint={t('doctor.cf.accountIdHint')}>
                  <input className="ltr" value={accountId} maxLength={40} autoComplete="off" onChange={(e) => setAccountId(e.target.value.replace(/[^0-9a-fA-F]/g, ''))} />
                </Field>
                <Field label={t('doctor.cf.token')} hint={t('doctor.cf.tokenNew')}>
                  <input className="ltr" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
                </Field>
              </div>
              <div className="dr-cf-a">
                <button type="submit" className="btn primary small" disabled={busy || accountId.length !== 32 || token.trim().length < 20}>
                  {busy ? '…' : ts.configured ? t('doctor.cf.replaceGo') : t('doctor.cf.connect')}
                </button>
                {ts.configured && (
                  <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>
                    {t('common.cancel')}
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
