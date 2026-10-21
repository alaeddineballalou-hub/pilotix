import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { LANGUAGES, ROLES, User } from '@pilotix/shared';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth';
import { ZodPipe } from '../common/zod';
import { DbService } from '../db/db.service';

const toUser = (r: any): User & { lastSeenAt: string | null } => ({
  id: Number(r.id),
  name: r.name,
  email: r.email,
  roles: r.roles,
  language: r.language,
  active: r.active,
  lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
});

const NewUser = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(10).max(200),
  roles: z.array(z.enum(ROLES)).min(1),
  language: z.enum(LANGUAGES).default('fr'),
});
const PatchUser = NewUser.partial().extend({ active: z.boolean().optional() });
const MyPrefs = z.object({ language: z.enum(LANGUAGES) });

@Controller('users')
export class UsersController {
  constructor(private readonly db: DbService) {}

  /** Staff list (names and roles) — every logged-in user can see who is who. */
  @Get()
  async list() {
    return (await this.db.query('SELECT id, name, email, roles, language, active, last_seen_at FROM users ORDER BY name')).map(toUser);
  }

  @Post()
  @Roles('admin')
  async create(@Body(new ZodPipe(NewUser)) b: z.infer<typeof NewUser>) {
    try {
      const r = await this.db.one(
        'INSERT INTO users (name, email, password_hash, roles, language) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [b.name, b.email.toLowerCase(), await bcrypt.hash(b.password, 12), b.roles, b.language],
      );
      return toUser(r);
    } catch (e: any) {
      if (e?.code === '23505') throw new BadRequestException('This email is already used');
      throw e;
    }
  }

  @Patch('me')
  async updateMe(@Body(new ZodPipe(MyPrefs)) b: z.infer<typeof MyPrefs>, @CurrentUser() u: AuthUser) {
    return toUser(await this.db.one('UPDATE users SET language=$2 WHERE id=$1 RETURNING *', [u.id, b.language]));
  }

  @Patch(':id')
  @Roles('admin')
  async update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(PatchUser)) b: z.infer<typeof PatchUser>, @CurrentUser() me: AuthUser) {
    if (id === me.id && (b.active === false || (b.roles && !b.roles.includes('admin')))) {
      throw new BadRequestException('You cannot remove your own admin access');
    }
    const hash = b.password ? await bcrypt.hash(b.password, 12) : null;
    const r = await this.db.one(
      `UPDATE users SET name=COALESCE($2,name), email=COALESCE($3,email), password_hash=COALESCE($4,password_hash),
         roles=COALESCE($5,roles), language=COALESCE($6,language), active=COALESCE($7,active) WHERE id=$1 RETURNING *`,
      [id, b.name ?? null, b.email?.toLowerCase() ?? null, hash, b.roles ?? null, b.language ?? null, b.active ?? null],
    );
    if (!r) throw new NotFoundException();
    return toUser(r);
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
