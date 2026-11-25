// The Pilotix Android app's notifications (Firebase Cloud Messaging, HTTP v1 — mobile/…/PilotixMessagingService.java).
// The server signs in to Google with the Firebase project's service account: FIREBASE_SERVICE_ACCOUNT_B64 in deploy/.env,
// written there by the Deploy button from the GitHub secret FIREBASE_SERVICE_ACCOUNT (deploy/update.sh › secrets), so
// nobody pastes the key on the server. Then one message per phone; core's push.ts › fcmMessage says what it carries.
// Without the key, the app's phones get nothing and the browsers' Web Push works as before.
import { Logger } from '@nestjs/common';
import { fcmGone, fcmMessage } from '@pilotix/core';
import { createSign } from 'node:crypto';
import { config } from './config';

type Account = { project_id: string; client_email: string; private_key: string; private_key_id?: string };
const log = new Logger('Firebase');
/** Google's address for the sign-in (the key file says the same; another one is never used) */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let account: Account | null | undefined;
/** The service account, read once. Never written to the log. */
function serviceAccount(): Account | null {
  if (account !== undefined) return account;
  account = null;
  const raw = config.firebaseServiceAccount;
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j?.type === 'service_account' && typeof j.project_id === 'string' && /^[a-z0-9-]{4,40}$/.test(j.project_id) && typeof j.client_email === 'string' && typeof j.private_key === 'string')
      account = { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key, private_key_id: typeof j.private_key_id === 'string' ? j.private_key_id : undefined };
    else log.warn('FIREBASE_SERVICE_ACCOUNT is not a Firebase service account key: the app phones get no notifications');
  } catch {
    log.warn('FIREBASE_SERVICE_ACCOUNT could not be read (not JSON): the app phones get no notifications');
  }
  if (account) log.log(`the app phones' notifications go through Firebase (project ${account.project_id})`);
  return account;
}

/** This server has the Firebase key: the app phones can be told. */
export const fcmReady = () => !!serviceAccount();

const b64url = (s: string) => Buffer.from(s).toString('base64url');

/** Google's access for Firebase messages: asked with a note signed by the key (a JWT), kept until 5 minutes before its end. */
let access: { token: string; until: number } | null = null;
let asking: Promise<string> | null = null;
function accessToken(a: Account): Promise<string> {
  if (access && Date.now() < access.until) return Promise.resolve(access.token);
  asking ??= (async () => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(a.private_key_id ? { kid: a.private_key_id } : {}) }));
    const claims = b64url(JSON.stringify({ iss: a.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
    const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(a.private_key).toString('base64url');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!res.ok || typeof j.access_token !== 'string') throw new Error(`Google refused the Firebase key (${res.status} ${String(j.error ?? '')})`);
    const life = Math.max(10 * 60, Number(j.expires_in) || 3600);
    access = { token: j.access_token, until: Date.now() + (life - 5 * 60) * 1000 };
    return access.token;
  })().finally(() => {
    asking = null;
  });
  return asking;
}

/** One message to each of these app phones' tokens (ServerHooks.fcm). Never throws: a failure is « not sent ». */
export async function fcm(tokens: string[], payload: Record<string, unknown>): Promise<{ token: string; ok: boolean; gone: boolean }[]> {
  const notSent = () => tokens.map((token) => ({ token, ok: false, gone: false }));
  const a = serviceAccount();
  if (!a || !tokens.length) return notSent();
  let bearer: string;
  try {
    bearer = await accessToken(a);
  } catch (e) {
    log.warn(`no notification to the app phones: ${(e as Error).message}`);
    return notSent();
  }
  const url = `https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`;
  return Promise.all(
    tokens.map(async (token) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(fcmMessage(token, payload)),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return { token, ok: true, gone: false };
        const body = await res.json().catch(() => null);
        // Google no longer takes this access: asked again next time
        if (res.status === 401) access = null;
        const gone = fcmGone(res.status, body);
        if (!gone) log.warn(`a notification to an app phone failed: ${res.status} ${String((body as { error?: { status?: unknown } } | null)?.error?.status ?? '')}`);
        return { token, ok: false, gone };
      } catch (e) {
        log.warn(`a notification to an app phone failed: ${(e as Error).message}`);
        return { token, ok: false, gone: false };
      }
    }),
  );
}

/** The hooks to give core, only when this server has the Firebase key (else the app phones are left out, as before). */
export const fcmHooks = (): { fcm?: typeof fcm } => (fcmReady() ? { fcm } : {});
