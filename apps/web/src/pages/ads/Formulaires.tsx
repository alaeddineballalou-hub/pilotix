// Marketing › Formulaires: the leads of the shop's Facebook and Instagram ad forms, live. Each one became its order, or
// says what it waits for, with the button that solves it there: the wilaya to choose (« Bordj »: 34 or 50?), the number to
// fix, the form's product to choose, a duplicate to create anyway. On the side: today's result and the forms (each one on
// or off, its product, « Créer la commande » or « Garder à vérifier »). Everything is decided in core (leads.*).
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WILAYAS } from '@pilotix/shared';
import type { Out } from '../../lib/backend';
import { clock, pct, sameDay, shortWhen, since, wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import './formulaires.css';

type Feed = Out<'leads.feed'>;
type Lead = Feed['rows'][number];
type Form = Feed['forms'][number];
const FILTERS = ['all', 'created', 'fix', 'waiting', 'dup'] as const;
type Filter = (typeof FILTERS)[number];
const PAGE = 40;

/** 0661234578 → 0661 23 45 78 */
const fmtPhone = (p: string | null) => (p && /^0\d{9}$/.test(p) ? `${p.slice(0, 4)} ${p.slice(4, 6)} ${p.slice(6, 8)} ${p.slice(8)}` : (p ?? ''));
const place = (l: Lead) => [l.wilayaId ? wilayaName(l.wilayaId) : null, l.commune].filter(Boolean).join(', ');

/** The parts of a line (« Poussette · Rose · Sétif »), each one in its own direction (a French name on an Arabic page). */
function Parts({ items }: { items: (string | null | false | undefined)[] }) {
  const list = items.filter(Boolean) as string[];
  return (
    <>
      {list.map((x, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          <bdi>{x}</bdi>
        </Fragment>
      ))}
    </>
  );
}

export function Formulaires() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  const [formId, setFormId] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [editing, setEditing] = useState<Form | null>(null);
  const q = useRpc('leads.feed', { filter, formId: formId || undefined, limit }, { refetchInterval: 15_000 });
  const d = q.data;
  if (q.error && !d) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  const formOf = (id: string) => d.forms.find((f) => f.formId === id) ?? null;
  const empty = !d.forms.length && !d.counts.all;
  return (
    <div className="lf">
      <section className="lf-main" aria-labelledby="lf-title">
        <div className="lf-head">
          <h2 id="lf-title">{t('leads.title')}</h2>
          <span className="lf-live">
            <span aria-hidden="true" />
            {t('leads.live')}
          </span>
          {d.forms.length > 1 && (
            <label className="lf-pick">
              {t('leads.form')}
              <select
                value={formId}
                onChange={(e) => {
                  setFormId(e.target.value);
                  setLimit(PAGE);
                }}
              >
                <option value="">{t('leads.allForms', { n: d.forms.length })}</option>
                {d.forms.map((f) => (
                  <option key={f.formId} value={f.formId}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {!empty && (
          <div className="lf-chips" role="group" aria-label={t('leads.filterLabel')}>
            {FILTERS.map((k) => (
              <button
                key={k}
                type="button"
                className={`lf-chip c-${k}`}
                aria-pressed={filter === k}
                onClick={() => {
                  setFilter(k);
                  setLimit(PAGE);
                }}
              >
                {t(`leads.chips.${k}`)} · {d.counts[k]}
              </button>
            ))}
          </div>
        )}
        {empty ? (
          <Empty page={d.page} />
        ) : d.rows.length ? (
          <ol className="lf-feed">
            {d.rows.map((l) => (
              <li key={l.id}>
                <Row l={l} form={formOf(l.formId)} onForm={setEditing} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="lf-none">{t('leads.noneHere')}</p>
        )}
        {d.more > 0 && (
          <button type="button" className="lf-btn lf-more" onClick={() => setLimit((n) => Math.min(500, n + PAGE))}>
            {t('leads.more', { count: d.more })}
          </button>
        )}
      </section>
      <aside className="lf-side">
        <Today today={d.today} />
        <Forms forms={d.forms} live={d.live} onEdit={setEditing} />
      </aside>
      {editing && <FormModal form={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- one lead
function Row({ l, form, onForm }: { l: Lead; form: Form | null; onForm: (f: Form) => void }) {
  const { t } = useTranslation();
  const { has } = useSession();
  // a marketer does not open orders (Confirmation does): the reference is enough for him
  const canOpen = has('confirmation', 'suivi', 'depot', 'agent_manager', 'vendeur');
  const fix = useAction('leads.fix', { onDone: (r) => r.status === 'created' && toast(t('leads.done', { ref: r.order?.ref ?? '' }), 'ok') });
  const create = useAction('leads.create', { onDone: (r) => r.status === 'created' && toast(t('leads.done', { ref: r.order?.ref ?? '' }), 'ok') });
  const ignore = useAction('leads.ignore');
  const retry = useAction('leads.retry', { onDone: (r) => r.status === 'created' && toast(t('leads.done', { ref: r.order?.ref ?? '' }), 'ok') });
  const save = useAction('leads.formSave', { onDone: (r: any) => toast(r.created ? t('leads.modal.savedCreated', { count: r.created }) : t('leads.modal.saved'), 'ok') });
  const busy = fix.isPending || create.isPending || ignore.isPending || retry.isPending || save.isPending;
  const [phone, setPhone] = useState<string | null>(null);
  const [pickW, setPickW] = useState<number | ''>('');
  const [otherW, setOtherW] = useState(false);
  const formName = form?.name || l.formName || t('leads.aForm');
  const product = l.product ?? form?.productName ?? '';
  const tone = l.status === 'fix' || l.status === 'error' ? 'warn' : l.status === 'waiting' ? 'info' : l.status === 'test' || l.status === 'ignored' ? 'mute' : '';
  const tel = l.phone && /^0\d{9}$/.test(l.phone) ? `tel:${l.phone}` : null;

  const who = (
    <div className="lf-who">
      <b>
        <bdi>{l.isTest ? t('leads.testName') : l.name || t('leads.noName')}</bdi>
      </b>{' '}
      {l.problem === 'phone' ? (
        <span className="lf-bad">· {l.phone ? t('leads.phoneShort', { phone: l.phone }) : t('leads.phoneNone')}</span>
      ) : (
        !l.isTest && l.phone && <span className="ltr lf-muted">· {fmtPhone(l.phone)}</span>
      )}
      <br />
      <span className="lf-what">
        {l.status === 'waiting' && l.problem === 'product' ? (
          <span className="lf-info">{t('leads.noProduct', { form: formName, count: form?.waiting ?? 1 })}</span>
        ) : l.status === 'waiting' && l.problem === 'off' ? (
          <span className="lf-info">{t('leads.off', { form: formName })}</span>
        ) : l.status === 'waiting' && l.problem === 'review' ? (
          <span className="lf-info">{t('leads.review', { form: formName })}</span>
        ) : l.status === 'dup' && l.dup ? (
          t('leads.dup', { ref: l.dup.ref, date: shortWhen(l.dup.at) })
        ) : l.status === 'error' ? (
          <span className="lf-bad">{t('leads.error', { error: l.error ?? '' })}</span>
        ) : l.status === 'test' ? (
          t('leads.test')
        ) : (
          <Parts items={[product, l.qty > 1 ? `× ${l.qty}` : null, place(l)]} />
        )}
      </span>
    </div>
  );

  return (
    <article className={`lf-row ${tone} ${l.problem === 'wilaya' ? 'ring' : ''}`}>
      <div className="lf-line">
        <When at={l.at} />
        <span className={`lf-net ${l.platform}`} title={t(`leads.net.${l.platform}`)}>
          {l.platform === 'ig' ? 'IG' : 'FB'}
        </span>
        {who}
        {l.status === 'created' && l.order && (
          <>
            <span className="lf-tag ok">
              <Icon name="check" />
              {t('leads.order', { ref: l.order.ref })}
            </span>
            {canOpen && (
              <button type="button" className="lf-btn" onClick={() => openOrder(l.order!.id)}>
                {t('leads.open')}
              </button>
            )}
          </>
        )}
        {l.status === 'fix' && <span className="lf-tag warn">{t('leads.chips.fix')}</span>}
        {l.status === 'fix' && l.problem === 'phone' && phone === null && (
          <button type="button" className="lf-btn warn" onClick={() => setPhone('')}>
            {t('leads.fixPhone')}
          </button>
        )}
        {l.status === 'waiting' && l.problem === 'product' && form && (
          <button type="button" className="lf-btn primary" onClick={() => onForm(form)}>
            {t('leads.pickProduct')}
          </button>
        )}
        {l.status === 'waiting' && l.problem === 'off' && form && (
          <button type="button" className="lf-btn primary" disabled={busy} onClick={() => save.mutate({ id: form.id, productId: form.productId, variantId: form.variantId, active: true, mode: form.mode, dupDays: form.dupDays })}>
            {t('leads.turnOn')}
          </button>
        )}
        {((l.status === 'waiting' && l.problem === 'review') || l.status === 'ignored') && (
          <button type="button" className="lf-btn primary" disabled={busy} onClick={() => create.mutate({ id: l.id })}>
            {t('leads.create')}
          </button>
        )}
        {l.status === 'dup' && (
          <>
            <span className="lf-tag mute">{t('leads.dupTag')}</span>
            <button type="button" className="lf-btn" disabled={busy} onClick={() => create.mutate({ id: l.id })}>
              {t('leads.createAnyway')}
            </button>
          </>
        )}
        {l.status === 'error' && (
          <button type="button" className="lf-btn warn" disabled={busy} onClick={() => retry.mutate({ id: l.id })}>
            {t('leads.retry')}
          </button>
        )}
        {l.status === 'test' && <span className="lf-tag info">{t('leads.testTag')}</span>}
        {l.status === 'ignored' && <span className="lf-tag mute">{t('leads.ignored')}</span>}
      </div>

      {/* the wilaya to choose: the ones the word can be, or any */}
      {l.status === 'fix' && l.problem === 'wilaya' && (
        <div className="lf-act">
          <span>{l.wrote ? t('leads.wrote', { text: l.wrote }) : t('leads.noWilaya')}</span>
          {!otherW &&
            l.candidates.map((c) => (
              <button key={c.id} type="button" className="lf-btn warn" disabled={busy} onClick={() => fix.mutate({ id: l.id, wilayaId: c.id })}>
                <span className="ltr">{String(c.id).padStart(2, '0')}</span> · {wilayaName(c.id)}
              </button>
            ))}
          {otherW || !l.candidates.length ? (
            <form
              className="lf-inline"
              onSubmit={(e) => {
                e.preventDefault();
                if (pickW) fix.mutate({ id: l.id, wilayaId: Number(pickW) });
              }}
            >
              <select aria-label={t('leads.pickWilaya')} value={pickW} onChange={(e) => setPickW(e.target.value ? Number(e.target.value) : '')}>
                <option value="">{t('leads.pickWilaya')}</option>
                {WILAYAS.map((_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {String(i + 1).padStart(2, '0')} · {wilayaName(i + 1)}
                  </option>
                ))}
              </select>
              <button type="submit" className="lf-btn primary" disabled={!pickW || busy}>
                {t('leads.ok')}
              </button>
            </form>
          ) : (
            <button type="button" className="lf-link" onClick={() => setOtherW(true)}>
              {t('leads.otherWilaya')}
            </button>
          )}
          {tel && (
            <a className="lf-link" href={tel}>
              {t('leads.call')}
            </a>
          )}
          <button type="button" className="lf-link mute" disabled={busy} onClick={() => ignore.mutate({ id: l.id })}>
            {t('leads.ignore')}
          </button>
        </div>
      )}

      {/* the number, typed again */}
      {l.status === 'fix' && l.problem === 'phone' && phone !== null && (
        <form
          className="lf-act lf-inline"
          onSubmit={(e) => {
            e.preventDefault();
            fix.mutate({ id: l.id, phone });
          }}
        >
          <label>
            <span className="sr-only">{t('leads.phoneLabel')}</span>
            <input className="ltr" type="tel" inputMode="tel" autoComplete="off" placeholder="0661 23 45 78" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus />
          </label>
          <button type="submit" className="lf-btn primary" disabled={phone.replace(/\D/g, '').length < 9 || busy}>
            {t('leads.ok')}
          </button>
          <button type="button" className="lf-link mute" onClick={() => setPhone(null)}>
            {t('leads.cancel')}
          </button>
        </form>
      )}

      {/* what the customer answered: to check a lead that waits for a person (an order already has it all) */}
      {!['test', 'created'].includes(l.status) && l.answers.length > 0 && (
        <details className="lf-answers">
          <summary>{t('leads.answers', { count: l.answers.length })}</summary>
          <dl>
            {l.answers.map((a, i) => (
              <div key={i}>
                <dt>{a.label || a.key.replace(/_/g, ' ')}</dt>
                <dd>{a.value}</dd>
              </div>
            ))}
          </dl>
          {l.adName && <p className="lf-muted">{t('leads.ad', { ad: l.adName })}</p>}
        </details>
      )}
    </article>
  );
}

/** « 14:52 / il y a 4 min » this last hour, « 14:52 » today, « hier / 14:52 » before. */
function When({ at }: { at: string }) {
  const { t } = useTranslation();
  const today = sameDay(at, new Date().toISOString());
  const fresh = Date.now() - Date.parse(at) < 3_600_000;
  return (
    <div className="lf-when">
      <b className="ltr">{today ? clock(at) : shortWhen(at)}</b>
      {today ? fresh && <span>{t('leads.ago', { d: since(at) })}</span> : <span className="ltr">{clock(at)}</span>}
    </div>
  );
}

function Empty({ page }: { page: Feed['page'] }) {
  const { t } = useTranslation();
  return (
    <div className="lf-empty">
      <Icon name="inbox" />
      <h3>{t('leads.empty.title')}</h3>
      <p>{t('leads.empty.text')}</p>
      {page ? (
        <p className="lf-muted">{t('leads.empty.page', { page: page.name })}</p>
      ) : (
        <a className="lf-btn primary" href="#/comptes">
          {t('leads.empty.link')}
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the side: today, the forms
function Today({ today }: { today: Feed['today'] }) {
  const { t } = useTranslation();
  const rate = today.leads ? today.orders / today.leads : 0;
  return (
    <section className="lf-card" aria-labelledby="lf-today">
      <h2 id="lf-today">{t('leads.today.title')}</h2>
      {today.leads ? (
        <>
          <p className="lf-big">
            {today.orders} <span>{t('leads.today.orders', { count: today.leads })}</span>
          </p>
          <div className="lf-bar" role="img" aria-label={t('leads.today.rate', { pct: pct(rate) })}>
            <span style={{ width: `${Math.round(rate * 100)}%` }} />
          </div>
          <p className="lf-muted">{t('leads.today.rate', { pct: pct(rate) })}</p>
        </>
      ) : (
        <p className="lf-muted">{t('leads.today.none')}</p>
      )}
    </section>
  );
}

function Forms({ forms, live, onEdit }: { forms: Form[]; live: boolean; onEdit: (f: Form) => void }) {
  const { t } = useTranslation();
  const sync = useAction('leads.syncForms', { onDone: (r) => toast(t('leads.forms.synced', { count: r.forms }), 'ok') });
  const save = useAction('leads.formSave', { onDone: (r: any) => r.created > 0 && toast(t('leads.modal.savedCreated', { count: r.created }), 'ok') });
  return (
    <section className="lf-card" aria-labelledby="lf-forms">
      <div className="lf-card-head">
        <h2 id="lf-forms">{t('leads.forms.title')}</h2>
        {live && (
          <button type="button" className="lf-link" disabled={sync.isPending} onClick={() => sync.mutate({})}>
            <Icon name="refresh" />
            {t('leads.forms.refresh')}
          </button>
        )}
      </div>
      {forms.length ? (
        <ul className="lf-forms">
          {forms.map((f) => (
            <li key={f.id}>
              <button type="button" className="lf-form" onClick={() => onEdit(f)}>
                <b>
                  <bdi>{f.name}</bdi>
                </b>
                <span className={!f.productId ? 'lf-warn' : ''}>
                  <Parts
                    items={[
                      f.metaStatus !== 'ACTIVE' ? t('leads.forms.archived') : !f.active ? t('leads.forms.stopped') : !f.productId ? t('leads.forms.noProduct') : f.productName,
                      f.active && !!f.productId && f.mode === 'review' && t('leads.forms.review'),
                      t('leads.forms.leads', { count: f.leads }),
                      f.waiting > 0 && t('leads.forms.waiting', { count: f.waiting }),
                    ]}
                  />
                </span>
              </button>
              <button
                type="button"
                role="switch"
                className="lf-switch"
                aria-checked={f.active}
                aria-label={t('leads.forms.switch', { form: f.name })}
                disabled={save.isPending}
                onClick={() => save.mutate({ id: f.id, productId: f.productId, variantId: f.variantId, active: !f.active, mode: f.mode, dupDays: f.dupDays })}
              >
                <span aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="lf-muted">{t('leads.forms.none')}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- a form's settings
function FormModal({ form, onClose }: { form: Form; onClose: () => void }) {
  const { t } = useTranslation();
  const products = useRpc('leads.products', {});
  const [productId, setProductId] = useState<number | null>(form.productId);
  const [variantId, setVariantId] = useState<number | null>(form.variantId);
  const [mode, setMode] = useState(form.mode);
  const [active, setActive] = useState(form.active);
  const [dupDays, setDupDays] = useState(form.dupDays);
  const save = useAction('leads.formSave', {
    onDone: (r: any) => {
      toast(r.created ? t('leads.modal.savedCreated', { count: r.created }) : t('leads.modal.saved'), 'ok');
      onClose();
    },
  });
  const variants = useMemo(() => products.data?.find((p) => p.id === productId)?.variants.filter((v) => v.title) ?? [], [products.data, productId]);
  return (
    <Modal
      sheet
      title={t('leads.modal.title', { form: form.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('leads.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ id: form.id, productId, variantId: productId ? variantId : null, active, mode, dupDays })}>
            {t('leads.modal.save')}
          </button>
        </>
      }
    >
      <div className="lf-modal">
        {form.waiting > 0 && !form.productId && <p className="lf-note">{t('leads.modal.waiting', { count: form.waiting })}</p>}
        <label className="lf-field">
          <span>{t('leads.modal.product')}</span>
          <select
            value={productId ?? ''}
            onChange={(e) => {
              setProductId(e.target.value ? Number(e.target.value) : null);
              setVariantId(null);
            }}
          >
            <option value="">{t('leads.modal.choose')}</option>
            {(products.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {variants.length > 1 && (
          <label className="lf-field">
            <span>{t('leads.modal.variant')}</span>
            <select value={variantId ?? ''} onChange={(e) => setVariantId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('leads.modal.variantAuto')}</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="lf-field">
          <legend>{t('leads.modal.mode')}</legend>
          {(['order', 'review'] as const).map((m) => (
            <label key={m} className={`lf-radio ${mode === m ? 'on' : ''}`}>
              <input type="radio" name="lf-mode" checked={mode === m} onChange={() => setMode(m)} />
              <span>
                <b>{t(`leads.modal.${m}`)}</b>
                <small>{t(`leads.modal.${m}Hint`)}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="lf-field lf-row-field">
          <span>{t('leads.modal.dup')}</span>
          <input type="number" min={0} max={60} value={dupDays} onChange={(e) => setDupDays(Math.max(0, Math.min(60, Number(e.target.value) || 0)))} />
          <small>{t('leads.modal.dupHint')}</small>
        </label>
        <label className="lf-check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>{t('leads.modal.active')}</span>
        </label>
        {form.questions.length > 0 && (
          <details className="lf-answers">
            <summary>{t('leads.modal.questions', { count: form.questions.length })}</summary>
            <ul>
              {form.questions.map((q) => (
                <li key={q.key}>{q.label || q.key}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}
