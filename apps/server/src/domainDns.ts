// The DNS that checks a shop's own domain (Landing pages › Réglages › « Votre propre domaine »).
//
// It asks big public DNS services directly (Cloudflare 1.1.1.1, Google 8.8.8.8), not the hosting company's DNS: that
// one can keep a domain's old addresses for a day or two after a shop moves the domain from another platform.
// Seen on 20 Nov 2026 with babyjoydz.net, moved from JustSell: every public DNS already gave Pilotix's address, but
// the server's DNS (Contabo) still gave JustSell's, so « Vérifier » kept saying « not yet ».
// When the public services cannot be reached (blocked, timeout), the server's own DNS answers; when they answer
// « no such record », that stays the answer.
import { promises as dns } from 'node:dns';

/** What the domain check needs to know about a name: its IPv4 addresses and its TXT texts. */
export interface NameLookup {
  resolve4(host: string): Promise<string[]>;
  resolveTxt(host: string): Promise<string[][]>;
}

/** The DNS answered: the name (or this kind of record) does not exist. Any other error = it could not be asked. */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

export function domainLookup(pub: NameLookup = publicDns(), own: NameLookup = serverDns()): NameLookup {
  const ask = async <T>(fromPub: () => Promise<T>, fromOwn: () => Promise<T>): Promise<T> => {
    try {
      return await fromPub();
    } catch (e: any) {
      if (NO_RECORD.has(e?.code)) throw e;
      return fromOwn();
    }
  };
  return {
    resolve4: (h) => ask(() => pub.resolve4(h), () => own.resolve4(h)),
    resolveTxt: (h) => ask(() => pub.resolveTxt(h), () => own.resolveTxt(h)),
  };
}

/** Cloudflare first, then Google: 3 s per try, 2 tries each, so a blocked network gives up within about 12 s. */
function publicDns(): NameLookup {
  const r = new dns.Resolver({ timeout: 3000, tries: 2 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return { resolve4: (h) => r.resolve4(h), resolveTxt: (h) => r.resolveTxt(h) };
}

function serverDns(): NameLookup {
  return { resolve4: (h) => dns.resolve4(h), resolveTxt: (h) => dns.resolveTxt(h) };
}
