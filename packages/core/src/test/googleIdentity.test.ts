// « Continuer avec Google »: the server believes Google's proof only when Google says it was made for Pilotix's own app
// and the e-mail is proven — for the plain button's key ('access') as for the old button's ID token ('id').
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleIdentity } from '../platform';

const APP = '123-pilotix.apps.googleusercontent.com';

/** Google's answers, by address; every call written down */
function google(answers: Record<string, any>) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const get = async (url: string, headers?: Record<string, string>) => {
    calls.push({ url, headers });
    const key = Object.keys(answers).find((k) => url.startsWith(k));
    return key ? answers[key] : null;
  };
  return { get, calls };
}

const KEYINFO = 'https://oauth2.googleapis.com/tokeninfo?access_token=';
const IDINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

test('the plain button’s key: made for Pilotix, e-mail proven → the person, with the name from userinfo', async () => {
  const g = google({ [KEYINFO]: { aud: APP, azp: APP, sub: '42', email: 'nari@gmail.com', email_verified: 'true', expires_in: '3500' }, [USERINFO]: { sub: '42', name: 'Nari' } });
  assert.deepEqual(await googleIdentity('ya29.key', 'access', ` ${APP} `, g.get), { email: 'nari@gmail.com', name: 'Nari' });
  assert.equal(g.calls[0].url, `${KEYINFO}ya29.key`);
  assert.equal(g.calls[1].url, USERINFO);
  assert.deepEqual(g.calls[1].headers, { Authorization: 'Bearer ya29.key' });
});

test('a key another site got for the same person never opens Pilotix', async () => {
  const other = google({ [KEYINFO]: { aud: 'other-app', azp: 'other-app', sub: '42', email: 'nari@gmail.com', email_verified: 'true' } });
  assert.equal(await googleIdentity('ya29.key', 'access', APP, other.get), null);
  // nothing more is asked of Google once the app is wrong
  assert.equal(other.calls.length, 1);
  const azp = google({ [KEYINFO]: { aud: APP, azp: 'other-app', sub: '42', email: 'nari@gmail.com', email_verified: 'true' } });
  assert.equal(await googleIdentity('ya29.key', 'access', APP, azp.get), null);
});

test('no proven e-mail, an expired key, no app id: nobody', async () => {
  const unproven = google({ [KEYINFO]: { aud: APP, sub: '42', email: 'nari@gmail.com', email_verified: 'false' } });
  assert.equal(await googleIdentity('ya29.key', 'access', APP, unproven.get), null);
  const noMail = google({ [KEYINFO]: { aud: APP, sub: '42', email_verified: 'true' } });
  assert.equal(await googleIdentity('ya29.key', 'access', APP, noMail.get), null);
  // Google answers nothing for an expired or unknown key
  assert.equal(await googleIdentity('ya29.old', 'access', APP, google({}).get), null);
  const any = google({ [KEYINFO]: { aud: APP, sub: '42', email: 'nari@gmail.com', email_verified: 'true' } });
  assert.equal(await googleIdentity('ya29.key', 'access', '  ', any.get), null);
  assert.equal(any.calls.length, 0);
});

test('userinfo for someone else, or no answer: the person still enters, without a name', async () => {
  const info = { [KEYINFO]: { aud: APP, sub: '42', email: 'nari@gmail.com', email_verified: true } };
  assert.deepEqual(await googleIdentity('ya29.key', 'access', APP, google({ ...info, [USERINFO]: { sub: '7', name: 'Someone' } }).get), { email: 'nari@gmail.com', name: '' });
  assert.deepEqual(await googleIdentity('ya29.key', 'access', APP, google(info).get), { email: 'nari@gmail.com', name: '' });
});

test('the old button’s ID token: still checked as before (made for Pilotix, by Google)', async () => {
  const ok = google({ [IDINFO]: { aud: APP, iss: 'https://accounts.google.com', email: 'nari@gmail.com', email_verified: 'true', name: 'Nari' } });
  assert.deepEqual(await googleIdentity('eyJ.id.token', 'id', APP, ok.get), { email: 'nari@gmail.com', name: 'Nari' });
  assert.equal(ok.calls[0].url, `${IDINFO}eyJ.id.token`);
  const notGoogle = google({ [IDINFO]: { aud: APP, iss: 'https://evil.example', email: 'nari@gmail.com', email_verified: 'true' } });
  assert.equal(await googleIdentity('eyJ.id.token', 'id', APP, notGoogle.get), null);
  const otherApp = google({ [IDINFO]: { aud: 'other-app', iss: 'accounts.google.com', email: 'nari@gmail.com', email_verified: 'true' } });
  assert.equal(await googleIdentity('eyJ.id.token', 'id', APP, otherApp.get), null);
});
