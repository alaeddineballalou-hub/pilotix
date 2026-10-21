import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuthModule } from './auth/auth';
import { config } from './config';
import { DashboardModule } from './dashboard/dashboard';
import { DbModule } from './db/db.service';
import { JobsModule } from './jobs/jobs.service';
import { LiveModule } from './live/live.gateway';
import { OrdersModule } from './orders/orders.controller';
import { ProductsModule } from './products/products';
import { UsersModule } from './users/users';

@Module({
  imports: [DbModule, AuthModule, LiveModule, JobsModule, OrdersModule, ProductsModule, UsersModule, DashboardModule],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 2 * 1024 * 1024 }),
  );
  app.setGlobalPrefix('api', { exclude: [] });
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  new Logger('Pilotix').log(`Server ready on port ${config.port}`);
}

bootstrap();
