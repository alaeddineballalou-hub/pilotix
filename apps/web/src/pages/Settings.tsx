import { Language, LANGUAGES } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { serverUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { store } from '../lib/store';

const langLabel: Record<Language, string> = { fr: 'Français', en: 'English', ar: 'العربية' };
type Theme = 'system' | 'light' | 'dark';

export function applyTheme(theme: Theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  store.set('theme', theme);
}

export function Settings() {
  const { t, i18n } = useTranslation();
  const { setLanguage } = useAuth();
  const [theme, setTheme] = useState<Theme>((store.get('theme') as Theme) || 'system');

  return (
    <section className="card" style={{ maxWidth: 560 }}>
      <label className="field">
        <span>{t('settings.language')}</span>
        <div className="tabs">
          {LANGUAGES.map((l) => (
            <button key={l} className={`tab ${i18n.language === l ? 'on' : ''}`} onClick={() => setLanguage(l)}>
              {langLabel[l]}
            </button>
          ))}
        </div>
      </label>
      <label className="field">
        <span>{t('settings.theme')}</span>
        <div className="tabs">
          {(['system', 'light', 'dark'] as Theme[]).map((th) => (
            <button
              key={th}
              className={`tab ${theme === th ? 'on' : ''}`}
              onClick={() => {
                setTheme(th);
                applyTheme(th);
              }}
            >
              {t(`settings.${th}`)}
            </button>
          ))}
        </div>
      </label>
      <div className="field">
        <span>{t('settings.server')}</span>
        <span className="ltr">{serverUrl() || '—'}</span>
      </div>
    </section>
  );
}
