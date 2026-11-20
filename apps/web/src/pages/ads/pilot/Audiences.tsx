// « Audiences »: the shop's own customers as Meta audiences. Left out of the ads: who returned a parcel, who gave a
// fake order; optional: the delivered customers, and people who look like them (a lookalike, 100 customers at least).
// No customer goes to Meta before the owner turns one on; the phones are hashed on the server (SHA-256) before they
// leave. Two more lists are Meta's own (« events »): the browsers behind fake orders and competitors, which Meta fills
// from the landing pages' events. Nothing is uploaded for them, so they are on unless the owner turns them off.
// « Pubs faites à la main »: an ad set made in Meta's Ads Manager gets the lists from Pilotix while it is new.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n, since } from '../../../lib/format';
import { useAction, useRpc } from '../../../lib/query';
import { ErrorBox, Icon, Loading } from '../../../ui/kit';
import { adStatusLabel } from '../adStatus';

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
      <HandCard />
      <p className="note pa-privacy">
        <Icon name="info" /> {t('pilotads.aud.where')}
      </p>
      <p className="note pa-privacy">
        <Icon name="lock" /> {t('pilotads.aud.privacy')}
      </p>
    </div>
  );
}

/** how many rows a list shows before « Voir tout » */
const HAND_SHOWN = 4;

/**
 * « Pubs faites à la main »: Pilotix puts the lists on every new ad set made in Meta's Ads Manager (its first hours:
 * its learning loses nothing), and only shows the older ones that miss them (a list added to an ad set that runs
 * restarts its learning). The owner turns it off or checks now; everything else is core's (ads.hand.*).
 */
function HandCard() {
  const { t } = useTranslation();
  const q = useRpc('ads.hand.state', {}, { refetchInterval: 120_000 });
  const save = useAction('ads.hand.save', { success: (r) => (r.on ? t('pilotads.hand.savedOn') : t('pilotads.hand.savedOff')) });
  const check = useAction('ads.hand.check', { success: t('pilotads.hand.checkedNow') });
  const [allFixed, setAllFixed] = useState(false);
  const [allMissing, setAllMissing] = useState(false);
  const d = q.data;
  // the lists above stay usable whatever happens to this card
  if (!d) return null;
  const fixed = allFixed ? d.fixed : d.fixed.slice(0, HAND_SHOWN);
  const missing = allMissing ? d.missing : d.missing.slice(0, HAND_SHOWN);
  return (
    <section className={`card pa-hand ${d.on ? 'on' : ''}`} aria-labelledby="pa-hand-title">
      <header>
        <span className="pa-aud-ico">
          <Icon name="shield" />
        </span>
        <div>
          <h3 id="pa-hand-title">{t('pilotads.hand.title')}</h3>
          <p>{t('pilotads.hand.sub', { h: d.fixH })}</p>
        </div>
        <label className="pa-switch" title={d.owner ? '' : t('pilotads.pilot.ownerOnly')}>
          <input type="checkbox" role="switch" checked={d.on} disabled={!d.owner || save.isPending} onChange={(e) => save.mutate({ on: e.target.checked })} aria-label={t('pilotads.hand.switch')} />
          <i aria-hidden />
        </label>
      </header>

      {!d.on ? (
        <p className="pa-hand-off">{t('pilotads.hand.off')}</p>
      ) : (
        <>
          {d.error && <p className="pa-err">{t('pilotads.hand.runError', { why: d.error })}</p>}
          {d.checkedAt && d.lists === 0 && <p className="pa-hand-off">{t('pilotads.hand.noLists')}</p>}
          {d.lists > 0 && !d.fixed.length && !d.missing.length && (
            <p className="pa-hand-ok">
              <Icon name="checkcircle" /> {t('pilotads.hand.allGood')}
            </p>
          )}

          {d.fixed.length > 0 && (
            <div className="pa-hand-block">
              <h4>
                <Icon name="checkcircle" /> {t('pilotads.hand.fixedTitle')} <b className="ltr">{n(d.fixed.length)}</b>
              </h4>
              <ul className="pa-hand-list">
                {fixed.map((f) => (
                  <li key={`${f.id}-${f.at}`}>
                    <span className="pa-hand-name">
                      <b>{f.name}</b>
                      <small>{f.campaign}</small>
                    </span>
                    <span className="pa-hand-tag ok">{t('pilotads.hand.added', { count: f.added })}</span>
                    <small className="pa-hand-when">{t('pilotads.ago', { d: since(f.at) })}</small>
                  </li>
                ))}
              </ul>
              {d.fixed.length > HAND_SHOWN && (
                <button type="button" className="btn small ghost pa-hand-more" onClick={() => setAllFixed(!allFixed)}>
                  {allFixed ? t('pilotads.hand.less') : t('pilotads.hand.more', { n: n(d.fixed.length - HAND_SHOWN) })}
                </button>
              )}
            </div>
          )}

          {d.missing.length > 0 && (
            <div className="pa-hand-block warn">
              <h4>
                <Icon name="alert" /> {t('pilotads.hand.missingTitle')} <b className="ltr">{n(d.missing.length)}</b>
              </h4>
              <p className="pa-hand-hint">{t('pilotads.hand.missingHint')}</p>
              <ul className="pa-hand-list">
                {missing.map((m) => (
                  <li key={m.id}>
                    <span className="pa-hand-name">
                      <b>{m.name}</b>
                      <small>{m.campaign}</small>
                    </span>
                    <span className={`pa-hand-tag ${m.status === 'ACTIVE' ? 'run' : ''}`}>{adStatusLabel(m.status, t)}</span>
                    <small className="pa-hand-when">{t('pilotads.hand.lacks', { count: m.lacks })}</small>
                    {m.error && <small className="pa-err pa-hand-why">{t('pilotads.hand.refused', { why: m.error })}</small>}
                  </li>
                ))}
              </ul>
              {d.missing.length > HAND_SHOWN && (
                <button type="button" className="btn small ghost pa-hand-more" onClick={() => setAllMissing(!allMissing)}>
                  {allMissing ? t('pilotads.hand.less') : t('pilotads.hand.more', { n: n(d.missing.length - HAND_SHOWN) })}
                </button>
              )}
            </div>
          )}
        </>
      )}

      <footer>
        <small className="muted">{d.checkedAt ? t('pilotads.hand.checkedAt', { when: t('pilotads.ago', { d: since(d.checkedAt) }) }) : t('pilotads.hand.never')}</small>
        {d.owner && d.on && (
          <button type="button" className="btn small ghost" disabled={check.isPending} onClick={() => check.mutate({})}>
            <Icon name="refresh" /> {check.isPending ? t('pilotads.hand.checking') : t('pilotads.hand.check')}
          </button>
        )}
      </footer>
      {d.demo && <p className="pa-hand-demo muted">{t('pilotads.hand.demo')}</p>}
    </section>
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
