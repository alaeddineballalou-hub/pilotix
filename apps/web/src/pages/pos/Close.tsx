// Point de vente › Clôture: what the drawer should hold (its float + the cash sales), the notes and coins counted, the
// gap (it needs a note, and is written in the cash's caisse), the drawer opened again with its float; the last clôtures.
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, da, dateTime } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import type { Out } from '../../lib/backend';
import { longDay } from './Sales';

/** Algeria's notes and coins (200 DA is both); « 1 »: other coins, typed as one amount. */
const MONEY = [2000, 1000, 500, 200, 100, 50, 20, 10, 5] as const;
type Drawer = NonNullable<Out<'pos.drawer'>['open']>;

export function Close() {
  const q = useRpc('pos.drawer', {});
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  return (
    <div className="pos-close">
      {q.data.open ? (
        <Count d={q.data.open} last={<LastCloses rows={q.data.closed} />} />
      ) : (
        <>
          <OpenDrawer />
          <LastCloses rows={q.data.closed} />
        </>
      )}
    </div>
  );
}

function Count({ d, last }: { d: Drawer; last: ReactNode }) {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const close = useAction('pos.close', { success: t('pos.close.closedOk') });
  const qty = (k: string) => Math.max(0, Math.floor(Number(counts[k] || 0)) || 0);
  const counted = MONEY.reduce((s, v) => s + v * qty(String(v)), 0) + qty('1');
  const touched = Object.values(counts).some((v) => v !== '');
  const gap = counted - d.expected;
  const send = () => {
    const c: Record<string, number> = {};
    for (const k of [...MONEY.map(String), '1']) if (qty(k)) c[k] = qty(k);
    close.mutate({ counted, counts: c, note: note.trim() || undefined });
  };
  const label = (v: number) => (v >= 500 ? t('pos.close.note', { v: da(v) }) : v === 200 ? t('pos.close.note200', { v: da(v) }) : t('pos.close.coin', { v: da(v) }));
  return (
    <>
      <div className="pos-day-head">
        <div className="pos-grow">
          <h2>{longDay(0)}</h2>
          <p className="muted">{t('pos.close.openedBy', { time: clock(d.openedAt), by: d.who ?? '—', v: da(d.opening) })}</p>
        </div>
      </div>
      <div className="pos-close-grid">
        <div className="pos-close-left">
          <section className="card pos-drawer" aria-label={t('pos.close.drawer')}>
            <h2>
              <Icon name="wallet" />
              {t('pos.close.drawer')}
            </h2>
            <div className="pos-kv">
              <span>{t('pos.close.float')}</span>
              <b className="ltr">{da(d.opening)}</b>
            </div>
            <div className="pos-kv">
              <span>{t('pos.close.cashSales')}</span>
              <b className="ltr">{da(d.by.cash)}</b>
            </div>
            <div className="pos-kv pos-kv-big">
              <b>{t('pos.close.expected')}</b>
              <b className="ltr">{da(d.expected)}</b>
            </div>
            <div className="pos-kv muted">
              <span>{t('pos.close.notInDrawer')}</span>
              <span>
                {t('pos.method.baridimob')} <bdi className="ltr">{da(d.by.baridimob)}</bdi> · {t('pos.method.card')} <bdi className="ltr">{da(d.by.card)}</bdi>
              </span>
            </div>
            <div className="pos-kv muted">
              <span>{t('pos.close.salesOf')}</span>
              <span>
                {t('pos.sales.n', { count: d.sales })} · <span className="ltr">{da(d.total)}</span>
              </span>
            </div>
          </section>
          {last}
        </div>
        <section className="card pos-count" aria-label={t('pos.close.count')}>
          <h2>{t('pos.close.count')}</h2>
          <div className="pos-money">
            {MONEY.map((v) => (
              <label key={v} className="pos-money-r">
                <span>{label(v)}</span>
                <input type="text" inputMode="numeric" className="ltr" value={counts[v] ?? ''} placeholder="0" onChange={(e) => setCounts({ ...counts, [v]: e.target.value.replace(/\D/g, '').slice(0, 5) })} aria-label={label(v)} />
                <span className="ltr end">{qty(String(v)) ? da(v * qty(String(v))) : '—'}</span>
              </label>
            ))}
            <label className="pos-money-r">
              <span>{t('pos.close.other')}</span>
              <input type="text" inputMode="numeric" className="ltr" value={counts['1'] ?? ''} placeholder="0" onChange={(e) => setCounts({ ...counts, '1': e.target.value.replace(/\D/g, '').slice(0, 7) })} aria-label={t('pos.close.other')} />
              <span className="ltr end">{qty('1') ? da(qty('1')) : '—'}</span>
            </label>
          </div>
          <div className="pos-kv pos-kv-big">
            <b>{t('pos.close.counted')}</b>
            <b className="ltr">{da(counted)}</b>
          </div>
          {!touched ? (
            <p className="pos-note">
              <Icon name="info" />
              <span>{t('pos.close.howTo')}</span>
            </p>
          ) : gap === 0 ? (
            <p className="pos-note ok">
              <Icon name="check" />
              <span>{t('pos.close.right')}</span>
            </p>
          ) : (
            <p className={`pos-note ${gap < 0 ? 'warn' : ''}`}>
              <Icon name="alert" />
              <span>{gap < 0 ? t('pos.close.short', { v: da(-gap), e: da(d.expected) }) : t('pos.close.over', { v: da(gap), e: da(d.expected) })}</span>
            </p>
          )}
          <label className="pos-field">
            <span>
              {t('pos.close.noteLabel')}
              {gap !== 0 && touched && <span className="pos-req"> · {t('pos.close.needed')}</span>}
            </span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('pos.close.notePh')} maxLength={300} />
          </label>
          <button type="button" className="btn primary pos-pay" disabled={!touched || (gap !== 0 && !note.trim()) || close.isPending} onClick={send}>
            <Icon name="lock" />
            {t('pos.close.close')}
          </button>
          <p className="muted pos-help">{t('pos.close.help')}</p>
        </section>
      </div>
    </>
  );
}

