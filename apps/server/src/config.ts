function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL', 'postgres://pilotix:pilotix_dev_only@localhost:5432/pilotix'),
  redisUrl: process.env.REDIS_URL || '',
  jwtSecret: (() => {
    const s = required('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-only-secret-change-me-0123456789abcdef');
    if (process.env.NODE_ENV === 'production' && s.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
    return s;
  })(),
  jwtExpires: process.env.JWT_EXPIRES || '12h',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
