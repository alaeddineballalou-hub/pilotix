// Pilotix server: runs the shared core (all business rules) on PostgreSQL and exposes it over HTTP. One server hosts
// several shops, each in its own PostgreSQL schema (see packages/core/src/platform); the public links below also exist
// as /api/s/<shop>/… for every shop but the first (the old links without /s/… lead to shop #1).
//   POST /api/auth/login            → { token, session } (the e-mail tells which shop)
//   GET|POST /api/auth/demo         → the demo shop's button on the login page
//   POST /api/platform/…            → the control room (Pilotix staff: shops, trials, payments, plans), see platform.ts
//   POST /api/rpc/:name             → runs one core action for the logged-in user (role checks in the core)
//   POST /api/hooks/orders/:channel → orders from a website / store (key in ?key= or x-webhook-key)
//   POST /api/hooks/cron            → courier status sync, called by an external scheduler (?key=)
//   POST /api/hooks/courier/:id     → a courier's status change (ZR webhook, ?key= set when it was turned on)
//   GET|POST /api/hooks/meta        → Dellal: WhatsApp, Messenger and Instagram messages (Meta webhook)
//   POST /api/hooks/tiktok          → Dellal: TikTok messages (?key= the Dellal verify token)
//   POST /api/hooks/sms             → Delivery AI agent: SMS gateway reports and SMS answers (?key= the SMS hook key)
//   GET  /api/lp/:slug              → a product's landing page (public HTML); POST /api/lp/:slug/order, GET /api/lp/geo/:w, /api/lp/img/:id/:w.webp
//   GET  /api/health
//   Socket.IO at /live              → "something changed" events for open screens
import 'reflect-metadata';
import { Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiModule } from './api';
import { config } from './config';
import { DoctorLogger, watchProcess } from './doctor';
import * as core from '@pilotix/core';
import { CoreModule, CoreService } from './core.service';
import { JobsModule } from './jobs';
import { keepLimits, stopKeepingLimits } from './limits';
import { LiveModule } from './live';
import { startSecretBox } from './secretbox';

/** The login counters, written down when the server stops (read back at the start: see keepLimits below). */
@Injectable()
class LimitsKeeper implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await stopKeepingLimits();
  }
}

@Module({ imports: [CoreModule, LiveModule, ApiModule, JobsModule], providers: [LimitsKeeper] })
class AppModule {}

async function bootstrap() {
  // the saved secrets (couriers' keys, tokens): sealed as they are written, opened as they are read (DATA_KEY)
  const sealing = startSecretBox(process.env.DATA_KEY);
  // the Doctor (control room) keeps every error and warning the server writes
  const logger = new DoctorLogger();
  logger.setLogLevels(['error', 'warn', 'log']);
  watchProcess();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: config.trustProxy as any, bodyLimit: 5 * 1024 * 1024 }), {
    logger,
    rawBody: true, // Meta webhooks are signed over the raw body
  });
  // what anyone can send without being logged in stays small: logins and sign-ups, landing page forms, webhooks
  // (the rest — the app's own actions, its pictures and imports — keeps the 5 MB above)
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route: { url?: string; bodyLimit?: number }) => {
      const url = String(route.url ?? '');
      if (/^\/api\/(auth|platform\/auth)\//.test(url)) route.bodyLimit = 64 * 1024;
      else if (/^\/api\/(s\/[^/]+\/)?lp\//.test(url)) route.bodyLimit = 64 * 1024;
      else if (/^\/api\/(s\/[^/]+\/)?hooks\//.test(url)) route.bodyLimit = 1024 * 1024;
      // a planned post's video comes in pieces of 8 MB (CM AI agent › Planner)
      else if (/^\/api\/(s\/[^/]+\/)?cm\/video\//.test(url)) route.bodyLimit = 9 * 1024 * 1024;
    })
    // and what a request carries is counted before anything checks it: a list of millions of tiny items fits in 5 MB,
    // and checking each of them one by one would fill the memory (core.inputTooBig)
    .addHook('preValidation', async (req: { body?: unknown }, reply: any) => {
      if (!req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) return;
      const big = core.inputTooBig(req.body);
      if (big) return reply.code(413).send({ statusCode: 413, error: 'Payload Too Large', message: big });
    });
  // the pieces of a planned post's video arrive as they are (bytes, not JSON): PUT /api/cm/video/…
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 9 * 1024 * 1024 }, (_req: unknown, body: Buffer, done: (e: Error | null, b?: Buffer) => void) => done(null, body));
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.enableShutdownHooks();
  // the failed logins counted before an update still count after it
  await keepLimits(config.redisUrl);
  await app.listen(config.port, '0.0.0.0');
  new Logger('Pilotix').log(`Server ready on port ${config.port}`);
  // what was saved readable before (an older version, no DATA_KEY yet): sealed now, in the background
  if (sealing)
    void core
      .sealStoredSecrets(app.get(CoreService).t)
      .then((r) => r && r.sealed && new Logger('Secrets').log(`${r.sealed} saved secrets sealed (${r.shops} shops checked)`))
      .catch((e) => new Logger('Secrets').warn(`Sealing the saved secrets stopped: ${(e as Error).message}`));
}

bootstrap();
