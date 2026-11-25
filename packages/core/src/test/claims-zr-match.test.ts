// Réclamations that match ZR's (owner, 25 Nov 2026: « réclamation should match ZR réclamation right »): the ones made in
// ZR's own app come into Pilotix; the shop's own messages (a relance sent from Pilotix, or written in ZR's app) are never
// taken for ZR's answer; the whole conversation is read, not only its last message; ZR's end decides « Résolue » or
// « Perdue »; and one closed in Pilotix while ZR still works on it says so.
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import type { ClaimFound, ClaimMessage, ClaimState, CourierCompany } from '../couriers/types';
import { claimEnd, zr } from '../couriers/zr';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

const company: CourierCompany = { id: 1, name: 'ZR', kind: 'zr', secret: { api_key: 'k', tenant: 't' }, settings: {}, statusMap: {}, shop: { name: 'Test', fromWilayaId: 16, fromWilaya: 'Alger' }, cacheKey: 'claims-test' } as CourierCompany;
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });

test('ZR’s end of a réclamation: locked and solved → Résolue; refused → Perdue; open → still open', () => {
  assert.deepEqual(claimEnd({ name: 'resolue', description: 'Résolue', isLocked: true }), { status: 'Résolue', closed: true, resolved: true, refused: false });
  assert.deepEqual(claimEnd({ name: 'rejetee', description: 'Rejetée', isLocked: true }), { status: 'Rejetée', closed: true, resolved: false, refused: true });
  assert.deepEqual(claimEnd({ name: 'en_cours', description: 'En cours de traitement', isLocked: false }), { status: 'En cours de traitement', closed: false, resolved: false, refused: false });
  // ZR's real end (25 Nov 2026): « Traitée », not locked; « en traitement » is not an end
  assert.deepEqual(claimEnd({ name: 'traitee', description: 'Traitée', isLocked: false }), { status: 'Traitée', closed: true, resolved: true, refused: false });
  assert.equal(claimEnd({ name: 'en_traitement', description: 'Réclamation en traitement', isLocked: false }).closed, false);
  assert.equal(claimEnd({ name: 'en_attente_de_traitement', description: 'En attente de traitement', isLocked: false }).closed, false);
  // a locked state with other words is the end of ZR's work too
  assert.equal(claimEnd({ name: 'x', description: 'Faite', isLocked: true }).resolved, true);
});

test('ZR’s API: its réclamations newest first (also those made in its app), back to the last look only', async () => {
  const seen: any[] = [];
  globalThis.fetch = (async (u: string, o: any = {}) => {
    const path = String(u).replace(/^.*\/api\/v1/, '');
    const body = o.body ? JSON.parse(o.body) : null;
    seen.push({ path, body });
    if (path === '/claims/search' && body.pageNumber > 1) return json({ items: [], hasNext: false });
    if (path === '/claims/search')
      return json({
        items: [
          { id: 'c-new-1234', title: 'Colis bloqué', description: 'Le client attend', parcel: { id: 'p1', trackingNumber: '16-AAA-ZR' }, state: { name: 'nouvelle', description: 'Nouvelle', isLocked: false }, category: { name: 'Retard de livraison' }, createdAt: '2026-11-24T10:00:00Z' },
          { id: 'c-old-5678', parcel: { id: 'p2', trackingNumber: '16-BBB-ZR' }, state: { name: 'rejetee', description: 'Rejetée', isLocked: true }, category: { name: 'Autre' }, createdAt: '2026-11-20T10:00:00Z' },
        ],
        hasNext: true,
      });
    return json({}, 404);
  }) as typeof fetch;
  const all = await zr.claimList!(company, null);
  assert.equal(all.length, 2);
  assert.deepEqual(
    { id: all[0].extId, ref: all[0].extRef, cat: all[0].category, tracking: all[0].tracking, parcel: all[0].parcelExtId, closed: all[0].closed },
    { id: 'c-new-1234', ref: '16-AAA-ZR', cat: 'Retard de livraison', tracking: '16-AAA-ZR', parcel: 'p1', closed: false },
  );
  assert.equal(all[1].refused, true);
  assert.deepEqual(seen[0].body.orderBy, ['createdAt desc']);
  // back to the last look: an older one ends the reading (no second page)
  seen.length = 0;
  const recent = await zr.claimList!(company, '2026-11-22T00:00:00Z');
  assert.deepEqual(recent.map((x) => x.extId), ['c-new-1234']);
  assert.equal(seen.length, 1);
});

