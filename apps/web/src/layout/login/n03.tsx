/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Theme 3 — «It talks to your customers in Darija»: a real night-time chat that ends in an order.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

const Moon = () => (
  <svg className="pxn03-ic" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M10.8 1.6a6.6 6.6 0 1 0 3.6 10.6A5.6 5.6 0 0 1 10.8 1.6Z" fill="currentColor" />
  </svg>
);
const Sun = () => (
  <svg className="pxn03-ic" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="3.3" fill="currentColor" />
    <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M8 .9v1.8M8 13.3v1.8M.9 8h1.8M13.3 8h1.8M3 3l1.2 1.2M11.8 11.8 13 13M3 13l1.2-1.2M11.8 4.2 13 3" />
    </g>
  </svg>
);
const Ticks = () => (
  <svg className="pxn03-tk" viewBox="0 0 18 10" aria-hidden="true">
    <path d="M1 5.4 3.9 8.3 9.6 1.7M7.2 7.4l.9.9 5.7-6.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'overlay',
  side: 'end',
  Visual: ({ t }) => (
    <div className="pxn03">
      <div className="pxn03-sky" />
      <svg className="pxn03-stars" viewBox="0 0 1000 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <g fill="#fff">
          <circle cx="60" cy="40" r="1.6" opacity=".7" /><circle cx="180" cy="120" r="1.1" opacity=".5" />
          <circle cx="300" cy="60" r="1.4" opacity=".6" /><circle cx="420" cy="170" r="1" opacity=".4" />
          <circle cx="520" cy="30" r="1.5" opacity=".6" /><circle cx="640" cy="110" r="1.1" opacity=".5" />
          <circle cx="760" cy="50" r="1.7" opacity=".7" /><circle cx="880" cy="150" r="1.2" opacity=".5" />
          <circle cx="950" cy="70" r="1" opacity=".5" /><circle cx="110" cy="210" r="1" opacity=".35" />
          <circle cx="700" cy="230" r="1" opacity=".35" /><circle cx="360" cy="260" r="1" opacity=".3" />
        </g>
      </svg>
      <div className="pxn03-moon" />
      <div className="pxn03-dawn" />
      <div className="pxn03-scrim" />

      <div className="pxn03-col" dir={t('dir')}>
        <div className="pxn03-head">
          <h2 className="pxn03-h">
            {t('a')} <span>{t('b')}</span>
          </h2>
          <p className="pxn03-sub">{t('sub')}</p>
          <ul className="pxn03-chips">
            <li>{t('ch1')}</li>
            <li>{t('ch2')}</li>
            <li>{t('ch3')}</li>
            <li>{t('ch4')}</li>
          </ul>
        </div>

        <div className="pxn03-phone">
          <div className="pxn03-bar">
            <span className="pxn03-av">{t('avatar')}</span>
            <span className="pxn03-who">
              <b>{t('shop')}</b>
              <small>
                {t('status')} <Sun /> <Moon />
              </small>
            </span>
          </div>

          {/* the chat is always in Darija (every UI language): it is the proof of the headline */}
          <div className="pxn03-chat">
            <div className="pxn03-feed" dir="rtl">
              <div className="pxn03-old">
                <span className="pxn03-day"><Sun /> {t('today')}</span>
                <p className="pxn03-m pxn03-in">
                  {t('d0')}
                  <i className="pxn03-ts"><Sun /> {t('tDay0')}</i>
                </p>
                <p className="pxn03-m pxn03-out">
                  {t('d0r')}
                  <i className="pxn03-ts"><Sun /> {t('tDay0')} <Ticks /></i>
                </p>
                <p className="pxn03-m pxn03-in">
                  {t('d1')}
                  <i className="pxn03-ts"><Sun /> {t('tDay')}</i>
                </p>
                <p className="pxn03-m pxn03-out">
                  {t('d2')}
                  <i className="pxn03-ts"><Sun /> {t('tDay')} <Ticks /></i>
                </p>
              </div>
              <span className="pxn03-day pxn03-night"><Moon /> {t('night')}</span>

              <p className="pxn03-m pxn03-in pxn03-b1">
                {t('m1')}
                <i className="pxn03-ts"><Moon /> {t('tN1')}</i>
              </p>
              <div className="pxn03-slot">
                <span className="pxn03-typing pxn03-ty1" aria-hidden="true"><i /><i /><i /></span>
                <p className="pxn03-m pxn03-out pxn03-b2">
                  {t('m2')}
                  <i className="pxn03-ts"><Moon /> <span className="pxn03-ai">{t('ai')} · </span>{t('tN1')} <Ticks /></i>
                </p>
              </div>
              <p className="pxn03-m pxn03-in pxn03-b3">
                {t('m3')}
                <i className="pxn03-ts"><Moon /> {t('tN2')}</i>
              </p>
              <div className="pxn03-slot">
                <span className="pxn03-typing pxn03-ty2" aria-hidden="true"><i /><i /><i /></span>
                <p className="pxn03-m pxn03-out pxn03-ok pxn03-b4">
                  {t('m4')}
                  <i className="pxn03-ts"><Moon /> <span className="pxn03-ai">{t('ai')} · </span>{t('tN2')} <Ticks /></i>
                </p>
              </div>
            </div>
          </div>

          <div className="pxn03-order">
            <div className="pxn03-o-top">
              <span className="pxn03-o-ok">✓</span>
              <b>{t('oTitle')}</b>
              <small>{t('oVia')}</small>
            </div>
            <dl className="pxn03-o-rows">
              <div><dt>{t('oNameK')}</dt><dd>{t('oName')}</dd></div>
              <div><dt>{t('oTelK')}</dt><dd><bdi dir="ltr">{t('oTel')}</bdi></dd></div>
              <div><dt>{t('oCityK')}</dt><dd>{t('oCity')}</dd></div>
              <div><dt>{t('oItemK')}</dt><dd>{t('oItem')}</dd></div>
            </dl>
            <div className="pxn03-o-sum">
              <span>{t('oSumK')}</span>
              <b>{t('oSum')}</b>
            </div>
          </div>
        </div>
      </div>
    </div>
  ),
};
export default theme;
