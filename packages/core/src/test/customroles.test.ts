// Utilisateurs › Rôles › « + Nouveau rôle » (the owner's choice, 22 Nov 2026): an administrator, or someone who manages
// the team's accounts, makes a role from one they have; it never has more than its maker has now (when the maker loses a
// right, the role loses it too); a maker sees and gives only the roles they made, an administrator all of them. And in a
// boutique nobody but an administrator gives a role they do not have themselves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type RoleRights, rightsOf } from '@pilotix/shared';
import { call, num } from '../index';
import { boutiqueRights, giveCustomRole } from '../modules/rights';
import { EMAILS, setup } from './harness';

test('a role made here: from a role its maker has, never more than its maker, seen and given by its maker and the administrator', async () => {
  const { db, as } = await setup(40);
  const admin = await as(EMAILS.admin);
  const yacine0 = await as(EMAILS.manager);
  const amel0 = await as(EMAILS.manager2);
  const samira0 = await as(EMAILS.conf);
  const Y = yacine0.session.profile.id;
  const A = amel0.session.profile.id;
  const S = samira0.session.profile.id;
  const R = (await as(EMAILS.conf2)).session.profile.id;
  const N = (await as(EMAILS.suivi)).session.profile.id;

  // only the administrator and the people who manage the accounts make roles
  await assert.rejects(call('roles.custom.list', samira0, {}), /Accès refusé/);
  await assert.rejects(call('roles.custom.save', yacine0, { name: 'Chef', base: 'confirmation' }), /Accès refusé/);

  // Yacine and Amel (agent managers) manage the accounts
  const managers = { [String(Y)]: { on: ['x:users'] }, [String(A)]: { on: ['x:users'] } };
  await call('rights.save', admin, { roles: {}, people: managers });
  const yacine = await as(EMAILS.manager);
  const amel = await as(EMAILS.manager2);

  // from a role they have: an agent manager is also Confirmation, never Dépôt
  assert.deepEqual((await call('roles.custom.list', yacine, {})).bases, ['agent_manager', 'confirmation']);
  await assert.rejects(call('roles.custom.save', yacine, { name: 'Préparateur', base: 'depot' }), /rôle que vous avez vous-même/);

  // « Agent junior »: Confirmation without « Annuler une commande »; what he asks beyond his own rights is not kept
  const { id: junior } = await call('roles.custom.save', yacine, { name: 'Agent junior', base: 'confirmation', off: ['act:orders.cancel'], on: ['x:affect', 'x:users'] });
  const j = (await call('roles.custom.list', yacine, {})).roles.find((x: any) => x.id === junior)!;
  assert.deepEqual(j.on, [], 'Affectation (he does not have it) and « gérer les comptes » (never from a manager): not kept');
  assert.ok(!j.rights.includes('act:orders.cancel') && j.rights.includes('page:confirmation'));
  assert.equal(j.mine, true);
  assert.ok(j.cap && !j.cap.includes('x:affect'), 'his own rights are the cap');
  await assert.rejects(call('roles.custom.save', yacine, { name: 'agent  JUNIOR', base: 'confirmation' }), /déjà ce nom/);
  await assert.rejects(call('roles.custom.save', yacine, { id: junior, name: 'Agent junior', base: 'agent_manager' }), /ne change pas/);

  await assert.rejects(call('roles.custom.save', yacine, { name: 'Fake admin', base: 'admin' }), /Accès refusé/);
  await assert.rejects(call('roles.custom.save', admin, { name: 'Limited admin', base: 'admin', off: ['act:orders.cancel'] }), /tous les droits/);

  // each maker sees only theirs; the administrator sees them all, with their maker
  assert.equal((await call('roles.custom.list', amel, {})).roles.length, 0);
  await assert.rejects(call('roles.custom.save', amel, { id: junior, name: 'Agent junior', base: 'confirmation' }), /Seuls celui/);
  await assert.rejects(call('roles.custom.delete', amel, { id: junior }), /Seuls celui/);
  const all = await call('roles.custom.list', admin, {});
  assert.equal(all.roles.find((x: any) => x.id === junior)?.byName, 'Yacine');
  assert.deepEqual(all.bases, ['agent_manager', 'confirmation', 'suivi', 'depot', 'livreur', 'cm', 'admin']);

  // given by its maker only; the person needs the role it starts from
  await assert.rejects(call('users.update', amel, { id: S, customRole: junior }), /que vous avez faits/);
  await assert.rejects(call('users.update', yacine, { id: N, customRole: junior }), /cochez aussi ce rôle/);
  await call('users.update', yacine, { id: S, customRole: junior });
  assert.equal((await call('roles.custom.list', amel, {})).of[String(S)]?.name, 'Agent junior', 'a card names it, even for someone else');
  assert.equal((await call('roles.custom.list', amel, {})).of[String(S)]?.mine, false);

  // Samira follows it: no « Annuler » any more (the server refuses it, her session says so), the rest as before
  const samira = await as(EMAILS.conf);
  assert.ok(!(await call('me.get', samira, {})).rights?.includes('act:orders.cancel'));
  const order = num((await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND NOT is_exchange ORDER BY id LIMIT 1`))[0].id);
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [order, S]);
  await assert.rejects(call('orders.setConf', samira, { ids: [order], status: 'cancelled', reason: 'price' }), /Utilisateurs › Rôles/);
  await call('orders.setConf', samira, { ids: [order], status: 'callback', nextCallAt: new Date(Date.now() + 3_600_000).toISOString() });

  // the cap follows its maker today: Yacine loses « Changer les produits », so does his role; plain Confirmation keeps it
  await call('rights.save', admin, { roles: { agent_manager: { off: ['act:orders.items'] } }, people: managers });
  let rr = await boutiqueRights(db);
  assert.ok(!rightsOf({ id: S, roles: ['confirmation'] }, rr).has('act:orders.items'), 'gone with its maker');
  assert.ok(rightsOf({ id: R, roles: ['confirmation'] }, rr).has('act:orders.items'), 'Rania: plain Confirmation');
  await call('rights.save', admin, { roles: {}, people: managers });

  const { id: supervisorAdmin } = await call('roles.custom.save', admin, { name: 'Store administrator', base: 'admin' });
  await assert.rejects(giveCustomRole(admin, R, supervisorAdmin, ['confirmation']), /Administrateur/);
  await call('users.update', admin, { id: R, roles: ['admin'], customRole: supervisorAdmin });
  const administrator = (await call('roles.custom.list', admin, {})).roles.find((role: any) => role.id === supervisorAdmin)!;
  assert.ok(administrator.rights.includes('x:users'));
  assert.ok(administrator.rights.includes('act:ads.owner'));
  assert.equal((await call('roles.custom.list', admin, {})).of[String(R)]?.id, supervisorAdmin);
  await call('users.update', admin, { id: R, roles: ['confirmation'], customRole: null });

  // a role the administrator makes has no cap, « gérer les comptes » included
  const { id: plus } = await call('roles.custom.save', admin, { name: 'Agent plus', base: 'confirmation', on: ['x:users', 'x:affect'] });
  assert.deepEqual((await call('roles.custom.list', admin, {})).roles.find((x: any) => x.id === plus)?.on.sort(), ['x:affect', 'x:users']);
  await call('users.update', admin, { id: R, customRole: plus });
  rr = await boutiqueRights(db);
  assert.ok(rightsOf({ id: R, roles: ['confirmation'] }, rr).has('x:affect'));
  // its starting role taken away (the card's roles): the role made here goes with it
  await giveCustomRole(admin, R, undefined, ['suivi']);
  assert.equal((await call('roles.custom.list', admin, {})).of[String(R)], undefined);

  // in a boutique nobody but the administrator gives a role they do not have themselves (the person keeps hers)
  await assert.rejects(
    call('users.create', yacine, { name: 'Nour Benali', email: 'nour.depot@test.dz', phone: '0550123456', password: 'Pilotix-Essai-2026!', roles: ['depot'] }),
    /pas « Dépôt »/,
  );
  await assert.rejects(call('users.update', yacine, { id: R, roles: ['confirmation', 'suivi'] }), /pas « Suivi »/);
  await call('users.update', yacine, { id: N, roles: ['suivi'], name: 'Nadia Belkacem' });

  // taken back by its maker or the administrator only (it may have taken rights away); deleted once nobody has it
  await assert.rejects(call('roles.custom.delete', yacine, { id: junior }), /encore donné à/);
  await assert.rejects(call('users.update', amel, { id: S, customRole: null }), /quelqu’un d’autre/);
  await db.query('UPDATE profiles SET archived_at = now(), active = false WHERE id = $1', [S]);
  const archived = (await call('roles.custom.list', admin, {})).roles.find((x: any) => x.id === junior);
  assert.equal(archived?.people.find((p: any) => p.id === S)?.active, false);
  await assert.rejects(call('roles.custom.delete', admin, { id: junior }), /encore donné à/);
  await call('users.update', admin, { id: S, customRole: plus });
  await db.query('UPDATE profiles SET archived_at = NULL, active = true WHERE id = $1', [S]);
  await call('roles.custom.delete', yacine, { id: junior });
  const afterDelete = await call('roles.custom.list', admin, {});
  assert.equal(afterDelete.roles.some((x: any) => x.id === junior), false);
  assert.equal(afterDelete.of[String(S)]?.id, plus);
  assert.ok((await call('me.get', await as(EMAILS.conf), {})).rights?.includes('act:orders.cancel'), 'Samira has the replacement role permissions');
});

test('roles made by each other never go round in a loop: then the starting role caps them', () => {
  const rr: RoleRights = {
    roles: {},
    people: {},
    custom: {
      roles: {
        c1: { id: 'c1', name: 'A', base: 'confirmation', by: 10, at: '' },
        c2: { id: 'c2', name: 'B', base: 'agent_manager', by: 11, at: '' },
      },
      people: { '10': 'c2', '11': 'c1' },
      makers: { '10': { roles: ['agent_manager'] }, '11': { roles: ['confirmation'] } },
    },
  };
  const s = rightsOf({ id: 11, roles: ['confirmation'] }, rr);
  assert.ok(s.has('page:confirmation') && s.has('act:orders.cancel'));
  // a maker whose account is gone: the starting role as the boutique has it, nothing more
  const gone: RoleRights = { ...rr, custom: { ...rr.custom!, roles: { c1: { id: 'c1', name: 'A', base: 'confirmation', by: 99, at: '', on: ['x:affect'] } }, people: { '11': 'c1' } } };
  assert.ok(!rightsOf({ id: 11, roles: ['confirmation'] }, gone).has('x:affect'));
});
