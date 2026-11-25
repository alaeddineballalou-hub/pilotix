// How to put the Pilotix extension in Chrome, once per computer: a website alone cannot put photos into WhatsApp Web.
// Shown by « Envoyer des photos » and, on a computer, by the customer's first message, which is locked until the
// extension is there (owner, 25 Nov 2026: « he should install it before being able to send message »).
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EXT_ZIP, extBrowser } from '../../lib/waShare';
import { copyText, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { EXT_VIDEO, Player } from '../aide/videos';
import './photos.css';

/** `why`: what the extension does there; `last`: the step after loading it (what the agent does then). */
export function ExtInstall({ why, last }: { why: string; last: ReactNode }) {
  const { t } = useTranslation();
  // the install guide's film (the same as menu › Aide), opened on demand
  const [video, setVideo] = useState(false);
  return (
    <div className="sph-ext">
      <p className="sph-ext-why">{why}</p>
      {!extBrowser() && <p className="sph-ext-warn">{t('confirmation.photos.extBrowser')}</p>}
      <div className="sph-ext-video">
        {video && <Player src={EXT_VIDEO.src} poster={EXT_VIDEO.poster} title={t('shop.help.ext.title')} />}
        <button type="button" className="btn small" aria-expanded={video} onClick={() => setVideo((v) => !v)}>
          <Icon name="play" /> {video ? t('confirmation.photos.extVideoHide') : t('confirmation.photos.extVideo')}
        </button>
      </div>
      <ol className="sph-ext-steps">
        <li>
          <span>{t('confirmation.photos.ext1')}</span>
          <a className="btn small primary" href={EXT_ZIP} download>
            <Icon name="download" /> {t('confirmation.photos.ext1Btn')}
          </a>
        </li>
        <li>
          <span>{t('confirmation.photos.ext2')}</span>
        </li>
        <li>
          <span>{t('confirmation.photos.ext3')}</span>
          <button type="button" className="btn small" onClick={async () => toast(t((await copyText('chrome://extensions')) ? 'confirmation.msg.copied' : 'confirmation.photos.copyFail'), 'ok')}>
            <Icon name="copy" /> <span className="ltr">chrome://extensions</span>
          </button>
        </li>
        <li>
          <span>{t('confirmation.photos.ext4')}</span>
        </li>
        <li>{last}</li>
      </ol>
      <p className="sph-help">{t('confirmation.photos.extNote')}</p>
    </div>
  );
}
