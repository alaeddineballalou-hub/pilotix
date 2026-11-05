// Pilot AI « Push » (control room, managers): every lesson waiting goes into service now, without a test. The lessons the
// nights found are approved in the pusher's name, a running test stops, a new version is the book of every chat at its
// next reply — and of the test chats, to try it at once. With the box ticked, the shops' Darija lessons waiting are
// accepted for every shop too. « Revenir au livre précédent » undoes the book. The panel says all of it before the click.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { POut } from '../../lib/platform';
import { Icon } from '../../ui/kit';
import { usePilotAction } from './pilotDemo';

type State = POut<'p.pilot.state'>;

/** « Test it now » after a push: the lab's test chat starts again with the new version (read once, by the lab) */
let freshPush = 0;
export const takeFreshPush = (): number => {
  const v = freshPush;
  freshPush = 0;
  return v;
};

export function PushPanel({ d, onPushed, tryHref }: { d: State; onPushed?: (version: number | null) => void; tryHref?: string }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.push.';
  const [open, setOpen] = useState(false);
  const [darija, setDarija] = useState(true);
  const [done, setDone] = useState<{ version: number | null; darija: number; skipped: number } | null>(null);
  const push = usePilotAction('p.pilot.push', {
    success: (r) => (r.version ? t(k + 'done', { v: r.version }) : t(k + 'doneDarija', { n: r.darija?.done ?? 0 })),
    onDone: (r) => {
      setOpen(false);
      setDone({ version: r.version, darija: r.darija?.done ?? 0, skipped: r.skipped });
      onPushed?.(r.version);
    },
  });
  const champion = d.books.books.find((b) => b.status === 'champion') ?? null;
  const testing = d.books.test ? d.books.books.find((b) => b.id === d.books.test!.challengerId) ?? null : null;
  const review = d.candidates.length;
  const waiting = d.next.fresh.length;
  const lahja = d.lahjaWaiting;
  const v = d.next.version;
  const book = review > 0 || d.next.changed;
  const nothing = !book && !lahja;
  return (
    <div className="pl-push">
      {!open ? (
        <div className="pl-push-row">
          <button type="button" className="btn primary" disabled={nothing || push.isPending} onClick={() => (setDone(null), setOpen(true))}>
            <Icon name="upload" /> {book ? t(k + 'button', { v }) : t(k + 'buttonDarija')}
          </button>
          <span className="small muted">{nothing ? t(k + 'nothing') : t(k + 'note')}</span>
        </div>
      ) : (
        <div className="pl-push-ask" role="group" aria-label={book ? t(k + 'title', { v }) : t(k + 'titleDarija')}>
          <b>{book ? t(k + 'title', { v }) : t(k + 'titleDarija')}</b>
          <ul>
            {book && <li>{waiting + review > 0 ? t(k + 'lessons', { v, n: waiting + review }) : t(k + 'rebuilt', { v })}</li>}
            {review > 0 && <li>{t(k + 'review', { n: review })}</li>}
            {book && testing && <li>{t(k + 'test', { v: testing.version, next: v })}</li>}
            {book && <li>{champion ? t(k + 'live', { v: champion.version }) : t(k + 'liveFirst')}</li>}
          </ul>
          {lahja > 0 && (
            <label className="check">
              <input type="checkbox" checked={darija} onChange={(e) => setDarija(e.target.checked)} />
              <span>{t(k + 'darija', { n: lahja })}</span>
            </label>
          )}
          <div className="pl-push-do">
            <button type="button" className="btn primary" disabled={push.isPending || (!book && !(lahja > 0 && darija))} onClick={() => push.mutate({ darija: lahja > 0 && darija })}>
              <Icon name="upload" /> {t(k + 'confirm')}
            </button>
            <button type="button" className="btn ghost" disabled={push.isPending} onClick={() => setOpen(false)}>
              {t(k + 'cancel')}
            </button>
          </div>
        </div>
      )}
      {done && (
        <p className="pl-push-done" role="status">
          <Icon name="check" /> {done.version ? t(k + 'done', { v: done.version }) : t(k + 'doneDarija', { n: done.darija })}
          {!!done.version && done.darija > 0 && <> {t(k + 'doneDarija', { n: done.darija })}</>}
          {done.skipped > 0 && <> {t(k + 'skipped', { n: done.skipped })}</>}
          {tryHref && !!done.version && (
            <>
              {' '}
              <a href={tryHref} onClick={() => (freshPush = done.version ?? 0)}>
                {t(k + 'try', { v: done.version })}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
