// Pilot AI › Tester & leçons › Leçons › Darija: the Darija book, kept apart from the sales book. The rules of Algerian
// Darija in chapters, and the lessons for every shop, that Dellal and the CM AI agent read before every reply. Read it,
// edit it (managers: a draft, out with the next push — « Push en test », then « Push sur le serveur »), download it, see
// its versions and go back to one (at once) (modules/darijabook.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, dateTime, n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { ConfirmButton } from '../admin/bits';
import { toast } from '../../ui/toast';
import { LahjaWords } from '../messages/lahja';
import { usePilotAction, usePilotCall, usePilotRpc } from './pilotDemo';

type Data = POut<'p.darija.book'>;
type Book = Data['book'];
type Draft = NonNullable<Data['draft']>;
type Version = Data['versions'][number];
type Chapter = { title: string; text: string };
const k = 'platform.pilot.lab.book.';
const MAX = 30000;
/** A, B, C… as the book sets them */
const mark = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
const size = (title: string, cs: Chapter[]) => [title, ...cs.map((c, i) => `${mark(i)}. ${c.title}\n${c.text}`)].join('\n\n').length;

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

export function DarijaBookCard({ manager }: { manager: boolean }) {
  const { t } = useTranslation();
  const q = usePilotRpc('p.darija.book', {});
  const call = usePilotCall();
  const [open, setOpen] = useState<'read' | 'edit' | 'versions' | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async (version?: number) => {
    setBusy(true);
    try {
      const f = await call('p.darija.file', version ? { version } : {});
      saveText(`livre-darija-v${f.version}-${new Date().toISOString().slice(0, 10)}.txt`, f.text);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  if (q.isLoading) return <div className="pl-db pl-db-wait" aria-busy="true" />;
  if (q.error || !q.data)
    return (
      <p className="pl-lab-err" role="alert">
        <Icon name="alert" /> {q.error?.message}
      </p>
    );
  const { book, draft, trial, versions } = q.data;
  const words = book.lessons.flatMap((l) => l.words);
  return (
    <section className="pl-db" aria-labelledby="pl-db-h">
      <div className="pl-db-top">
        <span className="pl-db-ic">
          <Icon name="book" />
        </span>
        <div>
          <h3 id="pl-db-h">
            {t(k + 'title')} <span className="pl-db-v ltr">v{book.version}</span>
          </h3>
          <p className="pl-db-help">{t(k + 'help')}</p>
        </div>
      </div>
      <p className="pl-db-meta">
        <bdi>{t(k + 'chapters', { count: book.chapters.length, n: n(book.chapters.length) })}</bdi>
        {' · '}
        <bdi>{t(k + 'lessons', { count: words.length, n: n(words.length) })}</bdi>
        {' · '}
        <bdi>{t(k + 'since', { date: dateOnly(book.at) })}</bdi>
        {book.by && (
          <>
            {' · '}
            <bdi>{book.by}</bdi>
          </>
        )}
      </p>
      {book.note && (
        <p className="pl-db-last">
          {t(k + 'last')} <bdi>{book.note}</bdi>
        </p>
      )}
      {draft && <DraftNote draft={draft} manager={manager} onEdit={() => setOpen('edit')} />}
      {trial?.rules && <p className="small muted pl-db-trial">{t(k + 'trialRules', { v: trial.version })}</p>}
      <div className="pl-db-do">
        {manager && !draft && (
          <button type="button" className="btn primary small" onClick={() => setOpen('edit')}>
            <Icon name="pencil" /> {t(k + 'edit')}
          </button>
        )}
        <button type="button" className={`btn small ${manager ? '' : 'primary'}`} onClick={() => setOpen('read')}>
          <Icon name="eye" /> {t(k + 'read')}
        </button>
        <button type="button" className="btn small" disabled={busy} onClick={() => download()}>
          <Icon name="download" /> {t(k + 'download')}
        </button>
        <button type="button" className="btn ghost small" onClick={() => setOpen('versions')}>
          <Icon name="history" /> {t(k + 'versions', { n: n(versions.length) })}
        </button>
      </div>
      {open === 'read' && <ReadBook book={book} onClose={() => setOpen(null)} />}
      {open === 'edit' && <EditBook book={book} draft={draft} onClose={() => setOpen(null)} />}
      {open === 'versions' && <Versions versions={versions} manager={manager} busy={busy} onDownload={download} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** The book in service, chapter after chapter, then its lessons for every shop. */
function ReadBook({ book, onClose }: { book: Book; onClose: () => void }) {
  const { t } = useTranslation();
  const words = book.lessons.flatMap((l) => l.words);
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return (
    <Modal title={t(k + 'readTitle', { v: book.version })} onClose={onClose} sheet wide>
      <div className="pl-db-read">
        <p className="pl-db-intro" dir="auto">
          {book.title}
        </p>
        <nav className="pl-db-toc" aria-label={t(k + 'toc')}>
          {book.chapters.map((c, i) => (
            <button key={i} type="button" className="pl-db-toc-i" onClick={() => go(`pl-db-c${i}`)}>
              <b>{mark(i)}</b> <span dir="auto">{c.title}</span>
            </button>
          ))}
          <button type="button" className="pl-db-toc-i" onClick={() => go('pl-db-cl')}>
            <b>
              <Icon name="languages" />
            </b>{' '}
            {t(k + 'lessonsTitle')}
          </button>
        </nav>
        {book.chapters.map((c, i) => (
          <article key={i} id={`pl-db-c${i}`} className="pl-db-ch">
            <h4>
              <span className="pl-db-l">{mark(i)}</span> <span dir="auto">{c.title}</span>
            </h4>
            <div className="pl-db-text" dir="auto">
              {c.text}
            </div>
          </article>
        ))}
        <article id="pl-db-cl" className="pl-db-ch">
          <h4>
            <span className="pl-db-l">
              <Icon name="languages" />
            </span>{' '}
            {t(k + 'lessonsTitle')}
          </h4>
          {words.length ? <LahjaWords words={words} className="pl-db-words" /> : <p className="muted">{t(k + 'lessonsEmpty')}</p>}
        </article>
      </div>
    </Modal>
  );
}

/** The rules being edited: not in service yet, out with the next push. */
function DraftNote({ draft, manager, onEdit }: { draft: Draft; manager: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const discard = usePilotAction('p.darija.discard', { success: t(k + 'discarded') });
  return (
    <div className="pl-db-draft" role="note">
      <p>
        <Icon name="pencil" /> <b>{t(k + 'draftTitle')}</b>{' '}
        <small className="muted">
          <bdi>{draft.by ?? '—'}</bdi> · <bdi>{dateTime(draft.at)}</bdi>
        </small>
      </p>
      {draft.note && (
        <p className="small" dir="auto">
          {draft.note}
        </p>
      )}
      <p className="small">{t(k + 'draftHelp')}</p>
      {manager && (
        <div className="pl-db-do">
          <button type="button" className="btn primary small" onClick={onEdit}>
            <Icon name="pencil" /> {t(k + 'editDraft')}
          </button>
          <ConfirmButton className="btn ghost small" question={t(k + 'discardAsk')} onConfirm={() => discard.mutate({})} disabled={discard.isPending}>
            <Icon name="trash" /> {t(k + 'discard')}
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}

/** The rules as text, chapter by chapter (from the draft when there is one): saving keeps a draft, out with the next push. */
function EditBook({ book, draft, onClose }: { book: Book; draft: Draft | null; onClose: () => void }) {
  const { t } = useTranslation();
  const base = draft ?? book;
  const [title, setTitle] = useState(base.title);
  const [chapters, setChapters] = useState<Chapter[]>(() => base.chapters.map((c) => ({ ...c })));
  const [note, setNote] = useState(draft?.note ?? '');
  const [leave, setLeave] = useState(false);
  const added = useRef<number | null>(null);
  const save = usePilotAction('p.darija.save', { success: (r) => t(k + (r.draft ? 'savedDraft' : 'savedBack')), onDone: onClose });
  const dirty = title !== base.title || JSON.stringify(chapters) !== JSON.stringify(base.chapters.map((c) => ({ ...c })));
  const total = size(title, chapters);
  const ok = dirty && title.trim() && chapters.length > 0 && chapters.every((c) => c.title.trim() && c.text.trim()) && total <= MAX;
  const put = (i: number, f: keyof Chapter, v: string) => setChapters((cs) => cs.map((c, j) => (j === i ? { ...c, [f]: v } : c)));
  // the window's own close (Escape, ×, outside) must stay the same function while one types: a new one each key makes
  // the window take the focus back (ui/modal), and a space typed then would press its ×
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => (dirtyRef.current ? setLeave(true) : closeRef.current()), []);
  useEffect(() => {
    if (added.current === null) return;
    document.getElementById(`pl-db-et${added.current}`)?.focus();
    added.current = null;
  }, [chapters.length]);
  return (
    <Modal
      title={t(k + (draft ? 'editDraftTitle' : 'editTitle'), { v: book.version })}
      onClose={close}
      wide
      footer={
        leave ? (
          <div className="pl-db-foot" role="alert">
            <span>{t(k + 'leave')}</span>
            <button type="button" className="btn small" onClick={onClose}>
              {t(k + 'leaveYes')}
            </button>
            <button type="button" className="btn primary small" onClick={() => setLeave(false)}>
              {t(k + 'stay')}
            </button>
          </div>
        ) : (
          <div className="pl-db-foot">
            <input dir="auto" maxLength={300} value={note} placeholder={t(k + 'note')} aria-label={t(k + 'note')} onChange={(e) => setNote(e.target.value)} />
            <span className={`pl-db-size ${total > MAX ? 'over' : ''}`}>{t(k + 'size', { n: n(total), max: n(MAX) })}</span>
            <button type="button" className="btn ghost small" onClick={close}>
              {t(k + 'cancel')}
            </button>
            <button
              type="button"
              className="btn primary small"
              disabled={!ok || save.isPending}
              onClick={() => save.mutate({ title: title.trim(), chapters: chapters.map((c) => ({ title: c.title.trim(), text: c.text.trim() })), ...(note.trim() ? { note: note.trim() } : {}) })}
            >
              {t(k + 'saveDraft')}
            </button>
          </div>
        )
      }
    >
      <div className="pl-db-edit">
        <p className="pl-db-help">{t(k + 'editHelp')}</p>
        <label className="pl-db-f">
          <span>{t(k + 'bookTitle')}</span>
          <input dir="auto" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        {chapters.map((c, i) => (
          <fieldset key={i} className="pl-db-ech">
            <legend className="sr-only">{t(k + 'chapterTitle', { l: mark(i) })}</legend>
            <div className="pl-db-eh">
              <span className="pl-db-l" aria-hidden="true">
                {mark(i)}
              </span>
              <input id={`pl-db-et${i}`} dir="auto" maxLength={140} value={c.title} aria-label={t(k + 'chapterTitle', { l: mark(i) })} placeholder={t(k + 'chapterTitle', { l: mark(i) })} onChange={(e) => put(i, 'title', e.target.value)} />
              <button type="button" className="btn ghost small" disabled={chapters.length < 2} aria-label={t(k + 'removeChapter', { l: mark(i) })} title={t(k + 'removeChapter', { l: mark(i) })} onClick={() => setChapters((cs) => cs.filter((_, j) => j !== i))}>
                <Icon name="trash" />
              </button>
            </div>
            <textarea dir="auto" rows={Math.min(16, Math.max(3, c.text.split('\n').length + 1))} maxLength={8000} value={c.text} aria-label={t(k + 'chapterText', { l: mark(i) })} onChange={(e) => put(i, 'text', e.target.value)} />
          </fieldset>
        ))}
        {chapters.length < 30 && (
          <button
            type="button"
            className="btn small pl-db-add"
            onClick={() => {
              added.current = chapters.length;
              setChapters((cs) => [...cs, { title: '', text: '' }]);
            }}
          >
            <Icon name="plus" /> {t(k + 'addChapter')}
          </button>
        )}
        <p className="pl-db-help">{t(k + 'lessonsNote')}</p>
      </div>
    </Modal>
  );
}

/** Every version, newest first: what changed, who, when; download one; go back to one (managers). */
function Versions({ versions, manager, busy, onDownload, onClose }: { versions: Version[]; manager: boolean; busy: boolean; onDownload: (v: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [ask, setAsk] = useState<number | null>(null);
  const back = usePilotAction('p.darija.restore', { success: (r) => t(k + 'restored', { v: r.version }), onDone: () => setAsk(null) });
  return (
    <Modal title={t(k + 'versionsTitle')} onClose={onClose} sheet>
      <ul className="pl-db-vs">
        {versions.map((v) => (
          <li key={v.version} className={v.live ? 'on' : undefined}>
            <div className="pl-db-vh">
              <b className="ltr">v{v.version}</b>
              {v.live && <span className="chip pp-chip-ok">{t(k + 'live')}</span>}
              <span className="pl-db-kind">{t(`${k}kind.${v.kind}`, { defaultValue: v.kind })}</span>
            </div>
            {v.note && (
              <p className="pl-db-vn" dir="auto">
                {v.note}
              </p>
            )}
            <small className="muted">
              <bdi>{v.by ?? '—'}</bdi> · <bdi>{dateTime(v.at)}</bdi> · <bdi>{t(k + 'chapters', { count: v.chapters, n: n(v.chapters) })}</bdi> · <bdi>{t(k + 'lessonsShort', { count: v.lessons, n: n(v.lessons) })}</bdi>
            </small>
            {ask === v.version ? (
              <div className="pl-db-ask" role="alert">
                <p>{t(k + 'restoreAsk', { v: v.version })}</p>
                <div className="pl-db-do">
                  <button type="button" className="btn primary small" disabled={back.isPending} onClick={() => back.mutate({ version: v.version })}>
                    {t(k + 'restoreYes', { v: v.version })}
                  </button>
                  <button type="button" className="btn ghost small" disabled={back.isPending} onClick={() => setAsk(null)}>
                    {t(k + 'cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="pl-db-do">
                <button type="button" className="btn ghost small" disabled={busy} onClick={() => onDownload(v.version)}>
                  <Icon name="download" /> {t(k + 'downloadV')}
                </button>
                {manager && !v.live && (
                  <button type="button" className="btn small" onClick={() => setAsk(v.version)}>
                    <Icon name="undo" /> {t(k + 'restore')}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
