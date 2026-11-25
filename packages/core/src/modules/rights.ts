// Utilisateurs › Rôles: what each role of the boutique sees and does (packages/shared/src/rights.ts holds the list).
// Here: the boutique's saved rights (made once from the old ticks), the person's rights for a call, the check of every
// call against them (`rightsGate`, before it runs), and the editor's two actions.
import {
  cleanCustomRoles,
  cleanRoleRights,
  CUSTOM_BASES,
  CUSTOM_ID,
  type CustomBase,
  customBaseSet,
  customCanOn,
  type CustomRole,
  type CustomRoles,
  customRoleSet,
  expandRoles,
  makerCap,
  NO_CUSTOM,
  type Profile,
  RIGHTS,
  RIGHTS_ROLES,
  rightDef,
  rightsFromOldTicks,
  rightsOf,
  type Role,
  type RoleRights,
  type Session,
  tabRight,
} from '@pilotix/shared';
import { z } from 'zod';
import type { Db } from '../db';
import { num, numOrNull } from '../db';
import { bad, type Ctx, forbidden, notFound, proc } from '../rpc';
import { agencyLead } from './agencyscope';
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
    if (row) return withCustom(db, cleanRoleRights(row.value));
    const first = await fromOldTicks(db);
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING', [KEY, JSON.stringify(first)]);
    const again = (await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [KEY]))[0];
    return withCustom(db, cleanRoleRights(again?.value ?? first));
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

// ---------------------------------------------------------------- roles made in the boutique (« + Nouveau rôle »)
// The owner's choice (22 Nov 2026): an administrator, or someone who manages the team's accounts, makes a role from one
// they have themselves; it never has more than its maker has now; a maker sees only the roles they made (an
// administrator sees them all). Saved apart from the roles' rights (settings 'customRoles'), so that the editor of the
// rights never writes over them.
const CUSTOM_KEY = 'customRoles';
const MAX_CUSTOM = 60;

/** The roles' French names, for the messages. */
export const ROLE_FR: Record<string, string> = {
  admin: 'Administrateur',
  vendeur: 'Vendeur',
  agent_manager: 'Agent manager',
  confirmation: 'Confirmation',
  suivi: 'Suivi',
  depot: 'Dépôt',
  livreur: 'Livreur',
  marketer: 'Marketeur',
  cm: 'Community manager',
};

type SavedCustom = CustomRoles & { next: number };

/** The roles made here as saved, cleaned. `lock`: inside a transaction, held for the change that follows. */
async function savedCustom(db: Db, lock = false): Promise<SavedCustom> {
  const row = (await db.query<{ value: any }>(`SELECT value FROM settings WHERE key = $1${lock ? ' FOR UPDATE' : ''}`, [CUSTOM_KEY]))[0];
  const c = cleanCustomRoles(row?.value);
  const next = Math.max(Number(row?.value?.next) || 1, ...Object.keys(c.roles).map((id) => Number(id.slice(1)) + 1));
  return { roles: c.roles, people: c.people, next };
}

async function writeCustom(db: Db, c: SavedCustom, by: number) {
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [CUSTOM_KEY, JSON.stringify({ roles: c.roles, people: c.people, next: c.next }), by || null],
  );
}

/** The boutique's rights with its roles made here, and their makers as they are now (what caps those roles). */
async function withCustom(db: Db, rr: RoleRights): Promise<RoleRights> {
  const c = await savedCustom(db);
  if (!Object.keys(c.roles).length) return rr;
  const ids = [...new Set(Object.values(c.roles).map((x) => x.by).filter((x): x is number => x != null))];
  const makers: NonNullable<CustomRoles['makers']> = {};
  if (ids.length)
    for (const m of await db.query('SELECT id, roles, agency_id FROM profiles WHERE id = ANY($1)', [ids]))
      makers[String(num(m.id))] = { roles: (m.roles ?? []) as Role[], agencyId: numOrNull(m.agency_id) };
  return { ...rr, custom: { roles: c.roles, people: c.people, makers } };
}

