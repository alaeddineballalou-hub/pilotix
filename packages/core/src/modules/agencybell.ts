import { num } from '../db';
import { CONF_TODO, type AgencyTask } from '@pilotix/shared';
import { z } from 'zod';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { ringBell, type BellKind } from './bell';

const TITLES = {
  invitation: { en: 'New seller invitation', fr: 'Nouvelle invitation vendeur', ar: 'دعوة جديدة من بائع' },
  invitationAccepted: { en: 'Seller invitation accepted', fr: 'Invitation du vendeur acceptée', ar: 'تم قبول دعوة البائع' },
  invitationRefused: { en: 'Seller invitation declined', fr: 'Invitation du vendeur refusée', ar: 'تم رفض دعوة البائع' },
  accepted: { en: 'Agency request accepted', fr: 'Demande de collaboration acceptée', ar: 'تم قبول طلب التعاون' },
  refused: { en: 'Agency request declined', fr: 'Demande de collaboration refusée', ar: 'تم رفض طلب التعاون' },
  team: { en: 'Agency team updated', fr: 'Équipe de l’agence mise à jour', ar: 'تم تحديث فريق الوكالة' },
  access: { en: 'Your seller access changed', fr: 'Votre accès aux vendeurs a changé', ar: 'تم تغيير صلاحيات وصولك إلى البائعين' },
  paid: { en: 'Seller marked an invoice as paid', fr: 'Facture marquée payée par le vendeur', ar: 'سجّل البائع الفاتورة كمدفوعة' },
  received: { en: 'Seller payment confirmed received', fr: 'Réception du paiement vendeur confirmée', ar: 'تم تأكيد استلام دفعة البائع' },
  order: { en: 'Orders assigned to you', fr: 'Commandes qui vous sont affectées', ar: 'طلبات أُسندت إليك' },
  delegatedConfirmation: { en: 'New order sent to your agency for confirmation', fr: 'Nouvelle commande confiée à votre agence pour confirmation', ar: 'طلب جديد أُحيل إلى وكالتك للتأكيد' },
  delegatedFollow: { en: 'New order sent to your agency for delivery follow-up', fr: 'Nouvelle commande confiée à votre agence pour le suivi', ar: 'طلب جديد أُحيل إلى وكالتك للمتابعة' },
  delegatedSav: { en: 'New after-sales ticket sent to your agency', fr: 'Nouveau ticket SAV confié à votre agence', ar: 'تذكرة خدمة ما بعد البيع جديدة لوكالتك' },
  savAssigned: { en: 'After-sales ticket assigned to you', fr: 'Ticket SAV qui vous est affecté', ar: 'تذكرة خدمة ما بعد البيع أُسندت إليك' },
  follow: { en: 'Parcels assigned to you', fr: 'Colis qui vous sont affectés', ar: 'طرود أُسندت إليك' },
};

const ROLES = ['admin', 'agent_manager', 'confirmation', 'suivi', 'sav'] as const;
type AgencyRole = (typeof ROLES)[number];
const GROUPS = ['seller', 'order', 'follow', 'sav', 'team', 'access', 'payment', 'delegatedConfirmation', 'delegatedFollow', 'delegatedSav'] as const;
type Group = (typeof GROUPS)[number];
const ALLOWED: Record<Group, readonly AgencyRole[]> = {
  seller: ['admin'], order: ['confirmation'],
  follow: ['suivi'], sav: ['sav'], team: ['admin', 'agent_manager'],
  access: ['confirmation', 'suivi', 'sav'], payment: ['admin'],
  delegatedConfirmation: ['admin', 'agent_manager', 'confirmation'],
  delegatedFollow: ['admin', 'agent_manager', 'suivi'], delegatedSav: ['admin', 'agent_manager', 'sav'],
};
const DEFAULTS: Record<Group, readonly AgencyRole[]> = {
  ...ALLOWED, delegatedConfirmation: ['admin'], delegatedFollow: ['admin'], delegatedSav: ['admin'],
};
const GROUP: Record<keyof typeof TITLES, Group> = {
  invitation: 'seller', invitationAccepted: 'seller', invitationRefused: 'seller', accepted: 'seller', refused: 'seller',
  order: 'order', follow: 'follow', savAssigned: 'sav', team: 'team', access: 'access', paid: 'payment', received: 'payment',
  delegatedConfirmation: 'delegatedConfirmation', delegatedFollow: 'delegatedFollow', delegatedSav: 'delegatedSav',
};

