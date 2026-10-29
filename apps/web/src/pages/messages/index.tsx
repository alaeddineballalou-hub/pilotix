// « Message AI agent »: Dellal, the AI sales agent. One inbox for WhatsApp, Messenger, Instagram and TikTok
// (Dellal answers, a person can take over), a "Tester Dellal" chat, Dellal's results, and its settings (admin).
// The inbox has three columns on a computer (conversations, the conversation, the customer), two on a tablet
// (the customer opens as a panel) and one on a phone, where a conversation takes the whole screen.
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMenuCounts } from '../../layout/Shell';
import { backend, serverUrl, shopApi } from '../../lib/backend';
import { clock, da, dayLabel, n, sameDay, shortWhen } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { CopyCode } from '../../ui/CopyCode';
import { Card, ErrorBox, Field, Icon, Kpi, Kpis, Loading, StatusBadge } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { AgentHeader, Filters, initials, PeriodSwitch, SaveBar, SearchBox, useEdges, useFillHeight } from '../ai/agent';
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

/** The customer's initials with the channel in the corner. */
function Avatar({ name, ch, size = '' }: { name: string; ch: Channel; size?: '' | 'sm' | 'lg' }) {
  return (
    <span className={`ai-av ${size}`}>
      <span aria-hidden="true">{initials(name)}</span>
      <ChannelBadge ch={ch} />
    </span>
  );
}

