// The demo database lives in the browser and is rebuilt on every reload. These two functions let the demo
// keep a few things the user saved: the shared column presets and each user's screen choices (by email).
import { Db } from './db';
import { getSetting, setSetting } from './settings';

export interface DemoKeep {
  colPresets?: unknown[];
  colPresetActive?: unknown;
  ui?: Record<string, Record<string, unknown>>;
}

/** What to keep from the demo database (small: presets and screen choices). */
export async function demoSnapshot(db: Db): Promise<DemoKeep> {
  const ui: Record<string, Record<string, unknown>> = {};
  for (const r of await db.query<{ email: string; ui: unknown }>("SELECT email, ui FROM profiles WHERE ui <> '{}'::jsonb")) {
    const v = typeof r.ui === 'string' ? JSON.parse(r.ui) : r.ui;
    if (v && typeof v === 'object') ui[r.email.toLowerCase()] = v as Record<string, unknown>;
  }
  return { colPresets: await getSetting(db, 'colPresets'), colPresetActive: await getSetting(db, 'colPresetActive'), ui };
}

/** Puts back what was kept into a freshly built demo database. Bad data is ignored. */
export async function demoRestore(db: Db, keep: DemoKeep | null | undefined) {
  if (!keep || typeof keep !== 'object') return;
  if (Array.isArray(keep.colPresets)) {
    const ok = keep.colPresets.filter(
      (p: any) => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.cols) && p.cols.every((c: unknown) => typeof c === 'string'),
    ) as any[];
    await setSetting(db, 'colPresets', ok.slice(0, 30));
    const a: any = keep.colPresetActive;
    const active = a && typeof a.id === 'string' && ok.some((p) => p.id === a.id) ? { id: a.id as string, at: Number(a.at) || 0, by: String(a.by ?? '') } : null;
    await setSetting(db, 'colPresetActive', active);
  }
  if (keep.ui && typeof keep.ui === 'object')
    for (const [email, v] of Object.entries(keep.ui)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const json = JSON.stringify(v);
      if (json.length > 200_000) continue;
      await db.query('UPDATE profiles SET ui = $2::jsonb WHERE lower(email) = $1', [email.toLowerCase(), json]);
    }
}
