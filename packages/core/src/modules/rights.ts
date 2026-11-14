// Utilisateurs › Rôles: what each role of the boutique sees and does (packages/shared/src/rights.ts holds the list).
// Here: the boutique's saved rights (made once from the old ticks), the person's rights for a call, the check of every
// call against them (`rightsGate`, before it runs), and the editor's two actions.
import {
  cleanRoleRights,
  type Profile,
  RIGHTS,
  RIGHTS_ROLES,
  rightsFromOldTicks,
  rightsOf,
  type RoleRights,
  type Session,
  tabRight,
} from '@pilotix/shared';
import { z } from 'zod';
import type { Db } from '../db';
import { num, numOrNull } from '../db';
import { type Ctx, forbidden, proc } from '../rpc';
import { getPrefs } from './prefs';

/** Rights are a store's: a confirmation agency's or a marketer's own space keeps its roles and its people's ticks. */
export const rightsApply = (ctx: Pick<Ctx, 'shop'>) => !ctx.shop?.kind || ctx.shop.kind === 'store';

const KEY = 'roleRights';
const TTL = 10_000;
const cache = new WeakMap<Db, { at: number; v: Promise<RoleRights> }>();

/** each change of a boutique's rights here: what was worked out for a person before it is read again */
let generation = 0;
/** Forget what is kept of a boutique's rights (after a change). */
export const forgetRights = (db: Db) => {
  cache.delete(db);
  generation++;
};

/**
 * The boutique's rights. The first time: made from where they were before (Préférences' « Qui peut … », the three ticks
 * on the people), so that nothing changes for anybody that day, and saved.
 */
export async function boutiqueRights(db: Db): Promise<RoleRights> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  const v = (async () => {
    const row = (await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [KEY]))[0];
    if (row) return cleanRoleRights(row.value);
    const first = await fromOldTicks(db);
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING', [KEY, JSON.stringify(first)]);
    const again = (await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [KEY]))[0];
    return cleanRoleRights(again?.value ?? first);
  })();
  cache.set(db, { at: Date.now(), v });
  v.catch(() => cache.delete(db));
  return v;
}

async function fromOldTicks(db: Db): Promise<RoleRights> {
  const p = await getPrefs(db);
  const people = await db.query('SELECT id, roles, agency_id, can_manage_users, can_assign, can_affect FROM profiles');
  return rightsFromOldTicks({
    changeCompany: p.changeCompany,
    rulesBy: p.rulesBy,
    people: people.map((r: any) => ({
      id: num(r.id),
      roles: r.roles ?? [],
      agencyId: numOrNull(r.agency_id),
      canManageUsers: !!r.can_manage_users,
      canAssign: !!r.can_assign,
      canAffect: !!r.can_affect,
    })),
  });
}

// keyed by the person's profile, which a call's derived sessions keep (asDepot…) and the server keeps a few seconds
const memo = new WeakMap<object, { gen: number; p: Promise<Set<string>> }>();

/**
 * Every right of the person making this call (null: no limits from rights — an administrator, a partner's own space).
 * Read once per call, before it runs (rightsGate): a check made later inside a transaction never waits for the
 * database (a single-connection database, the in-browser demo, would wait for itself).
 */
export async function rightsOfCtx(ctx: Ctx): Promise<Set<string> | null> {
  if (ctx.session.isAdmin || !rightsApply(ctx)) return null;
  const key = ctx.session.profile as object;
  const hit = memo.get(key);
  if (hit && hit.gen === generation) return hit.p;
  const p = boutiqueRights(ctx.db).then((rr) => rightsOf(ctx.session.profile, rr));
  memo.set(key, { gen: generation, p });
  p.catch(() => memo.delete(key));
  return p;
}

/** A partner's own space: the three « en plus » that were ticks on the person (its roles decide the rest). */
function legacy(ctx: Ctx, id: string): boolean {
  if (id === 'x:users') return !!ctx.session.canManageUsers;
  if (id === 'x:assign') return !!ctx.session.profile.canAssign;
  if (id === 'x:affect') return !!ctx.session.profile.canAffect;
  return true;
}

/** Has the person making this call this right? */
export async function can(ctx: Ctx, id: string): Promise<boolean> {
  if (ctx.session.isAdmin) return true;
  if (!rightsApply(ctx)) return legacy(ctx, id);
  const set = await rightsOfCtx(ctx);
  return !set || set.has(id);
}

export const NOT_YOUR_RIGHT = 'Votre rôle n’a pas ce droit dans cette boutique (Utilisateurs › Rôles)';

