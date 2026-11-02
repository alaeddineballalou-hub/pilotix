// Customers' voice notes: Claude cannot listen, so Google Gemini (Pilotix's own Google key, set in Pilot AI › Réglages)
// writes each one as text, the way the customer writes, before Dellal reads it. The webhook keeps where the audio is
// (WhatsApp media id, Messenger / Instagram link); the server fetches it and asks Gemini; the cost is counted for the shop
// with its Dellal answers. Not understood: Dellal asks the customer to write it, and the team can try again (« Écrire ce
// vocal »).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { parseMetaWebhook, readGemini, runDellal, voicePrompt } from '../dellal-server';
import { getRaw, setRaw } from '../modules/admin';
import { DELLAL_SECRETS } from '../modules/dellal';
import { savePilotConfig, voiceConfig, voiceKey } from '../platform/pilotai';
import { loadShop } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const GOOGLE = 'AIzaSyD-test-key-for-voice-notes-0123456';
let t: Tenancy;
let db: Db;
let pctx: PCtx;
let shop: Ctx;
const p = <T = any>(name: string, input: unknown = {}, as: PCtx = pctx) => platformCall(name, as, input) as Promise<T>;
const reqs: any[] = [];
let heard: (args: any) => any = () => ({ ok: true, text: 'wesh, ch7al la poussette ?', lang: 'dz', seconds: 4, model: 'gemini-flash-latest' });
const asked: any[] = [];
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args) => {
    if (action === 'transcribe') {
      asked.push(args);
      return heard(args);
    }
    if (action !== 'complete') return { ok: true };
    reqs.push(args);
    return { content: [{ type: 'text', text: 'La poussette b 12 900 DA 😊 Men ayya wilaya ?' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  },
};

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  pctx = { t, staff, now: () => Date.now() };
  db = t.shop('public');
  const s1 = (await loadShop(t, { primary: true }))!;
  const session = await login(db, OWNER.email, OWNER.password);
  shop = { db, session, now: () => Date.now(), emit: () => undefined, server: hooks, t, shop: { id: s1.id, slug: 'boutique', primary: true, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null } };
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-test-key-0123456789');
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), enabled: true }, Number(admin.id));
});

test('the webhook keeps where the voice note is: WhatsApp media id, Messenger / Instagram link', () => {
  const wa = parseMetaWebhook({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P1' }, contacts: [{ wa_id: '213661000001', profile: { name: 'Karim' } }], messages: [{ from: '213661000001', id: 'wamid.1', type: 'audio', audio: { id: 'MEDIA42', mime_type: 'audio/ogg; codecs=opus', voice: true } }] } }] }],
  });
  assert.equal(wa[0].text, '[message vocal envoyé]');
  assert.deepEqual(wa[0].media, { kind: 'audio', id: 'MEDIA42', mime: 'audio/ogg; codecs=opus' });
  const fb = parseMetaWebhook({ object: 'page', entry: [{ messaging: [{ sender: { id: 'U1' }, recipient: { id: 'PAGE' }, message: { mid: 'm1', attachments: [{ type: 'audio', payload: { url: 'https://cdn.fbsbx.com/v/t59/audioclip.mp4' } }] } }] }] });
  assert.deepEqual(fb[0].media, { kind: 'audio', url: 'https://cdn.fbsbx.com/v/t59/audioclip.mp4' });
  const text = parseMetaWebhook({ object: 'page', entry: [{ messaging: [{ sender: { id: 'U1' }, message: { mid: 'm2', text: 'salam' } }] }] });
  assert.equal(text[0].media, undefined);
});

test('Gemini’s answer: the text, the language, the length, the cost (audio dearer than text); the asked writing', () => {
  const r = readGemini(
    {
      candidates: [{ content: { parts: [{ text: '```json\n{"text": "wesh khouya, mazal kayen ?", "lang": "dz", "seconds": 3}\n```' }] } }],
      usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 30, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 96 }, { modality: 'TEXT', tokenCount: 304 }] },
    },
    'gemini-flash-latest',
  );
  assert.equal(r.text, 'wesh khouya, mazal kayen ?');
  assert.equal(r.lang, 'dz');
  assert.equal(r.seconds, 3);
  assert.equal(r.usd.toFixed(8), ((96 * 1.5 + 304 * 0.75 + 30 * 3.75) / 1e6).toFixed(8));
  // a plain answer still counts; the length from the audio tokens (32 a second)
  const plain = readGemini({ candidates: [{ content: { parts: [{ text: 'salam, ch7al ?' }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 10, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 160 }] } }, 'gemini-2.5-flash-lite');
  assert.equal(plain.text, 'salam, ch7al ?');
  assert.equal(plain.seconds, 5);
  assert.match(voicePrompt('latin'), /Latin letters with digits \(arabizi: 3 = ع, 7 = ح, 9 = ق/);
  assert.match(voicePrompt('arabic'), /Arabic letters, as Algerians write it \(not classical Arabic\)/);
});

