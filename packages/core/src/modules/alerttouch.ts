// Who saved an alert (the owner, 26 Nov 2026): an alert a suivi agent sent back on the road with « Relivrer » (he
// reached the customer, the company was asked to deliver again), then delivered by the company, is the only one that
// goes to Suivi › Résolu (« Sauvé par ») and the only one whose suivi pay is paid — to the person who pressed
// « Relivrer ». An alert only worked on (« En cours »: a call, a call back, a réclamation) and then delivered is a plain
// « Livré » (« if it stayed En cours then delivered, he did not solve it »): no Résolu, no suivi pay. An alert nobody
// touched is a plain « Livré » too, and « ignorée » in the agent's score when its first-call deadline passed before it
// ended.

/** a line a person wrote in Pilotix, not the company's news (a sync runs under whoever pressed « Synchroniser », so its
 *  status lines carry a person too: they say « courier ») */
const byPerson = (w: string) => `${w}.user_id IS NOT NULL AND coalesce(${w}.data->>'courier', '') <> 'true'`;

/** The kinds of line that are real work on an alert: a call (Pas de réponse, Occupé), a status (a motif, a Bloqué
 *  treated, « Relivrer » or a manager's status); a « Rappel » is a note « suivi_rappel » (suivi.callResult). */
const ACTED_KINDS_SQL = `('call', 'sub_status', 'suivi_motif', 'suivi_stuck', 'follow_status')`;
/** a request sent to the company from Pilotix (parcel.action: a return, a new try, a note to its agents) — marked
 *  « acted » since 28 Nov 2026, read by its words before that */
const askedSql = (w: string) =>
  `(coalesce(${w}.data->>'acted', '') = 'true' OR ${w}.note LIKE 'Retour demandé à %' OR ${w}.note LIKE 'Nouvelle tentative demandée à %' OR ${w}.note LIKE 'Note envoyée à %')`;

/**
 * When a person really worked on the order (the owner, 28 Nov 2026: an alert is « En cours » only by real work — a call,
 * a status, « Relivrer », a réclamation, a request to the company), one row « at » each: the alert's clock stops at the
 * first one (alertClocks), and an alert without one is « ignorée ». Never work: a line Pilotix writes in a person's name
 * (« Équipe responsable : suivi », « Rendue à la file… », « Modification refusée par ZR »), a typed note, an edit,
 * giving the alert to an agent, a chat message, a bot's or a company's line, a delivery.
 */
export const actedAtSql = (o: string) => `SELECT w.at FROM order_events w
   WHERE w.order_id = ${o}.id AND ${byPerson('w')}
     AND (w.kind IN ${ACTED_KINDS_SQL} OR (w.kind = 'note' AND (w.to_value = 'suivi_rappel' OR ${askedSql('w')})))
     AND NOT (w.kind = 'follow_status' AND w.to_value = 'delivered')
  UNION ALL SELECT c.created_at FROM claims c WHERE c.order_id = ${o}.id AND c.created_by IS NOT NULL
  UNION ALL SELECT p.created_at FROM parcel_changes p WHERE p.order_id = ${o}.id AND p.created_by IS NOT NULL`;

/** the parcel's first alert */
const firstAlert = (o: string) => `(SELECT min(a.at) FROM order_events a WHERE a.order_id = ${o}.id AND a.kind = 'follow_status' AND a.to_value = 'alert')`;
/** its delivery after that alert (none yet: now) */
const deliveredAfter = (o: string) =>
  `coalesce((SELECT min(d.at) FROM order_events d WHERE d.order_id = ${o}.id AND d.kind = 'follow_status' AND d.to_value = 'delivered' AND d.at > ${firstAlert(o)}), now())`;
/** the people's real work on the alert, from its first alert to its delivery */
const actions = (o: string) => `FROM (${actedAtSql(o)}) x WHERE x.at > ${firstAlert(o)} AND x.at <= ${deliveredAfter(o)}`;

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
