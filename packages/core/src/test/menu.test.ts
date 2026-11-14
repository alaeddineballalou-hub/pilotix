// The store's menu list (packages/shared/src/menu.ts) is the one place a page, a tab or a team screen is written: the
// app's menu and its screens dropdown, the pages' tab bars, Utilisateurs › Rôles and the server's rights all read it.
// These tests keep the pieces in step: the screens name real lines, every page is on a screen, every right and screen
// has its name in French, English and Arabic, and a new server action says which right it needs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MENU_PAGES, MENU_TABS, RIGHTS, rightDef, SPACES, STORE_MENU, TAB_LINES } from '@pilotix/shared';
import { REGISTRY } from '../index';
import { PROC_RIGHTS, rightsNeeded } from '../modules/rights';
import { FREE_ACTIONS } from './rights-free';

const LOCALES = join(__dirname, '../../../../apps/web/src/locales');
const LANGS = ['fr', 'en', 'ar'] as const;

/** The app's texts of one language, as i18n reads them (the file's name, then the keys: 'nav.sub.suivi'). */
function texts(lang: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of readdirSync(join(LOCALES, lang))) if (f.endsWith('.json')) out[f.slice(0, -5)] = JSON.parse(readFileSync(join(LOCALES, lang, f), 'utf8'));
  return out;
}
const T = Object.fromEntries(LANGS.map((l) => [l, texts(l)]));
const named = (lang: string, key: string) => {
  let cur: unknown = T[lang];
  for (const k of key.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
  return typeof cur === 'string' && cur.trim() !== '';
};

test('the menu list: the screens name real lines, every page is on a screen, the tabs agree', () => {
  const items = new Set(STORE_MENU.map((n) => n.id));
  const lines = new Set(STORE_MENU.flatMap((n) => (n.children ?? []).map((c) => c.id)));
  for (const s of SPACES) for (const id of s.items) assert.ok(items.has(id) || lines.has(id), `screen ${s.id}: « ${id} » is not a line of the menu (a typo hides it from the screen)`);
  assert.equal(new Set(SPACES.map((s) => s.id)).size, SPACES.length, 'no screen twice');

  // a page of the menu reached on no team screen would only be in « Ancien menu »
  for (const p of MENU_PAGES) if (!p.always) assert.ok(p.screens.length > 0, `page ${p.id}: put it on a team screen (SPACES in packages/shared/src/menu.ts)`);

  // each page's tabs are its MENU_TABS list (the pages' tab bars read that list)
  for (const n of STORE_MENU) {
    const listed = (MENU_TABS as Record<string, readonly string[]>)[n.id];
    if (n.subs && listed) assert.equal(n.subs, listed, `${n.id}: its tabs are MENU_TABS.${n.id}`);
    for (const k of [...Object.keys(n.tabRoles ?? {}), ...Object.keys(n.tabNames?.each ?? {}), ...Object.values(n.tabAlias ?? {})]) assert.ok(n.subs?.includes(k), `${n.id}: « ${k} » is not one of its tabs`);
  }
  for (const id of Object.keys(MENU_TABS)) assert.ok(STORE_MENU.some((n) => n.id === id && n.subs === (MENU_TABS as Record<string, unknown>)[id]), `MENU_TABS.${id}: no page of the menu uses it`);
  // a line that opens a tab (Commandes › Livré) is that tab's right
  for (const [line, page] of TAB_LINES) assert.ok(rightDef(`tab:${page}/${line}`), `line ${line}: ${page} has no tab « ${line} »`);

  // Utilisateurs › Rôles lists exactly the menu's pages and their tabs, in its order
  const pages = RIGHTS.filter((d) => d.kind === 'page').map((d) => d.id.slice(5));
  assert.deepEqual(pages, MENU_PAGES.map((p) => p.id));
  for (const p of MENU_PAGES) assert.deepEqual(RIGHTS.filter((d) => d.kind === 'tab' && d.in === p.id).map((d) => d.id.split('/')[1]), p.tabs.map((t) => t.id), `${p.id}: its tabs`);
  // and its buttons sit on a page of the list (or the orders' and « everywhere » lines)
  for (const d of RIGHTS) if (d.kind === 'act') assert.ok(d.in === 'orders' || d.in === 'general' || rightDef(`page:${d.in}`), `${d.id}: « ${d.in} » is not a page of the menu`);
});

test('every page, tab, button, screen and group has its name in French, English and Arabic', () => {
  const keys = new Set<string>();
  for (const d of RIGHTS) {
    keys.add(d.label);
    if (d.kind === 'x') keys.add(`rights.xHelp.${d.id.slice(2)}`);
  }
  // the screens dropdown and the menu's groups (the editor's captions); the tabs' names are the tab bars' (menuTabName)
  for (const s of SPACES) keys.add(`nav.screens.${s.id}`);
  keys.add('nav.screens.title').add('nav.screens.all');
  for (const n of STORE_MENU) if (n.children) keys.add(`nav.${n.id}`);
  const missing = LANGS.flatMap((l) => [...keys].filter((k) => !named(l, k)).map((k) => `${l}: ${k}`));
  assert.deepEqual(missing, [], 'names to add in apps/web/src/locales');
});

test('a new server action says which right it needs (or that its roles are enough)', () => {
  const reg = REGISTRY as unknown as Record<string, { roles: unknown[] | null }>;
  const ctx = { session: { profile: { id: 1 }, isAdmin: false, roles: ['confirmation'] } } as any;
  const declared = (name: string) => name in PROC_RIGHTS || rightsNeeded(name, {}, ctx).length > 0;
  const free = new Set(FREE_ACTIONS);
  const open = Object.keys(reg).filter((n) => !(Array.isArray(reg[n].roles) && reg[n].roles!.length === 0));
  const unsaid = open.filter((n) => !declared(n) && !free.has(n));
  assert.deepEqual(unsaid, [], 'add each to PROC_RIGHTS or PAGE_PROCS (packages/core/src/modules/rights.ts), or to FREE_ACTIONS (test/rights-free.ts) if its roles are enough');
  // the list stays true: no action twice, none gone, none that has a right now
  assert.equal(free.size, FREE_ACTIONS.length, 'FREE_ACTIONS: no action twice');
  const stale = FREE_ACTIONS.filter((n) => !open.includes(n) || declared(n));
  assert.deepEqual(stale, [], 'take these out of FREE_ACTIONS (gone, administrators only, or with a right now)');
});
