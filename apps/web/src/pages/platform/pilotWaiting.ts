// What waits for the next « Push en test », in a few words: the two pushes' card and the exam's foot both say it.
import { n } from '../../lib/format';
import type { POut } from '../../lib/platform';

type Pending = POut<'p.pilot.state'>['release']['pending'];
type Tr = (k: string, o?: Record<string, unknown>) => string;
const K = 'platform.pilot.release.';

/** the sales lessons (and the nights' ones approved with the push), the Darija lessons and rules, the vocabulary; the
 *  box `withShops`: the shops' Darija lessons waiting go in too */
export function waitingParts(t: Tr, p: Pending, withShops: boolean): string[] {
  const sales = p.sales + p.candidates;
  const darija = p.darija + (withShops ? p.waiting : 0);
  return [
    sales > 0 ? (p.candidates > 0 ? t(K + 'partSalesNight', { n: n(sales), night: n(p.candidates) }) : t(K + 'partSales', { n: n(sales) })) : '',
    darija > 0 ? t(K + 'partDarija', { n: n(darija) }) : '',
    p.rules ? t(K + 'partRules') : '',
    p.vocab.total > 0 ? t(K + 'partVocab', { n: n(p.vocab.total) }) : '',
  ].filter(Boolean);
}
