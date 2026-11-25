// Contrôle (the owner's ask, 25 Nov 2026): « always everything matched between the depot, Pilotix and each delivery
// company, anything wrong we know ». Aperçu: one card per company (each one alone: its problems by area, whether it
// answers, its parcels on the road, the money to check) and the problems; then one tab per area — Argent (the owners),
// Retours, Dispatch, Statuts — with each company's chip, « À régler / Vus / Réglés ». Each problem says what disagrees,
// since when, who acts and what to do; what Pilotix did alone; « Ouvrir la commande », « C'est vu », « Reçu au dépôt ».
// The checks: @pilotix/core modules/leaks.ts (every 30 minutes) and leaks/rules.ts.
import { LEAK_AREAS, MENU_TABS, menuTabName, type LeakArea } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { In, Out } from '../../lib/backend';
import { da, since } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { tabOn } from '../../lib/rights';
import { useSession } from '../../lib/session';
import { CoChip } from '../../ui/CoIcon';
import { Empty, ErrorBox, Icon, Loading, StageBar } from '../../ui/kit';
import type { PageProps } from '../registry';
import './controle.css';

const TABS = MENU_TABS.controle;
type Tab = (typeof TABS)[number];
type Ov = Out<'leaks.overview'>;
type Co = Ov['companies'][number];
type Row = Out<'leaks.list'>['rows'][number];
type State = NonNullable<In<'leaks.list'>['state']>;
type T = ReturnType<typeof useTranslation>['t'];

const AREA_ICON: Record<LeakArea, string> = { argent: 'coins', retours: 'undo', dispatch: 'truck', statuts: 'route' };
const STATES: State[] = ['open', 'seen', 'closed'];
const letters = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

export function Controle({ sub }: PageProps) {
  const { t } = useTranslation();
  const ov = useRpc('leaks.overview', {});
  const tabs = TABS.filter((k) => tabOn('controle', k));
  const view: Tab = (tabs as readonly string[]).includes(sub ?? '') ? (sub as Tab) : (tabs[0] ?? 'apercu');
  const d = ov.data;
  return (
    <div className="ctl">
      <StageBar
        flow={false}
        current={view}
        items={tabs.map((k) => ({ key: k, label: t(menuTabName('controle', k)), href: `#/controle/${k}`, ...(d ? { count: k === 'apercu' ? d.open : d.totals[k as LeakArea] } : {}) }))}
      />
      {ov.error ? <ErrorBox error={ov.error} onRetry={() => ov.refetch()} /> : !d ? <Loading /> : view === 'apercu' ? <Overview ov={d} /> : <Area key={view} area={view as LeakArea} ov={d} />}
    </div>
  );
}

// ---------------------------------------------------------------- Aperçu
function Overview({ ov }: { ov: Ov }) {
  const { t } = useTranslation();
  const [pick, setPick] = useState<number | null>(null);
  const run = useAction('leaks.run', { success: t('ctl.ran') });
  const co = ov.companies.find((c) => c.id === pick) ?? null;
  return (
    <div className="ctl-wrap">
      <section className={`ctl-hero ${ov.open ? 'is-bad' : 'is-ok'}`}>
        <span className="ctl-hero-mark" aria-hidden="true">
          <Icon name={ov.open ? 'alert' : 'checkcircle'} />
        </span>
        <div className="ctl-grow">
          <h2 className="ctl-hero-t">{ov.open ? t('ctl.hero.bad', { count: ov.open }) : t('ctl.hero.ok')}</h2>
          <p className="ctl-hero-text">{t('ctl.hero.text')}</p>
          <p className="ctl-hero-meta">
            <span>{ov.lastRun ? t('ctl.hero.last', { when: since(ov.lastRun.at) }) : t('ctl.hero.never')}</span>
            <span>{t('ctl.hero.agreed', { count: ov.agreedToday })}</span>
            <span>{t('ctl.hero.acted', { count: ov.actedToday })}</span>
          </p>
        </div>
        <button type="button" className="btn ctl-run" disabled={run.isPending} onClick={() => run.mutate({})}>
          <Icon name="refresh" /> {t('ctl.run')}
        </button>
      </section>
      <div className="ctl-cos">
        {ov.companies.map((c) => (
          <CompanyCard key={c.id} c={c} on={pick === c.id} money={ov.money} onPick={() => setPick(pick === c.id ? null : c.id)} />
        ))}
      </div>
      <h3 className="ctl-h3">{co ? t('ctl.problemsOf', { name: co.name }) : t('ctl.problemsAll')}</h3>
      <Problems key={pick ?? 0} companyId={pick ?? undefined} state="open" limit={10} />
    </div>
  );
}

