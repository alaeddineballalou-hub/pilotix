import {
  ArgumentsHost,
  Body,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  ExecutionContext,
  Get,
  Headers,
  HttpException,
  Injectable,
  Logger,
  Module,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as core from '@pilotix/core';
import { normalizePhone, Session } from '@pilotix/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from './config';
import { CoreService } from './core.service';

// ---------------------------------------------------------------- errors → HTTP
const STATUS: Record<string, number> = { bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409 };

@Catch()
class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('API');
  catch(e: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status = 500;
    let message = 'Erreur du serveur';
    if (e instanceof core.AppError) {
      status = STATUS[e.code] ?? 400;
      message = e.message;
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      const r = e.getResponse() as any;
      message = typeof r === 'string' ? r : r?.message ?? e.message;
    } else {
      this.log.error(e?.stack || e);
    }
    res.status(status).send({ message });
  }
}

// ---------------------------------------------------------------- auth
const PUBLIC = 'px:public';
const Public = () => SetMetadata(PUBLIC, true);

@Injectable()
class AuthGuard implements CanActivate {
  /** Profiles are re-read at most every 30 s, so a deactivated account loses access quickly. */
  private cache = new Map<number, { s: Session; at: number }>();
  constructor(
    private readonly jwt: JwtService,
    private readonly core: CoreService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const h: string = req.headers?.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) throw new UnauthorizedException('Connectez-vous');
    let id: number;
    try {
      id = Number((await this.jwt.verifyAsync<{ sub: number }>(token)).sub);
    } catch {
      throw new UnauthorizedException('Session expirée, reconnectez-vous');
    }
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < 30_000) {
      req.session = hit.s;
      return true;
    }
    const p = await core.profileById(this.core.db, id);
    if (!p || !p.active) throw new UnauthorizedException('Compte désactivé');
    const s = core.makeSession(p);
    this.cache.set(id, { s, at: Date.now() });
    req.session = s;
    return true;
  }
}

/** 10 login attempts per 15 minutes per address. */
const attempts = new Map<string, { n: number; until: number }>();
function limitLogin(ip: string) {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const a = attempts.get(ip);
  if (!a || a.until < now) return void attempts.set(ip, { n: 1, until: now + 15 * 60_000 });
  if (++a.n > 10) throw new HttpException({ message: 'Trop de tentatives, réessayez dans quelques minutes' }, 429);
}

/** Dellal: newest message per conversation and the answer running for it. */
const latest = new Map<number, number>();
const running = new Map<number, Promise<unknown>>();
/** CM AI agent: one answer at a time (comments arrive in bursts under an ad). */
let cmQueue: Promise<unknown> = Promise.resolve();
function optionalDellal(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@pilotix/core/dist/dellal-server');
  } catch {
    return null;
  }
}

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

