import { Body, Controller, Get, Module, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ORDER_STATUSES } from '@pilotix/shared';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth';
import { ZodPipe } from '../common/zod';
import { OrdersService } from './orders.service';

const status = z.enum(ORDER_STATUSES);
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item));

const ListQuery = z.object({
  status: csv(status).optional(),
  q: z.string().max(100).optional(),
  wilaya: z.coerce.number().int().min(1).max(69).optional(),
  agentId: z.coerce.number().int().positive().optional(),
  livreurId: z.coerce.number().int().positive().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  callbackDue: z.preprocess((v) => v === 'true' || v === '1' || v === true, z.boolean()).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.enum(['created_desc', 'created_asc', 'callback_asc', 'total_desc']).default('created_desc'),
});

const Item = z.object({
  productId: z.number().int().positive(),
  variant: z.string().max(60).nullable().optional(),
  quantity: z.number().int().min(1).max(999),
  unitPrice: z.number().int().min(0).max(10_000_000).optional(),
});

const NewOrderBody = z.object({
  customerName: z.string().trim().min(2).max(120),
  phone: z.string().min(9).max(20),
  wilaya: z.number().int().min(1).max(69),
  commune: z.string().trim().max(120).default(''),
  address: z.string().trim().max(300).default(''),
  items: z.array(Item).min(1).max(50),
  deliveryFee: z.number().int().min(0).max(100_000).default(0),
  discount: z.number().int().min(0).max(10_000_000).default(0),
  note: z.string().max(1000).nullable().optional(),
});

const PatchBody = NewOrderBody.partial().extend({ version: z.number().int().min(1) });

const StatusBody = z.object({
  status,
  note: z.string().max(1000).nullable().optional(),
  callbackAt: z.string().datetime({ offset: true }).nullable().optional(),
  livreurId: z.number().int().positive().nullable().optional(),
  tracking: z.string().max(80).nullable().optional(),
  clientId: z.string().min(8).max(64).optional(),
});

const NoteBody = z.object({ note: z.string().max(1000).default(''), kind: z.enum(['call', 'note']).default('note') });

const SyncBody = z.object({
  actions: z
    .array(
      z.object({
        clientId: z.string().min(8).max(64),
        orderId: z.number().int().positive(),
        kind: z.enum(['status', 'call', 'note']),
        status: status.optional(),
        note: z.string().max(1000).optional(),
        callbackAt: z.string().datetime({ offset: true }).nullable().optional(),
        at: z.string(),
      }),
    )
    .max(200),
});

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>, @CurrentUser() u: AuthUser) {
    return this.orders.list(q, u);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) {
    return this.orders.get(id, u);
  }

  @Get(':id/events')
  events(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) {
    return this.orders.events(id, u);
  }

  @Post()
  @Roles('manager', 'confirmation', 'agent')
  create(@Body(new ZodPipe(NewOrderBody)) body: z.infer<typeof NewOrderBody>, @CurrentUser() u: AuthUser) {
    return this.orders.create(body, u);
  }

  @Patch(':id')
  @Roles('manager', 'confirmation', 'agent')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>, @CurrentUser() u: AuthUser) {
    return this.orders.update(id, body, u);
  }

  @Post(':id/status')
  setStatus(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(StatusBody)) body: z.infer<typeof StatusBody>, @CurrentUser() u: AuthUser) {
    return this.orders.setStatus(id, body, u);
  }

  @Post(':id/notes')
  addNote(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>, @CurrentUser() u: AuthUser) {
    return this.orders.addNote(id, body.note, body.kind, u);
  }

  @Post('sync')
  sync(@Body(new ZodPipe(SyncBody)) body: z.infer<typeof SyncBody>, @CurrentUser() u: AuthUser) {
    return this.orders.sync(body.actions, u);
  }
}

@Module({ controllers: [OrdersController], providers: [OrdersService] })
export class OrdersModule {}
