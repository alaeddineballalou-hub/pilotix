// Parcel labels of « En dispatch »: one 10 × 15 cm label per parcel (the size of label printers).
// Top: the delivery company, the tracking number, the order and its date, the QR code at the top right. A SAV exchange
// says so (the livreur brings the old product back). Then the wilaya in a large box (sorting at the courier's hub) next
// to the customer, phones, commune, address and home / stop desk; the contents; the amount to collect; the barcode at
// the bottom; the shop and its after-sales (SAV) number. The QR code and the barcode carry the same code.
// A label is printed only once the parcel is assigned: it needs its delivery company, and a company with an API needs
// its own tracking number first (it replaces the Pilotix one, so a Pilotix label would be refused by the scanner).
import type { Order } from '@pilotix/shared';
import { API_COURIER_KINDS } from '@pilotix/shared';
import type { TFunction } from 'i18next';
import i18n from '../../lib/i18n';
import { escapeHtml, printHtml } from '../../lib/files';
import { da, dateOnly, wilayaName } from '../../lib/format';

export type LabelState = { ok: true; code: string } | { ok: false; why: 'noCompany' | 'waiting' };

/** Can this parcel's label be printed, and with which code. `kind`: its delivery company's kind (undefined = unknown). */
export function labelState(o: Order, kind: string | undefined): LabelState {
  if (!o.companyId) return { ok: false, why: 'noCompany' };
  if (!o.tracking && (kind === undefined || API_COURIER_KINDS.includes(kind))) return { ok: false, why: 'waiting' };
  return { ok: true, code: o.tracking || o.ownTracking || o.ref };
}

// ---------------------------------------------------------------- Code 128 (set B): every printable character, exact case
// bar / space widths of the 106 symbols (6 each), then the stop symbol
const P =
  '212222222122222221121223121322131222122213122312132212221213221312231212112232122132122231113222' +
  '123122123221223211221132221231213212223112312131311222321122321221312212322112322211212123212321' +
  '232121111323131123131321112313132113132311211313231113231311112133112331132131113123113321133121' +
  '313121211331231131213113213311213131311123311321331121312113312311332111314111221411431111111224' +
  '111422121124121421141122141221112214112412122114122411142112142211241211221114413111241112134111' +
  '111242121142121241114212124112124211411212421112421211212141214121412121111143111341131141114113' +
  '114311411113411311113141114131311141411131211412211214211232';
const STOP = '2331112';