const cleanRoles = (group: Group, roles: readonly string[]) => ALLOWED[group].filter((role) => roles.includes(role));

const SERVICE: Partial<Record<Group, AgencyTask>> = {
  order: 'confirmation', follow: 'suivi', sav: 'sav',
  delegatedConfirmation: 'confirmation', delegatedFollow: 'suivi', delegatedSav: 'sav',
};
const METRICS = ['order', 'follow', 'sav'] as const;
type Metric = (typeof METRICS)[number];
const RULE = z.object({ threshold: z.number().int().min(1).max(100000), roles: z.array(z.enum(ROLES)).min(1).max(ROLES.length) });
const kpiRoles = (metric: Metric) => ['admin', 'agent_manager', ...ALLOWED[metric]] as AgencyRole[];

async function agencyLinks(ctx: Ctx) {
  return (await ctx.t?.platform.query(
    `SELECT l.tasks, s.schema_name FROM platform.agency_links l JOIN platform.shops s ON s.id = l.store_id
     JOIN platform.shops a ON a.id = l.agency_id
     WHERE l.agency_id = $1 AND l.status = 'active' AND s.status = 'active'
       AND a.kind = 'agency' AND a.status = 'active' AND a.agency_verified_at IS NOT NULL`,
    [ctx.shop!.id],
  )) ?? [];
}

const hasService = (links: Awaited<ReturnType<typeof agencyLinks>>, task: AgencyTask) =>
  links.some((link) => Array.isArray(link.tasks) && link.tasks.includes(task));

export const agencyBellProcs = {
  'agency.notifications.get': proc([], z.object({}), async (ctx) => {
    if (ctx.shop?.kind !== 'agency') throw forbidden();
    const saved = await getSetting(ctx.db, 'agencyNotify');
    const links = await agencyLinks(ctx);
    const kpis = await getSetting(ctx.db, 'agencyKpis');
    return {
      groups: GROUPS.filter((group) => !SERVICE[group] || hasService(links, SERVICE[group]!))
        .map((group) => ({ group, allowed: ALLOWED[group], roles: cleanRoles(group, saved[group] ?? DEFAULTS[group]) })),
      kpis: METRICS.filter((metric) => hasService(links, SERVICE[metric]!))
        .map((metric) => ({ metric, allowed: kpiRoles(metric), rule: kpis[metric] ?? null })),
    };
  }),
  'agency.notifications.set': proc([], z.object({
    rules: z.record(z.enum(GROUPS), z.array(z.enum(ROLES)).max(ROLES.length)),
    kpis: z.record(z.enum(METRICS), RULE.nullable()).optional(),
  }), async (ctx, { rules, kpis }) => {
    if (ctx.shop?.kind !== 'agency') throw forbidden();
    const saved = { ...await getSetting(ctx.db, 'agencyNotify') };
    const alerts = { ...await getSetting(ctx.db, 'agencyKpis') };
    const links = await agencyLinks(ctx);
    for (const group of GROUPS) if (rules[group]) {
      if (rules[group]!.length && SERVICE[group] && !hasService(links, SERVICE[group]!)) throw bad('Ce service n’est pas confié à votre agence');
      saved[group] = cleanRoles(group, rules[group]!);
    }
    for (const metric of METRICS) if (kpis && Object.prototype.hasOwnProperty.call(kpis, metric)) {
      const rule = kpis[metric];
      if (rule) {
        if (!hasService(links, SERVICE[metric]!)) throw bad('Ce service n’est pas confié à votre agence');
        if (rule.roles.some((role) => !kpiRoles(metric).includes(role))) throw bad('Rôle incompatible avec ce service');
        alerts[metric] = { threshold: rule.threshold, roles: [...new Set(rule.roles)] };
      } else delete alerts[metric];
    }
    await ctx.db.tx(async (db) => {
      await setSetting(db, 'agencyNotify', saved, ctx.session.profile.id);
      if (kpis) await setSetting(db, 'agencyKpis', alerts, ctx.session.profile.id);
    });
    return { ok: true };
  }),
};

