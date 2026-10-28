import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as core from '@pilotix/core';
import { featureOn } from '@pilotix/shared';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';
import { CoreService, ShopRef } from './core.service';
import { doctorState } from './doctor';
import { mailConfigured, sendMail } from './mail';
import { reminderMail } from './mails';
import { syncTurnstile } from './turnstile';

/**
 * Background work, outside user requests, for every shop that is active and paid (needs REDIS_URL; without it the app
 * works and these jobs are skipped — use POST /api/hooks/cron from an external scheduler instead):
 *  - courier status sync every 30 minutes
 *  - Meta Ads insights sync every night
 *  - monthly partitions of the order history (every shop, even unpaid: their orders keep coming in)
 *  - Dellal follow-ups (one short message to customers who went quiet) every 15 minutes
 *  - CM AI agent: comments still waiting (missed after a restart, or held during the night) every 3 minutes
 *  - Delivery AI agent: the customers' order messages that are due (WhatsApp, SMS) every minute
 *  - Landing pages: abandoned orders (list, Commandes, reminder) and Meta Conversions API events, every minute
 *  - Google Sheets sales channels: new lines become orders, every 2 minutes
 *  - AI Spy: competitors' Facebook ads (paid source), checked every hour, scanned once a day after the chosen hour
 *  - Pilotix: reminders e-mailed to stores' owners before their trial / paid period ends, and when a store locks (daily)
 *  - the demo shop starts again from fresh demo data every night
 * A job whose feature is not in a shop's plan is skipped for that shop.
 */
const FEATURE: Record<string, string | null> = {
  'courier-sync': null,
  'meta-sync': 'marketing/publicite',
  'landing-run': 'landing',
  'dellal-followups': 'pilotai/messages',
  'cm-sweep': 'pilotai/cm',
  'notify-run': 'pilotai/notify',
  'depot-push': null,
  'spy-scan': 'marketing/spy',
  'sheets-sync': 'management/canaux',
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
      const r: any = await call('delivery.sync');
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
    if (name === 'cm-sweep') return call('cm.sweep');
    if (name === 'notify-run') return call('notify.run');
    if (name === 'depot-push') return call('depot.pushRun');
    if (name === 'spy-scan') return call('spy.scan');
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
        if (job.name === 'turnstile-sync') {
          // Cloudflare's widgets in step with the shops' domains (a shop stopped, a domain became ready…)
          const st = await syncTurnstile(this.core);
          if (st.lastError) throw new Error(st.lastError);
          return { domains: st.domains, widgets: st.widgets.length };
        }
        if (job.name === 'demo-reset') {
          for (const s of await core.loadShops(this.core.t))
            if (s.demo && !s.primary && s.status === 'active') {
              await core.resetDemoShop(this.core.t, s.id).catch((e) => this.log.warn(`demo reset: ${e.message}`));
              this.core.invalidate();
            }
          return null;
        }
        const out: Record<string, unknown> = {};
        for (const ref of await this.core.jobShops()) {
          if (ref.shop.demo) continue; // the demo shop only simulates: nothing to run in the background
          const f = FEATURE[job.name];
          if (f === undefined || (f && !featureOn(ref.rules.features, f))) continue;
          try {
            out[ref.shop.slug] = await this.runFor(ref, job.name);
          } catch (e) {
            this.log.error(`[${ref.shop.slug}] ${job.name} failed: ${(e as Error).message}`);
          }
        }
        return out;
      },
      { connection: this.conn, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      if (job?.name) doctorState.job(job.name, false, err.message);
      this.log.error(`${job?.name} failed: ${err.message}`);
    });
    // the Doctor (control room) sees each job's last run
    this.worker.on('completed', (job) => doctorState.job(job.name, true));
    await this.queue.add('courier-sync', {}, { repeat: { every: 30 * 60_000 }, jobId: 'courier-sync', removeOnComplete: 50, removeOnFail: 100 });
    await this.queue.add('meta-sync', {}, { repeat: { pattern: '30 4 * * *' }, jobId: 'meta-sync', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('dellal-followups', {}, { repeat: { every: 15 * 60_000 }, jobId: 'dellal-followups', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('cm-sweep', {}, { repeat: { every: 3 * 60_000 }, jobId: 'cm-sweep', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('notify-run', {}, { repeat: { every: 60_000 }, jobId: 'notify-run', removeOnComplete: 20, removeOnFail: 50 });
    // dépôt alerts: the phones of the people who get them ring again until they open the app
    await this.queue.add('depot-push', {}, { repeat: { every: 30_000 }, jobId: 'depot-push', removeOnComplete: 20, removeOnFail: 50 });
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
    await this.queue.add('turnstile-sync', {}, { repeat: { every: 30 * 60_000 }, jobId: 'turnstile-sync', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('partitions', {}, { repeat: { pattern: '0 3 1 * *' }, jobId: 'partitions', removeOnComplete: 10 });
    // 03:40 UTC = 04:40 in Algeria: nobody is visiting the demo
    await this.queue.add('demo-reset', {}, { repeat: { pattern: '40 3 * * *' }, jobId: 'demo-reset', removeOnComplete: 10, removeOnFail: 20 });
    // every morning at 08:00 in Algeria (what the control room's settings say), whatever the server's time zone
    await this.queue.add('platform-reminders', {}, { repeat: { pattern: '0 8 * * *', tz: 'Africa/Algiers' }, jobId: 'platform-reminders', removeOnComplete: 20, removeOnFail: 50 });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    await this.conn?.quit();
  }
}

@Module({ providers: [JobsService] })
export class JobsModule {}