export async function needRight(ctx: Ctx, id: string, message = NOT_YOUR_RIGHT) {
  if (!(await can(ctx, id))) throw forbidden(message);
}

/**
 * The session as the app gets it: its rights, and the three old ticks worked out from them (the screens still read
 * them). A partner's own space: as it was.
 */
export async function sessionWithRights<S extends Session>(db: Db, session: S, shop: Ctx['shop']): Promise<S> {
  if (!rightsApply({ shop }) || session.isAdmin) return { ...session, rights: null };
  const set = rightsOf(session.profile, await boutiqueRights(db));
  const profile: Profile = { ...session.profile, canManageUsers: set.has('x:users'), canAssign: set.has('x:assign'), canAffect: set.has('x:affect') };
  return { ...session, profile, canManageUsers: set.has('x:users'), rights: [...set] };
}

// ---------------------------------------------------------------- the server's check of every call
type Need = string | readonly string[] | ((input: any, ctx: Ctx) => string | readonly string[] | null);

const BAD_CONF = new Set(['cancelled', 'duplicate', 'wrong_number', 'fake']);
/** Suivi's list tabs, as the menu names them ('alertes_new', 'alertes_encours': the « Alertes » tab); one it does not know
 *  is a right nobody has */
const suiviTab = (t: unknown) => (typeof t === 'string' ? (tabRight('suivi', t) ?? `tab:suivi/${t}`) : null);

/**
 * Which right an action needs (any one of a list). An action left out needs none (its roles decide, as before). The
 * roles of every action here are inside the defaults of its rights: by default nobody loses anything (test/rights).
 */
