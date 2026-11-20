// Clients › « Importer des clients » (admin): customers from the shop's old database (another app, an Excel file…) WITH
// their history there, so their score and level show at once instead of « Nouveau ». The file is read here (SheetJS, loaded
// only when the dialog needs it): the columns are found by their names (French, English or Arabic), the numbers
// checked, the levels shown with the shop's own points; then the server writes it in parts of 1,000 lines.
// Two kinds of file: the list of clients (one line per client, with Livrées, Refusées…), or ALL the orders of the old
// app (one line per order, with its status): then each client's history is counted here, order by order.
import { CLIENT_LEVELS, normalizePhone, normalizeScoreRules, scoreClient, WILAYAS, WILAYAS_AR, type ClientLevel } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc, type In } from '../../lib/backend';
import { n, wilayaName } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { Icon, Loading } from '../../ui/kit';
import { ScoreChip } from '../../ui/clientScore';
import { Modal } from '../../ui/modal';
import './import.css';

type Line = In<'customers.import'>['rows'][number];
type Field = 'phone' | 'name' | 'wilaya' | 'orders' | 'delivered' | 'returned' | 'fake' | 'cancelled' | 'lastOrder' | 'blacklist';
const FIELDS: Field[] = ['phone', 'name', 'wilaya', 'orders', 'delivered', 'returned', 'fake', 'cancelled', 'lastOrder', 'blacklist'];
const HISTORY: Field[] = ['delivered', 'returned', 'fake', 'cancelled'];
/** one call takes 1,000 lines at most (core: IMPORT_CUSTOMERS_MAX) */
const PART = 1000;
const MAX_ROWS = 100_000;

/** "Livrées" → "livrees": accents, Arabic vowel marks, case, spaces and punctuation do not count */
const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ًͯ-ٰٟ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
// the headers in French, English and Arabic (another app's export, Pilotix's own template, a shop's own sheet)
const ALIASES: Record<Field, string[]> = {
  phone: ['Téléphone', 'Tél', 'Tel', 'Numéro', 'Numéro de téléphone', 'Phone', 'Phone number', 'Mobile', 'رقم الهاتف', 'الهاتف', 'الرقم'],
  name: ['Nom', 'Nom du client', 'Client', 'Nom complet', 'Name', 'Customer', 'Customer name', 'Full name', 'الاسم', 'اسم الزبون', 'الزبون'],
  wilaya: ['Wilaya', 'Province', 'State', 'Ville', 'City', 'الولاية'],
  orders: ['Commandes', 'Nombre de commandes', 'Orders', 'Total orders', 'الطلبات', 'عدد الطلبات'],
  delivered: ['Livrées', 'Livrés', 'Livrée', 'Livré', 'Colis livrés', 'Delivered', 'المستلمة', 'تم التوصيل'],
  returned: ['Refusées', 'Refusés', 'Refusée', 'Refusé', 'Retours', 'Retournées', 'Retourné', 'Refused', 'Returned', 'Returns', 'المرفوضة', 'المرتجعة'],
  fake: ['Fausses', 'Fausses commandes', 'Fausse commande', 'Faux numéro', 'Fake', 'Fake orders', 'المزيفة', 'طلبات مزيفة'],
  cancelled: ['Annulées', 'Annulés', 'Annulée', 'Annulé', 'Cancelled', 'Canceled', 'الملغاة'],
  lastOrder: ['Dernière commande', 'Dernière', 'Last order', 'Last order date', 'آخر طلب'],
  blacklist: ['Liste noire', 'Blacklist', 'Blacklisted', 'Bloqué', 'القائمة السوداء'],
};
const BY_HEADER = new Map(FIELDS.flatMap((f) => ALIASES[f].map((a) => [norm(a), f] as const)));

