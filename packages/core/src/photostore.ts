// Where the shops' HD product photos live: Pilotix's Cloudflare R2 bucket (Plateforme › Stockage des photos). The
// server keeps only each photo's name in the bucket and a small copy for the screens; the photo itself goes to R2 once
// (when the shop adds it) and WhatsApp, Messenger and Instagram download it from R2 with a link valid for an hour
// (R2 charges nothing for downloads). The keys are kept sealed; the secret is never shown again.
// Signing is AWS Signature V4 (R2 speaks the S3 API), done with Web Crypto so this file runs anywhere; only the server
// calls R2 (the browser preview keeps its photos in its own database).
import { Db } from './db';
import { sealPlatformSetting } from './secretbox';

export const PHOTO_STORE = 'photo_store';

export interface StoreConf {
  /** Cloudflare account ID (32 hex) */
  account: string;
  bucket: string;
  /** R2 API token: Access Key ID and Secret Access Key */
  keyId: string;
  secret: string;
}
interface StoreRow extends StoreConf {
  lastTest?: { at: string; ok: boolean; error: string | null } | null;
}
export interface StoreStatus {
  configured: boolean;
  account: string;
  bucket: string;
  keyId: string;
  secretSet: boolean;
  lastTest: { at: string; ok: boolean; error: string | null } | null;
}

const ACCOUNT = /^[a-f0-9]{32}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KEY_ID = /^[A-Za-z0-9]{16,128}$/;
const SECRET = /^[A-Za-z0-9+/=_-]{20,256}$/;

const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

