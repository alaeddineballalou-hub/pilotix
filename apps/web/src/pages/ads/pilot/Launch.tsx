// « Lancer une pub ». Simple: four steps (the product, what you want, the ad, the budget). Pro: everything on one page
// (who sees it, the wilayas left out, the budget's shape, a test of each photo or video, the bid), with the same
// preview and checks. Everything goes to Meta PAUSED and is turned on in one go; the owner may want to say yes first.
// The numbers (what a delivered order may cost, the budgets suggested) come from core (ads.launch.options).
// Marketing › Influenceurs opens it with a creator (…/lancer/avec/<id>: an ad in the shop's name and the creator's) or
// with one of the creator's posts (…/lancer/booster/<post id>: the post itself becomes the ad).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, Out, rpc } from '../../../lib/backend';
import { da, dec1, n, since, wilayaName } from '../../../lib/format';
import { useAction, useRpc } from '../../../lib/query';
import { store } from '../../../lib/store';
import { Empty, ErrorBox, Icon, Loading } from '../../../ui/kit';
import { toast } from '../../../ui/toast';
import { toPlanPhoto } from '../../social/jpeg';
import { readVideo, sendPieces, videoBody, VideoError } from '../../social/video';
import { clientId, usd } from './Hub';

type Opt = Out<'ads.launch.options'>;
type P = Opt['products'][number];
type Media = Out<'ads.media.list'>[number];
type Goal = 'sales' | 'messages' | 'calls' | 'form' | 'awareness' | 'traffic' | 'engagement';
type Channel = 'messenger' | 'instagram' | 'whatsapp';
type Lang = 'darija' | 'fr' | 'ar';
const SIMPLE_GOALS: Goal[] = ['sales', 'messages', 'calls', 'form', 'awareness'];
const PRO_GOALS: Goal[] = [...SIMPLE_GOALS, 'traffic', 'engagement'];
const GOAL_ICON: Record<Goal, string> = { sales: 'cart', messages: 'message', calls: 'phone', form: 'clipboard', awareness: 'eye', traffic: 'globe', engagement: 'heart' };
const CTA: Record<Goal, string> = { sales: 'shop', messages: 'message', calls: 'call', form: 'signup', awareness: 'learn', traffic: 'learn', engagement: 'learn' };

