import { resolve } from 'path';
const prod = process.env.NODE_ENV === 'production';

function need(name: string, devDefault?: string): string {
  const v = process.env[name] ?? (prod ? undefined : devDefault);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** The proxies Pilotix's own installation has: Caddy on the same machine or in Docker's private network. */
export const PRIVATE_PROXIES = 'loopback,linklocal,uniquelocal';

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: need('DATABASE_URL', 'postgres://pilotix:pilotix_dev_only@localhost:5432/pilotix'),
  dbPoolMax: Number(process.env.DB_POOL_MAX || 20),
  /**
   * A database connection keeps notes on every shop schema it has opened (~1.5 MB each, never forgotten while it lives):
   * with many shops it grows until PostgreSQL runs out of memory. So a connection is closed after this many queries or
   * seconds, and a fresh one (small again) takes its place.
   */
  dbConnMaxUses: Number(process.env.DB_CONN_MAX_USES || 1000),
  dbConnMaxSeconds: Number(process.env.DB_CONN_MAX_SECONDS || 300),
  /** Background jobs: how many shops one job works on at the same time. */
  jobShopsParallel: Math.max(1, Number(process.env.JOB_SHOPS_PARALLEL || 4)),
  /** Background jobs skip a sleeping shop: nobody used the app and no order came in for this many days. */
  jobSleepDays: Math.max(1, Number(process.env.JOB_SLEEP_DAYS || 21)),
  redisUrl: process.env.REDIS_URL || '',
  jwtSecret: (() => {
    const s = need('JWT_SECRET', 'dev-only-secret-change-me-0123456789abcdef');
    if (prod && s.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
    // the example / development values are public: anyone could sign an admin token with them
    if (prod && /change-me|dev-only|example/i.test(s)) throw new Error('JWT_SECRET is still the example value: set a long random secret');
    return s;
  })(),
  /** '12h', '7d', or seconds */
  jwtExpires: (process.env.JWT_EXPIRES || '12h') as `${number}${'s' | 'm' | 'h' | 'd'}` | number,
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,capacitor://localhost,https://localhost')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * Proxies in front of the server whose X-Forwarded-For is trusted (the client address used by the login limit).
   * Default none: without a proxy, anyone could write that header and dodge the limit. Behind a reverse proxy (nginx,
   * Caddy, a load balancer) give the proxy's addresses: an address, a range, or the names loopback, linklocal and
   * uniquelocal (the private ranges: Docker's network). Fastify 5.12 no longer accepts a hop count (it trusts nobody
   * then, and every visitor has the proxy's address): an old TRUST_PROXY=1 means the private ranges.
   */
  trustProxy: (() => {
    const v = (process.env.TRUST_PROXY || '').trim();
    if (!v || v === 'false' || v === '0') return false;
    if (/^\d+$/.test(v)) return PRIVATE_PROXIES;
    return v;
  })(),
  /** Where the nightly database backups are (the control room shows the last one and the disk space left). */
  backupsDir: (process.env.BACKUPS_DIR || '/backups').replace(/\/+$/, ''),
  /**
   * This server's IPv4 addresses, for shops' own domains (their A record). Empty: those of PUBLIC_URL's name in the DNS
   * (wrong behind Cloudflare: set PUBLIC_IP then).
   */
  publicIps: (process.env.PUBLIC_IP || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)),
  /** Emergency switch: PLATFORM_TWO_STEP=off lets the control room in with the password only (e-mails broken). */
  twoStepOff: (process.env.PLATFORM_TWO_STEP || '').trim().toLowerCase() === 'off',
  /** Public address of this server (used to show webhook URLs). */
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  /** where the shops' videos wait for their post (CM AI agent › Planner): a volume that survives updates (deploy/docker-compose.yml) */
  mediaDir: process.env.MEDIA_DIR || (prod ? '/data/media' : resolve('media')),
  /**
   * The landing pages' own address (LANDING_URL, https://go.<domain>): customers' pages never run on the app's address
   * (their scripts could reach a logged-in person's session there). Used once it answers (CoreService.checkLanding).
   */
  landingUrl: (process.env.LANDING_URL || '').replace(/\/+$/, ''),
  /**
   * Optional: where the check of that address connects (LANDING_CHECK_VIA=web, Caddy's container in deploy/), with the
   * same name and the same certificate check: Cloudflare's bot protection stops robots like it on the way through
   * Cloudflare. The public DNS record is checked apart. Unset: straight to LANDING_URL.
   */
  landingCheckVia: (process.env.LANDING_CHECK_VIA || '').trim(),
  /** Optional: a GitHub token (no rights needed) for « Changements API » to read the open-source couriers' code more often. */
  githubToken: (process.env.GITHUB_TOKEN || '').trim(),
  /**
   * E-mails ("mot de passe oublié"). Any SMTP server: Gmail (smtp.gmail.com, 465, an app password), Microsoft 365
   * (smtp.office365.com, 587), Brevo (smtp-relay.brevo.com, 587)… MAIL_FROM: "Pilotix <contact@your-shop.dz>".
   */
  smtp: {
    host: (process.env.SMTP_HOST || '').trim(),
    port: Number(process.env.SMTP_PORT || 587),
    user: (process.env.SMTP_USER || '').trim(),
    pass: process.env.SMTP_PASS || '',
    from: (process.env.MAIL_FROM || process.env.SMTP_USER || '').trim(),
  },
};
