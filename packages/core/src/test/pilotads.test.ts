// Pilot Ads: what goes to Meta for each goal (all PAUSED, the shop's ids in the link, photos as bytes), the owner's
// limits, Pilote auto's rules, the buttons (pause, budget, undo, the owner's yes, « Tout arrêter »), the launcher in the
// demo (options, words, a launch live at once, a marketer's launch waiting for the owner), the audiences, the report by
// wilaya, and the order a chat brings keeping its ad.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { chatAdOf } from '../modules/dellal';
import { demoCopy, regionMatches } from '../modules/adslaunch';
import { checkChange, DEFAULT_GUARD, launchProblems, metaPhone, metaPlan, suggestFor, type AdsetStats, type LaunchInput } from '../modules/pilotads';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(220));
});
const owner = () => as(EMAILS.vendeur);
const mk = () => as(EMAILS.marketer);
const JPEG = '/9j/' + 'A'.repeat(120);

const base = (extra: Partial<LaunchInput> = {}): LaunchInput => ({
  goal: 'sales',
  name: 'Poussette — test',
  pageId: '104500000000001',
  instagramId: '178400000000001',
  pixelId: '1234567890123456',
  link: 'https://go.pilotix.app/boutique/poussette',
  text: { primary: 'Poussette à 8 900 DA, paiement à la livraison', headline: 'Poussette · 8 900 DA' },
  media: [{ kind: 'photo', mediaId: 7, name: 'Photo 1' }],
  budgetCents: 1000,
  budgetLevel: 'adset',
  split: 'one',
  regions: [],
  ageMin: 18,
  ageMax: 65,
  genders: [],
  advantageAudience: true,
  excludeAudiences: ['111'],
  includeAudiences: [],
  ...extra,
});
const stats = (x: Partial<AdsetStats> = {}): AdsetStats => ({
  id: '1',
  name: 'Ad set',
  status: 'ACTIVE',
  budgetUsd: 10,
  spend3Usd: 10,
  spend7Usd: 30,
  orders3: 4,
  orders7: 10,
  received: 60,
  delivered: 30,
  returned: 10,
  cancelled: 12,
  perDeliveredDzd: 2500,
  rate: 250,
  diag: 'ok',
  changedHoursAgo: 200,
  ...x,
});

test('the plan: everything PAUSED, the goal’s objective, the ids in the link, photos as bytes', () => {
  const p = metaPlan(base());
  assert.equal(p.campaign.status, 'PAUSED');
  assert.equal(p.campaign.objective, 'OUTCOME_SALES');
  assert.equal(p.campaign.is_adset_budget_sharing_enabled, false, 'ad set budgets: Meta wants the sharing flag');
  assert.ok(p.adsets.every((a) => a.body.status === 'PAUSED') && p.ads.every((a) => a.body.status === 'PAUSED'));
  assert.equal(p.adsets[0].body.optimization_goal, 'OFFSITE_CONVERSIONS');
  assert.deepEqual(p.adsets[0].body.promoted_object, { pixel_id: '1234567890123456', custom_event_type: 'PURCHASE' });
  assert.match(String(p.creatives[0].body.url_tags), /adset_id=\{\{adset\.id\}\}&ad_id=\{\{ad\.id\}\}/);
  const spec: any = p.creatives[0].body.object_story_spec;
  assert.equal(spec.link_data.image_hash, '{image:pv0}', 'a library photo goes as its bytes (no public address)');
  assert.deepEqual(p.images, [{ key: 'pv0', mediaId: 7, col: 'jpeg' }]);
  assert.deepEqual((p.adsets[0].body.targeting as any).excluded_custom_audiences, [{ id: '111' }]);
  // Meta's automatic changes that could rewrite a price stay off
  const dof: any = p.creatives[0].body.degrees_of_freedom_spec;
  assert.equal(dof.creative_features_spec.text_optimizations.enroll_status, 'OPT_OUT');
});

