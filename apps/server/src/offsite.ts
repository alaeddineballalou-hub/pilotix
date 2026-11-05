// The off-site copy of the nightly backup, set from the control room (Sauvegardes › Copie hors du serveur): each new
// backup (deploy/backup.sh writes it in /opt/pilotix-backups, read here in /backups) is encrypted on this server with
// the owner's passphrase and sent to a private Backblaze B2 bucket, with the key of the saved secrets (DATA_KEY) under
// the same passphrase. Without the passphrase the copies are unreadable, by Backblaze too. Its keys are kept sealed.
// To read a copy back:  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in <file>.sql.gz.enc -out <file>.sql.gz
import { Logger } from '@nestjs/common';
import { sealPlatformSetting } from '@pilotix/core';
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { config } from './config';
import type { CoreService } from './core.service';

const log = new Logger('Off-site backup');
const SETTING = 'backup_offsite';
const B2 = 'https://api.backblazeb2.com/b2api/v2';

interface Offsite {
  bucket: string;
  keyId: string;
  key: string;
  passphrase: string;
  lastAt?: string | null;
  lastFile?: string | null;
  lastBytes?: number | null;
  lastError?: string | null;
  lastTryAt?: string | null;
}

export interface OffsiteStatus {
  configured: boolean;
  bucket: string;
  keyId: string;
  keySet: boolean;
  passphraseSet: boolean;
  lastAt: string | null;
  lastFile: string | null;
  lastBytes: number | null;
  lastError: string | null;
  lastTryAt: string | null;
  /** the newest backup on this server, and whether it is off-site already */
  newest: { name: string; at: string; bytes: number } | null;
  sent: boolean;
}

async function read(core: CoreService): Promise<Offsite> {
  const r = (await core.t.platform.query(`SELECT value FROM platform.settings WHERE key = $1`, [SETTING]))[0];
  const v = (r?.value ?? {}) as Partial<Offsite>;
  return { bucket: String(v.bucket ?? ''), keyId: String(v.keyId ?? ''), key: String(v.key ?? ''), passphrase: String(v.passphrase ?? ''), lastAt: v.lastAt ?? null, lastFile: v.lastFile ?? null, lastBytes: v.lastBytes ?? null, lastError: v.lastError ?? null, lastTryAt: v.lastTryAt ?? null };
}

