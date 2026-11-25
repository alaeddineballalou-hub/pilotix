// Réclamations to a delivery company with no réclamation API that takes notes on a parcel (EcoTrack, NOEST, Zimou): the
// réclamation also goes there as a note (owner, 25 Nov 2026: the control room said « Pilotix envoie une note à la
// place », the Réclamation button did not). WhatsApp stays: the first message after the note is not a relance.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { courierCatalog } from '../couriers/catalog';
import { KINDS } from '../couriers/kinds';
import { CLAIM_NOTE_MAX, claimNoteText } from '../modules/suivi';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

/** A fake server: what Pilotix asked the delivery companies, and a note refused when the test says so. */
function fakeServer(refuse: string | null = null) {
  const calls: { action: string; args: any }[] = [];
  const server = {
    courier: async (action: string, args: any) => {
      calls.push({ action, args });
      if (action === 'note' && refuse) throw new Error(refuse);
      if (action === 'claim') return { extId: `zr-claim-${calls.length}`, extRef: args.claim.item.tracking, status: 'En attente de traitement', category: 'Relancer un colis' };
      return { ok: true };
    },
    meta: async () => null,
    hashPassword: async (s: string) => s,
    publicUrl: 'https://pilotix.example',
  } as unknown as Ctx['server'];
  return { server, calls };
}

const companyOf = async (kind: string) => {
  const r = (await db.query(`SELECT id FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1`, [kind]))[0];
  if (r) return Number(r.id);
  return Number((await db.query(`INSERT INTO delivery_companies (name, kind, active, config) VALUES ($1, $2, true, '{}') RETURNING id`, [`Test ${kind}`, kind]))[0].id);
};
const used = new Set<number>();
/** A parcel of this company on the road, with its number, no livreur and no réclamation yet. */
async function parcel(kind: string) {
  const r = (await db.query(`SELECT o.id FROM orders o WHERE o.shipped_at IS NOT NULL AND NOT (o.id = ANY($1)) AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.order_id = o.id) ORDER BY o.id DESC LIMIT 1`, [[...used]]))[0];
  const id = Number(r.id);
  used.add(id);
  await db.query(`UPDATE orders SET company_id = $2, livreur_id = NULL, follow_status = 'alert', tracking = $3, ext_id = $4 WHERE id = $1`, [id, await companyOf(kind), `NT-${kind}-${id}`, `ext-${id}`]);
  return id;
}

test('the note: the réclamation number and the problem first, the details cut to fit the smallest note (255)', () => {
  assert.equal(claimNoteText('REC-0007', 'late', ''), 'Réclamation REC-0007 — Retard de livraison');
  assert.equal(claimNoteText('REC-0007', 'late', '  Bloqué depuis 5 jours. '), 'Réclamation REC-0007 — Retard de livraison : Bloqué depuis 5 jours');
  assert.equal(claimNoteText('REC-0007', 'other', 'Autre'), 'Réclamation REC-0007 — Autre');
  const long = claimNoteText('REC-0007', 'relivrer', 'Le client est disponible demain matin. '.repeat(20));
  assert.ok(long.length <= CLAIM_NOTE_MAX, `${long.length} characters`);
  assert.ok(long.startsWith('Réclamation REC-0007 — Relivrer le colis : Le client est disponible'));
  assert.ok(long.endsWith('…'));
});

