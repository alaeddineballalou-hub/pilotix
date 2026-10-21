import type { Order } from '@pilotix/shared';
import i18n from '../../lib/i18n';
import { escapeHtml, printHtml } from '../../lib/files';
import { da, dateTime, wilaya } from '../../lib/format';

export interface RouteSheet {
  shop: string;
  title: string;
  who: string;
  phone: string | null;
  date: string;
  orders: Order[];
  total: number;
}

const items = (o: Order) => o.items.map((i) => `${i.qty} × ${i.name}${i.variantTitle ? ` (${i.variantTitle})` : ''}`).join(' + ');

/** Prints a livreur's (or a company's) route sheet: one line per parcel, in round order, with room to sign. */
export function printRouteSheet(s: RouteSheet) {
  const t = (k: string, o?: Record<string, unknown>) => i18n.t(`livraison.sheet.${k}`, o);
  const rows = s.orders
    .map(
      (o, k) => `<tr>
  <td class="num">${k + 1}</td>
  <td><b>${escapeHtml(o.ref)}</b>${o.tracking ? `<br><span class="muted">${escapeHtml(o.tracking)}</span>` : ''}</td>
  <td><b>${escapeHtml(o.customerName)}</b><br>${escapeHtml(o.phone)}${o.phone2 ? ` / ${escapeHtml(o.phone2)}` : ''}</td>
  <td>${escapeHtml(wilaya(o.wilayaId))} · ${escapeHtml(o.commune)}<br>${escapeHtml(o.address)}${o.isStopdesk ? `<br><b>${escapeHtml(t('stopdesk'))}</b>` : ''}</td>
  <td>${escapeHtml(items(o))}${o.deliveryNote ? `<br><i>${escapeHtml(o.deliveryNote)}</i>` : ''}</td>
  <td class="num big">${escapeHtml(da(o.total))}</td>
  <td style="width:90px"></td>
</tr>`,
    )
    .join('');
  printHtml(
    s.title,
    `<h1>${escapeHtml(s.title)}</h1>
<p class="muted">${escapeHtml(s.shop)} · ${escapeHtml(dateTime(s.date))}${s.phone ? ` · ${escapeHtml(s.phone)}` : ''}</p>
<p><b>${escapeHtml(t('count', { count: s.orders.length }))}</b> · ${escapeHtml(t('total'))} <b>${escapeHtml(da(s.total))}</b></p>
<table><thead><tr><th>#</th><th>${escapeHtml(t('order'))}</th><th>${escapeHtml(t('customer'))}</th><th>${escapeHtml(t('address'))}</th><th>${escapeHtml(t('products'))}</th><th class="num">${escapeHtml(t('amount'))}</th><th>${escapeHtml(t('sign'))}</th></tr></thead>
<tbody>${rows || `<tr><td colspan="7">${escapeHtml(t('empty'))}</td></tr>`}</tbody></table>
<p style="margin-top:24px">${escapeHtml(t('signLivreur'))} : ____________________ &nbsp; ${escapeHtml(t('signDepot'))} : ____________________</p>`,
  );
}
