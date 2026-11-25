/** How many digits open a search of the orders for everyone but the seller and the admins (server: oldphones.ts). */
export const LOOKUP_DIGITS = 5;

/** The digits of a search: letters (a name) do not count. */
export const lookupDigits = (q: string) => q.replace(/\D/g, '').length;
