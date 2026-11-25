// Suivi · « Clair » (the owner's design 1, 25 Nov 2026): the four lists of the alert bar — Nouvelles alertes, En cours,
// Résolu, Swap — one line per parcel with its company's small icon, the company's status in colour (a tap opens the
// history), three counters on top that are filters too, buttons only when there is something to do, and the alert
// opened like Confirmation's order: « Statut » (Pas de réponse, Occupé, Rappel, Réclamation, Client annule) and
// « Relivrer ». Résolu fills itself when the company delivers (no button); a cancelled alert goes to Swap.
import type { Order } from '@pilotix/shared';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, when, wilayaName } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { Empty, Icon } from '../../ui/kit';
import { Sheet } from '../../ui/Sheet';
import { AskCall, AskMsg, HistoryButton } from '../confirmation/History';
import { rpc } from '../../lib/backend';
import { useQueryClient } from '@tanstack/react-query';
import { eventText } from '../orders/OrderCard';
import { AlertTodo, CoBadge, Journey, tipKey, type PExtra } from './PhoneSuivi';
import { namesOf, variantsOf } from '../../lib/items';
import './clair.css';

export const CLAIR_TABS = ['alertes_new', 'alertes_encours', 'resolus', 'swap'] as const;
export type ClairTab = (typeof CLAIR_TABS)[number];
export const isClairTab = (t: string): t is ClairTab => (CLAIR_TABS as readonly string[]).includes(t);
/** the three counters of each list, in order ('all': the whole list) */
export const CLAIR_BUCKETS: Record<ClairTab, readonly string[]> = {
  alertes_new: ['late', 'soon', 'ok'],
  alertes_encours: ['call', 'later', 'zr'],
  resolus: ['today', 'yesterday', 'all'],
  swap: ['client', 'zr', 'all'],
};
const TONE: Record<ClairTab, Record<string, string>> = {
  alertes_new: { late: 'late', soon: 'soon', ok: 'ok' },
  alertes_encours: { call: 'late', later: 'soon', zr: 'off' },
  resolus: { today: 'ok', yesterday: 'ok', all: 'off' },
  swap: { client: 'late', zr: 'late', all: 'off' },
};

export type ClairX = PExtra & {
  last?: { key: 'no_answer' | 'busy' | 'called' | 'callback' | 'relivrer' | 'claim' | 'lost'; at: string; note: string | null } | null;
  callbackAt?: string | null;
  savedBy?: string | null;
  cancelBy?: 'client' | 'zr' | null;
  bucket?: string;
};
export type ClairRow = Order & { seller?: { id: number; name: string } };
export type StatusKey = 'no_answer' | 'busy' | 'callback' | 'claim' | 'cancel';

/** The three counters over a list: a tap shows only those parcels, a second tap (or « Tous ») all of them. */
export function ClairCounters({ tab, counts, value, onPick }: { tab: ClairTab; counts?: Record<string, number> | null; value: string | null; onPick: (k: string | null) => void }) {
  const { t } = useTranslation();
  return (
    <div className="svk" role="group" aria-label={t('suivi.clair.counters')}>
      {CLAIR_BUCKETS[tab].map((k) => {
        const on = value === k || (k === 'all' && !value);
        return (
          <button key={k} type="button" className={`svk-c t-${TONE[tab][k]}${on && value ? ' on' : ''}`} aria-pressed={!!value && value === k} onClick={() => onPick(k === 'all' || value === k ? null : k)}>
            <b className="ltr">{counts ? counts[k] ?? 0 : '—'}</b>
            <small>{t(`suivi.clair.k.${tab}.${k}`)}</small>
          </button>
        );
      })}
    </div>
  );
}

/** The company's words in colour: blue on its way, orange postponed, red a real problem. */
export function zrTone(text: string | null): 'blue' | 'orange' | 'red' {
  const r = (text ?? '').toLowerCase();
  if (/report|demain|nouvelle date|programm/.test(r)) return 'orange';
  if (/erron|faux|fausse|incorrect|invalide|mauvais|injoign|r[ée]pond|absent|refus|annul|ferm|[ée]teint|introuvable|desservi|probl|endommag|perdu|retour|wrong|cancel/.test(r)) return 'red';
  return 'blue';
}