/** The barcode as SVG bars (sharp on any printer); the 10-module margins on each side are part of it. */
export function code128Svg(text: string): string {
  const chars = [...text].map((c) => c.charCodeAt(0) - 32).filter((v) => v >= 0 && v <= 95);
  const codes = [104, ...chars];
  const check = codes.reduce((s, v, i) => s + v * Math.max(i, 1), 0) % 103;
  const widths = [...codes, check].map((c) => P.slice(c * 6, c * 6 + 6)).join('') + STOP;
  let x = 10;
  const bars: string[] = [];
  [...widths].forEach((w, i) => {
    if (i % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${w}" height="1"/>`);
    x += Number(w);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + 10} 1" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${escapeHtml(text)}">${bars.join('')}</svg>`;
}

// ---------------------------------------------------------------- QR code (the same code as the barcode)
type Zx = typeof import('@zxing/library');
let zx: Promise<Zx> | null = null;
/** The QR encoder (ZXing, loaded on first use); called early so printing does not wait for it. */
export const loadQr = () => (zx ??= import('@zxing/library'));

/** The QR code as SVG squares, with a 3-module white margin; error correction Q (a quarter of it may be damaged). */
function qrSvg(z: Zx, text: string): string {
  const m = z.QRCodeEncoder.encode(text, z.QRCodeDecoderErrorCorrectionLevel.Q).getMatrix();
  const n = m.getWidth();
  const q = 3;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.get(x, y) === 1) d += `M${x + q} ${y + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img" aria-label="${escapeHtml(text)}"><path d="${d}"/></svg>`;
}

/** The shop as printed on the labels. */
export interface LabelShop {
  name: string;
  /** after-sales number (Réglages), empty when not set */
  sav: string;
}

/** 0741932775 → 0741 93 27 75 (other formats as they are). */
const phone = (p: string) => {
  const d = p.replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 4)} ${d.slice(4, 6)} ${d.slice(6, 8)} ${d.slice(8)}` : p;
};

const LABEL_CSS = `@page{size:100mm 150mm;margin:0}
html,body{margin:0!important;padding:0;background:#fff}
.lbl{width:100mm;height:150mm;box-sizing:border-box;padding:3.6mm 4mm;display:flex;flex-direction:column;overflow:hidden;break-after:page;page-break-after:always;font-family:Arial,"Helvetica Neue",Helvetica,sans-serif;color:#000;line-height:1.2}
.lbl:last-child{break-after:auto;page-break-after:auto}
.lbl *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.lbl-k{font-size:7.5pt;font-weight:800;letter-spacing:.02em}
.lbl-top{display:flex;gap:3mm;direction:ltr}
.lbl-id{flex:1;min-width:0;display:flex;flex-direction:column}
[dir="rtl"] .lbl-id{direction:rtl}
.lbl-co{background:#000;color:#fff;border-radius:1.8mm;padding:2mm 3mm;font-size:15pt;font-weight:900;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lbl-co small{display:block;margin-top:.3mm;font-size:9pt;font-weight:700;letter-spacing:0;text-transform:none;overflow:hidden;text-overflow:ellipsis}
.lbl-id .lbl-k{margin-top:2mm}
.lbl-trk{font:900 18pt/1.05 "Courier New",Courier,monospace;letter-spacing:.02em;direction:ltr;overflow-wrap:anywhere}
[dir="rtl"] .lbl-trk{text-align:right}
.lbl-ref{margin-top:1.4mm;font-size:10pt}
.lbl-ref b{font-size:12pt;direction:ltr;unicode-bidi:isolate}
.lbl-qr{flex:none;width:30mm;height:30mm;border:.5mm solid #000;border-radius:1.8mm;padding:.5mm}
.lbl-qr svg{display:block;width:100%;height:100%}
.lbl-ex{margin-top:2.4mm;display:flex;align-items:center;gap:2.4mm;border:.7mm solid #000;border-radius:1.8mm;padding:1.4mm 2.4mm;font-size:9pt}
.lbl-ex b{flex:none;background:#000;color:#fff;border-radius:1mm;padding:.6mm 1.8mm;font-size:9.5pt;font-weight:900}
.lbl-to{display:flex;gap:3mm;margin-top:2.6mm;padding-top:2.6mm;border-top:.5mm solid #000;direction:ltr}
.lbl-wil{flex:none;width:23mm;align-self:flex-start;background:#000;color:#fff;border-radius:1.8mm;padding:2mm 1mm 1.8mm;display:flex;flex-direction:column;align-items:center;text-align:center}
.lbl-wil b{font-size:29pt;font-weight:900;line-height:1;direction:ltr}
.lbl-wil span{margin-top:.8mm;font-size:7.5pt;font-weight:800;text-transform:uppercase;line-height:1.15;overflow-wrap:anywhere}
.lbl-who{flex:1;min-width:0;display:flex;flex-direction:column;gap:.5mm}
[dir="rtl"] .lbl-who{direction:rtl}
.lbl-name{font-size:16pt;font-weight:900;line-height:1.1}
.lbl-ph{font-size:14.5pt;font-weight:800}
.lbl-com{font-size:12pt;font-weight:800}
.lbl-adr{font-size:10pt;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lbl-mode{align-self:flex-start;margin-top:.8mm;border:.5mm solid #000;border-radius:1mm;padding:.3mm 1.8mm;font-size:8.5pt;font-weight:900;letter-spacing:.04em}
.lbl-mode.desk{background:#000;color:#fff}
.lbl-s{margin-top:2.4mm;padding-top:2mm;border-top:.5mm solid #000}
.lbl-it{margin-top:.6mm;font-size:10.5pt;line-height:1.3;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.lbl-note{margin-top:1.2mm;font-size:10pt;font-weight:800}
.lbl-cod{margin-top:auto;display:flex;align-items:stretch;border:.7mm solid #000;border-radius:1.8mm;overflow:hidden}
.lbl-cod span{flex:none;display:flex;align-items:center;background:#000;color:#fff;padding:0 3mm;font-size:9.5pt;font-weight:900;letter-spacing:.03em;text-transform:uppercase}
.lbl-cod b{flex:1;padding:1mm 3mm;text-align:end;font-size:21pt;font-weight:900;white-space:nowrap;direction:ltr;unicode-bidi:isolate}
[dir="rtl"] .lbl-cod b{text-align:left}
.lbl-bc{margin:2.4mm -1mm 1mm;direction:ltr}
.lbl-bc svg{display:block;width:100%;height:16mm}
.lbl-code{text-align:center;font:800 11pt/1 "Courier New",Courier,monospace;letter-spacing:.1em;direction:ltr}
.lbl-f{display:flex;align-items:center;justify-content:space-between;gap:2mm;margin-top:2mm;padding-top:1.4mm;border-top:.3mm solid #000;font-size:8pt}
.lbl-f span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lbl-f b{font-size:9.5pt}
.lbl-f .lbl-sav{flex:none}`;

/** The label of one parcel. */
function labelHtml(t: TFunction, z: Zx, o: Order, code: string, shop: LabelShop): string {
  const e = escapeHtml;
  const items = o.items.map((i) => `${i.qty} × ${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''}`).join(' + ');
  const pieces = o.items.reduce((n, i) => n + i.qty, 0);
  const phones = [o.phone, o.phone2].filter((p): p is string => !!p).map(phone).join(' · ');
  return `<section class="lbl" dir="${i18n.dir()}">
<div class="lbl-top"><div class="lbl-id">
<div class="lbl-co">${e(o.companyName ?? '')}${o.livreurName ? `<small>${e(t('depot.labels.livreur', { name: o.livreurName }))}</small>` : ''}</div>
<div class="lbl-k">${e(t('depot.labels.tracking'))}</div>
<div class="lbl-trk">${e(code)}</div>
<div class="lbl-ref">${e(t('depot.labels.order'))} <b>${e(o.ref)}</b> · ${e(dateOnly(o.createdAt))}</div>
</div><div class="lbl-qr">${qrSvg(z, code)}</div></div>
${o.savRef ? `<div class="lbl-ex"><b>${e(t('depot.labels.exchange', { ref: o.savRef }))}</b><span>${e(t('depot.labels.exchangeHint'))}</span></div>` : ''}
<div class="lbl-to"><div class="lbl-wil"><b>${String(o.wilayaId).padStart(2, '0')}</b><span>${e(wilayaName(o.wilayaId))}</span></div>
<div class="lbl-who"><div class="lbl-k">${e(t('depot.labels.to'))}</div>
<div class="lbl-name">${e(o.customerName)}</div>
<div class="lbl-ph"><bdi dir="ltr">${e(phones)}</bdi></div>
${o.commune ? `<div class="lbl-com">${e(o.commune)}</div>` : ''}
${o.address ? `<div class="lbl-adr">${e(o.address)}</div>` : ''}
<span class="lbl-mode${o.isStopdesk ? ' desk' : ''}">${e(o.isStopdesk ? t('depot.labels.desk') : t('depot.labels.home'))}</span></div></div>
<div class="lbl-s"><div class="lbl-k">${e(t('depot.labels.itemsN', { count: pieces }))}</div><div class="lbl-it">${e(items || '—')}</div>
${o.deliveryNote ? `<div class="lbl-note">${e(t('depot.labels.note'))} : ${e(o.deliveryNote)}</div>` : ''}</div>
<div class="lbl-cod"><span>${e(t('depot.labels.collect'))}</span><b>${e(da(o.total))}</b></div>
<div class="lbl-bc">${code128Svg(code)}</div>
<div class="lbl-code">${e(code)}</div>
<div class="lbl-f"><span>${e(t('depot.labels.fromShort'))} <b>${e(shop.name)}</b></span>${shop.sav ? `<span class="lbl-sav">${e(t('depot.labels.savPhone'))} <b><bdi dir="ltr">${e(phone(shop.sav))}</bdi></b></span>` : ''}</div>
</section>`;
}

/** Prints the labels of the parcels that have one; returns how many were printed and how many were left out. */
export async function printLabels(t: TFunction, orders: Order[], kindOf: (companyId: number) => string | undefined, shop: LabelShop): Promise<{ printed: number; skipped: number }> {
  // by delivery company, so the labels of one courier come out together
  const ready = orders
    .flatMap((o) => {
      const s = labelState(o, o.companyId ? kindOf(o.companyId) : undefined);
      return s.ok ? [{ o, code: s.code }] : [];
    })
    .sort((a, b) => (a.o.companyName ?? '').localeCompare(b.o.companyName ?? '') || a.o.ref.localeCompare(b.o.ref, undefined, { numeric: true }));
  if (ready.length) {
    const z = await loadQr();
    printHtml(t('depot.labels.docTitle', { n: ready.length }), `<style>${LABEL_CSS}</style>${ready.map((r) => labelHtml(t, z, r.o, r.code, shop)).join('')}`);
  }
  return { printed: ready.length, skipped: orders.length - ready.length };
}