async function write(core: CoreService, v: Offsite) {
  await core.t.platform.query(
    `INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SETTING, JSON.stringify(sealPlatformSetting(SETTING, v))],
  );
}

const ready = (v: Offsite) => !!(v.bucket && v.keyId && v.key && v.passphrase.length >= 16);

/** The newest nightly backup on this server (null: none). */
async function newestBackup(): Promise<{ name: string; at: string; bytes: number; path: string } | null> {
  let best: { name: string; at: string; bytes: number; path: string } | null = null;
  try {
    for (const f of await readdir(config.backupsDir)) {
      if (!/^pilotix-\d{4}-\d{2}-\d{2}\.sql\.gz$/.test(f)) continue;
      const path = `${config.backupsDir}/${f}`;
      const st = await stat(path);
      if (!best || st.mtime.toISOString() > best.at) best = { name: f, at: st.mtime.toISOString(), bytes: st.size, path };
    }
  } catch {
    /* no backups folder on this server */
  }
  return best;
}

export async function offsiteStatus(core: CoreService): Promise<OffsiteStatus> {
  const v = await read(core);
  const n = await newestBackup();
  return {
    configured: ready(v),
    bucket: v.bucket,
    // the key's ID is not a secret (Backblaze shows it next to its name): its end, to recognise it
    keyId: v.keyId ? `…${v.keyId.slice(-6)}` : '',
    keySet: !!v.key,
    passphraseSet: !!v.passphrase,
    lastAt: v.lastAt ?? null,
    lastFile: v.lastFile ?? null,
    lastBytes: v.lastBytes ?? null,
    lastError: v.lastError ?? null,
    lastTryAt: v.lastTryAt ?? null,
    newest: n ? { name: n.name, at: n.at, bytes: n.bytes } : null,
    sent: !!(n && v.lastFile === `${n.name}.enc`),
  };
}

/** Saved by the owner: a key or the passphrase left empty keeps the one saved. */
export async function saveOffsite(core: CoreService, body: any): Promise<OffsiteStatus> {
  const cur = await read(core);
  const bucket = String(body?.bucket ?? '').trim();
  const keyId = String(body?.keyId ?? '').trim();
  const key = String(body?.key ?? '').trim();
  const passphrase = String(body?.passphrase ?? '');
  if (bucket && !/^[A-Za-z0-9-]{6,50}$/.test(bucket)) throw new Error('Nom du bucket : 6 à 50 lettres, chiffres ou tirets (comme dans Backblaze)');
  if (keyId && !/^[A-Za-z0-9]{12,40}$/.test(keyId)) throw new Error('keyID : celui de la clé d’application Backblaze (lettres et chiffres)');
  if (key && !/^[A-Za-z0-9+/=_-]{20,80}$/.test(key)) throw new Error('applicationKey : celle montrée une seule fois par Backblaze à la création de la clé');
  if (passphrase && passphrase.length < 16) throw new Error('Phrase secrète : 16 caractères au moins (gardez-la loin de ce serveur : sans elle les copies sont illisibles)');
  const next: Offsite = { ...cur, bucket: bucket || cur.bucket, keyId: keyId || cur.keyId, key: key || cur.key, passphrase: passphrase || cur.passphrase };
  if (body?.clear === true) Object.assign(next, { bucket: '', keyId: '', key: '', passphrase: '', lastError: null });
  await write(core, next);
  return offsiteStatus(core);
}

// ---------------------------------------------------------------- Backblaze B2 (native API)
interface B2Auth {
  apiUrl: string;
  token: string;
  accountId: string;
  bucketId: string | null;
}

async function b2Json(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }).catch(() => {
    throw new Error('Backblaze ne répond pas depuis ce serveur (réseau) : réessayez dans quelques minutes');
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Backblaze : ${data?.message || data?.code || `HTTP ${res.status}`}`);
  return data;
}

async function authorize(v: Offsite): Promise<B2Auth> {
  const a = await b2Json(`${B2}/b2_authorize_account`, { headers: { Authorization: `Basic ${Buffer.from(`${v.keyId}:${v.key}`).toString('base64')}` } });
  const auth: B2Auth = { apiUrl: String(a.apiUrl), token: String(a.authorizationToken), accountId: String(a.accountId), bucketId: a.allowed?.bucketId ? String(a.allowed.bucketId) : null };
  if (a.allowed?.bucketName && a.allowed.bucketName !== v.bucket) throw new Error(`Cette clé ne marche que pour le bucket « ${a.allowed.bucketName} »`);
  if (!auth.bucketId) {
    const l = await b2Json(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, { method: 'POST', headers: { Authorization: auth.token }, body: JSON.stringify({ accountId: auth.accountId, bucketName: v.bucket }) });
    auth.bucketId = l.buckets?.[0]?.bucketId ?? null;
    if (!auth.bucketId) throw new Error(`Bucket « ${v.bucket} » introuvable dans ce compte Backblaze`);
  }
  return auth;
}

