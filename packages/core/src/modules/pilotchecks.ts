// Pilot Automations › Pilot Checks (administrators): the shop's KPI list for its ads — the list is in
// packages/shared/src/pilotchecks.ts (83 checks: money, leads and parcels, offer, video, landing page, page trust, Meta,
// team). Here the owner changes, check by check, its lines (« good », « bad », « stop » or « urgent »), what to do, the
// other part to fix, the helper (off, doctor, bell, door: a door only where one stands) and how much data the check
// waits for before it judges; and the general settings that belong to no single check (2 days before an ad is judged,
// how sure before a stop, the budget steps…). pilot_checks and pilot_check_settings keep only what he changed;
// « Revenir au départ » forgets it. Every change writes a line in pilot_check_log (who, when, old, new).
//
// The rows and the change lines saved for the first list (71 cases) are marked list = 'v1' and are no longer read
// (migration 114).
// This step keeps the rules only: nothing is counted, blocked or rung with them yet (the next steps read checkRules and
// checkSettings).
import {
  CHECK_LEVELS, CHECK_RANGE, CHECK_SETTINGS, CHECK_TEXT_MAX, CHECK_WAIT_MAX, CHECKS, checkDef, checkLevels, checkLinesInOrder, checkRule, checkSetting, checkSettingDef,
  CIRCLE_SETTING, circleValues,
  type CheckOverride, type CheckRule, type CheckSetting,
} from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num, numOrNull } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { getRaw } from './admin';

export interface CheckLogLine {
  id: number;
  /** the check's id, or '*' for a general setting */
  checkId: string;
  /** 'v' | 'v2' | 'g' | 's' | 'level' | 'wait' | 'action' | 'other', 'reset' (back to the starting values), or a setting's key */
  field: string;
  /** numbers and levels as text; null for a text: the app's own words (for a setting: not filled in) */
  old: string | null;
  new: string | null;
  by: string | null;
  at: string;
}

const LOG_SHOWN = 60;
/** the list the rows belong to (the first list's rows stay, unread) */
const LIST = 'v3';
/** a general setting in the change list */
const SETTING = '*';

async function overrides(db: Db): Promise<Map<string, CheckOverride>> {
  const rows = await db.query(`SELECT id, v, v2, g, s, level, wait, action, other FROM pilot_checks WHERE list = $1`, [LIST]);
  return new Map(
    rows.map((r: any) => [String(r.id), { v: numOrNull(r.v), v2: numOrNull(r.v2), g: numOrNull(r.g), s: numOrNull(r.s), level: r.level ?? null, wait: numOrNull(r.wait), action: r.action ?? null, other: r.other ?? null }]),
  );
}

/** Every check as the shop has it now (the owner's values where he changed them), in the list's order. */
export async function checkRules(db: Db): Promise<CheckRule[]> {
  const mine = await overrides(db);
  return CHECKS.map((d) => checkRule(d, mine.get(d.id)));
}

/** Every general setting as the shop has it now, in the list's order. */
export async function checkSettings(db: Db): Promise<CheckSetting[]> {
  const rows = await db.query(`SELECT key, v FROM pilot_check_settings`);
  const mine = new Map(rows.map((r: any) => [String(r.key), numOrNull(r.v)]));
  return CHECK_SETTINGS.map((d) => checkSetting(d, mine.get(d.key)));
}

