// Rendez-vous (a module: off until an administrator turns it on in Management › Modules, shopmodules.ts). A boutique that
// sells a service — a training centre first (owner's choice, 24 Nov 2026: « Seats in sessions ») — adds its sessions (a
// day, its hours, a city and a place, its seats, its price); the website (Landing pages › Site web, site.ts) shows the
// ones still open and people book a seat there. Each booking comes into Pilotix › Rendez-vous: the team calls the person
// and confirms, like an order (design « A », 24 Nov 2026), and the person keeps a ticket with a code to show at the door
// (design « C »). Payment is on the training day, never online.
// Protection of the bookings from the website: an Algerian mobile number, one booking per number and session (a second
// one opens the first ticket again), never more seats than are free, and a number of the black list is kept apart
// (« blocked »: it takes no seat; the person sees a ticket still « to confirm »). The server adds its own limits (a
// hidden field robots fill, a few bookings per address, nothing posted from another site: apps/server/src/api.ts).
// Its tables: migrations/134_rdv.ts.
import { algiersParts, algiersTime, RDV_LISTS, RDV_MAX_SEATS, RDV_OFF, RDV_OK, RDV_STATUSES, RDV_TAKES, RDV_TODO, rdvCode, type RdvStatus, type SiteSession, type SiteTicket } from '@pilotix/shared';
import { z } from 'zod';
import { type Db, iso, isoOrNull, num } from '../db';
import { bad, type Ctx, hasRole, notFound, proc } from '../rpc';
import { mobileOf } from './landing';
import { modulesOf, requireModule, setModule } from './shopmodules';

/** Every action of the page starts here: refused while the boutique has not turned Rendez-vous on. */
const on = (ctx: Ctx) => requireModule(ctx.db, 'rdv');

// ---------------------------------------------------------------- what the page and the website read
export interface RdvSession {
  id: number;
  title: string;
  city: string;
  place: string;
  startsAt: string;
  endsAt: string | null;
  seats: number;
  price: number;
  note: string;
  /** the website takes bookings */
  open: boolean;
  /** seats held: confirmed (and at the door), still to call; free = seats - both */
  confirmed: number;
  todo: number;
  free: number;
  /** it has started */
  past: boolean;
}

export interface RdvBooking {
  id: number;
  sessionId: number;
  name: string;
  phone: string;
  seats: number;
  status: RdvStatus;
  tries: number;
  callAt: string | null;
  note: string;
  code: string;
  source: 'site' | 'hand';
  lang: string | null;
  createdAt: string;
  updatedAt: string;
  /** the last person who handled it */
  agent: string | null;
  session: { title: string; city: string; place: string; startsAt: string; endsAt: string | null };
}

const SESSION_COLS = `s.id, s.title, s.city, s.place, s.starts_at, s.ends_at, s.seats, s.price, s.note, s.open,
  coalesce((SELECT sum(b.seats) FROM rdv_bookings b WHERE b.session_id = s.id AND b.status = ANY($1)), 0)::int AS confirmed,
  coalesce((SELECT sum(b.seats) FROM rdv_bookings b WHERE b.session_id = s.id AND b.status = ANY($2)), 0)::int AS todo`;

function sessionOf(r: any, now: number): RdvSession {
  const seats = num(r.seats);
  const confirmed = num(r.confirmed);
  const todo = num(r.todo);
  return {
    id: num(r.id),
    title: String(r.title ?? ''),
    city: String(r.city ?? ''),
    place: String(r.place ?? ''),
    startsAt: iso(r.starts_at),
    endsAt: isoOrNull(r.ends_at),
    seats,
    price: num(r.price),
    note: String(r.note ?? ''),
    open: !!r.open,
    confirmed,
    todo,
    free: Math.max(0, seats - confirmed - todo),
    past: new Date(r.starts_at).getTime() <= now,
  };
}

