// Pilotix server: runs the shared core (all business rules) on PostgreSQL and exposes it over HTTP.
//   POST /api/auth/login            → { token, session }
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
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiModule } from './api';
import { config } from './config';
import { CoreModule } from './core.service';
import { JobsModule } from './jobs';
import { LiveModule } from './live';

@Module({ imports: [CoreModule, LiveModule, ApiModule, JobsModule] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true, bodyLimit: 5 * 1024 * 1024 }), {
    logger: ['error', 'warn', 'log'],
    rawBody: true, // Meta webhooks are signed over the raw body
  });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  new Logger('Pilotix').log(`Server ready on port ${config.port}`);
}

bootstrap();
