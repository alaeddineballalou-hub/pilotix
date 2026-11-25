// The search of everyone but the seller and the admins (owner's rules, 25 Nov 2026): « Tous », the top search bar and
// Suivi › Réclamation › Recherche have no list and reach every order of the person's reach, whatever its age, only by:
// - at least 5 digits of the customer's phone (a name never counts);
// - or a whole order reference or tracking code typed exactly (PX1374, 43-PCLONZDMHK-ZR): the shop's references have
//   4 digits and ZR's codes 2, so 5 digits alone left the team without them (owner's choice « A », 25 Nov 2026). Found
//   only when typed whole, so nobody can go through the orders with it.
// The server (core oldphones.ts, orders.ts) and the screens use the same rule.

/** How many digits of a phone open the search. */
export const LOOKUP_DIGITS = 5;

/** The digits of a search: letters (a name) do not count. */
export const lookupDigits = (q: string | null | undefined) => (q ?? '').replace(/\D/g, '').length;

/** A whole reference or tracking code: one word of at least 4 signs with a digit and a letter (PX1374, PXT12664…,
 *  43-PCLONZDMHK-ZR). A name has no digit, a phone no letter. */
export const isLookupCode = (q: string | null | undefined) => {
  const s = (q ?? '').trim();
  return s.length >= 4 && !/\s/.test(s) && /\d/.test(s) && /\p{L}/u.test(s);
};

/** The search opens: 5 digits of a phone, or a whole reference or tracking code. */
export const lookupReady = (q: string | null | undefined) => lookupDigits(q) >= LOOKUP_DIGITS || isLookupCode(q);
