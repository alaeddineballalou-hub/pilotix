// Pilot Automations › Pilot Checks (administrators): the owner's rules for the cases of the « Pilotix Judge » — the list
// is in packages/shared/src/pilotchecks.ts (71 cases: offer, video, landing page, page trust, Meta, team). Here he
// changes, case by case, the limit (« bad when »), what to do, the other part to fix, the helper (off, doctor, bell,
// door: a door only where one stands) and how much data the case waits for before it judges. pilot_checks keeps only
// what he changed; « Revenir au départ » forgets it. Every change writes a line in pilot_check_log (who, when, old, new).
//
// This step keeps the rules only: nothing is counted, blocked or rung with them yet (the next steps read checkRules).
import { CHECK_LEVELS, CHECK_RANGE, CHECK_TEXT_MAX, CHECK_WAIT_MAX, CHECKS, checkDef, checkLevels, checkRule, type CheckOverride, type CheckRule } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num, numOrNull } from '../db';
import { bad, Ctx, proc } from '../rpc';

export interface CheckLogLine {
  id: number;
  checkId: string;
  /** 'v' | 'v2' | 'level' | 'wait' | 'action' | 'other', or 'reset' (back to the starting values) */
  field: string;
  /** numbers and levels as text; null for a text: the app's own words */
  old: string | null;
  new: string | null;
  by: string | null;
  at: string;
}

const LOG_SHOWN = 60;

async function overrides(db: Db): Promise<Map<string, CheckOverride>> {
  const rows = await db.query(`SELECT id, v, v2, level, wait, action, other FROM pilot_checks`);
  return new Map(rows.map((r: any) => [String(r.id), { v: numOrNull(r.v), v2: numOrNull(r.v2), level: r.level ?? null, wait: numOrNull(r.wait), action: r.action ?? null, other: r.other ?? null }]));
}

/** Every case as the shop has it now (the owner's values where he changed them), in the table's order. */
export async function checkRules(db: Db): Promise<CheckRule[]> {
  const mine = await overrides(db);
  return CHECKS.map((d) => checkRule(d, mine.get(d.id)));
}

async function logLines(db: Db): Promise<CheckLogLine[]> {
  const rows = await db.query(
    `SELECT l.id, l.check_id, l.field, l.old, l.new, l.at, p.name
       FROM pilot_check_log l LEFT JOIN profiles p ON p.id = l.user_id
      ORDER BY l.at DESC, l.id DESC LIMIT ${LOG_SHOWN}`,
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
  const limit = (x: number | undefined, has: boolean): number | undefined => {
    if (x === undefined) return undefined;
    if (!has) throw bad('Ce cas n’a pas de chiffre à régler');
    const n = round2(x);
    if (n < range.min || n > range.max) throw bad(`Le chiffre doit être entre ${range.min} et ${range.max}`);
    return n;
  };
  const v = limit(i.v, d.v !== null);
  const v2 = limit(i.v2, d.v2 !== null);
  if (i.level !== undefined && !checkLevels(d).includes(i.level)) throw bad('Ce cas n’a pas de porte : choisissez Docteur ou Cloche');
  if (i.wait !== undefined && !d.wait) throw bad('Ce cas n’attend pas de données');
  const after: CheckOverride = {
    v: v ?? before.v,
    v2: v2 ?? before.v2,
    level: i.level ?? before.level,
    wait: i.wait ?? before.wait,
    action: i.action === undefined ? before.action : text(i.action),
    other: i.other === undefined ? before.other : text(i.other),
  };
  if (d.op === 'out' && after.v !== null && after.v2 !== null && after.v! >= after.v2!) throw bad('Le premier chiffre doit être plus petit que le second');
  const next = checkRule(d, after);

  const fields = ['v', 'v2', 'level', 'wait', 'action', 'other'] as const;
  const moved = fields.filter((f) => before[f] !== next[f]);
  if (!moved.length) return { rule: before, changed: 0 };
  const at = new Date(ctx.now()).toISOString();
  const me = ctx.session.profile.id || null;
  // only what differs from the starting value is kept (a value put back by hand is « not changed » again)
  const keep = (f: (typeof fields)[number]) => (next.changed.includes(f) ? next[f] : null);
  if (next.changed.length)
    await ctx.db.query(
      `INSERT INTO pilot_checks (id, v, v2, level, wait, action, other, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v, v2 = EXCLUDED.v2, level = EXCLUDED.level, wait = EXCLUDED.wait, action = EXCLUDED.action,
         other = EXCLUDED.other, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [d.id, keep('v'), keep('v2'), keep('level'), keep('wait'), keep('action'), keep('other'), at, me],
    );
  else await ctx.db.query(`DELETE FROM pilot_checks WHERE id = $1`, [d.id]);
  for (const f of moved) await ctx.db.query(`INSERT INTO pilot_check_log (check_id, field, old, new, user_id, at) VALUES ($1,$2,$3,$4,$5,$6)`, [d.id, f, said(before[f]), said(next[f]), me, at]);
  return { rule: next, changed: moved.length };
}

/** Back to the starting values (the change list keeps what was there). */
async function reset(ctx: Ctx, id: string): Promise<{ rule: CheckRule; changed: number }> {
  const d = checkDef(id);
  if (!d) throw bad('Cas inconnu');
  const gone = await ctx.db.query(`DELETE FROM pilot_checks WHERE id = $1 RETURNING id`, [d.id]);
  if (gone.length) await ctx.db.query(`INSERT INTO pilot_check_log (check_id, field, old, new, user_id, at) VALUES ($1,'reset',NULL,NULL,$2,$3)`, [d.id, ctx.session.profile.id || null, new Date(ctx.now()).toISOString()]);
  return { rule: checkRule(d, undefined), changed: gone.length };
}

export const pilotChecksProcs = {
  // administrators only: the rules are the owner's
  'auto.checks': proc([], z.object({}), async (ctx) => ({ rules: await checkRules(ctx.db), log: await logLines(ctx.db) })),
  'auto.checkSave': proc([], SaveIn, (ctx, i) => save(ctx, i)),
  'auto.checkReset': proc([], z.object({ id: z.string().min(2).max(4) }), (ctx, i) => reset(ctx, i.id)),
};
