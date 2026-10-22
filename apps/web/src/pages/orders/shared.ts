// Helpers shared by the orders screens (table, card, form, pages).
import { CONF_TODO, ConfStatus, FOLLOW_ON_ROAD, FollowStatus, Order, phoneIntl } from '@pilotix/shared';
import type { TFunction } from 'i18next';
import type { In } from '../../lib/backend';
import { downloadCsv, escapeHtml, printHtml } from '../../lib/files';
import { da, dateTime, when, wilaya, wilayaName } from '../../lib/format';
import { trackOf } from '../../lib/items';

export type ListFilter = In<'orders.list'>;

/** "2 × Poussette Gris · 1 × Biberon" */
export const itemsText = (o: Pick<Order, 'items'>) =>
  o.items.map((i) => `${i.qty} × ${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''}`).join(' · ');
export const pieces = (o: Pick<Order, 'items'>) => o.items.reduce((s, i) => s + i.qty, 0);

/** Confirmation label like the original ("Tentative 02" for no answer). */
export function confLabel(t: TFunction, o: Pick<Order, 'confStatus' | 'attempts'>): string {
  if (o.confStatus === 'no_answer') return t('orders.attemptN', { n: String(Math.max(1, o.attempts)).padStart(2, '0') });
  return t(`status.conf.${o.confStatus}`);
}

export const telHref = (p: string) => `tel:${p}`;
export function waHref(phone: string, template: string, vars: { nom: string; boutique: string; ref: string }) {
  const text = (template || '').replace(/\{(nom|boutique|ref)\}/g, (_, k: 'nom' | 'boutique' | 'ref') => vars[k]);
  return `https://wa.me/${phoneIntl(phone)}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------- filters of the generic list
export type ConfFilter = '' | 'todo' | ConfStatus | 'try1' | 'try2';
export type FollowFilter = '' | 'prep' | 'active' | 'back' | FollowStatus;

/** Turns the original filter selects into orders.list input. */
export function toListInput(f: { conf?: ConfFilter; follow?: FollowFilter; company?: string; wilaya?: string; channel?: string; agent?: string; from?: string; to?: string; q?: string }): Partial<ListFilter> {
  const out: Partial<ListFilter> = {};
  if (f.conf === 'todo') out.conf = CONF_TODO;
  else if (f.conf === 'try1' || f.conf === 'try2') out.conf = ['no_answer', 'busy'];
  else if (f.conf) out.conf = [f.conf];
  if (f.follow === 'prep') out.follow = ['to_prepare', 'prepared'];
  else if (f.follow === 'active') out.follow = [...FOLLOW_ON_ROAD];
  else if (f.follow === 'back') out.follow = ['returning', 'returned'];
  else if (f.follow) out.follow = [f.follow];
  if (f.company === 'none') out.companyId = 'none';
  else if (f.company) out.companyId = Number(f.company);
  if (f.wilaya) out.wilayaId = Number(f.wilaya);
  if (f.channel) out.channel = f.channel as ListFilter['channel'];
  if (f.agent === 'none') out.agentId = 'none';
  else if (f.agent) out.agentId = Number(f.agent);
  if (f.from) out.from = new Date(`${f.from}T00:00:00+01:00`).toISOString();
  if (f.to) out.to = new Date(Date.parse(`${f.to}T00:00:00+01:00`) + 86_400_000).toISOString();
  if (f.q?.trim()) out.q = f.q.trim();
  return out;
}

// ---------------------------------------------------------------- exports and printing
/** CSV with the columns of the original app (BOM + ";"). */
export function exportOrdersCsv(t: TFunction, rows: Order[]) {
  const k = (x: string) => t(`orders.csv.${x}`);
  downloadCsv(`${k('file')}-${new Date().toISOString().slice(0, 10)}`, [
    ['ref', 'created', 'client', 'phone', 'phone2', 'wilaya', 'commune', 'address', 'desk', 'products', 'pieces', 'productsDa', 'feeDa', 'discount', 'totalDa', 'conf', 'follow', 'company', 'tracking', 'agent', 'deliveryNote'].map(k),
    ...rows.map((o) => [
      o.ref, dateTime(o.createdAt), o.customerName, o.phone, o.phone2 ?? '', wilaya(o.wilayaId), o.commune, o.address, o.isStopdesk ? t('common.yes') : '',
      itemsText(o), pieces(o), o.subtotal, o.deliveryFee, o.discount, o.total, confLabel(t, o), o.followStatus ? t(`status.follow.${o.followStatus}`) : '',
      o.companyName ?? '', trackOf(o), o.agentName ?? '', o.deliveryNote ?? '',
    ]),
  ]);
}

/** Simple Code 39 barcode as SVG (prints sharp on any printer). */
function barcodeSvg(text: string): string {
  const C: Record<string, string> = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn',
    K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn',
    U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn', Z: 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn',
  };
  const s = `*${text.toUpperCase().replace(/[^0-9A-Z. -]/g, '-')}*`;
  let x = 0;
  const bars: string[] = [];
  for (const ch of s) {
    const p = C[ch] ?? C['-'];
    for (let i = 0; i < 9; i++) {
      const w = p[i] === 'w' ? 3 : 1;
      if (i % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${w}" height="44"/>`);
      x += w;
    }
    x += 1;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${x * 1.4}" height="44" viewBox="0 0 ${x} 44" preserveAspectRatio="none">${bars.join('')}</svg>`;
}

