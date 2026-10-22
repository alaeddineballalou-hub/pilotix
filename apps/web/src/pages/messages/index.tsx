// « Messages »: Dellal, the AI sales agent. One inbox for WhatsApp, Messenger, Instagram and TikTok
// (Dellal answers, a person can take over), a "Tester Dellal" chat, Dellal's results, and its settings (admin).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, serverUrl } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { CopyCode } from '../../ui/CopyCode';
import { Card, Empty, ErrorBox, Field, Help, Icon, Kpi, Kpis, Loading, StatusBadge, Tabs } from '../../ui/kit';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import './messages.css';

type Channel = 'whatsapp' | 'messenger' | 'instagram' | 'tiktok' | 'test';
const CH_SHORT: Record<Channel, string> = { whatsapp: 'WA', messenger: 'FB', instagram: 'IG', tiktok: 'TT', test: '🧪' };

export function ChannelBadge({ ch }: { ch: Channel }) {
  const { t } = useTranslation();
  return (
    <span className={`dl-ch dl-${ch}`} title={t(`messages.ch.${ch}`)}>
      {CH_SHORT[ch]}
    </span>
  );
}

function ModePill({ mode, name }: { mode: 'ai' | 'human' | 'handoff'; name: string }) {
  const { t } = useTranslation();
  return <span className={`dl-pill dl-${mode}`}>{mode === 'ai' ? name : t(`messages.mode.${mode}`)}</span>;
}

export function Messages({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const current = sub === 'tester' || sub === 'resultats' || (sub === 'reglages' && admin) ? sub : 'inbox';
  const tabs = [
    { key: 'inbox', label: t('messages.tabs.inbox') },
    { key: 'tester', label: t('messages.tabs.tester') },
    { key: 'resultats', label: t('messages.tabs.resultats') },
    ...(admin ? [{ key: 'reglages', label: t('messages.tabs.reglages') }] : []),
  ];
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>
            {t('messages.title')}
            <Help text={t('messages.help')} label={t('messages.title')} />
          </h2>
          <div className="tabs" role="tablist">
            {tabs.map((x) => (
              <a key={x.key} role="tab" aria-selected={current === x.key} className={`tab ${current === x.key ? 'on' : ''}`} href={`#/messages/${x.key}`} style={{ textDecoration: 'none' }}>
                {x.label}
              </a>
            ))}
          </div>
        </div>
      </div>
      {current === 'inbox' && <Inbox selected={rest?.[0] ? Number(rest[0]) : null} />}
      {current === 'tester' && <Tester />}
      {current === 'resultats' && <Results />}
      {current === 'reglages' && <Settings />}
    </>
  );
}

// ---------------------------------------------------------------- inbox
type Tab = 'all' | 'handoff' | 'ai' | 'orders';

