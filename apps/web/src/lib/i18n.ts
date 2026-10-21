import type { Language } from '@pilotix/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import fr from '../locales/fr.json';
import { store } from './store';

const saved = store.get('lang') as Language | null;
const guess: Language = saved ?? (navigator.language.startsWith('ar') ? 'ar' : navigator.language.startsWith('en') ? 'en' : 'fr');

i18n.use(initReactI18next).init({
  resources: { fr: { translation: fr }, en: { translation: en }, ar: { translation: ar } },
  lng: guess,
  fallbackLng: 'fr',
  interpolation: { escapeValue: false },
});

/** Arabic flips the whole page right-to-left; numbers and phones keep their direction (see .ltr in CSS). */
export function applyLanguage(lang: Language) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  store.set('lang', lang);
  if (i18n.language !== lang) i18n.changeLanguage(lang);
}
applyLanguage(guess);

const locales: Record<Language, string> = { fr: 'fr-DZ', en: 'en-GB', ar: 'ar-DZ' };

/** Dinars with spaces as thousands separators, Western digits in every language (as used on Algerian receipts). */
export function formatDZD(value: number, lang: Language): string {
  const n = new Intl.NumberFormat(locales[lang], { maximumFractionDigits: 0, numberingSystem: 'latn' } as Intl.NumberFormatOptions).format(value);
  return i18n.t('common.dzd', { value: n });
}

export function formatDate(iso: string, lang: Language, withTime = true): string {
  return new Intl.DateTimeFormat(locales[lang], {
    day: '2-digit',
    month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'Africa/Algiers',
    numberingSystem: 'latn',
  } as Intl.DateTimeFormatOptions).format(new Date(iso));
}

export default i18n;