/** One file to the bucket (its SHA-1 checked by Backblaze). */
async function upload(auth: B2Auth, name: string, path: string, size: number, sha1: string): Promise<void> {
  const u = await b2Json(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, { method: 'POST', headers: { Authorization: auth.token }, body: JSON.stringify({ bucketId: auth.bucketId }) });
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      String(u.uploadUrl),
      {
        method: 'POST',
        timeout: 30 * 60_000,
        headers: { Authorization: String(u.authorizationToken), 'X-Bz-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'X-Bz-Content-Sha1': sha1 },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body.length < 2000 ? (body += d) : null));
        res.on('end', () => {
          if ((res.statusCode ?? 500) < 300) return resolve();
          let m = `HTTP ${res.statusCode}`;
          try {
            m = JSON.parse(body).message || m;
          } catch {
            /* as it is */
          }
          reject(new Error(`Backblaze : ${m}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Backblaze : trop long')));
    req.on('error', reject);
    createReadStream(path).on('error', reject).pipe(req);
  });
}

/**
 * Encrypted as `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt` does (« Salted__ », the salt, then the data): the
 * same command with -d reads it back anywhere. Returns its size and SHA-1 (what Backblaze checks).
 */
export async function encryptFile(src: string | Buffer, dst: string, passphrase: string): Promise<{ size: number; sha1: string }> {
  const salt = randomBytes(8);
  const kiv = pbkdf2Sync(passphrase, salt, 200_000, 48, 'sha256');
  const cipher = createCipheriv('aes-256-cbc', kiv.subarray(0, 32), kiv.subarray(32, 48));
  const hash = createHash('sha1');
  let size = 0;
  const head = Buffer.concat([Buffer.from('Salted__'), salt]);
  let first = true;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      const out = first ? Buffer.concat([head, chunk]) : chunk;
      first = false;
      hash.update(out);
      size += out.length;
      done(null, out);
    },
    flush(done) {
      if (first) {
        hash.update(head);
        size += head.length;
        this.push(head);
      }
      done();
    },
  });
  const input = typeof src === 'string' ? createReadStream(src) : Readable.from([src]);
  await pipeline(input, cipher, count, createWriteStream(dst, { mode: 0o600 }));
  return { size, sha1: hash.digest('hex') };
}

let running: Promise<OffsiteStatus> | null = null;

/** The newest backup sent (when it is not yet, or `force`), with the key of the saved secrets. One at a time. */
export function sendOffsite(core: CoreService, force = false): Promise<OffsiteStatus> {
  if (!running)
    running = doSend(core, force).finally(() => {
      running = null;
    });
  return running;
}

async function doSend(core: CoreService, force: boolean): Promise<OffsiteStatus> {
  const v = await read(core);
  if (!ready(v)) return offsiteStatus(core);
  const n = await newestBackup();
  if (!n) return offsiteStatus(core);
  const name = `${n.name}.enc`;
  if (!force && v.lastFile === name) return offsiteStatus(core);
  const dir = join(tmpdir(), `pilotix-offsite-${randomBytes(6).toString('hex')}`);
  const at = new Date().toISOString();
  try {
    await mkdir(dir, { mode: 0o700 });
    const auth = await authorize(v);
    const data = join(dir, name);
    const d = await encryptFile(n.path, data, v.passphrase);
    await upload(auth, name, data, d.size, d.sha1);
    // the key of the saved secrets, under the same passphrase (a new server needs it to read the couriers' keys…)
    if (process.env.DATA_KEY) {
      const keys = join(dir, 'pilotix-keys.enc');
      const k = await encryptFile(Buffer.from(`DATA_KEY=${process.env.DATA_KEY.trim()}\n`), keys, v.passphrase);
      await upload(auth, 'pilotix-keys.enc', keys, k.size, k.sha1);
    }
    await write(core, { ...v, lastAt: at, lastTryAt: at, lastFile: name, lastBytes: d.size, lastError: null });
    log.log(`${name} sent (${d.size} bytes)`);
  } catch (e) {
    const m = String((e as Error).message ?? e).slice(0, 300);
    await write(core, { ...v, lastTryAt: at, lastError: m });
    log.warn(`not sent: ${m}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => null);
  }
  return offsiteStatus(core);
}

/** « Tester »: the keys and the bucket, with a small file (pilotix-test.txt, its date). */
export async function testOffsite(core: CoreService): Promise<OffsiteStatus> {
  const v = await read(core);
  if (!ready(v)) throw new Error('Remplissez d’abord le bucket, les deux clés et la phrase secrète');
  const dir = join(tmpdir(), `pilotix-offsite-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(dir, { mode: 0o700 });
    const auth = await authorize(v);
    const f = join(dir, 'pilotix-test.txt');
    const body = Buffer.from(`Pilotix: test of the off-site copy, ${new Date().toISOString()}\n`);
    await writeFile(f, body, { mode: 0o600 });
    await upload(auth, 'pilotix-test.txt', f, body.length, createHash('sha1').update(body).digest('hex'));
    await write(core, { ...v, lastError: null });
  } catch (e) {
    await write(core, { ...v, lastError: String((e as Error).message ?? e).slice(0, 300) });
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => null);
  }
  return offsiteStatus(core);
}
