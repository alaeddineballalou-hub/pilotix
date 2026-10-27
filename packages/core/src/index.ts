// Pilotix core: every business rule, used by the real server (PostgreSQL) and by the in-browser preview (PGlite).
import { Ctx, dispatch, Procedure } from './rpc';
import { REGISTRY } from './registry';
import { agencyGate, SELLER_PROCS } from './modules/agencyscope';
import { syncAgency } from './modules/agencies';
import { sellerCall } from './modules/agencywork';

export * from './db';
export * from './rpc';
export * from './settings';
export { expandIp, ipNet } from './net';
export { seedDemo, seedBase } from './seed';
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

export { REGISTRY };
export { syncAgency, syncLink, agencyCounts, monthBounds, monthNow } from './modules/agencies';
export { agencyGate, AGENCY_AGENT_PROCS, SELLER_PROCS } from './modules/agencyscope';
export { FANOUT_PROCS } from './modules/agencywork';

/** An agency's team changed (a person closed, given other roles): its agents' accounts in the stores follow. */
const AGENCY_TEAM = new Set(['users.create', 'users.update', 'admin.users.resetPassword', 'me.delete']);

const run = (ctx: Ctx, name: string, input: unknown) => dispatch(REGISTRY as unknown as Record<string, Procedure>, name, ctx, input, agencyGate);

/** Runs one named action for the logged-in user, with role checks, input validation and the agencies' limits. */
export async function call(name: string, ctx: Ctx, input: unknown) {
  // a confirmation agency's space working on its sellers' orders: inside the chosen store (or each of them)
  if (ctx.shop?.kind === 'agency' && ctx.seller !== undefined && SELLER_PROCS.has(name)) return sellerCall(name, ctx, input, run);
  const out = await run(ctx, name, input);
  if (ctx.shop?.kind === 'agency' && ctx.t && AGENCY_TEAM.has(name)) await syncAgency(ctx.t, ctx.shop.id);
  return out;
}

export type ProcName = keyof typeof REGISTRY;
