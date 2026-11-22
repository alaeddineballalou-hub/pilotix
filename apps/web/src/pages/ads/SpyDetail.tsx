// AI Spy › one ad: the creative next to where it sends the customer (site: price, builder, order form; or a
// conversation), its text, Claude's reading, why it has its score, and what to do with it (open it on Facebook, open
// the site, follow the page, mark it « pas pertinente »). A site the server could not read (its « no robots » rule, a
// protection wall: Pilotix never forces it) says so; its price can then be typed by hand, or read by the person's own
// Chrome on the page they open (the Pilotix Spy extension's « Lire le prix de cette page »).
import { webHref } from '../../lib/safeHref';
import type { SpyAd } from '@pilotix/core';
import { useId, useState, type FormEvent } from 'react';
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
  const site = real && ad.linkType === 'site' ? webHref(ad.linkUrl) : null;
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
          <SiteCard ad={ad} productId={productId} />
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
            <p className="note">{v.ai ? t('spy.ai.notYet') : t(v.platform ? 'spy.ai.offPilot' : 'spy.ai.off')}</p>
            <div className="row">
              <button type="button" className="btn small primary" disabled={analyze.isPending} onClick={() => analyze.mutate({ productId })}>
                <Icon name="sparkles" /> {analyze.isPending ? t('spy.ai.running') : t('spy.ai.run')}
              </button>
              {!v.ai && (
                <a className="btn small ghost" href="#/spy/reglages">
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

/** Where the customer lands: the site as Pilotix read it (or why it could not), its price and who gave it, or the conversation the ad opens. */
function SiteCard({ ad, productId }: { ad: SpyAd; productId: number }) {
  const { t } = useTranslation();
  const [typing, setTyping] = useState(false);
  const s = ad.site;
  const isSite = ad.linkType === 'site';
  // the server's last good reading of the page, the price a person gave, else the price written in the ad
  const readAt = s?.readAt ?? (s?.ok ? s.checkedAt : null);
  const robot = s?.price && readAt ? { price: s.price, old: s.oldPrice, at: readAt } : null;
  const man = ad.manual;
  const shown =
    man && (!robot || Date.parse(man.at) >= Date.parse(robot.at))
      ? { price: man.price, old: man.oldPrice, from: man.via, at: man.at }
      : robot
        ? { price: robot.price, old: robot.old, from: 'site' as const, at: robot.at }
        : ad.price
          ? { price: ad.price, old: ad.oldPrice, from: 'ad' as const, at: null }
          : null;
  const platform = s?.platform ?? ad.platform;
  const walled = !!s && !s.ok && (s.blocked === 'robots' || s.blocked === 'wall');
  const competitor = isSite && !ad.own;
  return (
    <div className="spy-site">
      <div className="spy-site-bar">
        <Icon name={linkIcon(ad.linkType)} />
        {isSite ? <span className="ltr">{shortUrl(ad.linkUrl)}</span> : <span>{t(`spy.link.${ad.linkType}`)}</span>}
      </div>
      <div className="spy-site-body">
        {walled && (
          <div>
            <span className="badge t-bad">
              <Icon name="lock" /> {t('spy.site.blocked')}
            </span>
          </div>
        )}
        {shown ? (
          <div className="spy-site-pricebox">
            <div className="spy-site-price">
              <b className="ltr">{da(shown.price)}</b>
              {shown.old ? <s className="ltr">{da(shown.old)}</s> : null}
            </div>
            <small className="muted">{shown.at ? t(`spy.site.from.${shown.from}`, { when: when(shown.at) }) : t('spy.site.from.ad')}</small>
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
          {s && !s.ok && <li className="spy-bad">{t(`spy.site.why.${s.blocked ?? 'down'}`)}</li>}
        </ul>
        {s && <small className="muted">{t('spy.site.checked', { when: when(s.checkedAt) })}</small>}
        {competitor &&
          (typing ? (
            <PriceForm ad={ad} productId={productId} onDone={() => setTyping(false)} />
          ) : (
            <div className="spy-site-acts">
              <button type="button" className="btn small" onClick={() => setTyping(true)}>
                <Icon name="pencil" /> {man ? t('spy.site.change') : t('spy.site.type')}
              </button>
            </div>
          ))}
        {competitor && !typing && (!s?.ok || !robot) && <p className="note spy-site-hint">{t('spy.site.chromeHint')}</p>}
      </div>
    </div>
  );
}

/** « Taper le prix »: the competitor's price as the person sees it on the site (and its crossed price), or taken back. */
function PriceForm({ ad, productId, onDone }: { ad: SpyAd; productId: number; onDone: () => void }) {
  const { t } = useTranslation();
  const uid = useId();
  const [price, setPrice] = useState(ad.manual ? String(ad.manual.price) : '');
  const [old, setOld] = useState(ad.manual?.oldPrice ? String(ad.manual.oldPrice) : '');
  const save = useAction('spy.sitePrice', { onDone });
  const p = Math.round(Number(price.replace(/[\s.,]/g, '')));
  const o = Math.round(Number(old.replace(/[\s.,]/g, '')));
  const valid = Number.isFinite(p) && p >= 100 && p <= 10_000_000;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || save.isPending) return;
    save.mutate(
      { via: 'hand', productId, gkey: ad.gkey, price: p, oldPrice: old.trim() && Number.isFinite(o) && o > p && o <= 10_000_000 ? o : null },
      { onSuccess: () => toast(t('spy.site.savedOk'), 'ok') },
    );
  };
  return (
    <form className="spy-priceform" onSubmit={submit}>
      <div className="spy-priceform-row">
        <label htmlFor={`${uid}-p`}>{t('spy.site.priceLabel')}</label>
        <input id={`${uid}-p`} className="ltr" type="text" inputMode="numeric" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="12 900" autoFocus />
      </div>
      <div className="spy-priceform-row">
        <label htmlFor={`${uid}-o`}>{t('spy.site.oldLabel')}</label>
        <input id={`${uid}-o`} className="ltr" type="text" inputMode="numeric" autoComplete="off" value={old} onChange={(e) => setOld(e.target.value)} placeholder="15 000" />
      </div>
      <div className="spy-site-acts">
        <button type="submit" className="btn small primary" disabled={!valid || save.isPending}>
          <Icon name="check" /> {t('spy.site.save')}
        </button>
        <button type="button" className="btn small ghost" onClick={onDone}>
          {t('spy.site.cancel')}
        </button>
        {ad.manual && (
          <button type="button" className="btn small ghost danger" disabled={save.isPending} onClick={() => save.mutate({ via: 'hand', productId, gkey: ad.gkey, price: null }, { onSuccess: () => toast(t('spy.site.clearedOk'), 'ok') })}>
            <Icon name="trash" /> {t('spy.site.clear')}
          </button>
        )}
      </div>
    </form>
  );
}
