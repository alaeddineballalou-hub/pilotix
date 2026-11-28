// The Dépôt's stage bar, for one boutique (Depot.tsx) and for « Toutes les boutiques » (boutiques/all.tsx).
import { MENU_TABS, menuTabName } from '@pilotix/shared';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { tabOn } from '../../lib/rights';
import { Icon } from '../../ui/kit';
import './stages.css';

// « En livraison » moved to Suivi (the parcels on the road are the suivi's work); an old link goes there
/** Dépôt's steps: the menu's tabs (packages/shared/src/menu.ts), shared with Utilisateurs › Rôles */
/** the stages (« Réglages » is not one: ./Settings.tsx) */
export const DEPOT_STAGES = MENU_TABS.depot.filter((k): k is Exclude<(typeof MENU_TABS.depot)[number], 'reglages'> => k !== 'reglages');
export type DepotStage = (typeof DEPOT_STAGES)[number];

/** The stage of the address (#/depot/<stage>): « En préparation » when none. */
export function depotStage(sub: string | undefined): DepotStage {
  if (sub === 'enlivraison') location.replace('#/suivi/enlivraison');
  return (DEPOT_STAGES as readonly string[]).includes(sub ?? '') ? (sub as DepotStage) : 'preparer';
}

/** the tabs that are not steps of the parcels: after a line, without a count */
const APART: DepotStage[] = ['erreurs', 'stats'];

export type DepotStageCounts = Partial<Record<DepotStage, number>> & { prepAlerts?: number };

/**
 * Each stage with what waits there (drawn here rather than with <StageBar>: it needs the ⟶ arrow and the red « end »
 * stage of the original). A phone shows two or three stages at a time: the current one is brought into view.
 */
export function DepotStageBar({
  stage,
  counts,
  phone,
  cfgOn = false,
  noErrors = false,
  stats = false,
}: {
  stage: DepotStage;
  counts?: DepotStageCounts;
  phone?: boolean;
  cfgOn?: boolean;
  noErrors?: boolean;
  /** « Statistiques »: the depot's managers, the administrators and the seller only (depot.statsOn) */
  stats?: boolean;
}) {
  const { t } = useTranslation();
  const bar = useRef<HTMLElement>(null);
  // « Réglages » (administrators by default): it can come once the rights are there, over the end of the bar
  const gear = tabOn('depot', 'reglages');
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const show = () => {
      const on = el.querySelector<HTMLElement>('.bjm-p.on');
      // « Statistiques » and « Réglages » are pinned at the end, always in view: nothing to bring
      if (!on || on.closest('.bjm-end') || el.scrollWidth <= el.clientWidth + 1) return;
      const r = el.getBoundingClientRect();
      const b = on.getBoundingClientRect();
      // « Statistiques » and « Réglages » stay over the end of the bar (sticky), with a fade before them: what is under
      // them is not seen
      const cfg = el.querySelector<HTMLElement>('.bjm-end')?.getBoundingClientRect();
      const rtl = getComputedStyle(el).direction === 'rtl';
      const lo = cfg && rtl ? cfg.right + 44 : r.left + 8;
      const hi = cfg && !rtl ? cfg.left - 44 : r.right - 8;
      if (b.left >= lo && b.right <= hi) return;
      el.scrollBy({ left: b.left + b.width / 2 - (lo + hi) / 2 });
    };
    show();
    // again when the tabs widen: the counts, the letters once loaded (the last one, « Statistiques », left the screen)
    const ro = new ResizeObserver(() => show());
    el.querySelectorAll('.bjm-p').forEach((x) => ro.observe(x));
    return () => ro.disconnect();
  }, [stage, !!counts, stats, gear]);
  const shown = DEPOT_STAGES.filter((k) => tabOn('depot', k) && !(noErrors && k === 'erreurs') && (k !== 'stats' || stats));
  // the steps and « Erreurs de livraison » slide; « Statistiques » is pinned with « Réglages » at the end
  const steps = shown.filter((k) => k !== 'stats');
  const statsOn = shown.includes('stats');
  return (
    <nav ref={bar} className="bjm-bar flow" aria-label={t('depot.title')} data-g="depot">
      {steps.map((k, i) => (
        <span key={k} style={{ display: 'contents' }}>
          {/* « Erreurs de livraison » is not a step of the parcels: apart, after a line */}
          {i > 0 && APART.includes(k) && <span className="bjm-sep" aria-hidden="true" />}
          {i > 0 && !APART.includes(k) && (
            <span className={`bjm-ar ${k === 'retours' ? 'bjm-ar2' : ''}`} aria-hidden="true">
              {k === 'retours' ? '⟶' : '›'}
            </span>
          )}
          <a className={`bjm-p ${stage === k && !cfgOn ? 'on' : ''} ${k === 'retours' ? 'end' : ''}`} href={`#/depot/${k}`} aria-current={stage === k && !cfgOn ? 'page' : undefined}>
            <span className="bjm-l">{phone && k === 'preparer' ? t('depot.ph.stage') : t(menuTabName('depot', k))}</span>
            {counts && !APART.includes(k) && <b className={`bjm-n ltr${k === 'prepares' && counts.prepAlerts ? ' bad' : ''}`}>{counts[k] ?? 0}</b>}
          </a>
        </span>
      ))}
      {/* « Statistiques » (a chart) and « Réglages » (a gear): pinned together at the end of the bar, always in view,
          even when the steps slide under them (the owner, 28 Nov 2026); their names are tooltips and for screen readers.
          « Réglages » (administrators by default; Utilisateurs › Rôles) */}
      {(statsOn || gear) && (
        <span className="bjm-end">
          {statsOn && (
            <a className={`bjm-p bjm-ico ${stage === 'stats' && !cfgOn ? 'on' : ''}`} href="#/depot/stats" aria-label={t(menuTabName('depot', 'stats'))} title={t(menuTabName('depot', 'stats'))} aria-current={stage === 'stats' && !cfgOn ? 'page' : undefined}>
              <Icon name="chart" />
            </a>
          )}
          {gear && (
            <a className={`bjm-p bjm-cfg ${cfgOn ? 'on' : ''}`} href="#/depot/reglages" aria-label={t(menuTabName('depot', 'reglages'))} title={t(menuTabName('depot', 'reglages'))} aria-current={cfgOn ? 'page' : undefined}>
              <Icon name="settings" />
              <span className="bjm-l">{t(menuTabName('depot', 'reglages'))}</span>
            </a>
          )}
        </span>
      )}
    </nav>
  );
}
