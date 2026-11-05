// Pilot AI's two pushes (control room): nothing Pilotix changes reaches the shops at once.
//  1. « Push en test »: everything waiting — the sales lessons (the nights' ones approved in the pusher's name), the Darija
//     lessons Pilotix accepted (and, box ticked, the shops' ones waiting), the Darija rules' draft, the vocabulary's working
//     copy — becomes one version that only the control room's test chat uses;
//  2. « Push sur le serveur »: that version, exactly as tested, goes out to every shop at once (its question says all of it
//     before the click). « Revenir au livre précédent » brings the sales book back.
// A card of the Dellal tab, and the foot of the lab's next-book card. Managers push; everyone sees where things are.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateTime, n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { Card, Icon } from '../../ui/kit';
import { usePilotAction } from './pilotDemo';

type State = POut<'p.pilot.state'>;
type Release = State['release'];
type Tr = (k: string, o?: Record<string, unknown>) => string;
const K = 'platform.pilot.release.';

/** « Tester » from the Dellal tab: the lab's test chat starts again on that version (read once, by the lab) */
let freshPush: 'trial' | 'live' | null = null;
export const takeFreshPush = (): 'trial' | 'live' | null => {
  const v = freshPush;
  freshPush = null;
  return v;
};

/** What waits for the next « Push en test », in a few words (the box: the shops' Darija lessons waiting go in too). */
function waitingParts(t: Tr, p: Release['pending'], withShops: boolean): string[] {
  const sales = p.sales + p.candidates;
  const darija = p.darija + (withShops ? p.waiting : 0);
  return [
    sales > 0 ? (p.candidates > 0 ? t(K + 'partSalesNight', { n: n(sales), night: n(p.candidates) }) : t(K + 'partSales', { n: n(sales) })) : '',
    darija > 0 ? t(K + 'partDarija', { n: n(darija) }) : '',
    p.rules ? t(K + 'partRules') : '',
    p.vocab.total > 0 ? t(K + 'partVocab', { n: n(p.vocab.total) }) : '',
  ].filter(Boolean);
}
/** What the version in test holds that the shops do not have. */
function trialParts(t: Tr, tr: NonNullable<Release['trial']>): string[] {
  return [
    tr.sales.changed ? (tr.sales.fresh > 0 ? t(K + 'partSalesNew', { n: n(tr.sales.lessons), fresh: n(tr.sales.fresh) }) : t(K + 'partSalesBook', { n: n(tr.sales.lessons) })) : '',
    tr.darija.lessons > 0 ? t(K + 'partDarija', { n: n(tr.darija.lessons) }) : '',
    tr.darija.rules ? t(K + 'partRules') : '',
    tr.vocab.total > 0 ? t(K + 'partVocab', { n: n(tr.vocab.total) }) : '',
  ].filter(Boolean);
}

export function ReleaseCard({ d, manager }: { d: State; manager: boolean }) {
  const { t } = useTranslation();
  return (
    <Card title={t(K + 'title')} help={t(K + 'help')} className="pl-rel-card">
      <ReleasePanel d={d} manager={manager} tryHref="#/platform/pilot/lab" />
    </Card>
  );
}

