// Utilisateurs › Rôles: what each role sees and does. By default nobody loses anything (every checked action is inside
// its roles' defaults), the old ticks become the first rights, the server refuses what a role was left without (a
// button, a tab, a page), gives what was given « en plus », and the app gets the person's rights with the session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  byDefault,
  cleanRoleRights,
  expandRoles,
  NO_ROLE_RIGHTS,
  personIs,
  rightDef,
  RIGHTS,
  RIGHTS_ROLES,
  type RightsRole,
  rightsFromOldTicks,
  rightsOf,
  roleSummary,
  type Role,
} from '@pilotix/shared';
import { call, num, REGISTRY } from '../index';
import { boutiqueRights, forgetRights, PROC_RIGHTS, rightsNeeded } from '../modules/rights';
import { EMAILS, setup } from './harness';

test('the list: known ids, tabs under their page, the counts of a role', () => {
  const ids = new Set(RIGHTS.map((d) => d.id));
  assert.equal(ids.size, RIGHTS.length, 'no right twice');
  for (const d of RIGHTS) {
    if (d.kind === 'tab') assert.ok(ids.has(`page:${d.in}`), `${d.id}: its page is listed`);
    if (d.extraFor) for (const r of d.extraFor) assert.ok(!byDefault(r, d), `${d.id}: « en plus » for ${r}, who has it already`);
  }
  const s = roleSummary('confirmation', NO_ROLE_RIGHTS);
  assert.deepEqual([s.pages.on, s.pages.on === s.pages.of, s.acts.on === s.acts.of], [7, true, true]);
});

test('by default nobody loses anything: every action the server checks is inside its roles’ defaults', () => {
  const reg = REGISTRY as unknown as Record<string, { roles: Role[] | null }>;
  const fakeCtx = (r: RightsRole) => ({ session: { profile: { id: 1 }, isAdmin: false, roles: [r] } }) as any;
  let checked = 0;
  for (const name of Object.keys(reg)) {
    const roles = reg[name].roles;
    if (roles !== null && roles.length === 0) continue; // administrators only
    // every role that passes the action's role check (its own roles and the roles it includes: a vendeur is an agent too)
    const callers = RIGHTS_ROLES.filter((r) => roles === null || expandRoles([r === 'agence' ? 'confirmation' : (r as Role)]).some((x) => roles.includes(x)));
    for (const r of callers) {
      // a few inputs (tabs, endings…); an agent never gives an order to someone else (orders.assignAgent refuses it)
      const inputs = [
        { agentId: 1, status: 'confirmed', tab: 'enlivraison', sub: 'nouvelles' },
        { agentId: name === 'orders.assignAgent' && !['vendeur', 'agent_manager'].includes(r) ? 1 : 2, status: 'cancelled', tab: 'swap', sub: 'livrees' },
        { agentId: 1, status: 'fake', tab: 'alertes_new', sub: 'terminees' },
      ];
      const need = inputs.flatMap((i) => rightsNeeded(name, i, fakeCtx(r)));
      for (const any of need) {
        checked++;
        assert.ok(
          any.some((id) => {
            const d = rightDef(id);
            assert.ok(d, `${name}: unknown right ${id}`);
            const page = d!.kind === 'tab' ? rightDef(`page:${d!.in}`)! : null;
            return byDefault(r, d!) && (!page || byDefault(r, page));
          }),
          `${name} (${r}) would lose ${any.join(' | ')}`,
        );
      }
    }
  }
  assert.ok(checked > 150, `checked ${checked}`);
  for (const name of Object.keys(PROC_RIGHTS)) assert.ok(reg[name], `${name}: no such action`);
});

