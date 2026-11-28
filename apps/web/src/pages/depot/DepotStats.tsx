// Dépôt › Statistiques (the owner's design, agreed 28 Nov 2026: the PDF « Dépôt — Statistiques »): the whole depot on
// one page — the orders sent, the median time from reaching the depot to leaving it, the late ones, the errors (the main
// card) and what they cost, the errors by type, each person. A tap: « En retard » opens its list here; « Erreurs »,
// « Coût des erreurs », a type or a person open « Erreurs de livraison » with the same filters (goErrors below).
// Only the depot's managers (Management › Alertes dépôt), the administrators and the seller see it (core: faults.ts).
import type { FaultReason } from '@pilotix/shared';
import { KeyboardEvent, ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, da, dur, n, pct } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { ErrorBox, Help, Loading } from '../../ui/kit';
import { DateRange } from '../confirmation/DateRange';
import type { Kf } from '../confirmation/shared';
import '../confirmation/confirmation.css';

/** The filters, shared with « Erreurs de livraison »: the period is kept on this device, the agent and product are not. */
export interface DepotF {
  per: Kf['per'];
  from: string;
  to: string;
  agent: number | null;
  product: number | null;
}
const algDay = () => new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
export const loadDepotF = (): DepotF => {
  const k = store.json<Partial<DepotF>>('depot-sx', {});
  return { per: k.per ?? '30', from: k.from ?? algDay(), to: k.to ?? algDay(), agent: null, product: null };
};
export const saveDepotF = (f: DepotF) => store.set('depot-sx', JSON.stringify({ per: f.per, from: f.from, to: f.to }));
export const depotIn = (f: DepotF) => ({
  per: f.per,
  ...(f.per === 'custom' ? { from: f.from, to: f.to } : {}),
  ...(f.agent ? { agent: f.agent } : {}),
  ...(f.product ? { product: f.product } : {}),
});

/** What a tap from Statistiques hands to « Erreurs de livraison » (read once there, with « ‹ Statistiques »). */
export interface DepotTap {
  agent?: number | null;
  product?: number | null;
  reason?: FaultReason | null;
  none?: boolean;
}
export const takeDepotTap = (): DepotTap | null => {
  const x = store.json<DepotTap | null>('depot-sx-tap', null);
  store.set('depot-sx-tap', null);
  return x;
};
function goErrors(f: DepotF, x: DepotTap) {
  store.set('depot-sx-tap', JSON.stringify({ agent: x.none ? null : x.agent ?? f.agent, product: f.product, reason: x.reason ?? null, none: !!x.none }));
  location.hash = '#/depot/erreurs';
}

/** Enter or space on a line or a card that opens something. */
const onKey = (go: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    go();
  }
};

