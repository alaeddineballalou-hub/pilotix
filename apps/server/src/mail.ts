// Sends e-mails through any SMTP server (Gmail, Microsoft 365, Brevo, your host…), with no extra package.
// Port 465: TLS from the start. Other ports (587): STARTTLS, which is required except towards localhost:
// a password or a reset link never travels unencrypted.
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { config } from './config';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** True when the server has what it needs to send e-mails. */
export function mailConfigured(): boolean {
  return !!(config.smtp.host && config.smtp.from && config.publicUrl);
}

const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const addr = (s: string) => {
  const m = clean(s).match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  const a = m ? m[1] : clean(s);
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(a)) throw new Error(`Adresse e-mail invalide : ${a}`);
  return a;
};
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

/** The whole message (headers + body), lines ending in CRLF. */
export function buildMessage(from: string, m: Mail, now = new Date()): string {
  const boundary = `px-${randomBytes(12).toString('hex')}`;
  const domain = addr(from).split('@')[1];
  const fromName = clean(from).match(/^(.*?)\s*<[^>]+>\s*$/)?.[1]?.replace(/^"|"$/g, '');
  const head = [
    `From: ${fromName ? `${word(fromName)} <${addr(from)}>` : addr(from)}`,
    `To: ${addr(m.to)}`,
    `Subject: ${word(clean(m.subject))}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  const part = (type: string, body: string) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap(b64(body))].join('\r\n');
  const body = m.html
    ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, '', part('text/plain', m.text), part('text/html', m.html), `--${boundary}--`, ''].join('\r\n')
    : ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(m.text))].join('\r\n');
  return [...head, body].join('\r\n');
}

/** One SMTP conversation. */
class Smtp {
  private buf = '';
  private waiting: ((line: string) => void)[] = [];
  private lines: string[] = [];
  private failed: Error | null = null;

  constructor(private sock: net.Socket) {
    this.listen(sock);
  }

  private listen(sock: net.Socket) {
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const w = this.waiting.shift();
        if (w) w(line);
        else this.lines.push(line);
      }
    });
    const fail = (e: Error) => {
      this.failed = e;
      for (const w of this.waiting.splice(0)) w('');
    };
    sock.on('error', fail);
    sock.on('close', () => fail(new Error('Connexion SMTP fermée')));
  }

  private line(): Promise<string> {
    const l = this.lines.shift();
    if (l !== undefined) return Promise.resolve(l);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((ok, ko) =>
      this.waiting.push((x) => {
        if (this.failed && x === '') ko(this.failed);
        else ok(x);
      }),
    );
  }

  /** A full reply (multi-line replies: "250-…" then "250 …"). */
  async reply(): Promise<{ code: number; text: string[] }> {
    const text: string[] = [];
    for (;;) {
      const l = await this.line();
      text.push(l.slice(4));
      if (l[3] !== '-') return { code: Number(l.slice(0, 3)), text };
    }
  }

  async cmd(c: string | null, expect: number[], show = c): Promise<string[]> {
    if (c !== null) this.sock.write(`${c}\r\n`);
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${show ?? 'accueil'} → ${r.code} ${r.text.join(' ')}`);
    return r.text;
  }

  /** Switches to TLS on the same connection (after STARTTLS). */
  async upgrade(host: string) {
    // the plain socket's listeners would read the encrypted bytes
    this.sock.removeAllListeners('data');
    this.sock.removeAllListeners('error');
    this.sock.removeAllListeners('close');
    const s = tls.connect({ socket: this.sock, servername: host });
    await new Promise<void>((ok, ko) => {
      s.once('secureConnect', ok);
      s.once('error', ko);
    });
    this.sock = s;
    this.buf = '';
    this.lines = [];
    this.listen(s);
  }

  write(data: string) {
    this.sock.write(data);
  }
  end() {
    this.sock.end();
  }
}

export async function sendMail(m: Mail): Promise<void> {
  const { host, port, user, pass, from } = config.smtp;
  if (!host || !from) throw new Error('SMTP non configuré');
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const sock: net.Socket = port === 465 ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  sock.setTimeout(20_000, () => sock.destroy(new Error('SMTP : délai dépassé')));
  await new Promise<void>((ok, ko) => {
    sock.once(port === 465 ? 'secureConnect' : 'connect', ok);
    sock.once('error', ko);
  });
  const s = new Smtp(sock);
  try {
    await s.cmd(null, [220]);
    const me = new URL(config.publicUrl || 'http://pilotix.local').hostname;
    let ehlo = await s.cmd(`EHLO ${me}`, [250]);
    if (port !== 465) {
      if (ehlo.some((l) => /^STARTTLS\b/i.test(l))) {
        await s.cmd('STARTTLS', [220]);
        await s.upgrade(host);
        ehlo = await s.cmd(`EHLO ${me}`, [250]);
      } else if (!local) throw new Error('Le serveur SMTP ne propose pas de connexion chiffrée (STARTTLS) : envoi refusé');
    }
    if (user) {
      const auth = ehlo.find((l) => /^AUTH\b/i.test(l)) || '';
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        await s.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235], 'AUTH PLAIN');
      } else {
        await s.cmd('AUTH LOGIN', [334]);
        await s.cmd(Buffer.from(user).toString('base64'), [334], 'AUTH (utilisateur)');
        await s.cmd(Buffer.from(pass).toString('base64'), [235], 'AUTH (mot de passe)');
      }
    }
    await s.cmd(`MAIL FROM:<${addr(from)}>`, [250]);
    await s.cmd(`RCPT TO:<${addr(m.to)}>`, [250, 251]);
    await s.cmd('DATA', [354]);
    const msg = buildMessage(from, m).replace(/\r\n\./g, '\r\n..');
    s.write(`${msg}${msg.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
    await s.cmd(null, [250], 'DATA (message)');
    s.write('QUIT\r\n');
  } finally {
    s.end();
  }
}