/** Who makes roles here: an administrator (from any role), or someone who manages the accounts (from a role they have). */
async function customMaker(ctx: Ctx): Promise<{ admin: boolean; bases: CustomBase[] }> {
  if (!rightsApply(ctx)) throw forbidden('Les rôles se règlent dans la boutique');
  if (ctx.session.isAdmin) return { admin: true, bases: [...CUSTOM_BASES] };
  if (!(await can(ctx, 'x:users'))) throw forbidden();
  const mine = expandRoles(ctx.session.profile.roles);
  return { admin: false, bases: CUSTOM_BASES.filter((b) => mine.includes(b)) };
}

/**
 * Gives one person a role made here (null: none; undefined: as it is), from their card (users.create / users.update).
 * Only an administrator or the role's maker gives it, or takes it back (it may have taken rights away); the person needs
 * the role it starts from. `roles`: their roles after this change — a role made here whose starting role went, goes too.
 */
export async function giveCustomRole(ctx: Ctx, personId: number, roleId: string | null | undefined, roles: readonly string[]) {
  if (!rightsApply(ctx)) {
    if (roleId) throw bad('Les rôles faits dans Utilisateurs › Rôles se donnent dans la boutique');
    return;
  }
  const me = ctx.session.profile.id;
  const admin = ctx.session.isAdmin;
  let changed = false;
  await ctx.db.tx(async (tx) => {
    const c = await savedCustom(tx, true);
    const k = String(personId);
    const had = c.people[k] ? c.roles[c.people[k]] : undefined;
    const want = roleId === undefined ? (had && roles.includes(had.base) ? had.id : null) : roleId;
    if ((had?.id ?? null) === want) return;
    if (had && roleId !== undefined && !admin && had.by !== me) throw forbidden(`Le rôle « ${had.name} » a été fait par quelqu’un d’autre : seuls lui et l’administrateur le changent`);
    if (!admin && (had?.base === 'admin' || (want && c.roles[want]?.base === 'admin'))) throw forbidden();
    if (want) {
      const x = c.roles[want];
      if (!x) throw bad('Ce rôle n’existe plus');
      if (!admin && x.by !== me) throw forbidden('Vous ne pouvez donner que les rôles que vous avez faits');
      if (!roles.includes(x.base)) throw bad(`Le rôle « ${x.name} » part de « ${ROLE_FR[x.base]} » : cochez aussi ce rôle`);
      c.people[k] = want;
    } else delete c.people[k];
    await writeCustom(tx, c, me);
    changed = true;
  });
  if (changed) {
    forgetRights(ctx.db);
    ctx.emit({ type: 'settings', data: { key: CUSTOM_KEY } });
  }
}

// keyed by the person's profile, which a call's derived sessions keep (asDepot…) and the server keeps a few seconds
const memo = new WeakMap<object, { gen: number; p: Promise<Set<string>> }>();

/**
 * Every right of the person making this call (null: no limits from rights — an administrator, a partner's own space).
 * Read once per call, before it runs (rightsGate): a check made later inside a transaction never waits for the
 * database (a single-connection database, the in-browser demo, would wait for itself).
 */
export async function rightsOfCtx(ctx: Ctx): Promise<Set<string> | null> {
  if (ctx.session.isAdmin || (ctx.session.profile.agencyId != null && !ctx.session.roles.includes('marketer')) || !rightsApply(ctx)) return null;
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
  // a confirmation agency's chief and its chefs d'équipe give the agency's orders to its own agents: the agency decides
  // that, not the store's « Rôles » (agencyscope.ts checks who and to whom)
  'orders.assignAgent': (i, ctx) => (i.agentId !== ctx.session.profile.id && !agencyLead(ctx) ? 'act:orders.give' : null),
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
  'suivi.unswap': 'act:suivi.swap',
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
  'catalog.guidePhotoAdd': 'act:stock.guides',
  'catalog.translateGuide': 'act:stock.guides',
  'catalog.guideDraft': 'act:stock.guides',
  // Point de vente
  'pos.sell': 'act:pos.sell',
  'pos.open': 'act:pos.sell',
  'pos.close': 'act:pos.sell',
  'pos.clientNew': 'act:pos.sell',
  'pos.cancel': 'act:pos.cancel',
  // Rendez-vous: a call's result, a booking taken by hand; the sessions (their days, seats and prices)
  'rdv.set': 'act:rdv.handle',
  'rdv.add': 'act:rdv.handle',
  'rdv.sessionSave': 'act:rdv.sessions',
  'rdv.sessionDelete': 'act:rdv.sessions',
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
  'ads.tree.campaign': 'act:ads.launch',
  'ads.tree.delete': 'act:ads.owner',
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
  'landing.aiTitle': 'act:landing.edit',
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
  // Landing pages › Site web: the shop's own site
  'site.start': 'act:landing.edit',
  'site.save': 'act:landing.edit',
  'site.publish': 'act:landing.edit',
  'site.unpublish': 'act:landing.edit',
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
  'confirmation.overview': 'tab:dashboard/confirmation',
  'confirmation.riskStats': 'tab:dashboard/confirmation',
};

