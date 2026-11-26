// Who took an alert (the owner, 26 Nov 2026): an alert someone moved to « En cours » — a person acted on it — is the
// only one that goes to Suivi › Résolu when the company delivers it (« Sauvé par »), and the only one whose suivi pay
// is paid (to the person who took it). An alert nobody touched, then delivered, is a plain « Livré »: no Résolu, no
// suivi pay, and « ignorée » in the agent's score when its first-call deadline passed before the delivery.

/** Someone acted on an alert (the clock of an alert stops: alertClocks): a call, a note, a treatment, a status, an
 *  edit — not a chat message, not a bot's or a company's line. */
export const ACTED_KINDS_SQL = `('call', 'note', 'sub_status', 'suivi_motif', 'suivi_stuck', 'follow_status', 'edit')`;

/** the parcel's first alert */
const firstAlert = (o: string) => `(SELECT min(a.at) FROM order_events a WHERE a.order_id = ${o}.id AND a.kind = 'follow_status' AND a.to_value = 'alert')`;
/** its delivery after that alert (none yet: now) */
const deliveredAfter = (o: string) =>
  `coalesce((SELECT min(d.at) FROM order_events d WHERE d.order_id = ${o}.id AND d.kind = 'follow_status' AND d.to_value = 'delivered' AND d.at > ${firstAlert(o)}), now())`;
/** the people's actions on the alert, from its first alert to its delivery */
const actions = (o: string) => `FROM order_events w
   WHERE w.order_id = ${o}.id AND w.user_id IS NOT NULL AND w.kind IN ${ACTED_KINDS_SQL}
     AND NOT (w.kind = 'follow_status' AND w.to_value = 'delivered')
     AND w.at > ${firstAlert(o)} AND w.at <= ${deliveredAfter(o)}`;

/** the parcel was an alert at least once */
export const hadAlertSql = (o: string) => `EXISTS (SELECT 1 FROM order_events a WHERE a.order_id = ${o}.id AND a.kind = 'follow_status' AND a.to_value = 'alert')`;
/** someone took its alert (moved it to « En cours ») before the delivery */
export const alertTouchedSql = (o: string) => `EXISTS (SELECT 1 ${actions(o)})`;
/** who took it: the first person who acted on it (null: nobody) */
export const alertTakerSql = (o: string) => `(SELECT w.user_id ${actions(o)} ORDER BY w.at, w.id LIMIT 1)`;
/** when its first alert came */
export const firstAlertSql = firstAlert;
