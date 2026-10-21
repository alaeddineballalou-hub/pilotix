import {
  Body,
  CanActivate,
  Controller,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  HttpException,
  HttpStatus,
  Post,
  Req,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Role, User } from '@pilotix/shared';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ZodPipe } from '../common/zod';
import { config } from '../config';
import { DbService } from '../db/db.service';

export interface AuthUser {
  id: number;
  name: string;
  roles: Role[];
}

const PUBLIC = 'pilotix:public';
const ROLES = 'pilotix:roles';

/** Marks a route as open to everyone (no login). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Restricts a route to these roles. Admin always passes. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
/** Injects the logged-in user. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers?.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException();
    try {
      const p = await this.jwt.verifyAsync<{ sub: number; name: string; roles: Role[] }>(token);
      req.user = { id: Number(p.sub), name: p.name, roles: p.roles } satisfies AuthUser;
    } catch {
      throw new UnauthorizedException();
    }

    const needed = this.reflector.getAllAndOverride<Role[]>(ROLES, targets);
    if (needed?.length && !req.user.roles.includes('admin') && !needed.some((r: Role) => req.user.roles.includes(r))) {
      throw new ForbiddenException();
    }
    return true;
  }
}

/** Simple per-IP limit on login attempts: 10 per 15 minutes. */
const attempts = new Map<string, { n: number; until: number }>();
function checkRate(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.until < now) {
    attempts.set(ip, { n: 1, until: now + 15 * 60_000 });
    return;
  }
  a.n++;
  if (a.n > 10) throw new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
}

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Post('login')
  async login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>, @Req() req: { ip?: string }) {
    checkRate(req.ip || 'unknown');
    const row = await this.db.one(
      'SELECT id, name, email, password_hash, roles, language, active FROM users WHERE email = $1',
      [body.email.toLowerCase()],
    );
    // Same message and similar timing whether the email exists or not.
    const ok = row ? await bcrypt.compare(body.password, row.password_hash) : await bcrypt.compare(body.password, '$2a$12$' + 'x'.repeat(53));
    if (!row || !ok || !row.active) throw new UnauthorizedException('Wrong email or password');

    await this.db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [row.id]);
    const user: User = { id: Number(row.id), name: row.name, email: row.email, roles: row.roles, language: row.language, active: row.active };
    const token = await this.jwt.signAsync({ sub: user.id, name: user.name, roles: user.roles });
    return { token, user };
  }

  @Get('me')
  async me(@CurrentUser() u: AuthUser) {
    const row = await this.db.one('SELECT id, name, email, roles, language, active FROM users WHERE id = $1', [u.id]);
    if (!row || !row.active) throw new UnauthorizedException();
    return { ...row, id: Number(row.id) };
  }
}

@Module({
  imports: [JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { expiresIn: config.jwtExpires } })],
  controllers: [AuthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