/**
 * The sessions not put away, in date order. `from`: only those that start after this time (the website: from now; the
 * page: from yesterday, so a day's session stays in view while it runs).
 */
export async function rdvSessions(db: Db, now: number, opts: { from?: number; openOnly?: boolean; ids?: number[] } = {}): Promise<RdvSession[]> {
  const where = ['s.archived_at IS NULL'];
  const params: unknown[] = [RDV_OK, RDV_TODO];
  if (opts.from !== undefined) where.push(`s.starts_at > $${params.push(new Date(opts.from).toISOString())}`);
  if (opts.openOnly) where.push('s.open');
  if (opts.ids) where.push(`s.id = ANY($${params.push(opts.ids)}::bigint[])`);
  const rows = await db.query(`SELECT ${SESSION_COLS} FROM rdv_sessions s WHERE ${where.join(' AND ')} ORDER BY s.starts_at, s.id`, params);
  return rows.map((r) => sessionOf(r, now));
}

const BOOKING_SQL = `SELECT b.*, s.title AS s_title, s.city AS s_city, s.place AS s_place, s.starts_at AS s_starts, s.ends_at AS s_ends, p.name AS agent_name
  FROM rdv_bookings b JOIN rdv_sessions s ON s.id = b.session_id LEFT JOIN profiles p ON p.id = b.agent_id`;

function bookingOf(r: any): RdvBooking {
  return {
    id: num(r.id),
    sessionId: num(r.session_id),
    name: String(r.name ?? ''),
    phone: String(r.phone ?? ''),
    seats: num(r.seats),
    status: (RDV_STATUSES as readonly string[]).includes(r.status) ? (r.status as RdvStatus) : 'new',
    tries: num(r.tries),
    callAt: isoOrNull(r.call_at),
    note: String(r.note ?? ''),
    code: String(r.code ?? rdvCode(num(r.id))),
    source: r.source === 'hand' ? 'hand' : 'site',
    lang: r.lang ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    agent: r.agent_name ?? null,
    session: { title: String(r.s_title ?? ''), city: String(r.s_city ?? ''), place: String(r.s_place ?? ''), startsAt: iso(r.s_starts), endsAt: isoOrNull(r.s_ends) },
  };
}

/** A day after it started, a session's bookings still to call are no longer « to confirm ». */
const STALE_MS = 24 * 3_600_000;

