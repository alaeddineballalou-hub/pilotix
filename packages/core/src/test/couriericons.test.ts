// A delivery company's small badge shows its own icon (delivery.icons → apps/web/public/couriers/icon/<logo>.webp): the
// logo of the card it was made from, for every role; and every icon file belongs to a card (scripts/courier-logos-icon.py).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { CARDS } from '../couriers/kinds';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(60));
});

const icons = async (email: string) => (await call('delivery.icons', await as(email), {})) as { companies: { id: number; logo: string | null }[]; kinds: Record<string, string> };

test('delivery.icons: each company its card’s logo, the shop’s own livreurs none, for every role', async () => {
  const admin = await as(EMAILS.admin);
  const dhd: any = await call('delivery.saveCompany', admin, { name: 'DHD', kind: 'ecotrack', settings: { base_url: 'https://platform.dhd-dz.com' }, secret: {} });
  const rows = await db.query('SELECT id, kind FROM delivery_companies');
  for (const email of [EMAILS.admin, EMAILS.suivi, EMAILS.depot, EMAILS.conf, EMAILS.livreur]) {
    const r = await icons(email);
    const of = (id: unknown) => r.companies.find((c) => c.id === Number(id))?.logo;
    assert.equal(r.companies.length, rows.length, email);
    for (const c of rows.filter((x: any) => x.kind === 'zr')) assert.equal(of(c.id), 'zr', email);
    for (const c of rows.filter((x: any) => x.kind === 'own')) assert.equal(of(c.id), null, email);
    assert.equal(of(dhd.id), 'dhd', email);
    // a kind that is one company only: its logo (an order of another shop's company)
    assert.equal(r.kinds.zr, 'zr');
    assert.equal(r.kinds.ecotrack, undefined);
  }
});

test('every icon file is the own icon of a company card, and the app knows each one', () => {
  const root = join(__dirname, '..', '..', '..', '..');
  const dir = join(root, 'apps/web/public/couriers/icon');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.webp')).map((f) => f.slice(0, -5)).sort() : [];
  const logos = new Set(CARDS.map((c) => c.logo).filter(Boolean));
  assert.deepEqual(files.filter((f) => !logos.has(f)), [], 'an icon whose name is no card’s logo');
  // the app's list (written by the script with the files): run python3 scripts/courier-logos-icon.py after adding one
  const list = readFileSync(join(root, 'apps/web/src/ui/courierIcons.ts'), 'utf-8');
  const listed = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, files, 'apps/web/src/ui/courierIcons.ts is not the list of icon files');
  // where each one comes from is written down
  const sources = readFileSync(join(root, 'scripts/courier-icons/SOURCES.md'), 'utf-8');
  assert.deepEqual(files.filter((f) => !sources.includes(`| ${f} |`)), [], 'an icon missing from scripts/courier-icons/SOURCES.md');
});
