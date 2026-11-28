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
      if (!on || el.scrollWidth <= el.clientWidth + 1) return;
      const r = el.getBoundingClientRect();
      const b = on.getBoundingClientRect();
      // « Réglages » stays over the end of the bar (sticky), with a fade before it: what is under them is not seen
      const cfg = el.querySelector<HTMLElement>('.bjm-cfg')?.getBoundingClientRect();
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
  return (
    <nav ref={bar} className="bjm-bar flow" aria-label={t('depot.title')} data-g="depot">
      {shown.map((k, i) => (
        <span key={k} style={{ display: 'contents' }}>
          {/* « Erreurs de livraison » and « Statistiques » are not steps of the parcels: apart, after a line */}
          {i > 0 && APART.includes(k) && !(k === 'stats' && shown.includes('erreurs')) && <span className="bjm-sep" aria-hidden="true" />}
          {i > 0 && !APART.includes(k) && (
            <span className={`bjm-ar ${k === 'retours' ? 'bjm-ar2' : ''}`} aria-hidden="true">
              {k === 'retours' ? '⟶' : '›'}
            </span>
          )}
          {k === 'stats' ? (
            // « Statistiques »: a chart only (the owner's choice, 28 Nov 2026), so the bar fits a computer's screen
            <a className={`bjm-p bjm-ico ${stage === k && !cfgOn ? 'on' : ''}`} href="#/depot/stats" aria-label={t(menuTabName('depot', k))} title={t(menuTabName('depot', k))} aria-current={stage === k && !cfgOn ? 'page' : undefined}>
              <Icon name="chart" />
            </a>
          ) : (
            <a className={`bjm-p ${stage === k && !cfgOn ? 'on' : ''} ${k === 'retours' ? 'end' : ''}`} href={`#/depot/${k}`} aria-current={stage === k && !cfgOn ? 'page' : undefined}>
              <span className="bjm-l">{phone && k === 'preparer' ? t('depot.ph.stage') : t(menuTabName('depot', k))}</span>
              {counts && !APART.includes(k) && <b className={`bjm-n ltr${k === 'prepares' && counts.prepAlerts ? ' bad' : ''}`}>{counts[k] ?? 0}</b>}
            </a>
          )}
        </span>
      ))}
      {/* « Réglages »: apart at the end, with a gear (administrators by default; Utilisateurs › Rôles) */}
      {gear && (
        <a className={`bjm-p bjm-cfg ${cfgOn ? 'on' : ''}`} href="#/depot/reglages" aria-label={t(menuTabName('depot', 'reglages'))} title={t(menuTabName('depot', 'reglages'))} aria-current={cfgOn ? 'page' : undefined}>
          <Icon name="settings" />
          <span className="bjm-l">{t(menuTabName('depot', 'reglages'))}</span>
        </a>
      )}
    </nav>
  );
}
