import { LANGUAGES, Profile, ROLES } from '@pilotix/shared';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Db, isoOrNull, num, numOrNull } from '../db';
import { AppError, bad, Ctx, forbidden, makeSession, notFound, proc } from '../rpc';

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
  avatar: r.avatar ?? null,
  referralCode: r.referral_code ?? null,
  canManageUsers: !!r.can_manage_users,
  archived: !!r.archived_at,
});

/**
 * Team accounts: the administrator, or someone the administrator allowed (a manager, a supervisor). Such a person never
 * touches administrators, nor other people who have this right, nor gives either right: nobody can raise themselves.
 */
function needUserManager(ctx: Ctx) {
  if (!ctx.session.isAdmin && !ctx.session.canManageUsers) throw forbidden();
}
async function needCanEdit(ctx: Ctx, id: number) {
  needUserManager(ctx);
  if (ctx.session.isAdmin) return;
  if (id === ctx.session.profile.id) throw forbidden('Changez vos propres informations dans Mon profil');
  const t = (await ctx.db.query('SELECT roles, can_manage_users FROM profiles WHERE id = $1', [id]))[0];
  if (!t) throw notFound();
  if ((t.roles as string[]).includes('admin') || t.can_manage_users) throw forbidden('Seul l’administrateur peut modifier ce compte');
}
function needGrantable(ctx: Ctx, b: { roles?: string[]; canManageUsers?: boolean }) {
  if (ctx.session.isAdmin) return;
  if (b.roles?.includes('admin')) throw forbidden('Seul l’administrateur peut donner le rôle Administrateur');
  if (b.canManageUsers !== undefined) throw forbidden('Seul l’administrateur peut donner ce droit');
}

/** The shop's plan allows N active accounts (a multi-shop server): one more is refused beyond that. */
async function needSeat(ctx: Ctx) {
  const max = ctx.shop?.maxUsers;
  if (!max) return;
  const n = num((await ctx.db.query(`SELECT count(*)::int AS n FROM profiles WHERE active AND email NOT LIKE '%@pilotix.invalid'`))[0]?.n);
  if (n >= max) throw bad(`Votre formule Pilotix permet ${max} comptes actifs. Désactivez un compte, ou demandez à Pilotix une formule plus grande.`);
}

/** The shop's plan allows N active livreurs (a multi-shop server): one more is refused beyond that. */
async function needDriverSeat(ctx: Ctx, exceptId: number | null = null) {
  const max = ctx.shop?.maxDrivers;
  if (max === null || max === undefined) return;
  const n = num(
    (await ctx.db.query(`SELECT count(*)::int AS n FROM profiles WHERE active AND 'livreur' = ANY(roles) AND email NOT LIKE '%@pilotix.invalid' AND ($1::bigint IS NULL OR id <> $1)`, [exceptId]))[0]?.n,
  );
  if (n >= max)
    throw bad(
      max === 0
        ? 'Votre formule Pilotix ne comprend pas de livreurs. Demandez à Pilotix une formule plus grande.'
        : `Votre formule Pilotix permet ${max} livreur${max > 1 ? 's' : ''} actif${max > 1 ? 's' : ''}. Désactivez un livreur, ou demandez à Pilotix une formule plus grande.`,
    );
}

export async function profileById(db: Db, id: number): Promise<Profile | null> {
  const r = (await db.query('SELECT * FROM profiles WHERE id = $1', [id]))[0];
  return r ? toProfile(r) : null;
}

let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= bcrypt.hash('not-a-real-password', 12));

/** Checks email + password; returns the session or throws one generic message. */
export async function login(db: Db, email: string, password: string) {
  const r = (await db.query('SELECT * FROM profiles WHERE email = $1', [email.trim().toLowerCase()]))[0];
  // an unknown email takes as long as a known one (a real hash of the same cost): nobody learns which emails have an account
  const ok = r ? await bcrypt.compare(password, r.password_hash) : await bcrypt.compare(password, await dummyHash());
  if (!r || !ok) throw new AppError('unauthorized', 'Email ou mot de passe incorrect');
  if (!r.active) throw new AppError('unauthorized', 'Votre compte est désactivé');
  await db.query("UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE id = $1", [r.id]);
  return makeSession(toProfile(r));
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);

