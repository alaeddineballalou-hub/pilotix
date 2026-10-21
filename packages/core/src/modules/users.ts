import { LANGUAGES, Profile, ROLES } from '@pilotix/shared';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Db, isoOrNull, num, numOrNull } from '../db';
import { AppError, bad, forbidden, makeSession, notFound, proc } from '../rpc';

export const toProfile = (r: any): Profile => ({
  id: num(r.id),
  name: r.name,
  email: r.email,
  phone: r.phone,
  roles: r.roles,
  language: r.language,
  active: r.active,
  lastSeenAt: isoOrNull(r.last_seen_at),
  livreurCompanyId: numOrNull(r.livreur_company_id),
});

export async function profileById(db: Db, id: number): Promise<Profile | null> {
  const r = (await db.query('SELECT * FROM profiles WHERE id = $1', [id]))[0];
  return r ? toProfile(r) : null;
}

/** Checks email + password; returns the session or throws one generic message. */
export async function login(db: Db, email: string, password: string) {
  const r = (await db.query('SELECT * FROM profiles WHERE email = $1', [email.trim().toLowerCase()]))[0];
  const ok = r ? await bcrypt.compare(password, r.password_hash) : await bcrypt.compare(password, '$2a$10$' + 'x'.repeat(53));
  if (!r || !ok) throw new AppError('unauthorized', 'Email ou mot de passe incorrect');
  if (!r.active) throw new AppError('unauthorized', 'Votre compte est désactivé');
  await db.query("UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE id = $1", [r.id]);
  return makeSession(toProfile(r));
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);

const NewUser = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(200),
  phone: z.string().max(20).nullable().optional(),
  password: z.string().min(8).max(200),
  roles: z.array(z.enum(ROLES)).min(1),
  language: z.enum(LANGUAGES).default('fr'),
  livreurCompanyId: z.number().int().positive().nullable().optional(),
});

export const usersProcs = {
  'me.get': proc(null, z.object({}), async (ctx) => {
    const p = await profileById(ctx.db, ctx.session.profile.id);
    if (!p || !p.active) throw new AppError('unauthorized', 'Votre compte est désactivé');
    return makeSession(p);
  }),
  'me.language': proc(null, z.object({ language: z.enum(LANGUAGES) }), async (ctx, i) => {
    await ctx.db.query('UPDATE profiles SET language=$2 WHERE id=$1', [ctx.session.profile.id, i.language]);
    return { ok: true };
  }),
  'me.password': proc(null, z.object({ current: z.string().min(1), next: z.string().min(8).max(200) }), async (ctx, i) => {
    const r = (await ctx.db.query('SELECT password_hash FROM profiles WHERE id=$1', [ctx.session.profile.id]))[0];
    if (!r || !(await bcrypt.compare(i.current, r.password_hash))) throw bad('Mot de passe actuel incorrect');
    await ctx.db.query('UPDATE profiles SET password_hash=$2 WHERE id=$1', [ctx.session.profile.id, await hashPassword(i.next)]);
    return { ok: true };
  }),
  /** Heartbeat every minute: online / in a call / idle. */
  'me.seen': proc(null, z.object({ presence: z.enum(['online', 'call', 'idle']).default('online') }), async (ctx, i) => {
    await ctx.db.query('UPDATE profiles SET last_seen_at = now(), presence = $2 WHERE id = $1', [ctx.session.profile.id, i.presence]);
    ctx.emit({ type: 'presence', id: ctx.session.profile.id, data: i.presence });
    return { ok: true };
  }),

  /** Everyone sees the team list (names, roles, presence) — needed for agent / livreur pickers. */
  'users.list': proc(null, z.object({ role: z.enum(ROLES).optional(), activeOnly: z.boolean().default(false) }), async (ctx, i) => {
    const rows = await ctx.db.query(
      `SELECT *, CASE WHEN last_seen_at > now() - interval '3 minutes' THEN presence ELSE 'offline' END AS live
       FROM profiles WHERE ($1::text IS NULL OR $1 = ANY(roles)) AND (NOT $2 OR active) ORDER BY name`,
      [i.role ?? null, i.activeOnly],
    );
    return rows.map((r: any) => ({ ...toProfile(r), presence: r.live as 'online' | 'call' | 'idle' | 'offline' }));
  }),
  'users.create': proc([], NewUser, async (ctx, b) => {
    try {
      const r = (
        await ctx.db.query(
          'INSERT INTO profiles (name, email, phone, password_hash, roles, language, livreur_company_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [b.name, b.email.toLowerCase(), b.phone ?? null, await hashPassword(b.password), b.roles, b.language, b.livreurCompanyId ?? null],
        )
      )[0];
      return toProfile(r);
    } catch (e: any) {
      if (String(e?.code) === '23505' || /unique|duplicate/i.test(e?.message)) throw bad('Cet email est déjà utilisé');
      throw e;
    }
  }),
  'users.update': proc([], NewUser.partial().extend({ id: z.number().int().positive(), active: z.boolean().optional() }), async (ctx, b) => {
    if (b.id === ctx.session.profile.id && (b.active === false || (b.roles && !b.roles.includes('admin')))) throw forbidden('Vous ne pouvez pas retirer votre propre accès administrateur');
    const r = (
      await ctx.db.query(
        `UPDATE profiles SET name=COALESCE($2,name), email=COALESCE($3,email), phone=COALESCE($4,phone), password_hash=COALESCE($5,password_hash),
           roles=COALESCE($6,roles), language=COALESCE($7,language), active=COALESCE($8,active), livreur_company_id=COALESCE($9,livreur_company_id) WHERE id=$1 RETURNING *`,
        [b.id, b.name ?? null, b.email?.toLowerCase() ?? null, b.phone ?? null, b.password ? await hashPassword(b.password) : null, b.roles ?? null, b.language ?? null, b.active ?? null, b.livreurCompanyId ?? null],
      )
    )[0];
    if (!r) throw notFound();
    return toProfile(r);
  }),
};