function Inbox({ selected }: { selected: number | null }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const [tab, setTab] = useState<Tab>('all');
  const [channel, setChannel] = useState<Channel | ''>('');
  const [q, setQ] = useState('');
  const list = useRpc('dellal.inbox', { tab, channel: channel || undefined, q: q.trim() || undefined }, { refetchInterval: 15_000 });
  const d = list.data;
  const go = (id: number | null) => (window.location.hash = id ? `#/messages/inbox/${id}` : '#/messages/inbox');
  return (
    <>
      {d && !d.enabled && (
        <div className="warnbox" style={{ marginBottom: 12 }}>
          {t('messages.off', { name: d.name })} {session?.isAdmin && <a href="#/messages/reglages">{t('messages.offLink')}</a>}
        </div>
      )}
      <div className={`bjr-chat dl-chat ${selected ? 'sel' : ''}`}>
        <div className="bjr-ppl">
          <div className="dl-filters">
            <Tabs<Tab>
              value={tab}
              onChange={setTab}
              items={[
                { value: 'all', label: t('messages.inbox.all'), count: d?.counts.all },
                { value: 'handoff', label: t('messages.inbox.handoff'), count: d?.counts.handoff },
                { value: 'ai', label: d?.name ?? 'Dellal', count: d?.counts.ai },
                { value: 'orders', label: t('messages.inbox.orders'), count: d?.counts.orders },
              ]}
            />
            <div className="row" style={{ gap: 6 }}>
              <input type="search" className="grow" placeholder={t('messages.inbox.search')} aria-label={t('messages.inbox.search')} value={q} onChange={(e) => setQ(e.target.value)} />
              <select aria-label={t('messages.inbox.channel')} value={channel} onChange={(e) => setChannel(e.target.value as Channel | '')} style={{ width: 'auto' }}>
                <option value="">{t('messages.inbox.allChannels')}</option>
                {(['whatsapp', 'messenger', 'instagram', 'tiktok'] as Channel[]).map((c) => (
                  <option key={c} value={c}>
                    {t(`messages.ch.${c}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorBox error={list.error} onRetry={() => list.refetch()} />
          ) : !d?.rows.length ? (
            <p className="bjr-empty">{t('messages.inbox.empty')}</p>
          ) : (
            d.rows.map((c) => (
              <button key={c.id} type="button" className={`bjr-p ${selected === c.id ? 'on' : ''}`} onClick={() => go(c.id)}>
                <span className="bjr-av dl-av">
                  <ChannelBadge ch={c.channel} />
                </span>
                <b>{c.customerName || c.phone || t('messages.unknown')}</b>
                <span className="dl-right">
                  {c.orderRef ? <span className="dl-pill dl-order ltr">{c.orderRef}</span> : <ModePill mode={c.mode} name={d.name} />}
                  {c.unread > 0 && <span className="bjr-u">{c.unread}</span>}
                </span>
                <small>
                  {when(c.lastMessageAt)} · {c.lastPreview}
                </small>
              </button>
            ))
          )}
        </div>
        {selected ? <Thread id={selected} name={d?.name ?? 'Dellal'} onBack={() => go(null)} /> : <div className="bjr-th dl-none"><p className="bjr-empty">{t('messages.inbox.pick')}</p></div>}
      </div>
    </>
  );
}

function Bubbles({
  messages,
  name,
  pending,
}: {
  messages: { id: number; role: string; body: string; userName: string | null; sendError: string | null; at: string; meta: any }[];
  name: string;
  /** the customer's message while Dellal is still answering (tester) */
  pending?: string | null;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [messages.length, pending]);
  return (
    <div className="bjr-msgs" ref={box} aria-live="polite">
      {!messages.length && !pending && <span className="muted small">{t('messages.thread.empty')}</span>}
      {messages.map((m) =>
        m.role === 'tool' ? (
          <span key={m.id} className="dl-tool ltr">
            {m.body}
          </span>
        ) : (
          <div key={m.id} className={`bjr-m ${m.role === 'customer' ? '' : 'mine'} ${m.role === 'agent' ? 'dl-agent' : ''}`}>
            <span className="bjr-who">
              {m.role === 'customer' ? t('messages.thread.customer') : m.role === 'agent' ? (m.meta?.cm ? t('nav.cm') : name) : m.userName ?? t('messages.thread.team')}
              {/* a conversation opened from a comment: the public comment, then the CM AI agent's private message */}
              {m.meta?.comment && <span className="bjr-role">{t('messages.thread.comment')}</span>}
              {m.role === 'agent' && m.meta?.demo && <span className="bjr-role">{t('messages.thread.demo')}</span>}
              <span>{when(m.at)}</span>
            </span>
            <span className="bjr-b">{m.body}</span>
            {m.sendError && <small className="dl-err">⚠ {m.sendError}</small>}
          </div>
        ),
      )}
      {pending && (
        <>
          <div className="bjr-m">
            <span className="bjr-who">{t('messages.thread.customer')}</span>
            <span className="bjr-b">{pending}</span>
          </div>
          <Typing name={name} />
        </>
      )}
    </div>
  );
}

/** "Dellal écrit… 12 s" while the answer is on its way. */
function Typing({ name }: { name: string }) {
  const { t } = useTranslation();
  const [s, setS] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = window.setInterval(() => setS(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="bjr-m mine dl-agent">
      <span className="bjr-who">{name}</span>
      <span className="bjr-b muted">{t('messages.tester.typing', { name, s })}</span>
    </div>
  );
}

function Thread({ id, name, onBack }: { id: number; name: string; onBack: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('dellal.conversation', { id }, { refetchInterval: 10_000 });
  const [body, setBody] = useState('');
  const reply = useAction('dellal.reply', { onDone: (r) => (setBody(''), r.sendError && toast(r.sendError, 'bad')) });
  const mode = useAction('dellal.setMode', { success: (r) => (r.answered ? t('messages.thread.answered', { name }) : t('messages.thread.modeSaved')) });
  if (q.isLoading) return <div className="bjr-th"><Loading /></div>;
  if (q.error || !q.data) return <div className="bjr-th"><ErrorBox error={q.error} onRetry={() => q.refetch()} /></div>;
  const { conversation: c, messages, customer, orders } = q.data;
  const submit = () => body.trim() && reply.mutate({ id, body: body.trim() });
  return (
    <>
      <div className="bjr-th">
        <div className="bjr-th-h">
          <button type="button" className="btn small ghost bjr-back" onClick={onBack} aria-label={t('messages.thread.back')}>
            ‹
          </button>
          <ChannelBadge ch={c.channel} />
          <span className="grow">
            <b>{c.customerName || c.phone || t('messages.unknown')}</b>
            <small className="ltr">{c.phone ?? t(`messages.ch.${c.channel}`)}</small>
          </span>
          <ModePill mode={c.mode} name={name} />
          {c.mode === 'ai' ? (
            <button type="button" className="btn small" disabled={mode.isPending} onClick={() => mode.mutate({ id, mode: 'human' })}>
              {t('messages.thread.takeOver')}
            </button>
          ) : (
            <button type="button" className="btn small ok" disabled={mode.isPending} onClick={() => mode.mutate({ id, mode: 'ai' })}>
              {t('messages.thread.giveBack', { name })}
            </button>
          )}
        </div>
        {c.mode === 'handoff' && c.handoffReason && <div className="dl-handoff-bar">{t('messages.thread.handoff', { reason: c.handoffReason })}</div>}
        <Bubbles messages={messages} name={name} />
        <div className="bjr-cmp">
          <div className="bjr-cmp-r">
            <textarea
              rows={1}
              aria-label={t('messages.thread.write')}
              placeholder={c.mode === 'ai' ? t('messages.thread.writePause', { name }) : t('messages.thread.write')}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button type="button" className="btn primary bjr-sendb" title={t('messages.thread.send')} aria-label={t('messages.thread.send')} disabled={!body.trim() || reply.isPending} onClick={submit}>
              <Icon name="send" />
            </button>
          </div>
        </div>
      </div>
      <aside className="dl-side">
        <h3>{t('messages.side.customer')}</h3>
        <dl className="dl-kv">
          <dt>{t('messages.side.phone')}</dt>
          <dd className="ltr">{c.phone ?? '—'}</dd>
          <dt>{t('messages.side.channel')}</dt>
          <dd>{t(`messages.ch.${c.channel}`)}</dd>
          {c.source && (
            <>
              <dt>{t('messages.side.source')}</dt>
              <dd>{c.source}</dd>
            </>
          )}
          {customer && (
            <>
              <dt>{t('messages.side.history')}</dt>
              <dd>{t('messages.side.historyV', { orders: customer.orders, delivered: customer.delivered, returned: customer.returned })}</dd>
            </>
          )}
          {customer?.blacklisted && (
            <>
              <dt />
              <dd>
                <span className="badge t-bad">{t('messages.side.blacklisted')}</span>
              </dd>
            </>
          )}
          {c.assignedName && (
            <>
              <dt>{t('messages.side.assigned')}</dt>
              <dd>{c.assignedName}</dd>
            </>
          )}
        </dl>
        <h3>{t('messages.side.orders')}</h3>
        {!orders.length ? (
          <p className="muted small">{t('messages.side.noOrder')}</p>
        ) : (
          orders.map((o) => (
            <button key={o.id} type="button" className={`dl-order-card ${o.id === c.orderId ? 'on' : ''}`} onClick={() => openOrder(o.id)}>
              <b className="ltr">{o.ref}</b>
              <span className="ltr">{da(o.total)}</span>
              <span>{o.followStatus ? <StatusBadge kind="follow" status={o.followStatus} /> : <StatusBadge kind="conf" status={o.confStatus} />}</span>
              {o.id === c.orderId && <small>{t('messages.side.byDellal', { name })}</small>}
            </button>
          ))
        )}
      </aside>
    </>
  );
}

// ---------------------------------------------------------------- tester
function Tester() {
  const { t } = useTranslation();
  const [data, setData] = useState<{ messages: any[]; demo: boolean } | null>(null);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const send = useAction('dellal.test', { silent: false, onDone: (r) => (setData(r), setPending(null)) });
  const init = useRpc('dellal.test', {});
  const st = useRpc('dellal.inbox', { limit: 1 });
  const shown = data ?? init.data ?? null;
  const name = st.data?.name ?? 'Dellal';
  const quick = t('messages.tester.quick', { returnObjects: true }) as string[];
  // show the customer's message at once (an answer from Claude can take a while); give the text back if it failed
  useEffect(() => {
    if (!send.isPending && pending) {
      if (send.isError) setBody(pending);
      setPending(null);
    }
  }, [send.isPending]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (text = body) => {
    const v = text.trim();
    if (!v || send.isPending) return;
    setPending(v);
    setBody('');
    send.mutate({ body: v });
  };
  return (
    <Card
      title={t('messages.tester.title', { name })}
      actions={
        <button type="button" className="btn small ghost" disabled={send.isPending} onClick={() => send.mutate({ reset: true })}>
          {t('messages.tester.reset')}
        </button>
      }
    >
      <p className="muted small">{t('messages.tester.help', { name })}</p>
      {shown?.demo && <div className="warnbox" style={{ margin: '8px 0' }}>{t(backend.kind === 'demo' ? 'messages.tester.demoPreview' : 'messages.tester.demoNoKey', { name })}</div>}
      {shown && !shown.demo && backend.kind === 'demo' && (
        <div className="okbox" style={{ margin: '8px 0', fontWeight: 500 }}>
          {t('messages.tester.inPage', { name })}
        </div>
      )}
      <div className="dl-tester">
        {init.isLoading ? <Loading /> : <Bubbles messages={shown?.messages ?? []} name={name} pending={pending} />}
        <div className="bjr-cmp">
          <div className="bjr-qr">
            {quick.map((x) => (
              <button key={x} type="button" disabled={send.isPending} onClick={() => submit(x)}>
                {x}
              </button>
            ))}
          </div>
          <div className="bjr-cmp-r">
            <textarea
              rows={1}
              aria-label={t('messages.tester.write')}
              placeholder={t('messages.tester.write')}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button type="button" className="btn primary bjr-sendb" aria-label={t('messages.thread.send')} disabled={!body.trim() || send.isPending} onClick={() => submit()}>
              {send.isPending ? '…' : <Icon name="send" />}
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- results
function Results() {
  const { t } = useTranslation();
  const [days, setDays] = useState(7);
  const q = useRpc('dellal.stats', { days });
  const name = useRpc('dellal.inbox', { limit: 1 }).data?.name ?? 'Dellal';
  const s = q.data;
  return (
    <Card
      title={t('messages.results.title', { name })}
      actions={
        <select aria-label={t('messages.results.period')} value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
          {[1, 7, 30, 90].map((d) => (
            <option key={d} value={d}>
              {t('messages.results.days', { count: d })}
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
            <Kpi icon="chat" label={t('messages.results.conversations')} value={n(s.conversations)} sub={t('messages.results.messages', { a: n(s.customerMessages), b: n(s.agentMessages) })} />
            <Kpi icon="receipt" label={t('messages.results.orders', { name })} value={n(s.orders)} sub={da(s.amount)} tone="ok" />
            <Kpi icon="sparkles" label={t('messages.results.conversion')} value={`${String(s.conversion).replace('.', ',')} %`} />
            <Kpi icon="users" label={t('messages.results.handed')} value={n(s.handed)} tone={s.handed ? 'warn' : undefined} />
          </Kpis>
          <Kpis>
            <Kpi icon="check" label={t('messages.results.confirmed')} value={n(s.confirmed)} />
            <Kpi icon="truck" label={t('messages.results.delivered')} value={n(s.delivered)} rate={s.orders ? s.delivered / s.orders : null} />
          </Kpis>
          <p className="muted small">{t('messages.results.note', { name })}</p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- settings (admin)
type Secret = 'ai' | 'appSecret' | 'pageToken' | 'waToken' | 'tiktokToken';

function Settings() {
  const q = useRpc('dellal.settings.get', {});
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <SettingsForm key={JSON.stringify(q.data.settings)} data={q.data} />;
}

function SettingsForm({ data }: { data: NonNullable<ReturnType<typeof useRpc<'dellal.settings.get'>>['data']> }) {
  const { t } = useTranslation();
  const [f, setF] = useState(data.settings);
  const [sec, setSec] = useState<Partial<Record<Secret, string | null>>>({});
  const save = useAction('dellal.settings.save', {
    success: t('messages.settings.saved'),
    onDone: (r) => {
      setSec({});
      if (r.aiTest) toast(r.aiTest.ok ? t('messages.settings.aiOk') : r.aiTest.message ?? 'IA', r.aiTest.ok ? 'ok' : 'bad');
    },
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const base = serverUrl() || (backend.kind === 'demo' ? 'https://votre-serveur.dz' : window.location.origin);
  const metaUrl = `${base}/api/hooks/meta`;
  const tiktokUrl = `${base}/api/hooks/tiktok?key=${f.verifyToken}`;
  const secret = (k: Secret, label: string, ph: string) => (
    <Field
      label={label}
      hint={
        data.has[k] ? (
          <span>
            ✓ {t('messages.settings.saved1')}{' '}
            <button type="button" className="linkbtn" onClick={() => setSec({ ...sec, [k]: null })}>
              {sec[k] === null ? t('messages.settings.willRemove') : t('messages.settings.remove')}
            </button>
          </span>
        ) : undefined
      }
    >
      <input className="ltr" type="password" autoComplete="new-password" value={sec[k] ?? ''} placeholder={data.has[k] ? t('messages.settings.keep') : ph} onChange={(e) => setSec({ ...sec, [k]: e.target.value })} />
    </Field>
  );
  const submit = () => save.mutate({ ...f, secrets: sec as Record<Secret, string | null> });
  return (
    <>
      <Card title={t('messages.settings.sell', { name: f.name })}>
        <label className="dl-switch">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span>
            <b>{t('messages.settings.enabled', { name: f.name })}</b>
            <small>{t('messages.settings.enabledHint')}</small>
          </span>
        </label>
        <div className="grid2">
          <Field label={t('messages.settings.name')} hint={t('messages.settings.nameHint')}>
            <input value={f.name} maxLength={40} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={t('messages.settings.ordersTo')}>
            <select value={f.ordersTo} onChange={(e) => set('ordersTo', e.target.value as typeof f.ordersTo)}>
              <option value="new">{t('messages.settings.ordersNew')}</option>
              <option value="confirmed">{t('messages.settings.ordersConfirmed')}</option>
            </select>
          </Field>
          <Field label={t('messages.settings.tone')} wide>
            <input value={f.tone} maxLength={400} onChange={(e) => set('tone', e.target.value)} />
          </Field>
          <Field label={t('messages.settings.languages')} wide>
            <input value={f.languages} maxLength={200} onChange={(e) => set('languages', e.target.value)} />
          </Field>
          <Field label={t('messages.settings.followUp')} hint={t('messages.settings.followUpHint')}>
            <select value={f.followUpHours} onChange={(e) => set('followUpHours', Number(e.target.value))}>
              <option value={0}>{t('messages.settings.never')}</option>
              {[1, 2, 3, 6, 12, 20].map((h) => (
                <option key={h} value={h}>
                  {t('messages.settings.afterH', { count: h })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('messages.settings.model')} hint={t('messages.settings.modelHint')}>
            <select value={f.model} onChange={(e) => set('model', e.target.value as typeof f.model)}>
              {data.models.map((m) => (
                <option key={m} value={m}>
                  {t(`messages.settings.models.${m}`, { defaultValue: m })}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="dl-switch">
          <input type="checkbox" checked={f.nightReplies} onChange={(e) => set('nightReplies', e.target.checked)} />
          <span>
            <b>{t('messages.settings.night')}</b>
            <small>{t('messages.settings.nightHint')}</small>
          </span>
        </label>
        <label className="dl-switch">
          <input type="checkbox" checked={f.allowDiscount} onChange={(e) => set('allowDiscount', e.target.checked)} />
          <span>
            <b>{t('messages.settings.discount')}</b>
            <small>{t('messages.settings.discountHint')}</small>
          </span>
        </label>
      </Card>

      <Card title={t('messages.settings.knows')}>
        <p className="muted small">{t('messages.settings.knowsHelp', { name: f.name })}</p>
        <Field label={t('messages.settings.notes')} hint={t('messages.settings.notesHint')} wide>
          <textarea rows={5} maxLength={6000} value={f.notes} placeholder={t('messages.settings.notesPh')} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        <Field label={t('messages.settings.handoff')} hint={t('messages.settings.handoffHint')} wide>
          <textarea rows={4} maxLength={2000} value={f.handoffTopics} onChange={(e) => set('handoffTopics', e.target.value)} />
        </Field>
      </Card>

      <Card title={t('messages.settings.darija')} help={t('messages.settings.darijaHelp', { name: f.name })}>
        <p className="muted small">{t('messages.settings.darijaIntro', { name: f.name })}</p>
        <Field label={t('messages.settings.darijaPrefer')} hint={t('messages.settings.darijaPreferHint')} wide>
          <textarea rows={5} maxLength={4000} className="ltr" value={f.darijaPrefer} placeholder={t('messages.settings.darijaPreferPh')} onChange={(e) => set('darijaPrefer', e.target.value)} />
        </Field>
        <Field label={t('messages.settings.darijaAvoid')} hint={t('messages.settings.darijaAvoidHint')} wide>
          <textarea rows={4} maxLength={4000} className="ltr" value={f.darijaAvoid} placeholder={t('messages.settings.darijaAvoidPh')} onChange={(e) => set('darijaAvoid', e.target.value)} />
        </Field>
      </Card>

      <Card title={t('messages.settings.ai')} help={t('messages.settings.aiHelp')}>
        {secret('ai', t('messages.settings.aiKey'), 'sk-ant-…')}
        {!data.has.ai && <p className="muted small">{t('messages.settings.aiNone', { name: f.name })}</p>}
      </Card>

      <Card title={t('messages.settings.channels')} help={t('messages.settings.channelsHelp')}>
        <div className="dl-hook">
          <Field label={t('messages.settings.metaUrl')}>
            <CopyCode code={metaUrl} />
          </Field>
          <Field label={t('messages.settings.verifyToken')}>
            <CopyCode code={f.verifyToken || '—'} />
          </Field>
        </div>
        {secret('appSecret', t('messages.settings.appSecret'), '32 caractères')}
        <h3 className="dl-h3">
          <ChannelBadge ch="whatsapp" /> {t('messages.ch.whatsapp')}
        </h3>
        <div className="grid2">
          <Field label={t('messages.settings.waPhoneId')}>
            <input className="ltr" inputMode="numeric" value={f.whatsappPhoneId} onChange={(e) => set('whatsappPhoneId', e.target.value.replace(/\D/g, ''))} />
          </Field>
          {secret('waToken', t('messages.settings.waToken'), 'EAAG…')}
        </div>
        <h3 className="dl-h3">
          <ChannelBadge ch="messenger" /> <ChannelBadge ch="instagram" /> {t('messages.settings.pageTitle')}
        </h3>
        <div className="grid2">
          <Field label={t('messages.settings.pageId')}>
            <input className="ltr" inputMode="numeric" value={f.messengerPageId} onChange={(e) => set('messengerPageId', e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label={t('messages.settings.igId')}>
            <input className="ltr" inputMode="numeric" value={f.instagramId} onChange={(e) => set('instagramId', e.target.value.replace(/\D/g, ''))} />
          </Field>
          {secret('pageToken', t('messages.settings.pageToken'), 'EAAG…')}
        </div>
        <h3 className="dl-h3">
          <ChannelBadge ch="tiktok" /> {t('messages.ch.tiktok')}
        </h3>
        <p className="muted small">{t('messages.settings.tiktokHelp')}</p>
        <Field label={t('messages.settings.tiktokUrl')}>
          <CopyCode code={tiktokUrl} />
        </Field>
        {backend.kind === 'demo' && <p className="muted small">{t('messages.settings.demo')}</p>}
      </Card>

      <div className="dl-save">
        <button type="button" className="btn primary" disabled={save.isPending || f.name.trim().length < 2} onClick={submit}>
          {t('messages.settings.save')}
        </button>
      </div>
    </>
  );
}
