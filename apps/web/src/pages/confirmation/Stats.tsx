// "Statistiques" (foldable) — the KPI blocks of Nouvelles, En cours and Confirmées (managers).
import { Tone } from '@pilotix/shared';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { da, dur, n } from '../../lib/format';
import { ErrorBox, Help, Kpi, Loading } from '../../ui/kit';
import { kfInput, Kf, loadKf, saveKf, Sub } from './shared';
import { useNow } from './Countdown';

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
  if (sub === 'terminees') return null;
  if (sub === 'nouvelles') return <NouvellesStats kf={kf} setKf={setKf} open={open} setOpen={(o) => (setOpen(o), store.set('px-kff', o ? '1' : '0'))} />;
  return (
    <section className={`px-kff ${open ? '' : 'folded'}`}>
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
      <select aria-label={t('common.period')} className="bjkf-sel" value={kf.per} onChange={(e) => set({ per: e.target.value as Kf['per'] })}>
        {(['today', 'yesterday', '7', '30', 'month', 'custom'] as const).map((p) => (
          <option key={p} value={p}>
            {t(`confirmation.per.${p}`)}
          </option>
        ))}
      </select>
      {kf.per === 'custom' && (
        <span className="bjkf-dates">
          <input type="date" value={kf.from} aria-label={t('common.from')} onChange={(e) => set({ from: e.target.value })} />
          <span className="muted">→</span>
          <input type="date" value={kf.to} aria-label={t('common.to')} onChange={(e) => set({ to: e.target.value })} />
        </span>
      )}
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

const perLabel = (t: (k: string) => string, kf: Kf) => (kf.per === 'custom' ? (kf.from === kf.to ? kf.from : `${kf.from} → ${kf.to}`) : t(`confirmation.per.${kf.per}`));

// ---------------------------------------------------------------- Nouvelles: one foldable card
const PERS = ['today', 'yesterday', '7', '30', 'month', 'custom'] as const;

/** Nouvelles › Statistiques: one card with a fold arrow, the date filters under its header, and six numbers. */
function NouvellesStats({ kf, setKf, open, setOpen }: { kf: Kf; setKf: (k: Kf) => void; open: boolean; setOpen: (o: boolean) => void }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.firstCall', kfInput(kf), { refetchInterval: 30_000, enabled: open });
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
            <div className="px-seg" role="group" aria-label={t('common.period')}>
              {PERS.map((p) => (
                <button key={p} type="button" className={kf.per === p ? 'on' : ''} aria-pressed={kf.per === p} onClick={() => set({ per: p })}>
                  {t(`confirmation.per.${p}`)}
                </button>
              ))}
            </div>
            <div className="px-seg" role="group" aria-label={t('confirmation.stats.basis')}>
              {(['created', 'updated'] as const).map((b) => (
                <button key={b} type="button" className={kf.basis === b ? 'on' : ''} aria-pressed={kf.basis === b} onClick={() => set({ basis: b })}>
                  {t(`confirmation.stats.${b}`)}
                </button>
              ))}
            </div>
            {kf.per === 'custom' && (
              <span className="px-st-dates">
                <input type="date" value={kf.from} aria-label={t('common.from')} onChange={(e) => set({ from: e.target.value })} />
                <span className="muted">→</span>
                <input type="date" value={kf.to} aria-label={t('common.to')} onChange={(e) => set({ to: e.target.value })} />
              </span>
            )}
          </div>
          {q.error ? (
            <ErrorBox error={q.error} onRetry={() => q.refetch()} />
          ) : !D ? (
            <Loading />
          ) : (
            <div className="px-st-grid">
              <Kpi
                tone={D.waiting ? 'warn' : 'ok'}
                label={t('confirmation.fc.waiting')}
                value={n(D.waiting)}
                sub={D.waiting ? (D.waitingNoAgent ? t('confirmation.fc.noAgent', { n: D.waitingNoAgent }) : t('confirmation.fc.allAssigned')) : t('confirmation.fc.nobody')}
              />
              <Kpi tone={D.late ? 'bad' : 'ok'} label={t('confirmation.fc.lateNow')} value={n(D.late)} sub={D.late ? t('confirmation.fc.lateSub') : t('confirmation.fc.noLate')} />
              <Kpi
                tone={age === null ? 'ok' : age > fm * 60_000 ? 'bad' : age > fm * 30_000 ? 'warn' : 'ok'}
                label={t('confirmation.fc.oldest')}
                value={age === null ? '—' : dur(age)}
                sub={D.oldest ? `${D.oldest.ref} · ${D.oldest.name}` : t('confirmation.fc.nobody')}
              />
              <Kpi tone={tone3(onTime, 80, 70)} label={t('confirmation.fc.onTime')} value={pctTxt(onTime)} sub={D.called ? t('confirmation.fc.onTimeSub', { ok: D.onTime, n: D.called }) : t('confirmation.fc.noneCalled')} />
              <Kpi
                tone={med === null ? undefined : med <= fm ? 'ok' : med <= fm * 2 ? 'warn' : 'bad'}
                label={t('confirmation.fc.median')}
                value={med === null ? '—' : dur(med * 60_000)}
                sub={D.called ? t('confirmation.fc.medianSub') : perLabel(t, kf)}
              />
              <Kpi tone={tone3(f5, 50, 25)} label={t('confirmation.fc.under5')} value={pctTxt(f5)} sub={D.called ? t('confirmation.fc.under5Sub') : perLabel(t, kf)} />
            </div>
          )}
        </>
      )}
    </section>
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

