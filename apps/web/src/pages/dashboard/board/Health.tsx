// "Les équipes": one card per team area (Confirmation, Suivi, Dépôt, Livreurs, SAV) with the number it is judged on
// first (against its target and the period before), the one after, what is late now and who to help first — each card
// opens that area's board.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../../lib/query';
import { Icon } from '../../../ui/kit';
import { AreaKey, AREAS, coachOf, fmt, toneOf } from './defs';
import { Meter, TrendChip } from './parts';
import './board.css';

/** the number each area is judged on first (the line of its day chart), and the one after */
const HEADLINE: Record<AreaKey, [string, string]> = {
  confirmation: ['confRate', 'deliveryRate'],
  suivi: ['deliveryRate', 'treatMs'],
  depot: ['prep24Rate', 'wrongRate'],
  livreurs: ['deliveryRate', 'late'],
  sav: ['settled48Rate', 'satRate'],
};

export function TeamHealth({ areas, range, title, className = '' }: { areas: AreaKey[]; range: { from: string; to: string }; title?: string; className?: string }) {
  const { t } = useTranslation();
  if (!areas.length) return null;
  return (
    <section className={`tb-health ${className}`.trim()} aria-labelledby="tb-health-h">
      <div className="tb-ch">
        <h3 id="tb-health-h">{title ?? t('dashboard.tb.health')}</h3>
        <span>{t('dashboard.tb.healthSub')}</span>
      </div>
      <div className="tb-hgrid">
        {areas.map((a) => (
          <HealthCard key={a} area={a} range={range} />
        ))}
      </div>
    </section>
  );
}

function HealthCard({ area, range }: { area: AreaKey; range: { from: string; to: string } }) {
  const { t } = useTranslation();
  const q = useRpc('stats.board', { ...range, area }, { refetchInterval: 120_000 });
  const def = AREAS[area];
  const [k1, k2] = HEADLINE[area];
  const b = q.data;
  const late = b ? b.now.filter((x) => def.now[x.key]?.tone === 'bad').reduce((s, x) => s + x.n, 0) : 0;
  const coached = b ? b.members.filter((m) => !m.none).map((m) => ({ name: m.name, c: coachOf(def, m.v, b.team) })) : [];
  const help = coached.filter((x) => x.c.focus).map((x) => x.name);
  const tone = b ? toneOf(def, k1, b.team) : undefined;
  const tone2 = b ? toneOf(def, k2, b.team) : undefined;
  return (
    <a className={`tb-hc is-${tone ?? 'none'}${q.isFetching && q.isPlaceholderData ? ' busy' : ''}`} href={`#/dashboard/${area}`}>
      <span className="tb-hch">
        <b>{t(`dashboard.areas.${area}`)}</b>
        <Icon name="chevr" />
      </span>
      {!b ? (
        <span className="tb-hcl" aria-busy="true" />
      ) : (
        <>
          <span className="tb-hcv">
            <b className="ltr">{fmt(def.metrics[k1], b.team[k1])}</b>
            <TrendChip def={def.metrics[k1]} v={b.team[k1]} p={b.prev[k1]} label={t('dashboard.tb.vsPrevShort')} />
          </span>
          <small className="tb-hck">{t(`dashboard.tb.line.${area}`)}</small>
          <Meter def={def.metrics[k1]} v={b.team[k1]} tone={tone} big />
          <span className="tb-hc2">
            {t(`dashboard.tb.m.${area}.${k2}.l`)}
            <b className={`ltr is-${tone2 ?? 'none'}`}>{fmt(def.metrics[k2], b.team[k2])}</b>
          </span>
          <span className="tb-hcf">
            {late > 0 ? (
              <span className="late">
                <Icon name="timer" /> {t('dashboard.tb.lateN', { count: late })}
              </span>
            ) : (
              <span className="calm">
                <Icon name="checkcircle" /> {t('dashboard.tb.nowNone')}
              </span>
            )}
            {help.length > 0 ? (
              <span className="help">
                <Icon name="flag" />
                <span>
                  {t('dashboard.tb.toHelp', { names: help.slice(0, 2).join(', ') })}
                  {help.length > 2 && <> {t('dashboard.tb.more', { count: help.length - 2 })}</>}
                </span>
              </span>
            ) : (
              coached.some((x) => x.c.judged > 0) && (
                <span className="calm">
                  <Icon name="users" /> {t('dashboard.tb.nobodyToHelp')}
                </span>
              )
            )}
          </span>
        </>
      )}
    </a>
  );
}
