// Landing pages › Réglages › « Team et fournisseurs » (20 Nov 2026). The owner's own test orders had blocked his
// number (many orders from one number, then « Rejeter »), so the shop's people get a list of their own:
//  - Team: the numbers of the boutique's own people in Pilotix (Management › Utilisateurs: by themselves; not a partner
//    agency's agents) and the numbers added here. Their orders on a landing page are tests: never blocked, never a real
//    order (they wait in Protection › « Tests de l'équipe »), nothing sent to Meta or TikTok, counted nowhere, and never
//    in the lists the ads leave out, so the team still sees the ads. The browser that sent a test is remembered (a
//    cookie of the page's address, apps/server): its next visits fire no pixel and are not counted either.
//  - Fournisseurs: the numbers of Stock › Fournisseurs (by themselves) and the numbers added here. Their orders are
//    blocked without them knowing (« Commandes bloquées », reason « fournisseur »), and they join the « faux numéros »
//    list that the ads launched from Pilotix leave out.
// Each list has its own switch, off by default. A number in both lists is Team: the shop's own people come first.
import { normalizePhone } from '@pilotix/shared';
import { z } from 'zod';
import { Db, isoOrNull, num, numOrNull } from '../db';
import { bad, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';

export type PhoneListKind = 'team' | 'supplier';
export const PHONE_LIST_KINDS = ['team', 'supplier'] as const;

/** the « Tests de l'équipe » list keeps this many tests (the oldest leave) */
export const TESTS_KEPT = 300;

/** an Algerian mobile as Pilotix keeps it (0XXXXXXXXX), or null */
export function mobile(raw: string | null | undefined): string | null {
  const d = String(raw ?? '')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
  const p = normalizePhone(d);
  return p && /^0[5-7]\d{8}$/.test(p) ? p : null;
}

/** every Algerian mobile written in a text (a supplier's phone field may hold two numbers, with spaces or dots) */
export function mobilesIn(text: string | null | undefined): string[] {
  const found = String(text ?? '').match(/(?:\+|00)?213[\s.-]?0?[5-7](?:[\s.-]?\d){8}|0[5-7](?:[\s.-]?\d){8}/g) ?? [];
  return [...new Set(found.map((x) => mobile(x.replace(/[\s.-]/g, ''))).filter((p): p is string => !!p))];
}

export interface ListNumber {
  phone: string;
  name: string;
}

/** the boutique's own people with a mobile (active, not archived, not a partner agency's agent) */
export async function teamAccounts(db: Db): Promise<ListNumber[]> {
  const rows = await db.query(`SELECT name, phone FROM profiles WHERE active AND archived_at IS NULL AND agency_id IS NULL AND coalesce(phone, '') <> '' ORDER BY lower(name)`);
  const out = new Map<string, ListNumber>();
  for (const r of rows) {
    const p = mobile(r.phone);
    if (p && !out.has(p)) out.set(p, { phone: p, name: String(r.name ?? '') });
  }
  return [...out.values()];
}

/** the numbers of Stock › Fournisseurs (active suppliers; one field may hold several numbers) */
export async function supplierAccounts(db: Db): Promise<ListNumber[]> {
  const rows = await db.query(`SELECT name, phone FROM suppliers WHERE active AND coalesce(phone, '') <> '' ORDER BY lower(name)`);
  const out = new Map<string, ListNumber>();
  for (const r of rows) for (const p of mobilesIn(r.phone)) if (!out.has(p)) out.set(p, { phone: p, name: String(r.name ?? '') });
  return [...out.values()];
}

/** the numbers added by hand to a list (newest first) */
export async function addedNumbers(db: Db, kind: PhoneListKind): Promise<(ListNumber & { at: string | null })[]> {
  const rows = await db.query(`SELECT phone, name, added_at FROM landing_lists WHERE kind = $1 ORDER BY added_at DESC, phone`, [kind]);
  return rows.map((r: any) => ({ phone: String(r.phone), name: String(r.name ?? ''), at: isoOrNull(r.added_at) }));
}

export interface ListSwitches {
  team?: boolean;
  suppliers?: boolean;
}

/** the two switches (Landing pages › Réglages), off unless turned on */
export async function listSwitches(db: Db): Promise<{ team: boolean; suppliers: boolean }> {
  const s = (await getSetting(db, 'landing')) as ListSwitches;
  return { team: s.team === true, suppliers: s.suppliers === true };
}

/** The numbers of a list as they count now: none while its switch is off; the suppliers never hold a Team number. */
export async function listPhones(db: Db, kind: PhoneListKind, sw?: { team: boolean; suppliers: boolean }): Promise<Set<string>> {
  const on = sw ?? (await listSwitches(db));
  const team = async () => new Set([...(await teamAccounts(db)).map((x) => x.phone), ...(await addedNumbers(db, 'team')).map((x) => x.phone)]);
  if (kind === 'team') return on.team ? team() : new Set();
  if (!on.suppliers) return new Set();
  const mates = on.team ? await team() : new Set<string>();
  const out = new Set<string>();
  for (const p of [...(await supplierAccounts(db)).map((x) => x.phone), ...(await addedNumbers(db, 'supplier')).map((x) => x.phone)]) if (!mates.has(p)) out.add(p);
  return out;
}

/** Which list this number is on now (Team first), or null. */
export async function listOf(db: Db, phone: string | null): Promise<PhoneListKind | null> {
  if (!phone) return null;
  const sw = await listSwitches(db);
  if (!sw.team && !sw.suppliers) return null;
  if (sw.team && (await listPhones(db, 'team', sw)).has(phone)) return 'team';
  if (sw.suppliers && (await listPhones(db, 'supplier', sw)).has(phone)) return 'supplier';
  return null;
}

export interface TestOrder {
  landingId: number;
  productId: number;
  variantId: number | null;
  qty: number;
  unitPrice: number;
  name: string;
  phone: string;
  wilayaId: number | null;
  commune: string;
  fromAd: boolean;
}

/** A team test: kept in « Tests de l'équipe » only (the last TESTS_KEPT). Nothing else happens. */
export async function recordTest(db: Db, t: TestOrder, now: number) {
  await db.query(
    `INSERT INTO landing_tests (landing_id, product_id, variant_id, qty, unit_price, customer_name, phone, wilaya_id, commune, from_ad, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [t.landingId, t.productId, t.variantId, t.qty, t.unitPrice, t.name.slice(0, 120), t.phone, t.wilayaId, t.commune.slice(0, 120), t.fromAd, new Date(now).toISOString()],
  );
  await db.query(`DELETE FROM landing_tests WHERE id IN (SELECT id FROM landing_tests ORDER BY id DESC OFFSET ${TESTS_KEPT})`);
}

const Kind = z.enum(PHONE_LIST_KINDS);
const Phone = z.string().max(40);

export const landingListsProcs = {
  /** The two lists: their switch, the numbers that count by themselves (team accounts, Stock › Fournisseurs), the ones added. */
  'landing.lists.get': proc([], z.object({}), async (ctx) => {
    const sw = await listSwitches(ctx.db);
    const fake = (await ctx.db.query(`SELECT is_on FROM ad_audiences WHERE kind = 'fake'`).catch(() => []))[0];
    return {
      team: { on: sw.team, accounts: await teamAccounts(ctx.db), added: await addedNumbers(ctx.db, 'team') },
      suppliers: { on: sw.suppliers, stock: await supplierAccounts(ctx.db), added: await addedNumbers(ctx.db, 'supplier') },
      /** Pub › Audiences « faux numéros » is on: the suppliers are left out of the ads launched from Pilotix */
      adsList: !!fake?.is_on,
    };
  }),

  /** A switch turned on or off (only the one sent changes). */
  'landing.lists.save': proc([], z.object({ team: z.boolean().optional(), suppliers: z.boolean().optional() }), async (ctx, i) => {
    const cur = await getSetting(ctx.db, 'landing');
    await setSetting(ctx.db, 'landing', { ...cur, ...(i.team !== undefined ? { team: i.team } : {}), ...(i.suppliers !== undefined ? { suppliers: i.suppliers } : {}) }, ctx.session.profile.id);
    ctx.emit({ type: 'settings' });
    return { ok: true };
  }),

  /** A number added to a list (again: its name is updated). */
  'landing.lists.add': proc([], z.object({ kind: Kind, phone: Phone, name: z.string().trim().max(80).default('') }), async (ctx, i) => {
    const phone = mobile(i.phone);
    if (!phone) throw bad('Numéro invalide : un mobile algérien (05, 06 ou 07)');
    await ctx.db.query(
      `INSERT INTO landing_lists (kind, phone, name, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, phone) DO UPDATE SET name = EXCLUDED.name`,
      [i.kind, phone, i.name, ctx.session.profile.id],
    );
    return { ok: true, phone };
  }),

  /** A number taken off a list (only one added by hand: the others follow their account or supplier). */
  'landing.lists.remove': proc([], z.object({ kind: Kind, phone: Phone }), async (ctx, i) => {
    const phone = mobile(i.phone);
    if (phone) await ctx.db.query(`DELETE FROM landing_lists WHERE kind = $1 AND phone = $2`, [i.kind, phone]);
    return { ok: true };
  }),

  /** Protection › « Tests de l'équipe »: the last tests (newest first), with their page and product. */
  'landing.tests': proc(['marketer', 'confirmation'], z.object({ limit: z.number().int().min(1).max(TESTS_KEPT).default(50) }), async (ctx, i) => {
    const sw = await listSwitches(ctx.db);
    const rows = await ctx.db.query(
      `SELECT t.*, l.slug, COALESCE(NULLIF(l.title, ''), p.name) AS title, v.title AS variant
       FROM landing_tests t LEFT JOIN landing_pages l ON l.id = t.landing_id LEFT JOIN products p ON p.id = t.product_id LEFT JOIN product_variants v ON v.id = t.variant_id
       ORDER BY t.at DESC, t.id DESC LIMIT $1`,
      [i.limit],
    );
    const total = num((await ctx.db.query(`SELECT count(*) AS n FROM landing_tests`))[0]?.n);
    return {
      on: sw.team,
      total,
      tests: rows.map((r: any) => ({
        id: num(r.id),
        at: isoOrNull(r.at),
        name: String(r.customer_name ?? ''),
        phone: String(r.phone ?? ''),
        slug: r.slug ? String(r.slug) : null,
        title: r.title ? String(r.title) : null,
        variant: r.variant ? String(r.variant) : null,
        qty: num(r.qty),
        total: num(r.qty) * num(r.unit_price),
        wilayaId: numOrNull(r.wilaya_id),
        commune: String(r.commune ?? ''),
        fromAd: !!r.from_ad,
      })),
    };
  }),
};
