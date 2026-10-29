// Sociétés de livraison › « Couverture »: where each company — and « Livraison privée » — delivers, wilaya by wilaya
// (the company's own list, then the seller's switches; switching on a wilaya without price warns), « À corriger »
// (communes written another way, prices missing) and « Mettre à jour maintenant » (tariffs and bureaus from the APIs,
// also every night). Pilot and the confirm check follow these switches.
import { communesOf, REGIONS } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../lib/i18n';
import type { Out } from '../../lib/backend';
import { da, when, wilaya, wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import './coverage.css';

type Co = Out<'coverage.get'>['companies'][number];
type W = Co['wilayas'][number];
const REGION_KEYS = ['ouest', 'centre', 'est', 'sud'] as const;

export function Coverage() {
  const { t } = useTranslation();
  const q = useRpc('coverage.get', {});
  const fix = useRpc('coverage.toFix', {});
  const [sel, setSel] = useState<number | null>(null);
  const set = useAction('coverage.set', { silent: false });
  const refresh = useAction('coverage.refresh', { success: (r) => t('livraison.cov.refreshed', { count: r.results.filter((x) => x.ok).length }) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const cos = [...q.data.companies.filter((c) => c.active && c.own), ...q.data.companies.filter((c) => c.active && !c.own)];
  const co = cos.find((c) => c.id === sel) ?? cos.find((c) => !c.own) ?? cos[0];
  if (!co) return <p className="muted">{t('livraison.cov.noCompany')}</p>;
  const name = (c: Co) => (c.own ? t('livraison.pilot.private') : c.name);
  const served = co.wilayas.filter((w) => w.served).length;
  const toggle = (w: W) => {
    if (w.served) set.mutate({ companyId: co.id, wilayas: [w.w], on: w.list ? false : null });
    else if (w.list) set.mutate({ companyId: co.id, wilayas: [w.w], on: null });
    else if (window.confirm(t('livraison.cov.askOn', { co: name(co), w: wilaya(w.w) }))) set.mutate({ companyId: co.id, wilayas: [w.w], on: true });
  };
  const region = (ids: number[], on: boolean) => {
    const ws = co.wilayas.filter((w) => ids.includes(w.w));
    const turn = ws.filter((w) => w.served !== on);
    if (!turn.length) return;
    // on: those of the company's list come back to it; the others are switched on (after the warning)
    if (on) {
      const back = turn.filter((w) => w.list).map((w) => w.w);
      const force = turn.filter((w) => !w.list).map((w) => w.w);
      if (back.length) set.mutate({ companyId: co.id, wilayas: back, on: null });
      if (force.length && window.confirm(t('livraison.cov.askOnMany', { co: name(co), count: force.length }))) set.mutate({ companyId: co.id, wilayas: force, on: true });
    } else set.mutate({ companyId: co.id, wilayas: turn.map((w) => w.w), on: false });
  };
  const changed = co.wilayas.filter((w) => w.on !== null).map((w) => w.w);
  const r = q.data.refresh;
  const f = fix.data;

  return (
    <div className="cv">
      <div className="cv-head">
        <div>
          <h2>{t('livraison.cov.title')}</h2>
          <p className="muted">{t('livraison.cov.help')}</p>
        </div>
        <div className="cv-ref">
          <button type="button" className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate({})}>
            <Icon name="refresh" /> {refresh.isPending ? t('livraison.cov.refreshing') : t('livraison.cov.refresh')}
          </button>
          <small className="muted">
            {r.at ? t('livraison.cov.lastAt', { when: when(r.at) }) : t('livraison.cov.never')} · {t('livraison.cov.nightly')}
          </small>
          {r.results.some((x) => !x.ok) && (
            <small className="cv-bad">
              {r.results
                .filter((x) => !x.ok)
                .map((x) => `${x.name} : ${x.error}`)
                .join(' · ')}
            </small>
          )}
        </div>
      </div>

      <div className="cv-cos" role="radiogroup" aria-label={t('livraison.cov.company')}>
        {cos.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={c.id === co.id} className={`cv-co${c.id === co.id ? ' on' : ''}${c.own ? ' own' : ''}`} onClick={() => setSel(c.id)}>
            <Icon name={c.own ? 'bike' : 'truck'} />
            <span>
              <b>{name(c)}</b>
              <small>{t('livraison.cov.count', { count: c.wilayas.filter((w) => w.served).length })}</small>
            </span>
          </button>
        ))}
      </div>

      <section className="cv-card">
        <div className="cv-card-h">
          <span>
            <b>{t('livraison.cov.where', { co: name(co) })}</b>
            <small>{co.free ? t('livraison.cov.freeHint') : t('livraison.cov.listHint')}</small>
          </span>
          <span className="cv-tot">{t('livraison.cov.served', { count: served, all: co.wilayas.length })}</span>
        </div>
        <ul className="cv-legend" aria-label={t('livraison.cov.legend')}>
          <li className="on">{t('livraison.cov.lOn')}</li>
          <li className="mine">{t('livraison.cov.lMine')}</li>
          <li className="warn">{t('livraison.cov.lWarn')}</li>
          <li className="off">{t('livraison.cov.lOff')}</li>
        </ul>
        {REGION_KEYS.map((k) => {
          const ws = co.wilayas.filter((w) => REGIONS[k].includes(w.w)).sort((a, b) => a.w - b.w);
          return (
            <div key={k} className="cv-reg">
              <div className="cv-reg-h">
                <b>{t(`livraison.pilot.regions.${k}`)}</b>
                <small>{t('livraison.cov.regCount', { n: ws.filter((w) => w.served).length, all: ws.length })}</small>
                <button type="button" className="cv-mini" onClick={() => region(REGIONS[k], true)}>
                  {t('livraison.cov.allOn')}
                </button>
                <button type="button" className="cv-mini" onClick={() => region(REGIONS[k], false)}>
                  {t('livraison.cov.allOff')}
                </button>
              </div>
              <div className="cv-grid">
                {ws.map((w) => {
                  const warn = w.served && !w.list;
                  const cls = !w.served ? 'off' : warn ? 'warn' : w.on === true ? 'mine' : 'on';
                  return (
                    <button
                      key={w.w}
                      type="button"
                      className={`cv-w ${cls}`}
                      aria-pressed={w.served}
                      title={warn ? t('livraison.cov.warnTip', { co: name(co) }) : undefined}
                      disabled={set.isPending}
                      onClick={() => toggle(w)}
                    >
                      <span className="cv-n ltr">{String(w.w).padStart(2, '0')}</span>
                      <span className="cv-name">{wilayaName(w.w)}</span>
                      <small className="ltr">{!w.served ? (w.list ? t('livraison.cov.offShort') : t('livraison.cov.noPrice')) : w.home ? da(w.home) : !w.list ? t('livraison.cov.noPrice') : co.free ? t('livraison.cov.free') : ''}</small>
                      {w.on !== null && <i className="cv-you" title={t('livraison.cov.byYou')} />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {changed.length > 0 && (
          <button type="button" className="btn small cv-reset" onClick={() => set.mutate({ companyId: co.id, wilayas: changed, on: null })}>
            <Icon name="undo" /> {t('livraison.cov.reset', { count: changed.length })}
          </button>
        )}
      </section>

      <section className="cv-card" aria-labelledby="cv-fix-h">
        <div className="cv-card-h">
          <span>
            <b id="cv-fix-h">
              <Icon name="alert" /> {t('livraison.cov.fixT')}
            </b>
            <small>{t('livraison.cov.fixHint')}</small>
          </span>
        </div>
        {!f ? (
          <Loading />
        ) : !f.communes.length && !f.prices.length ? (
          <p className="cv-ok">
            <Icon name="checkcircle" /> {t('livraison.cov.allGood')}
          </p>
        ) : (
          <>
            {f.communes.length > 0 && (
              <ul className="cv-fix">
                {f.communes.map((c) => (
                  <CommuneFix key={`${c.wilayaId}|${c.commune}`} c={c} />
                ))}
              </ul>
            )}
            {f.prices.length > 0 && (
              <ul className="cv-fix">
                {f.prices.map((p) => (
                  <li key={p.companyId} className="price">
                    <Icon name="coins" />
                    <span className="cv-fx-t">
                      <b>{p.name}</b>
                      <small>{p.none ? t('livraison.cov.noFees') : t('livraison.cov.missing', { list: p.wilayas.map((w) => wilaya(w)).join(', ') })}</small>
                    </span>
                    <a className="btn small" href="#/livraison/societes">
                      {t('livraison.cov.toPrices')}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function CommuneFix({ c }: { c: Out<'coverage.toFix'>['communes'][number] }) {
  const { t } = useTranslation();
  const [to, setTo] = useState(c.suggestion ?? '');
  const fix = useAction('coverage.fixCommune', { success: (r) => t('livraison.cov.fixed', { count: r.fixed, c: r.commune }) });
  return (
    <li>
      <Icon name="flag" />
      <span className="cv-fx-t">
        <b>
          « {c.commune} » · {wilaya(c.wilayaId)}
        </b>
        <small>{t('livraison.cov.orders', { count: c.count })}</small>
      </span>
      <label className="cv-fx-sel">
        <span className="sr-only">{t('livraison.cov.isWhich')}</span>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{t('livraison.cov.pick')}</option>
          {communesOf(c.wilayaId).map((x) => (
            <option key={x[1]} value={x[1]}>
              {i18n.language === 'ar' && x[2] ? x[2] : x[1]}
              {x[1] === c.suggestion ? ` — ${t('livraison.cov.suggested')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn small primary" disabled={!to || fix.isPending} onClick={() => fix.mutate({ wilayaId: c.wilayaId, from: c.commune, to })}>
        {t('livraison.cov.fix')}
      </button>
    </li>
  );
}