/** The filter pills: dates (a period or « Personnalisé »), then the agent and the product when their choices are there. */
export function DepotFilters({ f, setF, agents, products }: { f: DepotF; setF: (p: Partial<DepotF>) => void; agents?: { id: number; name: string }[] | null; products?: { id: number; name: string }[] | null }) {
  const { t } = useTranslation();
  const kf: Kf = { per: f.per, basis: 'created', from: f.from, to: f.to, view: 'conf' };
  return (
    <div className="px-sx-fb">
      <DateRange custom kf={kf} onChange={(p) => setF({ per: p.per, from: p.from, to: p.to })} />
      {agents && (agents.length > 0 || f.agent) && (
        <select aria-label={t('depot.sx.agent')} className="px-sx-pill ag" value={f.agent ?? ''} onChange={(e) => setF({ agent: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('depot.sx.agentAll')}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      {products && (
        <select aria-label={t('depot.sx.product')} className="px-sx-pill" value={f.product ?? ''} onChange={(e) => setF({ product: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('depot.sx.productAll')}</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** A card, as Confirmation's: its « ? », and a › when a tap opens its list. */
function Tile({ label, help, value, gl, main, warn, onTap }: { label: string; help: string; value: string; gl: string; main?: boolean; warn?: boolean; onTap?: () => void }) {
  return (
    <div
      className={`px-sx-tile${main ? ' main' : ''}${warn ? ' warn' : ''}${onTap ? ' tap' : ''}`}
      {...(onTap ? { role: 'button', tabIndex: 0, onClick: onTap, onKeyDown: onKey(onTap) } : {})}
    >
      <div className="lb">
        {label}
        <Help text={help} label={label} />
      </div>
      <div className="v ltr">{value}</div>
      <div className="gl">
        {gl}
        {onTap && <span aria-hidden="true"> ›</span>}
      </div>
    </div>
  );
}

export function DepotStats() {
  const { t } = useTranslation();
  const [f, setF0] = useState<DepotF>(loadDepotF);
  const [late, setLate] = useState(false);
  const setF = (p: Partial<DepotF>) =>
    setF0((x) => {
      const nx = { ...x, ...p };
      saveDepotF(nx);
      return nx;
    });
  const q = useRpc('depot.stats', depotIn(f), { refetchInterval: 120_000 });
  const D = q.data;
  return (
    <section className="card px-st px-cf px-ds">
      <div className="px-sx">
        <DepotFilters f={f} setF={setF} agents={D?.agents} products={D?.products} />
        {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !D ? <Loading /> : late ? <LateList f={f} onBack={() => setLate(false)} /> : <Body D={D} f={f} onLate={() => setLate(true)} />}
      </div>
    </section>
  );
}

type Ds = NonNullable<ReturnType<typeof useDs>['data']>;
const useDs = (f: DepotF) => useRpc('depot.stats', depotIn(f));

function Body({ D, f, onLate }: { D: Ds; f: DepotF; onLate: () => void }) {
  const { t } = useTranslation();
  const rate = D.sent ? D.errors / D.sent : null;
  const toErrors = D.errors ? () => goErrors(f, {}) : undefined;
  return (
    <>
      <div className="px-sx-t6">
        <Tile label={t('depot.sx.sent')} help={t('depot.sx.hSent')} value={n(D.sent)} gl={t('depot.sx.sentSub')} />
        <Tile label={t('depot.sx.delay')} help={t('depot.sx.hDelay')} value={D.medianMs === null ? '—' : dur(D.medianMs)} gl={t('depot.sx.delaySub')} />
        <Tile warn={D.late > 0} label={t('depot.sx.late')} help={t('depot.sx.hLate')} value={pct(D.sent ? D.late / D.sent : null)} gl={t('depot.sx.lateSub', { count: D.late })} onTap={D.late ? onLate : undefined} />
        <Tile main label={t('depot.sx.errors')} help={t('depot.sx.hErrors')} value={pct(rate, 1)} gl={t('depot.sx.errorsSub', { n: n(D.errors), of: n(D.sent) })} onTap={toErrors} />
        <Tile label={t('depot.sx.cost')} help={t('depot.sx.hCost')} value={da(D.cost)} gl={t('depot.sx.costSub')} onTap={toErrors} />
      </div>
      <div className="px-sx-sec">
        {t('depot.sx.types')}
        <Help text={t('depot.sx.hTypes')} label={t('depot.sx.types')} />
      </div>
      {D.reasons.length ? (
        <div className="px-sx-rs">
          {D.reasons.map((r) => {
            const p = Math.round((r.n / D.errors) * 100);
            const go = () => goErrors(f, { reason: r.reason });
            return (
              <div key={r.reason} className="px-sx-rs-row tap" role="button" tabIndex={0} onClick={go} onKeyDown={onKey(go)}>
                <span>{t(`faults.reason.${r.reason}`)}</span>
                <div className="bk">
                  <div style={{ width: `${p}%` }} />
                </div>
                <span className="pc ltr">{p} %</span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="px-sx-empty">{t('depot.sx.noErrors')}</p>
      )}
      <People D={D} f={f} rate={rate} />
    </>
  );
}

/** Each person: the orders he prepared that left in the period, his errors, his rate (red: above the depot's, from 2
 *  errors); « Sans nom »; the whole depot. A line with errors opens them. */
function People({ D, f, rate }: { D: Ds; f: DepotF; rate: number | null }) {
  const { t } = useTranslation();
  const head = (k: 'cPrepared' | 'cErrors' | 'cRate') => t(`depot.sx.${k}`);
  // « Sans nom » has no rate: its orders and its errors are not one person's
  const line = (key: string, name: ReactNode, prepared: number | null, errors: number, x: DepotTap, few = false) => {
    const r = prepared && !few ? errors / prepared : null;
    const bad = r !== null && rate !== null && errors >= 2 && r > rate;
    const go = errors ? () => goErrors(f, x) : undefined;
    return (
      <tr key={key} className={`${go ? 'go' : ''}${few ? ' few' : ''}`} {...(go ? { onClick: go, tabIndex: 0, onKeyDown: onKey(go) } : {})}>
        <td data-l={t('depot.sx.cAgent')}>{name}</td>
        <td className="num ltr" data-l={head('cPrepared')}>
          {prepared ? n(prepared) : '—'}
        </td>
        <td className="num ltr" data-l={head('cErrors')}>
          {n(errors)}
        </td>
        <td className={`num ltr${bad ? ' bad' : ''}`} data-l={head('cRate')}>
          {r === null ? '—' : pct(r, 1)}
        </td>
        <td className="go" aria-hidden="true">
          {go ? '›' : ''}
        </td>
      </tr>
    );
  };
  return (
    <>
      <div className="px-sx-sec row">
        <span>{t('depot.sx.byAgent')}</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl px-sx-tbl">
          <thead>
            <tr>
              <th>{t('depot.sx.cAgent')}</th>
              <th className="num">{head('cPrepared')}</th>
              <th className="num">{head('cErrors')}</th>
              <th className="num">
                {head('cRate')}
                <Help text={t('depot.sx.hRate')} label={head('cRate')} />
              </th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {D.people.map((p) => line(String(p.id), p.name, p.prepared, p.errors, { agent: p.id }))}
            {D.none &&
              line(
                'none',
                <>
                  {t('depot.sx.noName')} <Help text={t('depot.sx.hNoName')} label={t('depot.sx.noName')} />
                </>,
                D.none.prepared,
                D.none.errors,
                { none: true },
                true,
              )}
            {!f.agent && (
              <tr className="tot">
                <td data-l={t('depot.sx.cAgent')}>{t('depot.sx.total')}</td>
                <td className="num ltr" data-l={head('cPrepared')}>
                  {n(D.sent)}
                </td>
                <td className="num ltr" data-l={head('cErrors')}>
                  {n(D.errors)}
                </td>
                <td className="num ltr" data-l={head('cRate')}>
                  {pct(rate, 1)}
                </td>
                <td className="go" aria-hidden="true" />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

const dayClock = (iso: string, lang: string) =>
  `${new Intl.DateTimeFormat(lang === 'ar' ? 'ar-DZ' : lang === 'en' ? 'en-GB' : 'fr-FR', { timeZone: 'Africa/Algiers', day: 'numeric', month: 'short', numberingSystem: 'latn' }).format(Date.parse(iso))} ${clock(iso)}`;

/** « En retard »: the orders sent more than 48 h after reaching the depot, the slowest first; a line opens the order. */
function LateList({ f, onBack }: { f: DepotF; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const q = useRpc('depot.late', depotIn(f));
  const head = (k: 'cOrder' | 'cClient' | 'cStart' | 'cSent' | 'cDelay' | 'cBy') => t(`depot.sx.${k}`);
  const L = q.data;
  return (
    <>
      <div className="px-sx-sec first">
        <button type="button" className="px-sx-back" onClick={onBack}>
          ‹ {t('depot.sx.back')}
        </button>
        {L && <span>{t('depot.sx.lateTitle', { count: L.total })}</span>}
      </div>
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !L ? (
        <Loading />
      ) : !L.rows.length ? (
        <p className="px-sx-empty">{t('depot.sx.noLate')}</p>
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl px-ov-tbl px-sx-tbl">
              <thead>
                <tr>
                  <th>{head('cOrder')}</th>
                  <th>{head('cClient')}</th>
                  <th>{head('cStart')}</th>
                  <th>{head('cSent')}</th>
                  <th className="num">{head('cDelay')}</th>
                  <th>{head('cBy')}</th>
                  <th aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {L.rows.map((r) => {
                  const go = () => openOrder(r.orderId);
                  return (
                    <tr key={r.orderId} className="go" onClick={go} tabIndex={0} onKeyDown={onKey(go)}>
                      <td className="ltr" data-l={head('cOrder')}>
                        {r.ref}
                      </td>
                      <td data-l={head('cClient')}>{r.customer || '—'}</td>
                      <td data-l={head('cStart')}>{dayClock(r.start, i18n.language)}</td>
                      <td data-l={head('cSent')}>{dayClock(r.sent, i18n.language)}</td>
                      <td className="num ltr bad" data-l={head('cDelay')}>
                        {dur(r.wait)}
                      </td>
                      <td data-l={head('cBy')}>{r.by ?? t('depot.sx.noName')}</td>
                      <td className="go" aria-hidden="true">
                        ›
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {L.total > L.rows.length && <p className="px-sx-empty">{t('depot.sx.more', { n: n(L.rows.length), of: n(L.total) })}</p>}
        </>
      )}
    </>
  );
}
