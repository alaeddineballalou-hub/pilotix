import type { Db } from '../db';
import { num } from '../db';
import { getSetting } from '../settings';
import { DEFAULT_TEXTS, kindFor, NOTIFY_KINDS, NotifyKind, orderVars, render, sendTime, simulatedHasWhatsApp, stillFits } from '../modules/notify';

const iso = (t: number) => new Date(t).toISOString();

/**
 * Delivery AI agent demo: the agent is on (WhatsApp texts approved by Meta, SMS through the gateway; sending is simulated),
 * with the messages of the last 3 days for the orders that moved: received, confirmed, shipped, with the livreur, at the
 * desk, failed attempt, cancelled by the livreur. Numbers ending in 3 or 7 have no WhatsApp: they got an SMS. Messages that
 * waited for the night and were overtaken by a newer step were skipped. A few customers answered (WhatsApp and SMS), and
 * two parcels were saved: a failed attempt, the customer answered, delivered the next day.
 */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const settings = {
    enabled: true,
    lang: 'dz',
    whatsapp: true,
    sms: 'gateway',
    smsProvider: 'android',
    smsUrl: 'https://api.sms-gate.app',
    smsUser: 'demo',
    wabaId: '102938475610293',
    hookKey: 'sms-demo-key',
    templates: Object.fromEntries(NOTIFY_KINDS.map((k) => [`${k}_dz`, { name: `pilotix_${k}_dz`, text: DEFAULT_TEXTS[k].dz, status: 'APPROVED', version: 1 }])),
  };
  await db.query(`INSERT INTO settings (key, value) VALUES ('notify', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(settings)]);
  const quiet = { quietFrom: 22, quietTo: 8 };
  const on: Record<NotifyKind, boolean> = { created: true, confirmed: true, shipped: true, out_for_delivery: true, stopdesk: true, failed: true, returning: true, delivered: false };
  const since = now - 3 * 86_400_000;
  const shop = (await getSetting(db, 'shop')).name;

  // the steps of each order in the last 3 days (creation, confirmation, delivery statuses)
  const orders = await db.query(
    `SELECT o.id, o.phone, o.conf_status, o.follow_status, o.is_stopdesk, o.created_at, o.conversation_id, v.channel AS conv_channel
     FROM orders o LEFT JOIN conversations v ON v.id = o.conversation_id
     WHERE NOT o.is_exchange AND o.ref NOT LIKE 'PX9000%' AND (o.created_at > $1 OR o.updated_at > $1)`,
    [iso(since)],
  );
  const events = await db.query(
    `SELECT order_id, at, kind, to_value FROM order_events WHERE at > $1 AND kind IN ('conf_status','follow_status') ORDER BY order_id, at, id`,
    [iso(since)],
  );
  const byOrder = new Map<number, { at: number; kind: string; to: string }[]>();
  for (const e of events) {
    const k = num(e.order_id);
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k)!.push({ at: Date.parse(new Date(e.at).toISOString()), kind: e.kind, to: e.to_value });
  }

  type Row = { order: number; kind: NotifyKind; status: string; channel: string | null; phone: string; body: string; waId: string | null; waStatus: string | null; smsId: string | null; smsStatus: string | null; error: string | null; at: number; sendAfter: number; sentAt: number | null; deliveredAt: number | null; readAt: number | null };
  const rows: Row[] = [];
  const history: unknown[][] = [];
  for (const o of orders) {
    const oid = num(o.id);
    const steps: { kind: NotifyKind; at: number }[] = [];
    const created = Date.parse(new Date(o.created_at).toISOString());
    if (created > since) steps.push({ kind: 'created', at: created });
    for (const e of byOrder.get(oid) ?? []) {
      if (e.kind === 'conf_status' && e.to === 'confirmed') steps.push({ kind: 'confirmed', at: e.at });
      if (e.kind === 'follow_status') {
        const k = kindFor(o, e.to);
        if (k) steps.push({ kind: k, at: e.at });
      }
    }
    if (!steps.length) continue;
    const ov = await orderVars(db, oid, 'dz', shop);
    if (!ov) continue;
    const body = (k: NotifyKind) => render(DEFAULT_TEXTS[k].dz, ov.vars);
    const wa = simulatedHasWhatsApp(String(o.phone));
    steps.forEach((st, i) => {
      if (!on[st.kind]) return;
      const due = sendTime(st.at + 60_000, quiet);
      const next = steps[i + 1];
      const base = { order: oid, kind: st.kind, phone: String(o.phone), body: body(st.kind), at: st.at, sendAfter: due, waId: null, waStatus: null, smsId: null, smsStatus: null, deliveredAt: null, readAt: null };
      // taken by Message AI agent in the customer's WhatsApp chat: no "received / confirmed" message
      if ((st.kind === 'created' || st.kind === 'confirmed') && o.conv_channel === 'whatsapp')
        return void rows.push({ ...base, status: 'skipped', channel: null, error: 'Commande prise dans la conversation WhatsApp : le client a déjà la réponse', sentAt: null });
      // still waiting for the morning when the next step came: replaced by the newer message
      if (next && next.at < due) return void rows.push({ ...base, status: 'skipped', channel: null, error: 'Remplacé par un message plus récent', sentAt: null });
      if (due > now) {
        // waiting for the end of the night (only if it still fits the order)
        if (stillFits(st.kind, o)) rows.push({ ...base, status: 'queued', channel: null, error: null, sentAt: null });
        return;
      }
      const sent = due + 20_000;
      if (wa) {
        const read = (oid + i) % 10 < 7;
        rows.push({ ...base, status: 'whatsapp', channel: 'whatsapp', waId: `wamid.demo.${oid}.${i}`, waStatus: read ? 'read' : 'delivered', error: null, sentAt: sent, deliveredAt: sent + 30_000, readAt: read ? sent + (5 + ((oid * 7) % 90)) * 60_000 : null });
      } else rows.push({ ...base, status: 'sms', channel: 'sms', smsId: `sms-demo-${oid}-${i}`, smsStatus: 'delivered', error: 'Pas de WhatsApp sur ce numéro', sentAt: sent, deliveredAt: sent + 15_000 });
      history.push([oid, iso(sent), wa ? 'whatsapp' : 'sms', st.kind, base.body]);
    });
  }

  // two SMS the gateway phone could not send (it was offline): to see the "Problèmes" tab
  const offline = rows.filter((x, i, a) => x.status === 'sms' && a.findIndex((y) => y.status === 'sms' && y.order === x.order) === i).slice(-2);
  for (const r of offline) {
    r.status = 'failed';
    r.smsStatus = 'failed';
    r.deliveredAt = null;
    r.error = 'SMS : le téléphone d’envoi est hors ligne';
    const h = history.findIndex((x) => x[0] === r.order && x[3] === r.kind);
    if (h >= 0) history.splice(h, 1);
  }

  // answers: a failed attempt answered on WhatsApp (handed to the team to send again), a "merci" after shipping,
  // a cancellation answered by SMS
  const replies: { row: Row; text: string; via: 'whatsapp' | 'sms'; after: number; saved?: boolean }[] = [];
  // answered a while ago (never in the future): the message was sent at least 2 hours before now
  const pickRow = (kind: NotifyKind, status: string, skip: Set<number>) => rows.find((r) => r.kind === kind && r.status === status && !skip.has(r.order) && r.sentAt && r.sentAt < now - 2 * 3_600_000);
  const used = new Set<number>();
  // phones that already have a WhatsApp conversation (Message AI agent demo) are left alone
  for (const c of await db.query(`SELECT phone FROM conversations WHERE phone IS NOT NULL`)) for (const r of rows) if (r.phone === c.phone) used.add(r.order);
  const failedWa = pickRow('failed', 'whatsapp', used);
  if (failedWa) {
    used.add(failedWa.order);
    replies.push({ row: failedWa, text: 'Wah mazal nhabha, ab3athouha ghodwa svp', via: 'whatsapp', after: 25 * 60_000 });
  }
  const shippedWa = pickRow('shipped', 'whatsapp', used);
  if (shippedWa) {
    used.add(shippedWa.order);
    replies.push({ row: shippedWa, text: 'Merci bien 🙏', via: 'whatsapp', after: 12 * 60_000 });
  }
  const returningSms = pickRow('returning', 'sms', used) ?? pickRow('failed', 'sms', used);
  if (returningSms) {
    used.add(returningSms.order);
    replies.push({ row: returningSms, text: 'Oui je la veux toujours, appelez-moi svp', via: 'sms', after: 40 * 60_000 });
  }

  // saved parcels: a failed attempt yesterday, the customer answered, delivered today
  const delivered = await db.query(
    `SELECT id, phone, delivered_at FROM orders WHERE follow_status = 'delivered' AND delivered_at > $1 AND delivered_at < $2 AND NOT is_exchange AND ref NOT LIKE 'PX9000%' ORDER BY delivered_at DESC LIMIT 6`,
    [iso(now - 2 * 86_400_000), iso(now - 2 * 3_600_000)],
  );
  let saved = 0;
  for (const d of delivered) {
    if (saved >= 2 || used.has(num(d.id))) continue;
    const ov = await orderVars(db, num(d.id), 'dz', shop);
    if (!ov) continue;
    const t = sendTime(Date.parse(new Date(d.delivered_at).toISOString()) - 22 * 3_600_000, quiet);
    const wa = simulatedHasWhatsApp(String(d.phone));
    const row: Row = {
      order: num(d.id), kind: 'failed', status: wa ? 'whatsapp' : 'sms', channel: wa ? 'whatsapp' : 'sms', phone: String(d.phone), body: render(DEFAULT_TEXTS.failed.dz, ov.vars),
      waId: wa ? `wamid.demo.saved.${d.id}` : null, waStatus: wa ? 'read' : null, smsId: wa ? null : `sms-demo-saved-${d.id}`, smsStatus: wa ? null : 'delivered',
      error: wa ? null : 'Pas de WhatsApp sur ce numéro', at: t - 60_000, sendAfter: t, sentAt: t, deliveredAt: t + 30_000, readAt: wa ? t + 20 * 60_000 : null,
    };
    rows.push(row);
    history.push([row.order, iso(t), row.channel, 'failed', row.body]);
    await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,'follow_status','out_for_delivery','failed','Client absent')`, [row.order, iso(t - 60_000), users.suivi ?? null]);
    replies.push({ row, text: saved ? 'Pardon, j’étais au travail. Demain je suis à la maison' : 'Ghodwa nkoun f dar, ab3athouli le livreur', via: wa ? 'whatsapp' : 'sms', after: 35 * 60_000, saved: true });
    used.add(row.order);
    saved++;
  }

  // write the messages (in the order they happened) and the order histories, 200 rows per query
  rows.sort((a, b) => a.at - b.at);
  const ids = new Map<Row, number>();
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params: unknown[] = [];
    const values = chunk.map((r) => {
      const reply = replies.find((x) => x.row === r);
      const v = [r.order, r.kind, r.status, r.channel, r.phone, r.body, r.waId, r.waStatus, r.smsId, r.smsStatus, r.error, r.status === 'failed' ? 3 : 0, iso(r.sendAfter), r.sentAt ? iso(r.sentAt) : null,
        r.deliveredAt ? iso(r.deliveredAt) : null, r.readAt ? iso(r.readAt) : null, reply && r.sentAt ? iso(r.sentAt + reply.after) : null, reply?.text ?? null, iso(r.at)];
      const base = params.length;
      params.push(...v);
      return `(${v.map((_, k) => `$${base + k + 1}`).join(',')})`;
    });
    const out = await db.query(
      `INSERT INTO notifications (order_id, kind, status, channel, phone, body, wa_id, wa_status, sms_id, sms_status, error, attempts, send_after, sent_at, delivered_at, read_at, replied_at, reply, created_at)
       VALUES ${values.join(',')} RETURNING id`,
      params,
    );
    chunk.forEach((r, k) => ids.set(r, num(out[k].id)));
  }
  for (let i = 0; i < history.length; i += 200) {
    const chunk = history.slice(i, i + 200);
    const params: unknown[] = [];
    const values = chunk.map((h) => {
      const base = params.length;
      params.push(...h);
      return `($${base + 1},$${base + 2},NULL,'chat',$${base + 3},$${base + 4},$${base + 5})`;
    });
    await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ${values.join(',')}`, params);
  }

  // the answers: in the order's history, and the WhatsApp ones in Message AI agent with the message before them
  for (const rp of replies) {
    const r = rp.row;
    if (!r.sentAt) continue;
    const at = r.sentAt + rp.after;
    await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1,$2,NULL,'chat',$3,'reply',$4)`, [r.order, iso(at), rp.via, rp.text]);
    if (rp.via !== 'whatsapp') continue;
    const o = (await db.query(`SELECT ref, customer_name FROM orders WHERE id = $1`, [r.order]))[0];
    const first = String(o.customer_name ?? '').split(' ')[0] || '';
    const resend = r.kind === 'failed';
    // a saved parcel: the team already sent it again (and it was delivered); otherwise it waits for a person
    const handled = !!rp.saved;
    const answer = resend
      ? `Saha ${first} 🙏 Nkhabbar l'équipe bach y3awdou yab3atouhalkom, w le livreur y3ayetlkom 9bel ma yji. Khalliw le téléphone ma7loul.`
      : `Bla mziya ${first}, saha 🙏 Ida 3andkom ay sou2al 3la la commande, ana hna.`;
    const conv = await db.query(
      `INSERT INTO conversations (channel, external_id, customer_name, phone, customer_id, mode, handoff_reason, last_message_at, last_customer_at, last_preview, unread, created_at)
       VALUES ('whatsapp',$1,$2,$3,(SELECT id FROM customers WHERE phone = $3),$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (channel, external_id) DO NOTHING RETURNING id`,
      ['213' + r.phone.slice(1), o.customer_name, r.phone, resend ? (handled ? 'human' : 'handoff') : 'ai', resend && !handled ? `Renvoyer ${o.ref} : le client la veut toujours` : null, iso(at + (handled ? 600_000 : 40_000)), iso(at), (handled ? 'C’est noté, le livreur repasse demain.' : answer).slice(0, 140), resend && !handled ? 1 : 0, iso(at)],
    );
    if (!conv[0]) continue;
    const cid = num(conv[0].id);
    const msg = (role: string, body: string, t: number, meta: unknown = null) =>
      db.query('INSERT INTO conv_messages (conversation_id, role, body, meta, created_at) VALUES ($1,$2,$3,$4,$5)', [cid, role, body, meta === null ? null : JSON.stringify(meta), iso(t)]);
    await msg('agent', r.body, r.sentAt, { notify: r.kind, notifyId: ids.get(r), ref: o.ref, via: 'whatsapp' });
    await msg('customer', rp.text, at);
    if (resend) await msg('tool', `handoff → Renvoyer ${o.ref} : le client la veut toujours`, at + 30_000, { tool: 'handoff', input: { reason: `Renvoyer ${o.ref} : le client la veut toujours` }, result: { ok: true } });
    await msg('agent', answer, at + 40_000, { demo: true });
    if (handled) {
      await db.query(`UPDATE conversations SET assigned_to = $2 WHERE id = $1`, [cid, users.suivi ?? null]);
      await db.query('INSERT INTO conv_messages (conversation_id, role, body, user_id, created_at) VALUES ($1,$2,$3,$4,$5)', [cid, 'staff', 'C’est noté, le livreur repasse demain.', users.suivi ?? null, iso(at + 600_000)]);
    }
  }
}