test('the plan for each goal: messages (two apps), calls, form, campaign budget, one ad set per video', () => {
  const m = metaPlan(base({ goal: 'messages', link: null, channels: ['messenger', 'whatsapp'], welcome: { text: 'Salam 👋', questions: ['Le prix ?', 'Livraison ?'] } }));
  assert.equal(m.campaign.objective, 'OUTCOME_ENGAGEMENT');
  assert.equal(m.adsets[0].body.destination_type, 'MESSAGING_MESSENGER_WHATSAPP');
  assert.equal((m.creatives[0].body.asset_feed_spec as any).optimization_type, 'DOF_MESSAGING_DESTINATION');
  assert.ok((m.creatives[0].body.object_story_spec as any).link_data.page_welcome_message, 'the welcome message');
  assert.equal(m.creatives[0].body.url_tags, undefined, 'no link to tag');

  const c = metaPlan(base({ goal: 'calls', phone: '+213661223344' }));
  assert.equal(c.adsets[0].body.optimization_goal, 'QUALITY_CALL');
  assert.deepEqual((c.creatives[0].body.object_story_spec as any).link_data.call_to_action, { type: 'CALL_NOW', value: { link: 'tel:+213661223344' } });

  const f = metaPlan(base({ goal: 'form', formId: '998877665544' }));
  assert.equal(f.adsets[0].body.destination_type, 'ON_AD');
  assert.equal((f.creatives[0].body.object_story_spec as any).link_data.call_to_action.value.lead_gen_form_id, '998877665544');

  const v = metaPlan(base({ budgetLevel: 'campaign', split: 'perMedia', media: [{ kind: 'video', mediaId: 3, url: 'https://x/lp/vid/3/a.mp4', name: 'V1' }, { kind: 'video', mediaId: 4, url: 'https://x/lp/vid/4/b.mp4', name: 'V2' }], excludeRegions: ['2010'] }));
  assert.equal(v.campaign.daily_budget, 1000);
  assert.equal(v.adsets.length, 2, 'one ad set per video: a test of the créas');
  assert.ok(v.adsets.every((a) => a.body.daily_budget === undefined), 'the campaign holds the budget');
  assert.equal((v.creatives[0].body.object_story_spec as any).video_data.image_hash, '{image:tv0}', 'the video’s still from the library');
  assert.deepEqual((v.adsets[0].body.targeting as any).excluded_geo_locations, { regions: [{ key: '2010' }] });
  assert.equal(v.creatives[0].video?.url, 'https://x/lp/vid/3/a.mp4');
});

test('nothing goes to Meta while something is missing', () => {
  assert.deepEqual(launchProblems(base()), []);
  assert.match(launchProblems(base({ link: null })).join(' '), /page de vente/);
  assert.match(launchProblems(base({ pixelId: null })).join(' '), /pixel/);
  assert.match(launchProblems(base({ goal: 'calls', phone: '0661223344' })).join(' '), /\+213/);
  assert.match(launchProblems(base({ goal: 'messages', channels: [] })).join(' '), /Messenger/);
  assert.match(launchProblems(base({ media: [{ kind: 'video', mediaId: 3, url: null, name: 'V' }] })).join(' '), /pas encore prête/);
});

test('the owner’s limits: pausing always, a big raise waits for the owner, « Tout arrêter » holds', () => {
  const c = (x: Partial<Parameters<typeof checkChange>[1]>, g = DEFAULT_GUARD) => checkChange(g, { op: 'budget', owner: false, fromUsd: 10, toUsd: 12, shopDailyUsd: 40, changesLastHour: 0, ...x });
  assert.deepEqual(checkChange({ ...DEFAULT_GUARD, stopped: true }, { op: 'pause', owner: false, fromUsd: 10, toUsd: 10, shopDailyUsd: 40, changesLastHour: 9 }), { ok: true, needsYes: false, why: null });
  assert.equal(c({}).ok && !(c({}) as any).needsYes, true, '+20 %: fine');
  assert.equal((c({ toUsd: 15 }) as any).needsYes, true, '+50 %: the owner says yes');
  assert.equal(c({ toUsd: 70, shopDailyUsd: 95 }).ok, false, 'above the shop’s day: a marketer cannot');
  assert.equal(c({ toUsd: 70, shopDailyUsd: 95, owner: true }).ok, true, 'the owner can (and is told)');
  assert.equal(c({ changesLastHour: 4 }).ok, false, 'Meta: 4 budget changes an hour');
  assert.equal(checkChange({ ...DEFAULT_GUARD, stopped: true }, { op: 'resume', owner: true, fromUsd: 10, toUsd: 10, shopDailyUsd: 0, changesLastHour: 0 }).ok, false);
});

