// Pilotix core: every business rule, used by the real server (PostgreSQL) and by the in-browser preview (PGlite).
import { Ctx, dispatch, Procedure } from './rpc';
import { REGISTRY } from './registry';
import { agencyGate, sellerProcsOf } from './modules/agencyscope';
import { syncAgency } from './modules/agencies';
import { sellerCall } from './modules/agencywork';
import { stopAgentPlan } from './modules/planledger';
import { requireAssignedProducts, seesPurchaseCosts, withoutPurchaseCosts } from './modules/productscope';

export * from './db';
export * from './rpc';
export * from './settings';
export { expandIp, ipNet } from './net';
export { seedDemo, seedBase } from './seed';
export { seedPilotDemo } from './seeds/pilot';
export { seedDemoPartners } from './demoPartners';
export { login, hashPassword, profileById } from './modules/users';
export type { ArchiveBlock, ArchiveKind, ArchiveRow, UseKind } from './modules/archive';
export { createPasswordReset, resetPassword, RESET_MINUTES, RESETS_PER_MONTH } from './passwordReset';
export type { PasswordResetLink, PasswordResetMail } from './passwordReset';
export { pgliteDb } from './pglite';
export * from './platform';
export { landingCommunes } from './modules/landing';
export { fromLibrary } from './modules/spy';
export type { RawAd, SpyAd, SpyBrief, SpyFinding, SpyKeyword, SpyProductRow, SpySettings, SpySite, SpySource, ScorePart } from './modules/spy';
export { demoSnapshot, demoRestore } from './demoKeep';
export type { DemoKeep } from './demoKeep';
export type { PGliteLike } from './pglite';
export type { ImportProduct, ImportResult } from './modules/productimport';
export type { ClientFacts, ClientLevel, ClientReasonCode, ClientScore, ScoreRules } from './modules/clientscore';

export { REGISTRY };
export { courierCatalog, COURIER_FEATURES, isCompany } from './couriers/catalog';
export type { CatalogCompany, CatalogItem, CourierFeature } from './couriers/catalog';
export type { KindField } from './couriers/kinds';
export { syncAgency, syncLink, agencyCounts, monthBounds, monthNow } from './modules/agencies';
export { agencyGate, AGENCY_AGENT_PROCS, MARKETER_AGENT_PROCS, MARKETER_SELLER_PROCS, SELLER_PROCS, sellerProcsOf } from './modules/agencyscope';
export { FANOUT_PROCS } from './modules/agencywork';
export { listPros, proByCode, computeProStats, STATS_HOURS } from './modules/pro';
export * as pilotLearn from './modules/pilotlearn';
export { pilotOn } from './modules/dellal';

/** A partner's team changed (a person closed, given other roles): its people's accounts in the stores follow. */
const AGENCY_TEAM = new Set(['users.create', 'users.update', 'admin.users.resetPassword', 'me.delete']);

const run = async (ctx: Ctx, name: string, input: unknown) => {
  const out = await dispatch(REGISTRY as unknown as Record<string, Procedure>, name, ctx, input, async (n, c, i: any) => {
    await agencyGate(n, c, i);
    if (['orders.quote', 'orders.create', 'orders.update'].includes(n) && i.items?.length)
      await requireAssignedProducts(c, i.items.map((l: any) => l.productId));
  });
  return seesPurchaseCosts(ctx) ? out : withoutPurchaseCosts(out);
};

/** Runs one named action for the logged-in user, with role checks, input validation and the agencies' limits. */
export async function call(name: string, ctx: Ctx, input: unknown) {
  // a partner's space (confirmation agency, marketer) working for its sellers: inside the chosen store (or each of them)
  const kind = ctx.shop?.kind;
  const partner = kind === 'agency' || kind === 'marketer';
  if (partner && ctx.seller !== undefined && sellerProcsOf(kind).has(name)) return sellerCall(name, ctx, input, run);
  // Stamp existing seller profiles with their stable agency identity before an e-mail change.
  if(partner && kind==='agency' && ctx.t && ((name==='users.update' && (ctx.session.isAdmin||ctx.session.canManageUsers))||name==='me.delete')) await syncAgency(ctx.t,ctx.shop!.id);
  const out = await run(ctx, name, input);
  if(partner && kind==='agency' && (name==='users.update'||name==='me.delete')) await stopAgentPlan(ctx,name==='me.delete'?ctx.session.profile.id:(input as {id:number}).id);
  if (partner && ctx.t && AGENCY_TEAM.has(name)) await syncAgency(ctx.t, ctx.shop!.id);
  return out;
}

export type ProcName = keyof typeof REGISTRY;
