// Pilot AI › Dellal AI: how Dellal learns, drawn as a learning bench the reader can drive (the day it sells, the night
// Pilot AI reads the finished chats, the morning the coach decides, the test that the parcels judge: learn/LearnBench),
// its rules in simple words (always the engine's own numbers), and its instruction book: put together on the server at
// each click, so a download is always the latest version.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { LearnBench } from './learn/LearnBench';
import { usePilotCall } from './pilotDemo';
import { PushPanel } from './PilotPush';
import { Card, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';

type State = POut<'p.pilot.state'>;

/** The loop, as a learning bench the reader can drive: the four moments, the engine's own numbers. */
export function LearnCard({ d }: { d: State }) {
  const { t, i18n } = useTranslation();
  const r = d.rules;
  const sc = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${String(Math.abs(v)).replace('.', i18n.language === 'en' ? '.' : ',')}`;
  return (
    <Card title={t('platform.pilot.learn.title')} help={t('platform.pilot.learn.help')} className="pl-card">
      <p className="pl-lead">{t('platform.pilot.learn.lead')}</p>
      <LearnBench share={Math.round(d.config.share * 100)} days={r.matureDays} />
      <p className="pl-again">
        <Icon name="undo" /> {t('platform.pilot.learn.again')}
      </p>

      <div className="pl-rules">
        <div>
          <h3 className="pb-h">{t('platform.pilot.learn.scoreTitle')}</h3>
          <p className="small muted">{t('platform.pilot.learn.scoreLead')}</p>
          <table className="pl-score">
            <tbody>
              {(
                [
                  ['delivered', r.score.delivered],
                  ['exchanged', r.score.exchanged],
                  ['refused', r.score.refused],
                  ['wrong_number', r.score.wrong_number],
                  ['cancelled', r.score.cancelled],
                  ['no_order', 0],
                ] as const
              ).map(([k, v]) => (
                <tr key={k}>
                  <td>{t(`platform.pilot.learn.score.${k}`)}</td>
                  <td className={`num ltr ${v > 0 ? 'pl-plus' : v < 0 ? 'pl-minus' : ''}`}>{sc(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">{t('platform.pilot.learn.gold', { gold: String(r.gold).replace('.', i18n.language === 'en' ? '.' : ',') })}</p>
        </div>
        <div>
          <h3 className="pb-h">{t('platform.pilot.learn.rulesTitle')}</h3>
          <ul className="pl-list">
            <li>{t('platform.pilot.learn.rule.win')}</li>
            <li>{t('platform.pilot.learn.rule.safe')}</li>
            <li>{t('platform.pilot.learn.rule.short', { open: r.maxOpen })}</li>
            <li>{t('platform.pilot.learn.rule.brain')}</li>
            <li>{t('platform.pilot.learn.rule.test', { min: n(r.minPass), days: r.matureDays, max: r.maxTestDays })}</li>
            <li>{t('platform.pilot.learn.rule.budget', { usd: d.config.maxUsd.toFixed(2) })}</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}

/** Dellal's instruction book: the version in service, the one in test, the file (made at the click: the latest), and
 * « Push » (managers): every lesson waiting in service now, as a new version, without a test. */
export function BookCard({ d, manager }: { d: State; manager: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState<string | null>(null);
  const call = usePilotCall();
  const champion = d.books.books.find((b) => b.status === 'champion') ?? null;
  const testing = d.books.test ? d.books.books.find((b) => b.id === d.books.test!.challengerId) ?? null : null;
  const get = async (show: boolean) => {
    setBusy(true);
    try {
      const b = await call('p.pilot.bookText', {});
      if (show) setRead(b.text);
      else saveText(`dellal-livre-${b.version ? `v${b.version}` : 'base'}-${new Date().toISOString().slice(0, 10)}.txt`, b.text);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('platform.pilot.book.title')} help={t('platform.pilot.book.help')} className="pl-book">
      <p className="small">{t('platform.pilot.book.what')}</p>
      <p className="pl-book-v">
        {champion ? (
          <>
            <b className="ltr">v{champion.version}</b> {t('platform.pilot.book.since', { date: dateOnly(champion.promotedAt ?? champion.createdAt), count: champion.lessons, n: n(champion.lessons) })}
          </>
        ) : (
          t('platform.pilot.book.base')
        )}
      </p>
      {testing && d.books.test && <p className="small muted">{t('platform.pilot.book.testing', { v: testing.version, share: Math.round(d.books.test.share * 100) })}</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={busy} onClick={() => get(false)}>
          <Icon name="download" /> {t('platform.pilot.book.download')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => get(true)}>
          <Icon name="eye" /> {t('platform.pilot.book.read')}
        </button>
      </div>
      <p className="small muted">{t('platform.pilot.book.always')}</p>
      {manager && <PushPanel d={d} tryHref="#/platform/pilot/lab" />}
      {read !== null && (
        <Modal title={t('platform.pilot.book.title')} onClose={() => setRead(null)} sheet>
          <pre className="pilot-transcript pl-book-text">{read}</pre>
        </Modal>
      )}
    </Card>
  );
}

function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
