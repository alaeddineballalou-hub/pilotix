// « CM AI agent »: the community manager. The comments under the shop's Facebook and Instagram posts and ads, and what
// the agent did with each one (public reply, private message that opens a conversation in Message AI agent, hidden);
// the posts and the product each one sells, a tester, the results and the settings (admin).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, Out, rpc, serverUrl } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { openOrderForm } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { CopyCode } from '../../ui/CopyCode';
import { Card, ErrorBox, Field, Help, Icon, Kpi, Kpis, Loading, Tabs } from '../../ui/kit';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import '../messages/messages.css';
import './cm.css';

type Channel = 'facebook' | 'instagram' | 'tiktok';
type FeedTab = 'todo' | 'answered' | 'hidden' | 'all';
type Comment = Out<'cm.feed'>['rows'][number];
const CH_SHORT: Record<Channel, string> = { facebook: 'FB', instagram: 'IG', tiktok: 'TT' };
const CH_CLASS: Record<Channel, string> = { facebook: 'dl-messenger', instagram: 'dl-instagram', tiktok: 'dl-tiktok' };

function CmBadge({ ch }: { ch: Channel }) {
  const { t } = useTranslation();
  return (
    <span className={`dl-ch ${CH_CLASS[ch]}`} title={t(`cm.ch.${ch}`)}>
      {CH_SHORT[ch]}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = { new: 'cm-new', answered: 'cm-ok', hidden: 'cm-mute', handoff: 'cm-warn', ignored: 'cm-mute', error: 'cm-bad' };

export function Cm({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const keys = ['commentaires', 'publications', 'tester', 'resultats', ...(admin ? ['reglages'] : [])];
  const current = keys.includes(sub ?? '') ? sub! : 'commentaires';
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>
            {t('cm.title')}
            <Help text={t('cm.help')} label={t('cm.title')} />
          </h2>
          <div className="tabs" role="tablist">
            {keys.map((k) => (
              <a key={k} role="tab" aria-selected={current === k} className={`tab ${current === k ? 'on' : ''}`} href={`#/cm/${k}`} style={{ textDecoration: 'none' }}>
                {t(`cm.tabs.${k}`)}
              </a>
            ))}
          </div>
        </div>
      </div>
      {current === 'commentaires' && <Feed postId={rest?.[0] ? Number(rest[0]) || null : null} />}
      {current === 'publications' && <Posts />}
      {current === 'tester' && <Tester />}
      {current === 'resultats' && <Results />}
      {current === 'reglages' && <Settings />}
    </>
  );
}

// ---------------------------------------------------------------- comments
function Feed({ postId }: { postId: number | null }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const [tab, setTab] = useState<FeedTab>(postId ? 'all' : 'todo');
  const [channel, setChannel] = useState<Channel | ''>('');
  const [post, setPost] = useState<number | ''>(postId ?? '');
  const [q, setQ] = useState('');
  const [bulk, setBulk] = useState<{ done: number; count: number } | null>(null);
  useEffect(() => setPost(postId ?? ''), [postId]);
  const list = useRpc('cm.feed', { tab, channel: channel || undefined, postId: post || undefined, q: q.trim() || undefined }, { refetchInterval: 15_000 });
  const d = list.data;
  const fresh = (d?.rows ?? []).filter((c) => c.status === 'new');
  // "Laisser CM AI répondre aux nouveaux": one after the other (each answer from Claude can take a while)
  const runAll = async () => {
    const ids = fresh.map((c) => c.id);
    setBulk({ done: 0, count: ids.length });
    let ok = 0;
    for (const [i, id] of ids.entries()) {
      try {
        await rpc('cm.answer', { id });
        ok++;
      } catch (e: any) {
        toast(e?.message ?? 'Erreur', 'bad');
      }
      setBulk({ done: i + 1, count: ids.length });
      await list.refetch();
    }
    setBulk(null);
    toast(t('cm.feed.bulkDone', { count: ok }), 'ok');
  };
  return (
    <>
      {d && !d.enabled && (
        <div className="warnbox" style={{ marginBottom: 12 }}>
          {t('cm.off')} {session?.isAdmin && <a href="#/cm/reglages">{t('cm.offLink')}</a>}
        </div>
      )}
      <Card>
        <div className="cm-filters">
          <Tabs<FeedTab>
            value={tab}
            onChange={setTab}
            items={[
              { value: 'todo', label: t('cm.feed.todo'), count: d?.counts.todo },
              { value: 'answered', label: t('cm.feed.answered'), count: d?.counts.answered },
              { value: 'hidden', label: t('cm.feed.hidden'), count: d?.counts.hidden },
              { value: 'all', label: t('cm.feed.all'), count: d?.counts.all },
            ]}
          />
          <div className="row cm-filter-row">
            <input type="search" className="grow" placeholder={t('cm.feed.search')} aria-label={t('cm.feed.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label={t('cm.feed.channel')} value={channel} onChange={(e) => setChannel(e.target.value as Channel | '')}>
              <option value="">{t('cm.feed.allChannels')}</option>
              {(['facebook', 'instagram'] as Channel[]).map((c) => (
                <option key={c} value={c}>
                  {t(`cm.ch.${c}`)}
                </option>
              ))}
            </select>
            <select aria-label={t('cm.feed.post')} value={post} onChange={(e) => setPost(e.target.value ? Number(e.target.value) : '')} className="cm-post-select">
              <option value="">{t('cm.feed.allPosts')}</option>
              {(d?.posts ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {CH_SHORT[p.channel]} · {(p.caption ?? t('cm.posts.noCaption')).slice(0, 60)}
                </option>
              ))}
            </select>
          </div>
          {fresh.length > 0 && (
            <div className="cm-bulk">
              <button type="button" className="btn primary small" disabled={!!bulk} onClick={runAll}>
                <Icon name="sparkles" /> {bulk ? t('cm.feed.bulkRun', { done: bulk.done, count: bulk.count }) : t('cm.feed.bulk', { count: fresh.length })}
              </button>
              {backend.kind === 'demo' && <small className="muted">{t('cm.feed.demoNote')}</small>}
            </div>
          )}
        </div>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !d?.rows.length ? (
          <p className="bjr-empty">{t('cm.feed.empty')}</p>
        ) : (
          <div className="cm-list">
            {d.rows.map((c) => (
              <CommentCard key={c.id} c={c} busy={!!bulk} />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function CommentCard({ c, busy }: { c: Comment; busy: boolean }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const [mode, setMode] = useState<'reply' | 'private' | null>(null);
  const [text, setText] = useState('');
  const [reveal, setReveal] = useState(false);
  const done = (r: { sendError?: string | null }) => {
    if (r.sendError) toast(r.sendError, 'bad');
    else {
      setMode(null);
      setText('');
    }
  };
  const answer = useAction('cm.answer', { onDone: (r) => r.skipped && toast(r.skipped, 'bad') });
  const reply = useAction('cm.reply', { onDone: done });
  const priv = useAction('cm.private', { onDone: done });
  const hide = useAction('cm.hide', { onDone: (r) => r.sendError && toast(r.sendError, 'bad') });
  const ignore = useAction('cm.ignore', {});
  const working = busy || answer.isPending || reply.isPending || priv.isPending || hide.isPending || ignore.isPending;
  const open = c.status === 'new' || c.status === 'handoff' || c.status === 'error';
  const junk = c.intent === 'spam' || c.intent === 'insult';
  const blur = c.hidden && !reveal;
  const by = c.by === 'team' ? (c.handledBy ? t('cm.by.teamName', { name: c.handledBy }) : t('cm.by.team')) : c.by ? t(`cm.by.${c.by}`) : null;
  const submit = () => {
    const v = text.trim();
    if (!v) return;
    if (mode === 'reply') reply.mutate({ id: c.id, body: v });
    if (mode === 'private') priv.mutate({ id: c.id, body: v });
  };
  return (
    <article className={`cm-card ${open ? 'cm-open' : ''}`} aria-busy={answer.isPending}>
      <header className="cm-head">
        <CmBadge ch={c.channel} />
        <span className="cm-who">
          <b>{c.authorName ?? t('cm.feed.someone')}</b>
          <small className="muted">
            {when(c.at)}
            {c.post && (
              <>
                {' · '}
                <a href={`#/cm/commentaires/${c.postId}`} className="cm-under" title={c.post.caption ?? ''}>
                  {t('cm.feed.under', { caption: (c.post.caption ?? t('cm.posts.noCaption')).slice(0, 48) })}
                </a>
                {c.post.isAd && <span className="cm-ad">{t('cm.feed.ad')}</span>}
              </>
            )}
          </small>
        </span>
        <span className={`cm-status ${STATUS_TONE[c.status] ?? ''}`}>{t(`cm.status.${c.status}`)}</span>
      </header>
      <p className={`cm-body ${blur ? 'cm-blur' : ''}`} dir="auto">
        {c.body}
      </p>
      {c.hidden && (
        <button type="button" className="linkbtn small" onClick={() => setReveal(!reveal)}>
          {reveal ? t('cm.feed.hideText') : t('cm.feed.showText')}
        </button>
      )}
      <div className="cm-tags">
        {c.intent && <span className={`cm-intent cm-i-${c.intent}`}>{t(`cm.intent.${c.intent}`)}</span>}
        {by && <span className="cm-by">{by}</span>}
        {c.phone && (
          <span className="cm-phone ltr">
            <Icon name="phone" /> {c.phone}
          </span>
        )}
      </div>
      {(c.publicReply || c.privateReply || c.hidden || c.reason || c.sendError) && (
        <div className="cm-acts">
          {c.publicReply && (
            <div className="cm-act">
              <Icon name="reply" />
              <span>
                <small>{t('cm.feed.public')}</small>
                <span dir="auto">{c.publicReply}</span>
              </span>
            </div>
          )}
          {c.privateReply && (
            <div className="cm-act">
              <Icon name="mail" />
              <span>
                <small>
                  {t('cm.feed.private')}
                  {c.conversationId && has('confirmation') && (
                    <>
                      {' · '}
                      <a href={`#/messages/inbox/${c.conversationId}`}>{t('cm.feed.openConv')}</a>
                    </>
                  )}
                </small>
                <span dir="auto">{c.privateReply}</span>
              </span>
            </div>
          )}
          {c.hidden && (
            <div className="cm-act">
              <Icon name="eyeoff" />
              <span>
                <small>{t('cm.feed.hiddenBy')}</small>
                <span>{c.intent === 'spam' || c.intent === 'insult' ? c.reason : c.phone ? t('cm.feed.hiddenPhone') : c.intent === 'complaint' ? t('cm.feed.hiddenRude') : c.reason ?? '—'}</span>
              </span>
            </div>
          )}
          {c.reason && !c.hidden && (
            <p className="cm-reason">
              {t('cm.feed.reason')} : {c.reason}
            </p>
          )}
          {c.sendError && <p className="dl-err">⚠ {c.sendError}</p>}
        </div>
      )}
      {mode && (
        <div className="cm-editor">
          <textarea rows={2} autoFocus value={text} maxLength={1000} placeholder={mode === 'reply' ? t('cm.feed.replyPh') : t('cm.feed.privatePh')} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" className="btn small ghost" onClick={() => setMode(null)}>
              {t('cm.feed.cancel')}
            </button>
            <button type="button" className="btn small primary" disabled={!text.trim() || working} onClick={submit}>
              <Icon name="send" /> {t('cm.feed.send')}
            </button>
          </div>
        </div>
      )}
      <footer className="cm-foot">
        {(c.status === 'new' || c.status === 'error') && (
          <button type="button" className="btn small primary" disabled={working} onClick={() => answer.mutate({ id: c.id })}>
            <Icon name="sparkles" /> {answer.isPending ? t('cm.feed.answering') : t('cm.feed.answer')}
          </button>
        )}
        {c.status === 'handoff' && (
          <button type="button" className="btn small ok" disabled={working} onClick={() => ignore.mutate({ id: c.id, done: true })}>
            <Icon name="check" /> {t('cm.feed.done')}
          </button>
        )}
        {!c.hidden && (
          <button type="button" className="btn small" disabled={working} onClick={() => setMode(mode === 'reply' ? null : 'reply')}>
            <Icon name="reply" /> {t('cm.feed.reply')}
          </button>
        )}
        {!c.privateSent && !junk && c.channel !== 'tiktok' && (
          <button type="button" className="btn small" disabled={working} onClick={() => setMode(mode === 'private' ? null : 'private')}>
            <Icon name="mail" /> {t('cm.feed.privateBtn')}
          </button>
        )}
        <button type="button" className="btn small ghost" disabled={working} onClick={() => hide.mutate({ id: c.id, hidden: !c.hidden })}>
          <Icon name={c.hidden ? 'eye' : 'eyeoff'} /> {c.hidden ? t('cm.feed.show') : t('cm.feed.hide')}
        </button>
        {(c.status === 'new' || c.status === 'error') && (
          <button type="button" className="btn small ghost" disabled={working} onClick={() => ignore.mutate({ id: c.id })}>
            {t('cm.feed.ignore')}
          </button>
        )}
        {c.phone && has('confirmation', 'suivi', 'depot') && (
          <button
            type="button"
            className="btn small ok"
            onClick={() =>
              openOrderForm({
                prefill: {
                  customerName: c.authorName?.replace(/^@/, '') ?? '',
                  phone: c.phone,
                  channel: c.channel === 'instagram' ? 'instagram' : 'facebook',
                  items: c.post?.productId ? [{ productId: c.post.productId, qty: 1 }] : [],
                  internalNote: t('cm.feed.orderNote', { text: c.body.slice(0, 200) }),
                },
              })
            }
          >
            <Icon name="plus" /> {t('cm.feed.createOrder')}
          </button>
        )}
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------- posts
function Posts() {
  const { t } = useTranslation();
  const q = useRpc('cm.posts', {});
  const link = useAction('cm.linkPost', { success: t('cm.posts.saved') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const { rows, products } = q.data;
  return (
    <Card title={t('cm.posts.title')} help={t('cm.posts.help')}>
      {!rows.length ? (
        <p className="bjr-empty">{t('cm.posts.empty')}</p>
      ) : (
        <div className="cm-posts">
          {rows.map((p) => (
            <div key={p.id} className="cm-post">
              <CmBadge ch={p.channel} />
              <div className="cm-post-main">
                <p className="cm-caption" dir="auto">
                  {p.caption ?? <span className="muted">{t('cm.posts.noCaption')}</span>}
                </p>
                <small className="muted">
                  {p.isAd && <span className="cm-ad">{t('cm.feed.ad')}</span>} {t('cm.posts.comments', { count: p.comments })}
                  {p.todo > 0 && (
                    <>
                      {' · '}
                      <b className="cm-todo">{t('cm.posts.todo', { count: p.todo })}</b>
                    </>
                  )}
                  {p.lastAt && <> · {when(p.lastAt)}</>}
                  {' · '}
                  <a href={`#/cm/commentaires/${p.id}`}>{t('cm.posts.see')}</a>
                  {p.permalink && (
                    <>
                      {' · '}
                      <a href={p.permalink} target="_blank" rel="noreferrer">
                        {t('cm.posts.open', { ch: t(`cm.ch.${p.channel}`) })}
                      </a>
                    </>
                  )}
                </small>
              </div>
              <Field label={t('cm.posts.product')}>
                <select value={p.productId ?? ''} disabled={link.isPending} onChange={(e) => link.mutate({ id: p.id, productId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t('cm.posts.none')}</option>
                  {products.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} · {da(x.price)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- tester
type TestResult = Out<'cm.test'> & { body: string; post: string | null };

function Seconds() {
  const { t } = useTranslation();
  const [s, setS] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = window.setInterval(() => setS(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="muted">{t('cm.tester.running', { s })}</span>;
}

function Tester() {
  const { t } = useTranslation();
  const posts = useRpc('cm.posts', {});
  const [postId, setPostId] = useState<number | ''>('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [results, setResults] = useState<TestResult[]>([]);
  const rows = posts.data?.rows ?? [];
  useEffect(() => {
    if (postId === '' && rows[0]) setPostId(rows[0].id);
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const caption = (id: number | '') => (id ? rows.find((p) => p.id === id)?.caption ?? null : null);
  /** the comment being tested, shown with its result */
  const asked = useRef<{ body: string; post: string | null }>({ body: '', post: null });
  const test = useAction('cm.test', { onDone: (r) => setResults((x) => [{ ...r, ...asked.current }, ...x].slice(0, 8)) });
  const quick = t('cm.tester.quick', { returnObjects: true }) as string[];
  const run = (text = body) => {
    const v = text.trim();
    if (!v || test.isPending) return;
    setBody(v);
    asked.current = { body: v, post: caption(postId) };
    test.mutate({ body: v, postId: postId || null, authorName: name.trim() || undefined });
  };
  const last = results[0];
  return (
    <>
      <Card title={t('cm.tester.title')}>
        <p className="muted small">{t('cm.tester.help')}</p>
        {last && last.by === 'demo' && <div className="warnbox" style={{ margin: '8px 0' }}>{t(backend.kind === 'demo' ? 'cm.tester.demoPreview' : 'cm.tester.demoNoKey')}</div>}
        {last && last.by === 'ai' && backend.kind === 'demo' && (
          <div className="okbox" style={{ margin: '8px 0', fontWeight: 500 }}>
            {t('cm.tester.inPage')}
          </div>
        )}
        <div className="grid2">
          <Field label={t('cm.tester.post')}>
            <select value={postId} onChange={(e) => setPostId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">{t('cm.tester.noPost')}</option>
              {rows.map((p) => (
                <option key={p.id} value={p.id}>
                  {CH_SHORT[p.channel]} · {(p.caption ?? t('cm.posts.noCaption')).slice(0, 70)}
                  {p.productName ? ` (${p.productName})` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('cm.tester.name')}>
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Amina B." />
          </Field>
          <Field label={t('cm.tester.comment')} wide>
            <textarea
              rows={2}
              dir="auto"
              value={body}
              maxLength={1500}
              placeholder={t('cm.tester.commentPh')}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  run();
                }
              }}
            />
          </Field>
        </div>
        <div className="bjr-qr cm-quick">
          {quick.map((x) => (
            <button key={x} type="button" disabled={test.isPending} onClick={() => run(x)} dir="auto">
              {x}
            </button>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 10 }}>
          {test.isPending && <Seconds />}
          <button type="button" className="btn primary" disabled={!body.trim() || test.isPending} onClick={() => run()}>
            <Icon name="sparkles" /> {t('cm.tester.run')}
          </button>
        </div>
      </Card>
      {results.map((r, i) => (
        <TestCard key={results.length - i} r={r} />
      ))}
    </>
  );
}

function TestCard({ r }: { r: TestResult }) {
  const { t } = useTranslation();
  const d = r.decision;
  const fixed = [...(r.darija.public?.issues ?? []), ...(r.darija.private?.issues ?? [])].map((x) => x.found);
  const nothing = !d.hide && !d.publicReply && !d.privateReply && !d.handoff;
  return (
    <Card className="cm-test">
      <div className="cm-test-q">
        <span className="muted small">{r.post ? t('cm.feed.under', { caption: r.post.slice(0, 60) }) : t('cm.tester.noPost')}</span>
        <p className="cm-body" dir="auto">
          {r.body}
        </p>
      </div>
      <div className="cm-tags">
        <span className={`cm-intent cm-i-${d.intent}`}>{t(`cm.intent.${d.intent}`)}</span>
        <span className="cm-by">{t(`cm.by.${r.by}`)}</span>
        {r.model && <span className="cm-by ltr">{r.model}</span>}
      </div>
      <h3 className="cm-h3">{t('cm.tester.result')}</h3>
      {nothing && <p className="muted">{t('cm.tester.nothing')}</p>}
      <div className="cm-acts">
        {d.hide && (
          <div className="cm-act">
            <Icon name="eyeoff" />
            <span>
              <small>{t('cm.tester.would.hide')}</small>
              <span>{d.reason}</span>
            </span>
          </div>
        )}
        {d.publicReply && (
          <div className="cm-act">
            <Icon name="reply" />
            <span>
              <small>{t('cm.tester.would.public')}</small>
              <span dir="auto">{d.publicReply}</span>
            </span>
          </div>
        )}
        {d.privateReply && (
          <div className="cm-act">
            <Icon name="mail" />
            <span>
              <small>{t('cm.tester.would.private')}</small>
              <span dir="auto">{d.privateReply}</span>
            </span>
          </div>
        )}
        {d.handoff && (
          <div className="cm-act cm-act-warn">
            <Icon name="users" />
            <span>
              <small>{t('cm.tester.would.handoff')}</small>
              <span>{d.reason}</span>
            </span>
          </div>
        )}
        {!d.hide && !d.handoff && d.reason && (
          <p className="cm-reason">
            {t('cm.feed.reason')} : {d.reason}
          </p>
        )}
        {r.by === 'rule' && <p className="cm-reason">{t('cm.tester.rule')}</p>}
        {fixed.length > 0 && <p className="cm-reason">{t('cm.tester.darija', { words: fixed.join(', ') })}</p>}
      </div>
      <dl className="dl-kv cm-facts">
        <dt>{t('cm.tester.language')}</dt>
        <dd>{t(`cm.tester.lang.${r.facts.lang}`)}</dd>
        <dt>{t('cm.tester.product')}</dt>
        <dd>{r.facts.product ?? '—'}</dd>
        <dt>{t('cm.tester.place')}</dt>
        <dd>{r.facts.place ?? '—'}</dd>
        {r.facts.phone && (
          <>
            <dt>{t('cm.tester.phone')}</dt>
            <dd className="ltr">{r.facts.phone}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------- results
function Results() {
  const { t } = useTranslation();
  const [days, setDays] = useState(7);
  const q = useRpc('cm.stats', { days });
  const s = q.data;
  const max = Math.max(1, ...(s?.intents ?? []).map((x) => x.n));
  return (
    <Card
      title={t('cm.results.title')}
      actions={
        <select aria-label={t('cm.results.period')} value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
          {[1, 7, 30, 90].map((d) => (
            <option key={d} value={d}>
              {t('cm.results.days', { count: d })}
            </option>
          ))}
        </select>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error || !s ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <Kpis>
            <Kpi icon="comments" label={t('cm.results.total')} value={n(s.total)} sub={t('cm.results.todo', { count: s.todo })} tone={s.todo ? 'warn' : undefined} />
            <Kpi icon="sparkles" label={t('cm.results.byAi')} value={n(s.byAi)} rate={s.total ? s.byAi / s.total : null} sub={t('cm.results.byTeam', { count: s.byTeam })} />
            <Kpi icon="mail" label={t('cm.results.private')} value={n(s.private)} sub={t('cm.results.replied', { count: s.replied })} />
            <Kpi icon="receipt" label={t('cm.results.orders')} value={n(s.orders)} sub={da(s.amount)} tone="ok" />
          </Kpis>
          <Kpis>
            <Kpi icon="ban" label={t('cm.results.hidden')} value={n(s.hidden)} sub={t('cm.results.hiddenSub', { count: s.phones })} />
            <Kpi icon="timer" label={t('cm.results.speed')} value={t('cm.results.speedV', { m: String(s.avgMinutes).replace('.', ',') })} />
            <Kpi icon="truck" label={t('cm.results.delivered')} value={n(s.delivered)} rate={s.orders ? s.delivered / s.orders : null} />
          </Kpis>
          <h3 className="cm-h3">{t('cm.results.intents')}</h3>
          <div className="cm-bars">
            {s.intents.map((x) => (
              <div key={x.intent} className="cm-bar-row">
                <span className={`cm-intent cm-i-${x.intent}`}>{t(`cm.intent.${x.intent}`)}</span>
                <span className="cm-bar">
                  <span style={{ width: `${(x.n / max) * 100}%` }} />
                </span>
                <b className="ltr">{n(x.n)}</b>
              </div>
            ))}
          </div>
          <p className="muted small">{t('cm.results.note')}</p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- settings (admin)
function Settings() {
  const q = useRpc('cm.settings.get', {});
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <SettingsForm key={JSON.stringify(q.data.settings)} data={q.data} />;
}

function SettingsForm({ data }: { data: NonNullable<ReturnType<typeof useRpc<'cm.settings.get'>>['data']> }) {
  const { t } = useTranslation();
  const [f, setF] = useState(data.settings);
  const save = useAction('cm.settings.save', { success: t('cm.settings.saved') });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const m = data.meta;
  const base = serverUrl() || (backend.kind === 'demo' ? 'https://votre-serveur.dz' : window.location.origin);
  const sw = (k: 'enabled' | 'replyPublic' | 'showPrice' | 'sendPrivate' | 'hideSpam' | 'hidePhones' | 'nightReplies') => (
    <label className="dl-switch">
      <input type="checkbox" checked={f[k]} onChange={(e) => set(k, e.target.checked)} />
      <span>
        <b>{t(`cm.settings.${k}`)}</b>
        <small>{t(`cm.settings.${k}Hint`)}</small>
      </span>
    </label>
  );
  return (
    <>
      <Card title={t('cm.settings.how')}>
        {sw('enabled')}
        {sw('replyPublic')}
        {sw('showPrice')}
        {sw('sendPrivate')}
        {sw('hideSpam')}
        {sw('hidePhones')}
        {sw('nightReplies')}
        <div className="grid2">
          <Field label={t('cm.settings.delay')} hint={t('cm.settings.delayHint')}>
            <select value={f.delaySec} onChange={(e) => set('delaySec', Number(e.target.value))}>
              {[0, 30, 60, 120, 300, 600].map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? t('cm.settings.now') : s < 60 ? t('cm.settings.sec', { count: s }) : t('cm.settings.min', { count: s / 60 })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('cm.settings.tone')}>
            <input value={f.tone} maxLength={400} onChange={(e) => set('tone', e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card title={t('cm.settings.rules')}>
        <Field label={t('cm.settings.notes')} hint={t('cm.settings.notesHint')} wide>
          <textarea rows={4} maxLength={4000} value={f.notes} placeholder={t('cm.settings.notesPh')} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        <Field label={t('cm.settings.banned')} hint={t('cm.settings.bannedHint')} wide>
          <textarea rows={3} maxLength={2000} className="ltr" value={f.banned} placeholder={t('cm.settings.bannedPh')} onChange={(e) => set('banned', e.target.value)} />
        </Field>
      </Card>

      <Card title={t('cm.settings.channels')} help={t('cm.settings.channelsHelp')}>
        <div className="cm-chans">
          {(['facebook', 'instagram', 'tiktok'] as Channel[]).map((c) => (
            <label key={c} className={`dl-switch ${c === 'tiktok' ? 'cm-soon' : ''}`}>
              <input type="checkbox" checked={c === 'tiktok' ? false : f.channels[c]} disabled={c === 'tiktok'} onChange={(e) => set('channels', { ...f.channels, [c]: e.target.checked })} />
              <span>
                <b>
                  <CmBadge ch={c} /> {t(`cm.ch.${c}`)}
                </b>
                <small>{c === 'tiktok' ? t('cm.settings.soon') : t(`cm.settings.${c}Hint`)}</small>
              </span>
            </label>
          ))}
        </div>
        <dl className="dl-kv cm-conn">
          <dt>{t('cm.settings.pageToken')}</dt>
          <dd>{m.pageToken ? <span className="cm-okc">✓ {t('cm.settings.connected')}</span> : <a href="#/messages/reglages">{t('cm.settings.connect')}</a>}</dd>
          <dt>{t('cm.settings.pageId')}</dt>
          <dd className="ltr">{m.pageId || '—'}</dd>
          <dt>{t('cm.settings.igId')}</dt>
          <dd className="ltr">{m.instagramId || '—'}</dd>
          <dt>{t('cm.settings.appSecret')}</dt>
          <dd>{m.appSecret ? <span className="cm-okc">✓ {t('cm.settings.connected')}</span> : <a href="#/messages/reglages">{t('cm.settings.appSecretNone')}</a>}</dd>
          <dt>{t('cm.settings.ai')}</dt>
          <dd>{m.ai ? <span className="cm-okc">✓ {t('cm.settings.connected')}</span> : <a href="#/messages/reglages">{t('cm.settings.aiNone')}</a>}</dd>
        </dl>
        <div className="dl-hook">
          <Field label={t('cm.settings.webhook')}>
            <CopyCode code={`${base}/api/hooks/meta`} />
          </Field>
          <Field label={t('cm.settings.verifyToken')}>
            <CopyCode code={m.verifyToken || '—'} />
          </Field>
        </div>
        <p className="muted small">{t('cm.settings.fields')}</p>
        {backend.kind === 'demo' && <p className="muted small">{t('cm.settings.demo')}</p>}
      </Card>

      <div className="dl-save">
        <button type="button" className="btn primary" disabled={save.isPending} onClick={() => save.mutate(f)}>
          {t('cm.settings.save')}
        </button>
      </div>
    </>
  );
}
