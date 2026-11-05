// Marketing › Campagnes: WhatsApp offers to the shop's own customers who said yes. The campaigns with their results
// (sent, read, answers, « Je commande », the orders and the money they brought), and on the side the customers who
// accept the offers (the box of the landing pages, the agents, a pasted list), and the pace. A campaign is written in a
// window with its WhatsApp preview: who gets it, the message and its buttons, when. Everything is decided in core
// (campaigns.*); Meta approves each message once.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, fromLocalInput, n, pct, toLocalInput, when, wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import './formulaires.css';
import './campagnes.css';

type List = Out<'campaigns.list'>;
type Campaign = List['campaigns'][number];
type Lang = 'dz' | 'fr' | 'ar';
interface Audience {
  productIds: number[];
  wilayas: number[];
  delivered: boolean;
  noReturns: boolean;
  minDays: number | null;
  maxDays: number | null;
}
const EMPTY_AUDIENCE: Audience = { productIds: [], wilayas: [], delivered: true, noReturns: true, minDays: null, maxDays: null };
const BUTTONS: Record<Lang, { order: string; stop: string; link: string }> = {
  dz: { order: 'Nkommandi', stop: 'Stop', link: 'Chouf le produit' },
  fr: { order: 'Je commande', stop: 'Stop', link: 'Voir le produit' },
  ar: { order: 'أطلب الآن', stop: 'إيقاف', link: 'شاهد المنتج' },
};
const SAMPLE: Record<Lang, string> = { dz: 'Amina', fr: 'Amina', ar: 'أمينة' };
/** A first text to change, in the message's language (not the screen's: Meta checks the language). */
const SAMPLE_BODY: Record<Lang, string> = {
  dz: 'Salam {nom}, merci 3la la confiance ! Kayen jdid 3and {boutique} had la semaine. Clicki 3la « Nkommandi » w n3aytoulek bach nconfirmiw.',
  fr: 'Bonjour {nom}, merci pour votre confiance ! Chez {boutique}, nous avons une nouveauté pour vous cette semaine. Appuyez sur « Je commande » et nous vous appelons pour confirmer.',
  ar: 'السلام عليكم {nom}، شكرا على ثقتكم! لدينا جديد عند {boutique} هذا الأسبوع. اضغطوا على « أطلب الآن » وسنتصل بكم لتأكيد الطلب.',
};

/** The same checks as the server (campaigns.ts campaignProblems), said before sending to Meta. */
function problemsOf(text: string, t: (k: string) => string): string[] {
  const out: string[] = [];
  const s = text.trim();
  for (const m of s.matchAll(/\{(\w*)\}/g)) if (!['nom', 'boutique'].includes(m[1])) out.push(t('campaigns.edit.pbVar'));
  if (/^\{\w+\}/.test(s) || /\{\w+\}$/.test(s)) out.push(t('campaigns.edit.pbEdge'));
  if (s.length < 20) out.push(t('campaigns.edit.pbShort'));
  if (s.length > 900) out.push(t('campaigns.edit.pbLong'));
  return [...new Set(out)];
}
const fill = (text: string, name: string, shop: string) => text.replace(/\{nom\}/g, name).replace(/\{boutique\}/g, shop);

