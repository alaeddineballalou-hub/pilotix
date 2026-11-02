// "How Dellal learns" as a learning bench (Anatomy kit): the lesson book rides a rail past the day, the night, the morning
// and the test. The picture is made once by explainers/dellal-learns/build.mjs (one per reading direction, loaded only
// when shown); bench.ts moves it. The words are the page's, in its language, with the engine's own numbers.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsDark } from '../../../lib/useMedia';
import { mountBench, type BenchArt, type BenchCtl, type BenchRead } from './bench';
import './iso.css';
import './bench.css';

const STEPS = ['day', 'night', 'morning', 'test'] as const;

export function LearnBench({ share, days }: { share: number; days: number }) {
  const { t, i18n } = useTranslation();
  const rtl = i18n.dir(i18n.language) === 'rtl';
  const dark = useIsDark();
  const [art, setArt] = useState<BenchArt | null>(null);
  const [step, setStep] = useState(0);
  const root = useRef<HTMLElement>(null);
  const ctl = useRef<BenchCtl | null>(null);
  const tr = useRef(t);
  tr.current = t;

  useEffect(() => {
    let live = true;
    (rtl ? import('./art-rtl') : import('./art-ltr')).then((m) => live && setArt(m.default)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [rtl]);

  useEffect(() => {
    const el = root.current;
    if (!art || !el) return;
    const dec = (v: number) => (Math.round(v * 10) / 10).toFixed(1).replace('.', i18n.language === 'en' ? '.' : ',');
    const k = 'platform.pilot.learn.bench.read.';
    const readout = (r: BenchRead) => {
      const t = tr.current;
      if (r.step === 0) return t(k + 'day', { v: r.v, n: r.n });
      // the score keeps its sign on its left in Arabic too (a left-to-right island in the sentence)
      if (r.step === 1) return t(k + 'night', { delivered: art.night.delivered, refused: art.night.refused, cancelled: art.night.cancelled, score: '\u2066+' + dec(art.night.score) + '\u2069' });
      if (r.step === 2) return t(k + 'morning', { v: r.v });
      if (r.verdict) return t(k + r.verdict, { a: dec(r.a), b: dec(r.b), v: r.v });
      return t(k + 'test', { share, n: Math.min(r.n, days), days });
    };
    const c = mountBench(el, art, { onStep: (s) => setStep(s), readout });
    ctl.current = c;
    return () => {
      c.destroy();
      ctl.current = null;
    };
  }, [art, share, days, i18n.language]);

  if (!art) return <div className="pl-bench-wait" aria-hidden="true" />;
  return (
    <figure ref={root} className="iso-figure pl-iso iso" data-theme={dark ? undefined : 'light'}>
      <div className="iso-plate">
        <div className="iso-plate-corners" aria-hidden="true">
          <span className="iso-plate-corner ltr" data-corner="fig">
            Fig. 1
          </span>
          <span className="iso-plate-corner" data-corner="title">
            {t('platform.pilot.learn.bench.name')}
          </span>
          <span className="iso-plate-corner" data-corner="hint">
            {t('platform.pilot.learn.bench.hint')}
          </span>
          <span className="iso-plate-corner" data-corner="readout" data-readout="" />
        </div>
        <div className="iso-stage" tabIndex={0} role="group" aria-label={t('platform.pilot.learn.bench.aria')} dangerouslySetInnerHTML={{ __html: art.svg }} />
      </div>
      <div className="pl-bsteps">
        {STEPS.map((s, i) => (
          <button key={s} type="button" className="pl-bstep" aria-pressed={step === i} data-on={step === i ? '' : undefined} onClick={() => ctl.current?.go(i)}>
            <span className="pl-bstep-n ltr">{i + 1}</span>
            <span className="pl-bstep-when">{t(`platform.pilot.learn.${s}.when`)}</span>
            <span className="pl-bstep-what">{t(`platform.pilot.learn.${s}.what`)}</span>
          </button>
        ))}
      </div>
      <p className="pl-bcap">{t(`platform.pilot.learn.${STEPS[step]}.text`, { share, days })}</p>
      <div className="pl-bkeys">
        <span className="pl-bkey">
          <i className="k-book" />
          {t('platform.pilot.learn.bench.keyBook')}
        </span>
        <span className="pl-bkey">
          <i className="k-won" />
          {t('platform.pilot.learn.bench.keyWon')}
        </span>
        <span className="pl-bkey">
          <i className="k-lost" />
          {t('platform.pilot.learn.bench.keyLost')}
        </span>
      </div>
    </figure>
  );
}
