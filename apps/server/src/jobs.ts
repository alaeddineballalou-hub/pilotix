import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as core from '@pilotix/core';
import { featureOn } from '@pilotix/shared';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';
import { CoreService, ShopRef } from './core.service';
import { watchNow } from './courierWatch';
import { doctorState } from './doctor';
import { mailConfigured, sendMail } from './mail';
import { pilotCoachMail, qualityAlertMail, reminderMail } from './mails';
import { syncTurnstile } from './turnstile';
import { sendOffsite } from './offsite';
import { runWatch } from './watchers';

/**
 * Background work, outside user requests, for every shop that is active and paid (needs REDIS_URL; without it the app
 * works and these jobs are skipped — use POST /api/hooks/cron from an external scheduler instead):
 *  - courier status sync every 5 minutes (companies with live updates (webhook): every 30 minutes, in case one was lost)
 *  - Meta Ads insights sync every night
 *  - monthly partitions of the order history (every shop, even unpaid: their orders keep coming in)
 *  - Dellal follow-ups (one short message to customers who went quiet) every 15 minutes
 *  - Dellal: a quiet chat with the customer's number becomes an order (Confirmation › Nouvelles), every minute
 *  - Dellal's safety net: the linked Pages' Messenger and Instagram chats read again (messages Meta did not send), every 3 minutes
 *  - CM AI agent: comments still waiting (missed after a restart, or held during the night) every 3 minutes
 *  - AI social media manager: the planned posts whose time has come go out on Facebook and Instagram, every minute
 *  - Delivery AI agent: the customers' order messages that are due (WhatsApp, SMS) every minute
 *  - Pilot Automations: no stock left → its ads paused (back on with the stock), the evening report, the slow call queue
 *    alerts, the come-back offers, every minute
 *  - Landing pages: abandoned orders (list, Commandes, reminder) and Meta Conversions API events, every minute
 *  - Google Sheets sales channels: new lines become orders, every 2 minutes
 *  - AI Spy: competitors' Facebook ads (paid source), checked every hour, scanned once a day after the chosen hour
 *  - Formulaires: the leads of the ads' forms Meta did not send (and the forms list every 6 hours), every 10 minutes
 *  - Campagnes: the WhatsApp offers due, every minute (the shop's messages a day, never at night)
 *  - Pilot Ads: Pilote auto reads the ads' fresh numbers, suggests (or makes, within the owner's limits) one change per
 *    ad set, keeps the daily cap, and sends the audiences again once a day, every 15 minutes
 *  - Pilotix: reminders e-mailed to stores' owners before their trial / paid period ends, and when a store locks (daily)
 *  - le réseau Pilotix: what every store learned about fake orders, shared anonymously with the others, every 30 minutes
 *  - Pilotix: « Changements API », what changed at each delivery company's API (daily, 07:20; an e-mail when something did)
 *  - Pilot Auto Assign: « Livraison privée » orders waiting too long in « À attribuer » go to the backup company, every 5 minutes
 *  - Affectation automatique: waiting orders and alerts get an agent on line, absent agents give back what they never touched, every minute
 *  - Couverture: the tariffs and bureaus of the companies with an API imported again, every night
 *  - the demo shop starts again from fresh demo data every night
 *  - Pilot AI: every night, the chats of the shops that share them (personal data removed) teach Dellal (one Message Batch)
 * A job whose feature is not in a shop's plan is skipped for that shop.
 */