test('NOEST: the réclamation also goes as a note on the parcel; the first WhatsApp after it is « Envoyée », not a relance', async () => {
  const fake = fakeServer();
  const admin = await as(EMAILS.admin, fake.server);
  const oid = await parcel('noest');
  // as the Réclamation button sends it for a company without a réclamation API
  const c: any = await call('suivi.claimCreate', admin, { orderId: oid, reason: 'late', details: 'Bloqué depuis 5 jours', message: 'Bonjour…', viaApi: false });
  const notes = fake.calls.filter((x) => x.action === 'note');
  assert.equal(notes.length, 1, 'one note to NOEST');
  assert.equal(notes[0].args.item.tracking, `NT-noest-${oid}`);
  assert.equal(notes[0].args.text, `Réclamation ${c.ref} — Retard de livraison : Bloqué depuis 5 jours`);
  assert.ok(!fake.calls.some((x) => x.action === 'claim'), 'no réclamation API at NOEST');
  assert.equal(c.noteApi, true);
  assert.equal(c.noteSent, true);
  assert.equal(c.noteError, null);
  assert.equal(c.channel, 'note');
  assert.ok(c.sentAt, 'sent: the wait for its answer starts');
  assert.ok(c.notes.some((n: any) => /^Note envoyée à .+ sur le colis \(API\) : Réclamation REC-/.test(n.text)));
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND note LIKE $2`, [oid, `Réclamation ${c.ref} : Note envoyée%`]);
  assert.equal(ev.length, 1, 'the order’s history says it');
  // then the agent sends the message by WhatsApp: its first message, not a relance
  const u: any = await call('suivi.claimUpdate', admin, { id: c.id, sentVia: 'whatsapp', message: 'Bonjour…' });
  assert.equal(u.notes[u.notes.length - 1].text, 'Envoyée (WhatsApp)');
  assert.equal(u.pushes, 0);
  // a second WhatsApp is a relance
  const r: any = await call('suivi.claimUpdate', admin, { id: c.id, sentVia: 'whatsapp' });
  assert.equal(r.notes[r.notes.length - 1].text, 'Relance (WhatsApp)');
});

test('EcoTrack and Zimou take the note too; a refusal never stops the réclamation (written in its history, WhatsApp left)', async () => {
  for (const kind of ['ecotrack', 'zimou']) {
    const fake = fakeServer();
    const admin = await as(EMAILS.admin, fake.server);
    const c: any = await call('suivi.claimCreate', admin, { orderId: await parcel(kind), reason: 'nocall', message: 'Bonjour…', viaApi: false });
    assert.equal(fake.calls.filter((x) => x.action === 'note').length, 1, kind);
    assert.equal(c.noteSent, true, kind);
  }
  const fake = fakeServer('401 Unauthorized');
  const admin = await as(EMAILS.admin, fake.server);
  const c: any = await call('suivi.claimCreate', admin, { orderId: await parcel('ecotrack'), reason: 'damaged', message: 'Bonjour…', viaApi: false });
  assert.equal(c.noteSent, false);
  assert.equal(c.noteError, '401 Unauthorized');
  assert.equal(c.sentAt, null, 'not sent: still to send by WhatsApp');
  assert.notEqual(c.channel, 'note');
  assert.ok(c.notes.some((n: any) => /n’a pas pris la note : 401 Unauthorized$/.test(n.text)));
});

test('no note where the company has no notes (Yalidine), where its réclamation API is used (ZR), or to our own livreur', async () => {
  const fake = fakeServer();
  const admin = await as(EMAILS.admin, fake.server);
  const y: any = await call('suivi.claimCreate', admin, { orderId: await parcel('yalidine'), reason: 'late', message: 'Bonjour…', viaApi: false });
  assert.equal(y.noteApi, false);
  assert.equal(y.noteSent, undefined);
  assert.equal(y.sentAt, null);
  const z: any = await call('suivi.claimCreate', admin, { orderId: await parcel('zr'), reason: 'late', message: 'Bonjour…' });
  assert.ok(z.extId, 'ZR: its own réclamation');
  assert.equal(z.noteApi, false);
  // a NOEST parcel given to our livreur: the claim is his, nothing goes to NOEST
  const oid = await parcel('noest');
  const lv = Number((await db.query(`SELECT id FROM profiles WHERE 'livreur' = ANY(roles) ORDER BY id LIMIT 1`))[0].id);
  await db.query(`UPDATE orders SET livreur_id = $2 WHERE id = $1`, [oid, lv]);
  const l: any = await call('suivi.claimCreate', admin, { orderId: oid, reason: 'late', message: 'Bonjour…', toLivreur: true, viaApi: false });
  assert.equal(l.noteApi, false);
  assert.ok(!fake.calls.some((x) => x.action === 'note'), 'no note at all');
});

test('the control room tells the truth: a company whose réclamations go as notes is one that takes notes, and the reverse', () => {
  for (const co of courierCatalog()) {
    if (!co.kind) continue;
    const k = KINDS[co.kind];
    const claim = co.items.find((x) => x.feature === 'claim')!;
    const saysNote = /\bnote\b/.test(claim.note);
    const takes = !!k.note && !k.claims;
    assert.equal(saysNote, takes, `${co.name}: « ${claim.note} »`);
  }
});