/** Only active profiles in the agency that match its current role policy receive lines. */
export async function tellAgency(ctx: Ctx, agencyId: number, event: keyof typeof TITLES, url: string, options: {
  people?: readonly number[];
  body?: string;
  count?: number;
  except?: number;
}): Promise<void> {
  try {
    const local = ctx.shop?.id === agencyId && ctx.shop.kind === 'agency';
    const target = local ? null : (await ctx.t?.platform.query(
      "SELECT schema_name FROM platform.shops WHERE id = $1 AND kind = 'agency' AND status = 'active'",
      [agencyId],
    ))?.[0];
    if (!local && !target) return;
    const db = local ? ctx.db : ctx.t!.shop(String(target!.schema_name));
    const group = GROUP[event];
    const saved = await getSetting(db, 'agencyNotify');
    const roles = cleanRoles(group, saved[group] ?? DEFAULTS[group]);
    if (!roles.length) return;
    const rows = await db.query(
      `SELECT id FROM profiles WHERE active AND agency_id IS NULL AND roles && $1::text[]
        AND ($2::bigint[] IS NULL OR id = ANY($2))`,
      [roles, options.people ?? null],
    );
    const kind: BellKind = event === 'order' ? 'order' : event === 'follow' ? 'alert' : 'info';
    await ringBell(
      { ...ctx, db, emit: (e) => ctx.emit({ ...e, shop: agencyId, privateInbox: true }) },
      rows.map((p) => num(p.id)).filter((id) => id !== options.except),
      (lang) => ({ kind, title: TITLES[event][lang], body: options.body ?? '', url }),
      { count: options.count },
    );
  } catch {
    // As with the seller bell, a notification failure cannot undo a completed business action.
  }
}

/** Resolve the seller-side assignee through the stable agency profile mapping and current order ownership. */
export async function tellAgencyAssignments(ctx: Ctx, area: 'conf' | 'follow', given: Map<number, number[]>, actor?: number | null) {
  if (!ctx.t || !ctx.shop || (ctx.shop.kind ?? 'store') !== 'store') return;
  const assignee = area === 'conf' ? 'agent_id' : 'follow_agent_id';
  const agency = area === 'conf' ? 'conf_agency_id' : 'follow_agency_id';
  for (const [profile, orders] of given) {
    if (profile === actor) continue;
    const row = (await ctx.db.query(
      `SELECT p.agency_id, p.agency_profile_id, count(*) AS n
         FROM orders o JOIN profiles p ON p.id = o.${assignee} AND p.agency_id = o.${agency}
         JOIN platform.agency_links l ON l.agency_id = p.agency_id AND l.store_id = $3 AND l.status = 'active'
        WHERE p.id = $1 AND o.id = ANY($2) AND p.active AND p.agency_profile_id IS NOT NULL
        GROUP BY p.agency_id, p.agency_profile_id`,
      [profile, orders, ctx.shop.id],
    ))[0];
    if (!row) continue;
    await tellAgency(ctx, num(row.agency_id), area === 'conf' ? 'order' : 'follow',
      area === 'conf' ? '#/confirmation/nouvelles' : '#/suivi/enlivraison',
      { people: [num(row.agency_profile_id)], count: num(row.n) });
  }
}

const DELEGATED = {
  confirmation: { event: 'delegatedConfirmation', url: '#/confirmation/nouvelles' },
  suivi: { event: 'delegatedFollow', url: '#/suivi/enlivraison' },
  sav: { event: 'delegatedSav', url: '#/sav/tickets' },
} as const;

/** The seller chooses which service events to send to the agency. The agency chooses the recipients by role. */
export async function tellDelegated(ctx: Ctx, agency: number, task: keyof typeof DELEGATED, order: number) {
  const shop = ctx.shop?.id;
  if (!ctx.t || !shop) return;
  const link = (await ctx.t.platform.query(
    `SELECT id FROM platform.agency_links WHERE agency_id = $1 AND store_id = $2 AND status = 'active'
      AND tasks ? $3 AND agency_alerts ? $3`,
    [agency, shop, task],
  ))[0];
  if (!link) return;
  const people = (await ctx.db.query(
    `SELECT agency_profile_id FROM profiles WHERE active AND agency_id = $1 AND $2 = ANY(roles)
      AND (agency_products IS NULL OR (SELECT product_id FROM order_items WHERE order_id = $3 ORDER BY id LIMIT 1) = ANY(agency_products))`,
    [agency, task, order],
  )).map((p) => num(p.agency_profile_id)).filter(Boolean);
  await tellAgency(ctx, agency, DELEGATED[task].event, DELEGATED[task].url, { people });
}