test('Pilot AI › Réglages: voice notes on, a Google key (never shown), the model; managers only', async () => {
  await assert.rejects(p('p.pilot.voiceSave', { enabled: true, model: 'gemini-flash-latest', key: 'sk-ant-wrong' }), /Clé Google invalide/);
  await assert.rejects(p('p.pilot.voiceSave', { enabled: true, model: 'gemini flash!', key: GOOGLE }), /modèle/);
  const support = { ...pctx, staff: { ...pctx.staff, role: 'support' as const } };
  await assert.rejects(p('p.pilot.voiceSave', { enabled: true, model: 'gemini-flash-latest' }, support));
  const r: any = await p('p.pilot.voiceSave', { enabled: true, model: 'gemini-flash-latest', key: GOOGLE });
  assert.equal(r.enabled, true);
  assert.equal(r.hasKey, true);
  assert.equal(JSON.stringify(r).includes(GOOGLE), false, 'the key never travels back to the screen');
  assert.deepEqual(await voiceKey(t), { key: GOOGLE, model: 'gemini-flash-latest' });
  await p('p.pilot.voiceSave', { enabled: false, model: 'gemini-flash-latest' });
  assert.equal(await voiceKey(t), null, 'off: no key given');
  assert.equal((await voiceConfig(t)).hasKey, true, 'kept while off');
  await p('p.pilot.voiceSave', { enabled: true, model: 'gemini-flash-latest' });
});

test('the server: WhatsApp audio with the shop’s token, Gemini with Pilotix’s Google key, counted for the shop; Meta’s links only', async () => {
  const s1 = (await loadShop(t, { primary: true }))!;
  const ctx = { db, t, shop: { id: s1.id } as any, session: await login(db, OWNER.email, OWNER.password), now: () => Date.now(), emit: () => {} };
  await setRaw(db, DELLAL_SECRETS.waToken, 'EAAG-whatsapp-token');
  const real = globalThis.fetch;
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.startsWith('https://graph.facebook.com/')) return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=42', mime_type: 'audio/ogg' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.startsWith('https://lookaside.fbsbx.com/') || u.startsWith('https://cdn.fbsbx.com/')) return new Response(new Uint8Array([79, 103, 103, 83, 1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/ogg' } });
    if (u.startsWith('https://generativelanguage.googleapis.com/'))
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"text":"salam, b ch7al la poussette ?","lang":"dz","seconds":4}' }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 128 }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }) as any;
  try {
    const r: any = await runDellal('transcribe', { channel: 'whatsapp', media: { id: 'MEDIA42', mime: 'audio/ogg; codecs=opus' }, script: 'latin' }, ctx as any);
    assert.deepEqual(r, { ok: true, text: 'salam, b ch7al la poussette ?', lang: 'dz', seconds: 4, model: 'gemini-flash-latest' });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer EAAG-whatsapp-token');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer EAAG-whatsapp-token', 'WhatsApp’s file needs the token too');
    const g = calls[2];
    assert.match(g.url, /\/models\/gemini-flash-latest:generateContent$/);
    assert.equal(g.init.headers['x-goog-api-key'], GOOGLE);
    const body = JSON.parse(g.init.body);
    assert.equal(body.contents[0].parts[0].inline_data.mime_type, 'audio/ogg');
    assert.equal(body.contents[0].parts[0].inline_data.data, Buffer.from([79, 103, 103, 83, 1, 2, 3]).toString('base64'));
    // Messenger: Meta's link, nothing else
    const fb: any = await runDellal('transcribe', { channel: 'messenger', media: { url: 'https://cdn.fbsbx.com/v/t59/clip.mp4' } }, ctx as any);
    assert.equal(fb.ok, true);
    const bad: any = await runDellal('transcribe', { channel: 'messenger', media: { url: 'http://169.254.169.254/latest/meta-data' } }, ctx as any);
    assert.deepEqual(bad, { ok: false, error: 'bad_url' });
    // off: nothing fetched
    await p('p.pilot.voiceSave', { enabled: false, model: 'gemini-flash-latest' });
    const n = calls.length;
    assert.deepEqual(await runDellal('transcribe', { channel: 'whatsapp', media: { id: 'MEDIA43' } }, ctx as any), { ok: false, error: 'off' });
    assert.equal(calls.length, n);
    await p('p.pilot.voiceSave', { enabled: true, model: 'gemini-flash-latest' });
  } finally {
    globalThis.fetch = real;
  }
  const rows = await t.platform.query(`SELECT feature, model, payer, calls, usd FROM platform.ai_usage WHERE shop_id = $1 AND model LIKE 'gemini:%'`, [s1.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feature, 'dellal', 'counted with the shop’s Dellal answers');
  assert.equal(rows[0].payer, 'pilotix');
  assert.equal(Number(rows[0].calls), 2);
  assert.ok(Number(rows[0].usd) > 0);
  assert.equal((await p('p.pilot.voice')).today.calls, 2);
});

