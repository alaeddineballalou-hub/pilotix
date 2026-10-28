// A Pro marketer's business card: the navy front (name, code, city, niches, the success rate, the ad sets' bar, ad
// sets · stores · products), tap or Enter to turn it; the white back (every number, its niches and platforms, its city,
// how long it has been on Pilotix, a few lines of its own, and the action: invite, or where the request stands).
import { ProCard as Card } from '@pilotix/shared';
import { KeyboardEvent, ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/kit';
import './pro.css';

const COLORS = ['#3E648B', '#8A4FA0', '#2E8B6E', '#C0623A', '#5B6478', '#B0485F', '#2F7FA8', '#7A6A2E'];
const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export function ProBadge() {
  return (
    <span className="prx-badge">
      <Icon name="medal" /> PRO
    </span>
  );
}

/** The niches and platforms in words. */
export function useProWords() {
  const { t } = useTranslation();
  return { niche: (k: string) => t(`pro.niche.${k}`), platform: (k: string) => t(`pro.platform.${k}`) };
}

export function ProBizCard({ c, i = 0, action }: { c: Card; i?: number; action?: ReactNode }) {
  const { t } = useTranslation();
  const w = useProWords();
  const [flip, setFlip] = useState(false);
  const s = c.stats;
  const turn = () => setFlip((f) => !f);
  const key = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), turn());
  };
  const tags = (
    <div className="prx-tags">
      {c.profile.niches.map((n) => (
        <span key={n}>{w.niche(n)}</span>
      ))}
    </div>
  );
  return (
    <div
      className={`prx-card ${flip ? 'flip' : ''}`}
      style={{ ['--i' as string]: i }}
      role="button"
      tabIndex={0}
      aria-pressed={flip}
      aria-label={t('pro.card.turn', { name: c.name })}
      onClick={(e) => !(e.target as HTMLElement).closest('a,button') && turn()}
      onKeyDown={key}
    >
      <div className="prx-in">
        <div className="prx-face prx-front" aria-hidden={flip}>
          <div className="prx-r">
            <div>
              <p className="prx-name">{c.name}</p>
              <span className="prx-code ltr">
                {c.code}
                {c.profile.city ? ` · ${c.profile.city}` : ''}
              </span>
            </div>
            <ProBadge />
          </div>
          {tags}
          <div className="prx-r" style={{ alignItems: 'flex-end' }}>
            <div>
              {c.rate === null ? <span className="prx-rate none">{t('pro.card.noRate')}</span> : <span className="prx-rate ltr">{c.rate}%</span>}
              <div className="prx-cap">{c.rate === null ? t('pro.card.noRateHelp') : t('pro.card.rate')}</div>
            </div>
            <span className="prx-av" style={{ background: COLORS[c.id % COLORS.length] }}>
              {initials(c.name)}
            </span>
          </div>
          <div>
            <div className="prx-bar" role="img" aria-label={t('pro.card.barLabel', { ok: s.ok, ko: s.ko, run: s.run })}>
              <i style={{ flex: s.ok }} />
              <u style={{ flex: s.ko }} />
              <s style={{ flex: s.run || (s.adsets ? 0 : 1) }} />
            </div>
            <div className="prx-leg">
              <span>
                <em style={{ color: '#3FCB8A' }}>●</em>
                {t('pro.card.okN', { count: s.ok })}
              </span>
              <span>
                <em style={{ color: '#FF7A7A' }}>●</em>
                {t('pro.card.koN', { count: s.ko })}
              </span>
              <span>
                <em style={{ color: '#B9C6DD' }}>●</em>
                {t('pro.card.runN', { count: s.run })}
              </span>
            </div>
          </div>
          <div className="prx-mini">
            <div>
              <strong className="ltr">{s.adsets}</strong>
              {t('pro.card.adsets', { count: s.adsets })}
            </div>
            <div>
              <strong className="ltr">{s.stores}</strong>
              {t('pro.card.stores', { count: s.stores })}
            </div>
            <div>
              <strong className="ltr">{s.products}</strong>
              {t('pro.card.products', { count: s.products })}
            </div>
          </div>
          <span className="prx-tap">
            <Icon name="refresh" /> {t('pro.card.tap')}
          </span>
        </div>
        <div className="prx-face prx-back" aria-hidden={!flip}>
          <h4>
            <span>{c.name}</span> <ProBadge />
          </h4>
          <div className="prx-six">
            <div>
              <strong className="ltr">{s.adsets}</strong>
              {t('pro.card.launched')}
            </div>
            <div>
              <strong className="ok ltr">{s.ok}</strong>
              {t('pro.card.ok')}
            </div>
            <div>
              <strong className="ko ltr">{s.ko}</strong>
              {t('pro.card.ko')}
            </div>
            <div>
              <strong className="ltr">{s.run}</strong>
              {t('pro.card.run')}
            </div>
            <div>
              <strong className="ltr">{s.stores}</strong>
              {t('pro.card.stores', { count: s.stores })}
            </div>
            <div>
              <strong className="ltr">{s.products}</strong>
              {t('pro.card.products', { count: s.products })}
            </div>
          </div>
          <div className="prx-rows">
            <div>
              <span>{t('pro.card.niche')}</span>
              <b>{c.profile.niches.map(w.niche).join(' · ') || '—'}</b>
            </div>
            <div>
              <span>{t('pro.card.platforms')}</span>
              <b>{c.profile.platforms.map(w.platform).join(' · ') || '—'}</b>
            </div>
            <div>
              <span>{t('pro.card.city')}</span>
              <b>{c.profile.city || '—'}</b>
            </div>
            <div>
              <span>{t('pro.card.since')}</span>
              <b>{c.months < 1 ? t('pro.card.new') : t('pro.card.months', { count: c.months })}</b>
            </div>
          </div>
          {c.profile.bio && <p className="prx-bio">{c.profile.bio}</p>}
          {action}
        </div>
      </div>
    </div>
  );
}
