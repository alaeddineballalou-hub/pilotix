// Marketing › Campagnes: WhatsApp offers only to the customers who said yes, the template Meta approves (Marketing, with
// « Je commande », « Stop » and a link), the pace, Meta's statuses, « Stop » (by button or by hand), « Je commande » to
// Dellal, the gap of 3 days, the orders a campaign brought, and who may use it.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, ServerHooks } from '../index';
import { campaignProblems, campaignText } from '../modules/campaigns';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(150));
  // the tests run at any hour: no quiet hours here
  await db.query(`INSERT INTO settings (key, value) VALUES ('notify', '{"quietFrom":0,"quietTo":0}') ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`);
});

const mk = async (server?: ServerHooks) => as(EMAILS.marketer, server);
const audience = (extra: Record<string, unknown> = {}) => ({ productIds: [], wilayas: [], delivered: true, noReturns: true, minDays: null, maxDays: null, ...extra });

test('the text: {nom} and {boutique} only, never at the very start or end', () => {
  assert.deepEqual(campaignProblems('Salam {nom}, m3akom {boutique}. Promo 3 jours sur la poussette.'), []);
  assert.match(campaignProblems('{nom}, promo sur la poussette canne cette semaine')[0], /commencer ou finir/);
  assert.match(campaignProblems('Salam {prenom}, promo sur la poussette canne')[0], /Variable inconnue/);
  assert.equal(campaignText('Salam {nom}, m3akom {boutique}.', 'amina boudiaf', 'Bébé Confort DZ', 'dz'), 'Salam Amina, m3akom Bébé Confort DZ.');
});

test('the demo: customers who said yes, a promo sent last week with its results, one going out, a draft', async () => {
  const d: any = await call('campaigns.list', await mk(), {});
  assert.ok(d.consent.yes > 0, 'customers said yes');
  assert.ok(d.consent.form > 0 && d.consent.call > 0);
  assert.deepEqual(d.campaigns.map((c: any) => c.status).sort(), ['done', 'draft', 'sending']);
  const promo = d.campaigns.find((c: any) => c.status === 'done');
  assert.ok(promo.stats.sent > 0 && promo.stats.read > 0 && promo.stats.replied > 0);
  assert.ok(promo.stats.orders >= 1, 'the orders made after the message');
  assert.ok(promo.stats.revenue > 0);
  assert.equal(d.settings.formOptin, true, 'the box is on the demo landing pages');
  const detail: any = await call('campaigns.get', await mk(), { id: promo.id });
  assert.ok(detail.sends.some((s: any) => s.orderRef), 'a message shows the order it brought');
});

test('who gets it: only customers who said yes, without « Stop », chosen by product, wilaya and date', async () => {
  const all: any = await call('campaigns.audience', await mk(), { audience: audience() });
  const reachable = (await db.query(`SELECT count(*)::int AS n FROM customers c WHERE c.wa_optin_at IS NOT NULL AND c.wa_optout_at IS NULL AND NOT c.blacklisted`))[0].n;
  assert.ok(all.count > 0 && all.count <= reachable);
  const algiers: any = await call('campaigns.audience', await mk(), { audience: audience({ wilayas: [16] }) });
  assert.ok(algiers.count < all.count);
  const nobody: any = await call('campaigns.audience', await mk(), { audience: audience({ maxDays: 0, minDays: 3650 }) });
  assert.equal(nobody.count, 0);
});

test('the preview: written, « approved », sent at once (a number without WhatsApp fails)', async () => {
  const c: any = await call('campaigns.save', await mk(), { name: 'Test aperçu', audience: audience({ wilayas: [16] }), lang: 'fr', body: 'Bonjour {nom}, ici {boutique}. Nouvelle collection disponible cette semaine.', productId: null, link: null, orderButton: true, sendAt: null });
  assert.equal(c.status, 'draft');
  const s: any = await call('campaigns.submit', await mk(), { id: c.id });
  assert.equal(s.status, 'ready', 'Meta « approves » at once in the preview');
  const r: any = await call('campaigns.start', await mk(), { id: c.id });
  assert.equal(r.status, 'done');
  assert.ok(r.stats.sent > 0);
  assert.equal(r.stats.sent + r.stats.failed + r.stats.skipped, r.stats.total);
  await assert.rejects(call('campaigns.remove', await mk(), { id: c.id }), /historique/);
});

/** A fake server: Meta's answers, and every WhatsApp call recorded. */
function fakeServer(log: { action: string; args: any }[], o: { status?: string } = {}): ServerHooks {
  let n = 0;
  return {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (p) => p,
    dellal: async (action, args: any) => {
      log.push({ action, args });
      if (action === 'waCreateTemplate') return { id: 'tpl1', status: 'PENDING' };
      if (action === 'waTemplates') return [{ name: args?.name ?? 'x', status: o.status ?? 'APPROVED', language: 'fr', reason: o.status === 'REJECTED' ? 'PROMOTIONAL' : null }].map((t) => ({ ...t, name: lastTemplate(log) }));
      if (action === 'waTemplate') return { id: `wamid.test${++n}` };
      return { ok: true };
    },
  };
}
const lastTemplate = (log: { action: string; args: any }[]) => [...log].reverse().find((l) => l.action === 'waCreateTemplate')?.args?.name ?? '';

