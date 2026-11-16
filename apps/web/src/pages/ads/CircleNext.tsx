// « Life ad circle » › Recommencer: the products of the NEXT test are picked a week early, then sent to Espace créateur,
// which shows them as videos to make (core: strat.circlePick / circleSend / circleClear).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction } from '../../lib/query';
import { Icon } from '../../ui/kit';

const K = 'strat.circle.next.';
export interface CircleProduct {
  id: number;
  name: string;
  photo: string | null;
}
export interface CircleNextState {
  ids: number[];
  sentAt: string | null;
  done: number[];
}

export function CircleNextPick({ products, next, perWeek }: { products: CircleProduct[]; next: CircleNextState; perWeek: number | null }) {
  const { t, i18n } = useTranslation();
  const [find, setFind] = useState('');
  const pick = useAction('strat.circlePick');
  const send = useAction('strat.circleSend', { success: t(K + 'sentOk') });
  const clear = useAction('strat.circleClear', { success: t(K + 'cleared') });
  const busy = pick.isPending || send.isPending || clear.isPending;
  const picked = useMemo(() => new Set(next.ids), [next.ids]);
  const shown = useMemo(() => {
    const f = find.trim().toLowerCase();
    return f ? products.filter((p) => p.name.toLowerCase().includes(f)) : products;
  }, [products, find]);
  const n = next.ids.length;

  return (
    <div className="lc-next">
      <h4>{t(K + 'title')}</h4>
      <p className="lc-help">{t(K + 'help')}</p>
      <p className="lc-count" aria-live="polite">
        <b>{perWeek ? t(K + 'countOf', { n, max: perWeek }) : t(K + 'count', { count: n })}</b>
        {perWeek !== null && n > perWeek && <span className="lc-over2"> {t(K + 'tooMany')}</span>}
      </p>
      {products.length > 8 && (
        <label className="lc-find">
          <span className="sr-only">{t(K + 'find')}</span>
          <input className="lc-in" value={find} placeholder={t(K + 'find')} onChange={(e) => setFind(e.target.value)} />
        </label>
      )}
      {products.length === 0 ? (
        <p className="muted small">{t(K + 'noProducts')}</p>
      ) : shown.length === 0 ? (
        <p className="muted small">{t(K + 'noMatch')}</p>
      ) : (
        <ul className="lc-plist">
          {shown.map((p) => (
            <li key={p.id}>
              <label className={`lc-prod${picked.has(p.id) ? ' on' : ''}`}>
                <input type="checkbox" className="lc-tick" checked={picked.has(p.id)} disabled={busy} onChange={(e) => pick.mutate({ id: p.id, on: e.target.checked })} />
                {p.photo ? <img src={p.photo} alt="" /> : <span className="lc-ph" aria-hidden="true" />}
                <span className="lc-pn">{p.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="lc-acts">
        <button type="button" className="btn primary" disabled={busy || n === 0} onClick={() => send.mutate({})}>
          <Icon name="film" /> {t(K + (next.sentAt ? 'sendAgain' : 'send'))}
        </button>
        {n > 0 && (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => clear.mutate({})}>
            {t(K + 'clear')}
          </button>
        )}
      </div>
      {next.sentAt && (
        <p className="lc-sent">
          <Icon name="check" /> {t(K + 'sentAt', { date: new Date(next.sentAt).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' }), done: next.done.length, n })}
        </p>
      )}
    </div>
  );
}
