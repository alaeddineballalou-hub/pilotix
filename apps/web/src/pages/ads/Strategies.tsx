// Marketing › Stratégies: the seller gives each product its type for the ads (1 his own product, 2 like a
// competitor's, 3 exactly a competitor's), and Pilotix shows the video formats that fit that type best (core:
// strat.*, the formats library is the control room's, platform/credits.ts). Espace créateur makes the videos.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { FunnelStage, saveBrief } from '../createur/brief';

type Type = 1 | 2 | 3;
const TYPES: Type[] = [1, 2, 3];
const STAGES: FunnelStage[] = ['top', 'middle', 'bottom'];
const K = 'strat.';

export function Strategies() {
  const { t } = useTranslation();
  const q = useRpc('strat.state', {});
  const setType = useAction('strat.setType', { silent: false });
  const [pick, setPick] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'none' | Type>('all');
  const [stage, setStage] = useState<FunnelStage>('top');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const { session } = useSession();

  const data = q.data;
  const products = useMemo(() => {
    const all = data?.products ?? [];
    return filter === 'all' ? all : filter === 'none' ? all.filter((p) => p.type === null) : all.filter((p) => p.type === filter);
  }, [data, filter]);

  const cur0 = data ? (data.products.find((p) => p.id === pick) ?? products[0] ?? data.products[0]) : undefined;
  const recKeys = cur0?.type && data ? (data.byStage[`${cur0.type}-${stage}`] ?? []) : [];
  const recSig = `${cur0?.id}-${cur0?.type}-${stage}-${recKeys.join(',')}`;
  // a new product, type or stage: the 3 best formats are ticked
  useEffect(() => setChosen(new Set(recKeys.slice(0, 3))), [recSig]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!data) return <Loading />;
  if (!data.products.length) return <Empty>{t(K + 'noProducts')}</Empty>;

  const cur = data.products.find((p) => p.id === pick) ?? products[0] ?? data.products[0];
  const missing = data.products.filter((p) => p.type === null).length;
  const recs = recKeys.map((k) => data.formats.find((f) => f.key === k)!).filter(Boolean);
  const send = () => {
    const formats = recs.filter((f) => chosen.has(f.key)).map((f) => f.key);
    saveBrief(String(session?.shop?.id ?? 0), { productId: cur.id, stage, formats });
    location.hash = '/createur';
  };

  return (
    <div className="st">
      <section className="card st-intro">
        <h2>{t(K + 'title')}</h2>
        <p className="muted">{t(K + 'intro')}</p>
        <div className="st-types">
          {TYPES.map((n) => (
            <div key={n} className={`st-type t${n}`}>
              <b>{t(K + `type.${n}`)}</b>
              <small>{t(K + `typeHelp.${n}`)}</small>
            </div>
          ))}
        </div>
      </section>

      <div className="st-two">
        <section className="card st-list">
          <div className="st-filter" role="tablist">
            {(['all', 'none', 1, 2, 3] as const).map((f) => (
              <button key={String(f)} type="button" role="tab" aria-selected={filter === f} className={`st-chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? t(K + 'all') : f === 'none' ? t(K + 'none', { n: missing }) : t(K + `short.${f}`)}
              </button>
            ))}
          </div>
          {!products.length ? (
            <p className="muted small">{t(K + 'emptyFilter')}</p>
          ) : (
            <ul className="st-products">
              {products.map((p) => (
                <li key={p.id}>
                  <button type="button" className={`st-product${p.id === cur.id ? ' on' : ''}`} onClick={() => setPick(p.id)}>
                    {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <span className="st-ph" aria-hidden="true"><Icon name="layers" /></span>}
                    <span className="st-pn">
                      <b>{p.name}</b>
                      <small>{da(p.price)}</small>
                    </span>
                    <span className={`st-badge${p.type ? ` t${p.type}` : ' none'}`}>{p.type ? t(K + `short.${p.type}`) : t(K + 'noType')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card st-detail">
          <h3>{cur.name}</h3>
          <p className="lab">{t(K + 'whichType')}</p>
          <div className="st-pick">
            {TYPES.map((n) => (
              <button
                key={n}
                type="button"
                className={`st-pickbtn t${n}${cur.type === n ? ' on' : ''}`}
                aria-pressed={cur.type === n}
                disabled={setType.isPending}
                onClick={() => setType.mutate({ id: cur.id, type: cur.type === n ? null : n })}
              >
                <b>{t(K + `type.${n}`)}</b>
                <small>{t(K + `typeHelp.${n}`)}</small>
              </button>
            ))}
          </div>

          {cur.type ? (
            <>
              <p className="lab st-lab2">{t(K + 'whichStage')}</p>
              <div className="st-pick">
                {STAGES.map((n) => (
                  <button key={n} type="button" className={`st-pickbtn st-stage${stage === n ? ' on' : ''}`} aria-pressed={stage === n} onClick={() => setStage(n)}>
                    <b>{t(K + `stage.${n}`)}</b>
                    <small>{t(K + `stageHelp.${n}`)}</small>
                  </button>
                ))}
              </div>
              <h4 className="st-rech">
                <Icon name="check" /> {t(K + 'recs', { n: recs.length })}
              </h4>
              <p className="muted small">
                {t(K + `why.${cur.type}`)} {t(K + `stageWhy.${stage}`)}
              </p>
              {recs.length ? (
                <ol className="st-recs">
                  {recs.map((f, i) => (
                    <li key={f.key} className={`st-rec${chosen.has(f.key) ? ' top' : ''}`}>
                      <input
                        type="checkbox"
                        className="st-tick"
                        aria-label={f.name}
                        checked={chosen.has(f.key)}
                        onChange={(e) =>
                          setChosen((o) => {
                            const n = new Set(o);
                            if (e.target.checked) n.add(f.key);
                            else n.delete(f.key);
                            return n;
                          })
                        }
                      />
                      <span className="st-n">{i + 1}</span>
                      <span className="st-rt">
                        <b>{f.name}</b>
                        <small>{f.desc}</small>
                        <span className="st-tags">
                          {i < 3 && <span className="st-tag best">{t(K + 'best')}</span>}
                          {f.trend && <span className="st-tag trend">{t(K + 'trend')}</span>}
                          {f.credits > 0 && <span className="st-tag paid">{t(K + 'credits', { n: f.credits })}</span>}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted small">{t(K + 'noRecs')}</p>
              )}
              <div className="st-send">
                <button type="button" className="btn primary" disabled={!chosen.size} onClick={send}>
                  <Icon name="film" /> {t(K + 'send', { n: chosen.size })}
                </button>
                <small className="muted">{t(K + 'sendHelp')}</small>
              </div>
            </>
          ) : (
            <p className="st-hint">{t(K + 'chooseFirst')}</p>
          )}
        </section>
      </div>
    </div>
  );
}