export function ReleasePanel({ d, manager, onStaged, onReleased, onTry, tryHref }: { d: State; manager: boolean; onStaged?: (v: number) => void; onReleased?: (v: number) => void; onTry?: (kind: 'trial' | 'live') => void; tryHref?: string }) {
  const { t } = useTranslation();
  const r = d.release;
  const tr = r.trial;
  const p = r.pending;
  const [withShops, setWithShops] = useState(true);
  const [ask, setAsk] = useState(false);
  const [done, setDone] = useState<{ kind: 'trial' | 'live'; v: number; skipped: number; refused: number } | null>(null);
  const stage = usePilotAction('p.pilot.stage', {
    success: (x) => t(K + 'stagedToast', { v: x.version }),
    onDone: (x) => {
      setDone({ kind: 'trial', v: x.version, skipped: x.skipped, refused: x.refusedByCheck });
      onStaged?.(x.version);
    },
  });
  const push = usePilotAction('p.pilot.release', {
    success: (x) => t(K + 'pushedToast', { v: x.version }),
    onDone: (x) => {
      setAsk(false);
      setDone({ kind: 'live', v: x.version, skipped: 0, refused: 0 });
      onReleased?.(x.version);
    },
  });
  const busy = stage.isPending || push.isPending;
  const waiting = waitingParts(t, p, withShops);
  const inTrial = tr ? trialParts(t, tr) : [];
  const stale = tr ? tr.stale.sales + tr.stale.darija : 0;
  const testing = d.books.test ? d.books.books.find((b) => b.id === d.books.test!.challengerId) ?? null : null;
  const tryIt = (v: number, kind: 'trial' | 'live') =>
    tryHref ? (
      <a className="btn small" href={tryHref} onClick={() => (freshPush = kind)}>
        <Icon name="chat" /> {t(K + (kind === 'trial' ? 'tryTrial' : 'tryLive'), { v })}
      </a>
    ) : (
      <button type="button" className="btn small" onClick={() => onTry?.(kind)}>
        <Icon name="chat" /> {t(K + (kind === 'trial' ? 'tryTrial' : 'tryLive'), { v })}
      </button>
    );
  return (
    <div className="pl-rel">
      <ol className="pl-rel-steps">
        <li className="pl-rel-step">
          <span className="pl-rel-n" aria-hidden="true">
            1
          </span>
          <div className="pl-rel-body">
            <p className="pl-rel-h">
              <b>{t(K + 'stepTest')}</b> <span className="small muted">{t(K + 'stepTestWho')}</span>
            </p>
            <p className="pl-rel-what">{waiting.length ? t(K + (tr ? 'waitingMore' : 'waiting'), { what: waiting.join(t(K + 'and')), v: tr?.version }) : t(K + (tr ? 'nothingMore' : 'nothing'), { v: tr?.version })}</p>
            {manager && (
              <>
                {p.waiting > 0 && (
                  <label className="check pl-rel-check">
                    <input type="checkbox" checked={withShops} onChange={(e) => setWithShops(e.target.checked)} />
                    <span>{t(K + 'withShops', { n: n(p.waiting) })}</span>
                  </label>
                )}
                <div className="pl-rel-do">
                  <button type="button" className={`btn ${tr && !waiting.length ? '' : 'primary'}`} disabled={busy || !waiting.length} onClick={() => stage.mutate({ darija: p.waiting > 0 && withShops })}>
                    <Icon name="beaker" /> {t(K + 'stage')}
                  </button>
                  {p.candidates > 0 && <span className="small muted">{t(K + 'nightNote', { n: n(p.candidates) })}</span>}
                </div>
              </>
            )}
          </div>
        </li>
        <li className={`pl-rel-step ${tr ? 'on' : ''}`}>
          <span className="pl-rel-n" aria-hidden="true">
            2
          </span>
          <div className="pl-rel-body">
            <p className="pl-rel-h">
              <b>{t(K + 'stepLive')}</b> <span className="small muted">{t(K + 'stepLiveWho')}</span>
            </p>
            {!tr ? (
              <p className="pl-rel-what muted">{t(K + 'noTrial')}</p>
            ) : (
              <>
                <p className="pl-rel-what">
                  <b>{t(K + 'trialV', { v: tr.version })}</b> {inTrial.length ? inTrial.join(t(K + 'and')) : t(K + 'trialSame')}
                  <span className="small muted pl-rel-by">
                    {' '}
                    · <bdi>{tr.by ?? '—'}</bdi> · <bdi>{dateTime(tr.at)}</bdi>
                  </span>
                </p>
                {stale > 0 && (
                  <p className="warnbox pl-rel-stale" role="alert">
                    {t(K + 'stale', { v: tr.version, n: n(stale) })}
                  </p>
                )}
                {ask ? (
                  <div className="pl-push-ask" role="group" aria-label={t(K + 'askTitle', { v: tr.version })}>
                    <b>{t(K + 'askTitle', { v: tr.version })}</b>
                    <p className="small">{t(K + 'askLead')}</p>
                    <ul>
                      {tr.sales.changed && <li>{tr.sales.fresh > 0 ? t(K + 'askSalesNew', { n: n(tr.sales.lessons), fresh: n(tr.sales.fresh) }) : t(K + 'askSales', { n: n(tr.sales.lessons) })}</li>}
                      {tr.darija.lessons > 0 && <li>{t(K + 'askDarija', { n: n(tr.darija.lessons) })}</li>}
                      {tr.darija.rules && <li>{t(K + 'askRules')}</li>}
                      {tr.vocab.total > 0 && <li>{t(K + 'askVocab', { added: n(tr.vocab.added), changed: n(tr.vocab.changed), removed: n(tr.vocab.removed) })}</li>}
                      {testing && <li>{t(K + 'askTest', { v: testing.version })}</li>}
                      {waiting.length > 0 && <li>{t(K + 'askLeft', { what: waiting.join(t(K + 'and')) })}</li>}
                      <li>{r.live ? t(K + 'askBack', { v: r.live.version }) : t(K + 'askFirst')}</li>
                    </ul>
                    <div className="pl-push-do">
                      <button type="button" className="btn primary" disabled={busy} onClick={() => push.mutate({ id: tr.id })}>
                        <Icon name="upload" /> {t(K + 'push')}
                      </button>
                      <button type="button" className="btn ghost" disabled={busy} onClick={() => setAsk(false)}>
                        {t(K + 'cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="pl-rel-do">
                    {tryIt(tr.version, 'trial')}
                    {manager && (
                      <button type="button" className="btn primary" disabled={busy || stale > 0} onClick={() => (setDone(null), setAsk(true))}>
                        <Icon name="upload" /> {t(K + 'push')}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </li>
      </ol>
      <p className="pl-rel-live small muted">
        <Icon name="checkcircle" /> {r.live ? t(K + 'inService', { v: r.live.version, date: dateTime(r.live.at) }) : t(K + 'inServiceNone')}
      </p>
      {done && (
        <p className="pl-push-done" role="status">
          <Icon name="check" /> {t(K + (done.kind === 'trial' ? 'stagedDone' : 'pushedDone'), { v: done.v })}
          {done.skipped > 0 && <> {t(K + 'skipped', { n: n(done.skipped) })}</>}
          {done.refused > 0 && <> {t(K + 'refused', { n: n(done.refused) })}</>} {tryIt(done.v, done.kind)}
        </p>
      )}
      {!manager && <p className="small muted">{t(K + 'managers')}</p>}
    </div>
  );
}