test('the old ticks become the first rights, as Pilotix read them for each role', () => {
  assert.deepEqual(rightsFromOldTicks({ changeCompany: { confirmation: true, agency: false, depot: false, manager: true }, rulesBy: { confirmation: false, agency: false, depot: false, manager: false }, people: [] }), NO_ROLE_RIGHTS);
  const kinds = ['confirmation', 'agency', 'depot', 'manager'] as const;
  for (let mask = 0; mask < 16; mask++) {
    const cc = Object.fromEntries(kinds.map((k, i) => [k, !!(mask & (1 << i))])) as Record<(typeof kinds)[number], boolean>;
    const rb = Object.fromEntries(kinds.map((k, i) => [k, !!((15 - mask) & (1 << i))])) as Record<(typeof kinds)[number], boolean>;
    const rr = rightsFromOldTicks({ changeCompany: cc, rulesBy: rb, people: [] });
    for (const r of RIGHTS_ROLES) {
      const roles = expandRoles([r === 'agence' ? 'confirmation' : (r as Role)]);
      const s = { isAdmin: false, roles, profile: { canAssign: false, agencyId: r === 'agence' ? 3 : null } };
      const set = rightsOf({ id: 9, roles: [r === 'agence' ? 'confirmation' : (r as Role)], agencyId: r === 'agence' ? 3 : null }, rr);
      assert.equal(set.has('act:orders.company'), roles.includes('suivi') || personIs(s, cc), `company ${r} ${JSON.stringify(cc)}`);
      assert.equal(set.has('x:rules'), personIs(s, rb), `rules ${r} ${JSON.stringify(rb)}`);
    }
  }
  // the three ticks of a person; « Peut attribuer » also made him a manager in Préférences
  const rr = rightsFromOldTicks({
    changeCompany: { confirmation: false, agency: false, depot: false, manager: true },
    rulesBy: { confirmation: false, agency: false, depot: false, manager: true },
    people: [
      { id: 5, roles: ['confirmation'], canAssign: true },
      { id: 6, roles: ['depot'], canManageUsers: true, canAffect: true },
      { id: 7, roles: ['admin'], canAssign: true },
    ],
  });
  const p5 = rightsOf({ id: 5, roles: ['confirmation'] }, rr);
  assert.ok(p5.has('x:assign') && p5.has('act:orders.company') && p5.has('x:rules'));
  assert.ok(!rightsOf({ id: 8, roles: ['confirmation'] }, rr).has('act:orders.company'));
  const p6 = rightsOf({ id: 6, roles: ['depot'] }, rr);
  assert.ok(p6.has('x:users') && p6.has('x:affect') && !p6.has('x:assign'));
  assert.equal(rr.people['7'], undefined);
});

test('saved rights are cleaned: never more than the role may get', () => {
  const people = new Map([[5, { roles: ['confirmation'] as Role[], agencyId: null }]]);
  const c = cleanRoleRights(
    {
      roles: {
        confirmation: { off: ['act:orders.cancel', 'page:accueil', 'act:stock.prices', 'nope'], on: ['x:users', 'x:rules', 'act:orders.cancel'] },
        marketer: { on: ['x:assign'] },
      },
      people: { '5': { on: ['x:users', 'page:caisse', 'act:orders.cancel'], off: ['tab:suivi/swap'] }, '99': { on: ['x:users'] } },
    },
    people,
  );
  // accueil is locked, stock.prices is not a confirmation default; users is not « en plus » for confirmation
  assert.deepEqual(c.roles.confirmation, { off: ['act:orders.cancel'], on: ['x:rules'] });
  assert.equal(c.roles.marketer, undefined);
  // one person: the few given to anyone, and what the role lost given back to her; never an admin page
  assert.deepEqual(c.people['5'], { off: ['tab:suivi/swap'], on: ['x:users', 'act:orders.cancel'] });
  assert.equal(c.people['99'], undefined);
});

