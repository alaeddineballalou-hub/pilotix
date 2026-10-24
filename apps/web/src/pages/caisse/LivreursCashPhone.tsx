// Livreurs' money on phones (option B): one card per livreur — what he must hand in with « Encaisser » right there,
// his 4 numbers (en main · à retourner · échanges · taux de livraison), then his parcels not handed in yet (3 shown,
// « Voir les N colis » for the rest). A livreur sees only his own card.
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import '../sav/phone.css';
import './phone.css';
import './lcash.css';

type Data = Out<'cash.livreurs'>;
type L = Data['livreurs'][number];
type O = Data['delivered'][number];
const n0 = (v: number) => da(v).replace(/\s?(DA|د\.ج)$/, '');
const daysAgo = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : null);

function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="pxv-sheet" role="dialog" aria-modal="true">
      <button type="button" className="pxv-dim" aria-label={t('common.close')} onClick={onClose} />
      <div className="pxv-sh">
        <span className="pxv-grab" aria-hidden="true" />
        <div className="pxv-shh">
          <b>{title}</b>
          <button type="button" className="pxp-back" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LivreursCashPhone({ livreurId: fixed }: { livreurId?: number }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const self = !admin && !!session?.roles.includes('livreur') && !session.roles.includes('suivi');
  const q = useRpc('cash.livreurs', { livreurId: fixed });
  const d = q.data;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  const net = d.livreurs.reduce((s, l) => s + l.net, 0);
  const notCashed = d.livreurs.reduce((s, l) => s + l.notCashed, 0);
  const inHand = d.livreurs.reduce((s, l) => s + l.inHand, 0);
  const inHandValue = d.livreurs.reduce((s, l) => s + l.inHandValue, 0);
  const list = [...d.livreurs].sort((a, b) => b.net - a.net || b.inHand - a.inHand);
  return (
    <div className="pxlc">
      <div className="pxlc-h">{self ? t('caisse.lv.myTitle') : t('caisse.lcp.title')}</div>
      {!self && list.length > 1 && (
        <div className="pxk-k2">
          <div>
            <small>{t('caisse.lv.net')}</small>
            <b className="ltr ok">{da(net)}</b>
            <i>{t('caisse.lcp.notHanded', { count: notCashed })}</i>
          </div>
          <div>
            <small>{t('caisse.lv.inHand')}</small>
            <b>{inHand}</b>
            <i className="ltr">{t('caisse.lv.value', { amount: da(inHandValue) })}</i>
          </div>
        </div>
      )}
      {list.map((l) => (
        <Card key={l.id} l={l} orders={d.delivered.filter((o) => o.livreurId === l.id && !o.cashed)} admin={admin} self={self} />
      ))}
    </div>
  );
}