test('ZR’s API: the whole conversation of a réclamation, oldest first, with who wrote each message; a sent message gives its id', async () => {
  globalThis.fetch = (async (u: string, o: any = {}) => {
    const path = String(u).replace(/^.*\/api\/v1/, '');
    if (path === '/claims/c1') return json({ id: 'c1', state: { name: 'en_cours', description: 'En cours', isLocked: false }, lastModifiedAt: '2026-11-24T12:00:00Z' });
    if (path === '/claim-comments/c1/search')
      return json({
        items: [
          { id: 'm2', content: 'Nous vérifions avec le hub', modifiedBy: { id: 'zr-agent', fullName: 'Amina (ZR)' }, createdAt: '2026-11-24T11:00:00Z' },
          { id: 'm1', content: 'Toujours rien ?', modifiedBy: { id: 'shop', fullName: 'Baby Joy' }, createdAt: '2026-11-24T09:00:00Z' },
          { id: 'm0', content: '  ', modifiedBy: { id: 'shop' }, createdAt: '2026-11-24T08:00:00Z' },
        ],
        hasNext: false,
      });
    if (path === '/claim-comments/c1' && o.method === 'PATCH') return json({ id: 'm3' });
    return json({}, 404);
  }) as typeof fetch;
  const [st] = await zr.claimStates!(company, ['c1']);
  assert.deepEqual(
    st.messages!.map((m: ClaimMessage) => [m.id, m.byId, m.text]),
    [
      ['m1', 'shop', 'Toujours rien ?'],
      ['m2', 'zr-agent', 'Nous vérifions avec le hub'],
    ],
  );
  assert.equal(st.closed, false);
  assert.equal(await zr.claimComment!(company, 'c1', 'Merci de relancer'), 'm3');
});

test('a réclamation sent to ZR: ZR’s own category for our reason, its parcel number as ZR’s reference, the category kept', async () => {
  // ZR's 12 categories as its app lists them (25 Nov 2026)
  const names = ['Accélération de la commande', "Accélération d'encaissement", 'Annulation de la commande', 'Autre', 'Colis endommagé', 'Colis perdu', 'Demande de retour', "Demande d'information", 'Mise à jour des situations ', 'Relancer un colis', 'Reporter un colis ', 'Retard de livraison'];
  const sent: any[] = [];
  globalThis.fetch = (async (u: string, o: any = {}) => {
    const path = String(u).replace(/^.*\/api\/v1/, '');
    const body = o.body ? JSON.parse(o.body) : null;
    if (path === '/claim-categories/search') return json({ items: names.map((name, k) => ({ id: `cat-${k}`, name })), hasNext: false });
    if (path === '/claims') return sent.push(body), json({ id: `zr-${sent.length}` });
    if (path.startsWith('/claims/')) return json({ id: 'x', state: { name: 'en_attente_de_traitement', description: 'En attente de traitement', isLocked: false } });
    return json({}, 404);
  }) as typeof fetch;
  const c = { ...company, cacheKey: 'claims-cats-test' } as CourierCompany;
  const pick = async (reason: string, reasonText: string) => {
    const r = await zr.claim!(c, { ref: 'REC-1', item: { id: 1, tracking: '16-ABC-ZR', extId: 'parcel-1' }, reason, reasonText, categoryId: null, description: 'x' });
    return { cat: names[Number(String(sent[sent.length - 1].categoryId).slice(4))].trim(), r };
  };
  const late = await pick('late', 'Retard de livraison');
  assert.equal(late.cat, 'Retard de livraison');
  assert.deepEqual({ ref: late.r.extRef, category: late.r.category, status: late.r.status }, { ref: '16-ABC-ZR', category: 'Retard de livraison', status: 'En attente de traitement' });
  assert.equal((await pick('relivrer', 'Relivrer le colis')).cat, 'Relancer un colis');
  assert.equal((await pick('nocall', 'Le livreur n’a pas appelé le client')).cat, 'Relancer un colis');
  assert.equal((await pick('money', 'Problème de versement')).cat, "Accélération d'encaissement");
  assert.equal((await pick('damaged', 'Colis endommagé')).cat, 'Colis endommagé');
  assert.equal((await pick('noreturn', 'Retour non reçu')).cat, 'Demande de retour');
  assert.equal((await pick('fakedeliv', 'Faux statut « livré »')).cat, 'Mise à jour des situations');
  assert.equal((await pick('other', 'Autre')).cat, 'Autre');
});

