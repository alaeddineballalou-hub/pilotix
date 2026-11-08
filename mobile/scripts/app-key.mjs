// The Pilotix app's signing key, made by GitHub on every app build, the same each time, from a secret GitHub already
// keeps (the server key DEPLOY_SSH_KEY, given here as SEED). Nobody makes, copies or pastes a key.
// Why the same key: Android installs a new app over the old one only when both are signed by the same key.
// Never change VERSION, or the way the key is made: a new key means every phone installs the app again by hand once.
// It prints nothing but the certificate's fingerprint (public: any phone with the app can read it).
// Use: SEED=... node scripts/app-key.mjs <folder>  →  <folder>/key.pem and <folder>/cert.pem (then openssl makes the keystore)
import { checkPrimeSync, createHash, createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = 'pilotix android app key v1';
const folder = process.argv[2];
// spaces and line breaks don't count: the same server key saved again with other line ends gives the same app key
const seed = (process.env.SEED ?? '').replace(/\s+/g, '');
if (!folder || seed.length < 32) {
  console.error('app key: no folder or no seed');
  process.exit(1);
}
const root = createHmac('sha256', VERSION).update(seed).digest();

// n bytes that always come out the same for the same seed and label
function bytes(label, n) {
  const blocks = [];
  for (let i = 0; blocks.length * 32 < n; i++) blocks.push(createHmac('sha256', root).update(`${label}|${i}`).digest());
  return Buffer.concat(blocks).subarray(0, n);
}

const E = 65537n;
const big = (buf) => BigInt(`0x${buf.toString('hex')}`);
const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
function inverse(a, m) {
  let [r0, r1, s0, s1] = [((a % m) + m) % m, m, 1n, 0n];
  while (r1 !== 0n) {
    const k = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - k * r1, s1, s0 - k * s1];
  }
  if (r0 !== 1n) throw new Error('app key: no inverse');
  return ((s0 % m) + m) % m;
}

// the first prime from a fixed starting point: 1024 bits, top two bits set (so p·q has 2048 bits), p−1 not a multiple of E
function prime(label) {
  let c = big(bytes(label, 128)) | (3n << 1022n) | 1n;
  for (const top = 1n << 1024n; c < top; c += 2n) {
    if ((c - 1n) % E !== 0n && checkPrimeSync(c)) return c;
  }
  throw new Error('app key: no prime');
}

let p = prime('p');
let q = prime('q');
if (p === q) throw new Error('app key: same primes');
if (p < q) [p, q] = [q, p];
const n = p * q;
if (n.toString(2).length !== 2048) throw new Error('app key: wrong size');
const lambda = ((p - 1n) * (q - 1n)) / gcd(p - 1n, q - 1n);
const d = inverse(E, lambda);
const b64 = (x) => {
  const hex = x.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex').toString('base64url');
};
const key = createPrivateKey({
  format: 'jwk',
  key: { kty: 'RSA', n: b64(n), e: b64(E), d: b64(d), p: b64(p), q: b64(q), dp: b64(d % (p - 1n)), dq: b64(d % (q - 1n)), qi: b64(inverse(q, p)) },
});

// a self-signed certificate written byte by byte, so it is exactly the same on every build (fixed name, number and dates;
// an RSA signature is the same each time). Android compares these bytes between the old and the new app.
const len = (k) => (k < 0x80 ? [k] : k < 0x100 ? [0x81, k] : [0x82, k >> 8, k & 0xff]);
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag, ...len(body.length)]), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const algorithm = seq(Buffer.from('06092a864886f70d01010b0500', 'hex')); // sha256WithRSAEncryption, NULL
const name = seq(tlv(0x31, seq(Buffer.from('0603550403', 'hex'), tlv(0x0c, Buffer.from('Pilotix'))))); // CN=Pilotix
const tbs = seq(
  tlv(0x02, Buffer.from([0x01]), bytes('serial', 15)), // serial number
  algorithm,
  name, // issuer
  seq(tlv(0x17, Buffer.from('261101000000Z')), tlv(0x18, Buffer.from('20561101000000Z'))), // 1 Nov 2026 → 1 Nov 2056
  name, // subject
  createPublicKey(key).export({ type: 'spki', format: 'der' }),
);
const signature = sign('sha256', tbs, key);
if (!verify('sha256', tbs, createPublicKey(key), signature)) throw new Error('app key: bad signature');
const cert = seq(tbs, algorithm, tlv(0x03, Buffer.from([0x00]), signature));

const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
writeFileSync(join(folder, 'key.pem'), key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(join(folder, 'cert.pem'), pem('CERTIFICATE', cert), { mode: 0o600 });
const print = createHash('sha256').update(cert).digest('hex').toUpperCase().match(/../g).join(':');
console.log(`app key: certificate SHA-256 ${print}`);
