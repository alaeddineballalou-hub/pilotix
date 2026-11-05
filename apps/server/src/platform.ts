// The control room's API (Pilotix staff, not shop accounts):
//   POST /api/platform/auth/login → { token, staff }, or { step: 'code', ticket } (two-step login: a code by e-mail)
//   POST /api/platform/auth/code  → { token, staff, device? } (the code; « remember this device » for 30 days)
//   POST /api/platform/rpc/:name  → one control-room action (roles checked in the core)
//   GET  /api/platform/health     → the server: database and stores' sizes, last backups, disk space
// Pilotix never opens a store: there is no « open as » and no password of a store here. E-mails that carry a link
// (invitations) are sent by the server; their link never comes back to the control room.
import { Body, CanActivate, Controller, ExecutionContext, Get, Injectable, Logger, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as core from '@pilotix/core';
import type { OwnerMail, StaffSession } from '@pilotix/core';
import { readdir, stat, statfs } from 'node:fs/promises';
import { z } from 'zod';
import { config } from './config';
import { CoreService } from './core.service';
import { dismissDoctor, serverDoctor } from './doctor';
import { saveTurnstileConfig, syncTurnstile, turnstileStatus } from './turnstile';
import { robotGate } from './robot';
import { offsiteStatus, saveOffsite, sendOffsite, testOffsite } from './offsite';
import { otpStatus, saveOtp, testOtp } from './otp';
import { checkLogin, clearLogin, failedLogin } from './limits';
import { couriers, runCheck, runCheckAll, testable, watchNow, watchRunning } from './courierWatch';
import { mailConfigured, sendMail } from './mail';
import { ownerMail, ReceiptData, receiptMail, staffCodeMail } from './mails';
import { PUBLIC, Public } from './public';

/** Staff tokens are signed with their own key: a shop token is never a staff token, nor the reverse. */
const staffSecret = () => `${config.jwtSecret}:platform`;
const STARTED = new Date().toISOString();

interface StaffClaims {
  st: number;
  tv: number;
  typ: 'staff';
}

@Injectable()
export class PlatformGuard implements CanActivate {
  private cache = new Map<number, { at: number; tv: number; staff: StaffSession }>();
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
    let c: StaffClaims;
    try {
      c = await this.jwt.verifyAsync<StaffClaims>(token, { secret: staffSecret() });
    } catch {
      throw new UnauthorizedException('Session expirée, reconnectez-vous');
    }
    if (c.typ !== 'staff' || !c.st) throw new UnauthorizedException('Session expirée, reconnectez-vous');
    const hit = this.cache.get(c.st);
    if (hit && Date.now() - hit.at < 30_000 && hit.tv === c.tv) {
      req.staff = hit.staff;
      return true;
    }
    const staff = await core.staffById(this.core.t, Number(c.st), Number(c.tv));
    if (!staff) throw new UnauthorizedException('Compte désactivé ou mot de passe changé : reconnectez-vous');
    this.cache.set(c.st, { at: Date.now(), tv: Number(c.tv), staff });
    req.staff = staff;
    return true;
  }
}

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), device: z.string().max(4000).optional(), turnstile: z.string().max(4000).optional() });
const CodeBody = z.object({ ticket: z.string().max(4000), code: z.string().trim().regex(/^\d{6}$/, 'Code à 6 chiffres'), remember: z.boolean().default(false) });
/**
 * Actions that only read (or only touch what no shop's request keeps: Pilot AI's test chat, lessons chat, Darija lessons): everything
 * else changes shops, so what the shops' requests keep is forgotten at once.
 */
const READS = /^p\.(me|couriers|couriers\.(tests|state|usage)|dashboard|shops\.(list|get)|payments\.(list|receipt)|plans\.list|staff\.list|settings\.get|audit\.list|demo\.get|signups\.list|support\.(list|get)|health\.db|pilot\.(state|case|bookText|try|teach|voice|voiceSave)|lahja\.(state|decide|decideMany|add)|darija\.(book|save|restore|file)|dellal\.(board|more|books)|(cm|spy)\.board|ai\.costs)$/;
/** These need e-mails: the owner gets a link (or a receipt) only by e-mail. */
const NEEDS_MAIL = new Set(['p.shops.create', 'p.shops.resendInvite', 'p.payments.mailReceipt']);