/** A fake server: ZR's réclamations and their conversations, as the test sets them (ZR's ids never repeat). */
let n = 0;
function fakeZr() {
  const states = new Map<string, ClaimState>();
  let list: ClaimFound[] = [];
  const server = {
    courier: async (action: string, args: any) => {
      if (action === 'claim') return { extId: `zr-claim-${++n}`, extRef: args.claim.item.tracking, status: 'En attente de traitement', category: 'Relancer un colis' };
      if (action === 'claimComment') return { ok: true, extId: `msg-ours-${++n}` };
      if (action === 'claimList') return list;
      if (action === 'claimStates') return (args.extIds as string[]).map((x) => states.get(x) ?? { extId: x, status: 'Nouvelle', resolved: false, closed: false, messages: [] });
      if (action === 'claimCategories') return [{ id: 'cat-1', name: 'Retard de livraison' }];
      return null;
    },
    meta: async () => null,
    hashPassword: async (s: string) => s,
    publicUrl: 'https://pilotix.example',
  } as unknown as Ctx['server'];
  return { server, states, setList: (x: ClaimFound[]) => (list = x) };
}

const zrId = async () => Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' ORDER BY id LIMIT 1`))[0].id);
const used = new Set<number>();
/** A ZR parcel on the road with its number, and no réclamation yet. */
async function zrParcel() {
  const r = (await db.query(`SELECT o.id FROM orders o WHERE o.shipped_at IS NOT NULL AND NOT (o.id = ANY($1)) AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.order_id = o.id) ORDER BY o.id DESC LIMIT 1`, [[...used]]))[0];
  const id = Number(r.id);
  used.add(id);
  await db.query(`UPDATE orders SET company_id = $2, follow_status = 'alert', tracking = $3, ext_id = $4 WHERE id = $1`, [id, await zrId(), `16-CLM${id}-ZR`, `zr-parcel-${id}`]);
  return id;
}
const found = (x: Partial<ClaimFound> & { extId: string }): ClaimFound => ({ extRef: x.extId.slice(0, 8).toUpperCase(), category: null, title: null, description: null, tracking: null, parcelExtId: null, createdAt: '2026-11-24T08:00:00Z', status: 'Nouvelle', closed: false, resolved: false, refused: false, ...x });
const msg = (id: string, byId: string, text: string, at: string, by = byId === 'shop-account' ? 'Baby Joy' : 'Agent ZR'): ClaimMessage => ({ id, byId, by, text, at });

test('our relance is never ZR’s answer; ZR’s message is, until the shop writes again (from Pilotix or in ZR’s app)', async () => {
  const zrFake = fakeZr();
  const admin = await as(EMAILS.admin, zrFake.server);
  const oid = await zrParcel();
  const c: any = await call('suivi.claimCreate', admin, { orderId: oid, reason: 'late', details: 'Bloqué', message: 'Bonjour…', categoryId: 'cat-1' });
  assert.ok(c.extId);
  assert.deepEqual({ ref: c.extRef, category: c.extCategory }, { ref: c.tracking, category: 'Relancer un colis' }, 'ZR’s parcel number and ZR’s category');
  const rem: any = await call('suivi.claimRemind', admin, { id: c.id, text: 'Toujours pas de solution, merci.' });
  const sentId = rem.notes[rem.notes.length - 1].ext.id;
  assert.ok(sentId, 'ZR’s id for our relance is kept');
  // ZR's conversation holds only our relance: it is not an answer
  zrFake.states.set(c.extId, { extId: c.extId, status: 'En cours', resolved: false, closed: false, messages: [msg(sentId, 'shop-account', 'Toujours pas de solution, merci.', new Date(Date.now() - 60_000).toISOString())] });
  await call('suivi.claimSync', admin, {});
  let now: any = (await call('suivi.claims', admin, { orderId: oid })).rows[0];
  assert.equal(now.extAnswer, null, 'our own relance is not « la dernière réponse de ZR »');
  assert.notEqual(now.stage, 'answered');
  assert.equal(now.notes.filter((n: any) => n.ext?.id === sentId).length, 1, 'the relance stays one line');
  // ZR answers: « Réponse reçue », with ZR's words in the history
  zrFake.states.get(c.extId)!.messages!.push(msg('zr-1', 'zr-agent', 'Nous vérifions avec le hub.', new Date(Date.now() + 1_000).toISOString()));
  await call('suivi.claimSync', admin, {});
  now = (await call('suivi.claims', admin, { orderId: oid })).rows[0];
  assert.equal(now.stage, 'answered');
  assert.equal(now.extAnswer, 'Agent ZR : Nous vérifions avec le hub.');
  assert.ok(now.notes.some((n: any) => /^ZR Express \(Agent ZR\) : Nous vérifions/.test(n.text)));
  // the shop writes back in ZR's app, with the same account: its message, not an answer; ZR's last answer is kept
  zrFake.states.get(c.extId)!.messages!.push(msg('shop-2', 'shop-account', 'Le client attend toujours.', new Date(Date.now() + 2_000).toISOString()));
  await call('suivi.claimSync', admin, {});
  now = (await call('suivi.claims', admin, { orderId: oid })).rows[0];
  assert.notEqual(now.stage, 'answered');
  assert.equal(now.extAnswer, 'Agent ZR : Nous vérifions avec le hub.');
  assert.ok(now.notes.some((n: any) => n.ext?.mine && /^Vous, dans l’espace ZR Express : Le client attend/.test(n.text)));
  // ZR writes twice between two looks: both are kept
  zrFake.states.get(c.extId)!.messages!.push(msg('zr-2', 'zr-agent', 'Le hub a le colis.', new Date(Date.now() + 3_000).toISOString()), msg('zr-3', 'zr-agent', 'Livraison demain.', new Date(Date.now() + 4_000).toISOString()));
  await call('suivi.claimSync', admin, {});
  now = (await call('suivi.claims', admin, { orderId: oid })).rows[0];
  assert.ok(now.notes.some((n: any) => /Le hub a le colis/.test(n.text)) && now.notes.some((n: any) => /Livraison demain/.test(n.text)));
  assert.equal(now.extAnswer, 'Agent ZR : Livraison demain.');
});

