// Pilot AI › Settings: where the shops' HD product photos live (Pilotix's Cloudflare R2 bucket, core/photostore.ts).
// The server keeps only each photo's name there and a small copy; WhatsApp, Messenger and Instagram download the photos
// from R2 by links valid for an hour. The secret is typed once and never shown again; « Tester » tries the bucket.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateTime } from '../../lib/format';
import { Card, Field, Icon } from '../../ui/kit';
import { usePilotAction, usePilotRpc } from './pilotDemo';

export function PhotoStoreCard({ manager }: { manager: boolean }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.photos.';
  const q = usePilotRpc('p.photos.store', {});
  const d = q.data;
  const [f, setF] = useState({ account: '', bucket: '', keyId: '', secret: '' });
  useEffect(() => {
    if (d) setF((x) => ({ ...x, account: d.account, bucket: d.bucket }));
  }, [d?.account, d?.bucket]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = usePilotAction('p.photos.storeSave', { success: t('platform.saved'), onDone: () => setF((x) => ({ ...x, keyId: '', secret: '' })) });
  const test = usePilotAction('p.photos.storeTest', { success: (r) => (r.lastTest?.ok ? t(k + 'tested') : t(k + 'testBad', { when: dateTime(r.lastTest?.at), error: r.lastTest?.error ?? '' })) });
  const ready = !!d?.configured && d.lastTest?.ok !== false;
  const busy = save.isPending || test.isPending;
  return (
    <Card title={t(k + 'title')} badge={d && <span className={`chip ${ready ? 'pp-chip-ok' : 'pp-chip-warn'}`}>{d.configured ? t('platform.pilot.on') : t('platform.pilot.off')}</span>}>
      <p className="small muted">{t(k + 'text')}</p>
      {!d ? (
        <p className="muted small">{q.error?.message ?? '…'}</p>
      ) : (
        <>
          {d.lastTest && (
            <p className={`small ${d.lastTest.ok ? 'pp-ok' : 'form-err'}`}>
              <Icon name={d.lastTest.ok ? 'check' : 'alert'} /> {d.lastTest.ok ? t(k + 'testOk', { when: dateTime(d.lastTest.at) }) : t(k + 'testBad', { when: dateTime(d.lastTest.at), error: d.lastTest.error ?? '' })}
            </p>
          )}
          {manager ? (
            <form
              className="pp-store"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate({ account: f.account.trim(), bucket: f.bucket.trim(), ...(f.keyId.trim() ? { keyId: f.keyId.trim() } : {}), ...(f.secret.trim() ? { secret: f.secret.trim() } : {}) });
              }}
            >
              <ol className="small muted pp-steps">
                <li>{t(k + 's1')}</li>
                <li>{t(k + 's2')}</li>
                <li>{t(k + 's3')}</li>
              </ol>
              <div className="grid2">
                <Field label={t(k + 'account')}>
                  <input className="ltr" value={f.account} maxLength={32} autoComplete="off" placeholder="a1b2c3d4e5f6…" onChange={(e) => setF({ ...f, account: e.target.value.replace(/[^a-fA-F0-9]/g, '').toLowerCase() })} />
                </Field>
                <Field label={t(k + 'bucket')}>
                  <input className="ltr" value={f.bucket} maxLength={63} autoComplete="off" placeholder="pilotix-photos" onChange={(e) => setF({ ...f, bucket: e.target.value.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() })} />
                </Field>
                <Field label="Access Key ID" hint={d.keyId ? t(k + 'kept', { v: d.keyId }) : undefined}>
                  <input className="ltr" value={f.keyId} maxLength={128} autoComplete="off" placeholder={d.keyId || ''} onChange={(e) => setF({ ...f, keyId: e.target.value.trim() })} />
                </Field>
                <Field label="Secret Access Key" hint={d.secretSet ? t(k + 'secretKept') : t(k + 'secretHint')}>
                  <input className="ltr" type="password" value={f.secret} maxLength={256} autoComplete="off" placeholder={d.secretSet ? '••••••••' : ''} onChange={(e) => setF({ ...f, secret: e.target.value })} />
                </Field>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button type="submit" className="btn primary" disabled={busy}>
                  <Icon name="check" /> {t('common.save')}
                </button>
                {d.configured && (
                  <button type="button" className="btn" disabled={busy} onClick={() => test.mutate({})}>
                    <Icon name="refresh" /> {test.isPending ? '…' : t(k + 'test')}
                  </button>
                )}
              </div>
            </form>
          ) : (
            <p className="muted small">{t(k + 'managers')}</p>
          )}
        </>
      )}
    </Card>
  );
}