function Card({ l, orders, admin, self }: { l: L; orders: O[]; admin: boolean; self: boolean }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const [take, setTake] = useState(false);
  const shown = all ? orders : orders.slice(0, 3);
  const last = daysAgo(l.lastHandover);
  const rate = l.rate === null ? null : Math.round(l.rate * 100);
  return (
    <section className="pxlc-card">
      <div className="pxlc-who">
        <span className="pxk-av or">{l.name.trim().slice(0, 1).toUpperCase()}</span>
        <span className="pxk-rm">
          <b>{l.name}</b>
          <small>
            {l.notCashed ? t('caisse.lcp.notHanded', { count: l.notCashed }) : t('caisse.lcp.allHanded')}
            {last !== null ? ` · ${last === 0 ? t('caisse.lcp.lastToday') : t('caisse.lcp.lastAgo', { n: last })}` : ''}
          </small>
        </span>
        {l.phone && !self && (
          <a className="pxlc-call" href={`tel:${l.phone}`} aria-label={t('caisse.ph.call')}>
            <Icon name="phone" />
          </a>
        )}
      </div>
      <div className={`pxlc-due${l.net > 0 ? '' : ' zero'}`}>
        <div>
          <small>{self ? t('caisse.lcp.toHand') : t('caisse.ph.mustHand')}</small>
          <b className="ltr">{da(l.net)}</b>
          {l.share > 0 && <i className="ltr">{t('caisse.ph.mustHandSub', { a: da(l.notCashedAmount), s: da(l.share) })}</i>}
        </div>
        {admin && l.net > 0 && (
          <button type="button" onClick={() => setTake(true)}>
            {t('caisse.lcp.collect')}
          </button>
        )}
      </div>
      <div className="pxlc-k4">
        <div>
          <small>{t('caisse.lcp.k.inHand')}</small>
          <b>{l.inHand}</b>
        </div>
        <div>
          <small>{t('caisse.lcp.k.returning')}</small>
          <b className={l.returning ? 'bad' : ''}>{l.returning}</b>
        </div>
        <div>
          <small>{t('caisse.lcp.k.exchanges')}</small>
          <b>{l.exchanges}</b>
        </div>
        <div>
          <small>{t('caisse.lcp.k.rate')}</small>
          <b className={rate === null ? '' : rate >= 85 ? 'ok' : 'warn'}>{rate === null ? '—' : `${rate} %`}</b>
        </div>
      </div>
      {orders.length > 0 && (
        <ul className="pxlc-list">
          {shown.map((o) => (
            <li key={o.id}>
              <span className="pxk-rm">
                <b>{o.customerName}</b>
                <small>
                  <span className="ltr">{o.ref}</span> · {o.commune} · {when(o.deliveredAt)}
                </small>
              </span>
              <span className="pxlc-amt">
                <b className="ltr">{n0(o.total)}</b>
                {o.share > 0 && <small className="ltr">{t('caisse.lcp.part', { v: n0(o.share) })}</small>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {orders.length > 3 && (
        <button type="button" className="pxlc-more" onClick={() => setAll((v) => !v)}>
          {all ? t('caisse.lcp.less') : t('caisse.lcp.more', { count: orders.length })}
          <Icon name={all ? 'chevron' : 'chevr'} />
        </button>
      )}
      {take && <Collect l={l} orders={orders} onClose={() => setTake(false)} />}
    </section>
  );
}

/** « Encaisser »: his parcels not handed in (all ticked), into the caisse of whoever takes the cash. */
function Collect({ l, orders, onClose }: { l: L; orders: O[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [off, setOff] = useState<Set<number>>(new Set());
  const [into, setInto] = useState('main');
  const caisses = useRpc('caisse.list', {}).data ?? [];
  const go = useAction('cash.livreurCollect', { success: (r) => t('caisse.lv.collected', { count: r.orders }), onDone: onClose });
  const chosen = orders.filter((o) => !off.has(o.id));
  const due = chosen.reduce((s, o) => s + o.total - o.share, 0);
  const toggle = (id: number) => setOff((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <Sheet title={t('caisse.lcp.collectTitle', { name: l.name })} onClose={onClose}>
      <ul className="pxlc-list pxlc-pick">
        {orders.map((o) => (
          <li key={o.id}>
            <button type="button" onClick={() => toggle(o.id)}>
              <span className={`pxv-ck${!off.has(o.id) ? ' on' : ''}`}>{!off.has(o.id) && <Icon name="check" />}</span>
              <span className="pxk-rm">
                <b>{o.customerName}</b>
                <small className="ltr">{o.ref}</small>
              </span>
              <b className="ltr">{n0(o.total - o.share)}</b>
            </button>
          </li>
        ))}
      </ul>
      <div className="pxv-lbl">{t('caisse.ph.takenBy')}</div>
      <div className="pxv-chips pxk-into">
        {caisses.map((c) => (
          <button key={c.key} type="button" className={`pxv-chip${into === c.key ? ' on' : ''}`} aria-pressed={into === c.key} onClick={() => setInto(c.key)}>
            {c.key === 'main' ? t('caisse.ph.meMain') : c.key === 'bank' ? t('caisse.ph.bank') : c.name}
          </button>
        ))}
      </div>
      <button type="button" className="pxv-btn gr big" disabled={!chosen.length || go.isPending} onClick={() => go.mutate({ livreurId: l.id, ids: chosen.map((o) => o.id), into: into as 'main' })}>
        <Icon name="check" /> {t('caisse.ph.collectBtn', { v: da(due) })}
      </button>
    </Sheet>
  );
}
