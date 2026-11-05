// The server's side of the saved secrets (packages/core/src/secretbox.ts): sealed with DATA_KEY (AES-256-GCM, a new
// random nonce each time) as they are written, opened as the database gives them back. DATA_KEY lives in deploy/.env
// (made by install.sh, kept with the off-site backup under its passphrase: deploy/backup.sh), never in the database.
import { Logger } from '@nestjs/common';
import { SEALED, useSecretSealer } from '@pilotix/core';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { types } from 'pg';

const log = new Logger('Secrets');
let warned = false;

/** DATA_KEY: 32 bytes, written in base64 (or 64 hex characters). Anything else: no sealing (and said in the log). */
export function dataKey(raw: string | undefined): Buffer | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const b = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  return b.length === 32 ? b : null;
}

export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return SEALED + Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url');
}

/** The secret inside a sealed value; anything else as it is (a value that only looks sealed, a key that is not ours). */
export function open(key: Buffer, s: string): string {
  if (!s.startsWith(SEALED)) return s;
  try {
    const b = Buffer.from(s.slice(SEALED.length), 'base64url');
    if (b.length < 12 + 16) return s;
    const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(b.length - 16));
    return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8');
  } catch {
    if (!warned) {
      warned = true;
      log.error('A saved secret cannot be opened with this DATA_KEY (deploy/.env): was the key changed? The keys saved before must be typed again.');
    }
    return s;
  }
}

function openDeep(key: Buffer, v: unknown): unknown {
  if (typeof v === 'string') return v.startsWith(SEALED) ? open(key, v) : v;
  if (Array.isArray(v)) return v.map((x) => openDeep(key, x));
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) (v as Record<string, unknown>)[k] = openDeep(key, x);
  }
  return v;
}

/**
 * Turns sealing on (DATA_KEY set): secrets are sealed as they are written, and every value the database gives back
 * (text, JSON) is opened when it carries the seal's mark — every read of a secret, wherever it is in the code.
 */
export function startSecretBox(raw: string | undefined): boolean {
  const key = dataKey(raw);
  if (!key) {
    if (String(raw ?? '').trim()) log.error('DATA_KEY is not 32 bytes (base64 or 64 hex characters): saved secrets are kept unsealed');
    else log.warn('No DATA_KEY: saved secrets are kept unsealed (run the installer again: it makes one)');
    return false;
  }
  useSecretSealer((plain) => seal(key, plain));
  const json = (text: string) => {
    const v = JSON.parse(text);
    return text.includes(SEALED) ? openDeep(key, v) : v;
  };
  const text = (s: string) => (s.startsWith(SEALED) ? open(key, s) : s);
  types.setTypeParser(types.builtins.JSONB, json);
  types.setTypeParser(types.builtins.JSON, json);
  types.setTypeParser(types.builtins.TEXT, text);
  types.setTypeParser(types.builtins.VARCHAR, text);
  return true;
}
