// Caisses: the owner's main caisse, the bank, and one caisse per employee — and all the money still outside
// (what the delivery companies owe, the cash the livreurs hold). A caisse's balance = the versements received into it
// (cash_handovers.received_into, NULL = main) + its moves (expenses, manual entries, transfers).
import { z } from 'zod';
import { iso, num } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { cashProcs, CaisseKey, checkCaisse, livreursCash } from './cash';

const STAFF = ['confirmation', 'suivi', 'depot', 'agent_manager'] as const;
export const EXPENSE_CATS = ['fuel', 'packing', 'salary', 'rent', 'ads', 'repair', 'other'] as const;
const Amount = z.number().int().min(1).max(1_000_000_000);

/** Start of today in Algiers (UTC+1), as an ISO date-time. */
const todayStart = (now: number) => {
  const d = new Date(now + 3_600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 3_600_000).toISOString();
};
const monthStart = (now: number) => {
  const d = new Date(now + 3_600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 3_600_000).toISOString();
};

/** Balance of every caisse (optionally only what moved since a date). */
async function balances(ctx: Ctx, since?: string) {
  const out = new Map<string, number>();
  const add = (k: string, v: number) => out.set(k, (out.get(k) ?? 0) + v);
  const p = since ? [since] : [];
  for (const r of await ctx.db.query(`SELECT COALESCE(received_into, 'main') AS k, sum(net)::bigint AS v FROM cash_handovers WHERE cancelled_at IS NULL ${since ? 'AND created_at >= $1' : ''} GROUP BY 1`, p)) add(String(r.k), num(r.v));
  for (const r of await ctx.db.query(`SELECT caisse AS k, sum(amount)::bigint AS v FROM cash_moves WHERE cancelled_at IS NULL ${since ? 'AND created_at >= $1' : ''} GROUP BY 1`, p)) add(String(r.k), num(r.v));
  return out;
}

/** The people who can hold a caisse: the office team (the owner's money is the main caisse). */
async function staff(ctx: Ctx) {
  const rows = await ctx.db.query(`SELECT id, name, roles FROM profiles WHERE active ORDER BY name`);
  return rows
    .map((r: any) => ({ id: num(r.id), name: r.name as string, roles: (r.roles ?? []) as string[] }))
    .filter((p: { roles: string[] }) => !p.roles.includes('admin') && !p.roles.includes('vendeur') && p.roles.some((x) => (STAFF as readonly string[]).includes(x)));
}

async function caisseName(ctx: Ctx, key: string) {
  if (key === 'main') return 'Caisse principale';
  if (key === 'bank') return 'Banque';
  return ((await ctx.db.query('SELECT name FROM profiles WHERE id = $1', [Number(key.slice(1))]))[0]?.name as string) ?? key;
}

const isStaffOnly = (ctx: Ctx) => !ctx.session.isAdmin && !ctx.session.roles.includes('vendeur');
const mine = (ctx: Ctx) => `u${ctx.session.profile.id}`;
/** An employee only touches his own caisse. */
function canUse(ctx: Ctx, key: string) {
  if (isStaffOnly(ctx) && key !== mine(ctx)) throw forbidden('Vous ne pouvez utiliser que votre caisse');
}

export type CaisseMove = {
  id: string;
  at: string;
  /** signed: + in, − out */
  amount: number;
  kind: 'receipt' | 'expense' | 'income' | 'transfer';
  label: string;
  sub: string | null;
  category: string | null;
  note: string | null;
  byName: string | null;
  /** a move (not a versement) that can be cancelled */
  moveId: number | null;
};

