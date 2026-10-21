// Pilotix server: runs the shared core (all business rules) on PostgreSQL and exposes it over HTTP.
//   POST /api/auth/login            → { token, session }
//   POST /api/rpc/:name             → runs one core action for the logged-in user (role checks in the core)
//   POST /api/hooks/orders/:channel → orders from a website / store (key in ?key= or x-webhook-key)
//   POST /api/hooks/cron            → courier status sync, called by an external scheduler (?key=)
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
  });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  new Logger('Pilotix').log(`Server ready on port ${config.port}`);
}

bootstrap();