export function Campagnes() {
  const { t } = useTranslation();
  const q = useRpc('campaigns.list', {}, { refetchInterval: 20_000 });
  const [edit, setEdit] = useState<Campaign | 'new' | null>(null);
  const [view, setView] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const d = q.data;
  if (q.error && !d) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  return (
    <div className="lf cp">
      <section className="lf-main" aria-labelledby="cp-title">
        <div className="lf-head">
          <h2 id="cp-title">{t('campaigns.title')}</h2>
          <button type="button" className="lf-btn primary cp-new" onClick={() => setEdit('new')}>
            <Icon name="plus" />
            {t('campaigns.new')}
          </button>
        </div>
        {(!d.ready.whatsapp || !d.ready.waba) && d.ready.live && (
          <div className="cp-warn" role="note">
            <Icon name="alert" />
            <span>
              {!d.ready.whatsapp ? t('campaigns.ready.whatsapp') : t('campaigns.ready.waba')}{' '}
              <a href={!d.ready.whatsapp ? '#/messages/reglages' : '#/notify/reglages'}>{t('campaigns.ready.fix')}</a>
            </span>
          </div>
        )}
        {d.campaigns.length ? (
          <ol className="cp-list">
            {d.campaigns.map((c) => (
              <li key={c.id}>
                <CampaignCard c={c} perDay={d.settings.perDay} onEdit={() => setEdit(c)} onView={() => setView(c.id)} />
              </li>
            ))}
          </ol>
        ) : (
          <div className="lf-empty">
            <Icon name="send" />
            <h3>{t('campaigns.empty.title')}</h3>
            <p>{t('campaigns.empty.text')}</p>
            <button type="button" className="lf-btn primary" onClick={() => setEdit('new')}>
              {t('campaigns.new')}
            </button>
          </div>
        )}
      </section>
      <aside className="lf-side">
        <Consent d={d} onImport={() => setImporting(true)} />
        <Pace d={d} />
      </aside>
      {edit && <Editor c={edit === 'new' ? null : edit} d={d} onClose={() => setEdit(null)} />}
      {view !== null && <Results id={view} onClose={() => setView(null)} />}
      {importing && <Import onClose={() => setImporting(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- one campaign
function CampaignCard({ c, perDay, onEdit, onView }: { c: Campaign; perDay: number; onEdit: () => void; onView: () => void }) {
  const { t } = useTranslation();
  const submit = useAction('campaigns.submit', { success: (r) => (r.status === 'ready' ? t('campaigns.toast.approved') : t('campaigns.toast.sent')) });
  const check = useAction('campaigns.check', { success: (r) => (r.changed ? t('campaigns.toast.checked') : t('campaigns.toast.still')) });
  const start = useAction('campaigns.start', { success: (r) => t('campaigns.toast.started', { count: r.stats.total }) });
  const state = useAction('campaigns.state');
  const remove = useAction('campaigns.remove', { success: t('campaigns.toast.removed') });
  const busy = submit.isPending || check.isPending || start.isPending || state.isPending || remove.isPending;
  const s = c.stats;
  const started = ['sending', 'paused', 'done', 'canceled'].includes(c.status);
  const running = c.status === 'sending' || c.status === 'paused';
  const done = s.total - s.queued;
  const meta = [
    c.productName,
    running ? t('campaigns.meta.started', { when: when(c.startedAt) }) : null,
    c.status === 'done' || c.status === 'canceled' ? t('campaigns.meta.done', { when: when(c.finishedAt ?? c.startedAt) }) : null,
    !started ? t('campaigns.meta.created', { when: when(c.createdAt) }) : null,
    c.sendAt && !started ? t('campaigns.meta.at', { when: when(c.sendAt) }) : null,
  ].filter(Boolean) as string[];
  return (
    <article className={`cp-card st-${c.status}`}>
      <div className="cp-top">
        <div className="cp-name">
          <h3>
            <bdi>{c.name}</bdi>
          </h3>
          <span className={`cp-pill st-${c.status}`}>{t(`campaigns.status.${c.status}`)}</span>
        </div>
        <div className="cp-actions">
          {(c.status === 'draft' || c.status === 'rejected' || c.status === 'ready') && (
            <button type="button" className="lf-btn" onClick={onEdit}>
              <Icon name="pencil" />
              {t('campaigns.act.edit')}
            </button>
          )}
          {(c.status === 'draft' || c.status === 'rejected') && (
            <button type="button" className="lf-btn primary" disabled={busy} onClick={() => submit.mutate({ id: c.id })}>
              {t('campaigns.act.submit')}
            </button>
          )}
          {c.status === 'pending' && (
            <button type="button" className="lf-btn" disabled={busy} onClick={() => check.mutate({})}>
              <Icon name="refresh" />
              {t('campaigns.act.check')}
            </button>
          )}
          {c.status === 'ready' && (
            <button type="button" className="lf-btn primary" disabled={busy} onClick={() => window.confirm(t('campaigns.act.startAsk', { name: c.name, perDay })) && start.mutate({ id: c.id })}>
              <Icon name="send" />
              {c.sendAt && Date.parse(c.sendAt) > Date.now() ? t('campaigns.act.schedule') : t('campaigns.act.start')}
            </button>
          )}
          {c.status === 'sending' && (
            <button type="button" className="lf-btn" disabled={busy} onClick={() => state.mutate({ id: c.id, action: 'pause' })}>
              <Icon name="pause" />
              {t('campaigns.act.pause')}
            </button>
          )}
          {c.status === 'paused' && (
            <button type="button" className="lf-btn primary" disabled={busy} onClick={() => state.mutate({ id: c.id, action: 'resume' })}>
              <Icon name="play" />
              {t('campaigns.act.resume')}
            </button>
          )}
          {started && (
            <button type="button" className="lf-btn" onClick={onView}>
              {c.status === 'done' || c.status === 'canceled' ? t('campaigns.act.results') : t('campaigns.act.view')}
            </button>
          )}
        </div>
      </div>
      {meta.length > 0 && (
        <p className="cp-meta">
          {meta.map((x, i) => (
            <span key={i}>
              <bdi>{x}</bdi>
            </span>
          ))}
        </p>
      )}
      {c.status === 'rejected' && (
        <p className="cp-why" role="note">
          <Icon name="alert" />
          <span>{t('campaigns.rejected', { why: c.templateReason ?? '—' })}</span>
        </p>
      )}
      {c.status === 'pending' && (
        <p className="cp-wait" role="note">
          <Icon name="hourglass" />
          <span>{t('campaigns.pending')}</span>
        </p>
      )}
      {!started && c.status !== 'rejected' && (
        <p className="cp-text" dir={c.lang === 'ar' ? 'rtl' : 'ltr'}>
          <span>
            <WithVars text={c.body} />
          </span>
        </p>
      )}
      {started && (
        <>
          {running && (
            <div className="cp-progress">
              <div className="lf-bar" aria-hidden="true">
                <span style={{ width: `${s.total ? Math.round((done / s.total) * 100) : 0}%` }} />
              </div>
              <span>{t('campaigns.progress', { done: n(done), total: n(s.total) })}</span>
            </div>
          )}
          <dl className="cp-stats">
            <Stat label={t('campaigns.stat.sent')} value={n(s.sent)} />
            <Stat label={t('campaigns.stat.read')} value={n(s.read)} sub={s.sent ? pct(s.read / s.sent) : undefined} />
            <Stat label={t('campaigns.stat.replied')} value={n(s.replied)} />
            <Stat label={t('campaigns.stat.ordered')} value={n(s.ordered)} />
            <Stat label={t('campaigns.stat.orders')} value={n(s.orders)} tone={s.orders ? 'ok' : undefined} />
            <Stat label={t('campaigns.stat.revenue')} value={da(s.revenue)} tone={s.revenue ? 'ok' : undefined} />
          </dl>
        </>
      )}
      {(!started || running) && (
        <div className="cp-foot">
          {running ? (
            <button type="button" className="lf-link mute" disabled={busy} onClick={() => window.confirm(t('campaigns.act.cancelAsk', { count: s.queued })) && state.mutate({ id: c.id, action: 'cancel' })}>
              {t('campaigns.act.cancel')}
            </button>
          ) : (
            <button type="button" className="lf-link mute" disabled={busy} onClick={() => window.confirm(t('campaigns.act.removeAsk', { name: c.name })) && remove.mutate({ id: c.id })}>
              {t('campaigns.act.remove')}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/** The text of a campaign, its variables marked: « Salam [nom] ». */
function WithVars({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <>
      {text.split(/(\{(?:nom|boutique)\})/g).map((x, i) =>
        /^\{(nom|boutique)\}$/.test(x) ? (
          <mark key={i} className="cp-var">
            {x === '{nom}' ? t('campaigns.var.nom') : t('campaigns.var.boutique')}
          </mark>
        ) : (
          <Fragment key={i}>{x}</Fragment>
        ),
      )}
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' }) {
  return (
    <div className={tone === 'ok' ? 'ok' : ''}>
      <dt>{label}</dt>
      <dd>
        <span className="ltr">{value}</span>
        {sub && <small className="ltr">{sub}</small>}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------- the side: who says yes, the pace
function Consent({ d, onImport }: { d: List; onImport: () => void }) {
  const { t } = useTranslation();
  const save = useAction('campaigns.settings', { success: (r) => (r.formOptin ? t('campaigns.consent.boxOn') : t('campaigns.consent.boxOff')) });
  const c = d.consent;
  return (
    <section className="lf-card" aria-labelledby="cp-yes">
      <h2 id="cp-yes">{t('campaigns.consent.title')}</h2>
      <p className="lf-big">
        {n(c.yes)} <span>{t('campaigns.consent.of', { count: c.customers })}</span>
      </p>
      <ul className="cp-src">
        <li>
          <span>{t('campaigns.consent.form')}</span>
          <b className="ltr">{n(c.form)}</b>
        </li>
        <li>
          <span>{t('campaigns.consent.call')}</span>
          <b className="ltr">{n(c.call)}</b>
        </li>
        <li>
          <span>{t('campaigns.consent.import')}</span>
          <b className="ltr">{n(c.import)}</b>
        </li>
        <li className="stop">
          <span>{t('campaigns.consent.stop')}</span>
          <b className="ltr">{n(c.stop)}</b>
        </li>
      </ul>
      <div className="cp-toggle">
        <span>
          <b>{t('campaigns.consent.box')}</b>
          <small>{t('campaigns.consent.boxHint')}</small>
        </span>
        <button
          type="button"
          role="switch"
          className="lf-switch"
          aria-checked={d.settings.formOptin}
          aria-label={t('campaigns.consent.box')}
          disabled={save.isPending}
          onClick={() => save.mutate({ perDay: d.settings.perDay, formOptin: !d.settings.formOptin })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <p className="lf-muted cp-small">{t('campaigns.consent.agents')}</p>
      <button type="button" className="lf-btn cp-wide" onClick={onImport}>
        <Icon name="upload" />
        {t('campaigns.consent.importBtn')}
      </button>
    </section>
  );
}

function Pace({ d }: { d: List }) {
  const { t } = useTranslation();
  const [perDay, setPerDay] = useState(d.settings.perDay);
  useEffect(() => setPerDay(d.settings.perDay), [d.settings.perDay]);
  const save = useAction('campaigns.settings', { success: t('campaigns.pace.saved') });
  return (
    <section className="lf-card" aria-labelledby="cp-pace">
      <h2 id="cp-pace">{t('campaigns.pace.title')}</h2>
      <p className="cp-small">{t('campaigns.pace.text', { from: d.quiet.from, to: d.quiet.to })}</p>
      <form
        className="cp-pace"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ perDay, formOptin: d.settings.formOptin });
        }}
      >
        <label>
          <span>{t('campaigns.pace.perDay')}</span>
          <input type="number" min={10} max={100000} value={perDay} onChange={(e) => setPerDay(Math.max(10, Number(e.target.value) || 10))} />
        </label>
        <button type="submit" className="lf-btn" disabled={save.isPending || perDay === d.settings.perDay}>
          {t('campaigns.pace.save')}
        </button>
      </form>
      <p className="lf-muted cp-small">{t('campaigns.pace.today', { count: d.sentToday })}</p>
      <p className="lf-muted cp-small">{t('campaigns.pace.meta')}</p>
    </section>
  );
}

// ---------------------------------------------------------------- writing a campaign
function Editor({ c, d, onClose }: { c: Campaign | null; d: List; onClose: () => void }) {
  const { t } = useTranslation();
  const opts = useRpc('campaigns.options', {});
  const [name, setName] = useState(c?.name ?? '');
  const [aud, setAud] = useState<Audience>(c?.audience ?? EMPTY_AUDIENCE);
  const [lang, setLang] = useState<Lang>(() => {
    const l = (c?.lang ?? d.lang) as Lang;
    return l in BUTTONS ? l : 'dz';
  });
  const [body, setBody] = useState(() => c?.body ?? SAMPLE_BODY[lang]);
  const [productId, setProductId] = useState<number | null>(c?.productId ?? null);
  const [link, setLink] = useState<string>(c?.link ?? '');
  const [orderButton, setOrderButton] = useState(c?.orderButton ?? true);
  const [sendAt, setSendAt] = useState<string>(c?.sendAt ? toLocalInput(Date.parse(c.sendAt)) : '');
  // the count waits for the choice to settle
  const [debounced, setDebounced] = useState(aud);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(aud), 350);
    return () => clearTimeout(h);
  }, [aud]);
  const count = useRpc('campaigns.audience', { audience: debounced });
  const save = useAction('campaigns.save');
  // once saved, the same campaign (a refused « Envoyer à Meta » must not make a second one)
  const [savedId, setSavedId] = useState<number | undefined>(c?.id);
  const submit = useAction('campaigns.submit', { success: (r) => (r.status === 'ready' ? t('campaigns.toast.approved') : t('campaigns.toast.sent')) });
  const problems = problemsOf(body, t);
  const wasReady = c?.status === 'ready';
  const b = BUTTONS[lang];
  const input = () => ({ id: savedId, name: name.trim(), audience: aud, lang, body: body.trim(), productId, link: link || null, orderButton, sendAt: sendAt ? fromLocalInput(sendAt) : null });
  const doSave = (andSubmit: boolean) =>
    save.mutate(input(), {
      onSuccess: (r) => {
        setSavedId(r.id);
        // an approved campaign whose text did not change stays approved
        if (andSubmit && r.status !== 'ready') submit.mutate({ id: r.id }, { onSuccess: onClose });
        else {
          toast(t('campaigns.toast.saved'), 'ok');
          onClose();
        }
      },
    });
  const pages = opts.data?.pages ?? [];
  const products = opts.data?.products ?? [];
  const wilayas = opts.data?.wilayas ?? [];
  const toggle = <K extends 'productIds' | 'wilayas'>(k: K, v: number) => setAud((a) => ({ ...a, [k]: a[k].includes(v) ? a[k].filter((x) => x !== v) : [...a[k], v] }));
  const insert = (v: string) => setBody((x) => `${x.replace(/\s+$/, '')} {${v}} `);
  const busy = save.isPending || submit.isPending;
  return (
    <Modal
      wide
      sheet
      title={c ? t('campaigns.edit.titleEdit', { name: c.name }) : t('campaigns.edit.titleNew')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('campaigns.edit.cancel')}
          </button>
          {!wasReady && (
            <button type="button" className="btn" disabled={busy || name.trim().length < 2} onClick={() => doSave(false)}>
              {t('campaigns.edit.saveDraft')}
            </button>
          )}
          <button type="button" className="btn primary" disabled={busy || name.trim().length < 2 || problems.length > 0} onClick={() => doSave(true)}>
            {wasReady ? t('campaigns.edit.save') : t('campaigns.edit.saveSubmit')}
          </button>
        </>
      }
    >
      <div className="cp-edit">
        <div className="cp-form">
          {wasReady && <p className="lf-note">{t('campaigns.edit.readyNote')}</p>}
          {c?.status === 'rejected' && <p className="cp-why">{t('campaigns.rejected', { why: c.templateReason ?? '—' })}</p>}
          <label className="lf-field">
            <span>{t('campaigns.edit.name')}</span>
            <input value={name} maxLength={120} placeholder={t('campaigns.edit.namePh')} onChange={(e) => setName(e.target.value)} />
          </label>

          <fieldset className="cp-step">
            <legend>{t('campaigns.edit.who')}</legend>
            <div className="lf-field">
              <span>{t('campaigns.edit.products')}</span>
              <Chips items={aud.productIds.map((id) => ({ id, label: products.find((p) => p.id === id)?.name ?? `#${id}` }))} onRemove={(id) => toggle('productIds', id)} empty={t('campaigns.edit.allProducts')} />
              <select aria-label={t('campaigns.edit.products')} value="" onChange={(e) => e.target.value && toggle('productIds', Number(e.target.value))}>
                <option value="">{t('campaigns.edit.addProduct')}</option>
                {products
                  .filter((p) => !aud.productIds.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="lf-field">
              <span>{t('campaigns.edit.wilayas')}</span>
              <Chips items={aud.wilayas.map((id) => ({ id, label: `${String(id).padStart(2, '0')} ${wilayaName(id)}` }))} onRemove={(id) => toggle('wilayas', id)} empty={t('campaigns.edit.allWilayas')} />
              <select aria-label={t('campaigns.edit.wilayas')} value="" onChange={(e) => e.target.value && toggle('wilayas', Number(e.target.value))}>
                <option value="">{t('campaigns.edit.addWilaya')}</option>
                {wilayas
                  .filter((w) => !aud.wilayas.includes(w.id))
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {String(w.id).padStart(2, '0')} · {wilayaName(w.id)}
                    </option>
                  ))}
              </select>
            </div>
            <label className="lf-check">
              <input type="checkbox" checked={aud.delivered} onChange={(e) => setAud((a) => ({ ...a, delivered: e.target.checked }))} />
              <span>{t('campaigns.edit.delivered')}</span>
            </label>
            <label className="lf-check">
              <input type="checkbox" checked={aud.noReturns} onChange={(e) => setAud((a) => ({ ...a, noReturns: e.target.checked }))} />
              <span>{t('campaigns.edit.noReturns')}</span>
            </label>
            <div className="cp-days" role="group" aria-labelledby="cp-last">
              <span id="cp-last">{t('campaigns.edit.lastOrder')}</span>
              <label>
                <span>{t('campaigns.edit.moreThan')}</span>
                <input type="number" min={0} max={3650} value={aud.minDays ?? ''} placeholder="—" onChange={(e) => setAud((a) => ({ ...a, minDays: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) }))} />
                <span>{t('campaigns.edit.days')}</span>
              </label>
              <label>
                <span>{t('campaigns.edit.lessThan')}</span>
                <input type="number" min={0} max={3650} value={aud.maxDays ?? ''} placeholder="—" onChange={(e) => setAud((a) => ({ ...a, maxDays: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) }))} />
                <span>{t('campaigns.edit.days')}</span>
              </label>
            </div>
            <div className={`cp-count ${count.data && !count.data.count ? 'none' : ''}`} aria-live="polite">
              <Icon name="users" />
              <span>
                <b>{count.data ? t('campaigns.edit.count', { count: count.data.count }) : '…'}</b>
                {count.data && count.data.sample.length > 0 && <small>{t('campaigns.edit.sample2', { names: count.data.sample.join(', ') })}</small>}
                {count.data && !count.data.count && <small>{t('campaigns.edit.countNone')}</small>}
              </span>
            </div>
          </fieldset>

          <fieldset className="cp-step">
            <legend>{t('campaigns.edit.message')}</legend>
            <div className="cp-seg" role="radiogroup" aria-label={t('campaigns.edit.lang')}>
              {(['dz', 'fr', 'ar'] as Lang[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={lang === l}
                  className={lang === l ? 'on' : ''}
                  onClick={() => {
                    // the first text, untouched, follows the language
                    if (body === SAMPLE_BODY[lang]) setBody(SAMPLE_BODY[l]);
                    setLang(l);
                  }}
                >
                  {t(`campaigns.lang.${l}`)}
                </button>
              ))}
            </div>
            <label className="lf-field">
              <span>{t('campaigns.edit.text')}</span>
              <textarea rows={6} value={body} maxLength={1000} dir={lang === 'ar' ? 'rtl' : 'ltr'} onChange={(e) => setBody(e.target.value)} />
            </label>
            <div className="cp-vars">
              <span>{t('campaigns.edit.insert')}</span>
              <button type="button" onClick={() => insert('nom')}>
                {'{nom}'}
              </button>
              <button type="button" onClick={() => insert('boutique')}>
                {'{boutique}'}
              </button>
            </div>
            {problems.length > 0 && (
              <ul className="cp-problems" role="alert">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <label className="lf-field">
              <span>{t('campaigns.edit.product')}</span>
              <select
                value={productId ?? ''}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : null;
                  setProductId(id);
                  // its page, when it has one
                  const page = pages.find((p) => p.productId === id && p.url);
                  if (id && page && !link) setLink(page.url);
                }}
              >
                <option value="">{t('campaigns.edit.noProduct')}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <small>{t('campaigns.edit.productHint', { label: b.order })}</small>
            </label>
            <label className="lf-check">
              <input type="checkbox" checked={orderButton} onChange={(e) => setOrderButton(e.target.checked)} />
              <span>{t('campaigns.edit.orderButton', { label: b.order })}</span>
            </label>
            <label className="lf-field">
              <span>{t('campaigns.edit.link')}</span>
              <select value={link} onChange={(e) => setLink(e.target.value)}>
                <option value="">{t('campaigns.edit.noLink')}</option>
                {link && !pages.some((p) => p.url === link) && <option value={link}>{link}</option>}
                {pages
                  .filter((p) => p.url)
                  .map((p) => (
                    <option key={p.slug} value={p.url}>
                      {p.title}
                    </option>
                  ))}
              </select>
            </label>
          </fieldset>

          <fieldset className="cp-step">
            <legend>{t('campaigns.edit.whenTitle')}</legend>
            <label className={`lf-radio ${!sendAt ? 'on' : ''}`}>
              <input type="radio" name="cp-when" checked={!sendAt} onChange={() => setSendAt('')} />
              <span>
                <b>{t('campaigns.edit.whenNow')}</b>
                <small>{t('campaigns.edit.whenNowHint')}</small>
              </span>
            </label>
            <label className={`lf-radio ${sendAt ? 'on' : ''}`}>
              <input type="radio" name="cp-when" checked={!!sendAt} onChange={() => setSendAt(toLocalInput(Date.now() + 86_400_000))} />
              <span>
                <b>{t('campaigns.edit.whenAt')}</b>
                {sendAt && <input type="datetime-local" className="cp-at" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />}
              </span>
            </label>
          </fieldset>
        </div>

        <div className="cp-preview" aria-label={t('campaigns.edit.preview')}>
          <div className="cp-phone">
            <div className="cp-chat-head">
              <span className="cp-avatar" aria-hidden="true">
                {(d.shopName || 'P').slice(0, 1)}
              </span>
              <b>
                <bdi>{d.shopName || 'Pilotix'}</bdi>
              </b>
            </div>
            <div className="cp-chat">
              <div className="cp-bubble" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
                <p>{fill(body, SAMPLE[lang], d.shopName || 'Pilotix') || '…'}</p>
                <time>12:00</time>
              </div>
              <div className="cp-btns">
                {orderButton && (
                  <span>
                    <Icon name="reply" />
                    {b.order}
                  </span>
                )}
                <span>
                  <Icon name="reply" />
                  {b.stop}
                </span>
                {link && (
                  <span>
                    <Icon name="external" />
                    {b.link}
                  </span>
                )}
              </div>
            </div>
          </div>
          <p className="lf-muted cp-small">{t('campaigns.edit.metaNote')}</p>
        </div>
      </div>
    </Modal>
  );
}

function Chips({ items, onRemove, empty }: { items: { id: number; label: string }[]; onRemove: (id: number) => void; empty: string }) {
  const { t } = useTranslation();
  if (!items.length) return <p className="cp-all">{empty}</p>;
  return (
    <ul className="cp-chips">
      {items.map((x) => (
        <li key={x.id}>
          <bdi>{x.label}</bdi>
          <button type="button" aria-label={t('campaigns.edit.remove', { label: x.label })} onClick={() => onRemove(x.id)}>
            <Icon name="x" />
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- results
function Results({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('campaigns.get', { id }, { refetchInterval: 20_000 });
  const d = q.data;
  const state = useAction('campaigns.state');
  const sends = useMemo(() => d?.sends ?? [], [d]);
  return (
    <Modal wide sheet title={d ? d.campaign.name : t('campaigns.act.view')} onClose={onClose}>
      {!d ? (
        <Loading />
      ) : (
        <div className="cp-results">
          <dl className="cp-stats big">
            <Stat label={t('campaigns.stat.sent')} value={n(d.campaign.stats.sent)} />
            <Stat label={t('campaigns.stat.delivered')} value={n(d.campaign.stats.delivered)} />
            <Stat label={t('campaigns.stat.read')} value={n(d.campaign.stats.read)} sub={d.campaign.stats.sent ? pct(d.campaign.stats.read / d.campaign.stats.sent) : undefined} />
            <Stat label={t('campaigns.stat.replied')} value={n(d.campaign.stats.replied)} />
            <Stat label={t('campaigns.stat.ordered')} value={n(d.campaign.stats.ordered)} />
            <Stat label={t('campaigns.stat.stopped')} value={n(d.campaign.stats.stopped)} />
            <Stat label={t('campaigns.stat.orders')} value={n(d.campaign.stats.orders)} tone="ok" />
            <Stat label={t('campaigns.stat.revenue')} value={da(d.campaign.stats.revenue)} tone="ok" />
          </dl>
          <p className="lf-muted cp-small">{t('campaigns.results.ordersHint')}</p>
          {d.campaign.status === 'sending' && (
            <button type="button" className="lf-btn" disabled={state.isPending} onClick={() => state.mutate({ id, action: 'pause' })}>
              <Icon name="pause" />
              {t('campaigns.act.pause')}
            </button>
          )}
          <table className="cp-table">
            <thead>
              <tr>
                <th>{t('campaigns.results.customer')}</th>
                <th>{t('campaigns.results.status')}</th>
                <th>{t('campaigns.results.answer')}</th>
                <th>{t('campaigns.results.order')}</th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>
                      <bdi>{s.name || '—'}</bdi>
                    </b>
                    <small className="ltr">{s.phone}</small>
                  </td>
                  <td>
                    <span className={`cp-dot st-${s.status}`}>{t(`campaigns.send.${s.status}`, { defaultValue: s.status })}</span>
                    {s.error && <small className="cp-err">{s.error}</small>}
                  </td>
                  <td>{s.tapped === 'order' ? <span className="lf-tag ok">{t('campaigns.results.tapOrder')}</span> : s.tapped === 'stop' ? <span className="lf-tag mute">Stop</span> : s.repliedAt ? t('campaigns.results.replied') : '—'}</td>
                  <td>{s.orderRef ? <span className="lf-tag ok ltr">{s.orderRef}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- a list pasted
function Import({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const run = useAction('campaigns.import', {
    onDone: (r) => {
      toast(t('campaigns.import.done', { added: r.added, unknown: r.unknown, invalid: r.invalid }), 'ok');
      onClose();
    },
  });
  return (
    <Modal
      sheet
      title={t('campaigns.import.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('campaigns.edit.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!text.trim() || run.isPending} onClick={() => run.mutate({ phones: text })}>
            {t('campaigns.import.ok')}
          </button>
        </>
      }
    >
      <div className="lf-modal">
        <p className="lf-note">{t('campaigns.import.rule')}</p>
        <label className="lf-field">
          <span>{t('campaigns.import.label')}</span>
          <textarea rows={8} className="ltr" value={text} placeholder={'0661 23 45 78\n0770 11 92 40'} onChange={(e) => setText(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