/** Everything that went in and out of one caisse, newest first. */
async function movesOf(ctx: Ctx, key: string, limit: number): Promise<CaisseMove[]> {
  const hs = await ctx.db.query(
    `SELECT h.id, h.created_at, h.net, cardinality(h.orders) AS n, c.name AS company_name, lv.name AS livreur_name, u.name AS by_name
     FROM cash_handovers h LEFT JOIN delivery_companies c ON c.id = h.company_id LEFT JOIN profiles lv ON lv.id = h.livreur_id LEFT JOIN profiles u ON u.id = h.created_by
     WHERE h.cancelled_at IS NULL AND COALESCE(h.received_into, 'main') = $1 ORDER BY h.created_at DESC LIMIT $2`,
    [key, limit],
  );
  const ms = await ctx.db.query(
    `SELECT m.*, u.name AS by_name, o.caisse AS other FROM cash_moves m LEFT JOIN profiles u ON u.id = m.created_by
     LEFT JOIN cash_moves o ON o.pair_id = m.pair_id AND o.id <> m.id
     WHERE m.cancelled_at IS NULL AND m.caisse = $1 ORDER BY m.created_at DESC LIMIT $2`,
    [key, limit],
  );
  const names = new Map<string, string>();
  for (const m of ms) if (m.other && !names.has(m.other)) names.set(m.other, await caisseName(ctx, m.other));
  const out: CaisseMove[] = [
    ...hs.map((h: any) => ({
      id: `h${h.id}`,
      at: iso(h.created_at),
      amount: num(h.net),
      kind: 'receipt' as const,
      label: (h.livreur_name ?? h.company_name ?? 'Sans société') as string,
      sub: `${num(h.n)} colis`,
      category: null,
      note: null,
      byName: (h.by_name ?? null) as string | null,
      moveId: null,
    })),
    ...ms.map((m: any) => ({
      id: `m${m.id}`,
      at: iso(m.created_at),
      amount: num(m.amount),
      kind: m.kind as CaisseMove['kind'],
      label: m.kind === 'transfer' ? (num(m.amount) < 0 ? `→ ${names.get(m.other) ?? '?'}` : `← ${names.get(m.other) ?? '?'}`) : ((m.note as string) || ''),
      sub: null,
      category: (m.category ?? null) as string | null,
      note: (m.note ?? null) as string | null,
      byName: (m.by_name ?? null) as string | null,
      moveId: num(m.id),
    })),
  ];
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

async function caisseView(ctx: Ctx, key: string, limit: number) {
  const bal = await balances(ctx);
  const month = monthStart(ctx.now());
  const moves = await movesOf(ctx, key, limit);
  const inMonth = moves.filter((m) => m.at >= month);
  return {
    key,
    name: await caisseName(ctx, key),
    balance: bal.get(key) ?? 0,
    monthIn: inMonth.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0),
    monthOut: inMonth.filter((m) => m.amount < 0).reduce((s, m) => s + m.amount, 0),
    moves,
  };
}

