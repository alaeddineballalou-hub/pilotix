import type { Language } from '@pilotix/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { store } from './store';

// Every feature keeps its own translation files: locales/<lang>/<feature>.json → t('<feature>:key') or t('<feature>.key').
const files = import.meta.glob('../locales/*/*.json', { eager: true }) as Record<string, { default: Record<string, unknown> }>;
const resources: Record<string, { translation: Record<string, unknown> }> = { fr: { translation: {} }, en: { translation: {} }, ar: { translation: {} } };
for (const [path, mod] of Object.entries(files)) {
  const m = path.match(/locales\/(\w+)\/([\w-]+)\.json$/);
  if (!m) continue;
  const [, lang, ns] = m;
  resources[lang] ??= { translation: {} };
  resources[lang].translation[ns] = mod.default;
}

// Arabic counts have six forms (0, 1, 2, 3–10, 11–99, other); the files give « _one » and « _other ». Without a key
// for the others, i18next would show the French text: the plain key (tried before French) takes the « _other » text.
function pluralFallback(o: Record<string, unknown>) {
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) pluralFallback(v as Record<string, unknown>);
    else if (typeof v === 'string' && k.endsWith('_other') && !(k.slice(0, -6) in o)) o[k.slice(0, -6)] = v;
  }
}
pluralFallback(resources.ar.translation);

const saved = store.get('lang') as Language | null;
const initial: Language = saved ?? 'fr';

i18n.use(initReactI18next).init({
  resources,
  lng: initial,
  fallbackLng: 'fr',
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Arabic flips the page right-to-left. Numbers, phones and references keep their direction (class "ltr"). */
export function applyLanguage(lang: Language) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  store.set('lang', lang);
  if (i18n.language !== lang) i18n.changeLanguage(lang);
}
applyLanguage(initial);

export default i18n;
