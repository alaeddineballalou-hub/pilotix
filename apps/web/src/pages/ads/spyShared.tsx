// AI Spy: small pieces shared by the page, the detail panel and the settings (creative, score ring, landing line,
// translated sentences with bold parts). Every number comes from core (spy.*); nothing here invents data.
import type { SpyAd } from '@pilotix/core';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da } from '../../lib/format';
import { Icon } from '../../ui/kit';

export type View = Out<'spy.view'>;
export type LinkType = SpyAd['linkType'];

/** Arabic script in a text (its block is then read right-to-left). */
export const isAr = (s: string | null | undefined) => !!s && /[؀-ۿݐ-ݿ]/.test(s);
export const arLang = (s: string | null | undefined) => (isAr(s) ? 'ar' : undefined);

export function hostOf(u: string | null | undefined): string {
  if (!u) return '';
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
/** "eldjawda.net/velo" (no protocol, no query). */
export function shortUrl(u: string | null | undefined): string {
  if (!u) return '';
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname === '/' ? '' : x.pathname}`.slice(0, 80);
  } catch {
    return u.slice(0, 80);
  }
}
/** The ad's first line (its hook). */
export const firstLine = (a: Pick<SpyAd, 'body' | 'title'>) =>
  (a.body || a.title || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) ?? '';

const PLATFORM: Record<string, string> = { FACEBOOK: 'FB', INSTAGRAM: 'IG', MESSENGER: 'Messenger', AUDIENCE_NETWORK: 'Audience Network', THREADS: 'Threads', WHATSAPP: 'WhatsApp' };
export const platformsLabel = (p: string[]) => p.map((x) => PLATFORM[x.toUpperCase()] ?? x).join(' · ');

export type ScoreTone = 'ok' | 'info' | 'mid' | 'off';
/** The score's word: ≥ 70 winning, ≥ 45 promising, ≥ 25 testing, else new. */
export const scoreTone = (v: number): { k: 'win' | 'promising' | 'test' | 'new'; tone: ScoreTone } =>
  v >= 70 ? { k: 'win', tone: 'ok' } : v >= 45 ? { k: 'promising', tone: 'info' } : v >= 25 ? { k: 'test', tone: 'mid' } : { k: 'new', tone: 'off' };
/** Days online: ≥ 60 lasts, ≥ 30 passed the test, ≥ 7 in test, else a new test. */
export const dayTone = (d: number): { k: 'long' | 'passed' | 'testing' | 'fresh'; tone: ScoreTone } =>
  d >= 60 ? { k: 'long', tone: 'ok' } : d >= 30 ? { k: 'passed', tone: 'info' } : d >= 7 ? { k: 'testing', tone: 'mid' } : { k: 'fresh', tone: 'off' };

/**
 * A translated sentence with <b>…</b> parts. Values are put in as plain text after the translation (never parsed as
 * markup), so a page name can never add tags; each value is isolated (<bdi>) so an Arabic page name stays readable in a
 * French sentence and the other way round. `count` picks the plural form.
 */
export function Rich({ k, v, count }: { k: string; v: Record<string, string | number>; count?: number }) {
  const { t } = useTranslation();
  const keys = Object.keys(v);
  const marks: Record<string, string> = {};
  keys.forEach((key, i) => (marks[key] = `\u0001${i}\u0002`));
  const s = String(t(k, count === undefined ? marks : { ...marks, count }));
  const fill = (part: string): ReactNode[] =>
    part.split(/\u0001(\d+)\u0002/g).map((x, j) => (j % 2 ? <bdi key={j}>{String(v[keys[Number(x)]] ?? '')}</bdi> : x));
  return (
    <>
      {s
        .split(/(<b>[\s\S]*?<\/b>)/g)
        .filter(Boolean)
        .map((p, i) => (p.startsWith('<b>') && p.endsWith('</b>') ? <b key={i}>{fill(p.slice(3, -4))}</b> : <span key={i}>{fill(p)}</span>))}
    </>
  );
}

export function ScoreRing({ v, label }: { v: number; label: string }) {
  const tone = scoreTone(v).tone;
  return (
    <span className={`spy-ring ${tone}`} style={{ ['--v' as string]: v }} title={label} aria-label={`${label} ${v}/100`}>
      <b>{v}</b>
    </span>
  );
}

const hueOf = (s: string) => {
  let h = 7;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
};

/**
 * The ad's picture with its score, copies and price. Without a picture (examples, or a picture not downloaded yet) a
 * mock is drawn: a gradient, the page's initial, the ad's first line and the price sticker.
 */
export function Creative({ ad, big }: { ad: SpyAd; big?: boolean }) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  const img = !!ad.media && !broken;
  const line = firstLine(ad);
  const h = hueOf(ad.pageName || ad.gkey);
  const initial = Array.from(ad.pageName.trim())[0]?.toUpperCase() ?? '?';
  return (
    <span className={`spy-cr ${big ? 'big' : ''}`}>
      {img ? (
        <img src={ad.media as string} alt={t('spy.cr.alt', { page: ad.pageName })} loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span className="spy-mock" aria-hidden="true" style={{ ['--c1' as string]: `hsl(${h} 46% 40%)`, ['--c2' as string]: `hsl(${(h + 48) % 360} 52% 20%)` }}>
          <span className="spy-mock-i">{initial}</span>
          {line && (
            <span className="spy-mock-t" dir="auto" lang={arLang(line)}>
              {line}
            </span>
          )}
        </span>
      )}
      {img && ad.isVideo && (
        <span className="spy-play" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M7 4l13 8-13 8z" />
          </svg>
        </span>
      )}
      <span className="spy-cr-top">
        {ad.own ? (
          <span className="spy-src own">{t('spy.you')}</span>
        ) : (
          <span className="spy-src">
            <i className="spy-fbdot" aria-hidden="true" />
            {ad.isVideo ? t('spy.video') : t('spy.image')}
          </span>
        )}
        <ScoreRing v={ad.score} label={t('spy.scoreLabel')} />
      </span>
      <span className="spy-cr-bot">
        <span className="spy-pill ltr">{t('spy.copies', { count: ad.copies })}</span>
        {ad.price ? (
          <span className="spy-tag ltr">
            {ad.oldPrice ? <s>{da(ad.oldPrice)}</s> : null}
            {da(ad.price)}
          </span>
        ) : null}
      </span>
    </span>
  );
}

const LINK_ICON: Record<LinkType, string> = { site: 'globe', messenger: 'message', whatsapp: 'whatsapp', instagram: 'camera', page: 'flag', none: 'unlink' };
export const linkIcon = (l: LinkType) => LINK_ICON[l] ?? 'unlink';

/** Where the ad sends the customer: the site (and its builder), or a conversation. */
export function LandLine({ ad }: { ad: SpyAd }) {
  const { t } = useTranslation();
  return (
    <span className="spy-land">
      <Icon name={linkIcon(ad.linkType)} />
      {ad.linkType === 'site' ? (
        <span>
          <b className="ltr">{hostOf(ad.linkUrl) || t('spy.link.site')}</b>
          {ad.platform ? ` · ${ad.platform}` : ''}
        </span>
      ) : (
        <span>
          {t('spy.land.noSite')} · <b>{t(`spy.link.${ad.linkType}`)}</b>
        </span>
      )}
    </span>
  );
}
