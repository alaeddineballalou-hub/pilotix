import { DEFAULT_MANAGEMENT_PLAN, ManagementPlanConfig, payPeriodAt, PayTask } from '@pilotix/shared';
import type { Db } from '../db';
import { num } from '../db';
import { setRaw } from '../modules/admin';
import { payLedger, PAY_ACOMPTE_KEY, PAY_CALENDAR_KEY, recordPayment } from '../modules/pay';

const H = 3_600_000;

/**
 * Agent pay in the demo: a plan per job (confirmation in 5 price steps, team leaders on their team's orders, suivi per
 * parcel delivered, dépôt per parcel prepared), pay every 15 days, acomptes up to 5 000 DA from the 5th. The period
 * before last was paid and confirmed; the last one is ready (Nadia says she did not get hers, Karim has not answered);
 * Samira's acompte waits for her answer, Rania asks one; Imane has no plan yet (the owner's red alert).
 */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const base: ManagementPlanConfig = { ...structuredClone(DEFAULT_MANAGEMENT_PLAN), monthly: 0 };
  const steps = (a: number[]) => [
    { from: 0, to: 2000, amount: a[0] },
    { from: 2001, to: 5000, amount: a[1] },
    { from: 5001, to: 10000, amount: a[2] },
    { from: 10001, to: 15000, amount: a[3] },
    { from: 15001, to: null, amount: a[4] },
  ];
  const plans: Record<PayTask, { id: number; name: string; config: ManagementPlanConfig }> = {} as never;
  const add = async (task: PayTask, name: string, config: ManagementPlanConfig) => {
    const id = num((await db.query(`INSERT INTO management_payment_plans (kind, name, configuration) VALUES ('agent', $1, $2) RETURNING id`, [name, JSON.stringify(config)]))[0].id);
    plans[task] = { id, name, config };
  };
  const qty = { enabled: true, method: 'qty' as const, rate: 0, trigger: 'delivered' as const, ruleVersion: 2 as const };
  const noUp = { ...base.upsell, enabled: false, rate: 0, trigger: 'delivered' as const, ruleVersion: 2 as const };
  await add('confirmation', 'Confirmation · 5 tranches', { ...base, agentTask: 'confirmation', method: 'tier', trigger: 'delivered', ranges: steps([50, 80, 100, 150, 200]), upsell: qty });
  await add('superviseur', 'Superviseur · équipe', { ...base, agentTask: 'superviseur', method: 'tier', trigger: 'delivered', ranges: steps([20, 30, 40, 50, 60]), upsell: qty });
  await add('suivi', 'Suivi · par colis livré', { ...base, agentTask: 'suivi', method: 'fixed', rate: 40, trigger: 'delivered', upsell: noUp });
  await add('depot', 'Dépôt · par colis préparé', { ...base, agentTask: 'depot', method: 'fixed', rate: 30, trigger: 'prepared', upsell: noUp });

  const cal = { every: 'half' as const };
  await setRaw(db, PAY_CALENDAR_KEY, cal);
  await setRaw(db, PAY_ACOMPTE_KEY, { max: 5000, fromDay: 5 });
  const open = payPeriodAt(cal, now);
  const last = payPeriodAt(cal, open.from - 1);
  const before = payPeriodAt(cal, last.from - 1);
  const since = new Date(before.from).toISOString();

  const give: [string, PayTask][] = [
    ['conf1', 'confirmation'],
    ['conf2', 'confirmation'],
    ['manager1', 'superviseur'],
    ['manager1', 'confirmation'],
    ['manager2', 'superviseur'],
    ['suivi', 'suivi'],
    ['depot', 'depot'],
  ];
  for (const [who, task] of give) {
    const p = plans[task];
    await db.query('INSERT INTO pay_plan_terms (profile_id, task, plan_id, name, configuration, effective_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [users[who], task, p.id, p.name, JSON.stringify(p.config), since, users.admin]);
    await db.query('INSERT INTO pay_plan_slots (profile_id, task, plan_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [users[who], task, p.id]);
  }

  // the period before last: paid the morning of the next cut day, confirmed by everyone
  const paidOn = last.from + 10 * H;
  for (const who of ['conf1', 'conf2', 'manager1', 'manager2', 'suivi', 'depot']) {
    const l = await payLedger(db, users[who], last.from + 1);
    if (l.ready.total <= 0) continue;
    await recordPayment(db, { personId: users[who], kind: 'pay', from: l.paidUntil!, to: l.ready.periods[l.ready.periods.length - 1].to, amount: l.ready.total, caisse: 'main', by: users.admin, at: new Date(paidOn).toISOString(), status: 'received', answeredAt: new Date(paidOn + 2 * H).toISOString() });
  }
  // the last period: Nadia was paid but says the money did not come; Karim was paid and has not answered yet
  const paidAgain = Math.min(open.from + 10 * H, now - 2 * H);
  if (paidAgain > open.from) {
    for (const [who, status] of [['suivi', 'not_received'], ['depot', 'paid']] as const) {
      const l = await payLedger(db, users[who], paidAgain);
      if (l.ready.total <= 0) continue;
      await recordPayment(db, { personId: users[who], kind: 'pay', from: l.paidUntil!, to: l.ready.periods[l.ready.periods.length - 1].to, amount: l.ready.total, caisse: 'main', by: users.admin, at: new Date(paidAgain).toISOString(), status, answeredAt: status === 'not_received' ? new Date(Math.min(paidAgain + H, now - 60_000)).toISOString() : null });
    }
  }
  // acomptes in the open period: Samira's was paid yesterday and waits for her answer; Rania asks one
  const sam = await payLedger(db, users.conf1, now);
  const a = Math.min(2000, Math.floor((sam.open.earned * 0.6) / 100) * 100);
  const askAt = Math.max(open.from + H, now - 26 * H);
  const payAt = Math.max(askAt + H, now - 19 * H);
  if (a >= 500 && payAt < now) {
    const r = await db.query(`INSERT INTO pay_requests (profile_id, amount, note, status, asked_at, decided_by, decided_at) VALUES ($1,$2,$3,'paid',$4,$5,$6) RETURNING id`, [users.conf1, a, 'Pour la rentrée des enfants', new Date(askAt).toISOString(), users.admin, new Date(payAt).toISOString()]);
    await recordPayment(db, { personId: users.conf1, kind: 'acompte', amount: a, caisse: 'main', by: users.admin, at: new Date(payAt).toISOString(), requestId: num(r[0].id) });
  }
  const ran = await payLedger(db, users.conf2, now);
  const b = Math.min(1500, Math.floor((ran.open.earned * 0.5) / 100) * 100);
  if (b >= 500) await db.query(`INSERT INTO pay_requests (profile_id, amount, note, asked_at) VALUES ($1,$2,$3,$4)`, [users.conf2, b, 'Facture d’électricité', new Date(Math.max(open.from + H, now - 3 * H)).toISOString()]);
}
