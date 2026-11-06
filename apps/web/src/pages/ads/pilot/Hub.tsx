// Pilot Ads, inside Marketing › Publicité: its own tabs — « Mes pubs » (Simple: one card per product with three numbers,
// a verdict and one button; Pro: every table of Publicité, the buttons on each ad set, where the orders come from and
// the log of every change), « Lancer une pub », « Pilote auto », « Audiences », and for the owner « Demander » (Pilot AI
// answers about the ads with Meta's tools, Ask.tsx). On top of all of them: the owner's « Tout arrêter », the changes
// waiting for the owner's yes, an ad account that needs a payment.
// Every number and every rule is in core (ads.*, ads.ctl.*, ads.pilot.*, ads.ask.*): this file only shows them and asks.
import { CSSProperties, ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../../lib/backend';
import { da, n, since, wilayaName } from '../../../lib/format';
import { useAction, useRpc } from '../../../lib/query';
import { useSession } from '../../../lib/session';
import { store } from '../../../lib/store';
import { Empty, ErrorBox, Icon, Loading } from '../../../ui/kit';
import { Modal } from '../../../ui/modal';
import { AskPilot } from './Ask';
import { Audiences } from './Audiences';
import { Launch } from './Launch';
import { Pilote } from './Pilote';
import './pilot.css';

export type PubTab = 'pubs' | 'lancer' | 'pilote' | 'audiences' | 'demander';
const TABS: PubTab[] = ['pubs', 'lancer', 'pilote', 'audiences', 'demander'];
const TAB_ICON: Record<PubTab, string> = { pubs: 'chart', lancer: 'megaphone', pilote: 'sparkles', audiences: 'users', demander: 'chat' };
export type Ctl = Out<'ads.ctl.state'>;
export type Act = Ctl['recent'][number];
type Obj = Ctl['objects'][number];
type Ov = Out<'ads.overview'>;

const algDay = (k = 0) => new Date(Date.now() + 3_600_000 + k * 86_400_000).toISOString().slice(0, 10);
export const usd = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !isFinite(v) ? '—' : `${v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })} $`);
export const clientId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The Publicité page with Pilot Ads' tabs. `pro` is the full Publicité (the computer's, or the phone's). */
export function PubHub({ rest, pro, base = '#/marketing/publicite' }: { rest?: string[]; pro: ReactNode; base?: string }) {
  const { t } = useTranslation();
  const { has } = useSession();
  // « Demander » is the owner's: Meta's tools read the whole ad account, more than a marketer sees here
  const owner = has('vendeur');
  const tabs = owner ? TABS : TABS.filter((k) => k !== 'demander');
  const tab: PubTab = (tabs as string[]).includes(rest?.[0] ?? '') ? (rest![0] as PubTab) : 'pubs';
  const asks = useRpc('ads.ask.state', {}, { enabled: owner, refetchInterval: 120_000, retry: false });
  const [mode, setMode] = useState<'simple' | 'pro'>(() => (store.get('ads-mode') === 'pro' ? 'pro' : 'simple'));
  const ctl = useRpc('ads.ctl.state', {}, { refetchInterval: 60_000 });
  const pil = useRpc('ads.pilot.state', {}, { refetchInterval: 120_000 });
  const choose = (m: 'simple' | 'pro') => {
    setMode(m);
    store.set('ads-mode', m);
  };
  const counts: Partial<Record<PubTab, number>> = { pilote: pil.data?.suggestions.length || undefined, demander: asks.data?.waiting || undefined };
  return (
    <div className="pa">
      <div className="pa-top">
        <nav className={`pa-tabs ${tabs.length > 4 ? 'many' : ''}`} role="tablist" aria-label={t('pilotads.tabsLabel')} style={{ '--pa-n': tabs.length } as CSSProperties}>
          {tabs.map((k) => (
            <a key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} href={k === 'pubs' ? base : `${base}/${k}`}>
              <Icon name={TAB_ICON[k]} />
              {/* on a phone the four tabs sit side by side, so each shows a short name */}
              <span className="pa-tab-long">{t(`pilotads.tab.${k}`)}</span>
              <span className="pa-tab-short">{t(`pilotads.tabShort.${k}`)}</span>
              {!!counts[k] && <b className="pa-count ltr">{counts[k]}</b>}
            </a>
          ))}
        </nav>
        {tab === 'pubs' && <ModeSwitch mode={mode} onChange={choose} />}
      </div>
      {ctl.data && <TopAlerts s={ctl.data} />}
      {tab === 'pubs' ? (
        mode === 'simple' ? (
          <SimplePubs ctl={ctl.data ?? null} base={base} />
        ) : (
          <>
            {pro}
            <div className="pa-pro-more">
              <WhereCard />
              <ActionLog />
            </div>
          </>
        )
      ) : tab === 'lancer' ? (
        <Launch base={base} rest={rest} />
      ) : tab === 'pilote' ? (
        <Pilote />
      ) : tab === 'demander' ? (
        <AskPilot />
      ) : (
        <Audiences />
      )}
    </div>
  );
}