test('a relance sent before ZR’s ids were kept is still known as ours (the old « Dernière réponse » mistake)', async () => {
  const zrFake = fakeZr();
  const admin = await as(EMAILS.admin, zrFake.server);
  const oid = await zrParcel();
  const c: any = await call('suivi.claimCreate', admin, { orderId: oid, reason: 'late', message: 'Bonjour…' });
  // the line as the old version wrote it: no ZR id; ZR shows it back as the last comment
  const old = [...c.notes, { at: new Date().toISOString(), userId: 1, text: 'Relance envoyée à ZR (API) : Merci de nous répondre.', status: null }];
  await db.query('UPDATE claims SET notes = $2, ext_answer = $3 WHERE id = $1', [c.id, JSON.stringify(old), 'Baby Joy : Merci de nous répondre.']);
  zrFake.states.set(c.extId, { extId: c.extId, status: 'En cours', resolved: false, closed: false, messages: [msg('old-1', 'shop-account', 'Merci de nous répondre.', new Date().toISOString())] });
  await call('suivi.claimSync', admin, {});
  const now: any = (await call('suivi.claims', admin, { orderId: oid })).rows[0];
  assert.equal(now.extAnswer, null);
  assert.notEqual(now.stage, 'answered');
});

test('réclamations made in ZR’s app come into Pilotix when their parcel is a Pilotix parcel, with ZR’s category, only once', async () => {
  const zrFake = fakeZr();
  const admin = await as(EMAILS.admin, zrFake.server);
  const oid = await zrParcel();
  const oid2 = await zrParcel();
  const [tracking, tracking2] = await Promise.all([oid, oid2].map(async (x) => (await db.query('SELECT tracking FROM orders WHERE id = $1', [x]))[0].tracking));
  zrFake.setList([
    found({ extId: 'zr-app-1', extRef: tracking, category: 'Relancer un colis', description: 'Le client attend depuis 4 jours', tracking }),
    // a parcel from before Pilotix: stays at ZR only (owner's choice)
    found({ extId: 'zr-app-2', category: 'Autre', tracking: '05-NOTINPILOTIX-ZR' }),
    // ZR's end, « Traitée »: closed here too
    found({ extId: 'zr-app-3', extRef: tracking2, category: 'Colis endommagé', tracking: tracking2, closed: true, resolved: true, status: 'Traitée' }),
  ]);
  const r: any = await call('suivi.claimSync', admin, {});
  assert.equal(r.added, 2);
  const rows = (await call('suivi.claims', admin, { pageSize: 500 })).rows.filter((x: any) => /^zr-app-/.test(x.extId ?? ''));
  assert.deepEqual(rows.map((x: any) => x.extId).sort(), ['zr-app-1', 'zr-app-3']);
  const one = rows.find((x: any) => x.extId === 'zr-app-1');
  assert.deepEqual(
    { order: one.orderId, origin: one.origin, reason: one.reason, status: one.status, details: one.details, ref: one.extRef, category: one.extCategory },
    { order: oid, origin: 'courier', reason: 'relivrer', status: 'waiting', details: 'Le client attend depuis 4 jours', ref: tracking, category: 'Relancer un colis' },
  );
  assert.match(one.notes[0].text, /^Créée dans l’espace ZR Express · Relancer un colis/);
  const three = rows.find((x: any) => x.extId === 'zr-app-3');
  assert.deepEqual({ status: three.status, reason: three.reason, closed: three.extClosed }, { status: 'resolved', reason: 'damaged', closed: true });
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND note LIKE 'Réclamation %créée dans l’espace ZR%'`, [oid]);
  assert.equal(ev.length, 1);
  // the next look: nothing twice
  const again: any = await call('suivi.claimSync', admin, {});
  assert.equal(again.added, 0);
  // deleted in Pilotix: never brought back from ZR
  await call('suivi.claimDelete', admin, { id: one.id });
  const after: any = await call('suivi.claimSync', admin, {});
  assert.equal(after.added, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM claims WHERE ext_id = 'zr-app-1'`))[0].n, 0);
});

