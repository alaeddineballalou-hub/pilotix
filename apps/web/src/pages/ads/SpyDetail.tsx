// AI Spy › one ad: the creative next to where it sends the customer (site: price, builder, order form; or a
// conversation), its text, Claude's reading, why it has its score, and what to do with it (open it on Facebook, open
// the site, follow the page, mark it « pas pertinente »).
import type { SpyAd } from '@pilotix/core';
import { useTranslation } from 'react-i18next';
import { da, dateOnly, when } from '../../lib/format';
import { adUrl } from '../../lib/spyExtension';
import { useAction } from '../../lib/query';
import { Empty, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { arLang, Creative, dayTone, linkIcon, platformsLabel, scoreTone, shortUrl, type View } from './spyShared';

export function SpyDetail({ ad, v }: { ad: SpyAd | null; v: View }) {
  const { t } = useTranslation();
  const productId = v.product.id;
  const follow = useAction('spy.follow');
  const hide = useAction('spy.hide', { success: t('spy.d.hiddenOk') });
  const analyze = useAction('spy.analyze', { success: (r) => (r.demo ? t('spy.ai.offToast') : t('spy.ai.done', { count: r.analyzed })) });
  if (!ad)
    return (
      <section className="card spy-dcard" aria-live="polite">
        <Empty>{t('spy.d.pick')}</Empty>
      </section>
    );
  const sc = scoreTone(ad.score);
  const dt = dayTone(ad.days);
  // demo ads have invented ids and addresses: no link out of Pilotix for them
  const real = ad.source !== 'demo';
  const site = real && ad.linkType === 'site' && ad.linkUrl ? ad.linkUrl : null;
  const text = [ad.title, ad.body].filter(Boolean).join('\n');
  const toggleFollow = () =>
    follow.mutate(
      { pageKey: ad.pageKey, pageName: ad.pageName, productId, on: !ad.followed },
      { onSuccess: () => toast(ad.followed ? t('spy.d.unfollowed') : t('spy.d.followed'), 'ok') },
    );
  return (
    <section className="card spy-dcard" aria-live="polite" aria-labelledby="spy-d-t">
      <div className="spy-d-head">
        <div className="spy-d-title">
          <h2 id="spy-d-t">
            <span dir="auto">{ad.pageName}</span>
            {ad.own && <span className="badge spy-own">{t('spy.you')}</span>}
          </h2>
          <div className="spy-d-sub">
            <span className={`badge t-${sc.tone}`}>
              {t(`spy.tone.${sc.k}`)} · <span className="ltr">{ad.score}/100</span>
            </span>
            <span className={`badge t-${dt.tone}`}>{t('spy.d.online', { n: ad.days, what: t(`spy.dayTone.${dt.k}`) })}</span>
            {!ad.active && <span className="badge t-bad">{t('spy.stopped')}</span>}
            {ad.same === false && <span className="badge t-off">{t('spy.near')}</span>}
            {ad.platforms.length > 0 && <span className="ltr">{platformsLabel(ad.platforms)}</span>}
          </div>
        </div>
        <div className="spy-d-actions">
          {!ad.own && (
            <button type="button" className={`btn small ${ad.followed ? 'spy-on' : ''}`} aria-pressed={ad.followed} disabled={follow.isPending} onClick={toggleFollow}>
              <Icon name={ad.followed ? 'check' : 'bell'} /> {ad.followed ? t('spy.d.following') : t('spy.d.follow')}
            </button>
          )}
          {real && (
            <a className="btn small" href={adUrl(ad.adId)} target="_blank" rel="noopener noreferrer">
              <Icon name="external" /> {t('spy.d.fb')}
            </a>
          )}
          {site && (
            <a className="btn small" href={site} target="_blank" rel="noopener noreferrer nofollow">
              <Icon name="globe" /> {t('spy.d.site')}
            </a>
          )}
          {!ad.own && (
            <button type="button" className="btn small ghost danger" disabled={hide.isPending} onClick={() => hide.mutate({ productId, gkey: ad.gkey, hidden: true })}>
              <Icon name="eyeoff" /> {t('spy.d.hide')}
            </button>
          )}
        </div>
      </div>

      <div className="spy-pair">
        <div>
          <div className="spy-pair-l">
            <span>{ad.isVideo ? t('spy.d.adVideo') : t('spy.d.adImage')}</span>
            {real && (
              <a href={adUrl(ad.adId)} target="_blank" rel="noopener noreferrer">
                {ad.isVideo ? t('spy.d.play') : t('spy.d.zoom')} <Icon name="external" />
              </a>
            )}
          </div>
          <Creative ad={ad} big />
        </div>
        <div>
          <div className="spy-pair-l">
            <span>{site ? t('spy.d.itsSite') : t('spy.d.where')}</span>
            {site && (
              <a href={site} target="_blank" rel="noopener noreferrer nofollow">
                {t('spy.d.open')} <Icon name="external" />
              </a>
            )}
          </div>
          <SiteCard ad={ad} />
        </div>
      </div>

      <div className="spy-sect">
        <h3>{t('spy.d.text')}</h3>
        {text ? (
          <div className="spy-copy" dir="auto" lang={arLang(text)}>
            {text}
          </div>
        ) : (
          <p className="note">{t('spy.d.noText')}</p>
        )}
        <p className="note">
          {ad.startedAt ? t('spy.d.started', { date: dateOnly(ad.startedAt) }) : t('spy.d.firstSeen', { date: dateOnly(ad.firstSeen) })}
          {ad.keyword ? ` · ${t('spy.d.keyword', { q: ad.keyword })}` : ''}
          {ad.adIds.length > 1 ? ` · ${t('spy.d.ids', { count: ad.adIds.length })}` : ''}
        </p>
      </div>

      <div className="spy-sect">
        <h3>
          <Icon name="sparkles" /> {t('spy.ai.title')}
        </h3>
        {ad.ai ? (
          <>
            <dl className="spy-kv">
              <dt>{t('spy.ai.hook')}</dt>
              <dd dir="auto">{ad.ai.hook || '—'}</dd>
              <dt>{t('spy.ai.angle')}</dt>
              <dd dir="auto">{ad.ai.angle || '—'}</dd>
              <dt>{t('spy.ai.offer')}</dt>
              <dd dir="auto">{ad.ai.offer || '—'}</dd>
              {ad.cta && (
                <>
                  <dt>{t('spy.ai.cta')}</dt>
                  <dd dir="auto">{ad.cta}</dd>
                </>
              )}
            </dl>
            <div className="spy-callout">
              <p>
                <b>{t('spy.ai.keep')}</b> <span dir="auto">{ad.ai.keep || '—'}</span>
              </p>
              <p>
                <b>{t('spy.ai.weak')}</b> <span dir="auto">{ad.ai.weak || '—'}</span>
              </p>
            </div>
          </>
        ) : (
          <div className="spy-ai-none">
            <p className="note">{v.ai ? t('spy.ai.notYet') : t('spy.ai.off')}</p>
            <div className="row">
              <button type="button" className="btn small primary" disabled={analyze.isPending} onClick={() => analyze.mutate({ productId })}>
                <Icon name="sparkles" /> {analyze.isPending ? t('spy.ai.running') : t('spy.ai.run')}
              </button>
              {!v.ai && (
                <a className="btn small ghost" href="#/marketing/spy/reglages">
                  {t('spy.settings')}
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="spy-sect">
        <h3>
          <Icon name="chart" /> {t('spy.score.title')}
        </h3>
        <div className="spy-bars">
          {ad.scoreParts.map((p) => (
            <div key={p.key} className="spy-bar">
              <span>{t(`spy.score.${p.key}`, { n: p.n })}</span>
              <i aria-hidden="true">
                <u style={{ width: `${p.max ? Math.round((p.value / p.max) * 100) : 0}%` }} />
              </i>
              <b className="ltr">
                {p.value} / {p.max}
              </b>
            </div>
          ))}
        </div>
        <p className="note">{t('spy.score.note')}</p>
      </div>
    </section>
  );
}

/** Where the customer lands: the site as Pilotix read it, or the conversation the ad opens. */
function SiteCard({ ad }: { ad: SpyAd }) {
  const { t } = useTranslation();
  const s = ad.site;
  const price = s?.price ?? ad.price;
  const old = s?.oldPrice ?? ad.oldPrice;
  const platform = s?.platform ?? ad.platform;
  const isSite = ad.linkType === 'site';
  return (
    <div className="spy-site">
      <div className="spy-site-bar">
        <Icon name={linkIcon(ad.linkType)} />
        {isSite ? <span className="ltr">{shortUrl(ad.linkUrl)}</span> : <span>{t(`spy.link.${ad.linkType}`)}</span>}
      </div>
      <div className="spy-site-body">
        {price ? (
          <div className="spy-site-price">
            <b className="ltr">{da(price)}</b>
            {old ? <s className="ltr">{da(old)}</s> : null}
          </div>
        ) : (
          <div>
            <span className="badge t-off">{t('spy.site.noPrice')}</span>
          </div>
        )}
        {platform && (
          <div>
            <span className="badge t-info">{platform}</span>
          </div>
        )}
        <ul>
          {s?.title && <li dir="auto">{s.title}</li>}
          {s?.wilayas ? <li>{t('spy.site.wilayas', { n: s.wilayas })}</li> : null}
          {s?.stopdesk && <li>{t('spy.site.stopdesk')}</li>}
          {s?.whatsapp && <li>{t('spy.site.whatsapp')}</li>}
          {ad.cta && <li>{t('spy.site.cta', { cta: ad.cta })}</li>}
          {!isSite && <li>{t(`spy.site.chat.${ad.linkType}`)}</li>}
          {isSite && !s && <li className="muted">{t('spy.site.notChecked')}</li>}
          {s && !s.ok && <li className="spy-bad">{t('spy.site.down')}</li>}
        </ul>
        {s && <small className="muted">{t('spy.site.checked', { when: when(s.checkedAt) })}</small>}
      </div>
    </div>
  );
}