export function Messages({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const counts = useMenuCounts();
  const st = useRpc('dellal.inbox', { limit: 1 });
  const current = sub === 'tester' || sub === 'resultats' || (sub === 'reglages' && admin) ? sub : 'inbox';
  const tabs = [
    { key: 'inbox', label: t('messages.tabs.inbox'), icon: 'inbox', href: '#/messages/inbox', count: counts.msgs },
    { key: 'tester', label: t('messages.tabs.tester'), icon: 'play', href: '#/messages/tester' },
    { key: 'resultats', label: t('messages.tabs.resultats'), icon: 'chart', href: '#/messages/resultats' },
    ...(admin ? [{ key: 'reglages', label: t('messages.tabs.reglages'), icon: 'settings', href: '#/messages/reglages' }] : []),
  ];
  return (
    <>
      <AgentHeader agent="messages" title={t('messages.title')} help={t('messages.help')} about={t('ai.about.messages')} on={st.data?.enabled} settings={admin ? '#/messages/reglages' : undefined} tabs={tabs} current={current} />
      {current === 'inbox' && <Inbox selected={rest?.[0] ? Number(rest[0]) : null} />}
      {current === 'tester' && <Tester />}
      {current === 'resultats' && <Results />}
      {current === 'reglages' && <Settings />}
    </>
  );
}

// ---------------------------------------------------------------- inbox
type Tab = 'all' | 'handoff' | 'ai' | 'orders';
type Conv = NonNullable<ReturnType<typeof useRpc<'dellal.inbox'>>['data']>['rows'][number];

function Inbox({ selected }: { selected: number | null }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const [tab, setTab] = useState<Tab>('all');
  const [channel, setChannel] = useState<Channel | ''>('');
  const [q, setQ] = useState('');
  const [info, setInfo] = useState(false);
  const list = useRpc('dellal.inbox', { tab, channel: channel || undefined, q: q.trim() || undefined }, { refetchInterval: 15_000 });
  const d = list.data;
  const off = !!d && !d.enabled;
  const box = useFillHeight<HTMLDivElement>([off]);
  const name = d?.name ?? 'Dellal';
  const go = (id: number | null) => (window.location.hash = id ? `#/messages/inbox/${id}` : '#/messages/inbox');
  useEffect(() => setInfo(false), [selected]);
  // on a phone the conversation covers the screen: the page behind it stays still
  useEffect(() => {
    document.body.classList.toggle('ai-chat-open', !!selected);
    return () => document.body.classList.remove('ai-chat-open');
  }, [selected]);
  return (
    <>
      {off && (
        <div className="warnbox">
          {t('messages.off', { name: d.name })} {session?.isAdmin && <a href="#/messages/reglages">{t('messages.offLink')}</a>}
        </div>
      )}
      <div className="ai-inbox" ref={box}>
        <div className={`ai-inbox-in ${selected ? 'sel' : ''} ${info ? 'info' : ''}`}>
          <section className="ai-list" aria-label={t('messages.tabs.inbox')}>
            <div className="ai-list-top">
              <SearchBox value={q} onChange={setQ} placeholder={t('messages.inbox.search')} />
              <Filters<Tab>
                value={tab}
                onChange={setTab}
                label={t('ai.filters')}
                extra={
                  <select className={`ai-filter-sel ${channel ? 'on' : ''}`} aria-label={t('messages.inbox.channel')} title={t('messages.inbox.allChannels')} value={channel} onChange={(e) => setChannel(e.target.value as Channel | '')}>
                    <option value="">{t('messages.inbox.channel')}</option>
                    {(['whatsapp', 'messenger', 'instagram', 'tiktok'] as Channel[]).map((c) => (
                      <option key={c} value={c}>
                        {t(`messages.ch.${c}`)}
                      </option>
                    ))}
                  </select>
                }
                items={[
                  { value: 'all', label: t('messages.inbox.all'), count: d?.counts.all },
                  { value: 'handoff', label: t('messages.inbox.handoff'), count: d?.counts.handoff, alert: true },
                  { value: 'ai', label: name, count: d?.counts.ai },
                  { value: 'orders', label: t('messages.inbox.orders'), count: d?.counts.orders },
                ]}
              />
            </div>
            <div className="ai-convs">
              {list.isLoading ? (
                <Loading />
              ) : list.error ? (
                <ErrorBox error={list.error} onRetry={() => list.refetch()} />
              ) : !d?.rows.length ? (
                <p className="ai-note-m ai-pad">{t('messages.inbox.empty')}</p>
              ) : (
                d.rows.map((c) => <ConvRow key={c.id} c={c} on={selected === c.id} name={name} onClick={() => go(c.id)} />)
              )}
            </div>
          </section>
          {selected ? (
            <Thread id={selected} name={name} info={info} onInfo={setInfo} onBack={() => go(null)} />
          ) : (
            <div className="ai-pick">
              <span className={`ai-face ${d?.enabled ? 'on' : ''}`} aria-hidden="true">
                <Icon name="chat" />
                <i />
              </span>
              <b>{t('messages.inbox.pick')}</b>
              <p>{t('messages.inbox.pickHint')}</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ConvRow({ c, on, name, onClick }: { c: Conv; on: boolean; name: string; onClick: () => void }) {
  const { t } = useTranslation();
  const who = c.customerName || c.phone || t('messages.unknown');
  return (
    <button type="button" className={`ai-conv ${on ? 'on' : ''} ${c.unread > 0 ? 'unread' : ''}`} aria-current={on ? 'true' : undefined} onClick={onClick}>
      <Avatar name={who} ch={c.channel} />
      <span className="ai-conv-main">
        <span className="ai-conv-l1">
          <b>
            <bdi>{who}</bdi>
          </b>
          <time dateTime={c.lastMessageAt}>{shortWhen(c.lastMessageAt)}</time>
        </span>
        <span className="ai-conv-l2">
          <span className="ai-prev" dir="auto">
            {c.lastPreview}
          </span>
          {c.mode === 'handoff' ? (
            <span className="dl-pill dl-handoff">{t('messages.mode.handoff')}</span>
          ) : c.orderRef ? (
            <span className="dl-pill dl-order ltr">{c.orderRef}</span>
          ) : c.mode === 'human' ? (
            <span className="dl-pill dl-human">{t('messages.mode.human')}</span>
          ) : (
            <span className="dl-by-ai" title={name}>
              <Icon name="sparkles" />
            </span>
          )}
          {c.unread > 0 && <span className="ai-unread">{c.unread}</span>}
        </span>
      </span>
    </button>
  );
}

type Msg = { id: number; role: string; body: string; userName: string | null; sendError: string | null; at: string; meta: any };

/** The messages of a conversation, grouped by author, with the day between them. */
function Bubbles({ messages, name, pending }: { messages: Msg[]; name: string; pending?: string | null }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [messages.length, pending]);
  const author = (m: Msg) => (m.role === 'customer' ? t('messages.thread.customer') : m.role === 'agent' ? (m.meta?.cm ? t('nav.cm') : m.meta?.notify ? t('nav.notify') : name) : m.userName ?? t('messages.thread.team'));
  const rows: ReactNode[] = [];
  let prev: Msg | null = null;
  for (const m of messages) {
    if (!prev || !sameDay(prev.at, m.at)) {
      rows.push(
        <span key={`d${m.id}`} className="ai-day">
          {dayLabel(m.at)}
        </span>,
      );
      prev = null;
    }
    if (m.role === 'tool') {
      rows.push(
        <span key={m.id} className="dl-tool ltr">
          {m.body}
        </span>,
      );
      prev = m;
      continue;
    }
    const first = !prev || prev.role === 'tool' || author(prev) !== author(m) || !!m.meta?.notify || !!m.meta?.comment;
    const kind = m.role === 'customer' ? 'in' : m.role === 'agent' ? 'out bot' : 'out team';
    rows.push(
      <div key={m.id} className={`ai-msg ${kind} ${first ? 'first' : ''}`}>
        {first && (
          <span className="ai-who">
            {m.role === 'agent' && <Icon name="sparkles" />}
            {author(m)}
            {/* a delivery message (Delivery AI agent) the customer answered */}
            {m.meta?.notify && <span className="ai-tag">{t(`notify.kind.${m.meta.notify}`, { defaultValue: '' })}</span>}
            {/* a conversation opened from a comment: the public comment, then the CM AI agent's private message */}
            {m.meta?.comment && <span className="ai-tag">{t('messages.thread.comment')}</span>}
            {m.role === 'agent' && m.meta?.demo && <span className="ai-tag">{t('messages.thread.demo')}</span>}
          </span>
        )}
        <div className="ai-bub">
          <span className="ai-txt" dir="auto">
            {m.body}
          </span>
          <time dateTime={m.at}>{clock(m.at)}</time>
        </div>
        {m.sendError && <small className="ai-err">⚠ {m.sendError}</small>}
      </div>,
    );
    prev = m;
  }
  const lastIsCustomer = prev?.role === 'customer';
  return (
    <div className="ai-msgs" ref={box} aria-live="polite">
      {!messages.length && !pending && <span className="ai-note-m">{t('messages.thread.empty')}</span>}
      {rows}
      {pending && (
        <>
          <div className={`ai-msg in ${lastIsCustomer ? '' : 'first'}`}>
            {!lastIsCustomer && <span className="ai-who">{t('messages.thread.customer')}</span>}
            <div className="ai-bub">
              <span className="ai-txt" dir="auto">
                {pending}
              </span>
            </div>
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
    <div className="ai-msg out bot first wait">
      <span className="ai-who">
        <Icon name="sparkles" />
        {name}
      </span>
      <div className="ai-bub">
        <span className="ai-txt">{t('messages.tester.typing', { name, s })}</span>
      </div>
    </div>
  );
}

/** The message box: grows with the text; Enter sends, Shift + Enter goes to the line. */
function Composer({ value, onChange, onSend, placeholder, busy, children }: { value: string; onChange: (v: string) => void; onSend: () => void; placeholder: string; busy: boolean; children?: ReactNode }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(140, Math.max(44, el.scrollHeight + 3))}px`;
  }, [value]);
  return (
    <div className="ai-cmp">
      {children}
      <div className="ai-cmp-r">
        <textarea
          ref={ref}
          rows={1}
          dir="auto"
          aria-label={placeholder}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button type="button" className="btn primary ai-send" title={t('messages.thread.send')} aria-label={t('messages.thread.send')} disabled={!value.trim() || busy} onClick={onSend}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}

function Thread({ id, name, info, onInfo, onBack }: { id: number; name: string; info: boolean; onInfo: (v: boolean) => void; onBack: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('dellal.conversation', { id }, { refetchInterval: 10_000 });
  const [body, setBody] = useState('');
  const reply = useAction('dellal.reply', { onDone: (r) => (setBody(''), r.sendError && toast(r.sendError, 'bad')) });
  const mode = useAction('dellal.setMode', { success: (r) => (r.answered ? t('messages.thread.answered', { name }) : t('messages.thread.modeSaved')) });
  // Escape closes the customer panel, then (on a phone) the conversation
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-wrap')) return;
      if (info) onInfo(false);
      else if (window.matchMedia('(max-width: 699px)').matches) onBack();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [info, onInfo, onBack]);
  if (q.isLoading)
    return (
      <div className="ai-thread">
        <Loading />
      </div>
    );
  if (q.error || !q.data)
    return (
      <div className="ai-thread">
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  const { conversation: c, messages, customer, orders } = q.data;
  const who = c.customerName || c.phone || t('messages.unknown');
  const submit = () => body.trim() && !reply.isPending && reply.mutate({ id, body: body.trim() });
  return (
    <>
      <section className="ai-thread" aria-label={who}>
        <header className="ai-th-head">
          <button type="button" className="ai-back" onClick={onBack} aria-label={t('messages.thread.back')} title={t('messages.thread.back')}>
            <Icon name="chevl" />
          </button>
          <Avatar name={who} ch={c.channel} size="sm" />
          <span className="ai-th-who">
            <b>
              <bdi>{who}</bdi>
            </b>
            <small className={c.phone ? 'ltr' : ''}>{c.phone ?? t(`messages.ch.${c.channel}`)}</small>
          </span>
          <button type="button" className="ai-info-btn" aria-expanded={info} aria-label={t('messages.thread.info')} title={t('messages.thread.info')} onClick={() => onInfo(!info)}>
            <Icon name="user" />
          </button>
        </header>
        {c.mode === 'ai' ? (
          <div className="ai-mode ai">
            <span>
              <Icon name="sparkles" />
              <span>
                {t('messages.thread.modeAi', { name })} <span className="ai-hide-s">{t('messages.thread.modeAiHint')}</span>
              </span>
            </span>
            <button type="button" className="btn small" disabled={mode.isPending} onClick={() => mode.mutate({ id, mode: 'human' })}>
              {t('messages.thread.takeOver')}
            </button>
          </div>
        ) : (
          <div className={`ai-mode ${c.mode}`}>
            <span>
              <Icon name={c.mode === 'handoff' ? 'alert' : 'user'} />
              {c.mode === 'handoff' ? (c.handoffReason ? t('messages.thread.handoffBar', { name, reason: c.handoffReason }) : t('messages.mode.handoff')) : t('messages.thread.modeHuman', { name })}
            </span>
            <button type="button" className="btn small" disabled={mode.isPending} onClick={() => mode.mutate({ id, mode: 'ai' })}>
              <Icon name="sparkles" /> {t('messages.thread.giveBack', { name })}
            </button>
          </div>
        )}
        <Bubbles messages={messages} name={name} />
        <Composer value={body} onChange={setBody} onSend={submit} placeholder={t('messages.thread.write')} busy={reply.isPending} />
      </section>
      <aside className="ai-side" aria-label={t('messages.side.customer')}>
        <div className="ai-side-h">
          <h3>{t('messages.side.customer')}</h3>
          <button type="button" className="ai-side-x" onClick={() => onInfo(false)} aria-label={t('common.close')} title={t('common.close')}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ai-side-id">
          <Avatar name={who} ch={c.channel} size="lg" />
          <span>
            <b>
              <bdi>{who}</bdi>
            </b>
            <small>{t(`messages.ch.${c.channel}`)}</small>
          </span>
        </div>
        <dl className="ai-kv">
          <dt>{t('messages.side.phone')}</dt>
          <dd className="ltr">{c.phone ?? '—'}</dd>
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
        <h4>{t('messages.side.orders')}</h4>
        {!orders.length ? (
          <p className="muted small" style={{ margin: 0 }}>
            {t('messages.side.noOrder')}
          </p>
        ) : (
          orders.map((o) => (
            <button key={o.id} type="button" className={`dl-order-card ${o.id === c.orderId ? 'on' : ''}`} onClick={() => openOrder(o.id)}>
              <b className="ltr">{o.ref}</b>
              <span className="ltr">{da(o.total)}</span>
              <span>{o.followStatus ? <StatusBadge kind="follow" status={o.followStatus} /> : <StatusBadge kind="conf" status={o.confStatus} />}</span>
              {o.id === c.orderId && (
                <small>
                  <Icon name="sparkles" /> {t('messages.side.byDellal', { name })}
                </small>
              )}
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
  const [data, setData] = useState<{ messages: any[]; demo: boolean; platform?: boolean } | null>(null);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const send = useAction('dellal.test', { silent: false, onDone: (r) => (setData(r), setPending(null)) });
  const init = useRpc('dellal.test', {});
  const st = useRpc('dellal.inbox', { limit: 1 });
  const shown = data ?? init.data ?? null;
  const name = st.data?.name ?? 'Dellal';
  const quick = t('messages.tester.quick', { returnObjects: true }) as string[];
  const row = useEdges<HTMLDivElement>([quick.length]);
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
    <Card title={t('messages.tester.title', { name })}>
      <div className="ai-try">
        <div className="ai-try-in">
          <div className="ai-try-side">
            <p className="muted">{t('messages.tester.help', { name })}</p>
            {shown?.demo && <div className="warnbox">{t(backend.kind === 'demo' ? 'messages.tester.demoPreview' : shown.platform ? 'messages.tester.demoPilot' : 'messages.tester.demoNoKey', { name })}</div>}
            {shown && !shown.demo && backend.kind === 'demo' && (
              <div className="okbox" style={{ fontWeight: 500 }}>
                {t('messages.tester.inPage', { name })}
              </div>
            )}
            <div className="ai-tips">
              <h3>{t('ai.try')}</h3>
              {quick.map((x) => (
                <button key={x} type="button" dir="auto" disabled={send.isPending} onClick={() => submit(x)}>
                  <Icon name="chat" />
                  {x}
                </button>
              ))}
            </div>
          </div>
          <div className="ai-phone">
            <div className="ai-phone-h">
              <span className="ai-face on" aria-hidden="true">
                <Icon name="chat" />
                <i />
              </span>
              <b>{name}</b>
              <span className="ai-tag">{t('ai.test')}</span>
              <button type="button" className="btn small ghost" title={t('messages.tester.reset')} aria-label={t('messages.tester.reset')} disabled={send.isPending} onClick={() => send.mutate({ reset: true })}>
                <Icon name="refresh" />
                <span className="ai-hide-s">{t('messages.tester.reset')}</span>
              </button>
            </div>
            {init.isLoading ? <Loading /> : <Bubbles messages={shown?.messages ?? []} name={name} pending={pending} />}
            <Composer value={body} onChange={setBody} onSend={() => submit()} placeholder={t('messages.tester.write')} busy={send.isPending}>
              <div className="ai-quick" ref={row}>
                {quick.map((x) => (
                  <button key={x} type="button" dir="auto" disabled={send.isPending} onClick={() => submit(x)}>
                    {x}
                  </button>
                ))}
              </div>
            </Composer>
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
    <Card title={t('messages.results.title', { name })} actions={<PeriodSwitch value={days} onChange={setDays} />}>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !s ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="ai-results">
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
        </div>
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
  const metaUrl = `${shopApi(base)}/hooks/meta`;
  const tiktokUrl = `${shopApi(base)}/hooks/tiktok?key=${f.verifyToken}`;
  const dirty = JSON.stringify(f) !== JSON.stringify(data.settings) || Object.values(sec).some((v) => v !== undefined && v !== '');
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

      {/* on Pilotix's server the AI is Pilotix's (Pilot AI, run from the control room): nothing to set in a shop (nor in its preview) */}
      {!data.platform && backend.kind !== 'demo' && (
        <Card title={t('messages.settings.ai')} help={t('messages.settings.aiHelp')}>
          {secret('ai', t('messages.settings.aiKey'), 'sk-ant-…')}
          {!data.has.ai && <p className="muted small">{t('messages.settings.aiNone', { name: f.name })}</p>}
        </Card>
      )}

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

      <SaveBar dirty={dirty} busy={save.isPending} disabled={f.name.trim().length < 2} onSave={submit} label={t('messages.settings.save')} />
    </>
  );
}
