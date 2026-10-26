// The control room's API (Pilotix staff, not shop accounts):
//   POST /api/platform/auth/login → { token, staff }
//   POST /api/platform/rpc/:name  → one control-room action (roles checked in the core)
//   POST /api/platform/open/:id   → a 2-hour support token for a shop (opens it as its first administrator)
import { Body, CanActivate, Controller, ExecutionContext, Injectable, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as core from '@pilotix/core';
import type { StaffSession } from '@pilotix/core';
import { z } from 'zod';
import { config } from './config';
import { CoreService } from './core.service';
import { checkLogin, clearLogin, failedLogin } from './limits';
import { PUBLIC, Public } from './public';

/** Staff tokens are signed with their own key: a shop token is never a staff token, nor the reverse. */
const staffSecret = () => `${config.jwtSecret}:platform`;

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

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
/** Actions that only read: everything else changes shops, so what the shops' requests keep is forgotten at once. */
const READS = /^p\.(me|dashboard|shops\.(list|get)|payments\.list|plans\.list|staff\.list|settings\.get|audit\.list|demo\.get)$/;

@Controller('platform')
@UseGuards(PlatformGuard)
export class PlatformController {
  constructor(
    private readonly core: CoreService,
    private readonly jwt: JwtService,
  ) {}

  private sign(staff: StaffSession, tv: number) {
    return this.jwt.signAsync({ st: staff.id, tv, typ: 'staff' }, { secret: staffSecret(), expiresIn: '12h' });
  }

  @Public()
  @Post('auth/login')
  async login(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `p-ip:${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(ipKey, 10);
    const b = LoginBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Email ou mot de passe manquant');
    const mailKey = `p-email:${b.data.email.trim().toLowerCase()}|${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(mailKey, 5);
    let r: Awaited<ReturnType<typeof core.staffLogin>>;
    try {
      r = await core.staffLogin(this.core.t, b.data.email, b.data.password);
    } catch (e) {
      failedLogin(ipKey);
      failedLogin(mailKey);
      throw e;
    }
    clearLogin(mailKey);
    return { token: await this.sign(r.staff, r.tv), staff: r.staff };
  }

  @Post('rpc/:name')
  async rpc(@Param('name') name: string, @Body() body: unknown, @Req() req: { staff: StaffSession }) {
    if (!/^p(\.[a-zA-Z]+){1,3}$/.test(name)) throw new core.AppError('not_found', 'Action inconnue');
    const out: any = await core.platformCall(name, this.core.platformCtx(req.staff), body ?? {});
    if (!READS.test(name)) this.core.invalidate();
    // a new password logs out the other sessions: this one gets a fresh token
    if (name === 'p.me.password') {
      const r = (await this.core.t.platform.query('SELECT token_version FROM platform.staff WHERE id = $1', [req.staff.id]))[0];
      return { ...out, token: await this.sign(req.staff, Number(r?.token_version ?? 0)) };
    }
    return out;
  }

  /** Support: opens a shop as its first administrator for 2 hours (written in the journal). */
  @Post('open/:id')
  async open(@Param('id') idp: string, @Req() req: { staff: StaffSession }) {
    if (!/^\d+$/.test(idp)) throw new core.AppError('not_found', 'Boutique introuvable');
    const ref = await this.core.shop({ id: Number(idp) });
    if (!ref) throw new core.AppError('not_found', 'Boutique introuvable');
    if (ref.shop.status === 'archived') throw new core.AppError('bad_request', 'Boutique archivée');
    const p = await core.supportProfile(this.core.t, ref.shop);
    if (!p) throw new core.AppError('bad_request', 'Aucun administrateur actif dans cette boutique');
    const token = await this.jwt.signAsync({ sub: p.id, tv: p.tv, shop: ref.shop.id, imp: req.staff.id }, { expiresIn: '2h' });
    await core.recordAudit(this.core.t, req.staff, 'shop.open', ref.shop.id, { as: p.name });
    return { token, shop: { id: ref.shop.id, name: ref.shop.name } };
  }
}