test('Pilote auto’s rules: stop the loss, delivery and confirmation first, then trim, tired créas, the raise', () => {
  // max per order: 2500 × 0.5 / 250 = 5 $ → stop at 10 $ in 3 days with no order
  assert.equal(suggestFor(stats({ spend3Usd: 11, orders3: 0 }))?.rule, 'stop');
  assert.equal(suggestFor(stats({ delivered: 7, returned: 9 }))?.rule, 'deliver');
  assert.equal(suggestFor(stats({ received: 40, cancelled: 30 }))?.rule, 'confirm');
  const trim = suggestFor(stats({ spend7Usd: 80, orders7: 10 }));
  assert.equal(trim?.rule, 'trim');
  assert.equal(trim?.value, 8, '−20 %');
  assert.equal(suggestFor(stats({ diag: 'fatigue' }))?.op, 'creative');
  const up = suggestFor(stats({ spend7Usd: 20, orders7: 12 }));
  assert.equal(up?.rule, 'scale');
  assert.equal(up?.value, 12, '+20 %');
  assert.equal(suggestFor(stats({ spend7Usd: 20, orders7: 12, changedHoursAgo: 10 })), null, '72 h after a change');
  assert.equal(suggestFor(stats({ status: 'PAUSED', spend3Usd: 50, orders3: 0 })), null);
});

test('phones as Meta wants them, wilayas as Meta names them, words with no false promise', () => {
  assert.equal(metaPhone('0661 22 33 44'), '213661223344');
  assert.equal(metaPhone('+213 770 11 22 33'), '213770112233');
  assert.equal(metaPhone('021 22 33 44'), null, 'a landline is no WhatsApp or Meta phone here');
  assert.ok(regionMatches('Alger', 'Algiers Province'));
  assert.ok(regionMatches('Béjaïa', 'Bejaia Province'));
  assert.ok(!regionMatches('Oran', 'Ouargla Province'));
  for (const lang of ['darija', 'fr', 'ar'] as const) {
    const c = demoCopy(lang, { name: 'Poussette', price: 8900 }, 'messages');
    assert.equal(c.variants.length, 3);
    assert.ok(c.variants.every((v) => !/100\s?%|garanti|مضمون/i.test(v.primary)), 'no promise Meta refuses');
    assert.equal(c.welcome.questions.length, 3);
  }
});

test('a chat that came from an ad: the order keeps the ad and its ad set', async () => {
  const ad = await chatAdOf(db, 'pub 120210000090');
  assert.deepEqual(ad, { utm: { utm_source: 'facebook', utm_medium: 'chat', ad_id: '120210000090', adset_id: '120200009' }, adsetId: '120200009' });
  assert.deepEqual(await chatAdOf(db, 'facebook'), { utm: null, adsetId: null });
});

test('the buttons: the marketer sees his ad sets, pauses one and undoes it', async () => {
  const st: any = await call('ads.ctl.state', await mk(), {});
  assert.ok(st.objects.length >= 4);
  assert.ok(!st.objects.some((o: any) => o.id === '120200004'), 'the owner’s ad set is not his');
  const cbo: any = (await call('ads.ctl.state', await owner(), {})).objects.find((o: any) => o.id === '120200004');
  assert.equal(cbo.budgetLevel, 'campaign', 'Advantage+: the campaign holds the budget');
  assert.equal(st.waiting.length, 1, 'his raise waits for the owner');
  const a: any = await call('ads.ctl.act', await mk(), { objectId: '120200003', op: 'pause', clientId: 'p-1' });
  assert.equal(a.status, 'done');
  assert.equal((await db.query(`SELECT status FROM adsets WHERE id = '120200003'`))[0].status, 'PAUSED');
  const again: any = await call('ads.ctl.act', await mk(), { objectId: '120200003', op: 'pause', clientId: 'p-1' });
  assert.equal(again.id, a.id, 'a double click is one change');
  await call('ads.ctl.undo', await mk(), { id: a.id });
  assert.equal((await db.query(`SELECT status FROM adsets WHERE id = '120200003'`))[0].status, 'ACTIVE');
  await assert.rejects(call('ads.ctl.undo', await mk(), { id: a.id }), /ne peut pas/);
  await assert.rejects(call('ads.ctl.act', await mk(), { objectId: '120200004', op: 'pause' }), /Accès refusé/);
});

