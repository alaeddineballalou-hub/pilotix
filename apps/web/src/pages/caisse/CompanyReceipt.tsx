// A delivery company's money as the company itself counts it (the owner's design 1 « Reçu », 26 Nov 2026): what it
// collected, then everything it takes — its delivery price (+ its weight fee above 5 kg), its returns (+ weight), its
// swaps, its SAV exchanges (+ weight) — down to the net; under it the delivery gap: what the customers paid for their
// delivery against what the company took. The fees of returns, swaps and exchanges all come out with the next money
// received (each one once); the delivered parcels follow the ones ticked.
import { useTranslation } from 'react-i18next';
import { da } from '../../lib/format';
import type { useRpc } from '../../lib/query';

export type DueGroup = NonNullable<ReturnType<typeof useRpc<'cash.due'>>['data']>['groups'][number];
type DueOrder = DueGroup['orders'][number];

const n0 = (v: number) => da(v).replace(/\s?(DA|د\.ج)$/, '');
/** −1 234 / +50 / 0 */
const signed = (v: number) => (v > 0 ? `+${n0(v)}` : v < 0 ? `−${n0(-v)}` : '0');

/** The card's numbers for the parcels chosen, and what « Argent reçu » sends (their ids, the SAV parcels, the fees). */
export function receiptOf(g: DueGroup, chosen: DueOrder[]) {
  const x = g.extra;
  const delivery = chosen.reduce((s, o) => s + o.deliveryCost - o.weight, 0);
  const weight = chosen.reduce((s, o) => s + o.weight, 0);
  const client = chosen.reduce((s, o) => s + o.clientDelivery, 0);
  const extra = x ? x.exchanges.collected - x.exchanges.price - x.exchanges.weight - x.returns.fee - x.returns.weight - x.swaps.fee : 0;
  return {
    count: chosen.length + (x?.exchanges.n ?? 0),
    collected: chosen.reduce((s, o) => s + o.total, 0) + (x?.exchanges.collected ?? 0),
    delivery,
    weight,
    client,
    gap: client - delivery - weight,
    net: chosen.reduce((s, o) => s + o.net, 0) + extra,
    ids: [...chosen.map((o) => o.id), ...(x?.exchanges.ids ?? [])],
    fees: [...(x?.returns.ids ?? []), ...(x?.swaps.ids ?? [])],
  };
}

/** What the customer paid for the delivery against what the company took on it (+50: we earn, −150: we pay). */
export function GapChip({ o }: { o: DueOrder }) {
  const v = o.clientDelivery - o.deliveryCost;
  return <span className={`ltr pxk-gapc${v > 0 ? ' ok' : v < 0 ? ' bad' : ''}`}>{signed(v)}</span>;
}

/** « client 550 · ZR 500 » */
export function RowPrices({ g, o }: { g: DueGroup; o: DueOrder }) {
  const { t } = useTranslation();
  return <>{t('caisse.rc.row', { c: n0(o.clientDelivery), name: g.name, z: n0(o.deliveryCost) })}</>;
}

export function CompanyReceipt({ g, chosen }: { g: DueGroup; chosen: DueOrder[] }) {
  const { t } = useTranslation();
  const r = receiptOf(g, chosen);
  const x = g.extra;
  const out = (v: number, sub?: boolean) => (sub ? <span className={`ltr${v ? ' bad' : ''}`}>{v ? `−${n0(v)}` : '0'}</span> : <b className={`ltr${v ? ' bad' : ''}`}>{v ? `−${n0(v)}` : '0'}</b>);
  const line = (label: string, v: number, weight?: number) => (
    <>
      <div className={`ln${v || weight ? '' : ' z'}`}>
        <span>{label}</span>
        {out(v)}
      </div>
      {weight !== undefined && (
        <div className={`sb${weight ? '' : ' z'}`}>
          <span>{t('caisse.rc.weight')}</span>
          {out(weight, true)}
        </div>
      )}
    </>
  );
  return (
    <div className="pxk-rcbox">
      <div className="pxk-rc" title={t('caisse.rc.help', { name: g.name })}>
        <div className="ln">
          <span>{t('caisse.rc.collected', { name: g.name, n: r.count })}</span>
          <b className="ltr">{n0(r.collected)}</b>
        </div>
        {line(t('caisse.rc.delivery', { n: chosen.length }), r.delivery, r.weight)}
        {x && (
          <>
            {line(t('caisse.rc.returns', { n: x.returns.n }), x.returns.fee, x.returns.weight)}
            {line(t('caisse.rc.swaps', { n: x.swaps.n }), x.swaps.fee)}
            {line(t('caisse.rc.exchanges', { n: x.exchanges.n }), x.exchanges.price, x.exchanges.weight)}
          </>
        )}
        <div className="tot">
          <b>{t('caisse.rc.net')}</b>
          <b className={`ltr${r.net < 0 ? ' bad' : ''}`}>{da(r.net)}</b>
        </div>
      </div>
      {chosen.length > 0 && (
        <div className="pxk-gap">
          <span>{t('caisse.rc.gap', { c: n0(r.client), name: g.name, z: n0(r.delivery + r.weight) })}</span>
          <b className={`ltr${r.gap > 0 ? ' ok' : r.gap < 0 ? ' bad' : ''}`}>{signed(r.gap)}</b>
        </div>
      )}
    </div>
  );
}