/**
 * Whole pages whose actions are their own: the page's right (or one of the pages that use them) for every one of them.
 * The first prefix that matches decides.
 */
const PAGE_PROCS: readonly (readonly [prefix: string, right: string | readonly string[], except?: readonly string[]])[] = [
  ['sav.', 'page:sav'],
  ['pos.', 'page:pos'],
  ['rdv.', 'page:rendezvous'],
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
  // Landing pages › Site web
  ['site.', 'page:landing'],
  [
    'landing.',
    'page:landing',
    ['landing.store', 'landing.code', 'landing.coverage', 'landing.counts', 'landing.blocked', 'landing.protection', 'landing.markDevice', 'landing.restore', 'landing.dismiss', 'landing.leads', 'landing.convertLead', 'landing.dismissLead', 'landing.tests'],
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
  if (ctx.session.isAdmin || (ctx.session.profile.agencyId != null && !ctx.session.roles.includes('marketer')) || !rightsApply(ctx)) return;
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

  /**
   * The roles made here that this person may see (an administrator: all, with their maker; someone who manages the
   * accounts: the ones they made), each with what it has today and what its editor needs; the roles they may start a new
   * one from; and, for each person, the name of their role made here (a card shows it even when someone else made it).
   */
  'roles.custom.list': proc(null, z.object({}), async (ctx) => {
    const me = await customMaker(ctx);
    const rr = await boutiqueRights(ctx.db);
    const c = rr.custom ?? NO_CUSTOM;
    const myId = ctx.session.profile.id;
    const team = await ctx.db.query('SELECT id, name, active AND archived_at IS NULL AS active FROM profiles');
    const person = new Map(team.map((r: any) => [num(r.id), { name: String(r.name ?? ''), active: !!r.active }]));
    const roles = Object.values(c.roles)
      .filter((x) => me.admin || (x.base !== 'admin' && x.by === myId))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      .map((x) => {
        const cap = makerCap(x, rr);
        const people = Object.entries(c.people)
          .filter(([k, id]) => id === x.id && person.has(Number(k)))
          .map(([k]) => ({ id: Number(k), ...person.get(Number(k))! }));
        return {
          id: x.id,
          name: x.name,
          base: x.base,
          off: x.off ?? [],
          on: x.on ?? [],
          by: x.by,
          byName: x.by != null ? (person.get(x.by)?.name ?? null) : null,
          at: x.at,
          mine: x.by === myId,
          /** what its people have today */
          rights: [...customRoleSet(x, rr)],
          /** the editor's parts: what its starting role has here, what may be added, what its maker has (null: no limit) */
          baseHas: [...customBaseSet(x.base, rr)],
          canOn: [...customCanOn(x.base, rr, cap === null)],
          cap: cap ? [...cap] : null,
          people,
        };
      });
    const of: Record<string, { id: string; name: string; mine: boolean }> = {};
    for (const [k, id] of Object.entries(c.people)) {
      const x = c.roles[id];
      if (x) of[k] = { id, name: x.name, mine: me.admin || x.by === myId };
    }
    return { admin: me.admin, bases: me.bases, roles, of };
  }),

  /**
   * Makes a role (no id) or changes one (its maker or an administrator): a name, the role it starts from (one the maker
   * has), and its changes. What is turned on beyond the maker's rights now is not kept.
   */
  'roles.custom.save': proc(
    null,
    z.object({
      id: z.string().regex(CUSTOM_ID).optional(),
      name: z.string().trim().min(2).max(40),
      base: z.enum(CUSTOM_BASES),
      off: z.array(z.string().max(80)).max(400).default([]),
      on: z.array(z.string().max(80)).max(400).default([]),
    }),
    async (ctx, i) => {
      const me = await customMaker(ctx);
      const rr = await boutiqueRights(ctx.db);
      const myId = ctx.session.profile.id;
      const saved = await ctx.db.tx(async (tx) => {
        const c = await savedCustom(tx, true);
        const old = i.id ? c.roles[i.id] : undefined;
        if (i.id && !old) throw notFound('Ce rôle n’existe plus');
        if (old && !me.admin && old.by !== myId) throw forbidden('Seuls celui qui a fait ce rôle et l’administrateur le changent');
        if (i.base === 'admin' && !me.admin) throw forbidden();
        if (i.base === 'admin' && (i.off.length || i.on.length)) throw bad('Un administrateur a tous les droits');
        if (old && old.base !== i.base) throw bad('Le rôle de départ ne change pas : faites un nouveau rôle');
        if (!old && !me.bases.includes(i.base)) throw forbidden(`Vous ne pouvez partir que d’un rôle que vous avez vous-même (pas « ${ROLE_FR[i.base]} »)`);
        if (!old && Object.keys(c.roles).length >= MAX_CUSTOM) throw bad(`${MAX_CUSTOM} rôles au plus dans une boutique`);
        const name = i.name.trim().replace(/\s+/g, ' ');
        if (Object.values(c.roles).some((x) => x.id !== old?.id && x.name.toLowerCase() === name.toLowerCase())) throw bad('Un autre rôle porte déjà ce nom');
        const role: CustomRole = { id: old?.id ?? `c${c.next}`, name, base: i.base, by: old ? old.by : myId, at: old?.at ?? new Date(ctx.now()).toISOString() };
        // its maker's rights now (made by this person: theirs; else as the role reads them)
        const cap = role.by === myId ? (me.admin ? null : rightsOf(ctx.session.profile, rr)) : makerCap(role, rr);
        const baseHas = customBaseSet(i.base, rr);
        const canOn = customCanOn(i.base, rr, cap === null);
        const off = [...new Set(i.off)].filter((x) => {
          const d = rightDef(x);
          return !!d && !d.locked;
        });
        const on = [...new Set(i.on)].filter((x) => !off.includes(x) && !baseHas.has(x) && canOn.has(x) && (!cap || cap.has(x)));
        c.roles[role.id] = { ...role, ...(off.length ? { off } : {}), ...(on.length ? { on } : {}) };
        if (!old) c.next += 1;
        await writeCustom(tx, c, myId);
        return c.roles[role.id];
      });
      forgetRights(ctx.db);
      ctx.emit({ type: 'settings', data: { key: CUSTOM_KEY } });
      return { id: saved.id };
    },
  ),

  /** Deletes a role made here (its maker or an administrator), once nobody has it any more. */
  'roles.custom.delete': proc(null, z.object({ id: z.string().regex(CUSTOM_ID) }), async (ctx, i) => {
    const me = await customMaker(ctx);
    await ctx.db.tx(async (tx) => {
      const c = await savedCustom(tx, true);
      const x = c.roles[i.id];
      if (!x) return;
      if (!me.admin && (x.base === 'admin' || x.by !== ctx.session.profile.id)) throw forbidden('Seuls celui qui a fait ce rôle et l’administrateur le suppriment');
      const holders = Object.entries(c.people)
        .filter(([, id]) => id === i.id)
        .map(([k]) => Number(k));
      const assigned = holders.length ? await tx.query('SELECT name FROM profiles WHERE id = ANY($1) ORDER BY name', [holders]) : [];
      if (assigned.length) throw bad(`Ce rôle est encore donné à ${assigned.map((r: any) => r.name).join(', ')} : donnez-leur d’abord un autre rôle`);
      for (const k of holders) delete c.people[String(k)];
      delete c.roles[i.id];
      await writeCustom(tx, c, ctx.session.profile.id);
    });
    forgetRights(ctx.db);
    ctx.emit({ type: 'settings', data: { key: CUSTOM_KEY } });
    return { ok: true };
  }),
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
