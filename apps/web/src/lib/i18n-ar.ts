// The Arabic texts, in a file of their own: fetched only for the people who read Pilotix in Arabic (lib/i18n.ts).
export default import.meta.glob<{ default: Record<string, unknown> }>('../locales/ar/*.json', { eager: true });
