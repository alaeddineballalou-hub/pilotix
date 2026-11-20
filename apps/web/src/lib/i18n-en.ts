// The English texts, in a file of their own: fetched only for the people who read Pilotix in English (lib/i18n.ts).
export default import.meta.glob<{ default: Record<string, unknown> }>('../locales/en/*.json', { eager: true });