// ---------------------------------------------------------------- En cours
function EnCoursCard({ kf, setKf }: { kf: Kf; setKf: (k: Kf) => void }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.enCours', kfInput(kf), { refetchInterval: 60_000 });
  const now = useNow();
  const D = q.data;
  let body: ReactNode = <Loading />;
  if (q.error) body = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (D)
    body = (
      <div>
        <div className="bjec-sec">{t('confirmation.fc.now')}</div>
        <div className="kpis">
          <Kpi label={t('confirmation.ec.count')} help={t('confirmation.ec.countHelp')} value={n(D.count)} sub={t('confirmation.ec.value', { v: da(D.value) })} />
          <Kpi tone={D.dueNow ? 'warn' : undefined} label={t('confirmation.ec.due')} help={t('confirmation.ec.dueHelp')} value={n(D.dueNow)} sub={t('confirmation.ec.dueSub')} />
          <Kpi
            tone={D.late ? 'bad' : undefined}
            label={t('confirmation.ec.late')}
            help={t('confirmation.ec.lateHelp')}
            value={n(D.late)}
            sub={D.lateOldest ? t('confirmation.ec.lateSub', { d: dur(now - Date.parse(D.lateOldest.since)), ref: D.lateOldest.ref }) : t('confirmation.ec.lateNone')}
          />
          <Kpi
            label={t('confirmation.ec.later')}
            help={t('confirmation.ec.laterHelp')}
            value={n(D.later)}
            sub={D.nextLater ? t('confirmation.ec.laterSub', { d: dur(Date.parse(D.nextLater.at) - now), ref: D.nextLater.ref }) : t('confirmation.ec.laterNone')}
          />
          <Kpi tone={D.noAgent ? 'bad' : undefined} label={t('confirmation.ec.noAgent')} help={t('confirmation.ec.noAgentHelp')} value={n(D.noAgent)} sub={t('confirmation.ec.noAgentSub')} />
        </div>
        <div className="bjec-sec">
          {t('confirmation.ec.quality')} · {perLabel(t, kf)}
        </div>
        <div className="kpis">
          <Kpi label={t('confirmation.ec.avg')} help={t('confirmation.ec.avgHelp')} value={D.avgAttempts === null ? '—' : String(Math.round(D.avgAttempts * 10) / 10).replace('.', ',')} sub={t('confirmation.ec.avgSub')} />
          <Kpi tone={D.many ? 'bad' : undefined} label={t('confirmation.ec.many')} help={t('confirmation.ec.manyHelp')} value={n(D.many)} sub={t('confirmation.ec.manySub')} />
          <Kpi tone={D.old ? 'warn' : undefined} label={t('confirmation.ec.old')} help={t('confirmation.ec.oldHelp')} value={n(D.old)} sub={t('confirmation.ec.oldSub')} />
          <Kpi tone="ok" label={t('confirmation.ec.recovered')} value={n(D.recovered)} sub={t('confirmation.ec.recoveredSub')} />
          <Kpi tone={tone3(D.recoveryRate, 60, 40)} label={t('confirmation.ec.rate')} help={t('confirmation.ec.rateHelp')} value={pctTxt(D.recoveryRate)} sub={t('confirmation.ec.rateSub', { r: D.recovered, l: D.lost })} />
        </div>
        <div className="bjec-chips">
          {(['no_answer', 'busy', 'callback', 'postponed'] as const).map((k) => (
            <span key={k} className="chip">
              {t(`confirmation.ec.st.${k}`)} · {n(D.byStatus[k] ?? 0)}
            </span>
          ))}
        </div>
        <h3>{t('confirmation.byAgent')}</h3>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('confirmation.col.agent')}</th>
                <th className="num">{t('confirmation.ec.count')}</th>
                <th className="num">{t('confirmation.ec.colDue')}</th>
                <th className="num">{t('confirmation.ec.late')}</th>
                <th className="num">{t('confirmation.ec.colMany')}</th>
              </tr>
            </thead>
            <tbody>
              {D.byAgent.length ? (
                D.byAgent.map((a) => (
                  <tr key={a.agentId ?? 0} className={a.agentId ? undefined : 'warn-row'}>
                    <td data-l={t('confirmation.col.agent')}>
                      <b>{a.name ?? t('confirmation.noAgent')}</b>
                    </td>
                    <td className="num ltr" data-l={t('confirmation.ec.count')}>
                      {n(a.n)}
                    </td>
                    <td className="num ltr" data-l={t('confirmation.ec.colDue')}>
                      {n(a.due)}
                    </td>
                    <td className="num ltr" data-l={t('confirmation.ec.late')}>
                      {a.late ? <b className="stock-low">{n(a.late)}</b> : '0'}
                    </td>
                    <td className="num ltr" data-l={t('confirmation.ec.colMany')}>
                      {n(a.many)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="empty">
                    {t('confirmation.ec.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  return (
    <div className="card bjkfc bjec">
      <Head title={t('confirmation.ec.title')} help={t('confirmation.ec.help')}>
        <KfBar kf={kf} setKf={setKf} />
      </Head>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- Confirmées
function ConfirmedCard({ kf, setKf }: { kf: Kf; setKf: (k: Kf) => void }) {
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
      <Head title={t('confirmation.cf.title')} help={t('confirmation.cf.help')}>
        <KfBar kf={kf} setKf={setKf} />
      </Head>
      {body}
    </div>
  );
}

