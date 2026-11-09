// « Aide » (menu › Aide, #/aide): short films that show how to do one thing in Pilotix, for everyone. The films are
// in apps/web/public/videos; how one is made (a page drawn from the time alone, real Pilotix and Chrome screens,
// rendered to MP4 with its sound made in code) is in media/aide/<film>/README.md.
import { useTranslation } from 'react-i18next';
import { EXT_ZIP, sendMode } from '../../lib/waShare';
import { copyText, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import './aide.css';

const file = (name: string) => `${import.meta.env.BASE_URL}videos/${name}`;

/** « Installer l'extension WhatsApp »: 1 min, in French, with sound (the 7 steps of the « Envoyer photos » guide) */
export const EXT_VIDEO = { src: file('installer-extension-whatsapp.mp4'), poster: file('installer-extension-whatsapp.jpg') };

/** A film: it never starts by itself (the person presses play), it loads only its first image until then. */
export function Player({ src, poster, title }: { src: string; poster: string; title: string }) {
  return <video className="aide-player" src={src} poster={poster} controls preload="metadata" playsInline aria-label={title} />;
}

/** The add-on's film, its 7 steps written beside it, the download and the address to copy. */
export function ExtensionHelp() {
  const { t } = useTranslation();
  const steps = [1, 2, 3, 4, 5, 6, 7].map((n) => t(`shop.help.ext.s${n}`));
  // a computer installs the add-on; a phone or a tablet (and the Pilotix app) sends the photos without it
  const computer = sendMode() === 'pc';
  const copy = async () => {
    const ok = await copyText('chrome://extensions');
    toast(t(ok ? 'shop.help.copied' : 'shop.help.copyFail'), ok ? 'ok' : 'bad');
  };
  return (
    <section className="card aide-film" aria-labelledby="aide-ext-title">
      <div className="aide-film-v">
        <Player src={EXT_VIDEO.src} poster={EXT_VIDEO.poster} title={t('shop.help.ext.title')} />
        {computer && (
          <div className="aide-acts">
            <a className="btn primary" href={EXT_ZIP} download>
              <Icon name="download" /> {t('shop.help.ext.download')}
            </a>
            <button type="button" className="btn" onClick={copy}>
              <Icon name="copy" /> <span className="ltr">chrome://extensions</span>
            </button>
          </div>
        )}
      </div>
      <div className="aide-film-t">
        <div className="aide-tags">
          <span className="chip">{t('shop.help.ext.time')}</span>
          <span className="chip">{t('shop.help.ext.where')}</span>
          <span className="chip">{t('shop.help.ext.once')}</span>
        </div>
        <h2 id="aide-ext-title">{t('shop.help.ext.title')}</h2>
        <p className="muted">{t('shop.help.ext.what')}</p>
        <ol className="aide-steps">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        <p className={`small aide-phone${computer ? ' muted' : ' on'}`}>{t('shop.help.ext.phone')}</p>
      </div>
    </section>
  );
}
