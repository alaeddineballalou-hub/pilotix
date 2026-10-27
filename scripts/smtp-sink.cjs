// A tiny SMTP server for the tests (CI): accepts every message and saves it decoded in <dir>/<n>.json
// ({ to, subject, text, html, at }). No TLS, no auth (the Pilotix server allows that towards localhost only).
//   node scripts/smtp-sink.cjs [port=2525] [dir=$MAILS_DIR or /tmp/mails]
const net = require('net');
const fs = require('fs');
const dir = process.argv[3] || process.env.MAILS_DIR || '/tmp/mails';
const port = Number(process.argv[2] || 2525);
fs.mkdirSync(dir, { recursive: true });
// numbered after the last one already there: files keep sorting in the order they came
let n = Math.max(0, ...fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f, 10)));

const decodeWord = (s) =>
  s.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8')).replace(/=\?UTF-8\?Q\?([^?]+)\?=/gi, (_, q) => decodeURIComponent(q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, '%$1')));

function parse(raw) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const body = rest.join('\r\n\r\n');
  const h = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const out = { to: h.to, from: decodeWord(h.from || ''), subject: decodeWord(h.subject || ''), text: '', html: '' };
  const ct = h['content-type'] || '';
  const b = ct.match(/boundary="?([^";]+)"?/);
  const part = (hdrs, content) => {
    const enc = (hdrs.match(/content-transfer-encoding:\s*(\S+)/i) || [])[1] || '';
    const txt = /base64/i.test(enc) ? Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8') : content;
    if (/text\/html/i.test(hdrs)) out.html = txt;
    else out.text = txt;
  };
  if (b) {
    for (const p of body.split(`--${b[1]}`)) {
      const [ph, ...pb] = p.split(/\r?\n\r?\n/);
      if (!/content-type/i.test(ph)) continue;
      part(ph, pb.join('\n'));
    }
  } else part(`content-type: ${ct}\ncontent-transfer-encoding: ${h['content-transfer-encoding'] || ''}`, body);
  return out;
}

net
  .createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let data = false;
    let msg = '';
    let rcpt = [];
    sock.write('220 localhost test SMTP\r\n');
    sock.on('data', (d) => {
      buf += d;
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          msg += buf.slice(0, end);
          buf = buf.slice(end + 5);
          data = false;
          const m = parse(msg.replace(/^\.\./gm, '.'));
          m.rcpt = rcpt;
          m.at = new Date().toISOString();
          n++;
          fs.writeFileSync(`${dir}/${String(n).padStart(4, '0')}.json`, JSON.stringify(m, null, 2));
          console.log(`mail ${n} → ${m.to} : ${m.subject}`);
          msg = '';
          rcpt = [];
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const c = line.slice(0, 4).toUpperCase();
        if (c === 'EHLO' || c === 'HELO') sock.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (c === 'MAIL') sock.write('250 ok\r\n');
        else if (c === 'RCPT') (rcpt.push(line.replace(/^RCPT TO:\s*/i, '')), sock.write('250 ok\r\n'));
        else if (c === 'DATA') ((data = true), sock.write('354 go\r\n'));
        else if (c === 'QUIT') (sock.write('221 bye\r\n'), sock.end());
        else if (c === 'RSET') sock.write('250 ok\r\n');
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  })
  .listen(port, '127.0.0.1', () => console.log(`smtp sink on ${port} → ${dir}`));