/** « ● Numéro erroné »: the company's status, a tap opens the parcel's history (company and Pilotix, newest first). */
export function ZrStatus({ o, text }: { o: Order; text: string | null }) {
  const { t } = useTranslation();
  const v = text || t('suivi.clair.noNews');
  return (
    <HistoryButton orderId={o.id} refLabel={o.ref} className={`svc-zr z-${zrTone(text)}`} title={t('suivi.clair.histOf', { ref: o.ref })}>
      <i aria-hidden="true" />
      <span>{v}</span>
      <Icon name="history" />
    </HistoryButton>
  );
}

/** The company's words with its name in front, once (« ZR : Commande annulée », never « ZR : ZR : … »). */
function coSays(t: (k: string, o?: Record<string, unknown>) => string, o: Order, v: string) {
  return /^[A-Za-zÀ-ÿ]{2,12}\s?:/.test(v) ? v : t('suivi.clair.zrSays', { co: o.companyName || o.livreurName || t('suivi.zr'), v });
}

/** Nothing in the tab; « Résolu » still says how it fills (the owner: nothing to do there). */
function ClairEmpty({ tab }: { tab: ClairTab }) {
  const { t } = useTranslation();
  return (
    <>
      <Empty>{t(`suivi.clair.empty.${tab}`)}</Empty>
      {tab === 'resolus' && (
        <p className="svc-note">
          <Icon name="info" /> {t('suivi.clair.resolvedNote')}
        </p>
      )}
    </>
  );
}

/** The calls on an alert in dots, then « 2/6 » (Préférences › Appels du Suivi). */
export function CallDots({ tr }: { tr?: { done: number; need: number } | null }) {
  const { t } = useTranslation();
  if (!tr) return <span className="muted">—</span>;
  return (
    <span className="svc-dots" title={t('suivi.tries.count', { done: tr.done, need: tr.need })}>
      {Array.from({ length: tr.need }, (_, k) => (
        <i key={k} className={k < tr.done ? 'on' : ''} />
      ))}
      <small className="ltr">
        {tr.done}/{tr.need}
      </small>
    </span>
  );
}

