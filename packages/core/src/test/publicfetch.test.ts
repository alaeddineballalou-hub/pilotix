// Addresses someone typed never reach the server's own network: every IPv4 and IPv6 form of a private address is
// refused (IPv4 written inside IPv6 included), names that only exist inside are refused, redirects are checked one by
// one, and a key header never follows a redirect to another host. Browser push addresses are push services only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';
import { checkPublicUrl, privateAddress, publicFetch } from '../publicfetch';
import { pushServiceUrl } from '../modules/push';

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  delete process.env.PILOTIX_ALLOW_PRIVATE_URLS;
});

test('private and reserved addresses, in every IPv4 and IPv6 form, are not public', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.10',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b:1::1', '2002:7f00:1::1', '2002:c0a8:101::',
    'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fe80::1%eth0', '[::1]', 'not-an-ip',
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '41.111.2.3', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1', '2a00:1450:4007:80c::200e'])
    assert.equal(privateAddress(ip), false, ip);
});

test('an address that names the inside of a network is refused before any call', () => {
  for (const u of [
    'http://localhost:5432/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://[::ffff:7f00:1]/', 'http://[::1]:6379/', 'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/', 'http://postgres:5432/', 'http://redis/', 'http://printer.local/', 'http://box.lan/', 'ftp://files.example.com/', 'https://user:pw@api.example.com/', 'file:///etc/passwd',
  ])
    assert.throws(() => checkPublicUrl(u, 'Test'), /Test : adresse (refusée|invalide)/, u);
  assert.equal(checkPublicUrl('https://api.yalidine.app/v1/', 'Test').hostname, 'api.yalidine.app');
  assert.equal(checkPublicUrl('https://8.8.8.8/x', 'Test').hostname, '8.8.8.8');
});

test('a redirect towards the inside is refused, and a key never follows a redirect to another host', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    seen.push({ url: u, headers: o.headers });
    if (u === 'https://api.example.com/a') return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } });
    if (u === 'https://api.example.com/b') return new Response('', { status: 301, headers: { location: 'https://cdn.example.net/b' } });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  await assert.rejects(publicFetch('https://api.example.com/a', { headers: { Authorization: 'Bearer k' } }, 'Service SMS'), /Service SMS : adresse refusée \(réseau interne\)/);
  assert.equal(seen.length, 1);
  const r = await publicFetch('https://api.example.com/b', { headers: { Authorization: 'Bearer k', 'X-Api-Key': 'k2', Accept: 'application/json' } }, 'Courier');
  assert.equal(r.status, 200);
  assert.equal(seen[2].url, 'https://cdn.example.net/b');
  assert.deepEqual(seen[2].headers, { Accept: 'application/json' });
});

test('the real call: refused on a private IP; on a private network (allowed) it answers, follows redirects and limits the size', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/go') {
      res.writeHead(302, { location: '/json' });
      return res.end();
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(5000));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization ?? null }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  try {
    await assert.rejects(publicFetch(`http://127.0.0.1:${port}/json`, {}, 'SMS'), /SMS : adresse refusée/);
    process.env.PILOTIX_ALLOW_PRIVATE_URLS = '1';
    const posted = await publicFetch(`http://127.0.0.1:${port}/json`, { method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: '{"a":1}' }, 'SMS');
    assert.deepEqual(await posted.json(), { method: 'POST', body: '{"a":1}', auth: 'Bearer x' });
    const moved = await publicFetch(`http://127.0.0.1:${port}/go`, { headers: { Authorization: 'Bearer x' } }, 'SMS');
    assert.equal(moved.url, `http://127.0.0.1:${port}/json`);
    assert.deepEqual(await moved.json(), { method: 'GET', body: '', auth: 'Bearer x' });
    await assert.rejects(publicFetch(`http://127.0.0.1:${port}/big`, { maxBytes: 1000 }, 'SMS'), /trop lourde/);
    const cut = await publicFetch(`http://127.0.0.1:${port}/big`, { maxBytes: 1000, truncate: true }, 'SMS');
    assert.equal((await cut.text()).length, 1000);
  } finally {
    srv.close();
  }
});

test('a name that points inside when the connection is made is refused (what is checked is what is connected to)', async () => {
  const dns = require('node:dns');
  const lookup = dns.lookup;
  // the name looks public, but its IP (given at connection time) is the server's own
  dns.lookup = (host: string, opts: any, cb: any) => (host === 'rebind.example.com' ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : lookup(host, opts, cb));
  try {
    await assert.rejects(publicFetch('http://rebind.example.com:9/x', {}, 'Service SMS'), /Service SMS : adresse refusée \(réseau interne\)/);
  } finally {
    dns.lookup = lookup;
  }
});

test('notifications go to the browsers\' push services only', () => {
  for (const u of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QG', 'https://wns2-par02p.notify.windows.com/w/?token=1'])
    assert.equal(pushServiceUrl(u), true, u);
  for (const u of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.dz/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.dz/fcm.googleapis.com', 'not a url'])
    assert.equal(pushServiceUrl(u), false, u);
});
