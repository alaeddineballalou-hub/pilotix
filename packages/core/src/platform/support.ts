// « Contacter Pilotix »: a store writes to Pilotix, Pilotix answers. The store chooses what it tells; Pilotix sees
// nothing else of it. Kept in the platform's tables (not in the store's schema).
import { z } from 'zod';
import { isoOrNull, num } from '../db';
import { bad, notFound } from '../rpc';
import type { Tenancy } from './tenancy';

export interface SupportThread {
  id: number;
  shopId: number;
  shopName: string | null;
  subject: string;
  status: 'open' | 'closed';
  authorName: string;
  authorEmail: string;
  unreadStaff: boolean;
  unreadShop: boolean;
  createdAt: string;
  updatedAt: string;
  messages: number;
  /** the last message, cut short */
  last: { fromStaff: boolean; text: string } | null;
}
export interface SupportMessage {
  id: number;
  fromStaff: boolean;
  author: string;
  body: string;
  createdAt: string;
}

export const SupportNew = z.object({ subject: z.string().trim().min(2, 'Sujet : au moins 2 lettres').max(120), body: z.string().trim().min(2, 'Message trop court').max(5000) });
export const SupportReply = z.object({ body: z.string().trim().min(1, 'Message vide').max(5000) });

const THREAD_SELECT = `SELECT th.*, s.name AS shop_name,
    (SELECT count(*)::int FROM platform.support_messages m WHERE m.thread_id = th.id) AS n,
    (SELECT row_to_json(x) FROM (SELECT from_staff, left(body, 140) AS body FROM platform.support_messages m WHERE m.thread_id = th.id ORDER BY m.id DESC LIMIT 1) x) AS last_row
  FROM platform.support_threads th JOIN platform.shops s ON s.id = th.shop_id`;

const toThread = (r: any): SupportThread => {
  const last = typeof r.last_row === 'string' ? JSON.parse(r.last_row) : r.last_row;
  return {
    id: num(r.id),
    shopId: num(r.shop_id),
    shopName: r.shop_name ?? null,
    subject: r.subject,
    status: r.status,
    authorName: r.author_name,
    authorEmail: r.author_email,
    unreadStaff: !!r.unread_staff,
    unreadShop: !!r.unread_shop,
    createdAt: isoOrNull(r.created_at)!,
    updatedAt: isoOrNull(r.updated_at)!,
    messages: num(r.n),
    last: last ? { fromStaff: !!last.from_staff, text: String(last.body ?? '') } : null,
  };
};
const toMessage = (r: any): SupportMessage => ({ id: num(r.id), fromStaff: !!r.from_staff, author: r.author, body: r.body, createdAt: isoOrNull(r.created_at)! });

async function messagesOf(t: Tenancy, threadId: number): Promise<SupportMessage[]> {
  return (await t.platform.query('SELECT * FROM platform.support_messages WHERE thread_id = $1 ORDER BY id', [threadId])).map(toMessage);
}

// ---------------------------------------------------------------- the store's side
export async function shopThreads(t: Tenancy, shopId: number): Promise<SupportThread[]> {
  return (await t.platform.query(`${THREAD_SELECT} WHERE th.shop_id = $1 ORDER BY th.updated_at DESC LIMIT 100`, [shopId])).map(toThread);
}

/** One conversation of the store (its answers are now read). */
export async function shopThread(t: Tenancy, shopId: number, id: number): Promise<{ thread: SupportThread; messages: SupportMessage[] }> {
  const r = (await t.platform.query(`${THREAD_SELECT} WHERE th.id = $1 AND th.shop_id = $2`, [id, shopId]))[0];
  if (!r) throw notFound('Conversation introuvable');
  await t.platform.query('UPDATE platform.support_threads SET unread_shop = false WHERE id = $1', [id]);
  return { thread: { ...toThread(r), unreadShop: false }, messages: await messagesOf(t, id) };
}

