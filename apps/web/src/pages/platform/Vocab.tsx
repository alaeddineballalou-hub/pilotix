// Pilot AI › Tester & leçons › Leçons › Vocabulaire: Pilotix's book of Algerian Darija words for the AI agents of every
// shop (modules/vocab.ts). Put the book in (a Markdown file, or pasted: its tables), search it, add or correct a word, see
// what the corrections taught (an accepted Darija lesson writes in it), and try which words a customer's message brings
// to Dellal: for each reply it reads only the words that touch the conversation.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { ConfirmButton } from '../admin/bits';
import { usePilotAction, usePilotCall, usePilotRpc } from './pilotDemo';

type Word = POut<'p.vocab.list'>['rows'][number];
type Source = '' | 'book' | 'learned' | 'coach';
type Draft = { ar: string; lat: string; meaning: string; topic: string; avoid: string };
const SOURCES: Source[] = ['', 'book', 'learned', 'coach'];
const K = 'platform.pilot.lab.vocab.';
/** the topic select's value for the words with no topic (an empty value is « all the topics ») */
const NONE = '\u2205';
const PAGE_MAX = 1000;

export function VocabPane({ manager }: { manager: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [topic, setTopic] = useState('');
  const [source, setSource] = useState<Source>('');
  const [limit, setLimit] = useState(100);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [importing, setImporting] = useState<boolean | null>(null);
  const list = usePilotRpc('p.vocab.list', { ...(q.trim() ? { q: q.trim() } : {}), ...(topic ? { topic: topic === NONE ? '' : topic } : {}), ...(source ? { source } : {}), limit });
  const d = list.data;
  const c = d?.counts;
  const showImport = manager && !!c && (importing ?? !c.total);
  return (
    <div className="pl-dj pl-vc">
      <p className="small muted pl-lab-kind-note">{t(K + 'help')}</p>
      {c && (
        <div className="pl-vc-head">
          <p className="pl-vc-counts">
            <b>{t(K + 'count', { count: c.total, n: n(c.total) })}</b>
            {c.learned > 0 && <span className="chip">{t(K + 'learned', { count: c.learned, n: n(c.learned) })}</span>}
            {c.coach > 0 && <span className="chip">{t(K + 'coach', { count: c.coach, n: n(c.coach) })}</span>}
          </p>
          {manager && !showImport && (
            <button type="button" className="btn small" onClick={() => setImporting(true)}>
              <Icon name="upload" /> {t(K + 'importTitle')}
            </button>
          )}
        </div>
      )}
      {showImport && <ImportBook canClose={!!c?.total} onClose={() => setImporting(false)} />}
      <TryWords />
      <section>
        <h3>{t(K + 'listTitle')}</h3>
        <div className="pl-vc-tools">
          <label className="pl-vc-search">
            <Icon name="search" />
            <input type="search" dir="auto" value={q} placeholder={t(K + 'search')} aria-label={t(K + 'search')} onChange={(e) => (setQ(e.target.value), setLimit(100))} />
          </label>
          {!!c?.topics.length && (
            <select value={topic} aria-label={t(K + 'topic')} onChange={(e) => (setTopic(e.target.value), setLimit(100))}>
              <option value="">{t(K + 'allTopics')}</option>
              {c.topics.map((x) => (
                <option key={x.topic} value={x.topic || NONE}>
                  {x.topic || t(K + 'noTopic')} ({n(x.n)})
                </option>
              ))}
            </select>
          )}
          <div className="pl-vc-src" role="group" aria-label={t(K + 'source')}>
            {SOURCES.map((s) => (
              <button key={s || 'all'} type="button" className={`pl-vc-pill ${source === s ? 'on' : ''}`} aria-pressed={source === s} onClick={() => (setSource(s), setLimit(100))}>
                {t(K + `src.${s || 'all'}`)}
              </button>
            ))}
          </div>
          {manager && editing !== 'new' && (
            <button type="button" className="btn small" onClick={() => setEditing('new')}>
              <Icon name="plus" /> {t(K + 'add')}
            </button>
          )}
        </div>
        {editing === 'new' && <WordForm value={{ ar: '', lat: '', meaning: '', topic: topic === NONE ? '' : topic, avoid: '' }} onDone={() => setEditing(null)} />}
        {list.isLoading ? (
          <p className="muted">{t('platform.pilot.lab.try.loading')}</p>
        ) : list.error || !d ? (
          <p className="pl-lab-err" role="alert">
            <Icon name="alert" /> {list.error?.message}
          </p>
        ) : !d.rows.length ? (
          <p className="pl-next-empty">{q || topic || source ? t(K + 'emptySearch') : t(K + 'empty')}</p>
        ) : (
          <>
            <div className="pl-vc-list">
              {byTopic(d.rows).map((g, gi) => (
                <section key={gi} className="pl-vc-group" aria-label={g.topic || t(K + 'noTopic')}>
                  {!topic && (
                    <h4>
                      <bdi>{g.topic || t(K + 'noTopic')}</bdi>
                    </h4>
                  )}
                  <ul>
                    {g.rows.map((w) =>
                      editing === w.id ? (
                        <li key={w.id} className="pl-vc-editing">
                          <WordForm id={w.id} value={w} onDone={() => setEditing(null)} />
                        </li>
                      ) : (
                        <WordRow key={w.id} w={w} manager={manager} onEdit={() => setEditing(w.id)} />
                      ),
                    )}
                  </ul>
                </section>
              ))}
            </div>
            {d.total > d.rows.length &&
              (limit < PAGE_MAX ? (
                <button type="button" className="btn ghost small pl-vc-more" onClick={() => setLimit(Math.min(PAGE_MAX, limit + 100))}>
                  {t(K + 'more', { shown: n(d.rows.length), total: n(d.total) })}
                </button>
              ) : (
                <p className="small muted pl-vc-more">{t(K + 'moreSearch', { shown: n(d.rows.length), total: n(d.total) })}</p>
              ))}
          </>
        )}
      </section>
    </div>
  );
}

/** the rows of a page, a group each time the topic changes (the book's order: its chapters stay together) */
function byTopic(rows: Word[]): { topic: string; rows: Word[] }[] {
  const out: { topic: string; rows: Word[] }[] = [];
  for (const w of rows) {
    const last = out[out.length - 1];
    if (last && last.topic === w.topic) last.rows.push(w);
    else out.push({ topic: w.topic, rows: [w] });
  }
  return out;
}

function WordRow({ w, manager, onEdit }: { w: Word; manager: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const remove = usePilotAction('p.vocab.remove', { success: t(K + 'removed') });
  const mark = w.source !== 'book' ? t(K + `src.${w.source}`) : w.lahjaId ? t(K + 'changed') : '';
  return (
    <li className="pl-vc-row">
      <div className="pl-vc-entry">
        <p className="pl-vc-word">
          {w.ar && (
            <span className="pl-vc-ar" dir="rtl" lang="ar">
              {w.ar}
            </span>
          )}
          {w.lat && (
            <span className="pl-vc-lat" dir="ltr">
              {w.lat}
            </span>
          )}
          {mark && <span className="chip pp-chip-ok">{mark}</span>}
        </p>
        {(w.meaning || w.avoid) && (
          <p className="pl-vc-mean">
            {w.meaning && <bdi>{w.meaning}</bdi>}
            {w.avoid && (
              <span className="pl-vc-avoid">
                {t(K + 'not')} <bdi>{w.avoid}</bdi>
              </span>
            )}
          </p>
        )}
      </div>
      {manager && (
        <span className="pl-vc-acts">
          <button type="button" className="btn ghost small" aria-label={t(K + 'edit')} title={t(K + 'edit')} onClick={onEdit}>
            <Icon name="pencil" />
          </button>
          <ConfirmButton className="btn ghost small" question={t(K + 'removeAsk')} onConfirm={() => remove.mutate({ id: w.id })} disabled={remove.isPending}>
            <Icon name="trash" />
          </ConfirmButton>
        </span>
      )}
    </li>
  );
}

/** A word written or corrected by Pilotix: used at once by every shop. */
function WordForm({ id, value, onDone }: { id?: number; value: Draft; onDone: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState<Draft>({ ar: value.ar, lat: value.lat, meaning: value.meaning, topic: value.topic, avoid: value.avoid });
  const save = usePilotAction('p.vocab.save', { success: t(K + 'saved'), onDone });
  const put = (k: keyof Draft, v: string) => setF({ ...f, [k]: v });
  const field = (k: keyof Draft, dir: 'rtl' | 'ltr' | 'auto') => (
    <label>
      <span>{t(K + `col.${k}`)}</span>
      <input dir={dir} lang={k === 'ar' ? 'ar' : undefined} maxLength={200} value={f[k]} onChange={(e) => put(k, e.target.value)} />
    </label>
  );
  return (
    <div className="pl-vc-form">
      {field('ar', 'rtl')}
      {field('lat', 'ltr')}
      {field('meaning', 'auto')}
      {field('topic', 'auto')}
      {field('avoid', 'auto')}
      <div className="pl-vc-form-do">
        <button type="button" className="btn primary small" disabled={save.isPending || (!f.ar.trim() && !f.lat.trim())} onClick={() => save.mutate({ ...(id ? { id } : {}), ...f })}>
          {t(K + 'save')}
        </button>
        <button type="button" className="btn ghost small" onClick={onDone}>
          {t(K + 'cancel')}
        </button>
      </div>
    </div>
  );
}

/** Pilotix's book in: a Markdown file or pasted text (its tables). */
function ImportBook({ canClose, onClose }: { canClose: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [file, setFile] = useState('');
  const [replace, setReplace] = useState(false);
  const imp = usePilotAction('p.vocab.import', {
    success: (r) => t(K + 'imported', { added: n(r.added), skipped: n(r.skipped), unsure: n(r.unsure) }),
    onDone: () => (setText(''), setFile('')),
  });
  const read = (fl: File | undefined) => {
    if (!fl) return;
    if (fl.size > 800_000) return toast(t(K + 'tooBig'), 'bad');
    const r = new FileReader();
    r.onload = () => (setText(String(r.result ?? '')), setFile(fl.name));
    r.readAsText(fl);
  };
  return (
    <section className="pl-vc-import">
      <h3>{t(K + 'importTitle')}</h3>
      <p className="small muted">{t(K + 'importHelp')}</p>
      <div className="pl-vc-import-row">
        <label className="btn small">
          <Icon name="upload" /> {t(K + 'file')}
          <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => read(e.target.files?.[0])} />
        </label>
        {file && <span className="small">{file}</span>}
      </div>
      <textarea rows={6} dir="ltr" value={text} placeholder={t(K + 'pastePh')} aria-label={t(K + 'pastePh')} onChange={(e) => (setText(e.target.value), setFile(''))} />
      <label className="pl-vc-check">
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> {t(K + 'replace')}
      </label>
      <div className="pl-dj-do">
        <button type="button" className="btn primary small" disabled={imp.isPending || !text.trim()} onClick={() => imp.mutate({ text, replace })}>
          {t(K + 'import')}
        </button>
        {canClose && (
          <button type="button" className="btn ghost small" onClick={onClose}>
            {t(K + 'cancel')}
          </button>
        )}
      </div>
    </section>
  );
}

/** Try it: the words of the book a customer's message brings to Dellal. */
function TryWords() {
  const { t } = useTranslation();
  const call = usePilotCall();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState<Word[] | null>(null);
  const go = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setWords((await call('p.vocab.try', { text })).words);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pl-vc-try">
      <h3>{t(K + 'tryTitle')}</h3>
      <form
        className="pl-vc-try-row"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input dir="auto" value={text} placeholder={t(K + 'tryPh')} aria-label={t(K + 'tryTitle')} onChange={(e) => (setText(e.target.value), setWords(null))} />
        <button type="submit" className="btn small" disabled={busy || !text.trim()}>
          {t(K + 'try')}
        </button>
      </form>
      {words &&
        (words.length ? (
          <>
            <p className="small muted">{t(K + 'tryHelp', { count: words.length, n: n(words.length) })}</p>
            <ul className="pl-vc-tried">
              {words.map((w) => (
                <li key={w.id}>
                  {w.ar && (
                    <b dir="rtl" lang="ar">
                      {w.ar}
                    </b>
                  )}
                  {w.lat && <b dir="ltr">{w.lat}</b>}
                  {w.meaning && <span dir="auto">{w.meaning}</span>}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="small muted">{t(K + 'tryNone')}</p>
        ))}
    </section>
  );
}
