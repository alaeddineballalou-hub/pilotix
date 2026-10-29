// « Ma tournée »: the livreur's own hands.
//  - « Je travaille aujourd'hui »: each morning he says he works today. « À attribuer » shows who did; a manager can
//    still give orders to one who forgot (Pilotix asks once), and he gets a notification.
//  - Taking a parcel = scanning it. Only he puts parcels in his own hands (« En livraison »: its cash is his). The depot
//    scans them to « Dispatchées » first — the shared shelf, so everybody sees who took what and who forgot. A parcel
//    still « En dispatch » can be taken too: its history says the depot had not scanned it. Taking another livreur's
//    parcel makes it his, and the managers get a note.
//  - Before his scan he sees no customer (name, phones, address): only the parcel.
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { addEvent, getOrder, setFollow } from './orders';
export { hideCustomer, NOT_TAKEN } from './orders';
import { sendPush } from './push';

/** Today in Algeria (UTC+1, no summer time), as YYYY-MM-DD. */
export const algiersDay = (now: number) => new Date(now + 3_600_000).toISOString().slice(0, 10);

/** The livreurs who said « Je travaille aujourd'hui » today, and when. */
export async function checkedInToday(db: Db, now: number): Promise<Map<number, string>> {
  const rows = await db.query('SELECT profile_id, at FROM livreur_checkins WHERE day = $1', [algiersDay(now)]);
  return new Map(rows.map((r: any) => [num(r.profile_id), iso(r.at)]));
}

/** Admins and the people who assign (ticked in Utilisateurs): they hear about parcels taken by another livreur. */
async function managers(db: Db): Promise<number[]> {
  return (await db.query(`SELECT id FROM profiles WHERE active AND ('admin' = ANY(roles) OR can_assign)`)).map((r: any) => num(r.id));
}

export async function takeParcel(ctx: Ctx, raw: string) {
  const me = ctx.session.profile.id;
  const code = String(raw || '').trim().replace(/\s+/g, '');
  if (!code) throw bad('Scannez l’étiquette du colis.');
  const o = (
    await ctx.db.query(
      `SELECT o.id, o.ref, o.follow_status, o.livreur_id, c.kind, c.name AS company_name, lv.name AS livreur_name
         FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id LEFT JOIN profiles lv ON lv.id = o.livreur_id
        WHERE upper(o.ref) = upper($1) OR o.own_tracking = $1 OR o.tracking = $1
        ORDER BY o.id DESC LIMIT 1`,
      [code],
    )
  )[0];
  if (!o) throw bad('Colis introuvable : vérifiez l’étiquette.');
  if (o.kind !== 'own') throw bad(`${o.ref} part avec ${o.company_name ?? 'une société de livraison'}, pas avec nos livreurs.`);
  const status = String(o.follow_status);
  const from = o.livreur_id ? num(o.livreur_id) : null;
  if (from === me && ['out_for_delivery', 'failed', 'alert', 'in_exchange'].includes(status)) return { already: true, order: await getOrder(ctx, num(o.id)), from: null };
  if (!['prepared', 'shipped', 'out_for_delivery', 'failed', 'alert'].includes(status)) throw bad(`${o.ref} n’est pas à livrer.`);
  const oid = num(o.id);
  const myName = ctx.session.profile.name;
  await ctx.db.query('UPDATE orders SET livreur_id = $2, updated_at = now(), version = version + 1 WHERE id = $1', [oid, me]);
  if (from && from !== me) {
    await addEvent(ctx.db, oid, me, 'note', null, 'event', `Pris par ${myName} au lieu de ${o.livreur_name ?? 'un autre livreur'}`);
    await sendPush(ctx, await managers(ctx.db), {
      title: `${o.ref} : pris par ${myName}`,
      body: `Ce colis était à ${o.livreur_name ?? 'un autre livreur'}. L’argent est maintenant dû par ${myName}.`,
      tag: `taken-${oid}`,
      url: '#/depot/enlivraison',
    });
  }
  if (status === 'prepared') await addEvent(ctx.db, oid, me, 'note', null, 'event', 'Pris sans le scan « Dispatchées » du dépôt');
  if (status !== 'out_for_delivery') await setFollow(ctx, { ids: [oid], status: 'out_for_delivery' }, { system: true });
  return { already: false, order: await getOrder(ctx, oid), from: from && from !== me ? (o.livreur_name as string) : null };
}

/** A livreur was given orders (« À attribuer »): a notification on his phone. */
export async function tellLivreur(ctx: Ctx, livreurId: number, count: number) {
  await sendPush(ctx, [livreurId], {
    title: count > 1 ? `${count} nouvelles commandes pour vous` : 'Une nouvelle commande pour vous',
    body: 'Passez au dépôt et scannez-les dans « Ma tournée ».',
    tag: `assigned-${livreurId}`,
    url: '#/tournee',
  });
}

export const livreurProcs = {
  /** « Je travaille aujourd'hui ». */
  'tournee.checkIn': proc(['livreur'], z.object({}), async (ctx) => {
    const r = (
      await ctx.db.query(
        `INSERT INTO livreur_checkins (profile_id, day, at) VALUES ($1, $2, $3) ON CONFLICT (profile_id, day) DO UPDATE SET at = livreur_checkins.at RETURNING at`,
        [ctx.session.profile.id, algiersDay(ctx.now()), new Date(ctx.now()).toISOString()],
      )
    )[0];
    return { at: iso(r.at) };
  }),

  /** « Prendre un colis »: the livreur scans it — in his hands, « En livraison ». */
  'tournee.take': proc(['livreur'], z.object({ code: z.string().min(1).max(100) }), (ctx, i) => takeParcel(ctx, i.code)),
};
