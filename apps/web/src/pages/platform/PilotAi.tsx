// Pilot AI (control room): Dellal learns every night from the chats of the shops that share them (names, phones and
// addresses are removed inside each shop). Here: Pilotix's own AI key and nightly budget, last night's report, the
// coach's morning check (approve, edit or reject each lesson, with the anonymized chats behind it), and the lesson books
// with their test: a new book is kept only if it sells at least as well (delivered orders per chat).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateTime, n, when } from '../../lib/format';
import { POut, Staff, usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { can } from './bits';

type State = POut<'p.pilot.state'>;
type Lesson = State['candidates'][number];
const OUTCOMES = ['delivered', 'refused', 'cancelled', 'fake', 'no_order', 'pending', 'stale'] as const;
const pct = (k: number, total: number) => (total ? `${((k / total) * 100).toFixed(1)} %` : '—');

export function PilotAiPage({ staff }: { staff: Staff }) {
  const { t } = useTranslation();
  const q = usePRpc('p.pilot.state', {}, { refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const manager = can(staff, 'manager');
  return (
    <div className="pp-stack pilot-page">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.pilot')}</h1>
          <p className="muted">{t('platform.pilot.sub')}</p>
        </div>
      </div>
      <div className="pp-grid">
        <SettingsCard d={d} manager={manager} />
        <NightCard d={d} />
      </div>
      <CoachCard items={d.candidates} />
      <BooksCard d={d} manager={manager} />
    </div>
  );
}

function SettingsCard({ d, manager }: { d: State; manager: boolean }) {
  const { t } = useTranslation();
  const [on, setOn] = useState(d.config.enabled);
  const [max, setMax] = useState(String(d.config.maxUsd));
  const [share, setShare] = useState(String(Math.round(d.config.share * 100)));
  const [key, setKey] = useState('');
  const save = usePAction('p.pilot.save', { success: t('platform.saved'), onDone: () => setKey('') });
  const send = (k?: string | null) => save.mutate({ enabled: on, maxUsd: Number(max) || 0, share: (Number(share) || 20) / 100, ...(k !== undefined ? { key: k } : {}) });
  const ready = d.config.enabled && d.config.hasKey;
  return (
    <Card title={t('platform.pilot.settings')} badge={<span className={`chip ${ready ? 'pp-chip-ok' : 'pp-chip-warn'}`}>{ready ? t('platform.pilot.on') : t('platform.pilot.off')}</span>}>
      <p className="small muted">{t('platform.pilot.settingsText')}</p>
      <label className="check">
        <input type="checkbox" disabled={!manager} checked={on} onChange={(e) => setOn(e.target.checked)} /> {t('platform.pilot.enable')}
      </label>
      <Field label={t('platform.pilot.key')} hint={d.config.hasKey ? t('platform.pilot.keySaved') : t('platform.pilot.keyHint')}>
        <input type="password" className="ltr" autoComplete="off" disabled={!manager} value={key} placeholder={d.config.hasKey ? '••••••••' : 'sk-ant-…'} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field label={t('platform.pilot.maxUsd')} hint={t('platform.pilot.maxUsdHint')}>
          <input type="number" className="ltr" min={0} max={5} step={0.05} disabled={!manager} value={max} onChange={(e) => setMax(e.target.value)} />
        </Field>
        <Field label={t('platform.pilot.share')} hint={t('platform.pilot.shareHint')}>
          <input type="number" className="ltr" min={5} max={50} step={5} disabled={!manager} value={share} onChange={(e) => setShare(e.target.value)} />
        </Field>
      </div>
      <p className="small muted">{t('platform.pilot.sharing', { shops: n(d.sharing.shops), cases: n(d.sharing.cases) })}</p>
      {manager && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={() => send(key.trim() || undefined)}>
            <Icon name="check" /> {t('common.save')}
          </button>
          {d.config.hasKey && (
            <button type="button" className="btn" disabled={save.isPending} onClick={() => send(null)}>
              {t('platform.pilot.keyRemove')}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function NightCard({ d }: { d: State }) {
  const { t } = useTranslation();
  const r = d.night;
  if (!r)
    return (
      <Card title={t('platform.pilot.night')}>
        <p className="muted">{t('platform.pilot.noNight')}</p>
      </Card>
    );
  const by = r.cases.byOutcome ?? {};
  return (
    <Card title={t('platform.pilot.night')} badge={<span className="chip">{r.night}</span>}>
      <div className="pp-use">
        <div>
          <b className="ltr">{n(r.cases.total)}</b>
          <span>{t('platform.pilot.chats')}</span>
        </div>
        <div>
          <b className="ltr">{n(r.cases.gold)}</b>
          <span>{t('platform.pilot.gold')}</span>
        </div>
        <div>
          <b className="ltr">{n(r.lessons.proposed)}</b>
          <span>{t('platform.pilot.proposed')}</span>
        </div>
        <div>
          <b className="ltr">{n(r.lessons.rejectedByLint)}</b>
          <span>{t('platform.pilot.unsafe')}</span>
        </div>
      </div>
      <div className="pilot-chips">
        {OUTCOMES.filter((o) => by[o]).map((o) => (
          <span key={o} className={`chip o-${o}`}>
            {t(`platform.pilot.outcome.${o}`)} · <b className="ltr">{n(by[o])}</b>
          </span>
        ))}
      </div>
      <p className="small">
        <Icon name="moon" /> {t('platform.pilot.cost', { usd: r.spend.usd.toFixed(3), night: r.spend.nightUsd.toFixed(3), max: r.spend.maxUsd.toFixed(2) })}
        {r.spend.capHit && <span className="chip pp-chip-warn">{t('platform.pilot.capHit')}</span>}
      </p>
      {!r.ai.enabled && <p className="small muted">{t('platform.pilot.noAi')}</p>}
      <p className="small muted">{t('platform.pilot.ranAt', { when: when(r.at) })}</p>
    </Card>
  );
}

function CoachCard({ items }: { items: Lesson[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<[number, number] | null>(null);
  return (
    <Card title={t('platform.pilot.coach')} badge={items.length ? <span className="chip pp-chip-warn">{n(items.length)}</span> : undefined} help={t('platform.pilot.coachHelp')}>
      {!items.length ? <p className="muted">{t('platform.pilot.coachEmpty')}</p> : <div className="pilot-lessons">{items.map((l) => <LessonRow key={l.id} l={l} onCase={setOpen} />)}</div>}
      {open && <CaseModal shopId={open[0]} convId={open[1]} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function LessonRow({ l, onCase }: { l: Lesson; onCase: (c: [number, number]) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(l.text);
  const [note, setNote] = useState('');
  const act = usePAction('p.pilot.lesson', { success: t('platform.saved') });
  const ev = (l.evidence ?? {}) as { wins?: number; losses?: number; gold?: number; shops?: number; reasons?: Record<string, number>; cases?: [number, number][] };
  const reasons = Object.entries(ev.reasons ?? {})
    .filter(([k]) => k !== 'none')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const changed = text.trim() !== l.text;
  return (
    <div className="pilot-lesson">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="chip">{t(`platform.pilot.topic.${l.topic}`, { defaultValue: l.topic })}</span>
        <span className="small muted">
          {t('platform.pilot.evidence', { wins: n(ev.wins ?? 0), losses: n(ev.losses ?? 0), gold: n(ev.gold ?? 0), shops: n(ev.shops ?? 0) })}
        </span>
        {reasons.map(([k, v]) => (
          <span key={k} className="chip o-cancelled">
            {t(`platform.pilot.reason.${k}`, { defaultValue: k })} · {n(v)}
          </span>
        ))}
      </div>
      <textarea rows={3} maxLength={400} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: 'approve', ...(changed ? { text: text.trim() } : {}) })}>
          <Icon name="checkcircle" /> {t('platform.pilot.approve')}
        </button>
        {changed && (
          <button type="button" className="btn" disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: 'edit', text: text.trim() })}>
            <Icon name="pencil" /> {t('platform.pilot.saveEdit')}
          </button>
        )}
        <input className="pilot-note" maxLength={300} value={note} placeholder={t('platform.pilot.whyReject')} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="btn" disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: 'reject', ...(note.trim() ? { note: note.trim() } : {}) })}>
          <Icon name="xcircle" /> {t('platform.pilot.reject')}
        </button>
        {(ev.cases ?? []).slice(0, 3).map((c, i) => (
          <button key={i} type="button" className="btn ghost small" onClick={() => onCase(c)}>
            {t('platform.pilot.seeChat', { n: i + 1 })}
          </button>
        ))}
      </div>
    </div>
  );
}

function CaseModal({ shopId, convId, onClose }: { shopId: number; convId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const q = usePRpc('p.pilot.case', { shopId, convId });
  return (
    <Modal title={t('platform.pilot.chatTitle')} onClose={onClose} sheet>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !q.data ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <p className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className={`chip o-${q.data.outcome}`}>{t(`platform.pilot.outcome.${q.data.outcome}`, { defaultValue: q.data.outcome })}</span>
            {q.data.reason && <span className="chip">{t(`platform.pilot.reason.${q.data.reason}`, { defaultValue: q.data.reason })}</span>}
            {q.data.takeover && <span className="chip pp-chip-ok">{t('platform.pilot.takeover')}</span>}
          </p>
          <pre className="pilot-transcript">{q.data.transcript}</pre>
          <p className="small muted">{t('platform.pilot.legend')}</p>
          <p className="small muted">{t('platform.pilot.anonymous')}</p>
        </>
      )}
    </Modal>
  );
}

function BooksCard({ d, manager }: { d: State; manager: boolean }) {
  const { t } = useTranslation();
  const publish = usePAction('p.pilot.publish', { success: t('platform.pilot.published') });
  const promote = usePAction('p.pilot.promote', { success: t('platform.saved') });
  const stop = usePAction('p.pilot.stop', { success: t('platform.saved') });
  const back = usePAction('p.pilot.rollback', { success: t('platform.saved') });
  const { books, test } = d.books;
  const champion = books.find((b) => b.status === 'champion') ?? null;
  const rep = d.night?.test && test && d.night.test.id === test.id ? d.night.test : null;
  const busy = publish.isPending || promote.isPending || stop.isPending || back.isPending;
  return (
    <Card title={t('platform.pilot.books')} help={t('platform.pilot.booksHelp')}>
      <p>
        {champion ? t('platform.pilot.champion', { v: champion.version, lessons: n(champion.lessons), date: dateTime(champion.promotedAt ?? champion.createdAt) }) : t('platform.pilot.noBook')}
      </p>
      {test ? (
        <div className="pilot-test">
          <b>{t('platform.pilot.testRunning', { share: Math.round(test.share * 100), date: when(test.startedAt) })}</b>
          {rep ? (
            <div className="pp-use">
              <div>
                <b className="ltr">{pct(rep.A.k, rep.A.n)}</b>
                <span>{t('platform.pilot.armA', { n: n(rep.A.n) })}</span>
              </div>
              <div>
                <b className="ltr">{pct(rep.B.k, rep.B.n)}</b>
                <span>{t('platform.pilot.armB', { n: n(rep.B.n) })}</span>
              </div>
              <div className="txt">
                <b>{t(`platform.pilot.verdict.${rep.verdict}`, { defaultValue: rep.verdict })}</b>
                <span>{t('platform.pilot.verdictLabel')}</span>
              </div>
            </div>
          ) : (
            <p className="small muted">{t('platform.pilot.testWait')}</p>
          )}
          {manager && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn primary" disabled={busy || rep?.verdict !== 'pass'} onClick={() => promote.mutate({ testId: test.id })}>
                <Icon name="trophy" /> {t('platform.pilot.keep')}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => stop.mutate({ testId: test.id })}>
                <Icon name="xcircle" /> {t('platform.pilot.stop')}
              </button>
            </div>
          )}
        </div>
      ) : (
        manager && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" disabled={busy || !d.approved.length} onClick={() => publish.mutate({})}>
              <Icon name="sparkles" /> {t('platform.pilot.publish', { n: d.approved.length })}
            </button>
            {champion && books.some((b) => b.version < champion.version) && (
              <button type="button" className="btn" disabled={busy} onClick={() => back.mutate({})}>
                <Icon name="undo" /> {t('platform.pilot.rollback')}
              </button>
            )}
          </div>
        )
      )}
      {!!books.length && (
        <ul className="pp-mini">
          {books.map((b) => (
            <li key={b.id}>
              <span className="pp-two">
                <b>
                  v{b.version} · {t(`platform.pilot.bookStatus.${b.status}`, { defaultValue: b.status })}
                </b>
                <small className="muted">{t('platform.pilot.bookLine', { lessons: n(b.lessons), by: b.by ?? '—', date: dateTime(b.createdAt) })}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
