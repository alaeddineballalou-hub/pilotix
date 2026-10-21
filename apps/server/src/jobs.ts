import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';
import { CoreService } from './core.service';

/**
 * Background work, outside user requests (needs REDIS_URL; without it the app works and these jobs are skipped —
 * use POST /api/hooks/cron from an external scheduler instead):
 *  - courier status sync every 30 minutes
 *  - Meta Ads insights sync every night
 *  - monthly partitions of the order history
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private conn?: IORedis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(private readonly core: CoreService) {}

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
        const session = await this.core.systemSession();
        if (job.name === 'courier-sync') return this.core.call('delivery.sync', session, {});
        if (job.name === 'meta-sync') return this.core.call('ads.sync', session, {});
        if (job.name === 'partitions') {
          for (let i = 0; i <= 3; i++) await this.core.db.query(`SELECT ensure_events_partition((date_trunc('month', now()) + make_interval(months => $1))::date)`, [i]);
        }
      },
      { connection: this.conn, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.log.error(`${job?.name} failed: ${err.message}`));
    await this.queue.add('courier-sync', {}, { repeat: { every: 30 * 60_000 }, jobId: 'courier-sync', removeOnComplete: 50, removeOnFail: 100 });
    await this.queue.add('meta-sync', {}, { repeat: { pattern: '30 4 * * *' }, jobId: 'meta-sync', removeOnComplete: 20, removeOnFail: 50 });
    await this.queue.add('partitions', {}, { repeat: { pattern: '0 3 1 * *' }, jobId: 'partitions', removeOnComplete: 10 });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    await this.conn?.quit();
  }
}

@Module({ providers: [JobsService] })
export class JobsModule {}