test('on the server: a Marketing template with its buttons, approved, sent at the shop’s pace with the buttons’ values', async () => {
  // WhatsApp connected (Message AI agent) and the WhatsApp Business Account (Delivery AI agent)
  await db.query(`INSERT INTO settings (key, value) VALUES ('secret_dellal_wa_token', '"EAAG-test"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await db.query(`INSERT INTO settings (key, value) VALUES ('dellal', '{"whatsappPhoneId":"1098765"}') ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`);
  await db.query(`UPDATE settings SET value = value || '{"wabaId":"55501"}' WHERE key = 'notify'`);
  await call('campaigns.settings', await mk(), { perDay: 300, formOptin: true });
  const log: { action: string; args: any }[] = [];
  const server = fakeServer(log);
  const c: any = await call('campaigns.save', await mk(server), {
    name: 'Chaise haute',
    audience: audience({ wilayas: [9, 15, 19, 31] }),
    lang: 'fr',
    body: 'Bonjour {nom}, ici {boutique}. La chaise haute est arrivée, livraison 58 wilayas.',
    productId: null,
    link: 'https://go.example.com/bebe/chaise-haute',
    orderButton: true,
    sendAt: null,
  });
  const p: any = await call('campaigns.submit', await mk(server), { id: c.id });
  assert.equal(p.status, 'pending');
  const tpl = log.find((l) => l.action === 'waCreateTemplate')!.args;
  assert.equal(tpl.category, 'MARKETING');
  assert.equal(tpl.body, 'Bonjour {{1}}, ici {{2}}. La chaise haute est arrivée, livraison 58 wilayas.');
  assert.deepEqual(
    tpl.buttons.map((b: any) => `${b.type}:${b.text}`),
    ['QUICK_REPLY:Je commande', 'QUICK_REPLY:Stop', 'URL:Voir le produit'],
  );
  await assert.rejects(call('campaigns.start', await mk(server), { id: c.id }), /pas encore approuvé/);
  await call('campaigns.check', await mk(server), {});
  const started: any = await call('campaigns.start', await mk(server), { id: (await call('campaigns.get', await mk(server), { id: c.id }) as any).campaign.id });
  assert.equal(started.status, 'sending');
  const total = started.stats.total;
  assert.ok(total > 0);
  const sys = await as(EMAILS.admin, server);
  const r: any = await call('campaigns.run', sys, {});
  assert.ok(r.sent > 0 && r.sent <= 25, 'a few each minute');
  const sent = log.filter((l) => l.action === 'waTemplate');
  assert.deepEqual(sent[0].args.payloads, [`pxc:order:${c.id}`, `pxc:stop:${c.id}`]);
  assert.equal(sent[0].args.params[1], (await db.query(`SELECT value->>'name' AS n FROM settings WHERE key = 'shop'`))[0].n);
  assert.match(sent[0].args.to, /^213\d{9}$/);
  // Meta's statuses
  const first = (await db.query(`SELECT * FROM wa_campaign_sends WHERE campaign_id = $1 AND wa_id IS NOT NULL ORDER BY id LIMIT 1`, [c.id]))[0];
  await call('campaigns.waStatus', sys, { id: first.wa_id, status: 'read' });
  assert.ok((await db.query(`SELECT read_at FROM wa_campaign_sends WHERE id = $1`, [first.id]))[0].read_at);
  // « Je commande »: Dellal reads the button with the campaign's product
  const ord: any = await call('campaigns.reply', sys, { phone: `213${String(first.phone).slice(1)}`, payload: `pxc:order:${c.id}`, text: 'Je commande' });
  assert.equal(ord.text, 'Je commande');
  assert.equal((await db.query(`SELECT tapped FROM wa_campaign_sends WHERE id = $1`, [first.id]))[0].tapped, 'order');
  // « Stop »: no offer any more, said back to the customer, nothing for Dellal
  const before = (await call('campaigns.audience', await mk(), { audience: audience() }) as any).count;
  const stop: any = await call('campaigns.reply', sys, { phone: `213${String(first.phone).slice(1)}`, payload: `pxc:stop:${c.id}`, text: 'Stop' });
  assert.equal(stop.stop, true);
  assert.ok(log.some((l) => l.action === 'send' && /ne recevrez plus/.test(l.args.text)), 'said back');
  assert.equal((await call('campaigns.audience', await mk(), { audience: audience() }) as any).count, before - 1);
  // the rest leaves on the next runs, then the campaign is done
  for (let k = 0; k < 20 && ((await call('campaigns.get', await mk(), { id: c.id })) as any).campaign.status === 'sending'; k++) await call('campaigns.run', sys, {});
  const done: any = (await call('campaigns.get', await mk(), { id: c.id })).campaign;
  assert.equal(done.status, 'done');
  assert.equal(done.stats.queued, 0);
});

test('never twice in 3 days, the day’s limit, and « stop » typed by hand', async () => {
  const log: { action: string; args: any }[] = [];
  const server = fakeServer(log);
  const sys = await as(EMAILS.admin, server);
  const launch = async (name: string, wilayas: number[], orderButton: boolean) => {
    const c: any = await call('campaigns.save', await mk(server), { name, audience: audience({ wilayas }), lang: 'fr', body: 'Bonjour {nom}, une autre offre de {boutique} cette semaine.', productId: null, link: null, orderButton, sendAt: null });
    await call('campaigns.submit', await mk(server), { id: c.id });
    await call('campaigns.check', await mk(server), {});
    await call('campaigns.start', await mk(server), { id: c.id });
    return c.id as number;
  };
  // the same customers again: they got one these 3 days, skipped
  await call('campaigns.settings', await mk(), { perDay: 5000, formOptin: true });
  const again = await launch('Encore', [9, 15, 19, 31], false);
  const r: any = await call('campaigns.run', sys, {});
  assert.equal(r.sent, 0);
  const d: any = (await call('campaigns.get', await mk(), { id: again })).campaign;
  assert.ok(d.stats.skipped > 0 && d.stats.skipped === d.stats.total, 'all got one these 3 days');
  assert.equal(d.status, 'done');
  // the buttons without « Je commande »: only « Stop »
  assert.deepEqual([...log].reverse().find((l) => l.action === 'waCreateTemplate')!.args.buttons.map((b: any) => b.text), ['Stop']);
  // the day’s limit: 3 more messages, not one more
  const used = (await db.query(`SELECT count(*)::int AS n FROM wa_campaign_sends WHERE sent_at > now() - interval '1 day'`))[0].n;
  await call('campaigns.settings', await mk(), { perDay: used + 3, formOptin: true });
  const other = await launch('Autres wilayas', [5, 6, 13, 23, 25, 35, 42, 47], true);
  const r2: any = await call('campaigns.run', sys, {});
  assert.equal(r2.sent, 3);
  assert.equal((await call('campaigns.get', await mk(), { id: other }) as any).campaign.status, 'sending', 'the rest waits for tomorrow');
  // « stop » typed after a recent campaign message
  const recent = (await db.query(`SELECT phone FROM wa_campaign_sends WHERE sent_at IS NOT NULL AND tapped IS NULL ORDER BY sent_at DESC LIMIT 1`))[0];
  const typed: any = await call('campaigns.reply', sys, { phone: String(recent.phone), text: 'STOP' });
  assert.equal(typed.stop, true);
  assert.ok((await db.query(`SELECT wa_optout_at FROM customers WHERE phone = $1`, [recent.phone]))[0].wa_optout_at);
  // any other answer just counts
  const ans = (await db.query(`SELECT phone FROM wa_campaign_sends WHERE sent_at IS NOT NULL AND replied_at IS NULL ORDER BY sent_at DESC LIMIT 1`))[0];
  assert.deepEqual(await call('campaigns.reply', sys, { phone: String(ans.phone), text: 'Combien ?' }), {});
  assert.ok((await db.query(`SELECT 1 FROM wa_campaign_sends WHERE phone = $1 AND replied_at IS NOT NULL LIMIT 1`, [ans.phone]))[0]);
});

test('saying yes: the agent during the call, a pasted list; and who may use campaigns', async () => {
  const cust = (await db.query(`SELECT id, phone FROM customers WHERE wa_optin_at IS NULL AND wa_optout_at IS NULL ORDER BY id LIMIT 2`)) as any[];
  const agent = await as(EMAILS.conf);
  assert.deepEqual(await call('campaigns.optin', agent, { customerId: cust[0].id, on: true }), { on: true });
  const h: any = await call('customers.history', await as(EMAILS.admin), { id: cust[0].id });
  assert.equal(h.customer.waOffers, 'yes');
  const imp: any = await call('campaigns.import', await mk(), { phones: `${cust[1].phone}\n0555 00 00 01, 12345` });
  assert.deepEqual(imp, { added: 1, unknown: 1, invalid: 1 });
  assert.equal((await db.query(`SELECT wa_optin_source FROM customers WHERE id = $1`, [cust[1].id]))[0].wa_optin_source, 'import');
  await assert.rejects(call('campaigns.list', agent, {}), /Accès refusé/);
  await assert.rejects(call('campaigns.run', await mk(), {}), /Accès refusé/);
});