async function logLines(db: Db): Promise<CheckLogLine[]> {
  const rows = await db.query(
    `SELECT l.id, l.check_id, l.field, l.old, l.new, l.at, p.name
       FROM pilot_check_log l LEFT JOIN profiles p ON p.id = l.user_id
      WHERE l.list = $1
      ORDER BY l.at DESC, l.id DESC LIMIT ${LOG_SHOWN}`,
    [LIST],
  );
  return rows.map((r: any) => ({ id: num(r.id), checkId: String(r.check_id), field: String(r.field), old: r.old ?? null, new: r.new ?? null, by: r.name ?? null, at: iso(r.at) }));
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const text = (s: string | undefined) => (s === undefined ? undefined : s.trim().replace(/\s+/g, ' ') || null);
const said = (x: number | string | null) => (x === null ? null : String(x));

const SaveIn = z.object({
  id: z.string().min(2).max(4),
  v: z.number().finite().optional(),
  v2: z.number().finite().optional(),
  /** the « good » line and the second line (stop or urgent), for the checks that have one */
  g: z.number().finite().optional(),
  s: z.number().finite().optional(),
  level: z.enum(CHECK_LEVELS).optional(),
  wait: z.number().int().min(1).max(CHECK_WAIT_MAX).optional(),
  /** his own words; empty: back to the app's text */
  action: z.string().max(CHECK_TEXT_MAX).optional(),
  other: z.string().max(CHECK_TEXT_MAX).optional(),
});

async function save(ctx: Ctx, i: z.infer<typeof SaveIn>): Promise<{ rule: CheckRule; changed: number }> {
  const d = checkDef(i.id);
  if (!d) throw bad('Cas inconnu');
  const before = checkRule(d, (await overrides(ctx.db)).get(d.id));
  const range = CHECK_RANGE[d.unit];
  const limit = (x: number | undefined, has: boolean, none: string): number | undefined => {
    if (x === undefined) return undefined;
    if (!has) throw bad(none);
    const n = round2(x);
    if (n < range.min || n > range.max) throw bad(`Le chiffre doit être entre ${range.min} et ${range.max}`);
    return n;
  };
  const v = limit(i.v, d.v !== null, 'Ce cas n’a pas de chiffre à régler');
  const v2 = limit(i.v2, d.v2 !== null, 'Ce cas n’a pas de chiffre à régler');
  const g = limit(i.g, d.g !== null, 'Ce cas n’a pas de ligne « bon »');
  const s = limit(i.s, d.s !== null, 'Ce cas n’a pas de deuxième ligne');
  if (i.level !== undefined && !checkLevels(d).includes(i.level)) throw bad('Ce cas n’a pas de porte : choisissez Docteur ou Cloche');
  if (i.wait !== undefined && !d.wait) throw bad('Ce cas n’attend pas de données');
  const after: CheckOverride = {
    v: v ?? before.v,
    v2: v2 ?? before.v2,
    g: g ?? before.g,
    s: s ?? before.s,
    level: i.level ?? before.level,
    wait: i.wait ?? before.wait,
    action: i.action === undefined ? before.action : text(i.action),
    other: i.other === undefined ? before.other : text(i.other),
  };
  if (d.op === 'out' && after.v !== null && after.v2 !== null && after.v! >= after.v2!) throw bad('Le premier chiffre doit être plus petit que le second');
  if (!checkLinesInOrder(d, after.g ?? null, after.v ?? null, after.s ?? null)) throw bad('Les lignes doivent rester dans l’ordre : bon, mauvais, puis arrêt ou urgent');
  const next = checkRule(d, after);

  const fields = ['v', 'v2', 'g', 's', 'level', 'wait', 'action', 'other'] as const;
  const moved = fields.filter((f) => before[f] !== next[f]);
  if (!moved.length) return { rule: before, changed: 0 };
  const at = new Date(ctx.now()).toISOString();
  const me = ctx.session.profile.id || null;
  // only what differs from the starting value is kept (a value put back by hand is « not changed » again)
  const keep = (f: (typeof fields)[number]) => (next.changed.includes(f) ? next[f] : null);
  if (next.changed.length)
    await ctx.db.query(
      `INSERT INTO pilot_checks (id, v, v2, g, s, level, wait, action, other, list, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v, v2 = EXCLUDED.v2, g = EXCLUDED.g, s = EXCLUDED.s, level = EXCLUDED.level, wait = EXCLUDED.wait,
         action = EXCLUDED.action, other = EXCLUDED.other, list = EXCLUDED.list, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [d.id, keep('v'), keep('v2'), keep('g'), keep('s'), keep('level'), keep('wait'), keep('action'), keep('other'), LIST, at, me],
    );
  else await ctx.db.query(`DELETE FROM pilot_checks WHERE id = $1 AND list = $2`, [d.id, LIST]);
  for (const f of moved) await ctx.db.query(`INSERT INTO pilot_check_log (check_id, field, old, new, user_id, at, list) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [d.id, f, said(before[f]), said(next[f]), me, at, LIST]);
  return { rule: next, changed: moved.length };
}

/** Back to the starting values (the change list keeps what was there). */
async function reset(ctx: Ctx, id: string): Promise<{ rule: CheckRule; changed: number }> {
  const d = checkDef(id);
  if (!d) throw bad('Cas inconnu');
  const gone = await ctx.db.query(`DELETE FROM pilot_checks WHERE id = $1 AND list = $2 RETURNING id`, [d.id, LIST]);
  if (gone.length) await ctx.db.query(`INSERT INTO pilot_check_log (check_id, field, old, new, user_id, at, list) VALUES ($1,'reset',NULL,NULL,$2,$3,$4)`, [d.id, ctx.session.profile.id || null, new Date(ctx.now()).toISOString(), LIST]);
  return { rule: checkRule(d, undefined), changed: gone.length };
}

const SettingIn = z.object({
  key: z.string().min(2).max(40),
  /** the new value; null: back to the starting one (or « not filled in ») */
  v: z.number().finite().nullable(),
});

/** One general setting: a whole number in its range; the starting value typed back (or null) is « not changed » again. */
async function saveSetting(ctx: Ctx, i: z.infer<typeof SettingIn>): Promise<{ setting: CheckSetting; changed: number }> {
  const d = checkSettingDef(i.key);
  if (!d) throw bad('Réglage inconnu');
  const before = (await checkSettings(ctx.db)).find((x) => x.key === d.key)!;
  if (i.v !== null && (!Number.isInteger(i.v) || i.v < d.min || i.v > d.max)) throw bad(`Tapez un nombre entier entre ${d.min} et ${d.max}`);
  const next = checkSetting(d, i.v);
  if (next.v === before.v) return { setting: before, changed: 0 };
  const at = new Date(ctx.now()).toISOString();
  const me = ctx.session.profile.id || null;
  if (next.changed)
    await ctx.db.query(
      `INSERT INTO pilot_check_settings (key, v, updated_at, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET v = EXCLUDED.v, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [d.key, next.v, at, me],
    );
  else await ctx.db.query(`DELETE FROM pilot_check_settings WHERE key = $1`, [d.key]);
  await ctx.db.query(`INSERT INTO pilot_check_log (check_id, field, old, new, user_id, at, list) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [SETTING, d.key, said(before.v), said(next.v), me, at, LIST]);
  return { setting: next, changed: 1 };
}

/**
 * The two days of the week the shop's tests follow: the day they start and the day of the verdict (0 Sunday … 6
 * Saturday). They are set in Marketing › Stratégies (the « Life ad circle »); the texts here that name a day show them.
 */
export async function checkDays(db: Db): Promise<{ test: number; judge: number }> {
  const v = circleValues(await getRaw<unknown>(db, CIRCLE_SETTING, null));
  return { test: Number(v.testDay), judge: Number(v.judgeDay) };
}

export const pilotChecksProcs = {
  // administrators only: the rules are the owner's
  'auto.checks': proc([], z.object({}), async (ctx) => ({ rules: await checkRules(ctx.db), settings: await checkSettings(ctx.db), log: await logLines(ctx.db), days: await checkDays(ctx.db) })),
  'auto.checkSave': proc([], SaveIn, (ctx, i) => save(ctx, i)),
  'auto.checkReset': proc([], z.object({ id: z.string().min(2).max(4) }), (ctx, i) => reset(ctx, i.id)),
  'auto.checkSetting': proc([], SettingIn, (ctx, i) => saveSetting(ctx, i)),
};
