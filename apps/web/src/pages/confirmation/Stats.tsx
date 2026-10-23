// "Statistiques" (foldable) — the KPI blocks of Nouvelles and En cours (managers). « Confirmées » is a page of statistics
// only (ConfirmedStatsPage): the key numbers, confirmation by agent, and what became of the confirmed orders.
import { Tone } from '@pilotix/shared';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { da, dur, n } from '../../lib/format';
import { ErrorBox, Help, Kpi, Loading } from '../../ui/kit';
import { kfInput, Kf, loadKf, saveKf, Sub } from './shared';
import { useNow } from './Countdown';
import { DateRange, periodLabel } from './DateRange';
import './confirmation.css';

const tone3 = (p: number | null, ok: number, warn: number): Tone | undefined => (p === null ? undefined : p >= ok ? 'ok' : p >= warn ? 'warn' : 'bad');
const pctTxt = (p: number | null) => (p === null ? '—' : `${p} %`);

export function StatsSection({ sub }: { sub: Sub }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => store.get('px-kff') !== '0');
  const [kf, setKfState] = useState<Kf>(loadKf);
  const setKf = (k: Kf) => {
    setKfState(k);
    saveKf(k);
  };
  if (sub === 'terminees' || sub === 'livrees') return null;
  const fold = (o: boolean) => (setOpen(o), store.set('px-kff', o ? '1' : '0'));
  if (sub === 'nouvelles') return <NouvellesStats kf={kf} setKf={setKf} open={open} setOpen={fold} />;
  return (
    <section className={`px-kff px-kff-one ${open ? '' : 'folded'}`}>
      <button
        type="button"
        className="px-kff-btn"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          store.set('px-kff', open ? '0' : '1');
        }}
      >
        <span className="px-kff-t">{t('confirmation.stats.title')}</span>
        <span className="px-kff-s">{open ? t('common.hide') : t('common.show')}</span>
        <i className="px-kff-ch" />
      </button>
      {open && (
        <div className="px-kff-body">
          {sub === 'attente' && <EnCoursCard kf={kf} setKf={setKf} />}
          {sub === 'confirmees' && <ConfirmedCard kf={kf} setKf={setKf} />}
        </div>
      )}
    </section>
  );
}

/** Period / date type / indicator selects (".bjkf"). */
function KfBar({ kf, setKf, noView }: { kf: Kf; setKf: (k: Kf) => void; noView?: boolean }) {
  const { t } = useTranslation();
  const set = (p: Partial<Kf>) => setKf({ ...kf, ...p });
  return (
    <div className="bjkf">
      <DateRange kf={kf} onChange={set} />
      <select aria-label={t('confirmation.stats.basis')} className="bjkf-sel bjkf-bas" value={kf.basis} onChange={(e) => set({ basis: e.target.value as Kf['basis'] })}>
        <option value="created">{t('confirmation.stats.created')}</option>
        <option value="updated">{t('confirmation.stats.updated')}</option>
      </select>
      {!noView && <select aria-label={t('confirmation.stats.view')} className="bjkf-sel bjkf-view" value={kf.view} onChange={(e) => set({ view: e.target.value as Kf['view'] })}>
        <option value="conf">{t('confirmation.stats.viewConf')}</option>
        <option value="deliv">{t('confirmation.stats.viewDeliv')}</option>
      </select>}
    </div>
  );
}

function Head({ title, help, children }: { title: string; help: string; children?: ReactNode }) {
  return (
    <div className="card-head">
      <h2>
        {title}
        <Help text={help} label={title} />
      </h2>
      {children}
    </div>
  );
}

const perLabel = (t: (k: string) => string, kf: Kf) => periodLabel(t, i18n.language || 'fr', kf);

// ---------------------------------------------------------------- Nouvelles: one foldable card
const PERS = ['today', 'yesterday', '7', '30', 'month', 'custom'] as const;