// an orders file: one line per order; its status says what became of it (one « Statut » column, or two)
type OrderField = 'conf' | 'follow' | 'status' | 'date';
const ORDER_ALIASES: Record<OrderField, string[]> = {
  conf: ['Statut confirmation', 'Statut de confirmation', 'État confirmation', 'Confirmation', 'Confirmation status', 'حالة التأكيد', 'التأكيد'],
  follow: [
    'Statut livraison',
    'Statut de livraison',
    'État livraison',
    'Statut suivi',
    'Livraison',
    'Delivery status',
    'Follow status',
    'Shipping status',
    'حالة التوصيل',
    'حالة الشحن',
  ],
  status: ['Statut', 'État', 'Status', 'Statut de la commande', 'Order status', 'الحالة', 'حالة الطلب'],
  date: ['Date', 'Date de commande', 'Date commande', 'Créée le', 'Date de création', 'Created at', 'Order date', 'تاريخ الطلب', 'التاريخ'],
};
const BY_ORDER_HEADER = new Map((Object.keys(ORDER_ALIASES) as OrderField[]).flatMap((f) => ORDER_ALIASES[f].map((a) => [norm(a), f] as const)));
/** « Livrée - Encaissée » → " livree encaissee ": accents and marks off, words kept apart */
const words = (v: unknown) =>
  ` ${cell(v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
const said = (w: string, list: string[]) => list.some((x) => w.includes(` ${x} `));
// what a status says, in French, English and Arabic (the words of the Algerian apps and couriers)
const DELIVERED = ['livre', 'livree', 'livres', 'livrees', 'delivered', 'exchanged', 'encaisse', 'encaissee', 'مستلم', 'مستلمة', 'تم التسليم', 'تم التوصيل'];
const NOT_DELIVERED = ['non livre', 'non livree', 'pas livre', 'pas livree', 'not delivered', 'undelivered', 'غير مستلم', 'لم يتم التسليم'];
const RETURNED = [
  'retour',
  'retours',
  'retourne',
  'retournee',
  'returned',
  'returning',
  'refuse',
  'refusee',
  'refused',
  'rejete',
  'rejetee',
  'rejected',
  'مرتجع',
  'مرتجعة',
  'مرفوض',
  'مرفوضة',
  'ارجاع',
  'إرجاع',
];
const FAKE = ['faux', 'fausse', 'fake', 'wrong number', 'faux numero', 'numero errone', 'mauvais numero', 'مزيف', 'مزيفة', 'رقم خاطئ'];
const CANCELLED = ['annule', 'annulee', 'annules', 'annulees', 'cancelled', 'canceled', 'ملغى', 'ملغاة', 'ملغي', 'الغاء', 'إلغاء'];
/** what became of one order: Pilotix's own rule (delivered / refused from the parcel, fake / cancelled from the call) */
const outcome = (conf: string, follow: string) => {
  const c = words(conf),
    f = words(follow);
  const fake = said(c, FAKE);
  const kept = !said(f, NOT_DELIVERED);
  const returned = kept && said(f, RETURNED);
  return {
    fake,
    cancelled: !fake && said(c, CANCELLED),
    returned,
    delivered: kept && !returned && said(f, DELIVERED),
  };
};
const WILAYA_BY_NAME = new Map<string, number>([
  ...WILAYAS.map((w, k) => [norm(w), k + 1] as const),
  ...Object.entries(WILAYAS_AR).map(([k, w]) => [norm(w), Number(k)] as const),
]);

const cell = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v).trim());
const count = (v: unknown) => {
  const x = typeof v === 'number' ? v : Number(cell(v).replace(',', '.'));
  return Number.isFinite(x) && x > 0 ? Math.min(100_000, Math.round(x)) : 0;
};
/** « 16 Alger », « 16 », « Alger », « الجزائر » → 16 */
const wilayaOf = (v: unknown): number | null => {
  const s = cell(v);
  const code = /^\s*(\d{1,2})(?!\d)/.exec(s);
  const id = code ? Number(code[1]) : (WILAYA_BY_NAME.get(norm(s.replace(/^\d+\s*[-–.]?\s*/, ''))) ?? null);
  return id && id >= 1 && id <= WILAYAS.length ? id : null;
};
/** a date cell (Excel), « 2026-11-08 » or « 08/11/2026 » (day first, as in Algeria) */
const dateOf = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = cell(v);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  const t = dmy ? Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])) : Date.parse(s);
  return s && Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const yes = (v: unknown) => ['oui', 'yes', 'true', 'vrai', '1', 'x', 'نعم'].includes(norm(v));

type Parsed = {
  file: string;
  /** a list of clients, or all the orders of the old app (each client's history counted here) */
  kind: 'clients' | 'orders';
  /** the orders read, for an orders file */
  orders: number;
  /** one line per number (the same number twice: its last line counts) */
  rows: Line[];
  lines: number;
  invalid: number[];
  doubles: number;
  history: boolean;
  ignored: string[];
};
async function readSheet(file: File): Promise<Parsed | { error: string; args?: Record<string, string | number> }> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), {
    type: 'array',
    cellDates: true,
  });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws?.['!ref']) return { error: 'empty' };
  const first = XLSX.utils.decode_range(ws['!ref']).s.r;
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: true,
  });
  const blank = (r: unknown[]) => !r.some((c) => cell(c) !== '');
  const h = grid.findIndex((r) => !blank(r));
  if (h < 0) return { error: 'empty' };
  const cols = new Map<Field, number>();
  const ocols = new Map<OrderField, number>();
  const ignored: string[] = [];
  grid[h].forEach((c, k) => {
    const f = BY_HEADER.get(norm(c));
    const o = BY_ORDER_HEADER.get(norm(c));
    if (f && !cols.has(f)) cols.set(f, k);
    else if (o && !ocols.has(o)) ocols.set(o, k);
    else if (cell(c)) ignored.push(cell(c));
  });
  if (!cols.has('phone')) return { error: 'missingPhone' };
  const at = (r: unknown[], f: Field) => (cols.has(f) ? r[cols.get(f)!] : null);
  const ot = (r: unknown[], f: OrderField) => (ocols.has(f) ? cell(r[ocols.get(f)!]) : '');
  // no count of delivered / refused…, but a status: one line per order
  const isOrders = !HISTORY.some((f) => cols.has(f)) && (ocols.has('conf') || ocols.has('follow') || ocols.has('status'));
  if (isOrders) return readOrders(grid, h, first, at, ot, file.name, ignored);
  const byPhone = new Map<string, Line>();
  const invalid: number[] = [];
  let lines = 0;
  grid.slice(h + 1).forEach((r, k) => {
    if (blank(r)) return;
    lines++;
    const phone = normalizePhone(cell(at(r, 'phone')));
    if (!phone) return void invalid.push(first + h + k + 2);
    byPhone.set(phone, {
      phone,
      name: cell(at(r, 'name')).slice(0, 120),
      wilayaId: wilayaOf(at(r, 'wilaya')),
      orders: count(at(r, 'orders')),
      delivered: count(at(r, 'delivered')),
      returned: count(at(r, 'returned')),
      fake: count(at(r, 'fake')),
      cancelled: count(at(r, 'cancelled')),
      lastOrderAt: dateOf(at(r, 'lastOrder')),
      blacklisted: yes(at(r, 'blacklist')),
    });
  });
  if (!lines) return { error: 'empty' };
  if (lines > MAX_ROWS) return { error: 'tooMany', args: { n: lines, max: MAX_ROWS } };
  const rows = [...byPhone.values()];
  return {
    file: file.name,
    kind: 'clients',
    orders: 0,
    rows,
    lines,
    invalid,
    doubles: lines - invalid.length - rows.length,
    history: HISTORY.some((f) => cols.has(f)),
    ignored,
  };
}

/** An orders file: each client's history counted from their orders (the newest order gives the name and wilaya). */
function readOrders(
  grid: unknown[][],
  h: number,
  first: number,
  at: (r: unknown[], f: Field) => unknown,
  ot: (r: unknown[], f: OrderField) => string,
  file: string,
  ignored: string[],
): Parsed | { error: string; args?: Record<string, string | number> } {
  const byPhone = new Map<string, Line>();
  const invalid: number[] = [];
  let lines = 0;
  grid.slice(h + 1).forEach((r, k) => {
    if (!r.some((c) => cell(c) !== '')) return;
    lines++;
    const phone = normalizePhone(cell(at(r, 'phone')));
    if (!phone) return void invalid.push(first + h + k + 2);
    const one = ot(r, 'status');
    const o = outcome(ot(r, 'conf') || one, ot(r, 'follow') || one);
    const day = dateOf(at(r, 'lastOrder') ?? ot(r, 'date')) ?? dateOf(ot(r, 'date'));
    const c = byPhone.get(phone) ?? {
      phone,
      name: '',
      wilayaId: null,
      orders: 0,
      delivered: 0,
      returned: 0,
      fake: 0,
      cancelled: 0,
      lastOrderAt: null,
      blacklisted: false,
    };
    c.orders = (c.orders ?? 0) + 1;
    if (o.delivered) c.delivered = (c.delivered ?? 0) + 1;
    if (o.returned) c.returned = (c.returned ?? 0) + 1;
    if (o.fake) c.fake = (c.fake ?? 0) + 1;
    if (o.cancelled) c.cancelled = (c.cancelled ?? 0) + 1;
    if (yes(at(r, 'blacklist'))) c.blacklisted = true;
    const newer = !!day && (!c.lastOrderAt || day > c.lastOrderAt);
    if (newer) c.lastOrderAt = day;
    const name = cell(at(r, 'name')).slice(0, 120);
    const wilayaId = wilayaOf(at(r, 'wilaya'));
    if (name && (newer || !c.name)) c.name = name;
    if (wilayaId && (newer || !c.wilayaId)) c.wilayaId = wilayaId;
    byPhone.set(phone, c);
  });
  if (!lines) return { error: 'empty' };
  if (lines > MAX_ROWS) return { error: 'tooMany', args: { n: lines, max: MAX_ROWS } };
  return {
    file,
    kind: 'orders',
    orders: lines - invalid.length,
    rows: [...byPhone.values()],
    lines,
    invalid,
    doubles: 0,
    history: true,
    ignored,
  };
}

type Done = {
  added: number;
  updated: number;
  invalid: number;
  blacklisted: number;
  shared: string[];
};

export function ImportClients({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const rules = useRpc('clientscore.rules', {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<Parsed | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const col = (f: Field) => t(`clients.import.cols.${f}`);

  // the level each customer will have, with the shop's own points (Pilotix's orders of a known number add to it)
  const levelOf = useMemo(() => {
    const R = normalizeScoreRules(rules.data?.rules);
    return (r: Line) =>
      scoreClient(
        {
          delivered: r.delivered ?? 0,
          returned: r.returned ?? 0,
          fake: r.fake ?? 0,
          cancelled: r.cancelled ?? 0,
          blocked: 0,
          review: 0,
          markFake: 0,
          markCompetitor: 0,
          network: null,
          blacklisted: !!r.blacklisted,
          blacklistAuto: false,
          stopdeskOnly: false,
        },
        R,
      );
  }, [rules.data]);
  const levels = useMemo(() => {
    const c = Object.fromEntries(CLIENT_LEVELS.map((l) => [l, 0])) as Record<ClientLevel, number>;
    for (const r of data?.rows ?? []) c[levelOf(r).level]++;
    return c;
  }, [data, levelOf]);

  const template = async () => {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([
      FIELDS.map(col),
      ['0661 23 45 67', 'Amina B.', '16 Alger', 3, 2, 0, 0, 1, '2026-10-30', ''],
      ['0770 98 76 54', 'Karim D.', '31 Oran', 2, 0, 1, 1, 0, '2026-09-12', ''],
    ]);
    ws['!cols'] = FIELDS.map((f) => ({
      wch: f === 'name' || f === 'phone' || f === 'lastOrder' ? 18 : 12,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Clients');
    const blob = new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'modele-import-clients.xlsx';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setData(null);
    try {
      const r = await readSheet(file);
      if ('error' in r) setErr(t(`clients.import.err_${r.error}`, r.args));
      else setData(r);
    } catch (e) {
      setErr(t('clients.import.err_read', { msg: (e as Error).message }));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  // in parts of 1,000 lines; a part that fails stops here (importing again is safe: the old history is replaced)
  const run = async () => {
    if (!data) return;
    const sum: Done = {
      added: 0,
      updated: 0,
      invalid: 0,
      blacklisted: 0,
      shared: [],
    };
    setErr(null);
    setSent(0);
    try {
      for (let k = 0; k < data.rows.length; k += PART) {
        const r = await rpc('customers.import', {
          source: data.file.slice(0, 120),
          rows: data.rows.slice(k, k + PART),
        });
        sum.added += r.added;
        sum.updated += r.updated;
        sum.invalid += r.invalid;
        sum.blacklisted += r.blacklisted;
        sum.shared = [...new Set([...sum.shared, ...r.shared])];
        setSent(Math.min(data.rows.length, k + PART));
      }
      setDone(sum);
    } catch (e) {
      setErr(
        t('clients.import.err_part', {
          done: n(sum.added + sum.updated),
          msg: (e as Error).message,
        }),
      );
    } finally {
      setSent(null);
      qc.invalidateQueries();
    }
  };

  const sending = sent !== null;
  return (
    <Modal
      wide
      title={t('clients.import.title')}
      onClose={sending ? () => undefined : onClose}
      footer={
        done ? (
          <button className="btn primary" onClick={onClose}>
            {t('clients.import.see')}
          </button>
        ) : (
          <>
            <button className="btn" disabled={sending} onClick={onClose}>
              {t('common.cancel')}
            </button>
            {data && (
              <button className="btn" disabled={busy || sending} onClick={() => input.current?.click()}>
                {t('clients.import.other')}
              </button>
            )}
            {data && (
              <button className="btn primary" disabled={!data.rows.length || busy || sending} onClick={run}>
                <Icon name="upload" />
                {t('clients.import.confirm', {
                  count: data.rows.length,
                  n: n(data.rows.length),
                })}
              </button>
            )}
          </>
        )
      }
    >
      <div className="ci">
        <input
          ref={input}
          type="file"
          hidden
          accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        {!data && !done && (
          <>
            <p className="ci-intro">{t('clients.import.intro')}</p>
            <div className="ci-cols">
              {FIELDS.map((f) => (
                <span key={f} className={`chip${f === 'phone' ? ' req' : ''}`}>
                  {col(f)}
                  {f === 'phone' && ' *'}
                </span>
              ))}
            </div>
            <p className="ci-note">{t('clients.import.ordersFile')}</p>
            <p className="ci-note">{t('clients.import.rules')}</p>
            <div className="ci-pick">
              <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>
                <Icon name="upload" />
                {t('clients.import.pick')}
              </button>
              <button className="btn" onClick={template}>
                <Icon name="download" />
                {t('clients.import.template')}
              </button>
            </div>
          </>
        )}
        {busy && <Loading />}
        {err && (
          <p className="ci-err" role="alert">
            {err}
          </p>
        )}
        {done && (
          <div className="ci-sum ok" role="status">
            <Icon name="checkcircle" />
            <span>
              <b>
                {t('clients.import.done', {
                  count: done.added + done.updated,
                  n: n(done.added + done.updated),
                })}
              </b>
              <small>
                {[
                  t('clients.import.doneSum', {
                    added: n(done.added),
                    updated: n(done.updated),
                  }),
                  done.blacklisted ? t('clients.import.doneBlack', { count: done.blacklisted }) : null,
                  done.shared.length ? t('clients.alsoIn', { list: done.shared.join(', ') }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </span>
          </div>
        )}
        {data && !done && (
          <>
            <div className="ci-sum" role="status">
              <Icon name="list" />
              <span>
                <b className="ltr">{data.file}</b>
                <small>
                  {[
                    data.kind === 'orders'
                      ? t('clients.import.sumOrders', {
                          count: data.rows.length,
                          orders: n(data.orders),
                          n: n(data.rows.length),
                        })
                      : t('clients.import.sumRows', {
                          count: data.rows.length,
                          n: n(data.rows.length),
                        }),
                    data.invalid.length
                      ? t('clients.import.sumInvalid', {
                          count: data.invalid.length,
                          n: n(data.invalid.length),
                        })
                      : null,
                    data.doubles
                      ? t('clients.import.sumDoubles', {
                          count: data.doubles,
                          n: n(data.doubles),
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </span>
            </div>
            {!data.history && <p className="ci-warn">{t('clients.import.noHistory')}</p>}
            <div className="ci-levels-t">{t('clients.import.levels')}</div>
            <div className="cs-levels ci-levels">
              {CLIENT_LEVELS.map((l) => (
                <span key={l} className={`cs-lvbtn cs-${l}`}>
                  <i aria-hidden="true" />
                  {t(`clients.score.level.${l}`)}
                  <b className="ltr">{n(levels[l])}</b>
                </span>
              ))}
            </div>
            {data.invalid.length > 0 && (
              <p className="ci-note">
                {t('clients.import.invalidLines', {
                  lines: data.invalid.slice(0, 12).join(', ') + (data.invalid.length > 12 ? '…' : ''),
                })}
              </p>
            )}
            {data.ignored.length > 0 && (
              <p className="ci-note">
                {t('clients.import.ignoredCols', {
                  cols: data.ignored.slice(0, 8).join(', ') + (data.ignored.length > 8 ? '…' : ''),
                })}
              </p>
            )}
            <div className="tbl-wrap ci-table">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('clients.col.client')}</th>
                    <th>{t('clients.score.col')}</th>
                    <th>{t('clients.col.phone')}</th>
                    <th>{t('clients.col.wilaya')}</th>
                    <th className="num">{col('delivered')}</th>
                    <th className="num">{col('returned')}</th>
                    <th className="num">{col('fake')}</th>
                    <th className="num">{col('cancelled')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.slice(0, 6).map((r) => (
                    <tr key={r.phone}>
                      <td data-l={t('clients.col.client')}>
                        <b>{r.name || '—'}</b>
                        {r.blacklisted && <span className="flag">{t('clients.black')}</span>}
                      </td>
                      <td data-l={t('clients.score.col')}>
                        <ScoreChip s={levelOf(r)} showNew />
                      </td>
                      <td data-l={t('clients.col.phone')}>
                        <span className="ltr">{r.phone}</span>
                      </td>
                      <td data-l={t('clients.col.wilaya')}>{r.wilayaId ? wilayaName(r.wilayaId) : '—'}</td>
                      <td className="num" data-l={col('delivered')}>
                        {n(r.delivered ?? 0)}
                      </td>
                      <td className="num" data-l={col('returned')}>
                        {n(r.returned ?? 0)}
                      </td>
                      <td className="num" data-l={col('fake')}>
                        {n(r.fake ?? 0)}
                      </td>
                      <td className="num" data-l={col('cancelled')}>
                        {n(r.cancelled ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.rows.length > 6 && <p className="ci-note">{t('clients.import.more', { n: n(data.rows.length - 6) })}</p>}
            {sending ? (
              <div className="ci-bar" role="progressbar" aria-valuemin={0} aria-valuemax={data.rows.length} aria-valuenow={sent ?? 0}>
                <i
                  style={{
                    width: `${Math.round(((sent ?? 0) / Math.max(1, data.rows.length)) * 100)}%`,
                  }}
                />
                <span>
                  {t('clients.import.sending', {
                    done: n(sent ?? 0),
                    total: n(data.rows.length),
                  })}
                </span>
              </div>
            ) : (
              <p className="ci-note">{t('clients.import.safe')}</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