async function readRow(pdb: Db): Promise<StoreRow> {
  const r = (await pdb.query<{ value: unknown }>('SELECT value FROM platform.settings WHERE key = $1', [PHOTO_STORE]).catch(() => []))[0];
  const v = (r ? json(r.value) : {}) ?? {};
  return { account: String(v.account ?? ''), bucket: String(v.bucket ?? ''), keyId: String(v.keyId ?? ''), secret: String(v.secret ?? ''), lastTest: v.lastTest ?? null };
}
async function writeRow(pdb: Db, v: StoreRow) {
  await pdb.query(`INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [
    PHOTO_STORE,
    JSON.stringify(sealPlatformSetting(PHOTO_STORE, v)),
  ]);
}

export const storeReady = (c: StoreConf | null): c is StoreConf => !!c && ACCOUNT.test(c.account) && BUCKET.test(c.bucket) && KEY_ID.test(c.keyId) && SECRET.test(c.secret);

/** The bucket and its keys, when they are all set (null: photo storage is off). */
export async function readStore(pdb: Db): Promise<StoreConf | null> {
  const r = await readRow(pdb);
  return storeReady(r) ? { account: r.account, bucket: r.bucket, keyId: r.keyId, secret: r.secret } : null;
}

export async function storeStatus(pdb: Db): Promise<StoreStatus> {
  const r = await readRow(pdb);
  return { configured: storeReady(r), account: r.account, bucket: r.bucket, keyId: r.keyId, secretSet: !!r.secret, lastTest: r.lastTest ?? null };
}

/** Saves the bucket; keyId / secret: new values, or undefined to keep them. `clear`: forgets everything. */
export async function saveStore(pdb: Db, i: { account?: string; bucket?: string; keyId?: string; secret?: string; clear?: boolean }): Promise<StoreStatus> {
  if (i.clear) {
    await pdb.query('DELETE FROM platform.settings WHERE key = $1', [PHOTO_STORE]);
    return storeStatus(pdb);
  }
  const old = await readRow(pdb);
  const v: StoreRow = {
    account: (i.account ?? old.account).trim().toLowerCase(),
    bucket: (i.bucket ?? old.bucket).trim().toLowerCase(),
    keyId: i.keyId?.trim() || old.keyId,
    secret: i.secret?.trim() || old.secret,
    lastTest: null,
  };
  if (v.account && !ACCOUNT.test(v.account)) throw new Error('L’ID du compte Cloudflare a 32 caractères (chiffres et lettres a à f).');
  if (v.bucket && !BUCKET.test(v.bucket)) throw new Error('Nom du bucket : 3 à 63 caractères, minuscules, chiffres et tirets.');
  if (v.keyId && !KEY_ID.test(v.keyId)) throw new Error('Access Key ID invalide.');
  if (v.secret && !SECRET.test(v.secret)) throw new Error('Secret Access Key invalide.');
  await writeRow(pdb, v);
  return storeStatus(pdb);
}

// ---------------------------------------------------------------- AWS Signature V4 (query string), for R2
const te = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await globalThis.crypto.subtle.digest('SHA-256', te.encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await globalThis.crypto.subtle.importKey('raw', key instanceof Uint8Array ? new Uint8Array(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return globalThis.crypto.subtle.sign('HMAC', k, te.encode(msg));
}
/** RFC 3986, as S3 wants it */
const enc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** a safe object name: letters, digits, - _ . and / between the parts */
export const OBJECT_KEY = /^[a-z0-9][a-z0-9._-]{0,80}(\/[a-z0-9][a-z0-9._-]{0,80}){0,4}$/i;

/** AWS Signature V4 in the query string (a presigned link): the query, signature included. */
export async function signQuery(o: { method: string; host: string; path: string; region: string; keyId: string; secret: string; expires: number; now: Date }): Promise<string> {
  const amzDate = o.now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const q: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${o.keyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(Math.max(1, Math.min(604_800, Math.round(o.expires))))],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const qs = q
    .map(([k, v]) => `${enc3986(k)}=${enc3986(v)}`)
    .sort()
    .join('&');
  const canonical = [o.method, o.path, qs, `host:${o.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');
  let k = await hmac(te.encode(`AWS4${o.secret}`), day);
  k = await hmac(k, o.region);
  k = await hmac(k, 's3');
  k = await hmac(k, 'aws4_request');
  return `${qs}&X-Amz-Signature=${hex(await hmac(k, toSign))}`;
}

/**
 * A link that lets its holder do one thing to one object until it expires (GET to download it, PUT to upload it,
 * DELETE). R2's S3 endpoint; up to 7 days.
 */
export async function presign(c: StoreConf, method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', key: string, expires: number, now: Date = new Date()): Promise<string> {
  if (!OBJECT_KEY.test(key)) throw new Error('Nom de photo invalide');
  const host = `${c.account}.r2.cloudflarestorage.com`;
  const path = `/${enc3986(c.bucket)}/${key.split('/').map(enc3986).join('/')}`;
  return `https://${host}${path}?${await signQuery({ method, host, path, region: 'auto', keyId: c.keyId, secret: c.secret, expires, now })}`;
}

const r2Error = async (res: Response, what: string) => {
  const body = (await res.text().catch(() => '')).slice(0, 400);
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  return new Error(`${what} : R2 a répondu ${res.status}${code ? ` (${code})` : ''}`);
};

/** Puts one photo in the bucket. */
export async function putObject(c: StoreConf, key: string, bytes: Uint8Array, type: string): Promise<void> {
  const res = await fetch(await presign(c, 'PUT', key, 600), { method: 'PUT', headers: { 'Content-Type': type }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw await r2Error(res, 'Envoi de la photo');
}

/** Removes objects from the bucket (one that is already gone is fine). */
export async function deleteObjects(c: StoreConf, keys: string[]): Promise<string[]> {
  const done: string[] = [];
  for (const key of keys) {
    if (!OBJECT_KEY.test(key)) {
      done.push(key);
      continue;
    }
    const res = await fetch(await presign(c, 'DELETE', key, 600), { method: 'DELETE', signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (res && (res.ok || res.status === 404)) done.push(key);
  }
  return done;
}

/** Tries the bucket for real: puts a small file, reads it back, removes it. The result is kept (and shown). */
export async function testStore(pdb: Db): Promise<StoreStatus> {
  const row = await readRow(pdb);
  if (!storeReady(row)) throw new Error('Remplissez d’abord l’ID du compte, le bucket et les deux clés.');
  const key = `pilotix-test/${Date.now().toString(36)}.txt`;
  let error: string | null = null;
  try {
    const body = te.encode('Pilotix: test du stockage des photos');
    await putObject(row, key, body, 'text/plain');
    const got = await fetch(await presign(row, 'GET', key, 300), { signal: AbortSignal.timeout(20_000) });
    if (!got.ok) throw await r2Error(got, 'Lecture');
    if ((await got.text()) !== 'Pilotix: test du stockage des photos') throw new Error('Lecture : le fichier relu n’est pas le même');
    await deleteObjects(row, [key]);
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 300);
  }
  await writeRow(pdb, { ...row, lastTest: { at: new Date().toISOString(), ok: !error, error } });
  return storeStatus(pdb);
}
