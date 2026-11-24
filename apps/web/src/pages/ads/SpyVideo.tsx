// AI Spy › an ad › its video, played in Pilotix: Pilotix's own copy (the ads of followed pages, the ads a person tagged),
// else Facebook's link while it still works. A click on a video ad in the list starts it at once; on the ad page, a tap on
// the picture. When nothing can play (Facebook's link expired, no copy): Facebook's library instead.
import type { SpyAd } from '@pilotix/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adUrl } from '../../lib/spyExtension';
import { Icon } from '../../ui/kit';
import { Creative } from './spyShared';

/** The demo's own videos (demo://spy-video/<product>): a separate file, loaded only when one plays. */
async function demoVideo(src: string): Promise<string | null> {
  const k = /^demo:\/\/spy-video\/([a-z]+)$/.exec(src)?.[1];
  if (!k) return null;
  const m = await import('./spyDemoVideos');
  return m.default[k] ?? null;
}

export function AdVideo({ ad, autoPlay, real }: { ad: SpyAd; autoPlay: boolean; real: boolean }) {
  const { t } = useTranslation();
  const [on, setOn] = useState(autoPlay && !!ad.video);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  const demo = !!ad.video?.startsWith('demo://');
  const gone = !ad.video || failed;

  // the ad already on screen, clicked in the list: it starts too
  useEffect(() => {
    if (autoPlay && ad.video) setOn(true);
  }, [autoPlay, ad.video]);

  // the file to play: the address given, or the demo's own file
  useEffect(() => {
    if (!on || !ad.video) return;
    if (!ad.video.startsWith('demo://')) {
      setSrc(ad.video);
      return;
    }
    let live = true;
    demoVideo(ad.video)
      .then((s) => live && (s ? setSrc(s) : setFailed(true)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [on, ad.video]);

  // with its sound when the browser allows it (the person clicked); else muted, the sound one tap away in the controls
  useEffect(() => {
    const v = ref.current;
    if (!v || !src) return;
    v.play().catch(() => {
      v.muted = true;
      void v.play().catch(() => {});
    });
  }, [src]);

  return (
    <div className="spy-vid">
      {on && src && !failed ? (
        <video ref={ref} className="spy-video" src={src} poster={ad.media ?? undefined} controls playsInline preload="auto" onError={() => setFailed(true)} />
      ) : (
        <div className="spy-vid-cover">
          <Creative ad={ad} big noPlay />
          {!gone && (
            <button type="button" className="spy-vid-play" onClick={() => setOn(true)} aria-label={t('spy.d.play')} title={t('spy.d.play')}>
              {on ? (
                <span className="spy-vid-wait" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 4l13 8-13 8z" />
                </svg>
              )}
            </button>
          )}
        </div>
      )}
      {gone ? (
        <div className="spy-vid-note off" role="status">
          {failed ? (
            <span>{t('spy.d.vid.error')}</span>
          ) : (
            <span>
              <b>{t('spy.d.vid.gone')}</b>
              {!ad.own && <> {t('spy.d.vid.keepNext')}</>}
            </span>
          )}
          {real && (
            <a className="btn small" href={adUrl(ad.adId)} target="_blank" rel="noopener noreferrer">
              <Icon name="external" /> {t('spy.d.fb')}
            </a>
          )}
        </div>
      ) : ad.own ? (
        demo && <p className="spy-vid-note">{t('spy.d.vid.demo')}</p>
      ) : (
        <p className={`spy-vid-note ${ad.videoKept ? 'kept' : ''}`}>
          {ad.videoKept ? (
            <>
              <Icon name="check" /> {t('spy.d.vid.kept')}
            </>
          ) : (
            t('spy.d.vid.fb')
          )}
          {demo && <span className="spy-vid-demo"> · {t('spy.d.vid.demo')}</span>}
        </p>
      )}
    </div>
  );
}