/** Nouvelles › Statistiques: one card with a fold arrow, the date filters under its header, and six numbers. */
function NouvellesStats({ kf, setKf, open, setOpen }: { kf: Kf; setKf: (k: Kf) => void; open: boolean; setOpen: (o: boolean) => void }) {
  const { t } = useTranslation();
  // this box always counts by status change, on the chosen dates only
  const q = useRpc('confirmation.firstCall', { ...kfInput(kf), basis: 'updated' }, { refetchInterval: 30_000, enabled: open });
  const now = useNow();
  const D = q.data;
  const set = (p: Partial<Kf>) => setKf({ ...kf, ...p });
  const fm = D?.firstMinutes ?? 15;
  const onTime = D && D.called ? Math.round((D.onTime * 100) / D.called) : null;
  const f5 = D && D.called ? Math.round((D.under5 * 100) / D.called) : null;
  const age = D?.oldest ? Math.max(0, now - Date.parse(D.oldest.since)) : null;
  const med = D?.medianMin ?? null;
  return (
    <section className={`card px-st ${open ? '' : 'folded'}`}>
      <button type="button" className="px-st-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="px-st-t">{t('confirmation.stats.title')}</span>
        {open && (
          <span className="bjfc-live">
            <i />
            {t('confirmation.fc.live')}
          </span>
        )}
        <svg className="px-st-ch" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
        </svg>
      </button>
      {open && (
        <>
          <div className="px-st-filters">
            <DateRange kf={kf} onChange={set} />
            <span className="muted small">{t('confirmation.stats.byStatusChange')}</span>
          </div>
          {q.error ? (
            <ErrorBox error={q.error} onRetry={() => q.refetch()} />
          ) : !D ? (
            <Loading />
          ) : (
            <div className="px-st-grid">
              <Kpi
                tone={D.waiting ? 'warn' : undefined}
                icon="hourglass" label={t('confirmation.fc.waiting')}
                help={t('confirmation.kh.waiting')}
                value={n(D.waiting)}
                sub={D.waiting ? (D.waitingNoAgent ? t('confirmation.fc.noAgent', { n: D.waitingNoAgent }) : t('confirmation.fc.allAssigned')) : t('confirmation.fc.nobody')}
              />
              <Kpi tone={D.late ? 'bad' : undefined} help={t('confirmation.kh.late', { first: fm })} icon="alert" label={t('confirmation.fc.lateNow')} value={n(D.late)} sub={D.late ? t('confirmation.fc.lateSub') : t('confirmation.fc.noLate')} />
              <Kpi
                tone={age === null ? undefined : age > fm * 60_000 ? 'bad' : age > fm * 30_000 ? 'warn' : undefined}
                icon="timer" label={t('confirmation.fc.oldest')}
                help={t('confirmation.kh.oldest')}
                value={age === null ? '—' : dur(age)}
                sub={D.oldest ? `${D.oldest.ref} · ${D.oldest.name}` : t('confirmation.fc.nobody')}
              />
              <Kpi tone={tone3(onTime, 80, 70)} help={t('confirmation.kh.onTime', { first: fm })} icon="check" rate={onTime === null ? null : onTime / 100} label={t('confirmation.fc.onTime')} value={pctTxt(onTime)} sub={D.called ? t('confirmation.fc.onTimeSub', { ok: D.onTime, n: D.called }) : t('confirmation.fc.noneCalled')} />
              <Kpi
                tone={med === null ? undefined : med <= fm ? 'ok' : med <= fm * 2 ? 'warn' : 'bad'}
                icon="sliders" label={t('confirmation.fc.median')}
                help={t('confirmation.kh.median')}
                value={med === null ? '—' : dur(med * 60_000)}
                sub={D.called ? t('confirmation.fc.medianSub') : perLabel(t, kf)}
              />
              <Kpi tone={tone3(f5, 50, 25)} help={t('confirmation.kh.under5')} icon="sparkles" rate={f5 === null ? null : f5 / 100} label={t('confirmation.fc.under5')} value={pctTxt(f5)} sub={D.called ? t('confirmation.fc.under5Sub') : perLabel(t, kf)} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- En cours: one card, like Confirmées
/**
 * En cours › Statistiques. Same card and dropdowns as Confirmées (period, date type, indicator).
 * "À traiter maintenant" is live (every order of the tab, whatever the dates); "Performance" and the
 * agent table follow the dropdowns; "Performance de livraison" shows what became of the confirmed orders.
 */
function EnCoursCard({ kf, setKf }: { kf: Kf; setKf: (k: Kf) => void }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.enCours', kfInput(kf), { refetchInterval: 30_000, enabled: kf.view === 'conf' });
  const now = useNow();
  const D = q.data;
  const L = (k: string) => t(`confirmation.ek.col.${k}`);
  const badge = (p: number | null, ok: number, warn: number) => <span className={`badge t-${tone3(p, ok, warn) ?? 'off'} ltr`}>{pctTxt(p)}</span>;
  let body: ReactNode = <Loading />;
  if (kf.view === 'deliv') body = <DelivBody kf={kf} on="confirmed" />;
  else if (q.error) body = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (D) {
    const lateAge = D.lateOldest ? Math.max(0, now - Date.parse(D.lateOldest.since)) : null;
    const nextIn = D.nextLater ? Math.max(0, Date.parse(D.nextLater.at) - now) : null;
    const early = Math.max(0, D.cancelled - D.complete);
    body = (
      <div>
        <div className="bjec-sec">{t('confirmation.ek.secLive')}</div>
        <div className="kpis">
          <Kpi tone={D.dueNow ? 'warn' : undefined} label={t('confirmation.ek.due')} help={t('confirmation.ek.dueHelp')} value={n(D.dueNow)} sub={t('confirmation.ek.dueSub', { n: D.count })} />
          <Kpi
            tone={D.late ? 'bad' : undefined}
            label={t('confirmation.ek.late')}
            help={t('confirmation.ek.lateHelp')}
            value={n(D.late)}
            sub={D.lateOldest && lateAge !== null ? t('confirmation.ek.lateSub', { d: dur(lateAge), ref: D.lateOldest.ref }) : t('confirmation.ek.lateNone')}
          />
          <Kpi
            label={t('confirmation.ek.later')}
            help={t('confirmation.ek.laterHelp')}
            value={n(D.later)}
            sub={D.nextLater && nextIn !== null ? t('confirmation.ek.laterSub', { d: dur(nextIn), ref: D.nextLater.ref }) : t('confirmation.ek.laterNone')}
          />
          <Kpi label={t('confirmation.ek.value')} help={t('confirmation.ek.valueHelp')} value={da(D.value)} sub={t('confirmation.ek.valueSub', { n: D.count })} />
        </div>
        <div className="bjec-sec">
          {t('confirmation.ek.secPerf')} · {perLabel(t, kf)}
        </div>
        <div className="kpis">
          <Kpi tone={tone3(D.confRate, 60, 40)} label={t('confirmation.ek.conf')} help={t('confirmation.ek.confHelp')} value={pctTxt(D.confRate)} sub={t('confirmation.ek.confSub', { c: D.confirmed, x: D.cancelled })} />
          <Kpi tone={tone3(D.recoveryRate, 60, 40)} label={t('confirmation.ek.rec')} help={t('confirmation.ek.recHelp')} value={pctTxt(D.recoveryRate)} sub={t('confirmation.ek.recSub', { r: D.recovered, l: D.lost })} />
          <Kpi
            tone={tone3(D.completeRate, 100, 80)}
            label={t('confirmation.ek.full')}
            help={t('confirmation.ek.fullHelp')}
            value={pctTxt(D.completeRate)}
            sub={D.cancelled ? t('confirmation.ek.fullSub', { c: D.complete, n: D.cancelled }) : t('confirmation.ek.fullNone')}
          />
          <Kpi tone={early ? 'bad' : D.cancelled ? 'ok' : undefined} label={t('confirmation.ek.early')} help={t('confirmation.ek.earlyHelp')} value={n(early)} sub={t('confirmation.ek.earlySub')} />
        </div>
        <h3>{t('confirmation.ek.byAgent')}</h3>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{L('agent')}</th>
                <th className="num">{L('n')}</th>
                <th className="num">{L('due')}</th>
                <th className="num">{L('late')}</th>
                <th className="num">{L('conf')}</th>
                <th className="num">{L('rec')}</th>
                <th className="num">{L('full')}</th>
              </tr>
            </thead>
            <tbody>
              {D.byAgent.length ? (
                D.byAgent.map((a) => (
                  <tr key={a.agentId ?? 0}>
                    <td data-l={L('agent')}>
                      <b>{a.name ?? t('confirmation.noAgent')}</b>
                    </td>
                    <td className="num ltr" data-l={L('n')}>
                      {n(a.n)}
                    </td>
                    <td className="num ltr" data-l={L('due')}>
                      {a.due ? <b>{n(a.due)}</b> : '0'}
                    </td>
                    <td className="num" data-l={L('late')}>
                      <span className={`badge t-${a.late ? 'bad' : 'off'} ltr`}>{n(a.late)}</span>
                    </td>
                    <td className="num" data-l={L('conf')}>
                      {badge(a.confRate, 60, 40)}
                    </td>
                    <td className="num" data-l={L('rec')}>
                      {badge(a.recoveryRate, 60, 40)}
                    </td>
                    <td className="num" data-l={L('full')}>
                      {badge(a.completeRate, 100, 80)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="empty">
                    {t('confirmation.ek.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted small px-ek-legend">{t('confirmation.ek.legend')}</p>
      </div>
    );
  }
  return (
    <div className="card bjkfc bjek">
      <Head title={t('confirmation.ek.title')} help={t('confirmation.ek.help')}>
        <KfBar kf={kf} setKf={setKf} />
      </Head>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- Nouvelles
function FirstCallCard({ kf, setKf }: { kf: Kf; setKf: (k: Kf) => void }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.firstCall', kfInput(kf), { refetchInterval: 30_000 });
  const now = useNow();
  const D = q.data;
  const BUCKETS = [
    ['< 5 min', '#1e8a4c'],
    ['5–15 min', '#62b37c'],
    ['15–30 min', '#e0a100'],
    ['30–60 min', '#e07b39'],
    ['> 1 h', '#c9534b'],
  ] as const;
  let body: ReactNode = <Loading />;
  if (q.error) body = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (D) {
    const fm = D.firstMinutes;
    const pOk = D.called ? Math.round((D.onTime * 100) / D.called) : null;
    const f5 = D.called ? Math.round((D.under5 * 100) / D.called) : null;
    const age = D.oldest ? Math.max(0, now - Date.parse(D.oldest.since)) : null;
    const med = D.medianMin;
    body = (
      <>
        <div>
          <div className="bjfc-row">
            <span className="bjfc-rl">{t('confirmation.fc.now')}</span>
            <div className="bjfc-k">
              <Kpi
                big={D.waiting > 0}
                tone={D.waiting ? undefined : 'ok'}
                label={t('confirmation.fc.waiting')}
                value={n(D.waiting)}
                sub={D.waiting ? (D.waitingNoAgent ? t('confirmation.fc.noAgent', { n: D.waitingNoAgent }) : t('confirmation.fc.allAssigned')) : t('confirmation.fc.nobody')}
              />
              <Kpi big={D.late > 0} tone={D.late ? 'bad' : 'ok'} label={t('confirmation.fc.lateNow')} value={n(D.late)} sub={D.late ? t('confirmation.fc.lateSub') : t('confirmation.fc.noLate')} />
              <Kpi
                tone={age === null ? 'ok' : age > fm * 60_000 ? 'bad' : age > fm * 30_000 ? 'warn' : 'ok'}
                label={t('confirmation.fc.oldest')}
                value={age === null ? '—' : dur(age)}
                sub={D.oldest ? `${D.oldest.ref} · ${D.oldest.name}` : ' '}
              />
            </div>
          </div>
          <div className="bjfc-row">
            <span className="bjfc-rl">{perLabel(t, kf)}</span>
            <div className="bjfc-k">
              <Kpi label={t('confirmation.fc.recvCalled')} value={`${n(D.received)} / ${n(D.called)}`} sub={t('confirmation.fc.recvCalledSub')} />
              <Kpi tone={tone3(pOk, 80, 70)} label={t('confirmation.fc.onTime')} value={pctTxt(pOk)} sub={D.called ? t('confirmation.fc.onTimeSub', { ok: D.onTime, n: D.called }) : t('confirmation.fc.noneCalled')} />
              <Kpi
                tone={med === null ? undefined : med <= fm ? 'ok' : med <= fm * 2 ? 'warn' : 'bad'}
                label={t('confirmation.fc.median')}
                value={med === null ? '—' : dur(med * 60_000)}
                sub={D.called ? t('confirmation.fc.medianSub') : ' '}
              />
              <Kpi tone={tone3(f5, 50, 25)} label={t('confirmation.fc.under5')} value={pctTxt(f5)} sub={D.called ? t('confirmation.fc.under5Sub') : ' '} />
            </div>
          </div>
        </div>
        {D.called > 0 && (
          <div>
            <h3 style={{ margin: '6px 0 8px' }}>{t('confirmation.fc.dist')}</h3>
            <div className="bjfc-dist">
              {BUCKETS.map(([l, c], i) =>
                D.buckets[i] ? (
                  <span key={l} style={{ background: c, flex: D.buckets[i] }} title={`${l} : ${D.buckets[i]}`}>
                    {(D.buckets[i] * 100) / D.called >= 8 ? `${Math.round((D.buckets[i] * 100) / D.called)} %` : ''}
                  </span>
                ) : null,
              )}
            </div>
            <div className="bjfc-lg">
              {BUCKETS.map(([l, c], i) => (
                <span key={l}>
                  <i style={{ background: c }} />
                  {l} · {D.buckets[i]}
                </span>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }
  return (
    <div className="card bjfc">
      <Head title={t('confirmation.fc.title')} help={t('confirmation.fc.help', { first: D?.firstMinutes ?? 15 })}>
        <div className="row">
          <span className="bjfc-live">
            <i />
            {t('confirmation.fc.live')}
          </span>
          <KfBar kf={kf} setKf={setKf} />
        </div>
      </Head>
      {body}
    </div>
  );
}

function DelivBody({ kf, on }: { kf: Kf; on: 'created' | 'confirmed' }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.delivery', { ...kfInput(kf), on }, { refetchInterval: 60_000 });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const D = q.data;
  if (!D) return <Loading />;
  return (
    <div>
      <div className="bjec-sec">
        {t('confirmation.dv.sec')} · {perLabel(t, kf)}
      </div>
      <div className="kpis">
        <Kpi label={t('confirmation.dv.confirmed')} value={n(D.confirmed)} sub={`${t('confirmation.dv.confirmedSub')} · ${da(D.value)}`} />
        <Kpi label={t('confirmation.dv.depot')} value={n(D.depot)} sub={t('confirmation.dv.depotSub')} />
        <Kpi tone={D.route ? 'warn' : undefined} label={t('confirmation.dv.route')} value={n(D.route)} sub={t('confirmation.dv.routeSub')} />
        <Kpi tone="ok" label={t('confirmation.dv.delivered')} value={n(D.delivered)} sub={t('confirmation.dv.deliveredSub', { v: da(D.deliveredValue) })} />
        <Kpi tone={D.back ? 'bad' : undefined} label={t('confirmation.dv.back')} value={n(D.back)} sub={t('confirmation.dv.backSub')} />
        <Kpi tone={tone3(D.rate, 75, 60)} label={t('confirmation.dv.rate')} value={pctTxt(D.rate)} sub={t('confirmation.dv.rateSub')} />
        <Kpi label={t('confirmation.dv.overall')} value={pctTxt(D.overall)} sub={D.cancelledAfter ? t('confirmation.dv.cancelledAfter', { n: D.cancelledAfter }) : t('confirmation.dv.allConfirmed')} />
      </div>
    </div>
  );
}

function PeriodCard({ kf, setKf }: { kf: Kf; setKf: (k: Kf) => void }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.period', kfInput(kf), { refetchInterval: 60_000, enabled: kf.view === 'conf' });
  const D = q.data;
  let body: ReactNode = <Loading />;
  if (kf.view === 'deliv') body = <DelivBody kf={kf} on="created" />;
  else if (q.error) body = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (D)
    body = (
      <div className="kpis">
        <Kpi label={t('confirmation.np.recv')} value={n(D.received)} sub={`${perLabel(t, kf)} · ${da(D.value)}`} />
        <Kpi tone={D.notCalled ? 'warn' : undefined} label={t('confirmation.np.notCalled')} value={n(D.notCalled)} sub={D.notCalledNoAgent ? t('confirmation.fc.noAgent', { n: D.notCalledNoAgent }) : t('confirmation.np.allAgent')} />
        <Kpi label={t('confirmation.np.called')} value={n(D.called)} sub={D.calledPct === null ? ' ' : t('confirmation.np.calledSub', { p: D.calledPct })} />
        <Kpi tone="ok" label={t('confirmation.np.confirmed')} value={n(D.confirmed)} sub={t('confirmation.np.confirmedSub')} />
        <Kpi tone={D.cancelled ? 'bad' : undefined} label={t('confirmation.np.cancelled')} value={n(D.cancelled)} sub={t('confirmation.np.cancelledSub')} />
        <Kpi tone={tone3(D.rate, 60, 40)} label={t('confirmation.np.rate')} value={pctTxt(D.rate)} sub={t('confirmation.np.rateSub')} />
      </div>
    );
  return (
    <div className="card bjkfc bjnew">
      <Head title={t('confirmation.np.title')} help={t('confirmation.np.help')}>
        <KfBar kf={kf} setKf={setKf} />
      </Head>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- Confirmées
function ConfirmedCard({ kf, setKf, bare }: { kf: Kf; setKf: (k: Kf) => void; bare?: boolean }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.confirmed', kfInput(kf), { refetchInterval: 60_000, enabled: kf.view === 'conf' });
  const D = q.data;
  let body: ReactNode = <Loading />;
  if (kf.view === 'deliv') body = <DelivBody kf={kf} on="confirmed" />;
  else if (q.error) body = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (D)
    body = (
      <div>
        <div className="bjec-sec">
          {t('confirmation.cf.sec')} · {perLabel(t, kf)}
        </div>
        <div className="kpis">
          <Kpi tone="ok" label={t('confirmation.cf.confirmed')} value={n(D.confirmed)} sub={t('confirmation.ec.value', { v: da(D.value) })} />
          <Kpi tone={tone3(D.rate, 60, 40)} label={t('confirmation.np.rate')} value={pctTxt(D.rate)} sub={t('confirmation.cf.rateSub', { n: D.cancelled })} />
          <Kpi label={t('confirmation.cf.basket')} value={D.basket === null ? '—' : da(D.basket)} sub={D.itemsPerOrder === null ? ' ' : t('confirmation.cf.basketSub', { n: String(Math.round(D.itemsPerOrder * 10) / 10).replace('.', ',') })} />
          <Kpi label={t('confirmation.cf.lead')} value={D.leadMedianMs === null ? '—' : dur(D.leadMedianMs)} sub={t('confirmation.cf.leadSub')} />
        </div>
        <div className="bjec-sec">{t('confirmation.cf.upsell')}</div>
        <div className="kpis">
          <Kpi label={t('confirmation.cf.upOrders')} value={n(D.upsellOrders)} sub={t('confirmation.cf.upOrdersSub')} />
          <Kpi tone={D.upsellRate === null ? undefined : D.upsellRate >= 20 ? 'ok' : 'warn'} label={t('confirmation.cf.upRate')} value={pctTxt(D.upsellRate)} sub={t('confirmation.cf.upRateSub')} />
          <Kpi tone="ok" label={t('confirmation.cf.upValue')} value={da(D.upsellValue)} sub={t('confirmation.cf.upValueSub')} />
          <Kpi label={t('confirmation.cf.packs')} value={n(D.packs)} sub={t('confirmation.cf.packsSub')} />
        </div>
        <h3>{t('confirmation.byAgent')}</h3>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('confirmation.col.agent')}</th>
                <th className="num">{t('confirmation.cf.confirmed')}</th>
                <th className="num">{t('confirmation.cf.colValue')}</th>
                <th className="num">{t('confirmation.cf.basket')}</th>
                <th className="num">{t('confirmation.cf.colUp')}</th>
                <th className="num">{t('confirmation.cf.colUpRate')}</th>
                <th className="num">{t('confirmation.cf.upValue')}</th>
              </tr>
            </thead>
            <tbody>
              {D.byAgent.length ? (
                D.byAgent.map((a) => {
                  const r = a.n ? Math.round((a.up * 100) / a.n) : 0;
                  return (
                    <tr key={a.agentId ?? 0}>
                      <td data-l={t('confirmation.col.agent')}>
                        <b>{a.name ?? t('confirmation.noAgent')}</b>
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.confirmed')}>
                        {n(a.n)}
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.colValue')}>
                        {da(a.value)}
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.basket')}>
                        {a.n ? da(Math.round(a.value / a.n)) : '—'}
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.colUp')}>
                        {n(a.up)}
                      </td>
                      <td className="num" data-l={t('confirmation.cf.colUpRate')}>
                        <span className={`badge t-${r >= 20 ? 'ok' : r > 0 ? 'warn' : 'off'} ltr`}>{r} %</span>
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.upValue')}>
                        <b>{da(a.upValue)}</b>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="empty">
                    {t('confirmation.cf.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  return (
    <div className="card bjkfc bjcf">
      <Head title={bare ? t('confirmation.cs.detail') : t('confirmation.cf.title')} help={t('confirmation.cf.help')}>
        {!bare && <KfBar kf={kf} setKf={setKf} />}
      </Head>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- « Confirmées »: statistics only
/** One date bar, then L'essentiel (6 numbers), confirmation in detail (upsell, by agent), and what became of the
 * confirmed orders (dépôt, en route, livrées, retours). Same procedures as the foldable blocks. */
export function ConfirmedStatsPage() {
  const { t } = useTranslation();
  const [kf0, setKfState] = useState<Kf>(loadKf);
  const kf: Kf = { ...kf0, view: 'conf' };
  const setKf = (k: Kf) => {
    setKfState(k);
    saveKf(k);
  };
  const cq = useRpc('confirmation.confirmed', kfInput(kf), { refetchInterval: 60_000 });
  const dq = useRpc('confirmation.delivery', { ...kfInput(kf), on: 'confirmed' }, { refetchInterval: 60_000 });
  const C = cq.data;
  const D = dq.data;
  return (
    <div className="px-cs">
      <div className="card bjkfc px-cs-top">
        <Head title={t('confirmation.cs.title')} help={t('confirmation.cs.help')}>
          <KfBar kf={kf} setKf={setKf} noView />
        </Head>
        <div className="bjec-sec">
          {t('confirmation.cs.key')} · {perLabel(t, kf)}
        </div>
        {cq.error ? (
          <ErrorBox error={cq.error} onRetry={() => cq.refetch()} />
        ) : !C ? (
          <Loading />
        ) : (
          <div className="kpis px-cs-key">
            <Kpi tone="ok" label={t('confirmation.cf.confirmed')} value={n(C.confirmed)} sub={t('confirmation.ec.value', { v: da(C.value) })} />
            <Kpi tone={tone3(C.rate, 60, 40)} label={t('confirmation.np.rate')} value={pctTxt(C.rate)} sub={t('confirmation.cf.rateSub', { n: C.cancelled })} />
            <Kpi tone="ok" label={t('confirmation.dv.delivered')} value={D ? n(D.delivered) : '…'} sub={D ? t('confirmation.dv.deliveredSub', { v: da(D.deliveredValue) }) : ' '} />
            <Kpi tone={D ? tone3(D.rate, 75, 60) : undefined} label={t('confirmation.dv.rate')} value={D ? pctTxt(D.rate) : '…'} sub={t('confirmation.dv.rateSub')} />
            <Kpi label={t('confirmation.cf.basket')} value={C.basket === null ? '—' : da(C.basket)} sub={C.itemsPerOrder === null ? ' ' : t('confirmation.cf.basketSub', { n: String(Math.round(C.itemsPerOrder * 10) / 10).replace('.', ',') })} />
            <Kpi tone="ok" label={t('confirmation.cf.upValue')} value={da(C.upsellValue)} sub={t('confirmation.cs.upSub', { p: pctTxt(C.upsellRate), n: C.upsellOrders })} />
          </div>
        )}
      </div>
      <ConfirmedCard kf={kf} setKf={setKf} bare />
      <div className="card bjkfc">
        <Head title={t('confirmation.cs.after')} help={t('confirmation.cs.afterHelp')} />
        <DelivBody kf={kf} on="confirmed" />
      </div>
    </div>
  );
}