function CompanyCard({ c, on, money, onPick }: { c: Co; on: boolean; money: boolean; onPick: () => void }) {
  const { t } = useTranslation();
  const down = !!c.health?.error;
  const tone = down ? 'bad' : c.open ? 'warn' : 'ok';
  const link = !c.active
    ? t('ctl.co.off')
    : c.health
      ? down
        ? t('ctl.co.down', { when: since(c.health.errorSince) })
        : t('ctl.co.answers', { when: since(c.health.okAt) })
      : c.kind === 'own' || c.kind === 'manual'
        ? t('ctl.co.noApi')
        : null;
  return (
    <button type="button" className={`ctl-co is-${tone}${on ? ' on' : ''}`} onClick={onPick} aria-pressed={on}>
      <span className="ctl-co-top">
        <CoChip companyId={c.id} kind={c.kind} className="ctl-co-ic">
          {letters(c.name)}
        </CoChip>
        <span className="ctl-co-name">{c.name}</span>
        <span className={`ctl-pill is-${tone}`}>{c.open ? t('ctl.co.open', { count: c.open }) : t('ctl.co.ok')}</span>
      </span>
      <span className="ctl-areas">
        {LEAK_AREAS.filter((a) => money || a !== 'argent').map((a) => (
          <span key={a} className={`ctl-area${c.byArea[a] ? ' has' : ''}`}>
            <Icon name={AREA_ICON[a]} />
            <span className="ctl-area-n">{t(`ctl.tabs.${a}`)}</span>
            <b>{c.byArea[a] || '✓'}</b>
          </span>
        ))}
      </span>
      <span className="ctl-co-foot">
        {link ? <span className={down ? 'ctl-bad' : ''}>{link}</span> : null}
        <span>{t('ctl.co.road', { count: c.road })}</span>
        {money && c.atRisk ? <span className="ctl-money">{t('ctl.co.atRisk', { amount: da(c.atRisk) })}</span> : null}
        {c.seen ? <span>{t('ctl.co.seen', { count: c.seen })}</span> : null}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- an area: Argent, Retours, Dispatch, Statuts
function Area({ area, ov }: { area: LeakArea; ov: Ov }) {
  const { t } = useTranslation();
  const [co, setCo] = useState<number | null>(null);
  const [state, setState] = useState<State>('open');
  const chips = ov.companies.filter((c) => c.active || c.byArea[area]);
  return (
    <div className="ctl-wrap">
      <div className="ctl-tools">
        <div className="ctl-chips">
          <button type="button" className={`ctl-chip${co === null ? ' on' : ''}`} aria-pressed={co === null} onClick={() => setCo(null)}>
            {t('ctl.all')} <b>{ov.totals[area]}</b>
          </button>
          {chips.map((c) => (
            <button key={c.id} type="button" className={`ctl-chip${co === c.id ? ' on' : ''}`} aria-pressed={co === c.id} onClick={() => setCo(c.id)}>
              <CoChip companyId={c.id} kind={c.kind} className="ctl-chip-ic">
                {letters(c.name)}
              </CoChip>
              <span className="ctl-chip-n">{c.name}</span>
              <b>{c.byArea[area]}</b>
            </button>
          ))}
        </div>
        <div className="ctl-seg" role="tablist">
          {STATES.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={state === s} className={state === s ? 'on' : ''} onClick={() => setState(s)}>
              {t(`ctl.state.${s}`)}
            </button>
          ))}
        </div>
      </div>
      <Problems key={`${co}-${state}`} area={area} companyId={co ?? undefined} state={state} />
    </div>
  );
}

// ---------------------------------------------------------------- the problems
function Problems({ area, companyId, state, limit }: { area?: LeakArea; companyId?: number; state: State; limit?: number }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const q = useRpc('leaks.list', { ...(area ? { area } : {}), ...(companyId ? { companyId } : {}), state });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const rows = limit && !all ? q.data.rows.slice(0, limit) : q.data.rows;
  if (!rows.length) return <Empty>{t(`ctl.empty.${state}`)}</Empty>;
  return (
    <div className="ctl-list">
      {rows.map((r) => (
        <Problem key={r.id} r={r} />
      ))}
      {limit && !all && q.data.rows.length > limit ? (
        <button type="button" className="btn ctl-more" onClick={() => setAll(true)}>
          {t('ctl.seeAll')} ({q.data.rows.length})
        </button>
      ) : null}
    </div>
  );
}