const NewUser = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(200),
  phone: z.string().max(20).nullable().optional(),
  password: z.string().min(8).max(200),
  roles: z.array(z.enum(ROLES)).min(1).max(20),
  language: z.enum(LANGUAGES).default('fr'),
  livreurCompanyId: z.number().int().positive().nullable().optional(),
  canManageUsers: z.boolean().optional(),
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
    // every other session (another phone, a stolen token) is logged out
    await ctx.db.query('UPDATE profiles SET password_hash=$2, token_version = token_version + 1 WHERE id=$1', [ctx.session.profile.id, await hashPassword(i.next)]);
    return { ok: true };
  }),
  /** What I chose on screen (columns, the column preset in use…), saved with my account. */
  'me.ui': proc(null, z.object({}), async (ctx) => {
    const r = await ctx.db.query('SELECT ui FROM profiles WHERE id=$1', [ctx.session.profile.id]);
    const ui = r[0]?.ui;
    return (ui && typeof ui === 'object' ? ui : typeof ui === 'string' ? JSON.parse(ui) : {}) as Record<string, unknown>;
  }),
  /** Saves one of my screen choices (null removes it). Small values only. */
  'me.setUi': proc(null, z.object({ key: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), value: z.unknown() }), async (ctx, i) => {
    const me = ctx.session.profile.id;
    if (i.value === null || i.value === undefined) {
      await ctx.db.query('UPDATE profiles SET ui = ui - $2 WHERE id=$1', [me, i.key]);
      return { ok: true };
    }
    const json = JSON.stringify(i.value);
    if (json.length > 20_000) throw bad('Choix trop volumineux');
    const r = await ctx.db.query('SELECT (SELECT count(*) FROM jsonb_object_keys(ui))::int AS n, jsonb_exists(ui, $2) AS has FROM profiles WHERE id=$1', [me, i.key]);
    if ((r[0]?.n ?? 0) >= 300 && !r[0]?.has) throw bad('Trop de choix enregistrés');
    await ctx.db.query('UPDATE profiles SET ui = jsonb_set(ui, ARRAY[$2::text], $3::jsonb, true) WHERE id=$1', [me, i.key, json]);
    return { ok: true };
  }),
  /** My profile: name, phone and picture (the email is the login and never changes). */
  'me.update': proc(null, z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().max(30).nullable().optional(), avatar: z.string().max(400_000).nullable().optional() }), async (ctx, i) => {
    if (i.avatar && !/^data:image\/(png|jpe?g|webp);base64,/.test(i.avatar)) throw bad('Image invalide');
    const me = ctx.session.profile.id;
    if (i.avatar !== undefined) await ctx.db.query('UPDATE profiles SET name=$2, phone=$3, avatar=$4 WHERE id=$1', [me, i.name, i.phone || null, i.avatar]);
    else await ctx.db.query('UPDATE profiles SET name=$2, phone=$3 WHERE id=$1', [me, i.name, i.phone || null]);
    return { ok: true };
  }),
  /** Delete my own account (password asked again). The last admin cannot leave. My name, email, phone and picture are erased. */
  'me.delete': proc(null, z.object({ password: z.string().min(1) }), async (ctx, i) => {
    const me = ctx.session.profile.id;
    const r = (await ctx.db.query('SELECT password_hash, roles FROM profiles WHERE id=$1', [me]))[0];
    if (!r || !(await bcrypt.compare(i.password, r.password_hash))) throw bad('Mot de passe incorrect');
    if ((r.roles ?? []).includes('admin')) {
      const n = num((await ctx.db.query("SELECT count(*)::int AS n FROM profiles WHERE active AND 'admin' = ANY(roles) AND id <> $1", [me]))[0]?.n);
      if (!n) throw bad('Vous êtes le seul administrateur : nommez un autre administrateur avant de supprimer votre compte');
    }
    // a livreur cannot leave with parcels or cash in his hands: it would vanish from « Doit verser »
    const open = (
      await ctx.db.query(
        `SELECT count(*) FILTER (WHERE follow_status = ANY($2))::int AS road, count(*) FILTER (WHERE follow_status = 'delivered' AND NOT cashed)::int AS cash
           FROM orders WHERE livreur_id = $1`,
        [me, ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange', 'returning']],
      )
    )[0];
    if (num(open?.road) || num(open?.cash)) throw bad('Vous avez encore des colis ou de l’argent à verser : réglez-les avec le dépôt avant de supprimer votre compte');
    // Anyone who did any work (an order confirmed, a status changed, a payment, a stock move…) keeps their place in
    // that history: the account is emptied (name, email, phone, picture, password) and closed, never deleted, so
    // nobody can erase their own trail. Only an account that never did anything is really removed.
    const cols = await ctx.db.query(
      `SELECT c.table_name AS tb, c.column_name AS col FROM information_schema.columns c
        WHERE c.table_schema = current_schema() AND c.table_name <> 'profiles'
          AND c.column_name IN ('user_id','agent_id','created_by','follow_agent_id','livreur_id','locked_by','assigned_to','updated_by','marketer_id','closed_by','profile_id','manager_id','handled_by')
          AND c.data_type IN ('bigint','integer')`,
    );
    let trail = false;
    for (const c of cols) if (!trail) trail = (await ctx.db.query(`SELECT 1 FROM ${c.tb} WHERE ${c.col} = $1 LIMIT 1`, [me])).length > 0;
    if (trail) {
      const scrap = await hashPassword(globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID());
      await ctx.db.query(
        `UPDATE profiles SET name = 'Compte supprimé', email = 'deleted-' || id || '@pilotix.invalid', phone = NULL, avatar = NULL,
           password_hash = $2, active = false, token_version = token_version + 1 WHERE id = $1`,
        [me, scrap],
      );
      return { ok: true };
    }
    await ctx.db.tx(async (tx) => {
      await tx.query('DELETE FROM referrals WHERE referrer_id=$1', [me]);
      await tx.query('DELETE FROM profiles WHERE id=$1', [me]);
    });
    return { ok: true };
  }),
  /** My referral code, the rules, my invited friends and what I earned (demo: a few sample friends the first time). */
  'me.referrals': proc(null, z.object({}), async (ctx) => {
    const me = ctx.session.profile.id;
    let code = (await ctx.db.query('SELECT referral_code FROM profiles WHERE id=$1', [me]))[0]?.referral_code as string | null;
    if (!code) {
      await ctx.db.query('UPDATE profiles SET referral_code = upper(substr(md5(id::text || email || now()::text), 1, 6)) WHERE id=$1', [me]);
      code = (await ctx.db.query('SELECT referral_code FROM profiles WHERE id=$1', [me]))[0]?.referral_code ?? null;
    }
    const rv = (await ctx.db.query("SELECT value FROM settings WHERE key = 'referral'"))[0]?.value ?? {};
    const rules = { cash: num(rv.cash ?? 2000), months: num(rv.months ?? 1) };
    if (!ctx.server) {
      const seededKey = `referral_demo:${me}`;
      if (!(await ctx.db.query('SELECT 1 FROM settings WHERE key=$1', [seededKey])).length) {
        if (!num((await ctx.db.query('SELECT count(*)::int AS n FROM referrals WHERE referrer_id=$1', [me]))[0]?.n)) {
          const demo: [string, string, string | null, string, boolean, number][] = [
            ['Yasmine B.', 'yasmine.b@example.com', 'Yasmine Shop', 'subscribed', true, 41],
            ['Karim T.', 'karim.t@example.com', 'Tech Oran', 'subscribed', false, 12],
            ['Nesrine A.', 'nesrine.a@example.com', 'Nes Beauty', 'signed_up', false, 6],
            ['Mehdi K.', 'mehdi.k@example.com', null, 'invited', false, 3],
            ['Lina S.', 'lina.s@example.com', null, 'invited', false, 1],
          ];
          for (const [n, em, sh, st, pd, ago] of demo)
            await ctx.db.query(
              `INSERT INTO referrals (referrer_id, friend_name, friend_email, shop_name, status, cash_amount, free_months, paid, created_at, subscribed_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - ($9 || ' days')::interval, CASE WHEN $5 = 'subscribed' THEN now() - (($9::int - 2) || ' days')::interval END)`,
              [me, n, em, sh, st, st === 'subscribed' ? rules.cash : 0, st === 'subscribed' ? rules.months : 0, pd, String(ago)],
            );
        }
        await ctx.db.query("INSERT INTO settings (key, value) VALUES ($1, 'true') ON CONFLICT (key) DO NOTHING", [seededKey]);
      }
    }
    const friends = (await ctx.db.query('SELECT * FROM referrals WHERE referrer_id=$1 ORDER BY created_at DESC', [me])).map((x: any) => ({
      id: num(x.id),
      name: x.friend_name as string,
      email: (x.friend_email as string | null) ?? null,
      shop: (x.shop_name as string | null) ?? null,
      status: x.status as 'invited' | 'signed_up' | 'subscribed',
      cash: num(x.cash_amount),
      months: num(x.free_months),
      paid: !!x.paid,
      createdAt: isoOrNull(x.created_at)!,
      subscribedAt: isoOrNull(x.subscribed_at),
    }));
    const sub = friends.filter((f) => f.status === 'subscribed');
    return {
      code,
      rules,
      friends,
      totals: {
        invited: friends.length,
        signedUp: friends.filter((f) => f.status !== 'invited').length,
        subscribed: sub.length,
        cashEarned: sub.reduce((s, f) => s + f.cash, 0),
        cashPaid: sub.filter((f) => f.paid).reduce((s, f) => s + f.cash, 0),
        cashPending: sub.filter((f) => !f.paid).reduce((s, f) => s + f.cash, 0),
        months: sub.reduce((s, f) => s + f.months, 0),
      },
      /** On a server with several stores, Pilotix's own programme answers instead (the store's link, free months). */
      platform: false,
      link: null as string | null,
    };
  }),
  'me.invite': proc(null, z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().email().max(120) }), async (ctx, i) => {
    const me = ctx.session.profile.id;
    const em = i.email.toLowerCase();
    if ((await ctx.db.query('SELECT 1 FROM profiles WHERE email=$1', [em])).length) throw bad('Cette personne utilise déjà Pilotix');
    if ((await ctx.db.query('SELECT 1 FROM referrals WHERE referrer_id=$1 AND lower(friend_email)=$2', [me, em])).length) throw bad('Vous avez déjà invité cette personne');
    await ctx.db.query('INSERT INTO referrals (referrer_id, friend_name, friend_email) VALUES ($1,$2,$3)', [me, i.name, em]);
    return { ok: true };
  }),
  /** Admin: what a friend who subscribes brings (cash and free months). */
  'referral.rules': proc([], z.object({ cash: z.number().int().min(0).max(1_000_000), months: z.number().int().min(0).max(24) }), async (ctx, i) => {
    await ctx.db.query(
      "INSERT INTO settings (key, value, updated_by) VALUES ('referral', $1, $2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now(), updated_by = $2",
      [JSON.stringify({ cash: i.cash, months: i.months }), ctx.session.profile.id],
    );
    return { ok: true };
  }),
  /** Heartbeat every minute: online / in a call / idle. */
  'me.seen': proc(null, z.object({ presence: z.enum(['online', 'call', 'idle']).default('online') }), async (ctx, i) => {
    await ctx.db.query('UPDATE profiles SET last_seen_at = now(), presence = $2 WHERE id = $1', [ctx.session.profile.id, i.presence]);
    ctx.emit({ type: 'presence', id: ctx.session.profile.id, data: i.presence });
    return { ok: true };
  }),

  /** Everyone sees the team list (names, roles, presence) — needed for agent / livreur pickers. Emails (the logins) and
   *  phone numbers only for the administrator. */
  'users.list': proc(null, z.object({ role: z.enum(ROLES).optional(), activeOnly: z.boolean().default(false) }), async (ctx, i) => {
    const rows = await ctx.db.query(
      `SELECT *, CASE WHEN last_seen_at > now() - interval '3 minutes' THEN presence ELSE 'offline' END AS live
       FROM profiles WHERE ($1::text IS NULL OR $1 = ANY(roles)) AND (NOT $2 OR active) ORDER BY name`,
      [i.role ?? null, i.activeOnly],
    );
    const admin = ctx.session.isAdmin || !!ctx.session.canManageUsers;
    return rows.map((r: any) => ({ ...toProfile(r), ...(admin ? {} : { email: '', phone: null }), presence: r.live as 'online' | 'call' | 'idle' | 'offline' }));
  }),
  'users.create': proc(null, NewUser, async (ctx, b) => {
    needUserManager(ctx);
    needGrantable(ctx, b);
    await needSeat(ctx);
    if (b.roles.includes('livreur')) await needDriverSeat(ctx);
    try {
      const r = (
        await ctx.db.query(
          'INSERT INTO profiles (name, email, phone, password_hash, roles, language, livreur_company_id, can_manage_users) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [b.name, b.email.toLowerCase(), b.phone ?? null, await hashPassword(b.password), b.roles, b.language, b.livreurCompanyId ?? null, !!b.canManageUsers && !b.roles.includes('admin')],
        )
      )[0];
      return toProfile(r);
    } catch (e: any) {
      if (String(e?.code) === '23505' || /unique|duplicate/i.test(e?.message)) throw bad('Cet email est déjà utilisé');
      throw e;
    }
  }),
  'users.update': proc(null, NewUser.partial().extend({ id: z.number().int().positive(), active: z.boolean().optional() }), async (ctx, b) => {
    await needCanEdit(ctx, b.id);
    needGrantable(ctx, b);
    if (b.id === ctx.session.profile.id && (b.active === false || (b.roles && !b.roles.includes('admin')))) throw forbidden('Vous ne pouvez pas retirer votre propre accès administrateur');
    // an account closed earlier and opened again takes a place of the plan; so does a new livreur
    const before = (await ctx.db.query('SELECT active, roles, archived_at FROM profiles WHERE id = $1', [b.id]))[0];
    if (before?.archived_at && b.active === true) throw bad('Ce compte est archivé : sortez-le d’abord des archives (Management › Archives)');
    if (b.active === true && !before?.active) await needSeat(ctx);
    const willBeActive = b.active ?? !!before?.active;
    const wasDriver = !!before?.active && (before?.roles as string[] | undefined)?.includes('livreur');
    if (willBeActive && (b.roles ?? (before?.roles as string[] | undefined) ?? []).includes('livreur') && !wasDriver) await needDriverSeat(ctx, b.id);
    let r: any;
    try {
      r = (
        await ctx.db.query(
          `UPDATE profiles SET name=COALESCE($2,name), email=COALESCE($3,email), phone=COALESCE($4,phone), password_hash=COALESCE($5,password_hash),
             roles=COALESCE($6,roles), language=COALESCE($7,language), active=COALESCE($8,active), livreur_company_id=COALESCE($9,livreur_company_id),
             can_manage_users = CASE WHEN 'admin' = ANY(COALESCE($6,roles)) THEN false ELSE COALESCE($10,can_manage_users) END,
             token_version = token_version + CASE WHEN $5::text IS NOT NULL OR $8 = false THEN 1 ELSE 0 END WHERE id=$1 RETURNING *`,
          [b.id, b.name ?? null, b.email?.toLowerCase() ?? null, b.phone ?? null, b.password ? await hashPassword(b.password) : null, b.roles ?? null, b.language ?? null, b.active ?? null, b.livreurCompanyId ?? null, b.canManageUsers ?? null],
        )
      )[0];
    } catch (e: any) {
      if (String(e?.code) === '23505' || /unique|duplicate|déjà utilisé/i.test(e?.message)) throw bad('Cet email est déjà utilisé');
      throw e;
    }
    if (!r) throw notFound();
    return toProfile(r);
  }),
};
