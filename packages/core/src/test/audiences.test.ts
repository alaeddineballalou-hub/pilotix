// Pilot Ads › Audiences: a list of phones Meta already has is replaced each night (Meta's « replace », never « add »),
// Meta still working on it is no error, one deleted there is made again; what a failed sending leaves in use; and the
// way out said when Meta refuses a new ad set for one of the lists. (The two lists Meta fills by itself: pilotads.test.)
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { runMeta } from '../meta';
import { META_TOKEN_KEY, setRaw } from '../modules/admin';
import { audienceRefusal } from '../modules/adslaunch';
import { audienceIds, syncAudiences } from '../modules/adsmgr';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(220));
  // the shop's ad account and its connection (Pilot AI › Comptes)
  await setRaw(db, META_TOKEN_KEY, 'tok');
  await setRaw(db, 'meta', { adAccountId: '123', hasToken: true });
});
const owner = (server?: Ctx['server']) => as(EMAILS.vendeur, server);

// ---------------------------------------------------------------- Meta itself (meta.ts), its answers made up
const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});
type MetaCall = { method: string; path: string; body: Record<string, any> };
/** Meta as these tests see it: every call kept (its path, what it carries), answered by `answer` */
function fakeMeta(answer: (c: MetaCall) => { status?: number; json: unknown }): MetaCall[] {
  const calls: MetaCall[] = [];
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const url = new URL(String(u));
    const body: Record<string, any> = {};
    for (const [k, v] of init.body instanceof URLSearchParams ? init.body : url.searchParams)
      try {
        body[k] = JSON.parse(v);
      } catch {
        body[k] = v;
      }
    const c: MetaCall = { method: String(init.method ?? 'GET'), path: url.pathname.replace(/^\/v[\d.]+\//, ''), body };
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
const refusal = (code: number, subcode: number | null, message: string) => ({ status: 400, json: { error: { code, error_subcode: subcode ?? undefined, message } } });

test('a new list of phones is made and filled; the numbers leave hashed', async () => {
  const calls = fakeMeta((c) => (c.path.endsWith('/customaudiences') ? { json: { id: '900' } } : { json: { num_received: 2 } }));
  const r = await runMeta('audience', { name: 'Pilotix · faux numéros', metaId: null, phones: ['213661000001', '213661000002'] }, await owner());
  assert.deepEqual(r, { id: '900', received: 2 });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST act_123/customaudiences', 'POST 900/users']);
  assert.equal(calls[0].body.name, 'Pilotix · faux numéros');
  assert.equal(calls[0].body.subtype, 'CUSTOM');
  assert.equal(calls[1].body.session, undefined, 'a first filling is no replace');
  assert.deepEqual(calls[1].body.payload.schema, ['PHONE']);
  assert.equal(calls[1].body.payload.data.length, 2);
  for (const row of calls[1].body.payload.data) assert.match(row[0], /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(calls[1].body).includes('213661000001'), 'never in clear');
});

test('a list Meta already has is replaced, never added to: one session, 10 000 numbers a batch', async () => {
  const phones = Array.from({ length: 10_001 }, (_, k) => `2136${String(k).padStart(8, '0')}`);
  const calls = fakeMeta((c) => ({ json: { num_received: c.body.session.batch_seq === 1 ? 10_000 : 10_001 } }));
  const r = await runMeta('audience', { name: 'Pilotix · retours', metaId: '900', phones }, await owner());
  assert.deepEqual(r, { id: '900', received: 10_001 });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST 900/usersreplace', 'POST 900/usersreplace'], 'no « add » (900/users): Meta says it may send the ad sets back to learning');
  const [a, b] = calls.map((c) => c.body.session);
  assert.ok(Number.isSafeInteger(a.session_id) && a.session_id > 0);
  assert.equal(b.session_id, a.session_id, 'one session for the whole list');
  assert.deepEqual([a.batch_seq, a.last_batch_flag, b.batch_seq, b.last_batch_flag], [1, false, 2, true]);
  assert.equal(a.estimated_num_total, 10_001);
  assert.deepEqual(calls.map((c) => c.body.payload.data.length), [10_000, 1]);
});

test('Meta still working on the list is not an error; a list deleted in Meta is made again; another refusal is said', async () => {
  fakeMeta(() => refusal(2650, 1870145, 'Audience Update In Progress'));
  assert.deepEqual(await runMeta('audience', { metaId: '900', phones: ['213661000001'] }, await owner()), { id: '900', received: 0, busy: true });

  const calls = fakeMeta((c) => (c.path === '900/usersreplace' ? refusal(100, 33, 'Unsupported post request. Object with ID 900 does not exist') : c.path.endsWith('/customaudiences') ? { json: { id: '901' } } : { json: { num_received: 1 } }));
  assert.deepEqual(await runMeta('audience', { name: 'Pilotix · retours', metaId: '900', phones: ['213661000001'] }, await owner()), { id: '901', received: 1, remade: true });
  assert.deepEqual(calls.map((c) => c.path), ['900/usersreplace', 'act_123/customaudiences', '901/users']);

  fakeMeta(() => refusal(2650, 1870148, 'Something Went Wrong'));
  await assert.rejects(runMeta('audience', { metaId: '900', phones: ['213661000001'] }, await owner()), /Meta : Something Went Wrong/);
});

test('Meta refusing a new ad set for one of the lists: the way out is said (the other refusals stay as Meta wrote them)', () => {
  const lists = { excludeAudiences: ['771'], includeAudiences: [] };
  assert.match(audienceRefusal('Meta : Custom audience 771 is too small to be used', lists), /too small to be used · Meta refuse une de vos audiences : éteignez-la dans Publicité › Audiences/);
  assert.match(audienceRefusal('Meta : L’audience personnalisée n’est pas disponible', lists), /éteignez-la/);
  assert.equal(audienceRefusal('Meta : Advantage+ audience needs age_max 65', lists), 'Meta : Advantage+ audience needs age_max 65');
  assert.equal(audienceRefusal('Meta : Budget too low', lists), 'Meta : Budget too low');
  assert.equal(audienceRefusal('Meta : Custom audience 771 is too small', { excludeAudiences: [], includeAudiences: [] }), 'Meta : Custom audience 771 is too small', 'a launch without lists');
});

// ---------------------------------------------------------------- the lists of the shop (adsmgr.ts), the server made up
/** the server's Meta hook: every call kept, answered by `reply` (the id Meta gives a list) */
function fakeServer(reply: (action: string, args: any) => unknown) {
  const sent: { action: string; args: any }[] = [];
  const server: Ctx['server'] = {
    courier: async () => ({}),
    hashPassword: async (p) => p,
    meta: async (action: string, args: any) => {
      sent.push({ action, args });
      return reply(action, args);
    },
  };
  return { sent, server };
}
const row = async (kind: string) => (await db.query(`SELECT * FROM ad_audiences WHERE kind = $1`, [kind]))[0];
test('a sending that fails keeps a list Meta already has in use; a list never made is an error', async () => {
  await call('ads.aud.save', await owner(), { kind: 'buyers', on: true });
  await db.query(`UPDATE ad_audiences SET meta_id = NULL WHERE kind = 'buyers'`);
  const { sent, server } = fakeServer((action, args) => {
    if (action === 'eventAudience') return { id: args.metaId ?? '775' };
    throw new Error('Meta : Something Went Wrong');
  });
  await syncAudiences(await owner(server));
  const phones = sent.filter((x) => x.action === 'audience');
  assert.deepEqual(phones.map((x) => x.args.name).sort(), ['Pilotix · clients livrés', 'Pilotix · faux numéros', 'Pilotix · retours']);
  assert.equal(phones.find((x) => x.args.name === 'Pilotix · retours')!.args.metaId, '23851000000000001', 'the list Meta has is the one replaced');
  assert.ok(phones.every((x) => x.args.phones.length > 0 && x.args.phones.every((p: string) => /^213[5-7]\d{8}$/.test(p))));
  const ret = await row('returners');
  assert.deepEqual([ret.meta_id, ret.status, ret.error], ['23851000000000001', 'ready', 'Meta : Something Went Wrong']);
  const buyers = await row('buyers');
  assert.deepEqual([buyers.meta_id, buyers.status, buyers.error], [null, 'failed', 'Meta : Something Went Wrong']);
  const ids = await audienceIds(db);
  assert.ok(ids.exclude.includes('23851000000000001') && ids.exclude.includes('23851000000000002'), 'the next ad sets still leave them out');
  // Meta still working on a list (nothing sent tonight): the list stays in use, its card says so
  const busy = fakeServer((action, args) => (action === 'audience' && args.metaId ? { id: args.metaId, received: 0, busy: true } : { id: args.metaId ?? '775' }));
  await db.query(`UPDATE ad_audiences SET is_on = false WHERE kind = 'buyers'`);
  await syncAudiences(await owner(busy.server));
  const stuck = await row('returners');
  assert.deepEqual([stuck.meta_id, stuck.status], ['23851000000000001', 'ready']);
  assert.match(stuck.error, /Meta n’a pas fini la dernière mise à jour/);
  assert.ok((await audienceIds(db)).exclude.includes('23851000000000001'));
  await db.query(`UPDATE ad_audiences SET is_on = true WHERE kind = 'buyers'`);
  // the next night Meta takes them: the error goes
  const ok = fakeServer((action, args) => ({ id: args.metaId ?? '881' }));
  await syncAudiences(await owner(ok.server));
  assert.deepEqual([(await row('returners')).error, (await row('buyers')).meta_id, (await row('buyers')).status], [null, '881', 'ready']);
  await call('ads.aud.save', await owner(), { kind: 'buyers', on: false });
});

test('the owner adds numbers to a list himself (a start from his former tool): kept once, sent with the shop’s own, taken out again', async () => {
  const { phonesIn } = await import('../modules/adsmgr');
  assert.deepEqual(phonesIn('Nom;Tel\nKarim;0555 12 34 56\nSara;+213 661-23-45-67\nx;00213770000001\ny;0555123456\nfixe;021 23 45 67\nz;0412345678'), ['213555123456', '213661234567', '213770000001']);
  await assert.rejects(call('ads.aud.add', await as(EMAILS.marketer), { kind: 'returners', text: '0555123456' }), /Accès refusé/);
  await assert.rejects(call('ads.aud.add', await owner(), { kind: 'returners', text: 'rien ici 021234567' }), /Aucun numéro algérien/);
  const a: any = await call('ads.aud.add', await owner(), { kind: 'returners', text: '0799000001\n0799000002\n0799000001' });
  assert.deepEqual([a.found, a.added, a.added_by_kind.returners], [2, 2, 2]);
  const b: any = await call('ads.aud.add', await owner(), { kind: 'returners', text: '0799000002, 0799000003' });
  assert.deepEqual([b.found, b.added, b.added_by_kind.returners], [2, 1, 3], 'a number already there is not counted twice');
  assert.equal(((await call('ads.aud.list', await owner(), {})) as any).added_by_kind.returners, 3);
  // the next update sends them with the shop's own returners, the other lists do not get them
  const { sent, server } = fakeServer((action, args) => ({ id: args.metaId ?? '990' }));
  await syncAudiences(await owner(server));
  const ret = sent.find((x) => x.action === 'audience' && x.args.name === 'Pilotix · retours')!;
  for (const p of ['213799000001', '213799000002', '213799000003']) assert.ok(ret.args.phones.includes(p), p);
  assert.equal(new Set(ret.args.phones).size, ret.args.phones.length, 'each number once');
  const fake = sent.find((x) => x.action === 'audience' && x.args.name === 'Pilotix · faux numéros')!;
  assert.ok(!fake.args.phones.includes('213799000001'));
  // a number added more than a year ago no longer counts
  await db.query(`UPDATE ad_audience_phones SET added_at = now() - interval '400 days' WHERE phone = '213799000003'`);
  assert.equal(((await call('ads.aud.list', await owner(), {})) as any).added_by_kind.returners, 2);
  // « Retirer mes numéros »
  const c: any = await call('ads.aud.add', await owner(), { kind: 'returners', clear: true });
  assert.deepEqual([c.removed, c.added_by_kind.returners ?? 0], [3, 0]);
  sent.length = 0;
  await syncAudiences(await owner(server));
  assert.ok(!sent.find((x) => x.action === 'audience' && x.args.name === 'Pilotix · retours')!.args.phones.includes('213799000001'));
});