const mask = (email: string) => email.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => `${a}${'•'.repeat(Math.min(6, b.length))}${c}`);

@Controller('platform')
@UseGuards(PlatformGuard)
export class PlatformController {
  private readonly log = new Logger('Platform');
  constructor(
    private readonly core: CoreService,
    private readonly jwt: JwtService,
  ) {}

  private sign(staff: StaffSession, tv: number) {
    return this.jwt.signAsync({ st: staff.id, tv, typ: 'staff' }, { secret: staffSecret(), expiresIn: '12h' });
  }

  /** « Remember this device »: 30 days without the code on this browser (ends when the password changes). */
  private async deviceOk(device: string | undefined, staffId: number, tv: number): Promise<boolean> {
    if (!device) return false;
    try {
      const c = await this.jwt.verifyAsync<{ st: number; tv: number; typ: string }>(device, { secret: staffSecret() });
      return c.typ === 'device' && Number(c.st) === staffId && Number(c.tv) === tv;
    } catch {
      return false;
    }
  }

  @Public()
  @Post('auth/login')
  async login(@Body() body: unknown, @Req() req: { ip?: string; headers?: Record<string, unknown> }) {
    const ipKey = `p-ip:${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(ipKey, 10);
    const b = LoginBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Email ou mot de passe manquant');
    const mailKey = `p-email:${b.data.email.trim().toLowerCase()}|${core.ipNet(req.ip || '') || 'unknown'}`;
    // after 3 failures: Cloudflare's robot check too (robot.ts)
    await robotGate(this.core, req, [ipKey, mailKey], b.data.turnstile);
    checkLogin(mailKey, 5, true);
    let r: Awaited<ReturnType<typeof core.staffLogin>>;
    try {
      r = await core.staffLogin(this.core.t, b.data.email, b.data.password);
    } catch (e) {
      failedLogin(ipKey);
      failedLogin(mailKey);
      throw e;
    }
    clearLogin(mailKey);
    // the authenticator app (when this person turned it on): its code instead of the e-mailed one (a device remembered
    // 30 days is let in, as with the e-mailed code)
    if ((await core.staffTotpOn(this.core.t, r.staff.id)) && !(await this.deviceOk(b.data.device, r.staff.id, r.tv))) {
      const ticket = await this.jwt.signAsync({ st: r.staff.id, tv: r.tv, typ: 'staff-totp' }, { secret: staffSecret(), expiresIn: '10m' });
      return { step: 'totp' as const, ticket };
    }
    const set = await this.core.settings();
    // two-step login: a code by e-mail (not on a device remembered for 30 days). Never off by itself: with no e-mail
    // the control room stays closed (only PLATFORM_TWO_STEP=off in deploy/.env lets the password alone in)
    if (set.security.twoStep && !config.twoStepOff && !(await this.deviceOk(b.data.device, r.staff.id, r.tv))) {
      if (!mailConfigured()) {
        this.log.error('Two-step login: e-mails are not configured on the server (deploy/.env); PLATFORM_TWO_STEP=off is the emergency switch');
        throw new core.AppError('bad_request', 'Connexion en deux étapes : l’envoi d’e-mails n’est pas configuré sur le serveur. Configurez-le (deploy/.env) ; en urgence seulement : PLATFORM_TWO_STEP=off.');
      }
      const code = await core.makeStaffCode(this.core.t, r.staff.id);
      // waited for: when the e-mail cannot leave, the person is told now (not left waiting for a code)
      try {
        await sendMail(staffCodeMail({ to: r.staff.email, name: r.staff.name, code }));
      } catch (e: any) {
        this.log.error(`Code e-mail failed: ${e?.message || e}`);
        throw new core.AppError('bad_request', 'Le code n’a pas pu être envoyé par e-mail. Réessayez dans une minute.');
      }
      const ticket = await this.jwt.signAsync({ st: r.staff.id, tv: r.tv, typ: 'staff-code' }, { secret: staffSecret(), expiresIn: '10m' });
      return { step: 'code' as const, ticket, email: mask(r.staff.email) };
    }
    return { token: await this.sign(r.staff, r.tv), staff: r.staff };
  }

  /** The authenticator app's code (after the password): 10 wrong codes per 15 minutes per address, 5 per account. */
  @Public()
  @Post('auth/totp')
  async totp(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `p-totp:${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(ipKey, 10);
    const b = CodeBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Code à 6 chiffres');
    let c: { st: number; tv: number; typ: string };
    try {
      c = await this.jwt.verifyAsync(b.data.ticket, { secret: staffSecret() });
    } catch {
      throw new core.AppError('unauthorized', 'Code expiré : reconnectez-vous');
    }
    if (c.typ !== 'staff-totp') throw new core.AppError('unauthorized', 'Code expiré : reconnectez-vous');
    const accKey = `p-totp-st:${Number(c.st)}`;
    checkLogin(accKey, 5);
    if (!(await core.totpCheck(this.core.t, Number(c.st), b.data.code))) {
      failedLogin(ipKey);
      failedLogin(accKey);
      throw new core.AppError('unauthorized', 'Code incorrect : tapez le code que montre l’application maintenant');
    }
    clearLogin(accKey);
    const staff = await core.staffById(this.core.t, Number(c.st), Number(c.tv));
    if (!staff) throw new core.AppError('unauthorized', 'Compte désactivé ou mot de passe changé');
    const device = b.data.remember ? await this.jwt.signAsync({ st: staff.id, tv: Number(c.tv), typ: 'device' }, { secret: staffSecret(), expiresIn: '30d' }) : undefined;
    return { token: await this.sign(staff, Number(c.tv)), staff, ...(device ? { device } : {}) };
  }

  /** The code of the two-step login. */
  @Public()
  @Post('auth/code')
  async code(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `p-code:${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(ipKey, 10);
    const b = CodeBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Code à 6 chiffres');
    let c: { st: number; tv: number; typ: string };
    try {
      c = await this.jwt.verifyAsync(b.data.ticket, { secret: staffSecret() });
    } catch {
      throw new core.AppError('unauthorized', 'Code expiré : reconnectez-vous');
    }
    if (c.typ !== 'staff-code') throw new core.AppError('unauthorized', 'Code expiré : reconnectez-vous');
    if (!(await core.checkStaffCode(this.core.t, Number(c.st), b.data.code))) {
      failedLogin(ipKey);
      throw new core.AppError('unauthorized', 'Code incorrect ou expiré');
    }
    const staff = await core.staffById(this.core.t, Number(c.st), Number(c.tv));
    if (!staff) throw new core.AppError('unauthorized', 'Compte désactivé ou mot de passe changé');
    const device = b.data.remember ? await this.jwt.signAsync({ st: staff.id, tv: Number(c.tv), typ: 'device' }, { secret: staffSecret(), expiresIn: '30d' }) : undefined;
    return { token: await this.sign(staff, Number(c.tv)), staff, ...(device ? { device } : {}) };
  }

  @Post('rpc/:name')
  async rpc(@Param('name') name: string, @Body() body: unknown, @Req() req: { staff: StaffSession }) {
    if (!/^p(\.[a-zA-Z0-9]+){1,3}$/.test(name)) throw new core.AppError('not_found', 'Action inconnue');
    if (NEEDS_MAIL.has(name) && !mailConfigured()) throw new core.AppError('bad_request', 'L’envoi d’e-mails n’est pas configuré sur le serveur : le propriétaire ne recevrait pas son lien.');
    const ctx = this.core.platformCtx(req.staff);
    const out: any = await core.platformCall(name, ctx, body ?? {});
    if (!READS.test(name)) this.core.invalidate();
    // e-mails of the action: sent by the server, never returned (an invitation's link is the owner's only)
    if (out && typeof out === 'object') {
      const mails: OwnerMail[] = [...(out.mail ? [out.mail] : []), ...(Array.isArray(out.mails) ? out.mails : [])];
      delete out.mail;
      delete out.mails;
      for (const m of mails) void this.send(m, ctx);
    }
    // a new password logs out the other sessions: this one gets a fresh token
    if (name === 'p.me.password') {
      const r = (await this.core.t.platform.query('SELECT token_version FROM platform.staff WHERE id = $1', [req.staff.id]))[0];
      return { ...out, token: await this.sign(req.staff, Number(r?.token_version ?? 0)) };
    }
    return out;
  }

  private async send(m: OwnerMail, ctx: core.PCtx) {
    if (!mailConfigured()) return;
    try {
      const mail = m.kind === 'receipt' ? receiptMail((await core.platformCall('p.payments.receipt', ctx, { id: m.paymentId })) as ReceiptData, m.to) : ownerMail(m);
      if (mail) await sendMail(mail);
    } catch (e: any) {
      this.log.error(`${m.kind} e-mail to ${m.to} failed: ${e?.message || e}`);
    }
  }

  /** Doctor: the server's health (machine, database, jobs, errors in the code, silent shops). Owner and managers. */
  @Post('doctor')
  async doctor(@Req() req: { staff: StaffSession }) {
    if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé au propriétaire et aux managers');
    return serverDoctor(this.core);
  }

  /** Doctor: « Résolu » / « Ignorer » / « Ré-afficher » an alert no page can fix (owner and managers). */
  @Post('doctor/dismiss')
  async doctorDismiss(@Body() body: unknown, @Req() req: { staff: StaffSession }) {
    if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé au propriétaire et aux managers');
    const b = z.object({ id: z.string().regex(/^[a-zA-Z]{2,40}$/), kind: z.enum(['solve', 'ignore', 'restore']) }).safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Alerte ou action inconnue');
    try {
      await dismissDoctor(this.core, b.data.id, b.data.kind, req.staff.name);
    } catch (e) {
      throw new core.AppError('bad_request', (e as Error).message);
    }
    return serverDoctor(this.core);
  }

  /**
   * Cloudflare Turnstile for every shop: « save » the account id and API token (the owner only, Réglages; locked: it is
   * never removed, only replaced by a new one that Cloudflare accepted), « status », « sync » now. The token never comes back.
   */
  @Post('turnstile/:action')
  async turnstile(@Param('action') action: string, @Body() body: any, @Req() req: { staff: StaffSession }) {
    // every staff member sees whether it is connected (Réglages); syncing is for the owner and managers
    if (action === 'status') return turnstileStatus(this.core);
    if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé au propriétaire et aux managers');
    if (action === 'sync') return syncTurnstile(this.core);
    if (action === 'save') {
      if (req.staff.role !== 'owner') throw new core.AppError('forbidden', 'Réservé au propriétaire');
      try {
        // locked: no « remove »; a new Account ID and a new token replace the old ones (checked with Cloudflare first)
        return await saveTurnstileConfig(this.core, { accountId: String(body?.accountId ?? '').slice(0, 64), token: String(body?.token ?? '').slice(0, 400) });
      } catch (e) {
        throw new core.AppError('bad_request', (e as Error).message);
      }
    }
    throw new core.AppError('not_found', 'Action inconnue');
  }

  /**
   * The WhatsApp code that proves every account's phone: « status » (every staff member), « save » (the owner: the
   * number's ID, the token — never shown again —, the template, on/off), « test » (owner and managers: a code to a
   * number).
   */
  @Post('otp/:action')
  async otp(@Param('action') action: string, @Body() body: any, @Req() req: { staff: StaffSession }) {
    if (action === 'status') return otpStatus(this.core);
    try {
      if (action === 'save') {
        if (req.staff.role !== 'owner') throw new core.AppError('forbidden', 'Réservé au propriétaire');
        return await saveOtp(this.core, body ?? {});
      }
      if (action === 'test') {
        if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé au propriétaire et aux managers');
        const phone = core.accountPhoneOrBad(body?.phone);
        return await testOtp(this.core, phone);
      }
    } catch (e) {
      if (e instanceof core.AppError) throw e;
      throw new core.AppError('bad_request', (e as Error).message);
    }
    throw new core.AppError('not_found', 'Action inconnue');
  }

  /**
   * Sauvegardes › Copie hors du serveur (offsite.ts): status (owner and managers), save (owner), test and send now
   * (owner and managers).
   */
  @Post('backup/:action')
  async backupOffsite(@Param('action') action: string, @Body() body: any, @Req() req: { staff: StaffSession }) {
    if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé au propriétaire et aux managers');
    try {
      if (action === 'status') return await offsiteStatus(this.core);
      if (action === 'save') {
        if (req.staff.role !== 'owner') throw new core.AppError('forbidden', 'Réservé au propriétaire');
        const r = await saveOffsite(this.core, body ?? {});
        await core.recordAudit(this.core.t, req.staff, 'backup.offsite', null, { bucket: r.bucket, on: r.configured }).catch(() => null);
        return r;
      }
      if (action === 'test') return await testOffsite(this.core);
      if (action === 'send') return await sendOffsite(this.core, true);
    } catch (e) {
      if (e instanceof core.AppError) throw e;
      throw new core.AppError('bad_request', (e as Error).message);
    }
    throw new core.AppError('not_found', 'Action inconnue');
  }

  /** Delivery companies: calls each one's API from this server with made-up keys (alive? reached?). Nothing is created. */
  @Post('couriers/test')
  async couriersTest(@Req() req: { staff: StaffSession }) {
    if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé aux responsables');
    return { at: new Date().toISOString(), results: await couriers().probeCouriers() };
  }

  /** One company's API with the team's real test keys: connection, prices, offices, tracking (full: a real test parcel
   *  created as a draft, its label and status, then cancelled). */
  @Post('couriers/check')
  async courierCheck(@Body() body: unknown, @Req() req: { staff: StaffSession }) {
    if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé aux responsables');
    const b = z.object({ company: z.string().max(40), deep: z.boolean().default(false) }).safeParse(body ?? {});
    if (!b.success) throw new core.AppError('bad_request', 'Société manquante');
    return runCheck(this.core, b.data.company, b.data.deep);
  }

  /** Every company with saved test keys (not removed), checked in the background (the page reads the results as they come). */
  @Post('couriers/checkAll')
  async courierCheckAll(@Req() req: { staff: StaffSession }) {
    if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé aux responsables');
    couriers();
    const list = await testable(this.core);
    const startedAt = new Date().toISOString();
    void runCheckAll(this.core, list).catch((e) => this.log.warn(`Courier checks: ${(e as Error).message}`));
    return { startedAt, companies: list };
  }

  /** « Changements API » › « Vérifier maintenant »: the whole look, in the background (the page reads the list again). */
  @Post('couriers/watch')
  async courierWatch(@Req() req: { staff: StaffSession }) {
    if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé aux responsables');
    couriers();
    if (watchRunning()) return { running: true, startedAt: null };
    const startedAt = new Date().toISOString();
    void watchNow(this.core, req.staff.name || req.staff.email).catch((e) => this.log.warn(`Courier watch: ${(e as Error).message}`));
    return { running: false, startedAt };
  }

  /** The server: database and stores' sizes (numbers only), the last backups, the disk space, the e-mails. */
  @Get('health')
  async health(@Req() req: { staff: StaffSession }) {
    if (req.staff.role === 'support') throw new core.AppError('forbidden', 'Réservé aux responsables');
    const db = await core.platformCall('p.health.db', this.core.platformCtx(req.staff), {});
    const backups: { name: string; bytes: number; at: string }[] = [];
    let disk: { total: number; free: number } | null = null;
    try {
      for (const f of await readdir(config.backupsDir)) {
        if (!/\.sql\.gz$/.test(f)) continue;
        const st = await stat(`${config.backupsDir}/${f}`);
        backups.push({ name: f, bytes: st.size, at: st.mtime.toISOString() });
      }
      const fs = await statfs(config.backupsDir);
      disk = { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize };
    } catch {
      /* no backups folder on this server */
    }
    if (!disk) {
      try {
        const fs = await statfs('/');
        disk = { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize };
      } catch {
        /* unknown */
      }
    }
    backups.sort((a, b) => b.at.localeCompare(a.at));
    return {
      db,
      backups: { count: backups.length, last: backups[0] ?? null, bytes: backups.reduce((a, b) => a + b.bytes, 0), recent: backups.slice(0, 7) },
      disk,
      server: { startedAt: STARTED, node: process.version, memory: process.memoryUsage().rss, mail: mailConfigured(), jobs: !!config.redisUrl },
    };
  }

  /** (removed) Pilotix does not open stores any more: the owner decides who works in their store. */
  @Post('open/:id')
  open(@Param('id') _id: string) {
    throw new core.AppError('not_found', 'Pilotix n’ouvre plus les boutiques : le propriétaire peut ajouter votre e-mail à son équipe s’il veut de l’aide');
  }
}
