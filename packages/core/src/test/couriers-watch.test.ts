// Control room › Sociétés de livraison: a company removed from Pilotix (asked twice, hidden from the shops' list, back
// with « Restaurer ») and « Changements API » — what the daily look finds (documentation, open-source code, API
// addresses, tests with keys), the to-do list with « Résolu » / « Non résolu », lines added by hand.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { checkChanges, commitCompanies, docDiff, docLines, endpointOf, fieldChanges, jsonShape, lookAddresses, watchCouriers, watchMemoryOf, WATCH_REPOS } from '../couriers/watch';
import { addWatchItems, call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, staffLogin, watchState } from '../index';

const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));


test('documentation: lines added and removed, the same text gives the same lines', () => {
  const v1 = '# API\n- [Create a parcel](https://x/parcels.md)\n- [Track](https://x/track.md)\n\n  \n- [Track](https://x/track.md)';
  const v2 = '# API\n- [Create a parcel](https://x/parcels.md)\n- [Cancel a claim](https://x/claims.md)';
  assert.deepEqual(docLines(v1, 'text'), ['# API', '- [Create a parcel](https://x/parcels.md)', '- [Track](https://x/track.md)']);
  const d = docDiff(docLines(v1, 'text'), docLines(v2, 'text'));
  assert.deepEqual(d.added, ['- [Cancel a claim](https://x/claims.md)']);
  assert.deepEqual(d.removed, ['- [Track](https://x/track.md)']);
  // a Postman collection: each request, its query parameters and its body fields
  const postman = {
    info: { name: 'API' },
    item: [
      { name: 'Commandes', item: [{ name: 'Ajouter', request: { method: 'POST', url: '{{url}}/insertCommande/?apiKey=k&name=n', body: { mode: 'raw', raw: '{"phone":"1"}' } } }] },
      { name: 'Suivi', request: { method: 'GET', url: { raw: 'https://api.x.dz/getTracking/?tracking=1', query: [{ key: 'tracking' }] } } },
    ],
  };
  assert.deepEqual(docLines(JSON.stringify(postman), 'postman'), [
    'POST /insertCommande/ — Commandes › Ajouter',
    'POST /insertCommande/ · paramètre apiKey',
    'POST /insertCommande/ · paramètre name',
    'POST /insertCommande/ · champ phone',
    'GET /getTracking/ — Suivi',
    'GET /getTracking/ · paramètre tracking',
  ]);
  assert.deepEqual(docLines('not json', 'postman'), []);
});

