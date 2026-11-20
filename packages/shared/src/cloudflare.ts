/**
 * Cloudflare's IPv4 ranges (https://www.cloudflare.com/ips-v4), the same list as deploy/Caddyfile's `trusted_proxies`:
 * a domain behind Cloudflare's orange cloud shows these addresses instead of the server's.
 */
export const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

/** 203.0.113.10 → its number; null for anything that is not an IPv4 address */
function v4(ip: string): number | null {
  const p = ip.trim().split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}

/** An IPv4 address of Cloudflare's proxies (false for anything else, IPv6 included). */
export function isCloudflareIp(ip: string): boolean {
  const n = v4(ip);
  if (n === null) return false;
  return CLOUDFLARE_V4.some((range) => {
    const [base, bits] = range.split('/');
    const start = v4(base)!;
    return n >= start && n < start + 2 ** (32 - Number(bits));
  });
}
