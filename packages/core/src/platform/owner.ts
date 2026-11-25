// « Changer le propriétaire » (control room › Boutiques, Agences, Marketers): a shop, a confirmation agency or a
// marketer's space moves to another e-mail. That e-mail gets the account (made now when it has none: nothing is sent,
// the person enters with « Continuer avec Google » or « Mot de passe oublié »), the administrator's place in the shop
// and the shop itself. The owner before loses everything there at once: their place is closed (their sessions and
// assistant links end), their work still to do goes back to the team, and a partner's people in the stores follow.
import { num } from '../db';
import { bad } from '../rpc';
import { syncAgency } from '../modules/agencies';
import { releaseWorkIn } from '../modules/users';
import { accountByEmail, accountById, dropForeignPassword, ensureAccount, foreignPassword, NO_ACCOUNT, normEmail, ownedPartners, ownedStores, unusableHash } from './accounts';
import { keepSellerBilling, mainShopOf, type Shop } from './shops';
import type { Tenancy } from './tenancy';

export interface NewOwner {
  email: string;
  /** empty: the name of the person's account, or of their place in the shop */
  name?: string | null;
  /** the owner's phone shown to Pilotix's team (empty: none) */
  phone?: string | null;
}

export interface OwnerMoved {
  from: string | null;
  to: string;
  name: string;
  /** the account was made now (it had none) */
  created: boolean;
  /** the person already worked in the shop: their place became the administrator's */
  promoted: boolean;
  /** a password someone else may know (a store's admin chose it) was taken off the account */
  passwordDropped: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function moveOwner(t: Tenancy, s: Shop, n: NewOwner): Promise<OwnerMoved> {
  const email = normEmail(n.email);
  if (!EMAIL.test(email) || email.length > 200 || NO_ACCOUNT.test(email)) throw bad('E-mail invalide');
  if (s.status === 'deleted') throw bad('Boutique supprimée par son propriétaire');
  if (s.primary) throw bad('Votre propre boutique garde son propriétaire');
  if (s.demo) throw bad('La boutique de démonstration n’a pas de propriétaire à changer');
  const old = s.ownerAccountId ? await accountById(t, s.ownerAccountId) : null;
  const oldEmail = old?.email ?? (s.ownerEmail ? normEmail(s.ownerEmail) : null);
  if (oldEmail === email) throw bad('C’est déjà l’e-mail du propriétaire');
  const known = await accountByEmail(t, email);
  // one confirmation agency and one marketer space per person; a store never joins someone's own subscription
  if (known && s.kind !== 'store' && (await ownedPartners(t, known.id, s.kind)) > 0)
    throw bad(s.kind === 'agency' ? 'Cet e-mail a déjà son agence de confirmation (une seule par personne)' : 'Cet e-mail a déjà son espace marketer (un seul par personne)');
  if (known && s.kind === 'store' && (await ownedStores(t, known.id)) > 0) throw bad('Cet e-mail a déjà ses boutiques et leur abonnement : choisissez un e-mail sans boutique');
  const db = t.shop(s.schema);
  const here = (await db.query('SELECT id, name, roles, agency_id FROM profiles WHERE lower(email) = $1', [email]))[0];
  if (here && here.agency_id !== null && here.agency_id !== undefined) throw bad('Cet e-mail travaille ici pour une agence ou un marketer : il ne peut pas en devenir le propriétaire');
  const was = oldEmail ? (await db.query('SELECT id, active FROM profiles WHERE lower(email) = $1', [oldEmail]))[0] : null;
  if (was?.active) {
    // money in the old owner's own caisse would leave every caisse screen (the same rule as closing a team member)
    const left = num(
      (
        await db.query(
          `SELECT COALESCE((SELECT sum(net) FROM cash_handovers WHERE cancelled_at IS NULL AND received_into = $1), 0) + COALESCE((SELECT sum(amount) FROM cash_moves WHERE cancelled_at IS NULL AND caisse = $1), 0) AS v`,
          [`u${was.id}`],
        )
      )[0]?.v,
    );
    if (left !== 0) throw bad(`Il reste ${left} DA dans la caisse de l’ancien propriétaire : ils doivent d’abord aller dans une autre caisse (Caisse › Transférer)`);
  }
  const name = (n.name ?? '').trim().slice(0, 80) || known?.name || (here?.name as string | undefined) || email.split('@')[0];
  // the account: made now when it has none (no password, nothing sent)
  let acc = known ?? (await ensureAccount(t, { email, name, passwordHash: null })).account;
  const created = !known;
  // a password someone else may know (the old owner may have chosen it) never opens the shop it now owns
  const passwordDropped = foreignPassword(acc);
  if (passwordDropped) acc = (await dropForeignPassword(t, acc.id)) ?? acc;
  const own = ((await t.platform.query('SELECT password_hash FROM platform.accounts WHERE id = $1', [acc.id]))[0]?.password_hash as string | null) ?? null;
  const hash = own ?? unusableHash();
  // the seller's first boutique (it holds the plan) before the move
  const mainBefore = s.kind === 'store' && s.ownerAccountId ? await mainShopOf(t, s.ownerAccountId) : null;
  await db.tx(async (tx) => {
    if (here)
      await tx.query(
        `UPDATE profiles SET roles = CASE WHEN 'admin' = ANY(roles) THEN roles ELSE array_append(roles, 'admin') END, name = COALESCE($3, name),
           active = true, archived_at = NULL, can_manage_users = false, can_assign = false, can_affect = false, password_hash = $2 WHERE id = $1`,
        [here.id, hash, (n.name ?? '').trim() ? name : null],
      );
    else await tx.query(`INSERT INTO profiles (name, email, password_hash, roles, language) VALUES ($1, $2, $3, '{admin}', $4)`, [name, email, hash, acc.language === 'en' || acc.language === 'ar' ? acc.language : 'fr']);
    if (was?.active) {
      // closed now: every session of theirs and their assistant links end; their orders still to do go back to the team
      await tx.query('UPDATE profiles SET active = false, token_version = token_version + 1 WHERE id = $1', [was.id]);
      // (whatever their roles: an administrator may hold orders too, and nobody else would see them)
      await releaseWorkIn(tx, null, num(was.id), false, [], ['confirmation', 'suivi']);
    }
  });
  // a store that followed its seller's first boutique keeps the plan, the period and the limits it had
  const follower = s.kind === 'store' && !!s.mainShopId;
  await t.platform.query(
    `UPDATE platform.shops SET owner_account_id = $2, owner_email = $3, owner_name = $4, owner_phone = $5,
       plan_id = CASE WHEN $6 THEN $7 ELSE plan_id END, trial_ends_at = CASE WHEN $6 THEN $8::timestamptz ELSE trial_ends_at END,
       paid_until = CASE WHEN $6 THEN $9::timestamptz ELSE paid_until END, never_expires = CASE WHEN $6 THEN $10 ELSE never_expires END,
       max_users = CASE WHEN $6 THEN $11 ELSE max_users END, max_drivers = CASE WHEN $6 THEN $12 ELSE max_drivers END
     WHERE id = $1`,
    [s.id, acc.id, email, name, (n.phone ?? '').trim().slice(0, 30) || null, follower, s.planId, s.trialEndsAt, s.paidUntil, s.neverExpires, s.maxUsers, s.maxDrivers],
  );
  if (old) {
    // the team's passwords the old owner's admins chose open the shop as before (they open the new owner's shops now)
    const team = (await db.query(`SELECT lower(email) AS e FROM profiles WHERE agency_id IS NULL AND email NOT LIKE '%@pilotix.invalid'`)).map((r: any) => String(r.e));
    await t.platform.query(`UPDATE platform.accounts SET password_owner = $2 WHERE password_by = 'admin' AND password_owner = $1 AND email = ANY($3::text[]) AND id <> $2`, [old.id, acc.id, team]);
  }
  // the old owner's other boutiques: the next one takes the plan when this one held it
  if (s.kind === 'store') await keepSellerBilling(t, s.ownerAccountId, mainBefore);
  // a partner's people in the stores it works for: the new chief gets in, the old one is closed there too
  else await syncAgency(t, s.id);
  return { from: oldEmail, to: email, name, created, promoted: !!here, passwordDropped };
}
