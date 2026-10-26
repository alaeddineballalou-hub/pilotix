// « Delivery AI agent »: the messages sent to each customer about their order — received, confirmed, shipped, with the
// livreur, at the desk, failed attempt, cancelled by the livreur, delivered — by WhatsApp first, by SMS when the number
// has no WhatsApp, or to send by hand; the cases and their texts, a tester, the results and the settings (admin).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMenuCounts } from '../../layout/Shell';
import { backend, Out, rpc, serverUrl, shopApi } from '../../lib/backend';
import { da, n, pct, when } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { CopyCode } from '../../ui/CopyCode';
import { Card, ErrorBox, Field, Icon, Kpi, Kpis, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { AgentHeader, Filters, PeriodSwitch, SaveBar, SearchBox } from '../ai/agent';
import type { PageProps } from '../registry';
import '../messages/messages.css';
import '../cm/cm.css';
import './notify.css';

type Row = Out<'notify.feed'>['rows'][number];
type Kind = Row['kind'];
type Case = Out<'notify.cases'>['cases'][number];
type FeedTab = 'all' | 'todo' | 'waiting' | 'whatsapp' | 'sms' | 'replies' | 'problems';
type Lang = 'dz' | 'fr' | 'ar';
const KINDS: Kind[] = ['created', 'confirmed', 'shipped', 'out_for_delivery', 'stopdesk', 'failed', 'returning', 'delivered'];
const KIND_ICON: Record<Kind, string> = { created: 'receipt', confirmed: 'checkcircle', shipped: 'package', out_for_delivery: 'truck', stopdesk: 'building', failed: 'alert', returning: 'undo', delivered: 'gift' };
const intl = (p: string) => '213' + p.replace(/^0/, '');

/** "demain 08:00" for a message held during the night, otherwise like everywhere else. */
function whenSend(iso: string, t: (k: string) => string) {
  const d = new Date(Date.parse(iso) - 86_400_000).toLocaleDateString('fr-FR', { timeZone: 'Africa/Algiers' });
  const today = new Date().toLocaleDateString('fr-FR', { timeZone: 'Africa/Algiers' });
  const time = new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit' });
  return d === today ? `${t('notify.tomorrow')} ${time}` : when(iso);
}

const TAB_ICON: Record<string, string> = { messages: 'send', cas: 'route', tester: 'play', resultats: 'chart', reglages: 'settings' };

export function Notify({ sub }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const counts = useMenuCounts();
  const st = useRpc('notify.feed', { limit: 1 });
  const keys = ['messages', 'cas', 'tester', 'resultats', ...(admin ? ['reglages'] : [])];
  const current = keys.includes(sub ?? '') ? sub! : 'messages';
  const tabs = keys.map((k) => ({ key: k, label: t(`notify.tabs.${k}`), icon: TAB_ICON[k], href: `#/notify/${k}`, count: k === 'messages' ? counts.notify : undefined }));
  return (
    <>
      <AgentHeader agent="notify" title={t('notify.title')} help={t('notify.help')} about={t('ai.about.notify')} on={st.data?.enabled} settings={admin ? '#/notify/reglages' : undefined} tabs={tabs} current={current} />
      {current === 'messages' && <Feed admin={admin} />}
      {current === 'cas' && <Cases admin={admin} />}
      {current === 'tester' && <Tester admin={admin} />}
      {current === 'resultats' && <Results />}
      {current === 'reglages' && <Settings />}
    </>
  );
}

// ---------------------------------------------------------------- messages
function ChannelBadge({ m }: { m: Pick<Row, 'channel' | 'status'> }) {
  const { t } = useTranslation();
  if (m.channel === 'whatsapp') return <span className="dl-ch dl-whatsapp" title="WhatsApp">WA</span>;
  if (m.channel === 'sms') return <span className="dl-ch nt-sms" title="SMS">SMS</span>;
  if (m.channel === 'manual' || m.status === 'done') return <span className="dl-ch nt-hand" title={t('notify.msg.byHand')}><Icon name="send" /></span>;
  return (
    <span className="dl-ch nt-wait" title={t('notify.st.waiting')}>
      <Icon name={m.status === 'skipped' ? 'xcircle' : 'hourglass'} />
    </span>
  );
}

function statusOf(m: Row, t: (k: string, o?: any) => string): { label: string; tone: string } {
  switch (m.status) {
    case 'queued':
    case 'sending':
      return Date.parse(m.sendAfter) > Date.now() + 60_000 ? { label: t('notify.st.at', { at: whenSend(m.sendAfter, t) }), tone: 'cm-new' } : { label: t('notify.st.sending'), tone: 'cm-new' };
    case 'whatsapp':
      return m.waStatus === 'read' ? { label: t('notify.st.read'), tone: 'cm-ok' } : m.waStatus === 'delivered' ? { label: t('notify.st.delivered'), tone: 'cm-ok' } : { label: t('notify.st.sent'), tone: 'cm-new' };
    case 'sms':
      return m.smsStatus === 'delivered' ? { label: t('notify.st.smsDelivered'), tone: 'cm-ok' } : { label: t('notify.st.smsSent'), tone: 'cm-new' };
    case 'done':
      return { label: t('notify.st.done'), tone: 'cm-ok' };
    case 'manual':
      return { label: t('notify.st.manual'), tone: 'cm-warn' };
    case 'failed':
      return { label: t('notify.st.failed'), tone: 'cm-bad' };
    default:
      return { label: t('notify.st.skipped'), tone: 'cm-mute' };
  }
}

function Feed({ admin }: { admin: boolean }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<FeedTab>('all');
  const [kind, setKind] = useState<Kind | ''>('');
  const [q, setQ] = useState('');
  const list = useRpc('notify.feed', { tab, kind: kind || undefined, q: q.trim() || undefined }, { refetchInterval: 20_000 });
  const d = list.data;
  return (
    <>
      {d && !d.enabled && (
        <div className="warnbox">
          {t('notify.off')} {admin && <a href="#/notify/reglages">{t('notify.offLink')}</a>}
        </div>
      )}
      <div className="ai-feed">
        <div className="ai-feed-in">
          <aside className="ai-rail" aria-label={t('ai.filters')}>
            <div className="ai-rail-row">
              <SearchBox value={q} onChange={setQ} placeholder={t('notify.feed.search')} />
              <select aria-label={t('notify.feed.kind')} value={kind} onChange={(e) => setKind(e.target.value as Kind | '')}>
                <option value="">{t('notify.feed.allKinds')}</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`notify.kind.${k}`)}
                  </option>
                ))}
              </select>
            </div>
            <Filters<FeedTab>
              value={tab}
              onChange={setTab}
              label={t('ai.filters')}
              items={[
                { value: 'all', label: t('notify.feed.all'), count: d?.counts.all },
                { value: 'todo', label: t('notify.feed.todo'), count: d?.counts.todo, alert: true },
                { value: 'waiting', label: t('notify.feed.waiting'), count: d?.counts.waiting },
                { value: 'whatsapp', label: 'WhatsApp', count: d?.counts.whatsapp },
                { value: 'sms', label: 'SMS', count: d?.counts.sms },
                { value: 'replies', label: t('notify.feed.replies'), count: d?.counts.replies },
                { value: 'problems', label: t('notify.feed.problems'), count: d?.counts.problems, alert: true },
              ]}
            />
            {d?.demo && <p className="ai-note">{t('notify.feed.demoNote')}</p>}
          </aside>
          <div className="ai-main">
            {d && d.counts.todo > 0 && tab !== 'todo' && (
              <div className="cm-bulk nt-banner">
                <span className="cm-bulk-t">
                  <Icon name="send" />
                  {t('notify.feed.todoBanner', { count: d.counts.todo })}
                </span>
                <button type="button" className="btn primary" onClick={() => setTab('todo')}>
                  {t('notify.feed.todoGo')}
                </button>
              </div>
            )}
            {list.isLoading ? (
              <Loading />
            ) : list.error ? (
              <ErrorBox error={list.error} onRetry={() => list.refetch()} />
            ) : !d?.rows.length ? (
              <div className="ai-empty">
                <Icon name="send" />
                <p>{t(`notify.feed.empty_${tab}`, { defaultValue: t('notify.feed.empty') })}</p>
              </div>
            ) : (
              d.rows.map((m) => <MsgCard key={m.id} m={m} />)
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function MsgCard({ m }: { m: Row }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const [opened, setOpened] = useState<'whatsapp' | 'sms' | null>(null);
  const sendNow = useAction('notify.sendNow', {
    onDone: (r) => {
      const bad = r.status === 'skipped' || r.status === 'failed' || r.status === 'queued';
      toast(bad ? r.error ?? t('notify.msg.notSent') : t(`notify.msg.sentVia.${r.status}`, { defaultValue: t('notify.msg.sentVia.whatsapp') }), bad ? 'bad' : 'ok');
    },
  });
  const skip = useAction('notify.skip', { success: t('notify.msg.skippedOk') });
  const mark = useAction('notify.markSent', { success: t('notify.msg.markedOk') });
  const busy = sendNow.isPending || skip.isPending || mark.isPending;
  const st = statusOf(m, t);
  const byHand = m.status === 'manual' || m.status === 'failed';
  const text = encodeURIComponent(m.body);
  return (
    <article className={`cm-card nt-card ${byHand ? 'cm-open' : ''} ${m.status === 'skipped' ? 'nt-dim' : ''}`}>
      <header className="cm-head">
        <ChannelBadge m={m} />
        <span className="cm-who">
          <b>
            <bdi>{m.customerName}</bdi>
          </b>
          <small className="cm-meta nt-line">
            <button type="button" className="linkbtn nt-ref" onClick={() => openOrder(m.orderId)}>
              {m.ref}
            </button>
            <span className="ltr">{m.phone}</span>
            <time dateTime={m.sentAt ?? m.at}>{when(m.sentAt ?? m.at)}</time>
          </small>
        </span>
      </header>
      <div className="cm-tags">
        <span className={`nt-kind nt-k-${m.kind}`}>
          <Icon name={KIND_ICON[m.kind]} /> {t(`notify.kind.${m.kind}`)}
        </span>
        {(m.channel === 'sms' || byHand) && (
          <span className="cm-by">
            {t('notify.msg.parts', { count: m.sms.parts })}
            {m.sms.unicode ? ` · ${t('notify.msg.unicode')}` : ''}
          </span>
        )}
        {m.sentBy && <span className="cm-by">{t('notify.msg.by', { name: m.sentBy })}</span>}
        <span className={`cm-status nt-st ${st.tone}`}>{st.label}</span>
      </div>
      <p className="nt-text" dir="auto">
        {m.body}
      </p>
      {m.error && (
        <p className={m.status === 'failed' ? 'dl-err nt-err' : 'cm-reason'}>
          {m.status === 'failed' ? '⚠ ' : ''}
          {m.error}
        </p>
      )}
      {m.reply && (
        <div className="cm-acts">
          <div className="cm-act">
            <Icon name="reply" />
            <span>
              <small>
                {t('notify.msg.reply')} · {when(m.repliedAt)}
                {m.conversationId && has('confirmation') && (
                  <>
                    {' · '}
                    <a href={`#/messages/inbox/${m.conversationId}`}>{t('notify.msg.openConv')}</a>
                  </>
                )}
              </small>
              <span dir="auto">{m.reply}</span>
            </span>
          </div>
        </div>
      )}
      {(byHand || m.status === 'queued' || m.status === 'skipped') && (
        <footer className="cm-foot">
          {byHand && (
            <>
              <a className="btn small nt-wa-btn" href={`https://wa.me/${intl(m.phone)}?text=${text}`} target="_blank" rel="noreferrer" onClick={() => setOpened('whatsapp')}>
                <Icon name="whatsapp" /> {t('notify.msg.openWa')}
              </a>
              <a className="btn small" href={`sms:+${intl(m.phone)}?body=${text}`} onClick={() => setOpened('sms')}>
                <Icon name="message" /> {t('notify.msg.openSms')}
              </a>
              <button type="button" className={`btn small ${opened ? 'primary' : 'ok'}`} disabled={busy} onClick={() => mark.mutate({ id: m.id, via: opened ?? 'sms' })}>
                <Icon name="check" /> {t('notify.msg.markSent')}
              </button>
            </>
          )}
          {(m.status === 'queued' || m.status === 'failed') && (
            <button type="button" className="btn small" disabled={busy} onClick={() => sendNow.mutate({ id: m.id })}>
              <Icon name="send" /> {m.status === 'failed' ? t('notify.msg.retry') : t('notify.msg.sendNow')}
            </button>
          )}
          {m.status === 'skipped' && (
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => sendNow.mutate({ id: m.id })}>
              <Icon name="send" /> {t('notify.msg.sendAnyway')}
            </button>
          )}
          {m.status !== 'skipped' && (
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => skip.mutate({ id: m.id })}>
              {t('notify.msg.skip')}
            </button>
          )}
        </footer>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- the cases
function TemplatePill({ tpl, whatsapp }: { tpl: Case['template']; whatsapp: boolean }) {
  const { t } = useTranslation();
  if (!whatsapp) return null;
  const s = tpl?.status ?? 'NONE';
  const tone = s === 'APPROVED' ? 'cm-ok' : s === 'PENDING' ? 'cm-new' : s === 'NONE' || s === 'CHANGED' ? 'cm-warn' : 'cm-bad';
  return (
    <span className={`cm-status ${tone}`} title={tpl?.reason ?? ''}>
      <span className="nt-wa-dot" /> {t(`notify.tpl.${s}`, { defaultValue: s })}
    </span>
  );
}

function Flow() {
  const { t } = useTranslation();
  return (
    <div className="nt-flow">
      <ol className="nt-track" aria-label={t('notify.cases.flowLabel')}>
        {(['created', 'confirmed', 'shipped', 'out_for_delivery', 'delivered'] as Kind[]).map((k) => (
          <li key={k} className="nt-stop">
            <span className={`nt-node nt-k-${k}`}>
              <Icon name={KIND_ICON[k]} />
            </span>
            <span className="nt-stop-l">{t(`notify.kind.${k}`)}</span>
          </li>
        ))}
      </ol>
      <p className="nt-alt">
        <span>{t('notify.cases.onTheWay')}</span>
        {(['stopdesk', 'failed', 'returning'] as Kind[]).map((k) => (
          <span key={k} className={`nt-kind nt-k-${k}`}>
            <Icon name={KIND_ICON[k]} /> {t(`notify.kind.${k}`)}
          </span>
        ))}
      </p>
    </div>
  );
}

function Cases({ admin }: { admin: boolean }) {
  const { t } = useTranslation();
  const q = useRpc('notify.cases', {});
  const full = useRpc('notify.settings.get', {}, { enabled: admin });
  const [editing, setEditing] = useState<Kind | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = useAction('notify.templates.submit', {
    onDone: (r) => {
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length) toast(bad.map((x) => `${t(`notify.kind.${x.kind}`)} : ${x.message}`).join('\n'), 'bad');
      else toast(r.results.length ? t('notify.cases.submitted', { count: r.results.length }) : t('notify.cases.nothingToSubmit'), 'ok');
    },
  });
  const check = useAction('notify.templates.check', { success: t('notify.cases.checked') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const settings = full.data?.settings;
  /** saves one change of the settings (a case on/off, a text, the language) */
  const save = async (patch: Partial<NonNullable<typeof settings>>, ok?: string) => {
    if (!settings) return;
    setSaving(true);
    try {
      await rpc('notify.settings.save', { ...settings, ...patch });
      await Promise.all([q.refetch(), full.refetch()]);
      if (ok) toast(ok, 'ok');
      return true;
    } catch (e: any) {
      toast(e?.message ?? 'Erreur', 'bad');
      return false;
    } finally {
      setSaving(false);
    }
  };
  const waiting = d.cases.filter((c) => c.on && c.template?.status !== 'APPROVED').length;
  return (
    <>
      <Card title={t('notify.cases.how')} help={t('notify.cases.howHelp')}>
        <Flow />
        <ol className="nt-steps">
          <li>
            <span className="dl-ch dl-whatsapp">WA</span>
            <span>
              <b>{t('notify.cases.step1')}</b>
              <small>{t('notify.cases.step1Hint')}</small>
            </span>
          </li>
          <li>
            <span className="dl-ch nt-sms">SMS</span>
            <span>
              <b>{t('notify.cases.step2')}</b>
              <small>{t('notify.cases.step2Hint')}</small>
            </span>
          </li>
          <li>
            <span className="dl-ch nt-hand">
              <Icon name="send" />
            </span>
            <span>
              <b>{t('notify.cases.step3')}</b>
              <small>{t('notify.cases.step3Hint')}</small>
            </span>
          </li>
          <li>
            <span className="dl-ch nt-wait">
              <Icon name="moon" />
            </span>
            <span>
              <b>{d.quietFrom === d.quietTo ? t('notify.cases.noNight') : t('notify.cases.night', { from: d.quietFrom, to: d.quietTo })}</b>
              <small>{t('notify.cases.nightHint')}</small>
            </span>
          </li>
        </ol>
        {!d.enabled && <div className="warnbox">{t('notify.off')}</div>}
      </Card>

      <Card
        title={t('notify.cases.title')}
        actions={
          admin && settings ? (
            <select className="nt-lang" aria-label={t('notify.settings.lang')} value={settings.lang} disabled={saving} onChange={(e) => save({ lang: e.target.value as Lang }, t('notify.settings.saved'))}>
              {(['dz', 'fr', 'ar'] as Lang[]).map((l) => (
                <option key={l} value={l}>
                  {t(`notify.lang.${l}`)}
                </option>
              ))}
            </select>
          ) : (
            <span className="cm-by">{t(`notify.lang.${d.lang}`)}</span>
          )
        }
      >
        {admin && d.whatsapp && (
          <div className="nt-meta">
            <span className="muted small">{waiting ? t('notify.cases.metaWaiting', { count: waiting }) : t('notify.cases.metaAllOk')}</span>
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn small" disabled={submit.isPending} onClick={() => submit.mutate({})}>
                <Icon name="send" /> {t('notify.cases.submit')}
              </button>
              <button type="button" className="btn small ghost" disabled={check.isPending} onClick={() => check.mutate({})}>
                <Icon name="refresh" /> {t('notify.cases.check')}
              </button>
            </span>
          </div>
        )}
        <div className="nt-cases">
          {d.cases.map((c) => (
            <div key={c.kind} className={`nt-case ${c.on ? '' : 'nt-off'}`}>
              <div className="nt-case-h">
                <span className={`nt-case-ic nt-k-${c.kind}`}>
                  <Icon name={KIND_ICON[c.kind]} />
                </span>
                <span className="nt-case-t">
                  <b>{t(`notify.kind.${c.kind}`)}</b>
                  <small>{t(`notify.when.${c.kind}`)}</small>
                </span>
                {admin && settings ? (
                  <label className="nt-toggle">
                    <input type="checkbox" checked={c.on} disabled={saving} onChange={(e) => save({ cases: { ...settings.cases, [c.kind]: e.target.checked } })} />
                    <span>{c.on ? t('notify.cases.on') : t('notify.cases.off')}</span>
                  </label>
                ) : (
                  <span className={`cm-status ${c.on ? 'cm-ok' : 'cm-mute'}`}>{c.on ? t('notify.cases.on') : t('notify.cases.off')}</span>
                )}
              </div>
              {editing === c.kind && settings ? (
                <CaseEditor
                  c={c}
                  vars={d.vars as readonly string[]}
                  onCancel={() => setEditing(null)}
                  onSave={async (text) => {
                    const lang = settings.lang;
                    const texts = { ...(settings.texts ?? {}) } as Record<string, Record<string, string>>;
                    texts[c.kind] = { ...(texts[c.kind] ?? {}), [lang]: text };
                    if (await save({ texts }, t('notify.cases.textSaved'))) setEditing(null);
                  }}
                />
              ) : (
                <>
                  <div className="nt-phone">
                    <div className="nt-bubble" dir="auto">
                      {c.example}
                    </div>
                  </div>
                  <div className="nt-case-f">
                    <span className="cm-by">{t('notify.msg.parts', { count: c.sms.parts })}</span>
                    {c.sms.unicode && <span className="cm-by">{t('notify.msg.unicode')}</span>}
                    {c.custom && <span className="cm-by">{t('notify.cases.custom')}</span>}
                    <TemplatePill tpl={c.template} whatsapp={d.whatsapp} />
                    {admin && settings && (
                      <button type="button" className="btn small ghost nt-edit" onClick={() => setEditing(c.kind)}>
                        <Icon name="pencil" /> {t('notify.cases.edit')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <p className="muted small">{t('notify.cases.example')}</p>
      </Card>
    </>
  );
}

function CaseEditor({ c, vars, onSave, onCancel }: { c: Case; vars: readonly string[]; onSave: (text: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(c.text);
  const [p, setP] = useState<Out<'notify.preview'> | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const id = window.setTimeout(() => {
      rpc('notify.preview', { kind: c.kind, text: text.trim() || undefined })
        .then(setP)
        .catch(() => null);
    }, 250);
    return () => window.clearTimeout(id);
  }, [text, c.kind]);
  const insert = (v: string) => {
    const el = ref.current;
    const s = el?.selectionStart ?? text.length;
    const e = el?.selectionEnd ?? s;
    const next = `${text.slice(0, s)}{${v}}${text.slice(e)}`;
    setText(next);
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(s + v.length + 2, s + v.length + 2);
    });
  };
  const problems = text.trim() ? p?.problems ?? [] : [t('notify.cases.empty')];
  return (
    <div className="nt-editor">
      <textarea ref={ref} rows={4} dir="auto" value={text} maxLength={700} aria-label={t('notify.cases.text')} onChange={(e) => setText(e.target.value)} />
      <div className="nt-vars" aria-label={t('notify.cases.vars')}>
        {vars.map((v) => (
          <button key={v} type="button" onClick={() => insert(v)} title={t(`notify.var.${v}`)}>
            {`{${v}}`}
          </button>
        ))}
      </div>
      {p && (
        <>
          <div className="nt-phone">
            <div className="nt-bubble" dir="auto">
              {p.body}
            </div>
          </div>
          <small className="muted">
            {t('notify.msg.parts', { count: p.sms.parts })} · {t('notify.cases.chars', { count: p.sms.length })}
            {p.sms.unicode ? ` · ${t('notify.cases.unicodeWarn')}` : ''}
          </small>
        </>
      )}
      {problems.map((x) => (
        <p key={x} className="dl-err nt-err">
          ⚠ {x}
        </p>
      ))}
      <small className="muted">{t('notify.cases.metaNote')}</small>
      <div className="row nt-editor-acts">
        <button type="button" className="btn small ghost" onClick={() => setText(c.defaultText)}>
          {t('notify.cases.default')}
        </button>
        <span className="grow" />
        <button type="button" className="btn small ghost" onClick={onCancel}>
          {t('notify.cases.cancel')}
        </button>
        <button type="button" className="btn small primary" disabled={problems.length > 0 || text.trim() === c.text} onClick={() => onSave(text.trim())}>
          {t('notify.cases.saveText')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tester
function Tester({ admin }: { admin: boolean }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('shipped');
  const [ref, setRef] = useState('');
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState<Out<'notify.test'> | null>(null);
  const cleanRef = ref.trim().toUpperCase();
  const preview = useRpc('notify.preview', { kind, ref: /^PX\w{3,}$/.test(cleanRef) ? cleanRef : undefined }, { retry: false });
  const test = useAction('notify.test', { onDone: setResult });
  const ok = /^(\+?213|0)?\s*[5-7](\s*\d){8}$/.test(phone.trim());
  return (
    <Card title={t('notify.tester.title')}>
      <div className="ai-try half">
        <div className="ai-try-in">
          <div className="ai-try-side">
            <p className="muted">{t('notify.tester.help')}</p>
            <div className="grid2">
              <Field label={t('notify.tester.kind')}>
                <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`notify.kind.${k}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('notify.tester.ref')} hint={t('notify.tester.refHint')}>
                <input value={ref} maxLength={20} className="ltr" placeholder="PX1234" onChange={(e) => setRef(e.target.value)} />
              </Field>
            </div>
            {admin ? (
              <div className="nt-test-row">
                <Field label={t('notify.tester.phone')}>
                  <input value={phone} inputMode="tel" className="ltr" placeholder="0661 23 45 18" onChange={(e) => setPhone(e.target.value)} />
                </Field>
                <button type="button" className="btn primary" disabled={!ok || test.isPending} onClick={() => test.mutate({ phone: phone.trim(), kind, ref: cleanRef || undefined })}>
                  <Icon name="send" /> {test.isPending ? t('notify.tester.sending') : t('notify.tester.send')}
                </button>
              </div>
            ) : (
              <p className="muted small">{t('notify.tester.adminOnly')}</p>
            )}
            {admin && backend.kind === 'demo' && <p className="muted small">{t('notify.tester.demo')}</p>}
          </div>
          <div className="ai-out" aria-live="polite">
            {preview.error ? (
              <p className="dl-err">⚠ {preview.error.message}</p>
            ) : (
              preview.data && (
                <div className="nt-preview">
                  <div className="nt-phone">
                    <div className="nt-bubble" dir="auto">
                      {preview.data.body}
                    </div>
                  </div>
                  <small className="muted">
                    {t('notify.msg.parts', { count: preview.data.sms.parts })}
                    {preview.data.sms.unicode ? ` · ${t('notify.msg.unicode')}` : ''}
                  </small>
                </div>
              )
            )}
            {result && (
              <article className="nt-result">
                <div className="nt-result-h">
                  <ChannelBadge m={{ channel: result.channel === 'whatsapp' || result.channel === 'sms' ? result.channel : 'manual', status: 'done' }} />
                  <b>{t(`notify.tester.via.${result.channel}`, { defaultValue: result.channel })}</b>
                  {result.demo && <span className="cm-by">{t('notify.tester.simulated')}</span>}
                </div>
                {result.error && <p className="cm-reason">{result.error}</p>}
                <div className="nt-phone">
                  <div className="nt-bubble" dir="auto">
                    {result.body}
                  </div>
                </div>
              </article>
            )}
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
  const q = useRpc('notify.stats', { days });
  const s = q.data;
  const max = Math.max(1, ...KINDS.map((k) => s?.byKind[k]?.sent ?? 0));
  return (
    <Card title={t('notify.results.title')} actions={<PeriodSwitch value={days} onChange={setDays} />}>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !s ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="ai-results">
          <Kpis>
            <Kpi icon="send" label={t('notify.results.sent')} value={n(s.sent)} sub={t('notify.results.split', { wa: n(s.whatsapp), sms: n(s.sms), hand: n(s.manualDone) })} />
            <Kpi icon="eye" label={t('notify.results.read')} value={n(s.read)} rate={s.whatsapp ? s.read / Math.max(1, s.whatsapp) : null} sub={t('notify.results.readSub')} />
            <Kpi icon="reply" label={t('notify.results.replied')} value={n(s.replied)} rate={s.sent ? s.replied / s.sent : null} />
            <Kpi icon="trophy" label={t('notify.results.saved')} value={n(s.saved)} sub={da(s.savedAmount)} tone="ok" help={t('notify.results.savedHelp')} />
          </Kpis>
          <Kpis>
            <Kpi icon="refresh" label={t('notify.results.fallback')} value={n(s.fallback)} sub={t('notify.results.fallbackSub')} />
            <Kpi icon="send" label={t('notify.results.todo')} value={n(s.todo)} tone={s.todo ? 'warn' : undefined} />
            <Kpi icon="alert" label={t('notify.results.failed')} value={n(s.failed)} tone={s.failed ? 'bad' : undefined} />
            <Kpi icon="checkcircle" label={t('notify.results.deliveredRate')} value={pct(s.sent ? s.delivered / s.sent : null)} sub={t('notify.results.deliveredSub')} />
          </Kpis>
          <h3 className="cm-h3">{t('notify.results.byKind')}</h3>
          <div className="cm-bars">
            {KINDS.map((k) => (
              <div key={k} className="cm-bar-row nt-bar-row">
                <span className={`nt-kind nt-k-${k}`}>
                  <Icon name={KIND_ICON[k]} /> {t(`notify.kind.${k}`)}
                </span>
                <span className="cm-bar">
                  <span style={{ width: `${((s.byKind[k]?.sent ?? 0) / max) * 100}%` }} />
                </span>
                <b className="ltr">{n(s.byKind[k]?.sent ?? 0)}</b>
                <small className="muted">{t('notify.results.replies', { count: s.byKind[k]?.replied ?? 0 })}</small>
              </div>
            ))}
          </div>
          <p className="muted small">{t('notify.results.note')}</p>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- settings (admin)
function Settings() {
  const q = useRpc('notify.settings.get', {});
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <SettingsForm key={JSON.stringify(q.data.settings)} data={q.data} />;
}

function SettingsForm({ data }: { data: Out<'notify.settings.get'> }) {
  const { t } = useTranslation();
  const [f, setF] = useState(data.settings);
  const [secret, setSecret] = useState('');
  const save = useAction('notify.settings.save', { success: t('notify.settings.saved'), onDone: () => setSecret('') });
  const hooks = useAction('notify.smsHooks', { success: t('notify.settings.hooksDone') });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const m = data.meta;
  const base = serverUrl() || (backend.kind === 'demo' ? 'https://votre-serveur.dz' : window.location.origin);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const dirty = JSON.stringify(f) !== JSON.stringify(data.settings) || secret.trim() !== '';
  const sw = (k: 'enabled' | 'whatsapp') => (
    <label className="dl-switch">
      <input type="checkbox" checked={f[k]} onChange={(e) => set(k, e.target.checked)} />
      <span>
        <b>{t(`notify.settings.${k}`)}</b>
        <small>{t(`notify.settings.${k}Hint`)}</small>
      </span>
    </label>
  );
  return (
    <>
      <Card title={t('notify.settings.how')}>
        {sw('enabled')}
        <div className="grid2">
          <Field label={t('notify.settings.lang')} hint={t('notify.settings.langHint')}>
            <select value={f.lang} onChange={(e) => set('lang', e.target.value as Lang)}>
              {(['dz', 'fr', 'ar'] as Lang[]).map((l) => (
                <option key={l} value={l}>
                  {t(`notify.lang.${l}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('notify.settings.quiet')} hint={t('notify.settings.quietHint')}>
            <span className="nt-quiet">
              <select aria-label={t('notify.settings.quietFrom')} value={f.quietFrom} onChange={(e) => set('quietFrom', Number(e.target.value))}>
                {hours.map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
              <span className="muted nt-arrow" aria-hidden="true">→</span>
              <select aria-label={t('notify.settings.quietTo')} value={f.quietTo} onChange={(e) => set('quietTo', Number(e.target.value))}>
                {hours.map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </span>
          </Field>
        </div>
      </Card>

      <Card title="WhatsApp" help={t('notify.settings.waHelp')}>
        {sw('whatsapp')}
        <dl className="dl-kv cm-conn">
          <dt>{t('notify.settings.waNumber')}</dt>
          <dd>{m.whatsappConnected ? <span className="cm-okc">✓ {t('notify.settings.connected')}</span> : <a href="#/messages/reglages">{t('notify.settings.waConnect')}</a>}</dd>
        </dl>
        {!m.appSecret && (
          <div className="warnbox" style={{ marginBottom: 12 }}>
            {t('notify.settings.appSecretMissing')} <a href="#/messages/reglages">{t('notify.settings.appSecretLink')}</a>
          </div>
        )}
        <Field label={t('notify.settings.waba')} hint={t('notify.settings.wabaHint')}>
          <input className="ltr" inputMode="numeric" value={f.wabaId} maxLength={40} placeholder="102938475610293" onChange={(e) => set('wabaId', e.target.value.replace(/\D/g, ''))} />
        </Field>
        <p className="muted small">{t('notify.settings.waTemplates')}</p>
      </Card>

      <Card title={t('notify.settings.smsTitle')} help={t('notify.settings.smsHelp')}>
        <div className="nt-modes" role="radiogroup" aria-label={t('notify.settings.smsTitle')}>
          {(['gateway', 'manual', 'off'] as const).map((k) => (
            <label key={k} className={`nt-mode ${f.sms === k ? 'on' : ''}`}>
              <input type="radio" name="nt-sms" checked={f.sms === k} onChange={() => set('sms', k)} />
              <span>
                <b>{t(`notify.settings.sms_${k}`)}</b>
                <small>{t(`notify.settings.sms_${k}Hint`)}</small>
              </span>
            </label>
          ))}
        </div>
        {f.sms === 'gateway' && (
          <>
            <div className="grid2">
              <Field label={t('notify.settings.provider')}>
                <select value={f.smsProvider} onChange={(e) => set('smsProvider', e.target.value as 'android' | 'http')}>
                  <option value="android">{t('notify.settings.android')}</option>
                  <option value="http">{t('notify.settings.http')}</option>
                </select>
              </Field>
              <Field label={t('notify.settings.smsUrl')} hint={f.smsProvider === 'android' ? t('notify.settings.smsUrlAndroid') : t('notify.settings.smsUrlHttp')}>
                <input className="ltr" value={f.smsUrl} maxLength={300} placeholder={f.smsProvider === 'android' ? 'https://api.sms-gate.app' : 'https://…'} onChange={(e) => set('smsUrl', e.target.value.trim())} />
              </Field>
              {f.smsProvider === 'android' && (
                <Field label={t('notify.settings.smsUser')}>
                  <input className="ltr" value={f.smsUser} maxLength={120} autoComplete="off" onChange={(e) => set('smsUser', e.target.value.trim())} />
                </Field>
              )}
              <Field label={f.smsProvider === 'android' ? t('notify.settings.smsPass') : t('notify.settings.smsToken')} hint={m.smsSecret ? t('notify.settings.secretKept') : undefined}>
                <input type="password" className="ltr" value={secret} maxLength={500} autoComplete="new-password" placeholder={m.smsSecret ? '••••••••' : ''} onChange={(e) => setSecret(e.target.value)} />
              </Field>
            </div>
            {f.smsProvider === 'android' && (
              <div className="bjch-setup nt-setup">
                <b>{t('notify.settings.androidHow')}</b>
                <ol>
                  {(t('notify.settings.androidSteps', { returnObjects: true }) as string[]).map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ol>
              </div>
            )}
            <div className="dl-hook">
              <Field label={t('notify.settings.hook')} hint={t('notify.settings.hookHint')}>
                <CopyCode code={`${shopApi(base)}/hooks/sms?key=${data.settings.hookKey}`} />
              </Field>
              {f.smsProvider === 'android' && (
                <div className="nt-hook-btn">
                  <button type="button" className="btn small" disabled={hooks.isPending || (!m.smsSecret && !m.demo)} onClick={() => hooks.mutate({ baseUrl: base })} title={m.smsSecret || m.demo ? '' : t('notify.settings.hooksNeedSecret')}>
                    <Icon name="refresh" /> {t('notify.settings.hooks')}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
        {f.sms === 'manual' && <p className="muted small">{t('notify.settings.manualNote')}</p>}
        {backend.kind === 'demo' && <p className="muted small">{t('notify.settings.demo')}</p>}
      </Card>

      <SaveBar dirty={dirty} busy={save.isPending} onSave={() => save.mutate({ ...f, smsSecret: secret.trim() })} label={t('notify.settings.save')} />
    </>
  );
}
