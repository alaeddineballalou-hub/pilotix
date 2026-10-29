// Sociétés de livraison › Préférences: each seller's own choices — how an order gets its delivery company in « Manuel », who may
// change it by hand, whether strict rules are locked, who writes the Pilot rules, the backup company for waiting « Livraison privée » orders, and
// when a « sans stock » order rings. Everyone reads them (the screens follow them); only an admin changes them.
import { z } from 'zod';
import type { Db } from '../db';
import { bad, proc } from '../rpc';
import { DEFAULT_SETTINGS, getSetting, setSetting, SettingsMap } from '../settings';

export type Prefs = SettingsMap['prefs'];
export const RECOMMENDED_PREFS: Prefs = DEFAULT_SETTINGS.prefs;

/** The shop's choices, every missing one filled with the recommended one (a choice added later starts there). */
export async function getPrefs(db: Db): Promise<Prefs> {
  const p = await getSetting(db, 'prefs');
  const d = RECOMMENDED_PREFS;
  return {
    ...d,
    ...p,
    changeCompany: { ...d.changeCompany, ...(p.changeCompany ?? {}) },
    rulesBy: { ...d.rulesBy, ...(p.rulesBy ?? {}) },
    privateBackup: { ...d.privateBackup, ...(p.privateBackup ?? {}) },
  };
}

const prefsIn = z.object({
  manualDefault: z.boolean(),
  changeCompany: z.object({ confirmation: z.boolean(), agency: z.boolean(), depot: z.boolean(), manager: z.boolean() }),
  strictLock: z.boolean(),
  rulesBy: z.object({ confirmation: z.boolean(), agency: z.boolean(), depot: z.boolean(), manager: z.boolean() }),
  privateBackup: z.object({ on: z.boolean(), hours: z.number().int().min(1).max(240), companyId: z.number().int().positive().nullable() }),
  noStockDays: z.number().int().min(1).max(30),
  livreurAlerts: z.array(z.string().regex(/^(failed|returning):[a-z_]+$/)).max(20),
});

export const prefsProcs = {
  /** The choices, and the recommended ones (« Remettre les choix conseillés »). */
  'prefs.get': proc(null, z.object({}), async (ctx) => ({ prefs: await getPrefs(ctx.db), recommended: RECOMMENDED_PREFS })),

  /** Admin only: save every choice at once. */
  'prefs.set': proc([], prefsIn, async (ctx, i) => {
    const b = i.privateBackup;
    if (b.on && !b.companyId) throw bad('Choisissez la société de secours.');
    if (b.companyId) {
      const c = await ctx.db.query<{ kind: string }>('SELECT kind FROM delivery_companies WHERE id = $1', [b.companyId]);
      if (!c[0]) throw bad('Société de livraison introuvable.');
      if (c[0].kind === 'own') throw bad('La société de secours doit être une société de livraison, pas vos livreurs.');
    }
    await setSetting(ctx.db, 'prefs', { ...i, privateBackup: { ...b, companyId: b.companyId ?? null } }, ctx.session.profile.id);
    return { ok: true };
  }),
};