export const PROC_RIGHTS: Record<string, Need> = {
  // orders, wherever they are shown (orders.update: the customer and the products are checked inside, on what changes)
  'orders.create': 'act:orders.create',
  'orders.duplicate': 'act:orders.create',
  'orders.setConf': (i) => (BAD_CONF.has(i.status) ? 'act:orders.cancel' : null),
  'orders.assignAgent': (i, ctx) => (i.agentId !== ctx.session.profile.id ? 'act:orders.give' : null),
  'customers.setBlacklist': 'act:orders.blacklist',
  'delivery.send': 'act:orders.send',
  'delivery.cancel': 'act:orders.parcelCancel',
  'confirmation.photoShare': 'act:conf.photos',
  // Confirmation's tabs (« Livrées » is Commandes' tab)
  'confirmation.list': (i) => (typeof i.sub === 'string' ? (i.sub === 'livrees' ? 'tab:commandes/livrees' : `tab:confirmation/${i.sub}`) : null),
  // Suivi
  'suivi.list': (i) => suiviTab(i.tab),
  'suivi.treat': 'act:suivi.treat',
  'suivi.resolve': 'act:suivi.treat',
  'suivi.act': 'act:suivi.treat',
  'suivi.next': 'act:suivi.treat',
  'suivi.release': 'act:suivi.treat',
  'suivi.unassign': 'act:suivi.treat',
  'suivi.stuckDone': 'act:suivi.treat',
  'suivi.claimCreate': 'act:suivi.claim',
  'suivi.claimPush': 'act:suivi.claim',
  'suivi.claimRemind': 'act:suivi.claim',
  'suivi.claimUpdate': 'act:suivi.claim',
  'suivi.claimSync': 'act:suivi.claim',
  'suivi.swap': 'act:suivi.swap',
  'parcel.change': 'act:suivi.parcel',
  'parcel.changeCancel': 'act:suivi.parcel',
  'parcel.action': 'act:suivi.parcel',
  // Dépôt
  'depot.pick': 'act:depot.prepare',
  'depot.pickUndo': 'act:depot.prepare',
  'depot.pickDone': 'act:depot.prepare',
  'depot.ready': 'act:depot.prepare',
  'depot.dispatch': 'act:depot.dispatch',
  'depot.dropOff': 'act:depot.dispatch',
  'depot.resend': 'act:depot.dispatch',
  'depot.receiveReturn': 'act:depot.returns',
  'depot.restock': 'act:depot.returns',
  'depot.restockDone': 'act:depot.returns',
  'pickup.create': 'act:depot.pickup',
  'pickup.createMany': 'act:depot.pickup',
  'pickup.add': 'act:depot.pickup',
  'pickup.remove': 'act:depot.pickup',
  'pickup.drop': 'act:depot.pickup',
  // SAV (and its page for every one of its actions, below)
  'sav.create': 'act:sav.create',
  'sav.exchange': 'act:sav.exchange',
  'sav.settle': 'act:sav.settle',
  // Produits & stock
  'catalog.saveProduct': 'act:stock.products',
  'catalog.saveMontage': 'act:stock.products',
  'catalog.importProducts': 'act:stock.products',
  'catalog.setAvailability': 'act:stock.products',
  'photos.add': 'act:stock.products',
  'photos.update': 'act:stock.products',
  'photos.remove': 'act:stock.products',
  'catalog.setPrices': 'act:stock.prices',
  'catalog.move': 'act:stock.move',
  'catalog.transfer': 'act:stock.move',
  'catalog.transferMany': 'act:stock.move',
  'stock.markBroken': 'act:stock.move',
  'stock.fixBroken': 'act:stock.move',
  'purchases.create': 'act:stock.purchases',
  'purchases.pay': 'act:stock.purchases',
  'suppliers.save': 'act:stock.purchases',
  'catalog.saveGuide': 'act:stock.guides',
  'catalog.translateGuide': 'act:stock.guides',
  'catalog.guideDraft': 'act:stock.guides',
  // Point de vente
  'pos.sell': 'act:pos.sell',
  'pos.open': 'act:pos.sell',
  'pos.close': 'act:pos.sell',
  'pos.clientNew': 'act:pos.sell',
  'pos.cancel': 'act:pos.cancel',
  // Ma caisse
  'caisse.add': 'act:caisse.add',
  'caisse.transfer': 'act:caisse.transfer',
  'pay.ask': 'act:pay.ask',
  'pay.askCancel': 'act:pay.ask',
  // AI Pilot
  'dellal.reply': 'act:dellal.reply',
  'dellal.setMode': 'act:dellal.reply',
  'cm.reply': 'act:cm.reply',
  'cm.private': 'act:cm.reply',
  'cm.hide': 'act:cm.reply',
  'cm.answer': 'act:cm.reply',
  'cm.ignore': 'act:cm.reply',
  'cm.plan.save': 'act:social.publish',
  'cm.plan.publishNow': 'act:social.publish',
  'cm.plan.editPosted': 'act:social.publish',
  'cm.plan.delete': 'act:social.publish',
  'cm.plan.move': 'act:social.publish',
  'cm.plan.planMany': 'act:social.publish',
  'cm.plan.again': 'act:social.publish',
  'cm.plan.fillWeek': 'act:social.publish',
  'notify.sendNow': 'act:notify.send',
  'notify.markSent': 'act:notify.send',
  'notify.skip': 'act:notify.send',
  'promo.settings.save': 'act:promo.settings',
  'promo.mark': 'act:promo.settings',
  'promo.markPost': 'act:promo.settings',
  // Marketing
  'ads.ctl.act': 'act:ads.control',
  'ads.ctl.undo': 'act:ads.control',
  'ads.launch.save': 'act:ads.launch',
  'ads.launch.go': 'act:ads.launch',
  'ads.launch.copy': 'act:ads.launch',
  'ads.launch.remove': 'act:ads.launch',
  'ads.setMarketer': 'act:ads.owner',
  'ads.setFx': 'act:ads.owner',
  'ads.ctl.approve': 'act:ads.owner',
  'ads.ctl.guard': 'act:ads.owner',
  'ads.ctl.stopAll': 'act:ads.owner',
  'ads.pilot.save': 'act:ads.owner',
  'ads.aud.save': 'act:ads.owner',
  'ads.launch.approve': 'act:ads.owner',
  'campaigns.save': 'act:campaigns.send',
  'campaigns.submit': 'act:campaigns.send',
  'campaigns.start': 'act:campaigns.send',
  'campaigns.remove': 'act:campaigns.send',
  'campaigns.import': 'act:campaigns.send',
  'leads.fix': 'act:leads.fix',
  'leads.create': 'act:leads.fix',
  'leads.ignore': 'act:leads.fix',
  'leads.retry': 'act:leads.fix',
  'leads.formSave': 'act:leads.fix',
  'metacatalog.add': 'act:catalog.send',
  'metacatalog.remove': 'act:catalog.send',
  'metacatalog.send': 'act:catalog.send',
  'metacatalog.listSave': 'act:catalog.send',
  'metacatalog.listRemove': 'act:catalog.send',
  'metacatalog.listAuto': 'act:catalog.send',
  'metacatalog.tiktok': 'act:catalog.send',
  'mk.pay': 'act:marketers.pay',
  'mk.unpay': 'act:marketers.pay',
  'mk.price': 'act:marketers.pay',
  'landing.save': 'act:landing.edit',
  'landing.remove': 'act:landing.edit',
  'landing.quickCreate': 'act:landing.edit',
  'landing.addImage': 'act:landing.edit',
  'landing.addW320': 'act:landing.edit',
  'landing.ignore': 'act:landing.edit',
  'landing.settings.save': 'act:landing.edit',
  'landing.groupSave': 'act:landing.edit',
  'landing.groupRemove': 'act:landing.edit',
  'landing.pixelSave': 'act:landing.edit',
  'landing.pixelRemove': 'act:landing.edit',
  'landing.markDevice': 'act:landing.protect',
  'landing.restore': 'act:landing.protect',
  'landing.dismiss': 'act:landing.protect',
  'landing.convertLead': 'act:landing.protect',
  'landing.dismissLead': 'act:landing.protect',
  'partners.add': 'act:partners.manage',
  'partners.ask': 'act:partners.manage',
  'partners.revoke': 'act:partners.manage',
  'partners.note': 'act:partners.manage',
  // the team boards of the Dashboard
  'stats.overview2': 'tab:dashboard/overview',
  'stats.dashDepot': 'tab:dashboard/depot',
  'stats.dashSuivi': 'tab:dashboard/suivi',
  'stats.dashLivreurs': 'tab:dashboard/livreurs',
  'stats.dashSav': 'tab:dashboard/sav',
  'confirmation.firstCall': 'tab:dashboard/confirmation',
  'confirmation.period': 'tab:dashboard/confirmation',
  'confirmation.delivery': 'tab:dashboard/confirmation',
  'confirmation.enCours': 'tab:dashboard/confirmation',
  'confirmation.confirmed': 'tab:dashboard/confirmation',
  'confirmation.riskStats': 'tab:dashboard/confirmation',
};

