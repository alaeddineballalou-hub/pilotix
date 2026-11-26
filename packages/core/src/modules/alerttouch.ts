// Who saved an alert (the owner, 26 Nov 2026): an alert a suivi agent sent back on the road with « Relivrer » (he
// reached the customer, the company was asked to deliver again), then delivered by the company, is the only one that
// goes to Suivi › Résolu (« Sauvé par ») and the only one whose suivi pay is paid — to the person who pressed
// « Relivrer ». An alert only worked on (« En cours »: a call, a call back, a réclamation) and then delivered is a plain
// « Livré » (« if it stayed En cours then delivered, he did not solve it »): no Résolu, no suivi pay. An alert nobody
// touched is a plain « Livré » too, and « ignorée » in the agent's score when its first-call deadline passed before it
// ended.

/** Someone acted on an alert (the clock of an alert stops: alertClocks): a call, a note, a treatment, a status, an
 *  edit — not a chat message, not a bot's or a company's line. */
export const ACTED_KINDS_SQL = `('call', 'note', 'sub_status', 'suivi_motif', 'suivi_stuck', 'follow_status', 'edit')`;

/** a line a person wrote in Pilotix, not the company's news (a sync runs under whoever pressed « Synchroniser », so its
 *  status lines carry a person too: they say « courier ») */
const byPerson = (w: string) => `${w}.user_id IS NOT NULL AND coalesce(${w}.data->>'courier', '') <> 'true'`;

/** the parcel's first alert */
const firstAlert = (o: string) => `(SELECT min(a.at) FROM order_events a WHERE a.order_id = ${o}.id AND a.kind = 'follow_status' AND a.to_value = 'alert')`;
/** its delivery after that alert (none yet: now) */
const deliveredAfter = (o: string) =>
  `coalesce((SELECT min(d.at) FROM order_events d WHERE d.order_id = ${o}.id AND d.kind = 'follow_status' AND d.to_value = 'delivered' AND d.at > ${firstAlert(o)}), now())`;
/** the people's actions on the alert, from its first alert to its delivery */
const actions = (o: string) => `FROM order_events w
   WHERE w.order_id = ${o}.id AND ${byPerson('w')} AND w.kind IN ${ACTED_KINDS_SQL}
     AND NOT (w.kind = 'follow_status' AND w.to_value = 'delivered')
     AND w.at > ${firstAlert(o)} AND w.at <= ${deliveredAfter(o)}`;

/** its delivery (the last one; none yet: now) */
const deliveredAt = (o: string) => `coalesce((SELECT max(d.at) FROM order_events d WHERE d.order_id = ${o}.id AND d.kind = 'follow_status' AND d.to_value = 'delivered'), now())`;
/** its last alert before that delivery */
const lastAlert = (o: string) =>
  `(SELECT max(a.at) FROM order_events a WHERE a.order_id = ${o}.id AND a.kind = 'follow_status' AND a.to_value = 'alert' AND a.at <= ${deliveredAt(o)})`;
/** « Relivrer »: a person put its last alert back on the road (suivi.resolve « Résolu », the old « Traiter », a
 *  manager's status), before the delivery. One pressed before the alert came back (the company refused, or failed again)
 *  does not count: that alert stayed without a « Relivrer ». */
const relivres = (o: string) => `FROM order_events r
   WHERE r.order_id = ${o}.id AND r.kind = 'follow_status' AND r.from_value = 'alert' AND r.to_value IN ('shipped', 'out_for_delivery')
     AND ${byPerson('r')} AND r.at >= ${lastAlert(o)} AND r.at <= ${deliveredAt(o)}`;

/** the parcel was an alert at least once */
export const hadAlertSql = (o: string) => `EXISTS (SELECT 1 FROM order_events a WHERE a.order_id = ${o}.id AND a.kind = 'follow_status' AND a.to_value = 'alert')`;
/** someone worked on its alert (moved it to « En cours ») before the delivery: not « ignorée » */
export const alertTouchedSql = (o: string) => `EXISTS (SELECT 1 ${actions(o)})`;
/** someone sent its last alert back on the road with « Relivrer » before the delivery: Résolu, and the suivi pay */
export const relivreSql = (o: string) => `EXISTS (SELECT 1 ${relivres(o)})`;
/** who did (the last « Relivrer » before the delivery; null: nobody): « Sauvé par », the one paid */
export const relivreurSql = (o: string) => `(SELECT r.user_id ${relivres(o)} ORDER BY r.at DESC, r.id DESC LIMIT 1)`;
/** when its first alert came */
export const firstAlertSql = firstAlert;
