// For the end-to-end tests: the test mailbox (scripts/smtp-sink.cjs saves each e-mail the server sends as
// <MAILS_DIR>/<n>.json) and the control room's login, which asks for a code sent by e-mail (two-step login).
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export const MAILS = process.env.MAILS_DIR || '/tmp/mails';
const files = () => (existsSync(MAILS) ? readdirSync(MAILS).filter((f) => f.endsWith('.json')).sort() : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many e-mails arrived so far (to look only at the ones that come after). */
export const mailCount = () => files().length;
export const allMails = () => files().map((f) => ({ f, ...JSON.parse(readFileSync(`${MAILS}/${f}`, 'utf8')) }));

/** The last e-mail to `to` among those after the first `after` (waits up to 10 s); `re` must match its subject or text. */
export async function mailTo(to, after = 0, re) {
  for (let i = 0; i < 40; i++) {
    const m = allMails()
      .slice(after)
      .filter((x) => String(x.to || '').toLowerCase().includes(to.toLowerCase()) && (!re || re.test(`${x.subject} ${x.text}`)));
    if (m.length) return m[m.length - 1];
    await sleep(250);
  }
  throw new Error(`no e-mail to ${to}${re ? ` matching ${re}` : ''}`);
}

/** The token of a link in an e-mail: …/#/<kind>/<token> */
export function linkToken(m, kind) {
  const x = `${m.text} ${m.html}`.match(new RegExp(`#/${kind}/([A-Za-z0-9_.-]+)`));
  if (!x) throw new Error(`no #/${kind}/ link in « ${m.subject} »`);
  return x[1];
}

/** The 6-digit code of the control room's login e-mail. */
export const codeIn = (m) => (String(m.text).match(/\b(\d{6})\b/) || [])[1];

/**
 * Control room login: the password, then — when the server asks for it (it sends e-mails) — the code it e-mailed.
 * Answers like the API: { status, data } with data.token when logged in.
 */
export async function staffLogin(api, email, password, opts = {}) {
  const post = async (path, body) => {
    const r = await fetch(api + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: r.status, data };
  };
  const n0 = mailCount();
  const r = await post('/platform/auth/login', { email, password, ...(opts.device ? { device: opts.device } : {}) });
  if (r.status !== 201 || r.data?.step !== 'code') return r;
  const code = codeIn(await mailTo(email, n0));
  return post('/platform/auth/code', { ticket: r.data.ticket, code, remember: !!opts.remember });
}
