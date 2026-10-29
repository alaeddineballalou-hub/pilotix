// Control room › Sociétés de livraison: the team's own API keys for each delivery company, kept to test every API
// with real keys (connection, lists, tracking, a test parcel), and the last result of each test. Keys are write-only:
// the page learns which ones are set, never their values; only the server reads them, to run a test.
import type { Tenancy } from './tenancy';

const KEYS = 'courier_test_keys';
const RESULTS = 'courier_test_results';

export interface CourierTestKeys {
  secret: Record<string, string>;
  settings: Record<string, unknown>;
  updatedAt: string;
  by: string | null;
}
export interface CourierCheckStep {
  step: string;
  /** null = not available with this company (skipped) */
  ok: boolean | null;
  ms: number;
  detail: string;
}
export interface CourierCheckResult {
  ok: boolean;
  deep: boolean;
  at: string;
  steps: CourierCheckStep[];
}

const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});

/** One control-room setting saved as JSON (an object keyed by company), {} when not saved yet. */
export async function readSetting<T>(t: Tenancy, key: string): Promise<Record<string, T>> {
  const r = (await t.platform.query<{ value: unknown }>('SELECT value FROM platform.settings WHERE key = $1', [key]))[0];
  return (r ? json(r.value) : {}) as Record<string, T>;
}
export async function writeSetting(t: Tenancy, key: string, value: unknown) {
  await t.platform.query(
    `INSERT INTO platform.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/** SERVER ONLY (never sent to a browser): every company's test keys, with their values. */
export const courierTestKeys = (t: Tenancy) => readSetting<CourierTestKeys>(t, KEYS);

/** Saves a company's test keys: an empty secret keeps the one saved; settings replace the saved ones. */
export async function saveCourierTestKeys(t: Tenancy, company: string, secret: Record<string, string>, settings: Record<string, unknown>, by: string | null) {
  const all = await courierTestKeys(t);
  const old = all[company]?.secret ?? {};
  const merged: Record<string, string> = { ...old };
  for (const [k, v] of Object.entries(secret)) if (String(v ?? '').trim()) merged[k] = String(v).trim();
  all[company] = { secret: merged, settings, updatedAt: new Date().toISOString(), by };
  await writeSetting(t, KEYS, all);
}

export async function clearCourierTestKeys(t: Tenancy, company: string) {
  const all = await courierTestKeys(t);
  delete all[company];
  await writeSetting(t, KEYS, all);
  const res = await courierTestResults(t);
  delete res[company];
  await writeSetting(t, RESULTS, res);
}

export const courierTestResults = (t: Tenancy) => readSetting<CourierCheckResult>(t, RESULTS);

export async function saveCourierTestResult(t: Tenancy, company: string, result: CourierCheckResult) {
  const all = await courierTestResults(t);
  all[company] = result;
  await writeSetting(t, RESULTS, all);
}

/** What the page may see: which keys are set (never their values), the settings, the last test. */
export async function courierTestState(t: Tenancy) {
  const [keys, results] = await Promise.all([courierTestKeys(t), courierTestResults(t)]);
  const out: Record<string, { keysSet: string[]; settings: Record<string, unknown>; updatedAt: string | null; by: string | null; last: CourierCheckResult | null }> = {};
  for (const k of new Set([...Object.keys(keys), ...Object.keys(results)])) {
    const v = keys[k];
    out[k] = {
      keysSet: v ? Object.entries(v.secret).filter(([, x]) => !!x).map(([n]) => n) : [],
      settings: v?.settings ?? {},
      updatedAt: v?.updatedAt ?? null,
      by: v?.by ?? null,
      last: results[k] ?? null,
    };
  }
  return out;
}