test('Dellal reads the voice note as text; not understood: it asks the customer to write it; the team can try again', async () => {
  const r: any = await call('dellal.receive', shop, { channel: 'whatsapp', externalId: '213661000077', text: '[message vocal envoyé]', messageId: 'wamid.v1', media: { kind: 'audio', id: 'MEDIA77', mime: 'audio/ogg' } });
  let m = (await db.query(`SELECT body, meta FROM conv_messages WHERE id = $1`, [r.messageId]))[0];
  assert.equal(m.meta.voice.status, 'pending');
  reqs.length = 0;
  await call('dellal.answer', shop, { id: r.conversationId });
  assert.equal(asked.at(-1).media.id, 'MEDIA77');
  assert.equal(asked.at(-1).script, 'latin');
  m = (await db.query(`SELECT body, meta FROM conv_messages WHERE id = $1`, [r.messageId]))[0];
  assert.equal(m.body, 'wesh, ch7al la poussette ?', 'the message is now what they said');
  assert.equal(m.meta.voice.status, 'done');
  assert.equal(m.meta.voice.seconds, 4);
  assert.match(JSON.stringify(reqs[0].messages), /\[message vocal, écrit en texte par l’IA[^\]]*\] wesh, ch7al la poussette \?/);

  // a customer who writes in Arabic letters: Gemini is asked for Arabic letters; not understood → Dellal asks to write it
  heard = () => ({ ok: false, error: 'Google Gemini : audio trop court' });
  await call('dellal.receive', shop, { channel: 'whatsapp', externalId: '213661000088', text: 'السلام عليكم', messageId: 'wamid.t1' });
  const v: any = await call('dellal.receive', shop, { channel: 'whatsapp', externalId: '213661000088', text: '[message vocal envoyé]', messageId: 'wamid.v2', media: { kind: 'audio', id: 'MEDIA88' } });
  reqs.length = 0;
  await call('dellal.answer', shop, { id: v.conversationId });
  assert.equal(asked.at(-1).script, 'arabic');
  m = (await db.query(`SELECT body, meta FROM conv_messages WHERE id = $1`, [v.messageId]))[0];
  assert.equal(m.meta.voice.status, 'failed');
  assert.equal(m.body, '[message vocal envoyé]');
  assert.match(JSON.stringify(reqs[0].messages), /message vocal que tu ne peux pas écouter : dis-le simplement et demande au client de l’écrire/);
  // the team tries again from Messages (« Écrire ce vocal »)
  await assert.rejects(call('dellal.voice.read', shop, { messageId: v.messageId }), /pas compris/);
  heard = () => ({ ok: true, text: 'واش كاين التوصيل لوهران ؟', lang: 'dz', seconds: 3, model: 'gemini-flash-latest' });
  const read: any = await call('dellal.voice.read', shop, { messageId: v.messageId });
  assert.equal(read.body, 'واش كاين التوصيل لوهران ؟');
  assert.equal(read.voice.status, 'done');
  // a typed message is not a voice note
  const typed = (await db.query(`SELECT id FROM conv_messages WHERE external_id = 'wamid.t1'`))[0].id;
  await assert.rejects(call('dellal.voice.read', shop, { messageId: Number(typed) }), /introuvable/);
});
