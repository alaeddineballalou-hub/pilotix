// The sale's ticket on the counter's printer: an 80 mm roll (72 mm printed), in the app's language. The same HTML is
// shown in Réglages (Aperçu), where the owner writes its title, phone, address and last line.
import { escapeHtml, printHtml } from '../../lib/files';
import { da } from '../../lib/format';
import i18n from '../../lib/i18n';
import type { PosSale, PosState } from './shared';

/** The ticket's look, every rule under .pxt (the preview in Réglages uses it too). */
export const TICKET_CSS = `.pxt{box-sizing:border-box;width:72mm;margin:0 auto;padding:3mm 0 5mm;font:12px/1.35 ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace;color:#000;background:#fff}
.pxt *{box-sizing:border-box}.pxt .c{text-align:center}.pxt .h{font-size:16px;font-weight:700;margin:2px 0}.pxt .s{font-size:11px}
.pxt .r{display:flex;justify-content:space-between;gap:8px}.pxt .r>span:last-child{text-align:end;white-space:nowrap}
.pxt .l{font-weight:700;margin-top:4px;overflow-wrap:anywhere}.pxt .i{padding-inline-start:10px}.pxt .t{font-size:15px;font-weight:700;margin:3px 0}
.pxt hr{border:0;border-top:1px dashed #000;margin:6px 0}.pxt img{display:block;max-width:40mm;max-height:18mm;margin:0 auto 4px;object-fit:contain}
.pxt .x{font-size:15px;font-weight:700;border:2px solid #000;padding:2px 0;margin-top:6px}.pxt [dir=ltr]{unicode-bidi:isolate}`;
const PAGE_CSS = `@page{size:80mm auto;margin:0}html,body{margin:0;padding:0;background:#fff}${TICKET_CSS}`;

export type TicketInfo = PosState['ticket'];

const when = (iso: string) =>
  new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR', {
    timeZone: 'Africa/Algiers',
    numberingSystem: 'latn',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  } as Intl.DateTimeFormatOptions).format(Date.parse(iso));

/** The ticket of a sale, as HTML (the shop's own words escaped). */
export function ticketHtml(sale: PosSale, info: TicketInfo): string {
  const t = i18n.t.bind(i18n);
  const e = escapeHtml;
  const row = (a: string, b: string, cls = '') => `<div class="r ${cls}"><span>${a}</span><span>${b}</span></div>`;
  const num = (s: string) => `<bdi dir="ltr">${e(s)}</bdi>`;
  const title = info.title || info.shopName;
  const phone = info.phone || info.shopPhone;
  const lines = sale.lines
    .map((l) => {
      const before = l.unit * l.qty;
      return (
        `<div class="l">${e(l.name)}${l.variant ? ` · ${e(l.variant)}` : ''}</div>` +
        row(`<span class="i">${num(`${l.qty} × ${da(l.unit)}`)}</span>`, num(da(l.total))) +
        (before > l.total ? row(`<span class="i s">${e(t('pos.ticket.pack'))}</span>`, `<span class="s">${num(`−${da(before - l.total)}`)}</span>`) : '')
      );
    })
    .join('');
  return (
    `<div class="pxt" dir="${i18n.language === 'ar' ? 'rtl' : 'ltr'}" lang="${e(i18n.language)}">` +
    (info.logo ? `<img src="${e(info.logo)}" alt="">` : '') +
    `<div class="c h">${e(title)}</div>` +
    (info.address ? `<div class="c s">${e(info.address)}</div>` : '') +
    (phone ? `<div class="c s">${e(t('pos.ticket.phone'))} ${num(phone)}</div>` : '') +
    '<hr>' +
    row(e(t('pos.ticket.no', { no: sale.no })), num(when(sale.at))) +
    (sale.seller ? row(e(t('pos.ticket.seller')), e(sale.seller)) : '') +
    (sale.customer ? row(e(t('pos.ticket.customer')), e(sale.customer.name)) : '') +
    '<hr>' +
    lines +
    '<hr>' +
    row(e(t('pos.ticket.items')), num(String(sale.items))) +
    (sale.saved > 0 ? row(e(t('pos.ticket.saved')), num(`−${da(sale.saved)}`)) : '') +
    row(e(t('pos.ticket.total')), num(da(sale.total)), 't') +
    row(e(t('pos.ticket.paid')), e(t(`pos.method.${sale.method}`))) +
    '<hr>' +
    `<div class="c">${e(info.footer || t('pos.ticket.thanks'))}</div>` +
    (sale.cancelledAt ? `<div class="c x">${e(t('pos.ticket.cancelled'))}</div>` : '') +
    '</div>'
  );
}

/** Prints a sale's ticket (the browser's print window: choose the counter's 80 mm printer there). */
export function printTicket(sale: PosSale, info: TicketInfo) {
  printHtml(i18n.t('pos.ticket.no', { no: sale.no }), ticketHtml(sale, info), PAGE_CSS);
}