const KPI_TITLE = {
  order: { en: 'Confirmation backlog', fr: 'Commandes en attente de confirmation', ar: 'طلبات بانتظار التأكيد' },
  follow: { en: 'Open delivery alerts', fr: 'Alertes de suivi ouvertes', ar: 'تنبيهات التوصيل المفتوحة' },
  sav: { en: 'Open after-sales tickets', fr: 'Tickets SAV ouverts', ar: 'تذاكر خدمة ما بعد البيع المفتوحة' },
};

/** Check thresholds per eligible user and alert once per crossing. Counts follow that user's seller and product access. */
export async function runAgencyKpis(ctx: Ctx) {
  if (!ctx.t || ctx.shop?.kind !== 'agency') return;
  const rules = await getSetting(ctx.db, 'agencyKpis');
  const previous = await getSetting(ctx.db, 'agencyKpiState');
  if (!Object.keys(rules).length) {
    if (Object.keys(previous).length) await setSetting(ctx.db, 'agencyKpiState', {});
    return;
  }
  const links = await agencyLinks(ctx);
  const next: Record<string, boolean> = {};
  const agency = ctx.shop.id;
  const profiles = await ctx.db.query('SELECT id, roles FROM profiles WHERE active AND agency_id IS NULL ORDER BY id');
  for (const metric of METRICS) {
    const rule = rules[metric];
    const task = SERVICE[metric]!;
    if (!rule || !hasService(links, task)) continue;
    const counts = new Map<number, number>();
    for (const link of links.filter((row) => Array.isArray(row.tasks) && row.tasks.includes(task))) {
      const db = ctx.t.shop(String(link.schema_name));
      const mapped = await db.query(
        'SELECT id, agency_profile_id, agency_products FROM profiles WHERE active AND agency_id = $1 AND $2 = ANY(roles)',
        [agency, task],
      );
      for (const profile of profiles) {
        const id = num(profile.id);
        if (!rule.roles.some((role) => kpiRoles(metric).includes(role as AgencyRole) && profile.roles.includes(role))) continue;
        const local = mapped.find((row) => num(row.agency_profile_id) === id);
        if (!local) continue;
        const lead = profile.roles.includes('admin') || profile.roles.includes('agent_manager');
        const peopleScope = lead ? null : num(local.id);
        const rows = metric === 'sav'
          ? await db.query(
              `SELECT count(*) AS n FROM complaints c
               WHERE c.sav_agency_id = $1 AND c.status NOT IN ('closed', 'resolved')
                 AND ($2::bigint IS NULL OR c.assigned_to = $2)
                 AND ($3::bigint[] IS NULL OR (SELECT product_id FROM order_items WHERE order_id = c.order_id ORDER BY id LIMIT 1) = ANY($3))`,
              [agency, peopleScope, local.agency_products ?? null],
            )
          : await db.query(
              `SELECT count(*) AS n FROM orders WHERE ${metric === 'order' ? 'conf_agency_id' : 'follow_agency_id'} = $1
                 AND ${metric === 'order' ? 'conf_status' : 'follow_status'} = ANY($4)
                 AND ($2::bigint IS NULL OR ${metric === 'order' ? 'agent_id' : 'follow_agent_id'} = $2)
                 AND ($3::bigint[] IS NULL OR route_product_id = ANY($3))`,
              [agency, peopleScope, local.agency_products ?? null, metric === 'order' ? CONF_TODO : ['alert']],
            );
        counts.set(id, (counts.get(id) ?? 0) + num(rows[0]?.n));
      }
    }
    for (const [profile, count] of counts) {
      if (count < rule.threshold) continue;
      const key = `${metric}:${profile}:${rule.threshold}`;
      if (!previous[key]) {
        await ringBell(ctx, [profile], (lang) => ({
          kind: 'info', title: KPI_TITLE[metric][lang], body: `${count} ≥ ${rule.threshold}`,
          url: metric === 'order' ? '#/confirmation/nouvelles' : metric === 'follow' ? '#/suivi/alertes' : '#/sav/tickets',
        }));
      }
      next[key] = true;
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(previous)) await setSetting(ctx.db, 'agencyKpiState', next);
}
