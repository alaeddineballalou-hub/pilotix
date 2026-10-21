const prod = process.env.NODE_ENV === 'production';

function need(name: string, devDefault?: string): string {
  const v = process.env[name] ?? (prod ? undefined : devDefault);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: need('DATABASE_URL', 'postgres://pilotix:pilotix_dev_only@localhost:5432/pilotix'),
  dbPoolMax: Number(process.env.DB_POOL_MAX || 20),
  redisUrl: process.env.REDIS_URL || '',
  jwtSecret: (() => {
    const s = need('JWT_SECRET', 'dev-only-secret-change-me-0123456789abcdef');
    if (prod && s.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
    return s;
  })(),
  jwtExpires: process.env.JWT_EXPIRES || '12h',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,capacitor://localhost,https://localhost')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Public address of this server (used to show webhook URLs). */
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
};