@Controller()
@UseGuards(AuthGuard)
class ApiController {
  constructor(
    private readonly core: CoreService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Get('health')
  async health() {
    await this.core.db.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  }

  @Public()
  @Post('auth/login')
  async login(@Body() body: unknown, @Req() req: { ip?: string }) {
    limitLogin(req.ip || 'unknown');
    const b = LoginBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Email ou mot de passe manquant');
    const session = await core.login(this.core.db, b.data.email, b.data.password);
    const token = await this.jwt.signAsync({ sub: session.profile.id });
    return { token, session };
  }

  @Post('rpc/:name')
  rpc(@Param('name') name: string, @Body() body: unknown, @Req() req: { session: Session }) {
    // names like orders.list, and grouped ones like dellal.settings.get or cm.settings.save
    if (!/^[a-z]+(\.[a-zA-Z]+){1,3}$/.test(name)) throw new core.AppError('not_found', 'Action inconnue');
    return this.core.call(name, req.session, body ?? {});
  }

  /**
   * Orders from a website or a store. Body: { name|customer_name, phone, phone2?, wilaya (code), commune?, address?, stopdesk?,
   *   items: [{ sku, qty, price? }], note?, source?, utm? }. Key: ?key= or header x-webhook-key.
   */
  @Public()
  @Post('hooks/orders/:channel')
  async orderHook(@Param('channel') channel: string, @Query('key') qkey: string, @Headers('x-webhook-key') hkey: string, @Body() body: any) {
    const key = qkey || hkey || '';
    const db = this.core.db;
    let ch: any = null;
    if (/^\d+$/.test(channel)) ch = (await db.query('SELECT * FROM sales_channels WHERE id = $1 AND active', [Number(channel)]))[0];
    const shopKey = (await core.getSetting(db, 'webhook')).key;
    const ok = ch ? key && key === ch.webhook_key : channel === 'site' && shopKey && key === shopKey;
    if (!ok) throw new core.AppError('unauthorized', 'Clé webhook invalide');

    const items: { productId: number; variantId: number | null; qty: number; unitPrice?: number }[] = [];
    for (const it of Array.isArray(body?.items) ? body.items : []) {
      const sku = String(it.sku ?? '').trim();
      const v = (await db.query('SELECT v.id, v.product_id FROM product_variants v WHERE v.sku = $1', [sku]))[0];
      const p = v ? null : (await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0];
      if (!v && !p) {
        if (ch?.sku_required) throw new core.AppError('bad_request', `SKU inconnu : ${sku}`);
        continue;
      }
      items.push({ productId: Number(v?.product_id ?? p.id), variantId: v ? Number(v.id) : null, qty: Math.max(1, Number(it.qty) || 1), unitPrice: it.price !== undefined ? Math.round(Number(it.price)) : undefined });
    }
    if (!items.length) throw new core.AppError('bad_request', 'Aucun produit reconnu (vérifiez les SKU)');
    const phone = normalizePhone(String(body?.phone ?? ''));
    if (!phone) throw new core.AppError('bad_request', 'Téléphone invalide');
    const session = await this.core.systemSession();
    const order: any = await this.core.call('orders.create', session, {
      customerName: String(body?.customer_name ?? body?.name ?? '').slice(0, 120) || 'Client',
      phone,
      phone2: body?.phone2 ? String(body.phone2) : null,
      wilayaId: Number(body?.wilaya ?? body?.wilaya_id),
      commune: String(body?.commune ?? ''),
      address: String(body?.address ?? ''),
      isStopdesk: !!body?.stopdesk,
      channel: (['site', 'facebook', 'instagram', 'tiktok', 'appel', 'whatsapp', 'autre'].includes(body?.channel) ? body.channel : 'site') as any,
      source: ch ? ch.name : String(body?.source ?? 'site'),
      utm: body?.utm && typeof body.utm === 'object' ? body.utm : null,
      items,
      customerNote: body?.note ? String(body.note).slice(0, 1000) : null,
    });
    if (ch) await db.query('UPDATE sales_channels SET last_sync_at = now() WHERE id = $1', [ch.id]);
    return { ok: true, id: order.id, ref: order.ref };
  }

  // ---------------------------------------------------------------- Dellal (AI sales agent) webhooks
  /** Meta checks the webhook once: answer hub.challenge when the verify token matches. */
  @Public()
  @Get('hooks/meta')
  async metaVerify(@Query() q: Record<string, string>, @Res() res: any) {
    const r: any = await this.core.call('dellal.routing', await this.core.systemSession(), {});
    if (q['hub.mode'] === 'subscribe' && r.verifyToken && q['hub.verify_token'] === r.verifyToken) return res.status(200).header('Content-Type', 'text/plain').send(String(q['hub.challenge'] ?? ''));
    return res.status(403).send({ message: 'Jeton de vérification invalide' });
  }

  /** WhatsApp, Messenger and Instagram messages, and comments on posts and ads. Answers 200 at once; Dellal and the CM AI agent reply in the background. */
  @Public()
  @Post('hooks/meta')
  async metaHook(@Req() req: RawBodyRequest<any>, @Headers('x-hub-signature-256') sig: string, @Body() body: any) {
    const db = this.core.db;
    const secret = String((await db.query(`SELECT value FROM settings WHERE key = 'secret_dellal_meta_app_secret'`))[0]?.value ?? '');
    if (secret) {
      const raw: Buffer | undefined = req.rawBody;
      const want = 'sha256=' + createHmac('sha256', secret).update(raw ?? Buffer.from(JSON.stringify(body ?? {}))).digest('hex');
      const ok = !!sig && sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
      if (!ok) throw new core.AppError('unauthorized', 'Signature Meta invalide');
    }
    const m = optionalDellal();
    const list: any[] = m?.parseMetaWebhook ? m.parseMetaWebhook(body) : [];
    // comments make the page act in public (reply, hide): only from a webhook signed with the Meta app secret
    let comments: any[] = m?.parseMetaComments ? m.parseMetaComments(body) : [];
    if (comments.length && !secret) {
      new Logger('CM').warn('comments ignored: add the Meta app secret (Message AI agent › Réglages) so webhooks are signed');
      comments = [];
    }
    void this.handleIncoming(list);
    void this.handleComments(comments);
    return { ok: true, received: list.length + comments.length };
  }

  /** TikTok messages (from TikTok's business messaging or a bridge): { user_id, name?, text, message_id? }. Key = Dellal verify token. */
  @Public()
  @Post('hooks/tiktok')
  async tiktokHook(@Query('key') key: string, @Body() body: any) {
    const r: any = await this.core.call('dellal.routing', await this.core.systemSession(), {});
    if (!r.verifyToken || key !== r.verifyToken) throw new core.AppError('unauthorized', 'Clé invalide');
    const text = String(body?.text ?? body?.content?.text ?? '').trim();
    const user = String(body?.user_id ?? body?.sender?.id ?? '').trim();
    if (!text || !user) throw new core.AppError('bad_request', 'user_id et text requis');
    void this.handleIncoming([{ channel: 'tiktok', externalId: user, accountId: null, name: body?.name ? String(body.name) : null, text: text.slice(0, 4000), messageId: body?.message_id ? String(body.message_id) : null, source: null }]);
    return { ok: true };
  }

  /** Stores each message, then lets Dellal answer once the customer stops typing (2 s), one answer at a time per conversation. */
  private async handleIncoming(list: any[]) {
    const log = new Logger('Dellal');
    for (const msg of list) {
      try {
        const session = await this.core.systemSession();
        const r: any = await this.core.call('dellal.receive', session, msg);
        if (!r) continue;
        latest.set(r.conversationId, r.messageId);
        setTimeout(() => {
          if (latest.get(r.conversationId) !== r.messageId) return; // a newer message will be answered instead
          const prev = running.get(r.conversationId) ?? Promise.resolve();
          const next = prev
            .then(() => this.core.call('dellal.answer', session, { id: r.conversationId }))
            .catch((e) => log.warn(`conversation ${r.conversationId}: ${e?.message ?? e}`))
            .finally(() => {
              if (running.get(r.conversationId) === next) running.delete(r.conversationId);
            });
          running.set(r.conversationId, next);
        }, 2000);
      } catch (e: any) {
        log.warn(`incoming ${msg?.channel} message refused: ${e?.message ?? e}`);
      }
    }
  }

  /** Stores each comment, then lets the CM AI agent handle it after the shop's delay (the sweep job catches missed ones). */
  private async handleComments(list: any[]) {
    const log = new Logger('CM');
    for (const c of list) {
      try {
        const session = await this.core.systemSession();
        const r: any = await this.core.call('cm.receive', session, c);
        if (!r?.enabled) continue;
        setTimeout(() => {
          cmQueue = cmQueue
            .then(() => this.core.call('cm.run', session, { id: r.commentId }))
            .catch((e) => log.warn(`comment ${r.commentId}: ${e?.message ?? e}`));
        }, Math.max(0, Number(r.delaySec) || 0) * 1000);
      } catch (e: any) {
        log.warn(`incoming ${c?.channel} comment refused: ${e?.message ?? e}`);
      }
    }
  }

  /** Called by an external scheduler (e.g. every 30 minutes) to refresh courier statuses. */
  @Public()
  @Post('hooks/cron')
  async cron(@Query('key') key: string) {
    const ck = (await core.getSetting(this.core.db, 'cron')).key;
    if (!ck || key !== ck) throw new core.AppError('unauthorized', 'Clé cron invalide');
    const session = await this.core.systemSession();
    void this.core.call('cm.sweep', session, {}).catch(() => null); // comments the CM AI agent has not answered yet (in the background)
    return this.core.call('delivery.sync', session, {}).catch((e) => ({ ok: false, message: e.message }));
  }
}

@Module({
  imports: [JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { expiresIn: config.jwtExpires } })],
  controllers: [ApiController],
  providers: [AuthGuard, { provide: APP_FILTER, useClass: ErrorFilter }],
})
export class ApiModule {}