/** A new message to Pilotix (20 a day per store at most). */
export async function shopWrite(t: Tenancy, shopId: number, author: { name: string; email: string }, raw: unknown): Promise<{ id: number }> {
  const p = SupportNew.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0]?.message ?? 'Message incomplet');
  const today = num((await t.platform.query(`SELECT count(*)::int AS n FROM platform.support_threads WHERE shop_id = $1 AND created_at > now() - interval '1 day'`, [shopId]))[0]?.n);
  if (today >= 20) throw bad('Trop de messages aujourd’hui : Pilotix vous répond d’abord');
  return t.platform.tx(async (db) => {
    const id = num(
      (await db.query('INSERT INTO platform.support_threads (shop_id, author_email, author_name, subject) VALUES ($1, lower($2), $3, $4) RETURNING id', [shopId, author.email, author.name, p.data.subject]))[0]
        .id,
    );
    await db.query('INSERT INTO platform.support_messages (thread_id, from_staff, author, body) VALUES ($1, false, $2, $3)', [id, author.name, p.data.body]);
    return { id };
  });
}

/** The store answers in one of its conversations (it opens again). */
export async function shopReply(t: Tenancy, shopId: number, id: number, author: { name: string }, raw: unknown): Promise<{ ok: true }> {
  const p = SupportReply.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0]?.message ?? 'Message vide');
  const th = (await t.platform.query('SELECT id FROM platform.support_threads WHERE id = $1 AND shop_id = $2', [id, shopId]))[0];
  if (!th) throw notFound('Conversation introuvable');
  await t.platform.query('INSERT INTO platform.support_messages (thread_id, from_staff, author, body) VALUES ($1, false, $2, $3)', [id, author.name, p.data.body]);
  await t.platform.query(`UPDATE platform.support_threads SET status = 'open', unread_staff = true, updated_at = now() WHERE id = $1`, [id]);
  return { ok: true };
}

export async function shopUnread(t: Tenancy, shopId: number): Promise<number> {
  return num((await t.platform.query('SELECT count(*)::int AS n FROM platform.support_threads WHERE shop_id = $1 AND unread_shop', [shopId]))[0]?.n);
}

// ---------------------------------------------------------------- Pilotix's side
export async function staffThreads(t: Tenancy, f: { status?: 'open' | 'closed' | 'all'; shopId?: number }): Promise<SupportThread[]> {
  const rows = await t.platform.query(
    `${THREAD_SELECT} WHERE ($1::text IS NULL OR th.status = $1) AND ($2::int IS NULL OR th.shop_id = $2) ORDER BY th.unread_staff DESC, th.updated_at DESC LIMIT 300`,
    [f.status && f.status !== 'all' ? f.status : null, f.shopId ?? null],
  );
  return rows.map(toThread);
}

export async function staffThread(t: Tenancy, id: number): Promise<{ thread: SupportThread; messages: SupportMessage[] }> {
  const r = (await t.platform.query(`${THREAD_SELECT} WHERE th.id = $1`, [id]))[0];
  if (!r) throw notFound('Conversation introuvable');
  await t.platform.query('UPDATE platform.support_threads SET unread_staff = false WHERE id = $1', [id]);
  return { thread: { ...toThread(r), unreadStaff: false }, messages: await messagesOf(t, id) };
}

/** Pilotix answers: the store sees it in « Contacter Pilotix » (and its author gets an e-mail). */
export async function staffReply(t: Tenancy, id: number, staffName: string, raw: unknown): Promise<{ to: string; name: string; shop: string; subject: string; body: string; shopId: number }> {
  const p = SupportReply.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0]?.message ?? 'Message vide');
  const th = (await t.platform.query('SELECT th.*, s.name AS shop_name FROM platform.support_threads th JOIN platform.shops s ON s.id = th.shop_id WHERE th.id = $1', [id]))[0];
  if (!th) throw notFound('Conversation introuvable');
  await t.platform.query('INSERT INTO platform.support_messages (thread_id, from_staff, author, body) VALUES ($1, true, $2, $3)', [id, staffName, p.data.body]);
  await t.platform.query('UPDATE platform.support_threads SET unread_shop = true, unread_staff = false, updated_at = now() WHERE id = $1', [id]);
  return { to: th.author_email, name: th.author_name, shop: th.shop_name, subject: th.subject, body: p.data.body, shopId: num(th.shop_id) };
}

export async function staffSetStatus(t: Tenancy, id: number, status: 'open' | 'closed'): Promise<void> {
  const r = await t.platform.query('UPDATE platform.support_threads SET status = $2, unread_staff = false WHERE id = $1 RETURNING id', [id, status]);
  if (!r.length) throw notFound('Conversation introuvable');
}

export async function staffUnread(t: Tenancy): Promise<number> {
  return num((await t.platform.query('SELECT count(*)::int AS n FROM platform.support_threads WHERE unread_staff'))[0]?.n);
}