/** How many bookings wait for a call (the menu's badge, the « À confirmer » tab). */
export async function rdvTodoCount(db: Db, now: number): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM rdv_bookings b JOIN rdv_sessions s ON s.id = b.session_id
     WHERE b.status = ANY($1) AND s.archived_at IS NULL AND s.starts_at > $2`,
    [RDV_TODO, new Date(now - STALE_MS).toISOString()],
  );
  return num(r[0]?.n);
}

/** The menu's count: a person who sees the page (it is the confirmation team's), while the module is on. */
export async function rdvMenuCount(ctx: Ctx): Promise<number | undefined> {
  if (!hasRole(ctx.session, 'confirmation')) return undefined;
  if (!(await modulesOf(ctx.db)).rdv) return undefined;
  return rdvTodoCount(ctx.db, ctx.now());
}

async function listCounts(db: Db, now: number): Promise<Record<keyof typeof RDV_LISTS, number>> {
  const r = (
    await db.query(
      `SELECT count(*) FILTER (WHERE b.status = ANY($1) AND s.starts_at > $4)::int AS attente,
              count(*) FILTER (WHERE b.status = ANY($2))::int AS confirmes,
              count(*) FILTER (WHERE b.status = ANY($3))::int AS annules
       FROM rdv_bookings b JOIN rdv_sessions s ON s.id = b.session_id WHERE s.archived_at IS NULL`,
      [RDV_TODO, RDV_OK, RDV_OFF, new Date(now - STALE_MS).toISOString()],
    )
  )[0];
  return { attente: num(r?.attente), confirmes: num(r?.confirmes), annules: num(r?.annules) };
}

// ---------------------------------------------------------------- seats
/**
 * The seats a booking may take in a session (locked while the booking is written, so two people never take the last
 * seat together): what is free, not counting `except` (the booking being changed).
 */
async function freeSeats(tx: Db, sessionId: number, except: number | null): Promise<{ free: number; held: number; row: any }> {
  const row = (await tx.query('SELECT * FROM rdv_sessions WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [sessionId]))[0];
  if (!row) throw notFound('Session introuvable');
  const held = num(
    (await tx.query('SELECT coalesce(sum(seats), 0)::int AS n FROM rdv_bookings WHERE session_id = $1 AND status = ANY($2) AND id <> $3', [sessionId, RDV_TAKES, except ?? 0]))[0]?.n,
  );
  return { free: Math.max(0, num(row.seats) - held), held, row };
}

const FULL = (free: number) => (free > 0 ? `Il reste ${free} place${free > 1 ? 's' : ''} dans cette session` : 'Cette session est complète');

const randomToken = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Writes a booking and gives it its door code (RDV-0421, from its number). */
async function insertBooking(
  tx: Db,
  b: { sessionId: number; name: string; phone: string; seats: number; status: RdvStatus; source: 'site' | 'hand'; lang: string | null; ip: string | null; agentId: number | null; note?: string },
  now: number,
): Promise<{ id: number; token: string; code: string }> {
  const token = randomToken();
  const at = new Date(now).toISOString();
  const bookingId = num(
    (
      await tx.query(
        `INSERT INTO rdv_bookings (session_id, name, phone, seats, status, token, source, lang, ip, agent_id, note, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING id`,
        [b.sessionId, b.name, b.phone, b.seats, b.status, token, b.source, b.lang, b.ip, b.agentId, b.note ?? '', at],
      )
    )[0].id,
  );
  const code = rdvCode(bookingId);
  await tx.query('UPDATE rdv_bookings SET code = $1 WHERE id = $2', [code, bookingId]);
  return { id: bookingId, token, code };
}

const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, 80);

// ---------------------------------------------------------------- inputs
const id = z.number().int().positive();
const SessionInput = z.object({
  id: id.optional(),
  title: z.string().trim().max(120),
  city: z.string().trim().max(60),
  place: z.string().trim().max(200),
  /** its day and hours in Algiers: '2026-12-05', '09:00', '16:00' (no end: '') */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^(\d{2}:\d{2})?$/),
  seats: z.number().int().min(1).max(5000),
  price: z.number().min(0).max(100_000_000),
  note: z.string().trim().max(500),
  open: z.boolean(),
});

const ACTIONS = ['confirm', 'no_answer', 'callback', 'cancel', 'present', 'absent', 'reopen', 'note', 'move'] as const;

/** Which states each action starts from (a booking already there stays: confirming twice is no error). */
const FROM: Record<(typeof ACTIONS)[number], readonly RdvStatus[] | null> = {
  confirm: [...RDV_TODO, 'confirmed', 'cancelled', 'blocked', 'absent'],
  no_answer: RDV_TODO,
  callback: RDV_TODO,
  cancel: [...RDV_TODO, ...RDV_OK, 'cancelled'],
  present: RDV_TAKES,
  absent: RDV_TAKES,
  reopen: RDV_OFF,
  note: null,
  move: null,
};

// ---------------------------------------------------------------- the actions
export const rdvProcs = {
  /** The page's top: the sessions to come (and today's), the three lists' counts. */
  'rdv.overview': proc(['confirmation'], z.object({}), async (ctx) => {
    await on(ctx);
    const now = ctx.now();
    return { sessions: await rdvSessions(ctx.db, now, { from: now - STALE_MS }), counts: await listCounts(ctx.db, now) };
  }),

  /** Every session not put away, past ones too (the « Sessions » tab), newest first. */
  'rdv.sessions': proc(['confirmation'], z.object({}), async (ctx) => {
    await on(ctx);
    return { sessions: (await rdvSessions(ctx.db, ctx.now())).reverse() };
  }),

  /** One of the page's lists: « À confirmer », « Confirmés », « Annulés »; one session, or a name, number or code. */
  'rdv.list': proc(
    ['confirmation'],
    z.object({ list: z.enum(['attente', 'confirmes', 'annules']), sessionId: id.optional(), q: z.string().max(80).optional() }),
    async (ctx, i) => {
      await on(ctx);
      const now = ctx.now();
      const params: unknown[] = [RDV_LISTS[i.list]];
      const where = ['b.status = ANY($1)', 's.archived_at IS NULL'];
      if (i.list === 'attente') where.push(`s.starts_at > $${params.push(new Date(now - STALE_MS).toISOString())}`);
      if (i.sessionId) where.push(`b.session_id = $${params.push(i.sessionId)}`);
      const q = (i.q ?? '').trim();
      if (q) {
        const digits = q.replace(/\D/g, '');
        const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        const ors = [`b.name ILIKE $${params.push(like)}`, `b.code ILIKE $${params.push(like)}`];
        if (digits.length >= 3) ors.push(`b.phone LIKE $${params.push(`%${digits.replace(/^213/, '')}%`)}`);
        where.push(`(${ors.join(' OR ')})`);
      }
      const order =
        i.list === 'attente'
          ? `CASE WHEN b.status = 'callback' AND b.call_at <= $${params.push(new Date(now).toISOString())} THEN 0 WHEN b.status = 'new' THEN 1 ELSE 2 END, b.created_at DESC`
          : i.list === 'confirmes'
            ? 's.starts_at, b.name'
            : 'b.updated_at DESC';
      const rows = await ctx.db.query(`${BOOKING_SQL} WHERE ${where.join(' AND ')} ORDER BY ${order}, b.id DESC LIMIT 300`, params);
      return { rows: rows.map(bookingOf) };
    },
  ),

  /** A call's result, or a change: confirm, no answer, call back at…, cancel, there or not at the door, back to call, a note, another session. */
  'rdv.set': proc(
    ['confirmation'],
    z.object({
      id,
      action: z.enum(ACTIONS),
      callAt: z.string().datetime().optional(),
      note: z.string().max(1000).optional(),
      sessionId: id.optional(),
      seats: z.number().int().min(1).max(RDV_MAX_SEATS).optional(),
    }),
    async (ctx, i) => {
      await on(ctx);
      const me = ctx.session.profile.id;
      const now = ctx.now();
      const at = new Date(now).toISOString();
      await ctx.db.tx(async (tx) => {
        const b = (await tx.query('SELECT * FROM rdv_bookings WHERE id = $1 FOR UPDATE', [i.id]))[0];
        if (!b) throw notFound('Réservation introuvable');
        const status = b.status as RdvStatus;
        const from = FROM[i.action];
        if (from && !from.includes(status)) throw bad('Cette réservation a déjà changé : la liste se met à jour');
        const set = async (sql: string, params: unknown[]) => tx.query(`UPDATE rdv_bookings SET ${sql}, agent_id = $2, updated_at = $3 WHERE id = $1`, [i.id, me, at, ...params]);
        // a booking that held no seat (cancelled, blocked) takes them again: only if they are free
        const needSeats = async (sessionId: number, seats: number) => {
          const { free } = await freeSeats(tx, sessionId, i.id);
          if (seats > free) throw bad(FULL(free));
        };
        switch (i.action) {
          case 'confirm':
            if (!RDV_TAKES.includes(status)) await needSeats(num(b.session_id), num(b.seats));
            await set(`status = 'confirmed', call_at = NULL`, []);
            break;
          case 'no_answer':
            await set(`status = 'no_answer', tries = tries + 1, call_at = NULL`, []);
            break;
          case 'callback': {
            if (!i.callAt) throw bad('Choisissez quand rappeler');
            await set(`status = 'callback', call_at = $4`, [i.callAt]);
            break;
          }
          case 'cancel':
            await set(`status = 'cancelled', call_at = NULL`, []);
            break;
          case 'present':
          case 'absent':
            await set(`status = $4`, [i.action]);
            break;
          case 'reopen':
            await needSeats(num(b.session_id), num(b.seats));
            await set(`status = 'new', tries = 0, call_at = NULL`, []);
            break;
          case 'note':
            await set(`note = $4`, [(i.note ?? '').trim()]);
            break;
          case 'move': {
            const sessionId = i.sessionId ?? num(b.session_id);
            const seats = i.seats ?? num(b.seats);
            if (RDV_TAKES.includes(status)) await needSeats(sessionId, seats);
            else await freeSeats(tx, sessionId, i.id);
            await set(`session_id = $4, seats = $5`, [sessionId, seats]);
            break;
          }
        }
      });
      ctx.emit({ type: 'rdv', id: i.id });
      const row = (await ctx.db.query(`${BOOKING_SQL} WHERE b.id = $1`, [i.id]))[0];
      return bookingOf(row);
    },
  ),

  /** A booking taken by the team (a call, a visit): confirmed when they say so, else to call like the website's. */
  'rdv.add': proc(
    ['confirmation'],
    z.object({ sessionId: id, name: z.string().max(120), phone: z.string().max(30), seats: z.number().int().min(1).max(RDV_MAX_SEATS), confirmed: z.boolean(), note: z.string().max(1000).optional() }),
    async (ctx, i) => {
      await on(ctx);
      const name = cleanName(i.name);
      if (name.length < 2) throw bad('Écrivez le nom de la personne');
      const phone = mobileOf(i.phone);
      if (!phone) throw bad('Numéro de mobile algérien attendu (05, 06 ou 07)');
      const now = ctx.now();
      const made = await ctx.db.tx(async (tx) => {
        const { free } = await freeSeats(tx, i.sessionId, null);
        if (i.seats > free) throw bad(FULL(free));
        const twice = (await tx.query('SELECT id FROM rdv_bookings WHERE session_id = $1 AND phone = $2 AND status = ANY($3) LIMIT 1', [i.sessionId, phone, RDV_TAKES]))[0];
        if (twice) throw bad('Ce numéro a déjà une place dans cette session');
        return insertBooking(tx, { sessionId: i.sessionId, name, phone, seats: i.seats, status: i.confirmed ? 'confirmed' : 'new', source: 'hand', lang: null, ip: null, agentId: ctx.session.profile.id, note: (i.note ?? '').trim() }, now);
      });
      ctx.emit({ type: 'rdv', id: made.id });
      return bookingOf((await ctx.db.query(`${BOOKING_SQL} WHERE b.id = $1`, [made.id]))[0]);
    },
  ),

  /** A new session, or a change (its day, its seats, its price…). Fewer seats than already booked is refused. */
  'rdv.sessionSave': proc(['vendeur'], SessionInput, async (ctx, i) => {
    await on(ctx);
    const starts = algiersTime(i.date, i.start);
    if (!starts) throw bad('Date ou heure invalide');
    const ends = i.end ? algiersTime(i.date, i.end) : null;
    if (i.end && (!ends || ends <= starts)) throw bad('L’heure de fin vient après le début');
    const now = ctx.now();
    const at = new Date(now).toISOString();
    const sid = await ctx.db.tx(async (tx) => {
      if (i.id) {
        const { held } = await freeSeats(tx, i.id, null);
        if (i.seats < held) throw bad(`${held} places sont déjà réservées : gardez au moins ${held} places`);
        await tx.query(
          `UPDATE rdv_sessions SET title = $2, city = $3, place = $4, starts_at = $5, ends_at = $6, seats = $7, price = $8, note = $9, open = $10, updated_at = $11 WHERE id = $1`,
          [i.id, i.title, i.city, i.place, starts, ends, i.seats, i.price, i.note, i.open, at],
        );
        return i.id;
      }
      return num(
        (
          await tx.query(
            `INSERT INTO rdv_sessions (title, city, place, starts_at, ends_at, seats, price, note, open, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
            [i.title, i.city, i.place, starts, ends, i.seats, i.price, i.note, i.open, at],
          )
        )[0].id,
      );
    });
    ctx.emit({ type: 'rdv' });
    return (await rdvSessions(ctx.db, now, { ids: [sid] }))[0];
  }),

  /** Takes a session away: gone when nobody booked it, else put away with its bookings (the history stays). */
  'rdv.sessionDelete': proc(['vendeur'], z.object({ id }), async (ctx, i) => {
    await on(ctx);
    const used = (await ctx.db.query('SELECT 1 FROM rdv_bookings WHERE session_id = $1 LIMIT 1', [i.id]))[0];
    if (used) await ctx.db.query('UPDATE rdv_sessions SET archived_at = $2, open = false WHERE id = $1', [i.id, new Date(ctx.now()).toISOString()]);
    else await ctx.db.query('DELETE FROM rdv_sessions WHERE id = $1', [i.id]);
    ctx.emit({ type: 'rdv' });
    return { ok: true as const, archived: !!used };
  }),

  /**
   * A booking from the website (the server calls it: apps/server/src/api.ts, after its own limits). Answers the ticket's
   * key, or why not: the person goes back to the form with a message. A number of the black list gets a ticket too,
   * kept apart in Pilotix (it never says the number is listed).
   */
  'site.book': proc(
    [],
    z.object({ sessionId: z.number().int(), name: z.string().max(200), phone: z.string().max(40), seats: z.number().int(), lang: z.string().max(5).optional(), ip: z.string().max(80).optional() }),
    async (ctx, i): Promise<{ ok: true; token: string } | { ok: false; reason: 'closed' | 'full' | 'phone' | 'name' | 'seats' }> => {
      if (!(await modulesOf(ctx.db)).rdv) return { ok: false, reason: 'closed' };
      const name = cleanName(i.name);
      if (name.length < 2) return { ok: false, reason: 'name' };
      const phone = mobileOf(i.phone);
      if (!phone) return { ok: false, reason: 'phone' };
      if (i.seats < 1 || i.seats > RDV_MAX_SEATS) return { ok: false, reason: 'seats' };
      const now = ctx.now();
      const lang = i.lang && ['ar', 'fr', 'en'].includes(i.lang) ? i.lang : null;
      return ctx.db.tx(async (tx) => {
        const s = (await tx.query('SELECT * FROM rdv_sessions WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [i.sessionId]))[0];
        if (!s || !s.open || new Date(s.starts_at).getTime() <= now) return { ok: false as const, reason: 'closed' as const };
        // the same number in the same session: its ticket again (a person who pressed twice, or came back)
        const had = (await tx.query('SELECT token FROM rdv_bookings WHERE session_id = $1 AND phone = $2 AND status <> $3 ORDER BY id DESC LIMIT 1', [i.sessionId, phone, 'cancelled']))[0];
        if (had) return { ok: true as const, token: String(had.token) };
        const { free } = await freeSeats(tx, i.sessionId, null);
        if (i.seats > free) return { ok: false as const, reason: 'full' as const };
        const listed = !!(await tx.query('SELECT 1 FROM customers WHERE phone = $1 AND blacklisted LIMIT 1', [phone]))[0];
        const made = await insertBooking(tx, { sessionId: i.sessionId, name, phone, seats: i.seats, status: listed ? 'blocked' : 'new', source: 'site', lang, ip: i.ip ? i.ip.slice(0, 80) : null, agentId: null }, now);
        return { ok: true as const, token: made.token };
      }).then((r) => {
        if (r.ok) ctx.emit({ type: 'rdv' });
        return r;
      });
    },
  ),

  /** A ticket for the website (/?billet=…): the booking, its session and where it stands. Null when it does not exist. */
  'site.ticket': proc([], z.object({ token: z.string().max(64) }), async (ctx, i) => ({ ticket: await rdvTicket(ctx.db, i.token) })),
};

/** A booking's ticket (the website's /?billet=…), or null: no such booking, or Rendez-vous is off. */
export async function rdvTicket(db: Db, token: string): Promise<SiteTicket | null> {
  if (!/^[a-f0-9]{32}$/.test(token) || !(await modulesOf(db)).rdv) return null;
  const r = (await db.query(`${BOOKING_SQL} WHERE b.token = $1`, [token]))[0];
  if (!r) return null;
  const b = bookingOf(r);
  // a listed number never learns it: its ticket stays « to confirm »
  const shown: SiteTicket['status'] = RDV_OK.includes(b.status) ? (b.status === 'confirmed' ? 'ok' : 'done') : b.status === 'cancelled' ? 'cancelled' : 'todo';
  const s = (await db.query('SELECT price, note FROM rdv_sessions WHERE id = $1', [b.sessionId]))[0];
  return { code: b.code, name: b.name, seats: b.seats, status: shown, price: num(s?.price), note: String(s?.note ?? ''), session: b.session };
}

/** The sessions the website shows: open, still to come, soonest first (seats left counted now). */
export async function siteSessions(db: Db, now: number): Promise<SiteSession[]> {
  if (!(await modulesOf(db)).rdv) return [];
  return (await rdvSessions(db, now, { from: now, openOnly: true })).map(({ id, title, city, place, startsAt, endsAt, seats, free, price, note }) => ({ id, title, city, place, startsAt, endsAt, seats, free, price, note }));
}

// ---------------------------------------------------------------- the preview opened in Claude
/**
 * The preview's Rendez-vous: turned on, three sessions of a training (the next two Saturdays, a Friday after), and the
 * bookings of the designs (24 Nov 2026): five to call, the rest confirmed, two cancelled.
 */
export async function seedRdv(db: Db, now = Date.now()) {
  await setModule(db, 'rdv', true);
  if ((await db.query('SELECT 1 FROM rdv_sessions LIMIT 1'))[0]) return;
  const day = (n: number) => algiersParts(new Date(now + n * 86_400_000).toISOString()).date;
  // the next Saturday (at least two days away), then the one after, then the Friday of the week after
  let toSat = (6 - new Date(now + 3_600_000).getUTCDay() + 7) % 7;
  if (toSat < 2) toSat += 7;
  const title = 'E-commerce de zéro à la première vente';
  const sessions: [city: string, place: string, d: number, start: string, end: string, seats: number][] = [
    ['Alger', 'Hydra, 12 rue Ahmed Ouaked, salle 2', toSat, '09:00', '16:00', 20],
    ['Oran', 'Hôtel Le Méridien, salle Atlas', toSat + 7, '09:00', '16:00', 25],
    ['Constantine', 'Centre Ennour, Sidi Mabrouk', toSat + 13, '14:00', '18:00', 15],
  ];
  const ids: number[] = [];
  for (const [city, place, d, start, end, seats] of sessions) {
    const date = day(d);
    ids.push(
      num(
        (
          await db.query(
            `INSERT INTO rdv_sessions (title, city, place, starts_at, ends_at, seats, price, note, open, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 6000, $7, true, $8, $8) RETURNING id`,
            [title, city, place, algiersTime(date, start), algiersTime(date, end), seats, 'Apportez votre ordinateur. Paiement sur place, le jour de la formation.', new Date(now - 12 * 86_400_000).toISOString()],
          )
        )[0].id,
      ),
    );
  }
  const owner = num((await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) ORDER BY id LIMIT 1`))[0]?.id) || null;
  const agent = num((await db.query(`SELECT id FROM profiles WHERE 'confirmation' = ANY(roles) ORDER BY id LIMIT 1`))[0]?.id) || owner;
  const phone = (k: number) => `0${[5, 6, 7][k % 3]}${String(10_000_000 + ((k * 7_919_317) % 89_999_999)).padStart(8, '0')}`;
  type B = [session: number, name: string, seats: number, status: RdvStatus, minutesAgo: number, extra?: { tries?: number; callIn?: number }];
  const people: B[] = [
    [0, 'Amine Belkacem', 1, 'new', 12],
    [1, 'Sarah Hadjadj', 2, 'new', 40],
    [0, 'Yacine Merabet', 1, 'no_answer', 15 * 60, { tries: 1 }],
    [1, 'Nour El Houda Kaci', 1, 'new', 19 * 60],
    [0, 'Walid Cherif', 1, 'callback', 26 * 60, { callIn: 5 * 60 }],
    [0, 'Imane Boudiaf', 2, 'confirmed', 3 * 1440],
    [0, 'Karim Ait Ali', 1, 'confirmed', 3 * 1440 + 90],
    [0, 'Lina Mansouri', 1, 'confirmed', 4 * 1440],
    [0, 'Sofiane Benali', 2, 'confirmed', 4 * 1440 + 200],
    [0, 'Meriem Zerrouki', 1, 'confirmed', 5 * 1440],
    [0, 'Hamza Rahmani', 1, 'confirmed', 5 * 1440 + 60],
    [0, 'Asma Belhadj', 2, 'confirmed', 6 * 1440],
    [0, 'Riad Khelifi', 1, 'confirmed', 6 * 1440 + 30],
    [0, 'Chaima Saidi', 1, 'confirmed', 7 * 1440],
    [1, 'Omar Bensalem', 2, 'confirmed', 2 * 1440],
    [1, 'Yasmine Tahri', 1, 'confirmed', 2 * 1440 + 50],
    [1, 'Bilal Djebbar', 1, 'confirmed', 3 * 1440 + 10],
    [1, 'Feriel Amrani', 2, 'confirmed', 4 * 1440 + 15],
    [1, 'Nassim Lounis', 1, 'confirmed', 5 * 1440 + 5],
    [1, 'Rym Ferhat', 1, 'confirmed', 6 * 1440 + 25],
    [1, 'Anis Bouzid', 2, 'confirmed', 7 * 1440 + 40],
    [2, 'Ikram Ghazi', 3, 'confirmed', 8 * 1440],
    [2, 'Mehdi Larbi', 2, 'confirmed', 8 * 1440 + 100],
    [2, 'Souad Hamidi', 2, 'confirmed', 9 * 1440],
    [2, 'Adel Mokrani', 3, 'confirmed', 9 * 1440 + 30],
    [2, 'Sabrina Ouali', 2, 'confirmed', 10 * 1440],
    [2, 'Fares Benyahia', 3, 'confirmed', 10 * 1440 + 80],
    [0, 'Khaled Brahimi', 1, 'cancelled', 2 * 1440],
    [1, 'Nadia Selmi', 1, 'cancelled', 1440 + 300],
  ];
  for (const [k, [s, name, seats, status, ago, extra]] of people.entries()) {
    const at = now - ago * 60_000;
    const made = await insertBooking(db, { sessionId: ids[s], name, phone: phone(k + 3), seats, status, source: 'site', lang: k % 4 === 0 ? 'fr' : 'ar', ip: null, agentId: status === 'new' ? null : agent }, at);
    await db.query('UPDATE rdv_bookings SET tries = $2, call_at = $3, updated_at = $4 WHERE id = $1', [
      made.id,
      extra?.tries ?? 0,
      extra?.callIn ? new Date(now + extra.callIn * 60_000).toISOString() : null,
      new Date(status === 'new' ? at : Math.min(now, at + 3 * 3_600_000)).toISOString(),
    ]);
  }
}
