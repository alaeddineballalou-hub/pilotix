import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { DbService } from '../db/db.service';

export interface NotifyJob {
  orderId: number;
  phone: string;
  template: 'order_confirmed' | 'order_shipped' | 'order_delivered';
  language: 'fr' | 'en' | 'ar';
}

/**
 * Background work, kept out of user requests:
 *  - "notifications": WhatsApp / SMS messages to customers
 *  - "maintenance":   daily creation of future monthly order partitions
 * Runs only when REDIS_URL is set; without Redis the app still works and jobs are skipped.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private connection?: IORedis;
  private notifications?: Queue<NotifyJob>;
  private maintenance?: Queue;
  private workers: Worker[] = [];

  constructor(private readonly db: DbService) {}

  async onModuleInit() {
    if (!config.redisUrl) {
      this.log.warn('REDIS_URL not set: background jobs are disabled.');
      return;
    }
    this.connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
    const connection = this.connection;
    this.notifications = new Queue<NotifyJob>('notifications', { connection });
    this.maintenance = new Queue('maintenance', { connection });

    this.workers.push(
      new Worker<NotifyJob>(
        'notifications',
        async (job) => {
          // Plug the WhatsApp Business / SMS provider here (approved templates only).
          this.log.log(`Notify ${job.data.template} (${job.data.language}) for order ${job.data.orderId}`);
        },
        { connection, concurrency: 10, limiter: { max: 20, duration: 1000 } },
      ),
      new Worker(
        'maintenance',
        async () => {
          for (let i = 0; i <= 3; i++) {
            await this.db.query(`SELECT ensure_orders_partition((date_trunc('month', now()) + make_interval(months => $1))::date)`, [i]);
          }
        },
        { connection },
      ),
    );
    for (const w of this.workers) w.on('failed', (job, err) => this.log.error(`Job ${job?.name} failed: ${err.message}`));

    await this.maintenance.add('partitions', {}, { repeat: { pattern: '0 3 * * *' }, jobId: 'partitions-daily' });
  }

  async notify(data: NotifyJob) {
    if (!this.notifications) return;
    await this.notifications.add(data.template, data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close()));
    await this.notifications?.close();
    await this.maintenance?.close();
    await this.connection?.quit();
  }
}

@Global()
@Module({ providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