test('ZR’s categories give our reasons', async () => {
  const zrFake = fakeZr();
  const admin = await as(EMAILS.admin, zrFake.server);
  const cases: [string, string][] = [
    ['Accélération de la commande', 'late'],
    ["Accélération d'encaissement", 'money'],
    ['Retard de livraison', 'late'],
    ['Reporter un colis ', 'relivrer'],
    ['Demande de retour', 'noreturn'],
    ['Colis perdu', 'other'],
    ['Mise à jour des situations ', 'other'],
  ];
  const list: ClaimFound[] = [];
  for (const [k, [cat]] of cases.entries()) {
    const o = await zrParcel();
    const t = (await db.query('SELECT tracking FROM orders WHERE id = $1', [o]))[0].tracking;
    list.push(found({ extId: `zr-cat-${k}`, category: cat, tracking: t }));
  }
  zrFake.setList(list);
  await call('suivi.claimSync', admin, {});
  const rows = (await call('suivi.claims', admin, { pageSize: 500 })).rows.filter((x: any) => /^zr-cat-/.test(x.extId ?? ''));
  for (const [k, [cat, reason]] of cases.entries()) {
    const row = rows.find((x: any) => x.extId === `zr-cat-${k}`);
    assert.deepEqual({ cat: row.extCategory, reason: row.reason }, { cat: cat.trim(), reason }, cat);
  }
});

test('closed by ZR: « Résolue » or « Perdue » (refused); closed in Pilotix while ZR still works on it: shown, and followed until ZR closes it', async () => {
  const zrFake = fakeZr();
  const admin = await as(EMAILS.admin, zrFake.server);
  const a = await zrParcel();
  const b = await zrParcel();
  const ca: any = await call('suivi.claimCreate', admin, { orderId: a, reason: 'damaged', message: 'Bonjour…' });
  const cb: any = await call('suivi.claimCreate', admin, { orderId: b, reason: 'late', message: 'Bonjour…' });
  zrFake.states.set(ca.extId, { extId: ca.extId, status: 'Rejetée', resolved: false, refused: true, closed: true, messages: [] });
  await call('suivi.claimSync', admin, {});
  const ra: any = (await call('suivi.claims', admin, { orderId: a })).rows[0];
  assert.deepEqual({ status: ra.status, closed: ra.extClosed, words: ra.extStatus }, { status: 'lost', closed: true, words: 'Rejetée' });
  assert.match(ra.notes[ra.notes.length - 1].text, /Fermée par ZR Express : Perdue/);
  // the agent closes b in Pilotix; ZR still works on it
  await call('suivi.claimUpdate', admin, { id: cb.id, status: 'resolved' });
  zrFake.states.set(cb.extId, { extId: cb.extId, status: 'En cours', resolved: false, closed: false, messages: [] });
  const s1: any = await call('suivi.claimSync', admin, {});
  let rb: any = (await call('suivi.claims', admin, { orderId: b })).rows[0];
  assert.deepEqual({ status: rb.status, closed: rb.extClosed }, { status: 'resolved', closed: false });
  assert.ok(s1.checked >= 1);
  // ZR closes it later: Pilotix knows, and keeps the agent's own decision
  zrFake.states.set(cb.extId, { extId: cb.extId, status: 'Résolue', resolved: true, closed: true, messages: [] });
  await call('suivi.claimSync', admin, {});
  rb = (await call('suivi.claims', admin, { orderId: b })).rows[0];
  assert.deepEqual({ status: rb.status, closed: rb.extClosed, words: rb.extStatus }, { status: 'resolved', closed: true, words: 'Résolue' });
});
