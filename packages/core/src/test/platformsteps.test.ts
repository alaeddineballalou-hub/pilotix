// The platform's database steps (platform/schema.ts › PLATFORM_MIGRATIONS). On 23 Nov 2026 « Mes appareils » wrote its
// two tables into an old step (p003), and the agency's alerts their column into another (p005). The live server had done
// both steps long before, so its updates skipped them: there, every device check-in failed (the wall of that evening let
// nobody through), every phone notification of a store too, and the agency's alerts. A change to the platform's tables
// is a new step at the end, never an edit of an old one.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin } from '../index';
import { loadShop, passwordFromLink } from '../platform';
import { PLATFORM_MIGRATIONS } from '../platform/schema';
import { pushOnly } from '../modules/push';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Device-Password-1';

test('a server made before 23 Nov: after the next update the agency alerts work and a store’s phone gets its notifications', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  // the live server on 23 Nov: done up to p044, and p003 and p005 long before the tables and the column were written
  // into them
  await t.exec('public', `DROP TABLE platform.notification_device_subscriptions; DROP TABLE platform.notification_devices;
    ALTER TABLE platform.agency_links DROP COLUMN agency_alerts; DELETE FROM platform.migrations WHERE name > 'p044';`);
  // the next update: the server starts and brings every database up to date
  await migrateAll(t);
  // the agency's alerts (accepting a store, changing its tasks, the agency's bell) read and write this column
  await t.platform.query('SELECT agency_alerts FROM platform.agency_links LIMIT 0');

  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name: 'Boutique Sétif', ownerName: 'Karim', ownerEmail: 'karim@setif.dz', planId: biz.id, trialDays: 14 });
  await passwordFromLink(t, made.mail.token, PW);
  const s = (await loadShop(t, { id: made.id }))!;
  const db = t.shop(s.schema);
  const sent: string[] = [];
  const ctx: Ctx = {
    db,
    session: await login(db, 'karim@setif.dz', PW),
    now: () => Date.now(),
    emit: () => {},
    shop: shopCtx(s, shopStatus(s, Date.now(), 3)),
    t,
    server: {
      courier: async () => null,
      meta: async () => null,
      hashPassword: async () => 'test',
      pushKeys: () => ({ publicKey: 'store-public-key', privateKey: 'store-private' }),
      push: async (_k, subs) => subs.map(({ endpoint }) => (sent.push(endpoint), { endpoint, ok: true, gone: false })),
    },
  };

  // « Activer les notifications » on this phone, then a notification of the store (a new order, « Livrée », a dépôt
  // alert…) reaches it
  const endpoint = 'https://fcm.googleapis.com/fcm/send/old-server-phone';
  await call('push.subscribe', ctx, { endpoint, p256dh: 'fake-public-device-key', auth: 'fake-device-auth', ua: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
  assert.equal(await pushOnly(ctx, [ctx.session.profile.id], { title: 'Nouvelle commande' }), 1);
  assert.deepEqual(sent, [endpoint]);
});

/**
 * Each step as the live server did it (the first 12 hex of the sha256 of its SQL). A new step goes at the end and gets
 * its line here; an old one never changes, since a server that did it already never runs it again. The only exception:
 * a step whose update stopped the server (never done there): fix it, and its line here.
 */
const DONE: [string, string][] = [
  ['p001_platform', '80018210ad4e'],
  ['p002_accounts_signup_domains', '1d9b375f7632'],
  ['p003_accounts_privacy', 'a6dd82878398'],
  ['p004_turnstile', '553023f4e7f0'],
  ['p005_agencies', 'e87e1503732c'],
  ['p006_marketers', 'f62553012e77'],
  ['p007_account_phone', '2053f78c730b'],
  ['p008_pro_marketers', '72fe812ed23c'],
  ['p009_fraud_reputation', '0672b9aa3a20'],
  ['p010_protection_history', '3ad2258a3aa1'],
  ['p011_buyer_quality', '1a092012fb8f'],
  ['p012_pilot_ai', '9bb6fe0cc233'],
  ['p013_ai_usage', '5bba1498726f'],
  ['p014_lahja', 'b16687a9fb0c'],
  ['p015_darija_book', 'a58f13adf519'],
  ['p016_vocab', '52e5e774df8c'],
  ['p017_old_slugs', '110547f81362'],
  ['p018_social', '54a5eb4abfcf'],
  ['p019_seller_plan', '8d8d17d4128f'],
  ['p020_social_ig', '0fc9ff2022dc'],
  ['p021_social_hooks', 'af614fad1482'],
  ['p022_social_comments', '1f6662100abe'],
  ['p023_password_by', '3942a5c1dd6f'],
  ['p024_revoked_tokens', 'e0268bc3172d'],
  ['p025_social_deletions', 'a6c438979544'],
  ['p026_social_confirm', '8a3db3061232'],
  ['p027_staff_totp', '3d59570e5224'],
  ['p028_pilot_release', '9325863c4374'],
  ['p029_social_manager', '679ab4afc759'],
  ['p030_pilot_exams', '7e93482ede41'],
  ['p031_pilotix_lessons', 'cd50103ec693'],
  ['p032_exam_plan', '5c48bebc6c14'],
  ['p033_spy_searches', 'ad08caf864d8'],
  ['p034_case_tests', 'd7275d45fc68'],
  ['p035_shared_login_sync', '2fc4e56d72f9'],
  ['p036_shops_owner_index', '71ad383d8d5f'],
  ['p037_payment_claims', 'fd66e73f6226'],
  ['p038_ai_credits', '8037ee032680'],
  ['p039_referral_period', '5181159c913a'],
  ['p040_mcp', '405f66949931'],
  ['p041_mcp_log', '4f7c17c970f0'],
  ['p042_mcp_uploads', 'c66bd6deabfc'],
  ['p043_social_part', 'ef09b32bc7e2'],
  ['p044_social_ads_picked', 'a87cdca05b6b'],
  ['p045_notification_devices', '48235afb1b45'],
  ['p046_agency_alerts', '5bbf1b24ee86'],
];

test('the old platform steps never change: a change to the platform’s tables is a new step at the end', () => {
  const now = PLATFORM_MIGRATIONS.map(([name, sql]) => [name, createHash('sha256').update(sql).digest('hex').slice(0, 12)] as const);
  assert.deepEqual(now.slice(0, DONE.length).map(([name]) => name), DONE.map(([name]) => name), 'the steps keep their names and their order');
  for (const [i, [name, hash]] of DONE.entries())
    assert.equal(now[i][1], hash, `${name} was changed: put the change in a new step at the end (a server that did ${name} never runs it again)`);
  assert.equal(now.length, DONE.length, 'a new step: add its line to DONE once it is written');
});
