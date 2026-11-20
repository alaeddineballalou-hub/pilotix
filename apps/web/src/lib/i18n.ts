import type { Language } from '@pilotix/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { store } from './store';

// Every feature keeps its own translation files: locales/<lang>/<feature>.json → t('<feature>:key') or t('<feature>.key').
// French sits in the app's first file (it is also the fallback when a text is missing). English and Arabic each come in
// a file of their own, fetched only for the people who read them: one language's texts weigh about as much as the rest
// of the app, so carrying all three made the first open twice as heavy.
type Files = Record<string, { default: Record<string, unknown> }>;
const FR = import.meta.glob('../locales/fr/*.json', { eager: true }) as Files;
const LOAD: Record<Exclude<Language, 'fr'>, () => Promise<{ default: Files }>> = {
  en: () => import('./i18n-en'),
  ar: () => import('./i18n-ar'),
};

/** One language's files as one tree: the file's name is the first part of the key (« orders.tabs.all »). */
function bundle(files: Files): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, mod] of Object.entries(files)) {
    const m = path.match(/locales\/\w+\/([\w-]+)\.json$/);
    if (m) out[m[1]] = mod.default;
  }
  return out;
}

// Arabic counts have six forms (0, 1, 2, 3–10, 11–99, other); the files give « _one » and « _other ». Without a key
// for the others, i18next would show the French text: the plain key (tried before French) takes the « _other » text.
function pluralFallback(o: Record<string, unknown>) {
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) pluralFallback(v as Record<string, unknown>);
    else if (typeof v === 'string' && k.endsWith('_other') && !(k.slice(0, -6) in o)) o[k.slice(0, -6)] = v;
  }
}

i18n.use(initReactI18next).init({
  resources: { fr: { translation: bundle(FR) } },
  lng: 'fr',
  fallbackLng: 'fr',
  interpolation: { escapeValue: false },
  returnNull: false,
});

const loaded = new Set<Language>(['fr']);
const loading = new Map<Language, Promise<void>>();

/** Makes sure a language's texts are there (French always is). A failed download is tried again next time. */
export function loadLanguage(lang: Language): Promise<void> {
  if (loaded.has(lang)) return Promise.resolve();
  let p = loading.get(lang);
  if (!p) {
    p = LOAD[lang as Exclude<Language, 'fr'>]().then(({ default: files }) => {
      const texts = bundle(files);
      if (lang === 'ar') pluralFallback(texts);
      i18n.addResourceBundle(lang, 'translation', texts, true, true);
      loaded.add(lang);
    });
    p.catch(() => loading.delete(lang));
    loading.set(lang, p);
  }
  return p;
}

const saved = store.get('lang') as Language | null;
const initial: Language = saved === 'en' || saved === 'ar' ? saved : 'fr';
/** the language last asked for: a slow download never switches back to a language the person has left since */
let wanted: Language = initial;

/**
 * Arabic flips the page right-to-left. Numbers, phones and references keep their direction (class "ltr").
 * The page changes language once that language's texts are there (a moment, the first time); offline, it stays as it is.
 */
export function applyLanguage(lang: Language): Promise<void> {
  wanted = lang;
  store.set('lang', lang);
  return loadLanguage(lang).then(
    async () => {
      if (wanted !== lang) return;
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      if (i18n.language !== lang) await i18n.changeLanguage(lang);
    },
    () => undefined,
  );
}

/** The app is drawn once the reader's language is there (main.tsx waits for it), so it never opens in French first. */
export const i18nReady: Promise<void> = applyLanguage(initial);

export default i18n;