/**
 * Whole pages whose actions are their own: the page's right (or one of the pages that use them) for every one of them.
 * The first prefix that matches decides.
 */
const PAGE_PROCS: readonly (readonly [prefix: string, right: string | readonly string[], except?: readonly string[]])[] = [
  ['sav.', 'page:sav'],
  ['pos.', 'page:pos'],
  ['spy.', 'page:spy'],
  ['createur.', 'page:createur'],
  // Pilot Content's planner, also used by Espace créateur
  ['cm.plan.', ['page:social', 'page:createur']],
  ['tournee.', 'page:tournee'],
  ['partners.', 'page:influenceurs'],
  ['campaigns.', 'tab:marketing/campagnes', ['campaigns.optin']],
  ['leads.', 'tab:marketing/formulaires'],
  ['metacatalog.', 'tab:marketing/catalogue'],
  ['mk.', 'tab:marketing/marketer'],
  ['strat.', 'tab:marketing/strategies'],
  ['ads.', 'tab:marketing/publicite'],
  ['promo.settings.', 'page:codepromo'],
  // the « Awareness 🎁 » marks: Code promo, and the ticks of Pilot Comments' posts and of Publicité's ads
  ['promo.mark', ['page:codepromo', 'page:cm', 'tab:marketing/publicite']],
  ['promo.stats', 'page:codepromo'],
  // a landing page made from Marketing › Catalogue
  ['landing.quickCreate', ['page:landing', 'tab:marketing/catalogue']],
  [
    'landing.',
    'page:landing',
    ['landing.store', 'landing.code', 'landing.coverage', 'landing.counts', 'landing.blocked', 'landing.protection', 'landing.markDevice', 'landing.restore', 'landing.dismiss', 'landing.leads', 'landing.convertLead', 'landing.dismissLead'],
  ],
];

/** The rights an action needs: its own, and its page's (each must be there). */
export function rightsNeeded(name: string, input: unknown, ctx: Ctx): (readonly string[])[] {
  const out: (readonly string[])[] = [];
  const page = PAGE_PROCS.find(([p, , except]) => name.startsWith(p) && !except?.includes(name));
  if (page) out.push(typeof page[1] === 'string' ? [page[1]] : page[1]);
  const n = PROC_RIGHTS[name];
  const own = typeof n === 'function' ? n(input ?? {}, ctx) : n;
  if (own) out.push(typeof own === 'string' ? [own] : own);
  return out;
}

/** Refuses a call the person's rights do not allow (before it runs). Administrators and partners' spaces: as before. */
export async function rightsGate(name: string, ctx: Ctx, input: unknown) {
  if (ctx.session.isAdmin || !rightsApply(ctx)) return;
  // always read first: the action's own checks then find them at hand
  const set = await rightsOfCtx(ctx);
  const need = rightsNeeded(name, input, ctx);
  if (!need.length || !set) return;
  for (const any of need) if (!any.some((id) => set.has(id))) throw forbidden(NOT_YOUR_RIGHT);
}

