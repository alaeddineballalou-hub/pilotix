// IP addresses. An IPv6 home or phone connection gets a whole /64 block: an attacker can use a new address for every
// request inside it, so limits count the /64 block, never the single IPv6 address.

/** '2001:db8::1' → '2001:0db8:0000:0000:0000:0000:0000:0001'; '::ffff:1.2.3.4' → '1.2.3.4'; IPv4 unchanged. */
export function expandIp(ip: string): string {
  const v = (ip || '').trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return mapped[1];
  if (!v.includes(':')) return v;
  const [head, tail = ''] = v.split('::');
  const a = head ? head.split(':') : [];
  const b = v.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = v.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return v;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

/** What a limit counts: the IPv4 address, or the IPv6 /64 block ('2001:0db8:0000:0001::/64'). */
export function ipNet(ip: string): string {
  const e = expandIp(ip);
  return e.includes(':') && e.split(':').length === 8 ? `${e.split(':').slice(0, 4).join(':')}::/64` : e;
}

/** For SQL: '' for IPv4, else the expanded /64 prefix ('2001:0db8:0000:0001:') to match with LIKE. */
export function ipPrefix(ip: string): string {
  const e = expandIp(ip);
  return e.includes(':') && e.split(':').length === 8 ? `${e.split(':').slice(0, 4).join(':')}:` : '';
}