/** "Imprimer les bons": one delivery slip per order. */
export function printSlips(t: TFunction, rows: (Order & { companyKind?: string | null })[]) {
  const e = escapeHtml;
  const html = rows
    .map((a) => {
      const code = trackOf(a) || a.ref;
      return `<div style="border:2px solid #111;border-radius:8px;padding:10px;margin-bottom:10px;page-break-inside:avoid">
<div style="background:#111;color:#fff;padding:7px 12px;border-radius:5px;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:21px;font-weight:900;letter-spacing:.03em;-webkit-print-color-adjust:exact;print-color-adjust:exact">
<span>${a.companyKind === 'own' ? e(t('orders.slip.livreur')) : ''}${e(String(a.companyName || t('orders.slip.noCompany')).toUpperCase())}</span><span style="font-size:17px">${e(a.ref)}</span></div>
<div style="display:flex;align-items:center;gap:14px;margin-top:8px;flex-wrap:wrap">${barcodeSvg(code)}<b style="font-family:monospace;font-size:16px;letter-spacing:.04em">${e(code)}</b></div>
<div style="font-size:15px;margin:6px 0"><b>${e(a.customerName)}</b> · ${e(a.phone)}${a.phone2 ? ` / ${e(a.phone2)}` : ''}</div>
<div>${e([wilaya(a.wilayaId), a.commune, a.address].filter(Boolean).join(' · '))}${a.isStopdesk ? ` · <b>${e(t('orders.slip.desk'))}</b>` : ''}</div>
<div style="margin:6px 0">${e(itemsText(a))}</div>
${a.deliveryNote ? `<div><b>${e(t('orders.slip.note'))} : ${e(a.deliveryNote)}</b></div>` : ''}
<div style="font-size:18px;text-align:right"><b>${e(t('orders.slip.toCollect'))} : ${e(da(a.total))}</b></div></div>`;
    })
    .join('');
  printHtml(t('orders.slip.title'), html);
}

/** Printing one order from its card. */
export function printOrder(t: TFunction, o: Order, shopName: string) {
  const e = escapeHtml;
  printHtml(
    `${o.ref}`,
    `<h1>${e(shopName)} — ${e(o.ref)}</h1><p class="muted">${e(when(o.createdAt))}</p>
<h2>${e(t('orders.card.client'))}</h2><p><b>${e(o.customerName)}</b> · ${e(o.phone)}${o.phone2 ? ` / ${e(o.phone2)}` : ''}<br>${e([wilaya(o.wilayaId), o.commune, o.address].filter(Boolean).join(' · '))}${o.isStopdesk ? ` · <b>${e(t('orders.slip.desk'))}</b>` : ''}</p>
<h2>${e(t('orders.card.products'))}</h2><table><tr><th>${e(t('orders.form.product'))}</th><th class="num">${e(t('orders.form.qty'))}</th><th class="num">${e(t('orders.form.price'))}</th><th class="num">${e(t('orders.form.total'))}</th></tr>
${o.items.map((i) => `<tr><td>${e(i.name)}${i.variantTitle ? ` — ${e(i.variantTitle)}` : ''}</td><td class="num">${i.qty}</td><td class="num">${e(da(i.unitPrice))}</td><td class="num">${e(da(i.qty * i.unitPrice))}</td></tr>`).join('')}
</table><p style="text-align:right">${e(t('orders.card.sum', { sub: da(o.subtotal), fee: da(o.deliveryFee) }))}${o.discount ? e(t('orders.card.sumDiscount', { v: da(o.discount) })) : ''}<br><span class="big">${e(t('orders.card.toCollect', { v: da(o.total) }))}</span></p>
<h2>${e(t('orders.card.delivery'))}</h2><p>${e(t('orders.card.company'))} : ${e(o.companyName ?? '—')} · ${e(t('orders.card.tracking'))} : ${e(trackOf(o) || '—')}</p>
${o.deliveryNote ? `<p><b>${e(t('orders.card.noteLivreur'))} : ${e(o.deliveryNote)}</b></p>` : ''}`,
  );
}

export const wName = wilayaName;