// ---------------------------------------------------------------- the editor (Utilisateurs › Rôles)
const Edit = z.object({ off: z.array(z.string().max(80)).max(400).optional(), on: z.array(z.string().max(80)).max(400).optional() });
const RolesIn = z.object(Object.fromEntries(RIGHTS_ROLES.map((r) => [r, Edit.optional()])) as Record<(typeof RIGHTS_ROLES)[number], z.ZodOptional<typeof Edit>>);

async function teamPeople(db: Db) {
  const rows = await db.query("SELECT id, name, roles, agency_id, active FROM profiles WHERE archived_at IS NULL AND NOT ('admin' = ANY(roles)) ORDER BY name");
  return rows.map((r: any) => ({ id: num(r.id), name: String(r.name ?? ''), roles: (r.roles ?? []) as Profile['roles'], agencyId: numOrNull(r.agency_id), active: !!r.active }));
}

export const rightsProcs = {
  /** The boutique's rights, its team (for « Une personne à part ») and how many people each role has. */
  'rights.get': proc([], z.object({}), async (ctx) => {
    if (!rightsApply(ctx)) throw forbidden('Les rôles se règlent dans la boutique');
    const rr = await boutiqueRights(ctx.db);
    const people = await teamPeople(ctx.db);
    return { rights: rr, people, count: RIGHTS.length };
  }),
  /** Saves the boutique's rights, cleaned (never more than a role may get), and tells the open screens. */
  'rights.save': proc(
    [],
    z.object({ roles: RolesIn, people: z.record(z.string().regex(/^\d{1,12}$/), Edit).refine((x) => Object.keys(x).length <= 2000, 'Trop de personnes') }),
    async (ctx, i) => {
      if (!rightsApply(ctx)) throw forbidden('Les rôles se règlent dans la boutique');
      const people = await teamPeople(ctx.db);
      const clean = cleanRoleRights(i, new Map(people.map((p) => [p.id, p] as const)));
      await ctx.db.tx(async (tx) => {
        await tx.query(
          `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [KEY, JSON.stringify(clean), ctx.session.profile.id || null],
        );
        // the three ticks people had are kept as they now are (a partner's tools still read them)
        for (const p of people) {
          const on = new Set(clean.people[String(p.id)]?.on ?? []);
          await tx.query('UPDATE profiles SET can_manage_users = $2, can_assign = $3, can_affect = $4 WHERE id = $1', [p.id, on.has('x:users'), on.has('x:assign'), on.has('x:affect')]);
        }
      });
      forgetRights(ctx.db);
      ctx.emit({ type: 'settings', data: { key: KEY } });
      return { rights: clean };
    },
  ),
};

// ---------------------------------------------------------------- the three old ticks, still sent by some screens
/** Has another person of the boutique this right (e.g. a manager may not edit someone who also manages the team)? */
export async function personHas(ctx: Ctx, p: Pick<Profile, 'id' | 'roles' | 'agencyId' | 'canManageUsers' | 'canAssign' | 'canAffect'>, id: string): Promise<boolean> {
  if (p.roles.includes('admin')) return true;
  if (!rightsApply(ctx)) return id === 'x:users' ? !!p.canManageUsers : id === 'x:assign' ? !!p.canAssign : id === 'x:affect' ? !!p.canAffect : true;
  return rightsOf(p, await boutiqueRights(ctx.db)).has(id);
}

const TICKS = [
  ['canManageUsers', 'x:users'],
  ['canAssign', 'x:assign'],
  ['canAffect', 'x:affect'],
] as const;

/**
 * A person's three old ticks, set by the administrator from the person's card (users.create / users.update): in a store
 * they are the person's own « en plus » (Utilisateurs › Rôles).
 */
export async function setPersonTicks(ctx: Ctx, profileId: number, t: { canManageUsers?: boolean; canAssign?: boolean; canAffect?: boolean }) {
  if (!rightsApply(ctx) || TICKS.every(([k]) => t[k] === undefined)) return;
  const rr = await boutiqueRights(ctx.db);
  const mine = { ...(rr.people[String(profileId)] ?? {}) };
  const on = new Set(mine.on ?? []);
  for (const [k, id] of TICKS) {
    if (t[k] === true) on.add(id);
    if (t[k] === false) on.delete(id);
  }
  const next: RoleRights = { roles: rr.roles, people: { ...rr.people, [String(profileId)]: { ...mine, on: [...on] } } };
  const people = await teamPeople(ctx.db);
  const clean = cleanRoleRights(next, new Map(people.map((p) => [p.id, p] as const)));
  await ctx.db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [KEY, JSON.stringify(clean), ctx.session.profile.id || null],
  );
  forgetRights(ctx.db);
}
