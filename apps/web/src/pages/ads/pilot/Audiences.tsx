// « Audiences »: the shop's own customers as Meta audiences. Left out of the ads: who returned a parcel, who gave a
// fake order; optional: the delivered customers, and people who look like them (a lookalike, 100 customers at least).
// No customer goes to Meta before the owner turns one on; the phones are hashed on the server (SHA-256) before they
// leave. Two more lists are Meta's own (« events »): the browsers behind fake orders and competitors, which Meta fills
// from the landing pages' events. Nothing is uploaded for them, so they are on unless the owner turns them off.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n, since } from '../../../lib/format';
import { useAction, useRpc } from '../../../lib/query';
import { ErrorBox, Icon, Loading } from '../../../ui/kit';

const ICON: Record<string, string> = { returners: 'undo', fake: 'ban', fakeorder: 'shield', competitor: 'eye', buyers: 'checkcircle', lookalike: 'users' };

export function Audiences() {
  const { t } = useTranslation();
  const q = useRpc('ads.aud.list', {});
  const save = useAction('ads.aud.save', { success: t('pilotads.aud.saved') });
  const sync = useAction('ads.aud.sync', { success: t('pilotads.aud.synced') });
  const d = q.data;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  return (
    <div className="pa-aud">
      <section className="card pa-aud-head">
        <div>
          <h2>{t('pilotads.aud.title')}</h2>
          <p className="muted">{t('pilotads.aud.sub')}</p>
        </div>
        {d.owner && (
          <button type="button" className="btn" disabled={sync.isPending || !d.list.some((a) => a.on)} onClick={() => sync.mutate({})}>
            <Icon name="refresh" /> {t('pilotads.aud.sync')}
          </button>
        )}
      </section>
      <div className="pa-aud-grid">
        {d.list.map((a) => (
          <article key={a.kind} className={`card pa-aud-card ${a.on ? 'on' : ''}`}>
            <header>
              <span className="pa-aud-ico">
                <Icon name={ICON[a.kind] ?? 'users'} />
              </span>
              <div>
                <h3>{t(`pilotads.aud.${a.kind}.name`)}</h3>
                <span className={`badge t-${a.kind === 'lookalike' || a.kind === 'buyers' ? 'mid' : 'bad'}`}>{t(a.kind === 'lookalike' ? 'pilotads.aud.include' : 'pilotads.aud.exclude')}</span>
                {a.recommended && <span className="badge t-ok">{t('pilotads.aud.recommended')}</span>}
              </div>
              <label className="pa-switch" title={d.owner ? '' : t('pilotads.pilot.ownerOnly')}>
                <input type="checkbox" role="switch" checked={a.on} disabled={!d.owner || save.isPending} onChange={(e) => save.mutate({ kind: a.kind, on: e.target.checked })} aria-label={t(`pilotads.aud.${a.kind}.name`)} />
                <i aria-hidden />
              </label>
            </header>
            <p>{t(`pilotads.aud.${a.kind}.text`)}</p>
            <footer>
              {a.events ? (
                <span>{t('pilotads.aud.byMeta')}</span>
              ) : (
                <span>
                  <b className="ltr">{n(a.size)}</b> {t('pilotads.aud.people')}
                </span>
              )}
              <span className={`pa-aud-st s-${a.status}`}>{t(`pilotads.aud.st.${a.status}`, { defaultValue: a.status })}</span>
              {a.syncedAt && <small className="muted">{t('pilotads.aud.syncedAt', { when: t('pilotads.ago', { d: since(a.syncedAt) }) })}</small>}
            </footer>
            {a.error && <p className="pa-err">{a.error}</p>}
            {d.owner && (a.kind === 'returners' || a.kind === 'fake' || a.kind === 'buyers') && <AddPhones kind={a.kind} count={d.added_by_kind[a.kind] ?? 0} onDone={() => q.refetch()} />}
          </article>
        ))}
      </div>
      <p className="note pa-privacy">
        <Icon name="info" /> {t('pilotads.aud.where')}
      </p>
      <p className="note pa-privacy">
        <Icon name="lock" /> {t('pilotads.aud.privacy')}
      </p>
    </div>
  );
}

/**
 * The owner adds numbers to a list himself: pasted, or read from a file in the browser (a column copied from his former
 * tool, a courier's export). Pilotix keeps the Algerian mobile numbers it finds, each once; they count for a year.
 */
function AddPhones({ kind, count, onDone }: { kind: 'returners' | 'fake' | 'buyers'; count: number; onDone: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [file, setFile] = useState('');
  const add = useAction('ads.aud.add', {
    success: (r) => (r.removed ? t('pilotads.aud.add.removed', { n: n(r.removed) }) : t('pilotads.aud.add.done', { found: n(r.found), added: n(r.added) })),
    onDone: () => {
      setText('');
      setFile('');
      onDone();
    },
  });
  const read = async (f: File | undefined) => {
    if (!f) return;
    setFile(f.name);
    setText(await f.text());
  };
  const id = `pa-add-${kind}`;
  return (
    <details className="pa-aud-add">
      <summary>
        <Icon name="plus" /> {t('pilotads.aud.add.open')}
        {count > 0 && <span className="muted">{t('pilotads.aud.add.count', { n: n(count) })}</span>}
      </summary>
      <label htmlFor={id}>{t('pilotads.aud.add.label')}</label>
      <textarea id={id} className="ltr" rows={4} value={text} placeholder={'0555 12 34 56\n0661234567'} onChange={(e) => setText(e.target.value)} />
      <div className="pa-aud-add-row">
        <label className="btn small ghost">
          <Icon name="upload" /> {file || t('pilotads.aud.add.file')}
          <input type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => read(e.target.files?.[0])} />
        </label>
        <button type="button" className="btn small primary" disabled={!text.trim() || add.isPending} onClick={() => add.mutate({ kind, text })}>
          {add.isPending ? t('pilotads.aud.add.working') : t('pilotads.aud.add.go')}
        </button>
        {count > 0 && (
          <button type="button" className="btn small ghost" disabled={add.isPending} onClick={() => add.mutate({ kind, clear: true })}>
            {t('pilotads.aud.add.clear')}
          </button>
        )}
      </div>
      <p className="pa-aud-add-hint">{t('pilotads.aud.add.hint')}</p>
    </details>
  );
}