export const caissesProcs = {
  /** Main caisse, bank, and all the money still outside: companies, livreurs, employees. */
  'caisse.overview': proc([], z.object({}), async (ctx) => {
    const bal = await balances(ctx);
    const today = await balances(ctx, todayStart(ctx.now()));
    const due = await cashProcs['cash.due'].run(ctx, {});
    const companies = due.groups
      .filter((g) => !g.livreurId)
      .map((g) => ({ key: g.key, companyId: g.companyId, name: g.name, kind: g.kind, count: g.count, net: g.net, oldest: g.orders[0]?.deliveredAt ?? null }));
    const lc = await livreursCash(ctx, {});
    const lastBy = new Map<number, string>();
    for (const h of lc.handovers) if (h.livreurId && !lastBy.has(h.livreurId)) lastBy.set(h.livreurId, h.at);
    const livreurs = lc.livreurs.map((l) => ({ id: l.id, name: l.name, phone: l.phone, notCashed: l.notCashed, net: l.net, inHand: l.inHand, last: lastBy.get(l.id) ?? null }));
    const people = await staff(ctx);
    const employees = people.map((p) => ({ key: `u${p.id}`, id: p.id, name: p.name, role: p.roles.find((r) => (STAFF as readonly string[]).includes(r)) ?? null, balance: bal.get(`u${p.id}`) ?? 0 }));
    employees.sort((a, b) => b.balance - a.balance);
    return {
      main: { balance: bal.get('main') ?? 0, today: today.get('main') ?? 0 },
      bank: { balance: bal.get('bank') ?? 0 },
      companies,
      livreurs,
      employees,
      outside: companies.reduce((s, c) => s + c.net, 0) + livreurs.reduce((s, l) => s + l.net, 0) + employees.reduce((s, e) => s + e.balance, 0),
      tickets: { total: due.tickets.total, count: due.tickets.count },
    };
  }),

  /** One caisse: balance, this month in / out, its movements. */
  'caisse.view': proc([...STAFF, 'vendeur'], z.object({ caisse: CaisseKey, limit: z.number().int().min(1).max(500).default(150) }), async (ctx, i) => {
    canUse(ctx, i.caisse);
    return caisseView(ctx, i.caisse, i.limit);
  }),

  /** My own caisse (employees). */
  'caisse.mine': proc([...STAFF, 'vendeur'], z.object({ limit: z.number().int().min(1).max(500).default(150) }), async (ctx, i) => caisseView(ctx, mine(ctx), i.limit)),

  /** An expense (− money) or a manual entry (+ money) in a caisse. */
  'caisse.add': proc(
    [...STAFF, 'vendeur'],
    z.object({ caisse: CaisseKey, kind: z.enum(['expense', 'income']), amount: Amount, category: z.enum(EXPENSE_CATS).nullable().optional(), note: z.string().trim().max(300).nullable().optional() }),
    async (ctx, i) => {
      canUse(ctx, i.caisse);
      await checkCaisse(ctx.db, i.caisse);
      if (i.kind === 'expense' && !i.category) throw bad('Choisissez la catégorie de la dépense');
      const r = await ctx.db.query('INSERT INTO cash_moves (caisse, amount, kind, category, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
        i.caisse,
        i.kind === 'expense' ? -i.amount : i.amount,
        i.kind,
        i.kind === 'expense' ? i.category : null,
        i.note || null,
        ctx.session.profile.id,
      ]);
      return { id: num(r[0].id) };
    },
  ),

  /** Money moved from one caisse to another (an employee hands his cash to the main caisse, cash to the bank…). */
  'caisse.transfer': proc([...STAFF, 'vendeur'], z.object({ from: CaisseKey, to: CaisseKey, amount: Amount, note: z.string().trim().max(300).nullable().optional() }), async (ctx, i) => {
    if (i.from === i.to) throw bad('Choisissez deux caisses différentes');
    if (isStaffOnly(ctx) && (i.from !== mine(ctx) || i.to !== 'main')) throw forbidden('Vous pouvez seulement verser votre caisse à la caisse principale');
    await checkCaisse(ctx.db, i.from);
    await checkCaisse(ctx.db, i.to);
    const bal = (await balances(ctx)).get(i.from) ?? 0;
    if (bal < i.amount) throw bad(`Solde insuffisant : ${bal} DA dans cette caisse`);
    await ctx.db.tx(async (tx) => {
      const a = await tx.query(`INSERT INTO cash_moves (caisse, amount, kind, note, created_by) VALUES ($1,$2,'transfer',$3,$4) RETURNING id`, [i.from, -i.amount, i.note || null, ctx.session.profile.id]);
      const pair = num(a[0].id);
      await tx.query('UPDATE cash_moves SET pair_id = $1 WHERE id = $1', [pair]);
      await tx.query(`INSERT INTO cash_moves (caisse, amount, kind, note, pair_id, created_by) VALUES ($1,$2,'transfer',$3,$4,$5)`, [i.to, i.amount, i.note || null, pair, ctx.session.profile.id]);
    });
    return { ok: true };
  }),

  /** Cancels a move (both sides of a transfer). */
  'caisse.cancel': proc([], z.object({ id: z.number().int().positive() }), async (ctx, i) => {
    const m = (await ctx.db.query('SELECT id, pair_id, cancelled_at FROM cash_moves WHERE id = $1', [i.id]))[0];
    if (!m) throw notFound('Mouvement introuvable');
    if (m.cancelled_at) throw bad('Déjà annulé');
    if (m.pair_id) await ctx.db.query('UPDATE cash_moves SET cancelled_at = now() WHERE pair_id = $1', [m.pair_id]);
    else await ctx.db.query('UPDATE cash_moves SET cancelled_at = now() WHERE id = $1', [i.id]);
    return { ok: true };
  }),

  /** The caisses money can go into (for « Argent reçu » / « Encaisser » / transfers). */
  'caisse.list': proc([...STAFF, 'vendeur'], z.object({}), async (ctx) => [
    { key: 'main', name: 'Caisse principale' },
    { key: 'bank', name: 'Banque' },
    ...(await staff(ctx)).map((p) => ({ key: `u${p.id}`, name: p.name })),
  ]),
};
