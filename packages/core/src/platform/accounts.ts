// Accounts across shops: one e-mail may work in several shops (its own shops, or a client's), each shop keeping its
// accounts and roles. The login page checks the password in every shop of the e-mail and offers the ones it opens (a
// shop's administrator setting a password in their shop never opens another shop). Here too: the sign-up page (a shop
// made by its owner, on a free trial), the link that confirms the owner's e-mail, and a shop's own domain name.
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { num } from '../db';
import { hashPassword } from '../modules/users';
import { loadPlans, loadShop, platformSettings, provisionShop, Shop, shopIdsOfEmail, SLUG_RE, slugOk, freeSlug } from './shops';
import type { Tenancy } from './tenancy';

const DAY = 86_400_000;

async function sha256(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
function randomToken(): string {
  let s = '';
  for (const b of globalThis.crypto.getRandomValues(new Uint8Array(32))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The shops where this e-mail has an active account, with that account (closed and archived shops left out). */
export async function shopsOfEmail(t: Tenancy, email: string): Promise<{ shop: Shop; profileId: number; roles: string[]; hash: string }[]> {
  const out: { shop: Shop; profileId: number; roles: string[]; hash: string }[] = [];
  for (const id of await shopIdsOfEmail(t, email)) {
    const shop = await loadShop(t, { id });
    if (!shop || shop.status === 'archived' || shop.demo) continue;
    const p = (await t.shop(shop.schema).query('SELECT id, roles, password_hash FROM profiles WHERE lower(email) = $1 AND active', [email.trim().toLowerCase()]))[0];
    if (p) out.push({ shop, profileId: num(p.id), roles: p.roles as string[], hash: String(p.password_hash) });
  }
  return out;
}

/** The shops this e-mail and password open (each shop checks its own password). */
export async function shopsOpenedBy(t: Tenancy, email: string, password: string) {
  const out: { shop: Shop; profileId: number; roles: string[] }[] = [];
  for (const x of await shopsOfEmail(t, email)) if (await bcrypt.compare(password, x.hash)) out.push({ shop: x.shop, profileId: x.profileId, roles: x.roles });
  return out;
}

/**
 * A password changed in one shop: the other shops of the same e-mail that had the same password follow (the person keeps
 * one password); a shop with another password keeps it. Their other sessions end. Returns the shops changed.
 */
export async function followPasswordChange(t: Tenancy, email: string, current: string, next: string, exceptShopId: number): Promise<number[]> {
  const changed: number[] = [];
  let hash: string | null = null;
  for (const x of await shopsOfEmail(t, email)) {
    if (x.shop.id === exceptShopId || !(await bcrypt.compare(current, x.hash))) continue;
    hash ??= await hashPassword(next);
    await t.shop(x.shop.schema).query('UPDATE profiles SET password_hash = $2, token_version = token_version + 1 WHERE id = $1', [x.profileId, hash]);
    changed.push(x.shop.id);
  }
  return changed;
}

/**
 * « Mot de passe oublié » proves the person reads this e-mail: the new password opens every shop of the e-mail (it is
 * copied from the shop where the link was used). Their other sessions end.
 */
export async function spreadResetPassword(t: Tenancy, email: string, fromShopId: number): Promise<number[]> {
  const all = await shopsOfEmail(t, email);
  const from = all.find((x) => x.shop.id === fromShopId);
  if (!from) return [];
  const changed: number[] = [];
  for (const x of all) {
    if (x.shop.id === fromShopId) continue;
    await t.shop(x.shop.schema).query('UPDATE profiles SET password_hash = $2, token_version = token_version + 1 WHERE id = $1', [x.profileId, from.hash]);
    changed.push(x.shop.id);
  }
  return changed;
}

// ---------------------------------------------------------------- sign-up
export const SignupInput = z.object({
  shopName: z.string().trim().min(2, 'Nom de la boutique trop court').max(80),
  /** the shop's name in its links (site/<store>/<page>); empty = made from the shop's name */
  slug: z.string().trim().toLowerCase().max(40).optional(),
  name: z.string().trim().min(2, 'Votre nom est trop court').max(80),
  email: z.string().trim().toLowerCase().email('Email invalide').max(200),
  phone: z.string().trim().max(30).optional(),
  password: z.string().min(10, 'Mot de passe : 10 caractères au moins').max(200),
});
export type SignupInput = z.infer<typeof SignupInput>;

export class SignupError extends Error {}

/** Is this name free for a new shop's links? What would be used instead. */
export async function slugAvailability(t: Tenancy, wanted: string): Promise<{ slug: string; available: boolean; valid: boolean; suggestion: string }> {
  const slug = wanted.trim().toLowerCase();
  const valid = slugOk(slug);
  const taken = valid ? (await t.platform.query('SELECT 1 FROM platform.shops WHERE slug = $1', [slug])).length > 0 : false;
  return { slug, valid, available: valid && !taken, suggestion: await freeSlug(t, slug || 'boutique') };
}

/**
 * A shop made by its owner: on the trial plan, for the trial days of the platform's settings. Refused when sign-ups are
 * closed, when this address made too many today, or this e-mail already has the maximum of shops. Returns the shop
 * and the secret of the link that confirms the e-mail (sent by the server when it can send e-mails).
 */
export async function signupShop(t: Tenancy, i: SignupInput, o: { ip?: string | null; now?: number; fromShopId?: number } = {}): Promise<{ shop: Shop; confirm: string }> {
  const now = o.now ?? Date.now();
  const set = await platformSettings(t);
  if (!set.signup.open) throw new SignupError('Les inscriptions sont fermées pour le moment. Contactez Pilotix.');
  // a person already in the app adding a shop is not a robot: only the e-mail's limit counts
  if (o.ip && !o.fromShopId) {
    const n = num((await t.platform.query(`SELECT count(*)::int AS n FROM platform.signups WHERE ip = $1 AND at > $2::timestamptz`, [o.ip, new Date(now - DAY).toISOString()]))[0]?.n);
    if (n >= Math.max(1, set.signup.perIpPerDay)) throw new SignupError('Trop d’inscriptions depuis cette connexion aujourd’hui. Réessayez demain ou contactez Pilotix.');
  }
  const owned = num((await t.platform.query(`SELECT count(*)::int AS n FROM platform.shops WHERE lower(owner_email) = $1 AND status <> 'archived' AND NOT is_demo`, [i.email]))[0]?.n);
  if (owned >= Math.max(1, set.signup.maxShopsPerEmail)) throw new SignupError(`Vous avez déjà ${owned} boutiques : c’est le maximum. Contactez Pilotix pour en ajouter.`);
  let slug: string | undefined;
  if (i.slug) {
    if (!SLUG_RE.test(i.slug) || !slugOk(i.slug)) throw new SignupError('Nom dans les liens invalide : 2 à 40 lettres minuscules, chiffres et tirets (ex. ma-boutique)');
    if ((await t.platform.query('SELECT 1 FROM platform.shops WHERE slug = $1', [i.slug])).length) throw new SignupError('Ce nom est déjà pris par une autre boutique');
    slug = i.slug;
  }
  const plan = (await loadPlans(t)).find((p) => p.code === set.trial.planCode && p.active && !p.system) ?? null;
  let shop: Shop;
  try {
    shop = await provisionShop(t, {
      name: i.shopName,
      slug,
      planId: plan?.id ?? null,
      trialDays: Math.max(1, set.trial.days),
      owner: { name: i.name, email: i.email, phone: i.phone || null },
      password: i.password,
      notes: o.fromShopId ? `Ajoutée depuis la boutique n° ${o.fromShopId}` : 'Inscription en ligne',
      selfSignup: true,
      signupIp: o.ip ?? null,
      now,
    });
  } catch (e: any) {
    if (e?.message === 'SLUG_TAKEN' || String(e?.code) === '23505') throw new SignupError('Ce nom est déjà pris par une autre boutique');
    if (e?.message === 'BAD_SLUG') throw new SignupError('Nom dans les liens invalide');
    throw e;
  }
  await t.platform.query('INSERT INTO platform.signups (ip, email, shop_id) VALUES ($1, $2, $3)', [o.ip ?? null, i.email, shop.id]);
  await t.platform.query(`INSERT INTO platform.audit (shop_id, action, details) VALUES ($1, 'shop.signup', $2)`, [shop.id, JSON.stringify({ email: i.email, from: o.fromShopId ?? null })]);
  return { shop, confirm: await emailCheck(t, shop.id, i.email, now) };
}

/** A link (7 days) that confirms a shop owner's e-mail; returns its secret. */
export async function emailCheck(t: Tenancy, shopId: number, email: string, now = Date.now()): Promise<string> {
  const token = randomToken();
  await t.platform.query('INSERT INTO platform.email_checks (token_hash, shop_id, email, expires_at) VALUES ($1, $2, $3, $4::timestamptz)', [
    await sha256(token),
    shopId,
    email.trim().toLowerCase(),
    new Date(now + 7 * DAY).toISOString(),
  ]);
  return token;
}

/** The owner opened the link: the shop's e-mail is confirmed. */
export async function confirmEmail(t: Tenancy, token: string, now = Date.now()): Promise<Shop> {
  const r = (await t.platform.query('SELECT * FROM platform.email_checks WHERE token_hash = $1', [await sha256(String(token))]))[0];
  if (!r || r.used_at || Date.parse(r.expires_at) < now) throw new SignupError('Ce lien n’est plus valable. Demandez un nouveau lien depuis l’application.');
  await t.platform.query('UPDATE platform.email_checks SET used_at = $2::timestamptz WHERE token_hash = $1', [r.token_hash, new Date(now).toISOString()]);
  await t.platform.query('UPDATE platform.shops SET email_verified_at = $2::timestamptz WHERE id = $1 AND lower(owner_email) = $3', [r.shop_id, new Date(now).toISOString(), r.email]);
  return (await loadShop(t, { id: num(r.shop_id) }))!;
}

// ---------------------------------------------------------------- a shop's own domain name
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://www.MyShop.com/" → "www.myshop.com" (null = not a domain name). */
export function cleanDomain(input: string): string | null {
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  return HOST_RE.test(d) ? d : null;
}

/**
 * Sets (or removes: null) the shop's own domain for its landing pages. Never the platform's own address nor one of its
 * sub-domains, never another shop's. It is pending until its DNS points to this server (checkShopDomain).
 */
export async function setShopDomain(t: Tenancy, shopId: number, input: string | null, platformHost: string): Promise<Shop> {
  if (input === null || !input.trim()) {
    await t.platform.query(`UPDATE platform.shops SET domain = NULL, domain_status = 'none', domain_checked_at = NULL WHERE id = $1`, [shopId]);
    return (await loadShop(t, { id: shopId }))!;
  }
  const d = cleanDomain(input);
  if (!d) throw new SignupError('Nom de domaine invalide (ex. www.ma-boutique.com)');
  const host = platformHost.toLowerCase().replace(/^www\./, '');
  if (host && (d === host || d.endsWith(`.${host}`))) throw new SignupError('Ce domaine appartient à Pilotix : choisissez le vôtre');
  if ((await t.platform.query('SELECT 1 FROM platform.shops WHERE domain = $1 AND id <> $2', [d, shopId])).length) throw new SignupError('Ce domaine est déjà utilisé par une autre boutique');
  await t.platform.query(`UPDATE platform.shops SET domain = $2, domain_status = CASE WHEN domain = $2 THEN domain_status ELSE 'pending' END, domain_checked_at = NULL WHERE id = $1`, [shopId, d]);
  return (await loadShop(t, { id: shopId }))!;
}

/**
 * Does the shop's domain point to this server? `resolve` gives a name's IPv4 addresses (the server's DNS). The domain
 * is ready when every address of it is one of the platform's addresses.
 */
export async function checkShopDomain(t: Tenancy, shopId: number, platformHost: string, resolve: (host: string) => Promise<string[]>): Promise<{ ok: boolean; found: string[]; expected: string[] }> {
  const s = await loadShop(t, { id: shopId });
  if (!s?.domain) return { ok: false, found: [], expected: [] };
  const [found, expected] = await Promise.all([resolve(s.domain).catch(() => [] as string[]), resolve(platformHost).catch(() => [] as string[])]);
  const ok = found.length > 0 && expected.length > 0 && found.every((a) => expected.includes(a));
  await t.platform.query(`UPDATE platform.shops SET domain_status = $2, domain_checked_at = now() WHERE id = $1`, [shopId, ok ? 'ok' : 'pending']);
  return { ok, found, expected };
}

/** The active shop that uses this domain (ready), or null. */
export async function shopIdByDomain(t: Tenancy, host: string): Promise<number | null> {
  const d = cleanDomain(host.replace(/:\d+$/, ''));
  if (!d) return null;
  const r = (await t.platform.query(`SELECT id FROM platform.shops WHERE domain = $1 AND domain_status = 'ok' AND status = 'active'`, [d]))[0];
  return r ? num(r.id) : null;
}