test('a big raise waits for the owner’s yes; the owner’s own change goes at once', async () => {
  const w: any = (await call('ads.ctl.state', await owner(), {})).waiting[0];
  assert.equal(w.objectId, '120200002');
  const r: any = await call('ads.ctl.approve', await owner(), { id: w.id, yes: true });
  assert.equal(r.status, 'done');
  assert.equal((await db.query(`SELECT daily_budget_cents FROM adsets WHERE id = '120200002'`))[0].daily_budget_cents, 2000);
  await assert.rejects(call('ads.ctl.act', await mk(), { objectId: '120200001', op: 'budget', usd: 40 }), /limite est 100 \$/, 'the shop would spend more than the owner allows');
  const mine: any = await call('ads.ctl.act', await mk(), { objectId: '120200001', op: 'budget', usd: 30 });
  assert.equal(mine.status, 'waiting_yes', '+36 %');
  const own: any = await call('ads.ctl.act', await owner(), { objectId: '120200005', op: 'budget', usd: 9 });
  assert.equal(own.status, 'done');
  await call('ads.ctl.approve', await owner(), { id: mine.id, yes: false });
  assert.equal((await db.query(`SELECT status FROM ad_actions WHERE id = $1`, [mine.id]))[0].status, 'refused');
});

test('« Tout arrêter »: every running ad set paused, nothing starts again until « Tout relancer »', async () => {
  const before = (await db.query(`SELECT count(*)::int AS n FROM adsets WHERE status = 'ACTIVE'`))[0].n;
  assert.ok(before > 0);
  await assert.rejects(call('ads.ctl.stopAll', await mk(), { on: true }), /Accès refusé/);
  const s: any = await call('ads.ctl.stopAll', await owner(), { on: true });
  assert.equal(s.paused, before);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM adsets WHERE status = 'ACTIVE'`))[0].n, 0);
  await assert.rejects(call('ads.ctl.act', await mk(), { objectId: '120200001', op: 'resume' }), /Tout est arrêté/);
  const back: any = await call('ads.ctl.stopAll', await owner(), { on: false });
  assert.equal(back.resumed, before);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM adsets WHERE status = 'ACTIVE'`))[0].n, before);
});

test('Pilote auto: its suggestions, applied or set aside, and its settings (owner only)', async () => {
  const p: any = await call('ads.pilot.state', await owner(), {});
  assert.ok(p.suggestions.length >= 1, 'the demo has suggestions');
  assert.equal(p.rules.cap, 'auto');
  const any = p.suggestions[0];
  await call('ads.pilot.decide', await owner(), { id: any.id, apply: false });
  assert.equal((await db.query(`SELECT status FROM ad_suggestions WHERE id = $1`, [any.id]))[0].status, 'ignored');
  await assert.rejects(call('ads.pilot.save', await mk(), { rules: { stop: 'auto' } }), /Accès refusé/);
  const saved: any = await call('ads.pilot.save', await owner(), { rules: { stop: 'auto', confirm: 'auto' } });
  assert.equal(saved.rules.stop, 'auto');
  assert.equal(saved.rules.confirm, 'suggest', 'a rule that cannot act alone stays a suggestion');
  const run: any = await call('ads.pilot.check', await owner(), {});
  assert.ok(run.checked >= 1);
});

test('the launcher in the demo: products with what an order may cost, words, a launch live at once', async () => {
  const o: any = await call('ads.launch.options', await owner(), {});
  assert.equal(o.demo, true);
  assert.ok(o.page?.pageId && o.pixels.length >= 1);
  const p = o.products.find((x: any) => x.landing);
  assert.ok(p, 'a product with its sales page');
  assert.ok(p.limit.maxDzd > 0 && p.packs.length === 3);
  assert.ok(o.wilayas.length === 69);
  const words: any = await call('ads.launch.copy', await owner(), { productId: p.id, goal: 'sales', lang: 'darija' });
  assert.equal(words.by, 'ready');
  const photo: any = await call('ads.media.photo', await owner(), { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1350 });
  const spec = { goal: 'sales', productId: p.id, name: `${p.name} — test`, mediaIds: [photo.id], text: words.variants[0], budgetUsd: 10, excludeWilayas: [33] };
  const d: any = await call('ads.launch.save', await owner(), { mode: 'simple', clientId: 'l-1', spec });
  assert.equal(d.status, 'draft');
  const chk: any = await call('ads.launch.check', await owner(), { id: d.id });
  assert.equal(chk.ok, true, chk.problems.join(' | '));
  const live: any = await call('ads.launch.go', await owner(), { id: d.id });
  assert.equal(live.status, 'live');
  assert.equal(live.adsetIds.length, 1);
  const set = (await db.query(`SELECT goal, launch_id, status, daily_budget_cents, product_ids FROM adsets WHERE id = $1`, [live.adsetIds[0]]))[0];
  assert.equal(set.goal, 'sales');
  assert.equal(Number(set.launch_id), d.id);
  assert.equal(set.daily_budget_cents, null, 'Advantage+: the campaign holds the budget');
  assert.equal((await db.query(`SELECT daily_budget_cents FROM ad_campaigns WHERE id = $1`, [live.campaignId]))[0].daily_budget_cents, 1000);
  assert.equal((await db.query(`SELECT for_ads FROM cm_media WHERE id = $1`, [photo.id]))[0].for_ads, true);
  assert.ok((await db.query(`SELECT 1 FROM ad_actions WHERE op = 'launch' AND object_id = $1`, [live.campaignId])).length);
  await assert.rejects(call('ads.launch.remove', await owner(), { id: d.id }), /pause/);
});