const FEATURE: Record<string, string | null> = {
  'courier-sync': null,
  'meta-sync': 'marketing/publicite',
  'landing-run': 'landing',
  'dellal-followups': 'pilotai/messages',
  'dellal-autoorders': 'pilotai/messages',
  'dellal-catchup': 'pilotai/messages',
  'cm-sweep': 'pilotai/cm',
  'cm-plan': 'pilotai/social',
  'notify-run': 'pilotai/notify',
  'auto-run': 'pilotai/notify',
  'depot-push': null,
  'pilot-run': null,
  'assign-run': null,
  'coverage-refresh': null,
  'spy-scan': 'marketing/spy',
  'leads-catchup': 'marketing/formulaires',
  'campaigns-run': 'marketing/campagnes',
  'catalog-run': 'marketing/catalogue',
  'ads-pilot': 'marketing/publicite',
  'sheets-sync': 'management/canaux',
  // agent pay: the people still without a pay plan, told to the admins and to whoever added them (a store with
  // Caisse › Paie, an agency; the proc answers « nothing » elsewhere)
  'pay-plan-alert': null,
};

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private conn?: IORedis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(private readonly core: CoreService) {}

  /** One job for one shop. */
  private async runFor(ref: ShopRef, name: string): Promise<unknown> {
    const session = await this.core.systemSession(ref);
    const call = (proc: string, input: unknown = {}) => this.core.call(ref, proc, session, input);
    const tag = `[${ref.shop.slug}]`;
    if (name === 'courier-sync') {
      // every 5 minutes; the run at the top / half of the hour is the full one (webhook companies too)
      const r: any = await call('delivery.sync', { fast: new Date().getMinutes() % 30 >= 5 });
      // parcels the courier could not answer for, failed steps: in the server log, not lost
      const bad = [...(r?.companies ?? []).flatMap((c: any) => [...(c.error ? [`${c.company}: ${c.error}`] : []), ...(c.errors ?? []).map((e: any) => `${e.ref}: ${e.error}`)]), ...(r?.steps ?? []).map((s: any) => `${s.step}: ${s.error}`)];
      if (bad.length) new Logger('Courier sync').warn(`${tag} ${bad.length} problem(s): ${bad.slice(0, 20).join(' | ')}`);
      return r;
    }
    // the last 3 days (Algeria time): yesterday's results are final only the next day
    if (name === 'meta-sync') {
      const day = (d: number) => new Date(Date.now() + 3_600_000 - d * 86_400_000).toISOString().slice(0, 10);
      return call('ads.sync', { from: day(3), to: day(0) });
    }
    if (name === 'landing-run') return call('landing.run');
    if (name === 'dellal-followups') return call('dellal.followUps');
    if (name === 'dellal-autoorders') return call('dellal.autoOrders');
    if (name === 'dellal-catchup') {
      const r: any = await call('dellal.catchUp');
      if (r?.error && r.error !== r.prevError) new Logger('Dellal safety net').warn(`${tag} ${r.error}`);
      else if (r?.found) new Logger('Dellal safety net').log(`${tag} ${r.found} message(s) Meta had not sent`);
      return r;
    }
    if (name === 'cm-sweep') return call('cm.sweep');
    if (name === 'cm-plan') {
      const r: any = await call('cm.plan.run');
      if (r?.failed) new Logger('Planner').warn(`${tag} ${r.failed} post(s) did not go out (CM AI agent › Planner shows why)`);
      return r;
    }
    if (name === 'notify-run') return call('notify.run');
    if (name === 'auto-run') {
      const r: any = await call('auto.run');
      if (r?.errors?.length) new Logger('Pilot Automations').warn(`${tag} ${r.errors.join(' | ')}`);
      return r;
    }
    if (name === 'depot-push') return call('depot.pushRun');
    if (name === 'pay-plan-alert') return call('pay.noPlanPush');
    if (name === 'pilot-run') return call('pilot.run');
    if (name === 'assign-run') return call('assign.run');
    if (name === 'coverage-refresh') return call('coverage.refresh');
    if (name === 'spy-scan') return call('spy.scan');
    if (name === 'campaigns-run') return call('campaigns.run');
    if (name === 'catalog-run') return call('metacatalog.run');
    if (name === 'ads-pilot') return call('ads.pilot.run');
    if (name === 'leads-catchup') {
      const r: any = await call('leads.catchUp');
      if (r?.errors?.length) new Logger('Formulaires').warn(`${tag} ${r.errors.join(' | ')}`);
      return r;
    }
    if (name === 'sheets-sync') {
      const r: any[] = (await call('channels.sheet.syncAll')) as any[];
      const bad = r.filter((c) => c.error || c.errorCount).map((c) => `${c.name}: ${c.error ?? `${c.errorCount} ligne(s) refusée(s)`}`);
      if (bad.length) new Logger('Sheets sync').warn(`${tag} ${bad.join(' | ')}`);
      return r;
    }
    return null;
  }

  async onModuleInit() {
    if (!config.redisUrl) {
      this.log.warn('REDIS_URL not set: scheduled jobs disabled (use /api/hooks/cron)');
      return;
    }
    this.conn = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('pilotix', { connection: this.conn });
    this.worker = new Worker(
      'pilotix',
      async (job) => {
        if (job.name === 'partitions') {
          for (const ref of await this.core.jobShops(true))
            for (let i = 0; i <= 3; i++)
              await ref.db.query(`SELECT ensure_events_partition((date_trunc('month', now()) + make_interval(months => $1))::date)`, [i]).catch((e) => this.log.warn(`[${ref.shop.slug}] partitions: ${e.message}`));
          return null;
        }
        if (job.name === 'platform-reminders') {
          if (!mailConfigured()) return null;
          const pay = (await this.core.settings()).payment;
          const due = await core.takeDueReminders(this.core.t);
          for (const r of due) await sendMail(reminderMail(r, pay)).catch((e) => this.log.warn(`reminder to ${r.to}: ${e?.message || e}`));
          return { sent: due.length };
        }
        if (job.name === 'fraud-reputation') {
          // le réseau Pilotix: what every store learned about fake orders, shared (as anonymous hashes) with the others
          const r = await core.refreshReputation(this.core.t);
          if (r.errors.length) this.log.warn(`fraud-reputation: ${r.errors.length} store(s) skipped: ${r.errors.slice(0, 5).join(' | ')}`);
          // the buyers' quality fell by 5 points or more this week: the owner and the managers hear it, once a week
          if (mailConfigured()) {
            const alert = await core.takeQualityAlert(this.core.t);
            if (alert) {
              const staff = await this.core.t.platform.query<{ name: string; email: string }>(`SELECT name, email FROM platform.staff WHERE active AND role IN ('owner', 'manager')`);
              for (const s of staff) await sendMail(qualityAlertMail({ to: s.email, name: s.name, alert })).catch((e) => this.log.warn(`quality alert to ${s.email}: ${e?.message || e}`));
            }
          }
          return { shops: r.shops, keys: r.keys };
        }
        if (job.name === 'courier-watch') return watchNow(this.core, null);
        if (job.name === 'doctor-watch') {
          // the bug detector: the test robot, the outside services, the data checker, the judge, the red alerts
          await runWatch(this.core);
          return { done: true };
        }
        if (job.name === 'turnstile-sync') {
          // Cloudflare's widgets in step with the shops' domains (a shop stopped, a domain became ready…)
          const st = await syncTurnstile(this.core);
          if (st.lastError) throw new Error(st.lastError);
          return { domains: st.domains, widgets: st.widgets.length };
        }
        if (job.name === 'offsite-backup') {
          // the night's backup, encrypted, to Backblaze once it is there (Sauvegardes › Copie hors du serveur)
          const st = await sendOffsite(this.core);
          if (st.configured && st.lastError) throw new Error(st.lastError);
          return { sent: st.sent, file: st.lastFile };
        }
        if (job.name === 'pilot-ai-night') {
          // started on its own: the AI batch can take a while and must not hold the other jobs (one worker)
          void this.pilotNight();
          return { started: true };
        }
        if (job.name === 'demo-reset') {
          for (const s of await core.loadShops(this.core.t))
            if (s.demo && !s.primary && s.status === 'active') {
              await core.resetDemoShop(this.core.t, s.id).catch((e) => this.log.warn(`demo reset: ${e.message}`));
              this.core.invalidate();
            }
          return null;
        }
        // one run of a job at a time: a slow one (courier sync) never runs twice, and never holds the others up
        if (this.running.has(job.name)) return { skipped: 'still running' };
        this.running.add(job.name);
        try {
          const f = FEATURE[job.name];
          const shops = (await this.core.jobShops()).filter(
            // the demo shop only simulates: nothing to run in the background
            (ref) => !ref.shop.demo && f !== undefined && (!f || featureOn(ref.rules.features, f)),
          );
          let done = 0;
          let asleep = 0;
          let failed = 0;
          // several shops at once (JOB_SHOPS_PARALLEL); a sleeping shop (nobody, no order for weeks) is skipped
          await eachLimited(shops, config.jobShopsParallel, async (ref) => {
            if (!(await this.awake(ref))) return void asleep++;
            try {
              await this.runFor(ref, job.name);
              done++;
            } catch (e) {
              failed++;
              this.log.error(`[${ref.shop.slug}] ${job.name} failed: ${(e as Error).message}`);
            }
          });
          return { shops: done, asleep, failed };
        } finally {
          this.running.delete(job.name);
        }
      },
      // a few jobs at once (each one only once, see above): the courier sync waits on the companies' APIs while the
      // every-minute jobs go on
      { connection: this.conn, concurrency: 3 },
    );
    this.worker.on('failed', (job, err) => {
      if (job?.name) doctorState.job(job.name, false, err.message);
      this.log.error(`${job?.name} failed: ${err.message}`);
    });
    // the Doctor (control room) sees each job's last run
    this.worker.on('completed', (job) => doctorState.job(job.name, true));
    // couriers every 5 minutes (it was 30): Redis keeps the old repeat timer, removed here
    try {
      for (const r of await this.queue.getRepeatableJobs()) if (r.name === 'courier-sync' && Number(r.every) !== 5 * 60_000) await this.queue.removeRepeatableByKey(r.key);
    } catch (e) {
      this.log.warn(`courier-sync: old timer not removed (${(e as Error).message})`);
    }
    await this.queue.add('courier-sync', {}, { repeat: { every: 5 * 60_000 }, jobId: 'courier-sync', removeOnComplete: 50, removeOnFail: 100 });
    await this.queue.add('meta-sync', {}, { repeat: { pattern: '30 4 * * *' }, jobId: 'meta-sync', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('dellal-followups', {}, { repeat: { every: 15 * 60_000 }, jobId: 'dellal-followups', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('dellal-autoorders', {}, { repeat: { every: 60_000 }, jobId: 'dellal-autoorders', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('dellal-catchup', {}, { repeat: { every: 3 * 60_000 }, jobId: 'dellal-catchup', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('cm-sweep', {}, { repeat: { every: 3 * 60_000 }, jobId: 'cm-sweep', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('cm-plan', {}, { repeat: { every: 60_000 }, jobId: 'cm-plan', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('notify-run', {}, { repeat: { every: 60_000 }, jobId: 'notify-run', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('auto-run', {}, { repeat: { every: 60_000 }, jobId: 'auto-run', removeOnComplete: 20, removeOnFail: 50 });
    // dépôt alerts: the phones of the people who get them ring again until they open the app
    await this.queue.add('depot-push', {}, { repeat: { every: 30_000 }, jobId: 'depot-push', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('coverage-refresh', {}, { repeat: { pattern: '20 2 * * *', tz: 'Africa/Algiers' }, jobId: 'coverage-refresh', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('pilot-run', {}, { repeat: { every: 5 * 60_000 }, jobId: 'pilot-run', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('assign-run', {}, { repeat: { every: 60_000 }, jobId: 'assign-run', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('landing-run', {}, { repeat: { every: 60_000 }, jobId: 'landing-run', removeOnComplete: 20, removeOnFail: 50 });
    // Google Sheets every 2 minutes. Redis keeps repeat timers: one left from another interval (it was 10 minutes) is removed
    const SHEETS_EVERY = 2 * 60_000;
    try {
      for (const r of await this.queue.getRepeatableJobs()) if (r.name === 'sheets-sync' && Number(r.every) !== SHEETS_EVERY) await this.queue.removeRepeatableByKey(r.key);
    } catch (e) {
      this.log.warn(`sheets-sync: old timer not removed (${(e as Error).message})`);
    }
    await this.queue.add('sheets-sync', {}, { repeat: { every: SHEETS_EVERY }, jobId: 'sheets-sync', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('spy-scan', {}, { repeat: { pattern: '7 * * * *' }, jobId: 'spy-scan', removeOnComplete: 20, removeOnFail: 50 });
    // Marketing › Formulaires: the safety net of the ads' lead forms (a webhook Meta did not send)
    await this.queue.add('leads-catchup', {}, { repeat: { every: 10 * 60_000 }, jobId: 'leads-catchup', removeOnComplete: 20, removeOnFail: 50 });
    // Marketing › Campagnes: the WhatsApp offers due, a few each minute (the shop's messages a day, never at night)
    await this.queue.add('campaigns-run', {}, { repeat: { every: 60_000 }, jobId: 'campaigns-run', removeOnComplete: 20, removeOnFail: 50 });
    // Marketing › Catalogue: what changed in the lists' products goes to Meta, and Meta's answers come back
    await this.queue.add('catalog-run', {}, { repeat: { every: 10 * 60_000 }, jobId: 'catalog-run', removeOnComplete: 20, removeOnFail: 50 });
    // Marketing › Publicité › Pilote auto: the ads' rules (stop the loss, trim, the daily cap…), every 15 minutes
    await this.queue.add('ads-pilot', {}, { repeat: { every: 15 * 60_000 }, jobId: 'ads-pilot', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('turnstile-sync', {}, { repeat: { every: 30 * 60_000 }, jobId: 'turnstile-sync', removeOnComplete: 20, removeOnFail: 50 });
    // the bug detector (Control room › Doctor): every 10 minutes
    await this.queue.add('doctor-watch', {}, { repeat: { every: 10 * 60_000 }, jobId: 'doctor-watch', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('offsite-backup', {}, { repeat: { every: 30 * 60_000 }, jobId: 'offsite-backup', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('fraud-reputation', {}, { repeat: { every: 30 * 60_000 }, jobId: 'fraud-reputation', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('partitions', {}, { repeat: { pattern: '0 3 1 * *' }, jobId: 'partitions', removeOnComplete: 10 });
    // 03:40 UTC = 04:40 in Algeria: nobody is visiting the demo
    await this.queue.add('demo-reset', {}, { repeat: { pattern: '40 3 * * *' }, jobId: 'demo-reset', removeOnComplete: 10, removeOnFail: 20 });
    // 02:30 in Algeria: Dellal learns from the day's chats while nobody is buying; the coach finds the lessons in the morning
    await this.queue.add('pilot-ai-night', {}, { repeat: { pattern: '30 2 * * *', tz: 'Africa/Algiers' }, jobId: 'pilot-ai-night', removeOnComplete: 20, removeOnFail: 50 });
    // every morning at 08:00 in Algeria (what the control room's settings say), whatever the server's time zone
    await this.queue.add('platform-reminders', {}, { repeat: { pattern: '0 8 * * *', tz: 'Africa/Algiers' }, jobId: 'platform-reminders', removeOnComplete: 20, removeOnFail: 50 });
    // 09:10 in Algeria: who still has no pay plan (once a day)
    await this.queue.add('pay-plan-alert', {}, { repeat: { pattern: '10 9 * * *', tz: 'Africa/Algiers' }, jobId: 'pay-plan-alert', removeOnComplete: 20, removeOnFail: 50 });
    // the delivery companies' APIs looked at every morning, before the work day (Algeria time)
    await this.queue.add('courier-watch', {}, { repeat: { pattern: '20 7 * * *', tz: 'Africa/Algiers' }, jobId: 'courier-watch', removeOnComplete: 20, removeOnFail: 50 });
  }

  /** The jobs running now. */
  private running = new Set<string>();
  /** Each shop's newest order, looked at again every 10 minutes (to know which shops sleep). */
  private newest = new Map<number, { at: number; checked: number }>();

  /**
   * A shop is awake when someone used the app, an order came in, or it was opened, in the last JOB_SLEEP_DAYS days.
   * A sleeping shop costs nothing in the background; it wakes with its next order or the next time someone opens it.
   */
  private async awake(ref: ShopRef): Promise<boolean> {
    const limit = Date.now() - config.jobSleepDays * 86_400_000;
    if ((Date.parse(ref.shop.lastActiveAt ?? '') || 0) > limit || (Date.parse(ref.shop.createdAt ?? '') || 0) > limit) return true;
    let n = this.newest.get(ref.shop.id);
    if (!n || Date.now() - n.checked > 10 * 60_000) {
      // the last order by number (its key): no table scan, even with many orders
      const r = await ref.db.query<{ created_at: string | Date }>('SELECT created_at FROM orders ORDER BY id DESC LIMIT 1').catch(() => null);
      // not readable: counted as awake (never skip a shop by mistake)
      n = { at: r === null ? Date.now() : r[0] ? new Date(r[0].created_at).getTime() : 0, checked: Date.now() };
      this.newest.set(ref.shop.id, n);
    }
    return n.at > limit;
  }

  private pilotBusy = false;
  /**
   * Pilot AI, every night: each sharing shop's new or changed chats go to the platform (names, phones, addresses removed
   * inside the shop), then Dellal's learning runs once for all (scores, the AI batch, lessons for the coach, the test).
   */
  private async pilotNight(): Promise<void> {
    if (this.pilotBusy) return;
    this.pilotBusy = true;
    const log = new Logger('Pilot AI');
    try {
      const t = this.core.t;
      const conf = await core.pilotConfig(t);
      if (!conf.enabled) return;
      const pdb = t.platform;
      const now = new Date();
      let shops = 0;
      for (const ref of await this.core.jobShops()) {
        // only the shops chosen in the control room (super admin) teach Dellal
        if (ref.shop.demo || !conf.shops.includes(ref.shop.id) || !featureOn(ref.rules.features, 'pilotai/messages')) continue;
        try {
          const since = await core.pilotLearn.pilotSince(pdb, ref.shop.id);
          const cases = await core.pilotLearn.collectCases(ref.db, { shopId: ref.shop.id, since, now, limit: 2000 });
          await core.pilotLearn.saveCases(pdb, cases);
          await core.pilotLearn.pilotAdvance(pdb, ref.shop.id, core.pilotLearn.nextSince(cases, { limit: 2000, now, since }));
          shops++;
        } catch (e) {
          log.warn(`[${ref.shop.slug}] ${(e as Error).message}`);
        }
      }
      const key = await core.pilotKey(t);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const batch = key ? require('@pilotix/core/dist/dellal-server').pilotBatch(key) : null;
      const startedAt = new Date();
      const r = await core.pilotLearn.learnNight(pdb, batch, { now: startedAt, maxUsd: conf.maxUsd });
      log.log(`${shops} shop(s) · ${r.cases.total} chat(s) · ${r.spend.line}`);
      doctorState.job('pilot-ai-night', true);
      // the coach's morning note: lessons wait for an answer (every active staff member: anyone of them may approve)
      if (mailConfigured()) {
        const d = await core.pilotCoachDigest(t, startedAt);
        if (d.waiting > 0) {
          const staff = await t.platform.query<{ name: string; email: string }>(`SELECT name, email FROM platform.staff WHERE active`);
          for (const s of staff) await sendMail(pilotCoachMail({ to: s.email, name: s.name, ...d })).catch((e) => log.warn(`coach note to ${s.email}: ${e?.message || e}`));
        }
      }
    } catch (e) {
      doctorState.job('pilot-ai-night', false, (e as Error).message);
      log.error(`failed: ${(e as Error).message}`);
    } finally {
      this.pilotBusy = false;
    }
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    await this.conn?.quit();
  }
}

/** Runs fn for every item, at most `limit` at the same time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

@Module({ providers: [JobsService] })
export class JobsModule {}
