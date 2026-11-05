// Sauvegardes › Copie hors du serveur: the nightly backup, encrypted here with the owner's passphrase, sent to a
// private Backblaze B2 bucket (apps/server/src/offsite.ts). The keys and the passphrase are typed once, never shown
// again (kept sealed); managers can test and send now.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { shortWhen } from '../../lib/format';
import { OffsiteStatus, offsiteSave, offsiteSend, offsiteStatus, offsiteTest } from '../../lib/platform';
import { Card, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { bytes } from './Health';

export function OffsiteBox({ owner }: { owner: boolean }) {
  const { t } = useTranslation();
  const K = 'platform.offsite.';
  const qc = useQueryClient();
  const q = useQuery<OffsiteStatus, Error>({ queryKey: ['p', 'offsite'], queryFn: offsiteStatus });
  const [f, setF] = useState({ bucket: '', keyId: '', key: '', passphrase: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setF((x) => ({ ...x, bucket: q.data.bucket }));
  }, [q.data]);
  const s = q.data;
  const run = async (fn: () => Promise<OffsiteStatus>, ok: string) => {
    setBusy(true);
    try {
      qc.setQueryData(['p', 'offsite'], await fn());
      toast(ok, 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t(K + 'title')} help={t(K + 'help')}>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !s ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="dr-cf">
          <div className={`dr-cf-lock ${s.configured && !s.lastError ? '' : 'warn'}`}>
            <span className="dr-cf-lock-i" aria-hidden="true">
              <Icon name={s.configured ? 'lock' : 'archive'} />
            </span>
            <div>
              <b>{s.configured ? (s.sent ? t(K + 'isSent') : t(K + 'isOn')) : t(K + 'isOff')}</b>
              {s.lastAt && <small>{t(K + 'last', { when: shortWhen(s.lastAt), file: s.lastFile ?? '', size: bytes(s.lastBytes ?? 0) })}</small>}
              {s.lastError && <small className="form-err">{s.lastError}</small>}
            </div>
          </div>
          {owner ? (
            <form
              className="dr-cf-f"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => offsiteSave({ bucket: f.bucket.trim(), keyId: f.keyId.trim() || undefined, key: f.key.trim() || undefined, passphrase: f.passphrase || undefined }), t('platform.saved')).then(() =>
                  setF((x) => ({ ...x, keyId: '', key: '', passphrase: '' })),
                );
              }}
            >
              <ol className="dr-cf-steps">
                <li>{t(K + 's1')}</li>
                <li>{t(K + 's2')}</li>
                <li>{t(K + 's3')}</li>
              </ol>
              <div className="grid2">
                <Field label={t(K + 'bucket')}>
                  <input className="ltr" value={f.bucket} maxLength={50} autoComplete="off" onChange={(e) => setF({ ...f, bucket: e.target.value.replace(/[^A-Za-z0-9-]/g, '') })} />
                </Field>
                <Field label="keyID" hint={s.keyId ? t(K + 'kept', { v: s.keyId }) : undefined}>
                  <input className="ltr" value={f.keyId} maxLength={40} autoComplete="off" placeholder={s.keyId || ''} onChange={(e) => setF({ ...f, keyId: e.target.value.trim() })} />
                </Field>
                <Field label="applicationKey" hint={s.keySet ? t(K + 'keyKept') : t(K + 'keyHint')}>
                  <input className="ltr" type="password" value={f.key} maxLength={80} autoComplete="off" placeholder={s.keySet ? '••••••••' : ''} onChange={(e) => setF({ ...f, key: e.target.value })} />
                </Field>
                <Field label={t(K + 'pass')} hint={s.passphraseSet ? t(K + 'passKept') : t(K + 'passHint')}>
                  <input type="password" value={f.passphrase} maxLength={200} autoComplete="new-password" placeholder={s.passphraseSet ? '••••••••' : ''} onChange={(e) => setF({ ...f, passphrase: e.target.value })} />
                </Field>
              </div>
              <p className="muted small">{t(K + 'read')}</p>
              <div className="dr-cf-a">
                <button type="submit" className="btn primary small" disabled={busy}>
                  {busy ? '…' : t('common.save')}
                </button>
              </div>
            </form>
          ) : (
            <p className="muted">{t(K + 'ownerOnly')}</p>
          )}
          {s.configured && (
            <div className="dr-cf-a">
              <button type="button" className="btn small" disabled={busy} onClick={() => void run(offsiteTest, t(K + 'tested'))}>
                <Icon name="check" /> {t(K + 'test')}
              </button>
              <button type="button" className="btn small" disabled={busy || !s.newest} onClick={() => void run(offsiteSend, t(K + 'sentNow'))}>
                <Icon name="upload" /> {t(K + 'send')}
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