test('a marketer’s launch waits for the owner when the owner wants it, then goes live', async () => {
  await call('ads.ctl.guard', await owner(), { maxDailyUsd: 300, maxRaisePct: 30, yesAboveUsd: 30, launchYes: true });
  const o: any = await call('ads.launch.options', await mk(), {});
  const p = o.products.find((x: any) => x.landing);
  const photo: any = await call('ads.media.photo', await mk(), { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1080 });
  const d: any = await call('ads.launch.save', await mk(), { mode: 'pro', spec: { goal: 'sales', productId: p.id, name: 'Test marketer', mediaIds: [photo.id], text: { primary: 'Texte', headline: 'Titre' }, budgetUsd: 8 } });
  const w: any = await call('ads.launch.go', await mk(), { id: d.id });
  assert.equal(w.status, 'waiting_yes');
  await assert.rejects(call('ads.launch.go', await mk(), { id: d.id }), /attend le oui/);
  const live: any = await call('ads.launch.approve', await owner(), { id: d.id, yes: true });
  assert.equal(live.status, 'live');
  const set = (await db.query(`SELECT marketer_id FROM adsets WHERE id = $1`, [live.adsetIds[0]]))[0];
  assert.ok(set.marketer_id, 'the ad set is the marketer’s (his pay, his numbers)');
  await call('ads.ctl.guard', await owner(), { maxDailyUsd: 100, maxRaisePct: 30, yesAboveUsd: 30, launchYes: false });
});

test('a sales ad needs its sales page; the problems come back before Meta', async () => {
  const o: any = await call('ads.launch.options', await owner(), {});
  const bare = o.products.find((x: any) => !x.landing);
  if (!bare) return;
  const d: any = await call('ads.launch.save', await owner(), { mode: 'simple', spec: { goal: 'sales', productId: bare.id, name: 'Sans page', mediaIds: [], text: { primary: 'x', headline: 'y' }, budgetUsd: 5 } });
  const chk: any = await call('ads.launch.check', await owner(), { id: d.id });
  assert.equal(chk.ok, false);
  assert.ok(chk.problems.some((x: string) => /page de vente/.test(x)));
  await assert.rejects(call('ads.launch.go', await owner(), { id: d.id }), /page de vente/);
});

test('audiences: nothing sent before the owner turns one on; the report by wilaya and hour', async () => {
  const a: any = await call('ads.aud.list', await mk(), {});
  assert.deepEqual(a.list.filter((x: any) => x.on).map((x: any) => x.kind).sort(), ['fake', 'returners']);
  await assert.rejects(call('ads.aud.save', await mk(), { kind: 'buyers', on: true }), /Accès refusé/);
  await call('ads.aud.save', await owner(), { kind: 'buyers', on: true });
  const synced: any = await call('ads.aud.sync', await owner(), {});
  const buyers = synced.list.find((x: any) => x.kind === 'buyers');
  assert.ok(buyers.on && buyers.size > 0 && buyers.status === 'ready');
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const w: any = await call('ads.report.where', await owner(), { from, to: today });
  assert.ok(w.wilayas.length > 0 && w.wilayas[0].orders > 0);
  assert.equal(w.hours.length, 24);
  assert.ok(w.goals.some((g: any) => g.goal === 'messages'), 'the messages campaign’s orders');
});
