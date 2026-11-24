// Abandoned carts (« paniers abandonnés ») in the team's numbers. A leaf module with no imports: the stats, the board,
// the Doctor, the agency's pages and the reports all read it, whatever order the modules load in.

/**
 * An abandoned cart is a form the client left without sending it, kept by Pilotix (`came` 'abandoned') or added by a person
 * from Landing pages › Abandonnées ('recovered'). The owner's rule (24 Nov 2026): the team's confirmation rate counts one
 * only once it is confirmed (then it is an order the team saved); cancelled, fake, without an answer or still to call, it
 * never counts for or against the team. Landing pages › Abandonnées counts them all, and what they brought.
 */
export const CART_CAME = ['abandoned', 'recovered'];
const CONFIRMED = ['confirmed', 'no_stock'];
/** True for an abandoned cart that is not confirmed: left out of the team's numbers. `status` = its confirmation status. */
export const cartLeftOut = (came: string | null | undefined, status: string | null | undefined) =>
  !!came && CART_CAME.includes(came) && !CONFIRMED.includes(String(status));
/** SQL: the order counts in the team's numbers: not an abandoned cart, or one confirmed. `o` = the table's alias with its
 *  dot ('o.'); `status` = the status to judge (an event's to_value when the numbers come from what an agent did). */
export const teamCountsSql = (o = '', status = `${o}conf_status`) =>
  `(${o}came IS NULL OR ${o}came NOT IN ('abandoned','recovered') OR ${status} IN ('confirmed','no_stock'))`;
