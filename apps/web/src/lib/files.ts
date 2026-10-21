/**
 * CSV export (opens correctly in Excel: UTF-8 BOM and ";" separator, like the original app),
 * and printing (picking sheet, delivery slips, route sheet).
 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const PRINT_CSS = `body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12px;margin:12mm;color:#111}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:14px 0 6px}.muted{color:#666}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #bbb;padding:5px 6px;text-align:left;vertical-align:top}
th{background:#f1f3f7}.num{text-align:right}.slip{page-break-inside:avoid;border:1px dashed #999;padding:10px;margin-bottom:10px}
.big{font-size:16px;font-weight:700}@media print{.noprint{display:none}}`;

/**
 * Prints an HTML document. Uses a hidden frame (works in browsers and the phone apps);
 * if printing is blocked, the document is shown in a new tab instead.
 */
export function printHtml(title: string, bodyHtml: string) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${bodyHtml}</body></html>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.append(frame);
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      const w = window.open('', '_blank');
      w?.document.write(html);
      w?.document.close();
    }
    setTimeout(() => frame.remove(), 60_000);
  }, 300);
}

export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