test('the server follows the boutique’s rights: buttons, tabs, pages, « en plus », one person apart', async () => {
  const { db, as } = await setup(60);
  const admin = await as(EMAILS.admin);
  const samira = await as(EMAILS.conf);
  const karim = await as(EMAILS.depot);
  const rania = await as(EMAILS.conf2);

  // first read: made from the old ticks (karim had « Peut attribuer »), saved once
  await db.query('UPDATE profiles SET can_assign = true WHERE email = $1', [EMAILS.depot]);
  forgetRights(db);
  const first = await boutiqueRights(db);
  // (« Peut attribuer » made him a manager of Préférences' « Qui peut changer la société » too)
  assert.deepEqual(first.people[String(karim.session.profile.id)]?.on, ['x:assign', 'act:orders.company']);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM settings WHERE key = 'roleRights'`))[0].n, 1);
  const k1 = await call('depot.toAssign', await as(EMAILS.depot), {});
  assert.equal(k1.canAct, true);

  // me.get: the rights come with the session (the screens follow them)
  const me = await call('me.get', samira, {});
  assert.ok(Array.isArray(me.rights) && me.rights.includes('page:confirmation') && me.rights.includes('act:orders.cancel'));
  assert.equal((await call('me.get', admin, {})).rights, null);

  // only the administrator changes them
  await assert.rejects(call('rights.save', samira, { roles: {}, people: {} }), /Accès refusé/);

  const order = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND NOT is_exchange ORDER BY id LIMIT 2`)).map((r: any) => num(r.id));
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = ANY($1)', [order, samira.session.profile.id]);

  // Confirmation without « Annuler une commande », without Suivi's « Swap » tab and without SAV
  await call('rights.save', admin, {
    roles: { confirmation: { off: ['act:orders.cancel', 'tab:suivi/swap', 'page:sav', 'act:orders.items'] }, depot: { on: ['act:orders.company'] } },
    people: { [String(rania.session.profile.id)]: { on: ['act:orders.cancel'] } },
  });
  const s2 = await as(EMAILS.conf);
  await assert.rejects(call('orders.setConf', s2, { ids: [order[0]], status: 'cancelled', reason: 'price' }), /Utilisateurs › Rôles/);
  await call('orders.setConf', s2, { ids: [order[0]], status: 'callback', nextCallAt: new Date(Date.now() + 3_600_000).toISOString() });
  await assert.rejects(call('suivi.list', s2, { tab: 'swap' }), /Utilisateurs › Rôles/);
  await call('suivi.list', s2, { tab: 'enlivraison' });
  await assert.rejects(call('sav.list', s2, {}), /Utilisateurs › Rôles/);
  // the customer still changes, the products no more (only a real change counts)
  const o = await call('orders.get', s2, { id: order[1] });
  const items = o.items.map((l: any) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty }));
  await call('orders.update', s2, { id: o.id, customerName: 'Nour Hadj', items });
  await assert.rejects(call('orders.update', s2, { id: o.id, items: items.map((l: any, i: number) => (i === 0 ? { ...l, qty: l.qty + 1 } : l)) }), /produits/);
  // one person apart: Rania has « Annuler » back
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [order[1], rania.session.profile.id]);
  await call('orders.setConf', await as(EMAILS.conf2), { ids: [order[1]], status: 'cancelled', reason: 'price' });
  // the depot was given « Changer la société de livraison » en plus
  const kr = rightsOf({ id: karim.session.profile.id, roles: ['depot'] }, await boutiqueRights(db));
  assert.ok(kr.has('act:orders.company'));
  // the person's three ticks follow (a partner's tools still read them)
  const cols = (await db.query('SELECT can_assign FROM profiles WHERE id = $1', [karim.session.profile.id]))[0];
  assert.equal(cols.can_assign, false, 'karim lost « Peut attribuer » with this save (not in the list sent)');

  // the person card's ticks are the person's own « en plus » in a store
  await call('users.update', admin, { id: karim.session.profile.id, canAssign: true });
  forgetRights(db);
  assert.ok((await boutiqueRights(db)).people[String(karim.session.profile.id)]?.on?.includes('x:assign'));
  assert.equal((await call('depot.toAssign', await as(EMAILS.depot), {})).canAct, true);

  // the purchase prices leave the answers of a depot that lost them
  const before = await call('catalog.products', await as(EMAILS.depot), {});
  assert.ok(JSON.stringify(before).includes('"cost"'));
  await call('rights.save', admin, { roles: { depot: { off: ['act:costs'] } }, people: {} });
  const after = await call('catalog.products', await as(EMAILS.depot), {});
  assert.ok(!/"cost":\s*[1-9]/.test(JSON.stringify(after)), 'no purchase price left');
});