function ModeSwitch({ mode, onChange }: { mode: 'simple' | 'pro'; onChange: (m: 'simple' | 'pro') => void }) {
  const { t } = useTranslation();
  return (
    <div className="pa-mode" role="radiogroup" aria-label={t('pilotads.mode.label')}>
      {(['simple', 'pro'] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => onChange(m)} title={t(`pilotads.mode.${m}Tip`)}>
          {t(`pilotads.mode.${m}`)}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- on top of every tab
function TopAlerts({ s }: { s: Ctl }) {
  const { t } = useTranslation();
  const stop = useAction('ads.ctl.stopAll', { success: (r) => (r.paused ? t('pilotads.stop.paused', { n: r.paused }) : t('pilotads.stop.resumed', { n: r.resumed })) });
  const [ask, setAsk] = useState(false);
  const badAccounts = s.accounts.filter((a) => a.status !== 1 && a.status !== 0);
  return (
    <>
      {s.guard.stopped ? (
        <div className="pa-stopped" role="alert">
          <Icon name="power" />
          <div>
            <b>{t('pilotads.stop.isOn')}</b>
            <span>{t('pilotads.stop.isOnSub')}</span>
          </div>
          {s.owner && (
            <button type="button" className="btn primary" disabled={stop.isPending} onClick={() => stop.mutate({ on: false })}>
              {t('pilotads.stop.resume')}
            </button>
          )}
        </div>
      ) : (
        s.owner && (
          <div className="pa-guardbar">
            <span className="pa-guard-sum">
              <Icon name="shield" />
              {/* one line on a computer; on a phone the limit and today's spend go on two lines */}
              <span className="pa-guard-txt">
                <span>{t('pilotads.guard.limit', { max: s.guard.maxDailyUsd ?? '∞' })}</span>
                <span className="pa-guard-dot" aria-hidden="true">
                  {' · '}
                </span>
                <span>{t('pilotads.guard.now', { now: s.shopDailyUsd.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) })}</span>
              </span>
            </span>
            <button type="button" className="btn pa-danger-ghost" onClick={() => setAsk(true)}>
              <Icon name="power" /> {t('pilotads.stop.button')}
            </button>
          </div>
        )
      )}
      {badAccounts.map((a) => (
        <div key={a.id} className="warnbox pa-account">
          <Icon name="alert" /> {t(`pilotads.account.st${[2, 3, 7, 9, 101].includes(a.status) ? a.status : 'x'}`, { name: a.name || a.id })}
        </div>
      ))}
      {!!s.waiting.length && <Waiting list={s.waiting} owner={s.owner} />}
      {ask && (
        <Modal
          title={t('pilotads.stop.askTitle')}
          onClose={() => setAsk(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAsk(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={stop.isPending}
                onClick={() => {
                  stop.mutate({ on: true });
                  setAsk(false);
                }}
              >
                <Icon name="power" /> {t('pilotads.stop.confirm')}
              </button>
            </>
          }
        >
          <p>{t('pilotads.stop.askText')}</p>
        </Modal>
      )}
    </>
  );
}

/** The changes waiting for the owner's yes (the owner answers; a marketer sees his). */
function Waiting({ list, owner }: { list: Act[]; owner: boolean }) {
  const { t } = useTranslation();
  const yes = useAction('ads.ctl.approve', { success: (r) => t(r.status === 'refused' ? 'pilotads.wait.refused' : 'pilotads.wait.done') });
  return (
    <section className="card pa-wait">
      <div className="card-head">
        <h2>
          <Icon name="clock" /> {owner ? t('pilotads.wait.title') : t('pilotads.wait.titleMine')}
          <span className="count">{list.length}</span>
        </h2>
      </div>
      <ul className="pa-wait-list">
        {list.map((a) => (
          <li key={a.id}>
            <div className="pa-wait-what">
              <b>{actLine(t, a)}</b>
              <span className="muted">
                {a.by ?? '—'} · {t('pilotads.ago', { d: since(a.at) })}
                {raiseOf(a) ? ` · ${t('pilotads.wait.raise', { pct: raiseOf(a) })}` : ''}
              </span>
            </div>
            {owner && (
              <div className="pa-wait-btns">
                <button type="button" className="btn" disabled={yes.isPending} onClick={() => yes.mutate({ id: a.id, yes: false })}>
                  {t('pilotads.wait.no')}
                </button>
                <button type="button" className="btn primary" disabled={yes.isPending} onClick={() => yes.mutate({ id: a.id, yes: true })}>
                  {t('pilotads.wait.yes')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const cents = (v: unknown) => (typeof v === 'number' ? v / 100 : null);
/** a budget raise asked, in % (the reason it waits for the owner), in the reader's own language */
const raiseOf = (a: Act): number | null => {
  const from = Number(a.before?.budgetCents);
  const to = Number(a.after?.budgetCents);
  return a.op === 'budget' && from > 0 && to > from ? Math.round(((to - from) / from) * 100) : null;
};
/** One change, said in words: « Ensemble bébé : budget 12 $ → 20 $ par jour ». */
export function actLine(t: (k: string, o?: any) => string, a: Act): string {
  const name = a.objectName || a.objectId;
  if (a.op === 'budget' || (a.op === 'undo' && a.after?.budgetCents !== undefined && a.before?.budgetCents !== a.after?.budgetCents))
    return t('pilotads.act.budget', { name, from: usd(cents(a.before?.budgetCents), 0), to: usd(cents(a.after?.budgetCents), 0) });
  if (a.op === 'launch') return t('pilotads.act.launch', { name, usd: a.after?.budgetUsd ?? '—' });
  if (a.op === 'undo') return t('pilotads.act.undo', { name });
  return t(`pilotads.act.${a.op}`, { name });
}

// ---------------------------------------------------------------- Simple: one card per product
function SimplePubs({ ctl, base }: { ctl: Ctl | null; base: string }) {
  const { t } = useTranslation();
  const [days, setDays] = useState<7 | 30>(() => (store.get('ads-simple-days') === '30' ? 30 : 7));
  const range = { from: algDay(-(days - 1)), to: algDay() };
  const q = useRpc('ads.overview', { ...range, productId: null, marketerId: null });
  const d = q.data;
  const objs = useMemo(() => new Map((ctl?.objects ?? []).map((o) => [o.id, o])), [ctl]);
  const pick = (v: 7 | 30) => {
    setDays(v);
    store.set('ads-simple-days', String(v));
  };
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  const fxOk = !!d.fx.rate && !d.fx.missing;
  const products = [...d.products].sort((a, b) => b.spendUsd - a.spendUsd);
  const loose = d.adsets.filter((a) => !a.productIds.length && a.status === 'ACTIVE');
  return (
    <div className="pa-simple">
      <div className="pa-simple-head">
        <div>
          <h2>{t('pilotads.simple.title')}</h2>
          <p className="muted">{t('pilotads.simple.sub')}</p>
        </div>
        <div className="pa-mode pa-days" role="radiogroup" aria-label={t('pilotads.simple.days')}>
          {([7, 30] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={days === v} className={days === v ? 'on' : ''} onClick={() => pick(v)}>
              {t('pilotads.simple.lastDays', { n: v })}
            </button>
          ))}
        </div>
      </div>
      {!fxOk && <div className="warnbox">{t('ads.fxMissing')}</div>}
      {!products.length ? (
        <div className="card pa-empty">
          <Icon name="megaphone" />
          <h3>{t('pilotads.simple.noneTitle')}</h3>
          <p className="muted">{t('pilotads.simple.noneText')}</p>
          <a className="btn primary" href={`${base}/lancer`}>
            {t('pilotads.simple.launchFirst')}
          </a>
        </div>
      ) : (
        <div className="pa-cards">
          {products.map((p) => (
            <ProductCard key={p.productId} p={p} d={d} fxOk={fxOk} objs={objs} ctl={ctl} />
          ))}
        </div>
      )}
      {!!loose.length && (
        <p className="note pa-loose">
          <Icon name="info" /> {t('pilotads.simple.loose', { n: loose.length })}
        </p>
      )}
    </div>
  );
}

type Prod = Ov['products'][number];
const VERDICT_TONE: Record<string, 'ok' | 'mid' | 'bad' | 'off'> = { scale: 'ok', keep: 'mid', price: 'mid', cutdel: 'bad', cut: 'bad', loss: 'bad', wait: 'off' };

function ProductCard({ p, d, fxOk, objs, ctl }: { p: Prod; d: Ov; fxOk: boolean; objs: Map<string, Obj>; ctl: Ctl | null }) {
  const { t } = useTranslation();
  const sets = d.adsets.filter((a) => a.productIds.includes(p.productId));
  const live = sets.filter((a) => a.status === 'ACTIVE');
  const m = p.money;
  // what a delivered order may cost before ads eat the profit, and what it costs now
  const limit = m.d ? m.avant / m.d : null;
  const cost = m.d ? m.pub / m.d : null;
  const tone = VERDICT_TONE[p.advice.k] ?? 'off';
  const [budget, setBudget] = useState<Obj | null>(null);
  const act = useAction('ads.ctl.act', { success: t('pilotads.doneToast') });
  // « Augmenter »: the ad set that spends the most, +20 %
  const top = live.map((a) => objs.get(a.id)).filter((o): o is Obj => !!o && o.budgetUsd !== null).sort((a, b) => (b.budgetUsd ?? 0) - (a.budgetUsd ?? 0))[0];
  const pauseAll = () => live.forEach((a) => act.mutate({ objectId: a.id, op: 'pause', clientId: clientId() }));
  const meter = limit && cost !== null ? Math.min(1.25, cost / limit) : null;
  return (
    <article className={`card pa-pcard pa-tone-${tone}`}>
      <header>
        <h3>{p.name}</h3>
        <span className={`badge t-${tone}`}>{t(`ads.advice.${p.advice.k}`)}</span>
      </header>
      <div className="pa-three">
        <div>
          <span className="lab">{t('pilotads.simple.spent')}</span>
          <b className="ltr">{usd(p.spendUsd, 0)}</b>
          <small className="ltr">{fxOk ? da(Math.round(m.pub)) : '—'}</small>
        </div>
        <div>
          <span className="lab">{t('pilotads.simple.delivered')}</span>
          <b className="ltr">{n(m.d)}</b>
          <small>{t('pilotads.simple.ofOrders', { n: m.n })}</small>
        </div>
        <div>
          <span className="lab">{t('pilotads.simple.costPer')}</span>
          <b className={`ltr ${limit && cost !== null && cost > limit ? 'neg' : ''}`}>
            {fxOk && cost !== null ? n(Math.round(cost)) : '—'}
            {fxOk && cost !== null && <em className="pa-unit">{t('pilotads.simple.da')}</em>}
          </b>
          <small>{limit ? t('pilotads.simple.limit', { v: da(Math.round(limit)) }) : t('pilotads.simple.noLimit')}</small>
        </div>
      </div>
      {meter !== null && (
        <div className="pa-meter" aria-hidden>
          <i style={{ width: `${Math.round((meter / 1.25) * 100)}%` }} className={p.advice.k === 'wait' ? 'off' : meter > 1 ? 'bad' : meter > 0.7 ? 'mid' : 'ok'} />
          <s style={{ insetInlineStart: `${80}%` }} />
        </div>
      )}
      <p className="pa-say">{t(`pilotads.say.${p.advice.k}`, { rise: p.advice.rise ? da(p.advice.rise) : '' })}</p>
      <div className="pa-do">
        {p.advice.k === 'scale' && top && (
          <button type="button" className="btn primary" onClick={() => setBudget(top)}>
            <Icon name="trend" /> {t('pilotads.simple.raise')}
          </button>
        )}
        {['cut', 'loss', 'cutdel'].includes(p.advice.k) && !!live.length && (
          <button type="button" className="btn danger" disabled={act.isPending} onClick={pauseAll}>
            <Icon name="pause" /> {t('pilotads.simple.pauseAll', { n: live.length })}
          </button>
        )}
      </div>
      <ul className="pa-sets">
        {sets.map((a) => (
          <li key={a.id}>
            <span className={`pa-dot ${a.status === 'ACTIVE' ? 'on' : ''}`} aria-hidden />
            <span className="pa-set-name">{a.name}</span>
            <span className="muted ltr">{(() => { const o = objs.get(a.id); return o?.budgetUsd != null ? t('pilotads.perDay', { v: usd(o.budgetUsd, 0) }) : ''; })()}</span>
            {objs.get(a.id) && <AdsetButtons o={objs.get(a.id)!} ctl={ctl} compact onBudget={setBudget} />}
          </li>
        ))}
      </ul>
      {budget && ctl && <BudgetModal o={budget} ctl={ctl} suggested={p.advice.k === 'scale' ? Math.round((budget.budgetUsd ?? 0) * 1.2 * 10) / 10 : null} onClose={() => setBudget(null)} />}
    </article>
  );
}

// ---------------------------------------------------------------- the buttons of one ad set
export function AdsetButtons({ o, ctl, compact, onBudget }: { o: Obj; ctl: Ctl | null; compact?: boolean; onBudget?: (o: Obj) => void }) {
  const { t } = useTranslation();
  const act = useAction('ads.ctl.act', { success: (r) => (r.status === 'waiting_yes' ? t('pilotads.sentToOwner') : t('pilotads.doneToast')) });
  const [budget, setBudget] = useState(false);
  const live = o.status === 'ACTIVE';
  const stopped = !!ctl?.guard.stopped;
  const busy = act.isPending || o.waiting;
  const openBudget = () => (onBudget ? onBudget(o) : setBudget(true));
  return (
    <span className={`pa-btns ${compact ? 'compact' : ''}`} onClick={(e) => e.stopPropagation()}>
      {live ? (
        <button type="button" className="pa-ib" title={t('pilotads.btn.pause')} aria-label={t('pilotads.btn.pause')} disabled={busy} onClick={() => act.mutate({ objectId: o.id, op: 'pause', clientId: clientId() })}>
          <Icon name="pause" />
        </button>
      ) : (
        <button type="button" className="pa-ib" title={stopped ? t('pilotads.stop.isOn') : t('pilotads.btn.resume')} aria-label={t('pilotads.btn.resume')} disabled={busy || stopped || o.status === 'ARCHIVED' || o.status === 'DELETED'} onClick={() => act.mutate({ objectId: o.id, op: 'resume', clientId: clientId() })}>
          <Icon name="play" />
        </button>
      )}
      <button type="button" className="pa-ib" title={o.budgetLevel ? t('pilotads.btn.budget') : t('pilotads.btn.noBudget')} aria-label={t('pilotads.btn.budget')} disabled={busy || !o.budgetLevel || o.budgetUsd === null} onClick={openBudget}>
        <Icon name="wallet" />
      </button>
      {!compact && (
        <button type="button" className="pa-ib" title={t('pilotads.btn.copy')} aria-label={t('pilotads.btn.copy')} disabled={busy || stopped} onClick={() => act.mutate({ objectId: o.id, op: 'copy', clientId: clientId() })}>
          <Icon name="copy" />
        </button>
      )}
      {o.waiting && (
        <span className="pa-waitdot" title={t('pilotads.waitingYes')}>
          <Icon name="clock" />
        </span>
      )}
      {budget && ctl && <BudgetModal o={o} ctl={ctl} suggested={null} onClose={() => setBudget(false)} />}
    </span>
  );
}

/** A new daily budget: what changes, and whether it goes at once or to the owner. */
export function BudgetModal({ o, ctl, suggested, onClose }: { o: Obj; ctl: Ctl; suggested: number | null; onClose: () => void }) {
  const { t } = useTranslation();
  const from = o.budgetUsd ?? 0;
  const [v, setV] = useState(String(suggested ?? from));
  const to = Number(v.replace(',', '.'));
  const act = useAction('ads.ctl.act', { success: (r) => (r.status === 'waiting_yes' ? t('pilotads.sentToOwner') : t('pilotads.doneToast')), onDone: onClose });
  const rise = from && to > from ? (to - from) / from : 0;
  const g = ctl.guard;
  const total = ctl.shopDailyUsd - from + (isFinite(to) ? to : 0);
  const overDay = g.maxDailyUsd !== null && total > g.maxDailyUsd && to > from;
  const needsYes = !ctl.owner && (rise * 100 > g.maxRaisePct || (g.yesAboveUsd !== null && to > g.yesAboveUsd));
  const ok = isFinite(to) && to >= 1 && to !== from && !(overDay && !ctl.owner);
  return (
    <Modal
      title={t('pilotads.budget.title', { name: o.name })}
      onClose={onClose}
      sheet
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!ok || act.isPending} onClick={() => act.mutate({ objectId: o.id, op: 'budget', usd: to, clientId: clientId() })}>
            {needsYes ? t('pilotads.budget.ask') : t('pilotads.budget.save')}
          </button>
        </>
      }
    >
      <div className="pa-budget">
        <label className="field">
          <span className="lab">{t('pilotads.budget.perDay')}</span>
          <span className="pa-usd">
            <input type="number" inputMode="decimal" min={1} step={0.5} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
            <b>$</b>
          </span>
        </label>
        <div className="pa-quick">
          {[-20, 10, 20, 30].map((k) => (
            <button key={k} type="button" className="chip" onClick={() => setV(String(Math.round(from * (1 + k / 100) * 10) / 10))}>
              {k > 0 ? `+${k}` : k} %
            </button>
          ))}
        </div>
        <p className="pa-fromto ltr">
          {usd(from)} → <b>{isFinite(to) ? usd(to) : '—'}</b> {rise ? <span className={rise * 100 > g.maxRaisePct ? 'neg' : ''}>(+{Math.round(rise * 100)} %)</span> : null}
        </p>
        {o.budgetLevel === 'campaign' && <p className="note">{t('pilotads.budget.campaign', { name: o.campaignName ?? '' })}</p>}
        {overDay && <div className={ctl.owner ? 'warnbox' : 'error'}>{t(ctl.owner ? 'pilotads.budget.overOwner' : 'pilotads.budget.over', { total: Math.round(total), max: g.maxDailyUsd })}</div>}
        {needsYes && !overDay && <div className="warnbox">{t('pilotads.budget.needsYes', { pct: g.maxRaisePct })}</div>}
        <p className="note">{t('pilotads.budget.note')}</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Pro: the log of every change
export function ActionLog({ rows: given, title }: { rows?: Act[]; title?: string }) {
  const { t } = useTranslation();
  const q = useRpc('ads.ctl.actions', { limit: 60 }, { enabled: !given });
  const undo = useAction('ads.ctl.undo', { success: t('pilotads.log.undone') });
  const rows = given ?? q.data ?? [];
  return (
    <section className="card pa-log">
      <div className="card-head">
        <h2>
          <Icon name="history" /> {title ?? t('pilotads.log.title')}
          <span className="count">{rows.length}</span>
        </h2>
      </div>
      {!given && q.isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>{t('pilotads.log.empty')}</Empty>
      ) : (
        <ul className="pa-log-list">
          {rows.map((a) => (
            <li key={a.id} className={`st-${a.status}`}>
              <span className={`pa-src s-${a.source}`} title={t(`pilotads.src.${a.source}`)}>
                <Icon name={a.source === 'rule' || a.source === 'pilot' || a.source === 'ask' ? 'sparkles' : a.source === 'stop_all' ? 'power' : a.source === 'launch' ? 'megaphone' : a.source === 'auto' ? 'zap' : 'user'} />
              </span>
              <div className="pa-log-what">
                <b>{actLine(t, a)}</b>
                <span className="muted">
                  {a.source === 'rule' && a.rule ? t(`pilotads.rule.${a.rule}.name`) : a.by ?? t(`pilotads.src.${a.source}`)} · {t('pilotads.ago', { d: since(a.at) })}
                  {a.approvedBy ? ` · ${t('pilotads.log.yesBy', { name: a.approvedBy })}` : ''}
                </span>
                {a.error && <span className="pa-err">{a.error}</span>}
              </div>
              <span className={`badge t-${a.status === 'done' ? 'ok' : a.status === 'failed' || a.status === 'refused' ? 'bad' : a.status === 'waiting_yes' ? 'mid' : 'off'}`}>{t(`pilotads.st.${a.status}`)}</span>
              {a.canUndo && (
                <button type="button" className="btn small" disabled={undo.isPending} onClick={() => undo.mutate({ id: a.id })}>
                  <Icon name="undo" /> {t('pilotads.log.undo')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Pro: where the ads' orders come from
export function WhereCard() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const q = useRpc('ads.report.where', { from: algDay(-(days - 1)), to: algDay() });
  const d = q.data;
  const top = Math.max(1, ...(d?.hours ?? []).map((h) => h.orders));
  return (
    <section className="card pa-where">
      <div className="card-head">
        <h2>
          <Icon name="globe" /> {t('pilotads.where.title')}
        </h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t('pilotads.where.period')}>
          {[7, 30, 90].map((k) => (
            <option key={k} value={k}>
              {t('pilotads.simple.lastDays', { n: k })}
            </option>
          ))}
        </select>
      </div>
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : !d.wilayas.length ? (
        <Empty>{t('pilotads.where.empty')}</Empty>
      ) : (
        <div className="pa-where-grid">
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('pilotads.where.wilaya')}</th>
                  <th className="num">{t('pilotads.where.orders')}</th>
                  <th className="num">{t('pilotads.where.delivered')}</th>
                  <th className="num">{t('pilotads.where.rate')}</th>
                </tr>
              </thead>
              <tbody>
                {d.wilayas.slice(0, 12).map((w) => (
                  <tr key={w.wilayaId}>
                    <td data-l={t('pilotads.where.wilaya')}>{wilayaName(w.wilayaId)}</td>
                    <td className="num" data-l={t('pilotads.where.orders')}>
                      {n(w.orders)}
                    </td>
                    <td className="num" data-l={t('pilotads.where.delivered')}>
                      {n(w.delivered)}
                    </td>
                    <td className="num" data-l={t('pilotads.where.rate')}>
                      <span className={w.rate !== null && w.rate < 50 ? 'neg' : ''}>{w.rate === null ? '—' : `${w.rate} %`}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="pa-sub">{t('pilotads.where.hours')}</h3>
            <div className="pa-hours" role="img" aria-label={t('pilotads.where.hoursLabel')}>
              {d.hours.map((h) => (
                <span key={h.h} title={`${h.h}h · ${h.orders}`}>
                  <i style={{ height: `${Math.max(3, Math.round((h.orders / top) * 100))}%` }} />
                  {h.h % 6 === 0 && <em className="ltr">{h.h}h</em>}
                </span>
              ))}
            </div>
            <h3 className="pa-sub">{t('pilotads.where.goals')}</h3>
            <table className="pa-goaltbl">
              <tbody>
                {d.goals.map((g) => (
                  <tr key={g.goal}>
                    <td>{t(`pilotads.goal.${g.goal}.name`, { defaultValue: g.goal })}</td>
                    <td className="num ltr">{usd(g.spendUsd, 0)}</td>
                    <td className="num">{t('pilotads.where.goalOrders', { n: g.orders, d: g.delivered })}</td>
                    <td className="num ltr">{g.delivered ? usd(g.spendUsd / g.delivered) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">{t('pilotads.where.note')}</p>
          </div>
        </div>
      )}
    </section>
  );
}

/** The control state as a map, for the tables of Publicité (Pro). */
export function useControls(): { ctl: Ctl | null; byId: Map<string, Obj> } {
  const q = useRpc('ads.ctl.state', {}, { refetchInterval: 60_000 });
  const byId = useMemo(() => new Map((q.data?.objects ?? []).map((o) => [o.id, o])), [q.data]);
  return { ctl: q.data ?? null, byId };
}
