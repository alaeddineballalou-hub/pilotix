// Espace créateur: the products picked for the next test of the « Life ad circle » (Marketing › Stratégies), as videos to
// make before the « videos ready » day. Shown once the list was sent; someone who cannot see Stratégies sees nothing.
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';
import '../ads/ads.css';

const K = 'strat.circle.todo.';

export function CircleTodo({ onOpen }: { onOpen?: (id: number) => void }) {
  const { t, i18n } = useTranslation();
  // « le test de mardi »: a day inside a French sentence takes no capital
  const inText = (d: string) => (i18n.language.startsWith('fr') ? d.toLocaleLowerCase('fr') : d);
  const q = useRpc('strat.circle', {}, { retry: false });
  const done = useAction('strat.circleDone');
  const d = q.data;
  if (!d || !d.next.sentAt || !d.next.ids.length) return null;
  const list = d.next.ids.map((id) => d.products.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  const v = d.values;
  const day = typeof v.againVideoDay === 'number' ? inText(t(`strat.circle.day.${v.againVideoDay}`)) : '';
  const start = typeof v.testDay === 'number' ? inText(t(`strat.circle.day.${v.testDay}`)) : '';
  const ticked = new Set(d.next.done);
  return (
    <section className="card lc-todo">
      <h2>{t(K + 'title', { start })}</h2>
      <p className="lc-help">{t(K + 'help', { videos: v.testVideos, images: v.testImages, day })}</p>
      <p className="lc-count" aria-live="polite">
        <b>{t(K + 'progress', { done: d.next.done.length, n: list.length })}</b>
      </p>
      <ul className="lc-plist todo">
        {list.map((p) => (
          <li key={p.id} className={`lc-trow${ticked.has(p.id) ? ' done' : ''}`}>
            <label className="lc-prod">
              <input type="checkbox" className="lc-tick" checked={ticked.has(p.id)} disabled={done.isPending} onChange={(e) => done.mutate({ id: p.id, on: e.target.checked })} />
              {p.photo ? <img src={p.photo} alt="" /> : <span className="lc-ph" aria-hidden="true" />}
              <span className="lc-pn">
                {p.name}
                <small>{t(K + (ticked.has(p.id) ? 'isDone' : 'toDo'))}</small>
              </span>
            </label>
            {onOpen && (
              <button type="button" className="btn" onClick={() => onOpen(p.id)}>
                <Icon name="film" /> {t(K + 'open')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