const fmtMin = (t: (k: string, o?: any) => string, m: number) => (m >= 60 ? t('suivi.clock.h', { h: Math.floor(m / 60), m: String(Math.round(m % 60)).padStart(2, '0') }) : t('suivi.clock.m', { m: Math.max(1, Math.round(m)) }));
/** « +2 h 02 » late (red), « 23 min » left: the alert's clock in working time. */
function ClockText({ x }: { x?: ClairX }) {
  const { t } = useTranslation();
  const c = x?.clock;
  if (!c) return <span className="muted">—</span>;
  const m = Math.abs(c.left);
  // dir auto, not ltr: Arabic « 52 سا 54 » keeps its order (ltr showed « 52 54 سا »)
  return (
    <b className={`svc-clk ${c.state}`} dir="auto">
      {c.state === 'late' ? `+${fmtMin(t, m)}` : fmtMin(t, m)}
    </b>
  );
}
/** « 2 h », « 1 j » since a moment. */
function sinceText(t: (k: string, o?: any) => string, iso: string | null | undefined) {
  if (!iso) return '—';
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  if (m < 60) return t('suivi.clock.m', { m: Math.max(1, Math.round(m)) });
  if (m < 24 * 60) return t('suivi.clair.hours', { n: Math.floor(m / 60) });
  return t('suivi.clair.days', { n: Math.floor(m / 1440) });
}
/** « 14:30 » today, « 26/11 14:30 » another day. */
function hm(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return `${same ? '' : `${p(d.getDate())}/${p(d.getMonth() + 1)} `}${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Résolu › « Livré »: « 10:12 » today, « Hier », else « 23/11 ». */
function deliveredText(t: (k: string) => string, iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === today.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('suivi.clair.yesterday');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
}

/** En cours › « Dernier résultat »: what was done last, in colour. */
function LastResult({ x }: { x?: ClairX }) {
  const { t } = useTranslation();
  const l = x?.last;
  if (!l) return <span className="muted">—</span>;
  const tone = l.key === 'no_answer' || l.key === 'busy' || l.key === 'lost' ? 'orange' : l.key === 'relivrer' || l.key === 'claim' ? 'green' : 'blue';
  const day = l.key === 'relivrer' ? (hm(l.at).split(' ')[0].includes('/') ? hm(l.at).split(' ')[0] : t('suivi.clair.today')) : l.key === 'callback' && x?.callbackAt ? hm(x.callbackAt) : '';
  // the day goes under the words when the column is narrow (tablet), never « Relivrer / demandé / 24/11 »
  return (
    <span className={`svc-last z-${tone}`}>
      <i aria-hidden="true" />
      <span>{t(`suivi.clair.last.${l.key}`)}</span>
      {day && <small dir="auto">{day}</small>}
    </span>
  );
}

/** What the company asks to fix (a wrong number, a wrong commune): the third button of a line. */
export function fixOf(reason: string | null): 'number' | 'commune' | null {
  const k = tipKey(reason);
  return k === 'number' ? 'number' : k === 'zone' ? 'commune' : null;
}

export interface ClairHandlers {
  onOpen: (o: ClairRow) => void;
  onSwap: (o: ClairRow) => void;
  canSwap: (o: ClairRow) => boolean;
  canWork: (o: ClairRow) => boolean;
}

/** Call and WhatsApp, round (they ask how, like Confirmation; a call is written on the order). */
export function CallMsg({ o }: { o: Order }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  if (o.phoneHidden) return null;
  return (
    <span className="svc-cm" onClick={(e) => e.stopPropagation()}>
      <AskCall phone={o.phone} className="svc-ib call" label={`${t('suivi.act.call')} ${o.customerName} ${o.phone}`} onCall={() => rpc('orders.logCall', { id: o.id }).then(() => qc.invalidateQueries(), () => {})}>
        <Icon name="phone" />
      </AskCall>
      <AskMsg order={o} ready={t('suivi.ph.waText', { nom: o.customerName, ref: o.ref })} className="svc-ib wa" label={`${t('suivi.ph.message')} ${o.phone}`}>
        <Icon name="message" />
      </AskMsg>
    </span>
  );
}

/** The table of the four lists (tablet, computer); a line opens under itself (`open` draws it). */
export function ClairTable({ tab, rows, extra, reasonOf, openKey, open, h }: { tab: ClairTab; rows: ClairRow[]; extra: Record<number, ClairX>; reasonOf: (o: Order, x?: ClairX) => string | null; openKey: string | null; open: (o: ClairRow) => ReactNode; h: ClairHandlers }) {
  const { t } = useTranslation();
  if (!rows.length) return <ClairEmpty tab={tab} />;
  const key = (o: ClairRow) => `${o.seller?.id ?? 0}:${o.id}`;
  const cols: { k: string; l: string; cls?: string }[] =
    tab === 'alertes_new'
      ? [{ k: 'order', l: t('suivi.col.order') }, { k: 'client', l: t('suivi.col.client') }, { k: 'wilaya', l: t('suivi.col.wilaya'), cls: 'svc-hide-tb' }, { k: 'product', l: t('suivi.col.products'), cls: 'svc-hide-tb' }, { k: 'amount', l: t('suivi.clair.amount'), cls: 'num svc-hide-tb' }, { k: 'zr', l: t('suivi.clair.zr') }, { k: 'time', l: t('suivi.clair.time'), cls: 'num' }, { k: 'act', l: '' }]
      : tab === 'alertes_encours'
        ? [{ k: 'order', l: t('suivi.col.order') }, { k: 'client', l: t('suivi.col.client') }, { k: 'zr', l: t('suivi.clair.zr') }, { k: 'last', l: t('suivi.clair.lastCol') }, { k: 'calls', l: t('suivi.clair.calls') }, { k: 'since', l: t('suivi.clair.since'), cls: 'num svc-hide-tb' }, { k: 'act', l: '' }]
        : tab === 'resolus'
          ? [{ k: 'order', l: t('suivi.col.order') }, { k: 'client', l: t('suivi.col.client') }, { k: 'product', l: t('suivi.col.products'), cls: 'svc-hide-tb' }, { k: 'amount', l: t('suivi.clair.amount'), cls: 'num' }, { k: 'delivered', l: t('suivi.clair.delivered') }, { k: 'saved', l: t('suivi.clair.savedBy') }, { k: 'problem', l: t('suivi.clair.problem'), cls: 'svc-hide-tb' }]
          : [{ k: 'order', l: t('suivi.col.order') }, { k: 'client', l: t('suivi.col.client') }, { k: 'product', l: t('suivi.col.products'), cls: 'svc-hide-tb' }, { k: 'amount', l: t('suivi.clair.amount'), cls: 'num' }, { k: 'why', l: t('suivi.clair.why') }, { k: 'since', l: t('suivi.clair.since'), cls: 'num svc-hide-tb' }, { k: 'act', l: '' }];
  const opens = tab === 'alertes_new' || tab === 'alertes_encours';
  const cell = (o: ClairRow, k: string): ReactNode => {
    const x = extra[o.id];
    const reason = reasonOf(o, x);
    switch (k) {
      case 'order':
        return (
          <span className="svc-ord">
            {opens && (
              <span className={`svc-chev${openKey === key(o) ? ' on' : ''}`} aria-hidden="true">
                <Icon name="chevron" />
              </span>
            )}
            <b className="ltr">{o.ref}</b>
            {o.seller && <small>{o.seller.name}</small>}
          </span>
        );
      case 'client':
        return (
          <span className="svc-cli">
            <CoBadge o={o} x={x} />
            <b>{o.customerName}</b>
          </span>
        );
      case 'wilaya':
        return wilayaName(o.wilayaId);
      case 'product':
        return <span className="svc-clamp">{namesOf(o.items)}</span>;
      case 'amount':
        return <span className="ltr">{da(o.total)}</span>;
      case 'zr': {
        const fx = tab === 'alertes_new' ? fixOf(reason) : null;
        return (
          <span className="svc-zrc">
            <ZrStatus o={o} text={reason} />
            {fx && h.canWork(o) && (
              <button type="button" className="svc-fixb" onClick={(e) => (e.stopPropagation(), h.onOpen(o))}>
                <Icon name="pencil" /> {t(`suivi.clair.fix.${fx}`)}
              </button>
            )}
          </span>
        );
      }
      case 'time':
        return <ClockText x={x} />;
      case 'last':
        return <LastResult x={x} />;
      case 'calls':
        return <CallDots tr={x?.tries} />;
      case 'since':
        return (
          <span className="muted" dir="auto">
            {sinceText(t, tab === 'swap' ? o.updatedAt : x?.last?.at ?? o.updatedAt)}
          </span>
        );
      case 'delivered':
        return (
          <span className="svc-dlv">
            <Icon name="checkcircle" /> <span dir="auto">{deliveredText(t, o.deliveredAt)}</span>
          </span>
        );
      case 'saved':
        return x?.savedBy ? (
          <span className="svc-who">
            <i aria-hidden="true">{x.savedBy.slice(0, 1).toUpperCase()}</i>
            {x.savedBy}
          </span>
        ) : (
          <span className="muted">—</span>
        );
      case 'problem':
        return <span className="svc-clamp muted">{x?.alertReason || reason || '—'}</span>;
      case 'why':
        return (
          <span className="svc-last z-red">
            <i aria-hidden="true" />
            {x?.cancelBy === 'client' ? t('suivi.clair.cancelClient') : coSays(t, o, reason || t('suivi.clair.cancelled'))}
          </span>
        );
      case 'act':
        if (tab === 'swap') return h.canSwap(o) ? <SwapBtn onClick={() => h.onSwap(o)} /> : null;
        if (tab === 'alertes_encours' && x?.bucket === 'zr')
          return (
            <span className="svc-wait" title={t('suivi.clair.waitZr', { co: o.companyName || t('suivi.zr') })}>
              <Icon name="hourglass" /> <span className="svc-wl">{t('suivi.clair.waitZr', { co: o.companyName || t('suivi.zr') })}</span>
              <span className="svc-ws">{t('suivi.clair.waitZrShort')}</span>
            </span>
          );
        if (tab === 'alertes_encours' && x?.bucket === 'later' && x.callbackAt)
          return (
            <span className="svc-wait t">
              <Icon name="clock" /> <span className="ltr">{hm(x.callbackAt)}</span>
            </span>
          );
        return (
          <span className="svc-acts">
            {tab === 'alertes_encours' && <b className="svc-recall">{t('suivi.clair.recall')}</b>}
            <CallMsg o={o} />
          </span>
        );
    }
    return null;
  };
  return (
    <div className="tbl-wrap svc-wrap">
      <table className={`tbl svc-tbl svt-${tab}`}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.k} className={`svc-c-${c.k} ${c.cls ?? ''}`}>
                {c.l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const on = openKey === key(o);
            return (
              <Fragment key={key(o)}>
                <tr className={`clickable${on ? ' svc-on' : ''}`} onClick={() => h.onOpen(o)}>
                  {cols.map((c) => (
                    <td key={c.k} className={`svc-c-${c.k} ${c.cls ?? ''}`} data-l={c.l}>
                      {cell(o, c.k)}
                    </td>
                  ))}
                </tr>
                {on && (
                  <tr className="svc-open">
                    <td colSpan={cols.length}>
                      {/* width 0 + min-width 100 %: the opened alert fills the row without moving the columns */}
                      <div className="svc-openin">{open(o)}</div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {tab === 'resolus' && (
        <p className="svc-note">
          <Icon name="info" /> {t('suivi.clair.resolvedNote')}
        </p>
      )}
    </div>
  );
}

function SwapBtn({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="svc-swap" onClick={(e) => (e.stopPropagation(), onClick())}>
      <Icon name="swap" /> {t('suivi.clair.tab.swap')}
    </button>
  );
}

/** The phone's lines: a card each, the buttons on the right. */
export function ClairCards({ tab, rows, extra, reasonOf, h }: { tab: ClairTab; rows: ClairRow[]; extra: Record<number, ClairX>; reasonOf: (o: Order, x?: ClairX) => string | null; h: ClairHandlers }) {
  const { t } = useTranslation();
  if (!rows.length) return <ClairEmpty tab={tab} />;
  return (
    <ul className={`svc-cards svt-${tab}`}>
      {rows.map((o) => {
        const x = extra[o.id];
        const reason = reasonOf(o, x);
        const fx = tab === 'alertes_new' ? fixOf(reason) : null;
        const right =
          tab === 'swap' ? (
            h.canSwap(o) ? <SwapBtn onClick={() => h.onSwap(o)} /> : null
          ) : tab === 'resolus' ? null : tab === 'alertes_encours' && x?.bucket === 'zr' ? (
            <span className="svc-wait">
              <Icon name="hourglass" /> {t('suivi.clair.waitZrShort')}
            </span>
          ) : tab === 'alertes_encours' && x?.bucket === 'later' && x.callbackAt ? (
            <span className="svc-wait t">
              <Icon name="clock" /> <span className="ltr">{hm(x.callbackAt)}</span>
            </span>
          ) : (
            <CallMsg o={o} />
          );
        return (
          <li key={`${o.seller?.id ?? 0}:${o.id}`} className="svc-card" onClick={() => h.onOpen(o)}>
            <div className="svc-card-m">
              <div className="svc-card-t">
                <CoBadge o={o} x={x} />
                <b className="svc-name">{o.customerName}</b>
                {tab === 'alertes_new' && <ClockText x={x} />}
                {tab === 'alertes_encours' && x?.bucket === 'call' && <b className="svc-recall">{t('suivi.clair.recall')}</b>}
                {tab === 'alertes_encours' && x?.bucket !== 'call' && (
                  <span className="muted small" dir="auto">
                    {sinceText(t, x?.last?.at ?? o.updatedAt)}
                  </span>
                )}
                {(tab === 'resolus' || tab === 'swap') && <b className="svc-amt ltr">{da(o.total)}</b>}
              </div>
              {tab === 'alertes_new' && (
                <div className="svc-card-s" onClick={(e) => e.stopPropagation()}>
                  <ZrStatus o={o} text={reason} />
                </div>
              )}
              {tab === 'alertes_encours' && (
                <div className="svc-card-s">
                  <LastResult x={x} />
                  {x?.tries && <CallDots tr={x.tries} />}
                </div>
              )}
              {tab === 'resolus' && (
                <div className="svc-card-s">
                  <span className="svc-dlv">
                    <Icon name="checkcircle" /> {t('suivi.clair.deliveredAt', { v: deliveredText(t, o.deliveredAt) })}
                  </span>
                  {x?.savedBy && (
                    <span className="svc-who">
                      <i aria-hidden="true">{x.savedBy.slice(0, 1).toUpperCase()}</i>
                      {x.savedBy}
                    </span>
                  )}
                </div>
              )}
              {tab === 'swap' && (
                <div className="svc-card-s">
                  <span className="svc-last z-red">
                    <i aria-hidden="true" />
                    {x?.cancelBy === 'client' ? t('suivi.clair.cancelClient') : coSays(t, o, reason || t('suivi.clair.cancelled'))}
                  </span>
                  <span className="muted small svc-clamp">{namesOf(o.items)}</span>
                </div>
              )}
              {fx && h.canWork(o) && (
                <button type="button" className="svc-fixb" onClick={(e) => (e.stopPropagation(), h.onOpen(o))}>
                  <Icon name="pencil" /> {t(`suivi.clair.fix.${fx}`)}
                </button>
              )}
            </div>
            {right && (
              <div className="svc-card-r" onClick={(e) => e.stopPropagation()}>
                {right}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The « Statut » menu: two calls that count, a call back, a réclamation, the customer cancels. */
export function StatusMenu({ o, x, onPick, onClose }: { o: Order; x?: ClairX; onPick: (k: StatusKey) => void; onClose: () => void }) {
  // a parcel treated and back on the road (« Attend ZR »): no more calls to count, a réclamation or the customer cancels
  const { t } = useTranslation();
  const tr = x?.tries;
  const next = tr ? t('suivi.clair.menu.callN', { n: Math.min(tr.done + 1, tr.need), need: tr.need }) : '';
  const items: { k: StatusKey; icon: string; tone?: string; sub: string }[] = [
    { k: 'no_answer', icon: 'phoneoff', tone: 'or', sub: next },
    { k: 'busy', icon: 'phone', tone: 'or', sub: next },
    { k: 'callback', icon: 'clock', tone: 'bl', sub: t('suivi.clair.menu.callbackSub') },
    { k: 'claim', icon: 'copy', sub: t('suivi.clair.menu.claimSub', { co: o.companyName || t('suivi.zr') }) },
    { k: 'cancel', icon: 'xcircle', tone: 'rd', sub: t('suivi.clair.menu.cancelSub') },
  ].filter((it) => o.followStatus === 'alert' || it.k === 'claim' || it.k === 'cancel') as { k: StatusKey; icon: string; tone?: string; sub: string }[];
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="svc-menu-bg" onClick={onClose} />
      <div className="svc-menu" role="menu" aria-label={t('suivi.clair.status')}>
        {items.map((it) => (
          <button key={it.k} type="button" role="menuitem" className={`svc-mi ${it.tone ?? ''}`} onClick={() => (onClose(), onPick(it.k))}>
            <Icon name={it.icon} />
            <b>{t(`suivi.clair.menu.${it.k}`)}</b>
            <small>{it.sub}</small>
          </button>
        ))}
      </div>
    </>
  );
}

/** « Rappel »: the day and the hour to call back (the alert shows in « Plus tard » until then). */
export function RappelSheet({ o, onClose }: { o: Order; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const p = (n: number) => String(n).padStart(2, '0');
  const d0 = new Date(Date.now() + 2 * 3_600_000);
  const [day, setDay] = useState(`${d0.getFullYear()}-${p(d0.getMonth() + 1)}-${p(d0.getDate())}`);
  const [time, setTime] = useState(`${p(d0.getHours())}:00`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const at = new Date(`${day}T${time}:00`).toISOString();
      await rpc('suivi.callResult', { id: o.id, result: 'callback', at });
      void qc.invalidateQueries();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={t('suivi.clair.rappel.title')}
      sub={`${o.ref} · ${o.customerName}`}
      onClose={onClose}
      foot={
        <button type="button" className="btn primary block" disabled={busy || !day || !time} onClick={save}>
          {busy ? '…' : t('suivi.clair.rappel.ok')}
        </button>
      }
    >
      <div className="svc-rap">
        <label className="field">
          <span className="lab">{t('suivi.clair.rappel.day')}</span>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label className="field">
          <span className="lab">{t('suivi.clair.rappel.time')}</span>
          <input type="time" value={time} step={300} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      {err && <p className="svc-err">{err}</p>}
    </Sheet>
  );
}

/** The parcel's history in a sheet (the phone's « Historique » chip): the company's news and Pilotix's, newest first. */
export function HistorySheet({ o, onClose }: { o: Order; onClose: () => void }) {
  const { t } = useTranslation();
  const meta = useRpc('orders.uiMeta', {}, { staleTime: 5 * 60_000 });
  const names = new Map(Object.entries(meta.data?.names ?? {}));
  const ev = useRpc('orders.events', { id: o.id }, { staleTime: 15_000 });
  const name = (v: string | null) => (v ? names.get(v) ?? v : '—');
  const company = (v: string | null) => (v ? names.get(`c${v}`) ?? v : '—');
  const list = ev.data ? [...ev.data].reverse() : [];
  return (
    <Sheet title={t('suivi.clair.histOf', { ref: o.ref })} sub={t('suivi.clair.histSub')} onClose={onClose} tall>
      {!ev.data ? (
        <p className="muted small">…</p>
      ) : (
        <ol className="svc-tl">
          {list.map((e) => {
            const bad = e.kind === 'follow_status' && ['alert', 'failed', 'returning', 'returned', 'cancelled', 'lost'].includes(e.toValue ?? '');
            const ok = e.kind === 'follow_status' && ['delivered', 'shipped'].includes(e.toValue ?? '');
            return (
              <li key={e.id} className={bad ? 'al' : ok ? 'ok' : ''}>
                <b>{e.kind === 'note' ? e.note : eventText(t, e, name, company)}</b>
                <small>
                  <span className="ltr">{when(e.at)}</span>
                  {e.userName ? ` · ${e.userName}` : ''}
                </small>
                {e.note && e.kind !== 'note' && <q>{e.note}</q>}
              </li>
            );
          })}
        </ol>
      )}
    </Sheet>
  );
}

/** The alert opened under its line (tablet, computer): where the parcel is and what to do on the left, with « Statut »
 *  and « Relivrer »; the order, the customer and the history on the right. */
export function AlertPanel({ o, x, reason, statusOpen, onStatus, menu, onRelivrer, onClaim }: { o: Order; x?: ClairX; reason: string | null; statusOpen: boolean; onStatus: () => void; menu: ReactNode; onRelivrer?: () => void; onClaim?: () => void }) {
  const { t } = useTranslation();
  const ev = useRpc('orders.events', { id: o.id }, { staleTime: 15_000 });
  const meta = useRpc('orders.uiMeta', {}, { staleTime: 5 * 60_000 });
  const names = new Map(Object.entries(meta.data?.names ?? {}));
  const name = (v: string | null) => (v ? names.get(v) ?? v : '—');
  const company = (v: string | null) => (v ? names.get(`c${v}`) ?? v : '—');
  const list = ev.data ? [...ev.data].reverse().slice(0, 4) : [];
  const late = x?.clock?.state === 'late' ? fmtMin(t, Math.abs(x.clock.left)) : null;
  return (
    <div className="svc-panel" onClick={(e) => e.stopPropagation()}>
      <section className="svc-pl">
        <span className={`svc-pzr z-${zrTone(reason)}`}>
          <Icon name="alert" /> {!reason ? t('suivi.clair.noNews') : coSays(t, o, reason)}
        </span>
        <Journey o={o} label={reason} />
        <AlertTodo o={o} x={x} reason={reason} onClaim={onClaim} />
        <div className="svc-pbar">
          {statusOpen && menu}
          <button type="button" className="svc-stat" aria-haspopup="menu" aria-expanded={statusOpen} onClick={onStatus}>
            <Icon name="menu" /> {t('suivi.clair.change')}
            <span className="svc-cur">{t(o.followStatus === 'alert' ? (x?.last ? 'suivi.clair.curWork' : 'suivi.clair.curNew') : 'suivi.clair.curWait')}</span>
            <Icon name="chevron" />
          </button>
          {onRelivrer && (
            <button type="button" className="svc-reliv pc" onClick={onRelivrer}>
              <Icon name="refresh" /> {t('suivi.clair.relivrer')}
            </button>
          )}
          <small className="svc-pinfo">
            {x?.tries ? t('suivi.tries.count', { done: x.tries.done, need: x.tries.need }) : ''}
            {late ? ` · ${t('suivi.clair.lateBy', { v: late })}` : ''}
          </small>
        </div>
      </section>
      <section className="svc-pr">
        <div className="svc-prod">
          <span className="svc-pic" aria-hidden="true">
            <Icon name="package" />
          </span>
          <span>
            <b>{namesOf(o.items)}</b>
            <small>
              {o.items.some((i) => i.variantTitle) ? `${variantsOf(o.items)} · ` : ''}×{o.items.reduce((s, i) => s + i.qty, 0)}
            </small>
          </span>
          <b className="ltr">{da(o.total)}</b>
        </div>
        <div className="svc-g2">
          <div>
            <small>{t('suivi.col.client')}</small>
            <b>{o.customerName}</b>
            {!o.phoneHidden && <span className="ltr">{o.phone}</span>}
          </div>
          <div>
            <small>{o.isStopdesk ? t('suivi.ph.desk') : t('suivi.ph.home')}</small>
            <b>
              {wilayaName(o.wilayaId)}
              {o.commune ? `, ${o.commune}` : ''}
            </b>
            <span>{o.address || '—'}</span>
          </div>
        </div>
        <div className="svc-ph">
          <h5>
            <Icon name="history" /> {t('suivi.clair.history')}
          </h5>
          <ol className="svc-tl small">
            {list.map((e) => (
              <li key={e.id} className={e.kind === 'follow_status' && e.toValue === 'alert' ? 'al' : ''}>
                <b>{e.kind === 'note' ? e.note : eventText(t, e, name, company)}</b>
                <small>
                  <span className="ltr">{when(e.at)}</span>
                  {e.userName ? ` · ${e.userName}` : ''}
                </small>
              </li>
            ))}
          </ol>
          <HistoryButton orderId={o.id} refLabel={o.ref} className="svc-hall" title={t('suivi.clair.histOf', { ref: o.ref })}>
            {t('suivi.clair.histAll')}
          </HistoryButton>
        </div>
      </section>
    </div>
  );
}