/** What the problem says, in plain words: what disagrees, and what to do. */
function say(t: T, r: Row): { title: string; todo: string; extra: string | null } {
  const d = r.details as Record<string, unknown>;
  const v = {
    co: r.company ?? '—',
    words: String(d.words ?? r.words ?? ''),
    ref: String(d.ref ?? r.payRef ?? ''),
    tracking: String(d.tracking ?? r.tracking ?? ''),
    first: String(d.first ?? ''),
    paid: da(Number(d.paid ?? 0)),
    want: da(Number(d.total ?? 0) - Number(d.fee ?? 0)),
  };
  const k = `ctl.k.${r.kind}`;
  let title = t(`${k}.t`, v);
  let todo = t(`${k}.do`, v);
  let extra: string | null = null;
  if (r.kind === 'not_paid' && d.livreur) {
    title = t(`${k}.livreur`, v);
    todo = t(`${k}.doLivreur`, v);
  }
  if (r.kind === 'payout_not_in_caisse' && d.removed) title = t(`${k}.removed`, v);
  if (r.kind === 'return_not_scanned' && d.stock) extra = t(`${k}.stock`);
  if ((r.kind === 'sync_down' || r.kind === 'no_tracking') && d.error) extra = `« ${String(d.error)} »`;
  return { title, todo, extra };
}

function Problem({ r }: { r: Row }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const seen = useAction('leaks.seen', r.seenAt ? {} : { success: t('ctl.act.seenDone') });
  const got = useAction('leaks.received', { success: t('ctl.act.receivedDone') });
  const { title, todo, extra } = say(t, r);
  const depot = !!session && (session.isAdmin || session.roles.includes('depot'));
  const amount = r.amount ? (r.area === 'argent' ? da(r.amount) : t('ctl.parcelOf', { amount: da(r.amount) })) : null;
  return (
    <article className={`ctl-card is-${r.area}${r.closedAt ? ' is-closed' : ''}`}>
      <span className="ctl-card-ic" aria-hidden="true">
        <Icon name={r.closedAt ? 'checkcircle' : AREA_ICON[r.area]} />
      </span>
      <div className="ctl-grow">
        <h4 className="ctl-card-t">{title}</h4>
        <p className="ctl-card-meta">
          {r.ref ? <span className="ltr ctl-ref">{r.ref}</span> : null}
          {r.customer ? <span>{r.customer}</span> : null}
          {r.company ? (
            <span className="ctl-cm">
              <CoChip companyId={r.companyId} kind={r.companyKind} className="ctl-cm-ic">
                {letters(r.company)}
              </CoChip>
              {r.company}
            </span>
          ) : null}
          {r.tracking && r.tracking !== r.ref ? <span className="ltr">{r.tracking}</span> : null}
          <span>{t('ctl.since', { when: since(r.since) })}</span>
          <span className={`ctl-who is-${r.who}`}>{t('ctl.whoLine', { who: t(`ctl.who.${r.who}`) })}</span>
        </p>
        <p className="ctl-card-do">
          {todo}
          {extra ? <b> {extra}</b> : null}
        </p>
        {r.action === 'alert' ? (
          <p className="ctl-did">
            <Icon name="checkcircle" /> {t('ctl.did.alert')}
          </p>
        ) : null}
        {r.closedAt ? (
          <p className="ctl-did is-done">{r.closedBy === 'auto' ? t('ctl.closedAuto') : t('ctl.closedBy', { name: r.closedBy })}</p>
        ) : r.seenBy ? (
          <p className="ctl-did is-seen">{t('ctl.seenBy', { name: r.seenBy })}</p>
        ) : null}
      </div>
      <div className="ctl-card-side">
        {amount ? <span className={`ctl-amount${r.area === 'argent' ? ' is-money' : ''}`}>{amount}</span> : null}
        <div className="ctl-card-acts">
          {r.orderId ? (
            <button type="button" className="btn" onClick={() => openOrder(r.orderId!)}>
              {t('ctl.act.open')}
            </button>
          ) : null}
          {r.canReceive && depot ? (
            <button type="button" className="btn primary" disabled={got.isPending} onClick={() => got.mutate({ id: r.id })}>
              {t('ctl.act.received')}
            </button>
          ) : null}
          {!r.closedAt ? (
            <button type="button" className="btn" disabled={seen.isPending} onClick={() => seen.mutate({ id: r.id, ...(r.seenAt ? { undo: true } : {}) })}>
              {r.seenAt ? t('ctl.act.unseen') : t('ctl.act.seen')}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
