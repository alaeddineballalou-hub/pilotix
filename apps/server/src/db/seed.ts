import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { config } from '../config';

/** Creates the first admin account (and a few sample products when the catalog is empty). */
async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@pilotix.dz').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  if (password.length < 10) {
    throw new Error('Set SEED_ADMIN_PASSWORD (at least 10 characters) to create the first admin.');
  }
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  const hash = await bcrypt.hash(password, 12);
  await client.query(
    `INSERT INTO users (name, email, password_hash, roles, language)
     VALUES ('Administrateur', $1, $2, '{admin}', 'fr')
     ON CONFLICT (email) DO NOTHING`,
    [email, hash],
  );
  const { rows } = await client.query('SELECT count(*)::int AS n FROM products');
  if (rows[0].n === 0) {
    await client.query(
      `INSERT INTO products (name, sku, price, cost, variants, stock) VALUES
       ('Produit exemple A', 'PX-001', 3500, 1800, '{S,M,L}', 50),
       ('Produit exemple B', 'PX-002', 2200, 900, '{}', 120)`,
    );
  }
  await client.end();
  console.log(`Admin ready: ${email}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
