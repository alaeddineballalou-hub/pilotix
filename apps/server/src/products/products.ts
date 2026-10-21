import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Product } from '@pilotix/shared';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/auth';
import { ZodPipe } from '../common/zod';
import { DbService } from '../db/db.service';

const toProduct = (r: any): Product => ({
  id: Number(r.id),
  name: r.name,
  sku: r.sku,
  price: r.price,
  cost: r.cost,
  variants: r.variants,
  stock: r.stock,
  active: r.active,
});

const ProductBody = z.object({
  name: z.string().trim().min(2).max(160),
  sku: z.string().trim().min(1).max(60),
  price: z.number().int().min(0).max(10_000_000),
  cost: z.number().int().min(0).max(10_000_000).default(0),
  variants: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  active: z.boolean().default(true),
});
const StockBody = z.object({ delta: z.number().int().min(-100_000).max(100_000), reason: z.string().trim().min(2).max(200), variant: z.string().max(60).optional() });
const ListQuery = z.object({ q: z.string().max(100).optional(), all: z.preprocess((v) => v === 'true', z.boolean()).optional() });

@Controller('products')
export class ProductsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    const where: string[] = [];
    const p: unknown[] = [];
    if (!q.all) where.push('active');
    if (q.q) {
      p.push(q.q);
      where.push(`(name ILIKE '%' || $1 || '%' OR sku ILIKE $1 || '%' OR name % $1)`);
    }
    const rows = await this.db.query(`SELECT * FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name LIMIT 500`, p);
    return rows.map(toProduct);
  }

  @Post()
  @Roles('manager', 'depot')
  async create(@Body(new ZodPipe(ProductBody)) b: z.infer<typeof ProductBody>) {
    try {
      const r = await this.db.one(
        'INSERT INTO products (name, sku, price, cost, variants, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [b.name, b.sku, b.price, b.cost, b.variants, b.active],
      );
      return toProduct(r);
    } catch (e: any) {
      if (e?.code === '23505') throw new BadRequestException('This SKU already exists');
      throw e;
    }
  }

  @Patch(':id')
  @Roles('manager', 'depot')
  async update(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(ProductBody.partial())) b: Partial<z.infer<typeof ProductBody>>) {
    const r = await this.db.one(
      `UPDATE products SET name=COALESCE($2,name), sku=COALESCE($3,sku), price=COALESCE($4,price), cost=COALESCE($5,cost),
         variants=COALESCE($6,variants), active=COALESCE($7,active) WHERE id=$1 RETURNING *`,
      [id, b.name ?? null, b.sku ?? null, b.price ?? null, b.cost ?? null, b.variants ?? null, b.active ?? null],
    );
    if (!r) throw new NotFoundException();
    return toProduct(r);
  }

  @Post(':id/stock')
  @Roles('manager', 'depot')
  async adjustStock(@Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(StockBody)) b: z.infer<typeof StockBody>, @CurrentUser() u: AuthUser) {
    return this.db.tx(async (c) => {
      const r = await c.query('UPDATE products SET stock = stock + $2 WHERE id = $1 RETURNING *', [id, b.delta]);
      if (!r.rows[0]) throw new NotFoundException();
      await c.query('INSERT INTO stock_movements (product_id, variant, delta, reason, user_id) VALUES ($1,$2,$3,$4,$5)', [id, b.variant ?? null, b.delta, b.reason, u.id]);
      return toProduct(r.rows[0]);
    });
  }
}

@Module({ controllers: [ProductsController] })
export class ProductsModule {}