test('the whole look: the first one only remembers; the next ones find a changed documentation and new open-source code', async () => {
  let docs = '# ZR API\n- [Parcels](https://docs.zrexpress.app/reference/parcels.md)';
  let commits: unknown[] = [{ sha: 'a1', html_url: 'https://github.com/KaziSTM/vargo/commit/a1', commit: { committer: { date: '2026-10-01T00:00:00Z' }, message: 'old' } }];
  const b2 = { files: [{ filename: 'src/Services/Zr/Parcels/Create.php' }, { filename: 'README.md' }], commit: { message: 'ZR: new claim fields\n\nmore' } };
  // a fake internet: the documentation and the commits are what the variables hold now; ZR's API says « not found »
  globalThis.fetch = (async (u: string) => {
    const url = String(u);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (/docs\.zrexpress\.app\/llms\.txt/.test(url)) return new Response(docs, { status: 200 });
    if (/repos\/KaziSTM\/vargo\/commits\?/.test(url)) return json(commits);
    if (/repos\/KaziSTM\/vargo\/commits\/b2$/.test(url)) return json(b2);
    if (/api\.github\.com/.test(url)) return json([]);
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const first = await watchCouriers({ companies: ['zr'], memory: {}, pause: 0 });
  assert.deepEqual(first.found, [], 'the first look finds nothing: it remembers');
  assert.equal(first.memory.repos['KaziSTM/vargo'].sha, 'a1');
  assert.ok(first.memory.docs.zr.lines.length === 2);

  docs += '\n- [Cancel a claim](https://docs.zrexpress.app/reference/cancelclaim.md)';
  commits = [{ sha: 'b2', html_url: 'https://github.com/KaziSTM/vargo/commit/b2', commit: { committer: { date: '2026-10-28T10:00:00Z' }, message: 'ZR: new claim fields' } }, ...commits];
  const second = await watchCouriers({ companies: ['zr'], memory: first.memory, pause: 0 });
  const doc = second.found.find((f) => f.kind === 'docs')!;
  assert.equal(doc.company, 'zr');
  assert.match(doc.detail, /Ajouté \(1\) : « Cancel a claim »/);
  const code = second.found.find((f) => f.kind === 'code')!;
  assert.equal(code.company, 'zr');
  assert.equal(code.link, 'https://github.com/KaziSTM/vargo/commit/b2');
  assert.match(code.detail, /« ZR: new claim fields » — 1 fichier : Create\.php/);
  assert.equal(second.memory.repos['KaziSTM/vargo'].sha, 'b2');
  // nothing changed since: nothing found
  const third = await watchCouriers({ companies: ['zr'], memory: second.memory, pause: 0 });
  assert.deepEqual(third.found, []);
});

test('open-source code: a commit is about the companies whose files it touches (and only those looked at)', () => {
  const vargo = WATCH_REPOS.find((r) => r.repo === 'KaziSTM/vargo')!;
  const files = ['src/Services/Yalidine/Http/Client.php', 'src/Drivers/YalidineClones/GuepexExpressDriver.php', 'src/Drivers/NoestDriver.php', 'src/Services/Zr2/x.php'];
  assert.deepEqual(Object.keys(commitCompanies(vargo, files, new Set(['yalidine', 'guepex', 'noest', 'zr']))).sort(), ['guepex', 'noest', 'yalidine']);
  assert.deepEqual(Object.keys(commitCompanies(vargo, files, new Set(['noest']))), ['noest']);
});

test('GitHub limit reached: noted, nothing lost (the next look goes on from the same commit)', async () => {
  globalThis.fetch = (async () => new Response('{"message":"rate limit"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })) as typeof fetch;
  const mem = { repos: { 'KaziSTM/vargo': { sha: 'a1', date: '2026-10-01T00:00:00Z' } } };
  const r = await watchCouriers({ companies: ['near'], memory: mem, pause: 0 });
  assert.ok(r.notes.some((n) => /limite/.test(n)));
  assert.equal(r.memory.repos['KaziSTM/vargo'].sha, 'a1');
});

test('API addresses: « not found » twice in a row after being there = one line; back = closed; never there = nothing', async () => {
  const a = { base: 'https://api.x.dz', headers: { Authorization: 'Bearer x' }, list: ['GET /parcels', 'POST /claims', 'GET /never'] };
  const mem = watchMemoryOf({});
  let parcels = 401;
  globalThis.fetch = (async (u: string) => {
    const url = String(u);
    if (url.endsWith('/pilotix-watch-nope-404')) return new Response('', { status: 404 });
    if (url.endsWith('/parcels')) return new Response('', { status: parcels });
    if (url.endsWith('/claims')) return new Response('', { status: 401 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const look = async () => {
    const found: any[] = [];
    const fixed: string[] = [];
    const notes: string[] = [];
    await lookAddresses('x', a, mem, found, fixed, notes, 0);
    return { found, fixed, notes };
  };
  assert.deepEqual((await look()).found, []);
  parcels = 404;
  assert.deepEqual((await look()).found, [], 'one « not found » may pass');
  const gone = await look();
  assert.equal(gone.found.length, 1);
  assert.equal(gone.found[0].key, 'gone:x:GET /parcels');
  assert.equal(gone.found[0].kind, 'gone');
  assert.deepEqual((await look()).found, [], 'said once');
  parcels = 401;
  assert.ok((await look()).fixed.includes('gone:x:GET /parcels'), 'back: its line closes itself');
  // an API that refuses the keys before looking at the address: nothing can be told, nothing is found
  globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
  const blind = await look();
  assert.deepEqual(blind.found, []);
  assert.ok(blind.notes[0].includes('introuvable'));
});

test('tests with keys: a step that stops working is one line; working again closes it', () => {
  const ok = { steps: [{ step: 'connection', ok: true, detail: 'OK' }, { step: 'fees', ok: true, detail: '58 wilayas' }] };
  const bad = { steps: [{ step: 'connection', ok: true, detail: 'OK' }, { step: 'fees', ok: false, detail: 'Yalidine : erreur 500' }] };
  const r = checkChanges('yalidine', ok, bad);
  assert.equal(r.found.length, 1);
  assert.equal(r.found[0].key, 'broken:yalidine:fees');
  assert.match(r.found[0].title, /Tarifs/);
  assert.deepEqual(checkChanges('yalidine', bad, bad).found, [], 'still broken: no new line');
  assert.deepEqual(checkChanges('yalidine', null, bad).found, [], 'first test (keys just typed): not a change');
  assert.ok(checkChanges('yalidine', bad, ok).fixed.includes('broken:yalidine:fees'));
});

test('answers: fields remembered, new fields found at once, missing ones after three looks in a row', () => {
  assert.deepEqual(jsonShape({ data: [{ id: 1, tracking: 'x' }, { id: 2, extra: null }], per: { '1601': { price: 1 } } }), ['data', 'data[].extra', 'data[].id', 'data[].tracking', 'per', 'per.:n', 'per.:n.price']);
  assert.equal(endpointOf('get', 'https://api.yalidine.app/v1/parcels/yal-12AB/?page=2'), 'GET /v1/parcels/:id/');
  assert.equal(endpointOf('GET', 'https://ecom-dz.net/Api_v1/Commune/16'), 'GET /Api_v1/Commune/:id');
  const mem = watchMemoryOf({});
  assert.deepEqual(fieldChanges('ecotrack', mem, { 'GET /api/v1/get/fees': ['livraison', 'livraison[].tarif'] }), []);
  const more = fieldChanges('ecotrack', mem, { 'GET /api/v1/get/fees': ['livraison', 'livraison[].tarif', 'livraison[].tarif_retour'] });
  assert.equal(more.length, 1);
  assert.match(more[0].detail, /livraison\[\]\.tarif_retour/);
  const less = { 'GET /api/v1/get/fees': ['livraison', 'livraison[].tarif_retour'] };
  assert.deepEqual(fieldChanges('ecotrack', mem, less), []);
  assert.deepEqual(fieldChanges('ecotrack', mem, less), []);
  const gone = fieldChanges('ecotrack', mem, less);
  assert.equal(gone.length, 1);
  assert.match(gone[0].title, /disparu/);
  assert.match(gone[0].detail, /livraison\[\]\.tarif(?!_)/);
});

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { email: 'owner@boutique.dz', password: 'Owner-Password-1', name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, 'owner@boutique.dz', 'Owner-Password-1');
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  return { t, pctx };
}

test('removing a company: asked twice, gone from the shops’ list (those using it keep it), counted, put back', async () => {
  const { t, pctx } = await server();
  const db = t.shop('public');
  await db.query(`INSERT INTO delivery_companies (name, kind, active, config) VALUES ('Guepex', 'yalidine', true, '{"settings":{"base_url":"https://api.guepex.app/v1/"}}'), ('ZR', 'zr', true, '{}')`);
  assert.deepEqual(await platformCall('p.couriers.usage', pctx, { company: 'guepex' }), { stores: 1 });
  assert.deepEqual(await platformCall('p.couriers.usage', pctx, { company: 'yalidine' }), { stores: 0 }, 'Guepex is not Yalidine');
  await assert.rejects(() => platformCall('p.couriers.remove', pctx, { company: 'guepex' }), /confirm/i);
  await platformCall('p.couriers.remove', pctx, { company: 'guepex', confirm: true });
  const st: any = await platformCall('p.couriers.state', pctx, {});
  assert.ok(st.removed.guepex.at);
  assert.equal(st.removed.guepex.by, pctx.staff.name);
  // the shops no longer get it to add; their own company is still there
  const ctx: Ctx = { db, session: await login(db, 'owner@boutique.dz', 'Owner-Password-1'), now: () => Date.now(), emit: () => {}, t };
  const kinds: any = await call('delivery.kinds', ctx, {});
  assert.ok(!kinds.cards.some((c: any) => c.company === 'guepex'));
  assert.ok(kinds.cards.some((c: any) => c.company === 'yalidine'));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM delivery_companies WHERE kind = 'yalidine' AND active`))[0].n, 1);
  await platformCall('p.couriers.restore', pctx, { company: 'guepex' });
  assert.ok(((await call('delivery.kinds', ctx, {})) as any).cards.some((c: any) => c.company === 'guepex'));
  await assert.rejects(() => platformCall('p.couriers.remove', pctx, { company: 'nobody', confirm: true }), /Société inconnue/);
});

test('« Changements API »: lines added once while not resolved, Résolu / Non résolu, closed by themselves, by hand', async () => {
  const { t, pctx } = await server();
  const line = { company: 'zr', kind: 'docs' as const, key: 'docs:zr:abc', title: 'La documentation API a changé', detail: 'Ajouté (1)', link: 'https://docs.zrexpress.app/' };
  assert.equal((await addWatchItems(t, [line])).length, 1);
  assert.equal((await addWatchItems(t, [line])).length, 0, 'the same change, still « Non résolu »: not added twice');
  const [it] = (await watchState(t)).items;
  const solved: any = await platformCall('p.couriers.todo.set', pctx, { id: it.id, status: 'resolved' });
  assert.equal(solved.status, 'resolved');
  assert.equal(solved.resolvedBy, pctx.staff.name);
  assert.equal((await addWatchItems(t, [line])).length, 1, 'found again after « Résolu »: a new line');
  const back: any = await platformCall('p.couriers.todo.set', pctx, { id: it.id, status: 'open' });
  assert.equal(back.resolvedAt, null);
  // a test that works again closes its line by itself
  await addWatchItems(t, [{ company: 'noest', kind: 'broken', key: 'broken:noest:connection', title: 'x', detail: '', link: null }]);
  await addWatchItems(t, [], { fixed: ['broken:noest:connection'], run: { at: new Date().toISOString(), by: null, companies: 14, added: 1, notes: ['GitHub : limite'] } });
  const st: any = await platformCall('p.couriers.state', pctx, {});
  const fixed = st.watch.items.find((i: any) => i.key === 'broken:noest:connection');
  assert.equal(fixed.status, 'resolved');
  assert.equal(fixed.resolvedBy, 'Pilotix');
  assert.equal(st.watch.last.companies, 14);
  assert.equal(st.watch.running, null);
  // by hand: added, removed; a line Pilotix found is never removed (only « Résolu »)
  const mine: any = await platformCall('p.couriers.todo.add', pctx, { company: 'colivraison', title: 'Demander la documentation API', detail: 'relancer jeudi' });
  assert.equal(mine.kind, 'manual');
  assert.equal(mine.by, pctx.staff.name);
  await assert.rejects(() => platformCall('p.couriers.todo.remove', pctx, { id: it.id }), /à la main/);
  await platformCall('p.couriers.todo.remove', pctx, { id: mine.id });
  assert.ok(!(await watchState(t)).items.some((i) => i.id === mine.id));
  // the control room's menu counts the lines not resolved
  const dash: any = await platformCall('p.dashboard', pctx, {});
  assert.equal(dash.couriers, (await watchState(t)).items.filter((i) => i.status === 'open').length);
});
