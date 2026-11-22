// The bell's demo (the full demo only): what Samira, Nadia, Karim and the managers were told this morning and yesterday —
// a new order, a callback whose time came, deliveries (the cash line), a return, a customer's message, an order that
// went to someone else, an alert on a parcel, the depot's orders to prepare, the slow queue. Real demo orders: a line
// opens its order. In the viewer's language (the preview passes it).
import type { Language } from '@pilotix/shared';
import type { Db } from '../db';
import { num } from '../db';
import { say } from '../modules/inbox';

const M = 60_000;
const H = 60 * M;

export async function seed(db: Db, users: Record<string, number>, now: number, lang: Language = 'fr'): Promise<void> {
  const pick = async (where: string, n: number) =>
    (await db.query(`SELECT id, ref, customer_name, total FROM orders WHERE ${where} ORDER BY id DESC LIMIT ${Math.max(1, Math.min(20, n))}`)).map((r: any) => ({
      id: num(r.id),
      ref: String(r.ref),
      name: String(r.customer_name ?? '').trim(),
      total: num(r.total),
    }));
  const money = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} DA`;
  const add = (who: number | undefined, kind: string, ago: number, title: string, body: string, o: { order?: number | null; url?: string; important?: boolean; read?: boolean; tag?: string; n?: number } = {}) =>
    who
      ? db.query(
          `INSERT INTO inbox (profile_id, kind, tag, title, body, url, order_id, important, n, created_at, read_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz, CASE WHEN $11 THEN $10::timestamptz + interval '2 minutes' END)`,
          [who, kind, o.tag ?? null, title, body, o.url ?? null, o.order ?? null, !!o.important, o.n ?? 1, new Date(now - ago).toISOString(), !!o.read],
        )
      : null;

  const S = users.conf1;
  const toCall = await pick(`agent_id = ${num(S)} AND conf_status IN ('new', 'callback', 'no_answer')`, 3);
  const done = await pick(`agent_id = ${num(S)} AND follow_status = 'delivered'`, 6);
  const back = await pick(`agent_id = ${num(S)} AND follow_status IN ('returning', 'returned')`, 1);
  const gone = await pick(`agent_id = ${num(users.conf2)} AND conf_status IN ('new', 'no_answer')`, 1);
  const line = (o: { ref: string; name: string; total: number }) => [o.ref, o.name, o.total ? money(o.total) : ''].filter(Boolean).join(' · ');
  // Samira (Confirmation)
  if (toCall[0]) await add(S, 'order', 1 * M, say('order1', lang), line(toCall[0]), { order: toCall[0].id, url: '#/confirmation/nouvelles', important: true });
  if (toCall[1]) await add(S, 'callback', 7 * M, say('callback', lang, { name: toCall[1].name || toCall[1].ref }), say('callbackAt', lang, { ref: toCall[1].ref, time: new Date(now - 7 * M + H).toISOString().slice(11, 16) }), { order: toCall[1].id, url: '#/confirmation/attente', important: true });
  if (done[0]) await add(S, 'delivered', 24 * M, say('delivered1', lang, { ref: done[0].ref }), [done[0].name, money(done[0].total)].join(' · '), { order: done[0].id, url: '#/commandes/tout' });
  if (toCall[2]) await add(S, 'message', 48 * M, `💬 ${toCall[2].name || toCall[2].ref}`, `${toCall[2].ref} · ${lang === 'ar' ? 'السلام، هل العربة متوفرة باللون الرمادي؟' : lang === 'en' ? 'Hello, is the stroller available in grey?' : 'Salam, la poussette existe en gris ?'}`, { order: toCall[2].id, url: '#/commandes/tout', read: true, tag: `chat-demo-${toCall[2].id}` });
  if (back[0]) await add(S, 'returned', 2 * H + 10 * M, say('returned1', lang, { ref: back[0].ref }), [back[0].name, money(back[0].total)].join(' · '), { order: back[0].id, url: '#/commandes/tout', read: true });
  if (gone[0]) await add(S, 'taken', 3 * H + 5 * M, say('taken1', lang, { ref: gone[0].ref }), say('late', lang, { who: 'Rania' }), { url: '#/confirmation/nouvelles', read: true });
  if (done.length > 4) await add(S, 'delivered', 18 * H, say('deliveredN', lang, { n: 4 }), done.slice(1, 5).map((o) => o.ref).join(', '), { url: '#/commandes/tout', read: true, n: 4 });

  // Nadia (Suivi): a failed attempt on a parcel she follows, two alerts at once yesterday
  const N = users.suivi;
  const road = await pick(`follow_status IN ('alert', 'failed', 'out_for_delivery', 'shipped')`, 3);
  if (road[0]) await add(N, 'alert', 3 * M, say('alert1', lang, { ref: road[0].ref }), [road[0].name, say('failed', lang)].join(' · '), { order: road[0].id, url: '#/suivi/alertes', important: true });
  if (road[1]) await add(N, 'alert', 40 * M, say('given', lang), line(road[1]), { order: road[1].id, url: '#/suivi/alertes', important: true });
  if (road.length > 2) await add(N, 'alert', 20 * H, say('alertN', lang, { n: 2 }), road.slice(1, 3).map((o) => o.ref).join(', '), { url: '#/suivi/alertes', read: true, important: true, n: 2 });

  // Karim (Dépôt): the orders to prepare, grouped
  const K = users.depot;
  const prep = num((await db.query(`SELECT count(*) AS n FROM orders WHERE follow_status = 'to_prepare' AND conf_status = 'confirmed' AND shipped_at IS NULL`))[0]?.n);
  if (prep) {
    await add(K, 'depot', 9 * M, say('depotN', lang, { n: Math.min(6, prep) }), say('depotAll', lang, { total: prep }), { url: '#/depot/preparer', tag: 'depot-prepare', n: Math.min(6, prep) });
    await add(K, 'depot', 2 * H, say('depotN', lang, { n: 4 }), say('depotAll', lang, { total: Math.max(4, prep - 6) }), { url: '#/depot/preparer', read: true, n: 4 });
  }

  // the managers and the owner: the phone notifications they already got (Pilot Automations)
  const team = [users.admin, users.manager1].filter(Boolean);
  for (const who of team) {
    await add(who, 'info', 12 * M, lang === 'ar' ? 'طلبات تنتظر مكالمة: 5' : lang === 'en' ? '5 orders waiting for a call' : '5 commandes attendent un appel', lang === 'ar' ? 'أقدمها منذ 34 د' : lang === 'en' ? 'The oldest for 34 min' : 'La plus ancienne depuis 34 min', { url: '#/confirmation/nouvelles', tag: 'auto-wait' });
    await add(who, 'info', 15 * H, lang === 'ar' ? 'تقرير المساء' : lang === 'en' ? 'Evening report' : 'Rapport du soir', lang === 'ar' ? '42 طلبًا · 31 مؤكدًا · 18 تم توصيلها' : lang === 'en' ? '42 orders · 31 confirmed · 18 delivered' : '42 commandes · 31 confirmées · 18 livrées', { url: '#/notify/auto', read: true, tag: 'auto-evening' });
  }
}
