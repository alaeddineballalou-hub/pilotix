// Control room › Sociétés de livraison, on the server: the API tests with the team's test keys (one company, or all of
// them in the background), and « Changements API »: the daily look (07:20, Algeria time, or « Vérifier maintenant »)
// at what changed at each company — its documentation, the open-source code that follows its API, its API addresses,
// the tests with keys. What it finds goes to the to-do list; after the daily look, the owner and the managers get one
// e-mail listing the new lines (none when nothing changed).
import { Logger } from '@nestjs/common';
import * as core from '@pilotix/core';
import { config } from './config';
import type { CoreService } from './core.service';
import { mailConfigured, sendMail } from './mail';
import { courierWatchMail } from './mails';

const log = new Logger('Courier watch');

/** The couriers' API module (server only), or an error saying it is missing. */
export function couriers(): any {
  let m: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    m = require('@pilotix/core/dist/couriers');
  } catch {
    m = null;
  }
  if (!m?.probeCouriers || !m?.checkCourier || !m?.watchCouriers) throw new core.AppError('bad_request', 'Intégration des sociétés de livraison indisponible sur ce serveur');
  return m;
}

/** One at a time: the memory and the to-do list are read, changed and saved whole (the calls to the companies are not). */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => null);
  return next;
}

/** One company tested with the team's saved keys: its result is kept for the page, what changed goes to the list. */
async function checkAndCompare(c: CoreService, company: string, deep: boolean): Promise<{ result: core.CourierCheckResult; added: core.WatchItem[] }> {
  const co = core.courierCatalog().find((x) => x.key === company && x.kind);
  if (!co?.kind) throw new core.AppError('bad_request', 'Société inconnue');
  const keys = (await core.courierTestKeys(c.t))[co.key];
  if (!keys) throw new core.AppError('bad_request', `Ajoutez d’abord les clés de test de ${co.name}`);
  // the company's own API address (Guepex, Yalitec, DHD…) unless the team typed another one
  const settings: Record<string, unknown> = { ...co.presets };
  for (const [k, v] of Object.entries(keys.settings ?? {})) if (v !== '' && v !== null && v !== undefined) settings[k] = v;
  const m = couriers();
  const r = await m.checkCourier(co.kind, keys.secret, settings, { deep, name: co.name });
  const result: core.CourierCheckResult = { ok: r.ok, deep, at: new Date().toISOString(), steps: r.steps };
  const added = await serial(async () => {
    const prev = (await core.courierTestResults(c.t))[co.key];
    await core.saveCourierTestResult(c.t, co.key, result);
    // a step that stopped working (or works again), new or missing fields in the answers
    const mem = m.watchMemoryOf(await core.watchMemory(c.t));
    const steps = m.checkChanges(co.key, prev, result);
    const fields = m.fieldChanges(co.key, mem, r.shapes ?? {});
    await core.saveWatchMemory(c.t, mem);
    return core.addWatchItems(c.t, [...steps.found, ...fields], { fixed: steps.fixed });
  });
  log.log(`${co.key}${deep ? ' (full)' : ''}: ${r.ok ? 'OK' : 'FAILED'}${added.length ? ` · ${added.length} new line(s)` : ''}`);
  return { result, added };
}

/** Tests › « Tester » / « Test complet ». */
export async function runCheck(c: CoreService, company: string, deep: boolean): Promise<core.CourierCheckResult> {
  return (await checkAndCompare(c, company, deep)).result;
}

/** The companies with saved test keys, not removed from Pilotix. */
export async function testable(c: CoreService): Promise<string[]> {
  const [keys, removed] = await Promise.all([core.courierTestKeys(c.t), core.removedCouriers(c.t)]);
  return core
    .courierCatalog()
    .filter((co) => co.kind && keys[co.key] && !removed[co.key])
    .map((co) => co.key);
}

/** Tests › « Tester toutes les API »: every company with keys, four at a time (quick, without asking any one too much). */
export async function runCheckAll(c: CoreService, list: string[]): Promise<core.WatchItem[]> {
  const queue = [...list];
  const added: core.WatchItem[] = [];
  const worker = async () => {
    for (let k = queue.shift(); k; k = queue.shift()) {
      try {
        added.push(...(await checkAndCompare(c, k, false)).added);
      } catch (e) {
        log.warn(`${k}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return added;
}

let running = false;
export const watchRunning = () => running;

/**
 * The whole look. `by`: who asked (« Vérifier maintenant »), null for the daily look — the only one that sends the
 * e-mail (whoever asked is looking at the page). Returns null when a look is already running.
 */
export async function watchNow(c: CoreService, by: string | null): Promise<{ added: number; notes: string[] } | null> {
  if (running) return null;
  running = true;
  const added: core.WatchItem[] = [];
  const notes: string[] = [];
  let companies: string[] = [];
  try {
    await core.startWatchRun(c.t);
    const removed = await core.removedCouriers(c.t);
    companies = core
      .courierCatalog()
      .filter((co) => !removed[co.key])
      .map((co) => co.key);
    const m = couriers();
    // documentation, open-source code, API addresses
    const look = await m.watchCouriers({ companies, memory: await core.watchMemory(c.t), githubToken: config.githubToken || undefined });
    notes.push(...look.notes);
    added.push(
      ...(await serial(async () => {
        // the answers' fields may have been noted by a test meanwhile: they are kept
        const cur = m.watchMemoryOf(await core.watchMemory(c.t));
        await core.saveWatchMemory(c.t, { ...look.memory, fields: cur.fields });
        return core.addWatchItems(c.t, look.found, { fixed: look.fixed });
      })),
    );
    // the tests with the team's keys
    added.push(...(await runCheckAll(c, await testable(c))));
  } catch (e) {
    notes.push(`Erreur : ${(e as Error).message}`.slice(0, 300));
    log.error(`look failed: ${(e as Error).message}`);
  } finally {
    await core
      .addWatchItems(c.t, [], { run: { at: new Date().toISOString(), by, companies: companies.length, added: added.length, notes: notes.slice(0, 30) } })
      .catch((e) => log.error(`summary not saved: ${(e as Error).message}`));
    running = false;
  }
  log.log(`look by ${by ?? 'the daily job'}: ${companies.length} companies, ${added.length} new line(s)${notes.length ? `, ${notes.length} note(s)` : ''}`);
  if (!by && added.length) await mailNew(c, added);
  return { added: added.length, notes };
}

/** One e-mail to each active owner and manager: the new lines. */
async function mailNew(c: CoreService, added: core.WatchItem[]) {
  if (!mailConfigured()) return;
  const names = new Map(core.courierCatalog().map((co) => [co.key, co.name]));
  const items = added.map((i) => ({ company: names.get(i.company) ?? i.company, title: i.title }));
  const staff = await c.t.platform.query<{ name: string; email: string }>(`SELECT name, email FROM platform.staff WHERE active AND role IN ('owner', 'manager')`);
  for (const s of staff) await sendMail(courierWatchMail({ to: s.email, name: s.name, items })).catch((e) => log.warn(`e-mail to ${s.email}: ${e?.message || e}`));
}