function OpenDrawer() {
  const { t } = useTranslation();
  const [opening, setOpening] = useState('');
  const open = useAction('pos.open', { success: t('pos.close.openedOk') });
  return (
    <section className="card pos-opencard">
      <h2>
        <Icon name="lock" />
        {t('pos.close.closedTitle')}
      </h2>
      <p className="muted">{t('pos.close.closedText')}</p>
      <form
        className="pos-openform"
        onSubmit={(e) => {
          e.preventDefault();
          open.mutate({ opening: Number(opening || 0) });
        }}
      >
        <label className="pos-field">
          <span>{t('pos.close.float')}</span>
          <input type="text" inputMode="numeric" className="ltr" value={opening} placeholder="5000" onChange={(e) => setOpening(e.target.value.replace(/\D/g, '').slice(0, 8))} />
        </label>
        <button type="submit" className="btn primary" disabled={open.isPending}>
          {t('pos.close.open')}
        </button>
      </form>
      <p className="muted pos-help">{t('pos.close.floatHelp')}</p>
    </section>
  );
}

function LastCloses({ rows }: { rows: Out<'pos.drawer'>['closed'] }) {
  const { t } = useTranslation();
  if (!rows.length) return null;
  return (
    <section className="card">
      <h2>{t('pos.close.last')}</h2>
      <div className="pos-closes">
        {rows.map((r) => (
          <div key={r.id} className="pos-closes-r">
            <span className="pos-what">
              <b>{dateTime(r.closedAt)}</b>
              <small className="muted">
                {r.who ?? '—'} · {t('pos.sales.n', { count: r.sales })} · <span className="ltr">{da(r.total)}</span>
              </small>
              {r.note && <small className="muted">« {r.note} »</small>}
            </span>
            <span className="pos-closes-v">
              <small className="muted">
                {t('pos.close.expectedShort')} <span className="ltr">{da(r.expected)}</span> · {t('pos.close.countedShort')} <span className="ltr">{da(r.counted)}</span>
              </small>
              <span className={`pos-pill ${r.gap === 0 ? 'ok' : r.gap < 0 ? 'warn' : 'info'}`}>{r.gap === 0 ? t('pos.close.noGap') : <span className="ltr">{`${r.gap > 0 ? '+' : '−'}${da(Math.abs(r.gap))}`}</span>}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