interface Draft {
  id: number | null;
  clientId: string;
  goal: Goal;
  productId: number | null;
  name: string;
  mediaIds: number[];
  text: { primary: string; headline: string };
  lang: Lang;
  channels: Channel[];
  welcome: { text: string; questions: string[] } | null;
  phone: string;
  formId: string | null;
  newForm: { name: string; commune: boolean; variant: boolean; privacyUrl: string; lang: 'fr' | 'ar' } | null;
  postId: string | null;
  budgetUsd: number;
  budgetLevel: 'campaign' | 'adset';
  split: 'one' | 'perMedia';
  excludeWilayas: number[];
  ageMin: number;
  ageMax: number;
  genders: (1 | 2)[];
  advantageAudience: boolean;
  useAudiences: boolean;
  bid: { strategy: 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_BID_CAP'; usd: number | null } | null;
  start: string | null;
  pixelId: string | null;
  /** Marketing › Influenceurs: the creator whose name the ad carries too, or whose post is boosted */
  partnerId: number | null;
  partnerContentId: string | null;
}
const fresh = (): Draft => ({
  id: null,
  clientId: clientId(),
  goal: 'sales',
  productId: null,
  name: '',
  mediaIds: [],
  text: { primary: '', headline: '' },
  lang: (store.get('ads-lang') as Lang) || 'darija',
  channels: ['messenger'],
  welcome: null,
  phone: '',
  formId: null,
  newForm: null,
  postId: null,
  budgetUsd: 10,
  budgetLevel: 'campaign',
  split: 'one',
  excludeWilayas: [],
  ageMin: 18,
  ageMax: 65,
  genders: [],
  advantageAudience: true,
  useAudiences: true,
  bid: null,
  start: null,
  pixelId: null,
  partnerId: null,
  partnerContentId: null,
});
/** the goals a creator's post may be boosted for (an Instagram post gets the shop's link and button) */
const BOOST_GOALS: Record<'INSTAGRAM' | 'FACEBOOK', Goal[]> = { INSTAGRAM: ['sales', 'traffic', 'awareness'], FACEBOOK: ['awareness'] };
const specOf = (d: Draft) => ({
  goal: d.goal,
  productId: d.productId,
  name: d.name.trim() || 'Pub',
  mediaIds: d.mediaIds,
  text: d.text,
  channels: d.channels,
  welcome: d.goal === 'messages' ? d.welcome : null,
  phone: d.goal === 'calls' ? d.phone || null : null,
  formId: d.goal === 'form' ? d.formId : null,
  newForm: d.goal === 'form' && !d.formId ? d.newForm : null,
  postId: d.goal === 'engagement' ? d.postId : null,
  budgetUsd: d.budgetUsd,
  budgetLevel: d.budgetLevel,
  split: d.split,
  excludeWilayas: d.excludeWilayas,
  ageMin: d.ageMin,
  ageMax: d.ageMax,
  genders: d.genders,
  advantageAudience: d.advantageAudience,
  useAudiences: d.useAudiences,
  bid: d.bid,
  start: d.start,
  pixelId: d.pixelId,
  partnerId: d.goal === 'engagement' ? null : d.partnerId,
  partnerContentId: d.goal === 'engagement' ? null : d.partnerContentId,
});
const phoneOk = (v: string) => /^\+213[5-7]\d{8}$/.test(v.replace(/\s/g, '')) || /^0[5-7]\d{8}$/.test(v.replace(/\s/g, ''));

export function Launch({ base, rest }: { base: string; rest?: string[] }) {
  const { t } = useTranslation();
  // opened from Influenceurs: …/lancer/avec/<creator> or …/lancer/booster/<post>
  const pre = useMemo(() => {
    const id = rest?.[2] ? decodeURIComponent(rest[2]) : '';
    return { partnerId: rest?.[1] === 'avec' && /^\d+$/.test(id) ? Number(id) : null, contentId: rest?.[1] === 'booster' && /^[\w.:-]{3,80}$/.test(id) ? id : null };
  }, [rest]);
  const q = useRpc('ads.launch.options', { contentId: pre.contentId });
  const lib = useRpc('ads.media.list', {});
  const [mode, setMode] = useState<'simple' | 'pro'>(() => (store.get('ads-launch-mode') === 'pro' ? 'pro' : 'simple'));
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>(() => ({ ...fresh(), partnerId: pre.partnerId, partnerContentId: pre.contentId }));
  const [done, setDone] = useState<Out<'ads.launch.go'> | null>(null);
  const set = (p: Partial<Draft>) => setD((o) => ({ ...o, ...p }));
  const o = q.data;
  const product = o?.products.find((p) => p.id === d.productId) ?? null;
  // a creator's post to boost: its creator, and a goal it may be boosted for
  const boost = d.partnerContentId && o?.boost?.id === d.partnerContentId ? o.boost : null;
  useEffect(() => {
    if (!boost) return;
    const allowed = BOOST_GOALS[boost.platform];
    setD((x) => ({ ...x, partnerId: boost.partnerId ?? x.partnerId, mediaIds: [], goal: allowed.includes(x.goal) ? x.goal : allowed[0] }));
  }, [boost?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // a creator chosen in Influenceurs, now: the same one here
  useEffect(() => {
    if (pre.partnerId) setD((x) => ({ ...x, partnerId: pre.partnerId, partnerContentId: null }));
    else if (pre.contentId) setD((x) => ({ ...x, partnerContentId: pre.contentId }));
  }, [pre.partnerId, pre.contentId]);
  const cancelBoost = () => {
    set({ partnerContentId: null });
    location.hash = `${base}/lancer`;
  };
  const goalsOf = (all: Goal[]) => (boost ? all.filter((g) => BOOST_GOALS[boost.platform].includes(g)) : all);
  const chooseMode = (m: 'simple' | 'pro') => {
    setMode(m);
    store.set('ads-launch-mode', m);
  };
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!o) return <Loading />;
  if (done)
    return (
      <Done
        r={done}
        base={base}
        onAgain={() => {
          setDone(null);
          setD(fresh());
          setStep(0);
        }}
      />
    );
  const problems = readiness(t, o, d, product, lib.data ?? []);
  const props = { o, d, set, product, lib: lib.data ?? [], refetchLib: () => lib.refetch(), cancelBoost };
  return (
    <div className="pa-launch">
      <div className="pa-launch-head">
        <div>
          <h2>{t('pilotads.launch.title')}</h2>
          <p className="muted">{t('pilotads.launch.sub')}</p>
        </div>
        <div className="pa-mode" role="radiogroup" aria-label={t('pilotads.mode.label')}>
          {(['simple', 'pro'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => chooseMode(m)}>
              {t(`pilotads.mode.${m}`)}
            </button>
          ))}
        </div>
      </div>
      {o.guard.stopped && <div className="error">{t('pilotads.stop.isOnLaunch')}</div>}
      {!o.account && <div className="warnbox">{t('pilotads.launch.noAccount')}</div>}
      {mode === 'simple' ? (
        <div className="pa-wizard">
          <ol className="pa-steps" aria-label={t('pilotads.launch.stepsLabel')}>
            {(['product', 'goal', 'ad', 'budget'] as const).map((k, i) => (
              <li key={k} className={i === step ? 'on' : i < step ? 'done' : ''}>
                <button type="button" onClick={() => i <= step && setStep(i)} disabled={i > step} aria-current={i === step ? 'step' : undefined}>
                  <b className="ltr">{i < step ? <Icon name="check" /> : i + 1}</b>
                  <span>{t(`pilotads.step.${k}`)}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="pa-wizard-body">
            <div className="pa-wizard-main">
              {step === 0 && <StepProduct {...props} onNext={() => setStep(1)} />}
              {step === 1 && <StepGoal {...props} goals={goalsOf(SIMPLE_GOALS)} />}
              {step === 2 && <StepAd {...props} />}
              {step === 3 && <StepBudget {...props} />}
              <div className="pa-nav">
                {step > 0 && (
                  <button type="button" className="btn" onClick={() => setStep(step - 1)}>
                    {t('common.back')}
                  </button>
                )}
                {step < 3 ? (
                  <button type="button" className="btn primary" disabled={!stepOk(step, d, product, !!boost)} onClick={() => setStep(step + 1)}>
                    {t('pilotads.launch.next')}
                  </button>
                ) : (
                  <GoButton o={o} d={d} problems={problems} mode="simple" onDone={setDone} onSaved={(id) => set({ id })} />
                )}
              </div>
            </div>
            <aside className="pa-wizard-side">
              <Preview o={o} d={d} lib={lib.data ?? []} />
              {step === 3 && <Checks problems={problems} />}
            </aside>
          </div>
        </div>
      ) : (
        <div className="pa-pro">
          <div className="pa-pro-main">
            <section className="card">
              <h3 className="pa-h">{t('pilotads.pro.what')}</h3>
              <StepProduct {...props} compact />
              <StepGoal {...props} goals={goalsOf(PRO_GOALS)} compact />
            </section>
            <section className="card">
              <h3 className="pa-h">{t('pilotads.pro.ad')}</h3>
              <StepAd {...props} pro />
            </section>
            <section className="card">
              <h3 className="pa-h">{t('pilotads.pro.who')}</h3>
              <Targeting {...props} />
            </section>
            <section className="card">
              <h3 className="pa-h">{t('pilotads.pro.money')}</h3>
              <StepBudget {...props} pro />
              <ProMoney {...props} />
            </section>
          </div>
          <aside className="pa-pro-side">
            <Preview o={o} d={d} lib={lib.data ?? []} />
            <TestPlan d={d} product={product} />
            <Checks problems={problems} />
            <GoButton o={o} d={d} problems={problems} mode="pro" onDone={setDone} onSaved={(id) => set({ id })} />
          </aside>
        </div>
      )}
      <Launches onOpen={(l) => {
        setD({ ...fresh(), ...(l.spec as any), id: l.id, clientId: clientId(), lang: d.lang, phone: l.spec.phone ?? '', mediaIds: l.spec.mediaIds ?? [], bid: l.spec.bid ?? null });
        setStep(mode === 'simple' ? 3 : 0);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }} />
    </div>
  );
}

const stepOk = (step: number, d: Draft, p: P | null, boosting = false) =>
  step === 0 ? !!p : step === 1 ? true : step === 2 ? boosting || (!!d.text.primary.trim() && (d.mediaIds.length > 0 || d.goal === 'engagement')) : true;

/** What is still missing before « Lancer » (the server checks it again). */
function readiness(t: (k: string, o?: any) => string, o: Opt, d: Draft, p: P | null, lib: Media[]): { ok: boolean; text: string }[] {
  const out: { ok: boolean; text: string }[] = [];
  out.push({ ok: !!p, text: p ? t('pilotads.check.product', { name: p.name }) : t('pilotads.check.noProduct') });
  out.push({ ok: !!o.page, text: o.page ? t('pilotads.check.page', { name: o.page.name }) : t('pilotads.check.noPage') });
  if (d.goal === 'sales' || d.goal === 'traffic') out.push({ ok: !!p?.landing, text: p?.landing ? t('pilotads.check.landing') : t('pilotads.check.noLanding') });
  if (d.goal === 'sales') out.push({ ok: !!(d.pixelId || p?.landing?.pixelId || o.pixels.length), text: o.pixels.length || p?.landing?.pixelId ? t('pilotads.check.pixel') : t('pilotads.check.noPixel') });
  if (d.goal === 'calls') out.push({ ok: phoneOk(d.phone), text: phoneOk(d.phone) ? t('pilotads.check.phone', { v: d.phone }) : t('pilotads.check.noPhone') });
  if (d.goal === 'messages') out.push({ ok: d.channels.length > 0, text: d.channels.length ? t('pilotads.check.channels', { v: d.channels.map((c) => t(`pilotads.ch.${c}`)).join(' + ') }) : t('pilotads.check.noChannels') });
  if (d.goal === 'form') out.push({ ok: !!d.formId || !!(d.newForm?.privacyUrl && /^https?:\/\//.test(d.newForm.privacyUrl)), text: d.formId || d.newForm?.privacyUrl ? t('pilotads.check.form') : t('pilotads.check.noForm') });
  const boost = d.partnerContentId && o.boost?.id === d.partnerContentId ? o.boost : null;
  const partner = o.partners.find((x) => x.id === d.partnerId) ?? null;
  if (d.partnerContentId) out.push({ ok: !!boost?.boostable, text: boost ? (boost.boostable ? t('pilotads.partner.checkBoost', { name: partner?.name ?? boost.author.name }) : (boost.errors[0]?.message ?? t('partners.posts.elig.INELIGIBLE'))) : t('pilotads.partner.checkNoBoost') });
  else if (d.goal !== 'engagement') {
    const sel = lib.filter((m) => d.mediaIds.includes(m.id));
    out.push({ ok: sel.length > 0, text: sel.length ? t('pilotads.check.media', { n: sel.length }) : t('pilotads.check.noMedia') });
    out.push({ ok: !!d.text.primary.trim(), text: d.text.primary.trim() ? t('pilotads.check.text') : t('pilotads.check.noText') });
    if (partner) out.push({ ok: true, text: partner.status === 'pending' ? t('pilotads.partner.pending', { name: partner.name }) : t('pilotads.partner.check', { name: partner.name }) });
  } else out.push({ ok: !!d.postId, text: d.postId ? t('pilotads.check.post') : t('pilotads.check.noPost') });
  out.push({ ok: d.budgetUsd >= 1, text: t('pilotads.check.budget', { v: usd(d.budgetUsd, 0) }) });
  if (o.guard.stopped) out.push({ ok: false, text: t('pilotads.stop.isOn') });
  return out;
}

// ---------------------------------------------------------------- step 1: the product
function StepProduct({ o, d, set, compact, onNext }: { o: Opt; d: Draft; set: (p: Partial<Draft>) => void; compact?: boolean; onNext?: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const list = o.products.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));
  const choose = (p: P) => {
    set({ productId: p.id, name: d.name || `${p.name} — ${t(`pilotads.goal.${d.goal}.short`)}`, pixelId: d.pixelId ?? p.landing?.pixelId ?? null });
    if (!compact) onNext?.();
  };
  if (!o.products.length) return <Empty>{t('pilotads.launch.noProducts')}</Empty>;
  if (compact)
    return (
      <label className="field">
        <span className="lab">{t('pilotads.step.product')}</span>
        <select value={d.productId ?? ''} onChange={(e) => { const p = o.products.find((x) => x.id === Number(e.target.value)); if (p) choose(p); }}>
          <option value="">{t('pilotads.launch.pickProduct')}</option>
          {o.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {da(p.price)}
            </option>
          ))}
        </select>
        {d.productId && <LimitLine p={o.products.find((x) => x.id === d.productId)!} />}
      </label>
    );
  return (
    <div>
      <h3 className="pa-q">{t('pilotads.ask.product')}</h3>
      {o.products.length > 6 && <input className="pa-search" type="search" placeholder={t('pilotads.launch.search')} value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="pa-prods">
        {list.map((p) => (
          <button key={p.id} type="button" className={`pa-prod ${d.productId === p.id ? 'on' : ''}`} onClick={() => choose(p)}>
            <span className="pa-prod-pic">{p.photo ? <img src={p.photo} alt="" /> : <Icon name="package" />}</span>
            <span className="pa-prod-txt">
              <b>{p.name}</b>
              <span className="ltr">{da(p.price)}</span>
              <LimitLine p={p} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LimitLine({ p }: { p: P }) {
  const { t } = useTranslation();
  if (p.limit.maxDzd <= 0) return <small className="neg">{t('pilotads.limit.none')}</small>;
  return (
    <small className="pa-limit">
      {t('pilotads.limit.line', { max: da(p.limit.maxDzd) })}
      {p.estimated && <em> · {t('pilotads.limit.estimated')}</em>}
    </small>
  );
}

// ---------------------------------------------------------------- step 2: what you want
function StepGoal({ o, d, set, product, goals, compact }: { o: Opt; d: Draft; set: (p: Partial<Draft>) => void; product: P | null; goals: Goal[]; compact?: boolean }) {
  const { t } = useTranslation();
  const choose = (g: Goal) => {
    const name = product ? `${product.name} — ${t(`pilotads.goal.${g}.short`)}` : d.name;
    set({ goal: g, name, ...(g === 'calls' && !d.phone ? { phone: o.phone } : {}), ...(g === 'form' && !d.formId && !d.newForm ? { newForm: o.forms.length ? null : { name: name.slice(0, 100), commune: true, variant: false, privacyUrl: o.privacyUrl, lang: 'fr' } } : {}) });
  };
  return (
    <div className="pa-goalstep">
      {!compact && <h3 className="pa-q">{t('pilotads.ask.goal')}</h3>}
      <div className={`pa-goals ${compact ? 'compact' : ''}`} role="radiogroup" aria-label={t('pilotads.step.goal')}>
        {goals.map((g) => (
          <button key={g} type="button" role="radio" aria-checked={d.goal === g} className={`pa-goal ${d.goal === g ? 'on' : ''}`} onClick={() => choose(g)}>
            <Icon name={GOAL_ICON[g]} />
            <b>{t(`pilotads.goal.${g}.name`)}</b>
            {!compact && <span>{t(`pilotads.goal.${g}.text`)}</span>}
          </button>
        ))}
      </div>
      {!compact && <p className="pa-tip"><Icon name="info" /> {t(`pilotads.goal.${d.goal}.tip`)}</p>}
      <GoalFields o={o} d={d} set={set} product={product} />
    </div>
  );
}

function GoalFields({ o, d, set, product }: { o: Opt; d: Draft; set: (p: Partial<Draft>) => void; product: P | null }) {
  const { t } = useTranslation();
  if (d.goal === 'sales' || d.goal === 'traffic')
    return product && !product.landing ? (
      <div className="warnbox">
        {t('pilotads.check.noLanding')} <a href="#/landing">{t('pilotads.launch.makeLanding')}</a>
      </div>
    ) : product?.landing ? (
      <p className="note ltr pa-url">
        <Icon name="link" /> {product.landing.url}
      </p>
    ) : null;
  if (d.goal === 'messages') {
    const toggle = (c: Channel) => set({ channels: d.channels.includes(c) ? d.channels.filter((x) => x !== c) : [...d.channels, c] });
    const w = d.welcome ?? { text: '', questions: ['', '', ''] };
    return (
      <div className="pa-fields">
        <span className="lab">{t('pilotads.msg.where')}</span>
        <div className="pa-chips">
          {(['messenger', 'instagram', 'whatsapp'] as Channel[]).map((c) => (
            <button key={c} type="button" className={`chip ${d.channels.includes(c) ? 'on' : ''}`} aria-pressed={d.channels.includes(c)} onClick={() => toggle(c)}>
              <Icon name={c === 'whatsapp' ? 'whatsapp' : 'message'} /> {t(`pilotads.ch.${c}`)}
            </button>
          ))}
        </div>
        <p className="note">{t('pilotads.msg.dellal')}</p>
        {d.channels.includes('messenger') && (
          <>
            <label className="field">
              <span className="lab">{t('pilotads.msg.welcome')}</span>
              <input value={w.text} maxLength={300} placeholder={t('pilotads.msg.welcomePh')} onChange={(e) => set({ welcome: { ...w, text: e.target.value } })} />
            </label>
            <div className="pa-qs">
              {[0, 1, 2].map((k) => (
                <input key={k} value={w.questions[k] ?? ''} maxLength={80} placeholder={t('pilotads.msg.question', { n: k + 1 })} onChange={(e) => { const qs = [...w.questions]; qs[k] = e.target.value; set({ welcome: { ...w, questions: qs } }); }} />
              ))}
            </div>
          </>
        )}
      </div>
    );
  }
  if (d.goal === 'calls')
    return (
      <label className="field">
        <span className="lab">{t('pilotads.call.phone')}</span>
        <input className="ltr" type="tel" value={d.phone} placeholder="+213 6…" onChange={(e) => set({ phone: e.target.value })} aria-invalid={!!d.phone && !phoneOk(d.phone)} />
        <small className="note">{t('pilotads.call.note')}</small>
      </label>
    );
  if (d.goal === 'form') {
    const nf = d.newForm ?? { name: d.name.slice(0, 100), commune: true, variant: false, privacyUrl: o.privacyUrl, lang: 'fr' as const };
    return (
      <div className="pa-fields">
        <label className="field">
          <span className="lab">{t('pilotads.form.which')}</span>
          <select value={d.formId ?? ''} onChange={(e) => set(e.target.value ? { formId: e.target.value, newForm: null } : { formId: null, newForm: nf })}>
            <option value="">{t('pilotads.form.new')}</option>
            {o.forms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        {!d.formId && (
          <div className="pa-newform">
            <label className="field">
              <span className="lab">{t('pilotads.form.name')}</span>
              <input value={nf.name} maxLength={100} onChange={(e) => set({ newForm: { ...nf, name: e.target.value } })} />
            </label>
            <p className="note">{t('pilotads.form.asks')}</p>
            <label className="pa-check">
              <input type="checkbox" checked={nf.commune} onChange={(e) => set({ newForm: { ...nf, commune: e.target.checked } })} /> {t('pilotads.form.commune')}
            </label>
            <label className="pa-check">
              <input type="checkbox" checked={nf.variant} onChange={(e) => set({ newForm: { ...nf, variant: e.target.checked } })} /> {t('pilotads.form.variant')}
            </label>
            <label className="field">
              <span className="lab">{t('pilotads.form.privacy')}</span>
              <input className="ltr" type="url" value={nf.privacyUrl} placeholder="https://…" onChange={(e) => set({ newForm: { ...nf, privacyUrl: e.target.value } })} />
              <small className="note">{t('pilotads.form.privacyNote')}</small>
            </label>
            <label className="field">
              <span className="lab">{t('pilotads.form.lang')}</span>
              <select value={nf.lang} onChange={(e) => set({ newForm: { ...nf, lang: e.target.value as 'fr' | 'ar' } })}>
                <option value="fr">Français</option>
                <option value="ar">العربية</option>
              </select>
            </label>
          </div>
        )}
        <p className="note">{t('pilotads.form.toOrders')}</p>
      </div>
    );
  }
  if (d.goal === 'engagement')
    return (
      <label className="field">
        <span className="lab">{t('pilotads.post.which')}</span>
        <select value={d.postId ?? ''} onChange={(e) => set({ postId: e.target.value || null })}>
          <option value="">{t('pilotads.post.pick')}</option>
          {o.posts.map((p) => (
            <option key={p.id} value={p.id}>
              {(p.text || p.id).slice(0, 60)} {p.at ? `· ${t('pilotads.ago', { d: since(p.at) })}` : ''}
            </option>
          ))}
        </select>
        <input className="ltr" value={d.postId ?? ''} placeholder={t('pilotads.post.paste')} onChange={(e) => set({ postId: e.target.value.replace(/[^\d_]/g, '') || null })} />
      </label>
    );
  return <p className="note">{t('pilotads.goal.awareness.more')}</p>;
}

// ---------------------------------------------------------------- step 3: the ad (photos or videos, words)
function StepAd({ o, d, set, product, lib, refetchLib, pro, cancelBoost }: { o: Opt; d: Draft; set: (p: Partial<Draft>) => void; product: P | null; lib: Media[]; refetchLib: () => void; pro?: boolean; cancelBoost: () => void }) {
  const { t } = useTranslation();
  const [variants, setVariants] = useState<{ primary: string; headline: string }[]>([]);
  const [by, setBy] = useState<'ai' | 'ready' | null>(null);
  const [idea, setIdea] = useState('');
  const write = useAction('ads.launch.copy', {
    silent: true,
    onDone: (r) => {
      setVariants(r.variants);
      setBy(r.by);
      if (!d.text.primary.trim() && r.variants[0]) set({ text: r.variants[0] });
      if (d.goal === 'messages' && !d.welcome?.text) set({ welcome: r.welcome });
    },
  });
  const ask = (lang = d.lang) => product && write.mutate({ productId: product.id, goal: d.goal, lang, idea });
  // the first time this step opens with a product: three versions at once
  const asked = useRef<string>('');
  useEffect(() => {
    const k = `${product?.id}:${d.goal}:${d.lang}`;
    if (product && d.goal !== 'engagement' && !d.partnerContentId && asked.current !== k) {
      asked.current = k;
      ask();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, d.goal, d.lang]);
  if (d.goal === 'engagement') return <p className="note">{t('pilotads.post.noAd')}</p>;
  if (d.partnerContentId)
    return (
      <div className="pa-ad">
        {!pro && <h3 className="pa-q">{t('pilotads.ask.ad')}</h3>}
        <BoostCard o={o} d={d} onCancel={cancelBoost} />
      </div>
    );
  return (
    <div className="pa-ad">
      {!pro && <h3 className="pa-q">{t('pilotads.ask.ad')}</h3>}
      <PartnerPick o={o} d={d} set={set} />
      <MediaPicker d={d} set={set} lib={lib} refetchLib={refetchLib} product={product} />
      <div className="pa-words">
        <div className="pa-words-head">
          <span className="lab">{t('pilotads.ad.words')}</span>
          <div className="pa-mode small" role="radiogroup" aria-label={t('pilotads.ad.lang')}>
            {(['darija', 'fr', 'ar'] as Lang[]).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={d.lang === l} className={d.lang === l ? 'on' : ''} onClick={() => { set({ lang: l, text: { primary: '', headline: '' } }); store.set('ads-lang', l); }}>
                {t(`pilotads.lang.${l}`)}
              </button>
            ))}
          </div>
        </div>
        {pro && (
          <div className="pa-idea">
            <input value={idea} maxLength={400} placeholder={t('pilotads.ad.ideaPh')} onChange={(e) => setIdea(e.target.value)} />
            <button type="button" className="btn small" disabled={!product || write.isPending} onClick={() => ask()}>
              <Icon name="sparkles" /> {t('pilotads.ad.rewrite')}
            </button>
          </div>
        )}
        {write.isPending ? (
          <p className="muted pa-writing">
            <Icon name="sparkles" /> {t('pilotads.ad.writing')}
          </p>
        ) : (
          !!variants.length && (
            <div className="pa-variants">
              {variants.map((v, k) => (
                <button key={k} type="button" className={`pa-variant ${d.text.primary === v.primary ? 'on' : ''}`} onClick={() => set({ text: v })} dir={d.lang === 'fr' ? 'ltr' : 'rtl'}>
                  <small>{t('pilotads.ad.version', { n: k + 1 })}</small>
                  <span>{v.primary}</span>
                </button>
              ))}
            </div>
          )
        )}
        {by === 'ready' && !!variants.length && <p className="note">{t('pilotads.ad.ready')}</p>}
        <label className="field">
          <span className="lab">{t('pilotads.ad.primary')}</span>
          <textarea rows={5} maxLength={2000} value={d.text.primary} dir={d.lang === 'fr' ? 'ltr' : 'rtl'} onChange={(e) => set({ text: { ...d.text, primary: e.target.value } })} />
        </label>
        <label className="field">
          <span className="lab">{t('pilotads.ad.headline')}</span>
          <input value={d.text.headline} maxLength={80} dir={d.lang === 'fr' ? 'ltr' : 'rtl'} onChange={(e) => set({ text: { ...d.text, headline: e.target.value } })} />
        </label>
        {!pro && (
          <button type="button" className="btn small" disabled={!product || write.isPending} onClick={() => ask()}>
            <Icon name="sparkles" /> {t('pilotads.ad.more')}
          </button>
        )}
      </div>
    </div>
  );
}

/** « Avec un influenceur »: the ad in the shop's name and a creator's (Marketing › Influenceurs) */
function PartnerPick({ o, d, set }: { o: Opt; d: Draft; set: (p: Partial<Draft>) => void }) {
  const { t } = useTranslation();
  if (!o.partners.length) return null;
  const p = o.partners.find((x) => x.id === d.partnerId) ?? null;
  const shop = o.page?.name ?? t('pilotads.preview.page');
  return (
    <div className="pa-partner">
      <div className="pa-partner-head">
        <Icon name="handshake" /> {t('pilotads.partner.title')}
        <a href="#/marketing/influenceurs">{t('pilotads.partner.manage')}</a>
      </div>
      <select value={d.partnerId ?? ''} aria-label={t('pilotads.partner.title')} onChange={(e) => set({ partnerId: e.target.value ? Number(e.target.value) : null })}>
        <option value="">{t('pilotads.partner.none')}</option>
        {o.partners.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
            {x.igUsername && `@${x.igUsername}` !== x.name ? ` · @${x.igUsername}` : ''}
            {x.status === 'pending' ? ` (${t('partners.st.pending')})` : ''}
          </option>
        ))}
      </select>
      <p className={p?.status === 'pending' ? 'pa-partner-warn' : 'muted'}>
        {p ? (p.status === 'pending' ? t('pilotads.partner.pending', { name: p.name }) : p.status === 'page' ? t('pilotads.partner.page', { name: p.name }) : t('pilotads.partner.both', { shop, name: p.name })) : t('pilotads.partner.help')}
      </p>
    </div>
  );
}

/** a creator's post boosted: it keeps its picture and words (Marketing › Influenceurs › Booster) */
function BoostCard({ o, d, onCancel }: { o: Opt; d: Draft; onCancel: () => void }) {
  const { t } = useTranslation();
  const b = o.boost && o.boost.id === d.partnerContentId ? o.boost : null;
  if (!b) return <Loading />;
  const name = o.partners.find((x) => x.id === (d.partnerId ?? b.partnerId))?.name ?? b.author.name;
  return (
    <div className="pa-boost">
      {b.thumb ? <img src={b.thumb} alt="" /> : <span className="pa-boost-pic" aria-hidden="true" />}
      <div>
        <b>{t('pilotads.partner.boostTitle', { name })}</b>
        <p dir="auto">{b.caption.length > 220 ? `${b.caption.slice(0, 219)}…` : b.caption}</p>
        <p className="muted">{b.platform === 'FACEBOOK' ? t('pilotads.partner.boostFb') : t('pilotads.partner.boostHelp')}</p>
        {!b.boostable ? <p className="pa-err">{b.errors[0]?.message ?? t('partners.posts.elig.INELIGIBLE')}</p> : b.errors[0] && <p className="pa-partner-warn">{b.errors[0].message}</p>}
        <button type="button" className="btn small" onClick={onCancel}>
          {t('pilotads.partner.cancelBoost')}
        </button>
      </div>
    </div>
  );
}

function MediaPicker({ d, set, lib, refetchLib, product }: { d: Draft; set: (p: Partial<Draft>) => void; lib: Media[]; refetchLib: () => void; product: P | null }) {
  const { t } = useTranslation();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [pct, setPct] = useState(0);
  const toggle = (id: number) => set({ mediaIds: d.mediaIds.includes(id) ? d.mediaIds.filter((x) => x !== id) : d.mediaIds.length >= 10 ? d.mediaIds : [...d.mediaIds, id] });
  const addFiles = async (files: FileList | null) => {
    const all = Array.from(files ?? []);
    if (file.current) file.current.value = '';
    let ids = [...d.mediaIds];
    for (const f of all.slice(0, Math.max(0, 10 - ids.length))) {
      const isVid = f.type.startsWith('video/') || /\.(mp4|m4v|mov)$/i.test(f.name);
      try {
        if (isVid) {
          setBusy('video');
          setPct(0);
          let meta;
          try {
            meta = await readVideo(f);
          } catch (e) {
            toast(t(e instanceof VideoError && e.code === 'type' ? 'pilotads.media.videoType' : 'pilotads.media.videoBad'), 'bad');
            continue;
          }
          const r = await rpc('ads.media.videoStart', { mime: meta.mime as 'video/mp4' | 'video/quicktime', size: f.size, w: meta.w, h: meta.h, duration: Math.max(1, meta.duration), thumb: meta.thumb });
          if (r.upload) {
            if (!backend.upload) throw new Error(t('pilotads.media.videoLost'));
            const body = await videoBody(f, meta.mime);
            await sendPieces(body, r.chunk, (part, piece) => backend.upload!(`/cm/video/${r.id}/${r.key}?part=${part}`, piece), setPct);
            await rpc('ads.media.videoDone', { id: r.id });
          }
          ids = [...ids, r.id];
          set({ mediaIds: ids });
        } else {
          setBusy('photo');
          const ph = await toPlanPhoto(f);
          const r = await rpc('ads.media.photo', { jpeg: ph.jpeg, thumb: ph.thumb, w: ph.w, h: ph.h });
          ids = [...ids, r.id];
          set({ mediaIds: ids });
        }
      } catch (e: any) {
        toast(e?.message ?? t('common.error'), 'bad');
      }
    }
    setBusy('');
    setPct(0);
    refetchLib();
  };
  // the product's own photo, made an ad photo in one tap
  const useProductPhoto = async () => {
    if (!product?.photo) return;
    try {
      setBusy('photo');
      const blob = await (await fetch(product.photo)).blob();
      const ph = await toPlanPhoto(blob);
      const r = await rpc('ads.media.photo', { jpeg: ph.jpeg, thumb: ph.thumb, w: ph.w, h: ph.h });
      set({ mediaIds: [...d.mediaIds, r.id] });
      refetchLib();
    } catch {
      toast(t('pilotads.media.photoBad'), 'bad');
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="pa-media">
      <div className="pa-media-head">
        <span className="lab">{t('pilotads.media.title', { n: d.mediaIds.length })}</span>
        <span className="note">{t('pilotads.media.tip')}</span>
      </div>
      <div className="pa-grid">
        <button type="button" className="pa-add" onClick={() => file.current?.click()} disabled={!!busy}>
          <Icon name="upload" />
          <span>{busy === 'video' ? `${Math.round(pct * 100)} %` : busy ? t('pilotads.media.sending') : t('pilotads.media.add')}</span>
        </button>
        {product?.photo && !lib.length && (
          <button type="button" className="pa-add" onClick={useProductPhoto} disabled={!!busy}>
            <img src={product.photo} alt="" />
            <span>{t('pilotads.media.useProduct')}</span>
          </button>
        )}
        {lib.map((m) => {
          const k = d.mediaIds.indexOf(m.id);
          return (
            <button key={m.id} type="button" className={`pa-tile ${k >= 0 ? 'on' : ''}`} aria-pressed={k >= 0} onClick={() => toggle(m.id)} disabled={!m.ready}>
              {m.url ? <img src={m.url} alt="" loading="lazy" /> : <span className="pa-tile-ph"><Icon name={m.kind === 'video' ? 'film' : 'image'} /></span>}
              {m.kind === 'video' && <span className="pa-vid ltr"><Icon name="play" /> {m.duration ? `${Math.round(m.duration)} s` : ''}</span>}
              {k >= 0 && <b className="pa-pick ltr">{k + 1}</b>}
            </button>
          );
        })}
      </div>
      <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
    </div>
  );
}

// ---------------------------------------------------------------- step 4: the budget
function StepBudget({ o, d, set, product, pro }: { o: Opt; d: Draft; set: (p: Partial<Draft>) => void; product: P | null; pro?: boolean }) {
  const { t } = useTranslation();
  const packs = product?.packs ?? [
    { key: 'test' as const, usd: 5, delivered: null },
    { key: 'best' as const, usd: 10, delivered: null },
    { key: 'fast' as const, usd: 20, delivered: null },
  ];
  return (
    <div className="pa-money">
      {!pro && <h3 className="pa-q">{t('pilotads.ask.budget')}</h3>}
      {product && product.limit.maxDzd > 0 && (
        <div className="pa-limitbox">
          <div>
            <span className="lab">{t('pilotads.limit.maxLabel')}</span>
            <b className="ltr">{da(product.limit.maxDzd)}</b>
          </div>
          <div>
            <span className="lab">{t('pilotads.limit.targetLabel')}</span>
            <b className="ltr">{da(product.limit.targetDzd)}</b>
          </div>
          <p>{t('pilotads.limit.explain', { delivered: n(product.delivered), share: Math.round(product.share * 100) })}</p>
        </div>
      )}
      <div className="pa-packs" role="radiogroup" aria-label={t('pilotads.budget.perDay')}>
        {packs.map((p) => (
          <button key={p.key} type="button" role="radio" aria-checked={d.budgetUsd === p.usd} className={`pa-pack ${d.budgetUsd === p.usd ? 'on' : ''}`} onClick={() => set({ budgetUsd: p.usd })}>
            <small>{t(`pilotads.pack.${p.key}`)}</small>
            <b className="ltr">{t('pilotads.perDay', { v: usd(p.usd, 0) })}</b>
            {o.rate && <span className="ltr muted">≈ {da(Math.round(p.usd * o.rate))}</span>}
            <span>{p.delivered !== null ? t('pilotads.pack.delivered', { n: dec1(p.delivered * 7) }) : t('pilotads.pack.noData')}</span>
          </button>
        ))}
      </div>
      <label className="field pa-own">
        <span className="lab">{t('pilotads.budget.own')}</span>
        <span className="pa-usd">
          <input type="number" min={1} step={1} inputMode="decimal" value={d.budgetUsd} onChange={(e) => set({ budgetUsd: Math.max(1, Number(e.target.value) || 1) })} />
          <b>$</b>
        </span>
      </label>
      {!o.owner && (o.guard.launchYes || (o.guard.yesAboveUsd !== null && d.budgetUsd > o.guard.yesAboveUsd)) && <div className="warnbox">{t('pilotads.launch.ownerYes')}</div>}
      <p className="note">{t('pilotads.launch.safety')}</p>
    </div>
  );
}

function ProMoney({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const { t } = useTranslation();
  return (
    <div className="pa-promoney">
      <label className="field">
        <span className="lab">{t('pilotads.pro.level')}</span>
        <select value={d.budgetLevel} onChange={(e) => set({ budgetLevel: e.target.value as Draft['budgetLevel'] })}>
          <option value="campaign">{t('pilotads.pro.levelCampaign')}</option>
          <option value="adset">{t('pilotads.pro.levelAdset')}</option>
        </select>
      </label>
      <label className="field">
        <span className="lab">{t('pilotads.pro.split')}</span>
        <select value={d.split} onChange={(e) => set({ split: e.target.value as Draft['split'] })}>
          <option value="one">{t('pilotads.pro.splitOne')}</option>
          <option value="perMedia">{t('pilotads.pro.splitTest')}</option>
        </select>
      </label>
      <label className="field">
        <span className="lab">{t('pilotads.pro.bid')}</span>
        <select value={d.bid?.strategy ?? 'LOWEST_COST_WITHOUT_CAP'} onChange={(e) => set({ bid: e.target.value === 'LOWEST_COST_WITHOUT_CAP' ? null : { strategy: e.target.value as NonNullable<Draft['bid']>['strategy'], usd: d.bid?.usd ?? null } })}>
          <option value="LOWEST_COST_WITHOUT_CAP">{t('pilotads.pro.bidLowest')}</option>
          <option value="COST_CAP">{t('pilotads.pro.bidCost')}</option>
          <option value="LOWEST_COST_WITH_BID_CAP">{t('pilotads.pro.bidCap')}</option>
        </select>
      </label>
      {d.bid && (
        <label className="field">
          <span className="lab">{t('pilotads.pro.bidAmount')}</span>
          <span className="pa-usd">
            <input type="number" min={0.1} step={0.1} value={d.bid.usd ?? ''} onChange={(e) => set({ bid: { ...d.bid!, usd: Number(e.target.value) || null } })} />
            <b>$</b>
          </span>
        </label>
      )}
      <label className="field">
        <span className="lab">{t('pilotads.pro.start')}</span>
        <input type="datetime-local" value={d.start ? d.start.slice(0, 16) : ''} onChange={(e) => set({ start: e.target.value ? new Date(e.target.value).toISOString() : null })} />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------- Pro: who sees the ad
function Targeting({ o, d, set }: { o: Opt; d: Draft; set: (p: Partial<Draft>) => void }) {
  const { t } = useTranslation();
  const weak = o.wilayas.filter((w) => w.weak);
  const [add, setAdd] = useState('');
  const aud = o.audiences.filter((a) => a.on);
  return (
    <div className="pa-target">
      <div className="pa-fields">
        <span className="lab">{t('pilotads.who.wilayas')}</span>
        {!!weak.length && !weak.every((w) => d.excludeWilayas.includes(w.id)) && (
          <div className="pa-weak">
            <Icon name="truck" />
            <span>{t('pilotads.who.weak', { list: weak.slice(0, 6).map((w) => `${wilayaName(w.id)} ${w.rate} %`).join(', ') })}</span>
            <button type="button" className="btn small" onClick={() => set({ excludeWilayas: [...new Set([...d.excludeWilayas, ...weak.map((w) => w.id)])] })}>
              {t('pilotads.who.leaveOut')}
            </button>
          </div>
        )}
        <div className="pa-chips">
          {!d.excludeWilayas.length && <span className="muted">{t('pilotads.who.allDz')}</span>}
          {d.excludeWilayas.map((id) => (
            <button key={id} type="button" className="chip on" onClick={() => set({ excludeWilayas: d.excludeWilayas.filter((x) => x !== id) })} aria-label={t('pilotads.who.putBack', { w: wilayaName(id) })}>
              {wilayaName(id)} <Icon name="x" />
            </button>
          ))}
          <select value={add} onChange={(e) => { const id = Number(e.target.value); if (id) set({ excludeWilayas: [...new Set([...d.excludeWilayas, id])] }); setAdd(''); }} aria-label={t('pilotads.who.add')}>
            <option value="">{t('pilotads.who.add')}</option>
            {o.wilayas.filter((w) => !d.excludeWilayas.includes(w.id) && w.id <= 48).map((w) => (
              <option key={w.id} value={w.id}>
                {wilayaName(w.id)} {w.rate !== null ? `· ${w.rate} %` : ''}
              </option>
            ))}
          </select>
        </div>
        {d.excludeWilayas.some((x) => x > 48) && <p className="note">{t('pilotads.who.newWilayas')}</p>}
      </div>
      <div className="pa-row3">
        <label className="field">
          <span className="lab">{t('pilotads.who.age')}</span>
          <span className="pa-age">
            <input type="number" min={18} max={65} value={d.ageMin} onChange={(e) => set({ ageMin: Math.min(65, Math.max(18, Number(e.target.value) || 18)) })} />
            <span>–</span>
            <input type="number" min={18} max={65} value={d.ageMax} onChange={(e) => set({ ageMax: Math.min(65, Math.max(18, Number(e.target.value) || 65)) })} />
          </span>
        </label>
        <label className="field">
          <span className="lab">{t('pilotads.who.gender')}</span>
          <select value={d.genders.length === 1 ? String(d.genders[0]) : ''} onChange={(e) => set({ genders: e.target.value ? [Number(e.target.value) as 1 | 2] : [] })}>
            <option value="">{t('pilotads.who.everyone')}</option>
            <option value="2">{t('pilotads.who.women')}</option>
            <option value="1">{t('pilotads.who.men')}</option>
          </select>
        </label>
        <label className="pa-check pa-adv">
          <input type="checkbox" checked={d.advantageAudience} onChange={(e) => set({ advantageAudience: e.target.checked })} />
          <span>
            <b>{t('pilotads.who.advantage')}</b>
            <small>{t('pilotads.who.advantageTip')}</small>
          </span>
        </label>
      </div>
      <label className="pa-check">
        <input type="checkbox" checked={d.useAudiences} onChange={(e) => set({ useAudiences: e.target.checked })} />
        <span>
          <b>{t('pilotads.who.audiences')}</b>
          <small>{aud.length ? aud.map((a) => `${t(`pilotads.aud.${a.kind}.name`)} (${n(a.size)})`).join(' · ') : t('pilotads.who.noAudiences')}</small>
        </span>
      </label>
      {d.goal === 'sales' && o.pixels.length > 1 && (
        <label className="field">
          <span className="lab">{t('pilotads.who.pixel')}</span>
          <select value={d.pixelId ?? ''} onChange={(e) => set({ pixelId: e.target.value || null })}>
            <option value="">{t('pilotads.who.pixelAuto')}</option>
            {o.pixels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** Pro: what a test costs and what it may bring, for each budget (3 days at least, Meta's learning). */
function TestPlan({ d, product }: { d: Draft; product: P | null }) {
  const { t } = useTranslation();
  const packs = product?.packs ?? [];
  if (!packs.length) return null;
  const items = d.split === 'perMedia' ? Math.max(1, d.mediaIds.length) : 1;
  return (
    <section className="card pa-test">
      <h3 className="pa-h">{t('pilotads.test.title')}</h3>
      <table>
        <thead>
          <tr>
            <th>{t('pilotads.test.budget')}</th>
            <th className="num">{t('pilotads.test.days3')}</th>
            <th className="num">{t('pilotads.test.delivered')}</th>
          </tr>
        </thead>
        <tbody>
          {packs.map((p) => (
            <tr key={p.key} className={d.budgetUsd === p.usd ? 'on' : ''}>
              <td className="ltr">{t('pilotads.perDay', { v: usd(p.usd * items, 0) })}</td>
              <td className="num ltr">{usd(p.usd * items * 3, 0)}</td>
              <td className="num">{p.delivered !== null ? `≈ ${dec1(p.delivered * items * 3)}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">{d.split === 'perMedia' ? t('pilotads.test.perMedia', { n: items }) : t('pilotads.test.note')}</p>
    </section>
  );
}

// ---------------------------------------------------------------- the preview, the checks, « Lancer »
function Preview({ o, d, lib }: { o: Opt; d: Draft; lib: Media[] }) {
  const { t } = useTranslation();
  const boost = d.partnerContentId && o.boost?.id === d.partnerContentId ? o.boost : null;
  const pic = lib.find((m) => m.id === d.mediaIds[0]);
  const first = boost ? { url: boost.thumb, kind: boost.mediaType === 'VIDEO' ? 'video' : 'photo' } : pic;
  const shop = o.page?.name ?? t('pilotads.preview.page');
  const partner = d.goal === 'engagement' ? null : (o.partners.find((x) => x.id === d.partnerId)?.name ?? (boost ? boost.author.name : null));
  // a partnership ad: two names in its head (a boosted post: the creator first)
  const name = boost && partner ? partner : shop;
  const second = partner ? (boost ? shop : partner) : null;
  const text = boost ? boost.caption : d.text.primary;
  const url = o.products.find((p) => p.id === d.productId)?.landing?.url ?? '';
  const host = (() => {
    try {
      return url ? new URL(url).host : '';
    } catch {
      return '';
    }
  })();
  return (
    <section className="card pa-preview" aria-label={t('pilotads.preview.title')}>
      <h3 className="pa-h">{t('pilotads.preview.title')}</h3>
      <div className="pa-fb">
        <div className="pa-fb-head">
          <span className="pa-fb-two">
            <span className="pa-fb-av">{name.slice(0, 1)}</span>
            {second && <span className="pa-fb-av">{second.slice(0, 1)}</span>}
          </span>
          <span>
            <b>{second ? t('pilotads.partner.and', { a: name, b: second }) : name}</b>
            <small>{second ? t('pilotads.partner.paid') : t('pilotads.preview.sponsored')}</small>
          </span>
        </div>
        <p className="pa-fb-text" dir={boost ? 'auto' : d.text.primary ? (d.lang === 'fr' ? 'ltr' : 'rtl') : undefined}>{text || t('pilotads.preview.textPh')}</p>
        <div className="pa-fb-media">
          {first?.url ? <img src={first.url} alt="" /> : <Icon name="image" />}
          {first?.kind === 'video' && <span className="pa-fb-play"><Icon name="play" /></span>}
          {!boost && d.mediaIds.length > 1 && <span className="pa-fb-more ltr">+{d.mediaIds.length - 1}</span>}
        </div>
        <div className="pa-fb-foot">
          <span dir={d.text.headline ? (d.lang === 'fr' ? 'ltr' : 'rtl') : undefined}>
            <small>{d.goal === 'messages' ? t(`pilotads.ch.${d.channels[0] ?? 'messenger'}`) : d.goal === 'calls' ? d.phone : host || shop}</small>
            <b>{boost ? (o.products.find((p) => p.id === d.productId)?.name ?? '') || t('pilotads.preview.headlinePh') : d.text.headline || t('pilotads.preview.headlinePh')}</b>
          </span>
          <span className="pa-fb-cta">{t(`pilotads.cta.${CTA[d.goal]}`)}</span>
        </div>
      </div>
    </section>
  );
}

function Checks({ problems }: { problems: { ok: boolean; text: string }[] }) {
  const { t } = useTranslation();
  return (
    <section className="card pa-checks">
      <h3 className="pa-h">{t('pilotads.check.title')}</h3>
      <ul>
        {problems.map((p, k) => (
          <li key={k} className={p.ok ? 'ok' : 'no'}>
            <Icon name={p.ok ? 'checkcircle' : 'xcircle'} /> {p.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function GoButton({ o, d, problems, mode, onDone, onSaved }: { o: Opt; d: Draft; problems: { ok: boolean }[]; mode: 'simple' | 'pro'; onDone: (r: Out<'ads.launch.go'>) => void; onSaved: (id: number) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const ready = problems.every((p) => p.ok);
  const toOwner = !o.owner && (o.guard.launchYes || (o.guard.yesAboveUsd !== null && d.budgetUsd > o.guard.yesAboveUsd));
  const save = async () => {
    const r = await rpc('ads.launch.save', { id: d.id, clientId: d.id ? null : d.clientId, mode, spec: specOf(d) });
    onSaved(r.id);
    return r.id;
  };
  const go = async () => {
    setBusy(true);
    try {
      const id = await save();
      const r = await rpc('ads.launch.go', { id });
      onDone(r);
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad', 8000);
    } finally {
      setBusy(false);
    }
  };
  const keep = async () => {
    try {
      await save();
      toast(t('pilotads.launch.saved'), 'ok');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    }
  };
  return (
    <div className="pa-go">
      <button type="button" className="btn primary big" disabled={!ready || busy} onClick={go}>
        <Icon name="megaphone" /> {busy ? t('pilotads.launch.sending') : toOwner ? t('pilotads.launch.toOwner') : t('pilotads.launch.go', { v: usd(d.budgetUsd, 0) })}
      </button>
      <button type="button" className="btn ghost" disabled={busy || !d.productId} onClick={keep}>
        {t('pilotads.launch.keep')}
      </button>
    </div>
  );
}

function Done({ r, base, onAgain }: { r: Out<'ads.launch.go'>; base: string; onAgain: () => void }) {
  const { t } = useTranslation();
  const live = r.status === 'live';
  return (
    <div className="card pa-done">
      <span className={`pa-done-ico ${live ? 'ok' : 'mid'}`}>
        <Icon name={live ? 'checkcircle' : 'clock'} />
      </span>
      <h2>{live ? t('pilotads.done.live') : t('pilotads.done.waiting')}</h2>
      <p className="muted">{live ? t('pilotads.done.liveText', { name: r.name }) : t('pilotads.done.waitingText')}</p>
      <div className="pa-done-btns">
        <a className="btn primary" href={base}>
          {t('pilotads.done.see')}
        </a>
        <button type="button" className="btn" onClick={onAgain}>
          {t('pilotads.done.again')}
        </button>
      </div>
      {live && <p className="note">{t('pilotads.done.next')}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- the launches (drafts, waiting, live)
type L = Out<'ads.launch.list'>['launches'][number];
function Launches({ onOpen }: { onOpen: (l: L) => void }) {
  const { t } = useTranslation();
  const q = useRpc('ads.launch.list', {});
  const yes = useAction('ads.launch.approve', { success: (r) => (r.status === 'live' ? t('pilotads.done.live') : t('pilotads.wait.refused')) });
  const remove = useAction('ads.launch.remove', { success: t('pilotads.launch.removed') });
  const rows = q.data?.launches ?? [];
  const tone = useMemo(() => ({ live: 'ok', draft: 'off', waiting_yes: 'mid', launching: 'mid', failed: 'bad', refused: 'bad' }) as Record<string, string>, []);
  if (!rows.length) return null;
  return (
    <section className="card pa-launches">
      <div className="card-head">
        <h2>
          {t('pilotads.launches.title')}
          <span className="count">{rows.length}</span>
        </h2>
      </div>
      <ul>
        {rows.map((l) => (
          <li key={l.id}>
            <Icon name={GOAL_ICON[l.goal as Goal] ?? 'megaphone'} />
            <div className="pa-l-what">
              <b>{l.name}</b>
              <span className="muted">
                {t(`pilotads.goal.${l.goal}.name`)} · {t('pilotads.perDay', { v: usd(l.budgetUsd, 0) })}
                {l.partnerName ? ` · ${t('pilotads.partner.with', { name: l.partnerName })}` : ''} · {l.by ?? '—'} · {t('pilotads.ago', { d: since(l.createdAt) })}
              </span>
              {l.error && <span className="pa-err">{l.error}</span>}
            </div>
            <span className={`badge t-${tone[l.status] ?? 'off'}`}>{t(`pilotads.lst.${l.status}`)}</span>
            <span className="pa-l-btns">
              {(l.status === 'draft' || l.status === 'failed') && (
                <button type="button" className="btn small" onClick={() => onOpen(l)}>
                  {t('pilotads.launches.open')}
                </button>
              )}
              {q.data?.owner && l.status === 'waiting_yes' && (
                <>
                  <button type="button" className="btn small" disabled={yes.isPending} onClick={() => yes.mutate({ id: l.id, yes: false })}>
                    {t('pilotads.wait.no')}
                  </button>
                  <button type="button" className="btn small primary" disabled={yes.isPending} onClick={() => yes.mutate({ id: l.id, yes: true })}>
                    {t('pilotads.wait.yes')}
                  </button>
                </>
              )}
              {['draft', 'failed', 'refused'].includes(l.status) && (
                <button type="button" className="pa-ib" aria-label={t('common.delete')} title={t('common.delete')} disabled={remove.isPending} onClick={() => remove.mutate({ id: l.id })}>
                  <Icon name="trash" />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
