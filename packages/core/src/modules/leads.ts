// Marketing › Formulaires: the lead forms of the shop's Facebook and Instagram ads (Meta Lead Ads) become orders.
// Meta calls Pilotix's webhook when someone sends a form (the Page's « leadgen » field); Pilotix reads the lead with the
// Page's key (ctx.server.dellal 'lead'), understands its answers (name, phone, wilaya, commune, address, colour or size,
// quantity, in French, Arabic or English) and creates the order in Confirmation like any other: the agents call to
// confirm it. What Pilotix cannot do alone waits on the page: a wilaya written another way (« Bordj »: which one?), a
// number too short, a form without its product yet, a customer who already ordered these last days (a duplicate). A
// safety net reads the forms' last leads every few minutes (a webhook Meta did not send).
import { COMMUNES, normalizePhone, WILAYAS, WILAYAS_AR } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, makeSession, notFound, proc } from '../rpc';
import { dellalSettings, findPlace, strip } from './dellal';
import { officialCommune } from './coverage';
import { createOrder, noOrderAccess } from './orders';
import { profileById } from './users';
import { linkedPage } from './social';

export const LEAD_STATUSES = ['created', 'fix', 'waiting', 'dup', 'error', 'test', 'ignored', 'busy'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
/** Why a lead waits: its phone or wilaya to fix, its form without a product, switched off or « Garder à vérifier ». */
export type LeadProblem = 'phone' | 'wilaya' | 'product' | 'off' | 'review' | null;
export const LEAD_FILTERS = ['all', 'created', 'fix', 'waiting', 'dup'] as const;
export type LeadFilter = (typeof LEAD_FILTERS)[number];
/** What a question of a form gives: the customer's name (or first / last name), phone, wilaya… or a note for the agent. */
export const LEAD_FIELDS = ['name', 'first', 'last', 'phone', 'wilaya', 'commune', 'address', 'variant', 'qty', 'note', 'ignore'] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];
export const FORM_MODES = ['order', 'review'] as const;

/** A lead as Meta gives it (dellal-server.ts 'lead' / 'formLeads'). */
export interface MetaLead {
  id: string;
  createdTime?: string | number | null;
  formId?: string | null;
  adId?: string | null;
  adName?: string | null;
  adsetId?: string | null;
  campaignId?: string | null;
  platform?: string | null;
  isOrganic?: boolean;
  fieldData: { name: string; values: string[] }[];
}
/** A form as Meta gives it (dellal-server.ts 'leadForms' / 'leadForm'). */
export interface MetaForm {
  id: string;
  name: string;
  status: string;
  questions: { key: string; label: string; type: string }[];
}
export interface LeadAnswer {
  key: string;
  label: string;
  value: string;
}

// ---------------------------------------------------------------- understanding the answers
const has = (hay: string, re: RegExp) => re.test(hay);
/** Arabic and Persian digits → 0-9. */
const digits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
/** A key Meta made from a question (« quelle_est_votre_wilaya_? ») read as words. */
const words = (s: string) => String(s ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** What a question asks, from Meta's type, its key or its words (French, Arabic, English, Darija in Latin letters). */
export function fieldOf(q: { key: string; label?: string | null; type?: string | null }): LeadField {
  const type = String(q.type ?? '').toUpperCase();
  const byType: Record<string, LeadField> = { FULL_NAME: 'name', FIRST_NAME: 'first', LAST_NAME: 'last', PHONE: 'phone', STATE: 'wilaya', PROVINCE: 'wilaya', CITY: 'commune', STREET_ADDRESS: 'address' };
  if (byType[type]) return byType[type];
  const raw = `${words(q.key)} ${words(q.label ?? '')}`.toLowerCase();
  const t = `${strip(raw)} ${raw}`;
  if (has(t, /e-?mail|courriel|بريد/)) return 'note';
  // « Adresse (rue, numéro) » is an address, not a phone
  if (has(t, /adresse|address|عنوان|العنوان/)) return 'address';
  if (has(t, /phone|t[ée]l[ée]phone|\btel\b|num[eé]ro|mobile|portable|whats ?app|هاتف|الهاتف|رقم|جوال|نقال/)) return 'phone';
  if (has(t, /wilaya|wilaia|willaya|ولاية|الولاية|\bstate\b|province|r[ée]gion/)) return 'wilaya';
  if (has(t, /commune|baladia|baladiya|بلدية|البلدية|\bville\b|\bcity\b|da[iï]ra|دائرة|localit[ée]|مدينة/)) return 'commune';
  if (has(t, /quartier|\bcit[ée]\b|الحي/)) return 'address';
  if (has(t, /quantit[ée]|quantity|\bqty\b|nombre|combien|عدد|كمية|الكمية/)) return 'qty';
  if (has(t, /couleur|colou?r|taille|\bsize\b|pointure|mod[eè]le|\bmodel\b|اللون|لون|مقاس|المقاس|الحجم|النوع/)) return 'variant';
  if (has(t, /nom (et|&) pr[ée]nom|pr[ée]nom (et|&) nom|full ?name|nom complet|الاسم الكامل|الاسم و اللقب|الاسم واللقب/)) return 'name';
  if (has(t, /first ?name|pr[ée]nom/)) return 'first';
  if (has(t, /last ?name|surname|nom de famille|اللقب/)) return 'last';
  if (has(t, /\bnom\b|\bname\b|اسم|إسم|الاسم/)) return 'name';
  return 'note';
}

/** The answers of one lead, put in the order's words. `mapping`: what the shop chose for a question (none: Pilotix guesses). */
export function readAnswers(answers: LeadAnswer[], mapping: Record<string, LeadField> = {}) {
  const got: Record<LeadField, string[]> = { name: [], first: [], last: [], phone: [], wilaya: [], commune: [], address: [], variant: [], qty: [], note: [], ignore: [] };
  const notes: string[] = [];
  for (const a of answers) {
    const v = String(a.value ?? '').trim();
    if (!v) continue;
    const f = mapping[a.key] ?? fieldOf(a);
    got[f].push(v);
    if (f === 'note' || f === 'variant') notes.push(`${a.label || words(a.key)} : ${v}`.slice(0, 240));
  }
  const name = (got.name[0] ?? [got.first[0], got.last[0]].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
  const q = Number(digits(got.qty[0] ?? '').match(/\d{1,3}/)?.[0] ?? 1);
  return {
    name,
    phone: got.phone[0] ?? '',
    wilaya: words(got.wilaya[0] ?? ''),
    commune: words(got.commune[0] ?? ''),
    address: got.address.join(', '),
    variant: words(got.variant.join(' ')),
    qty: Number.isInteger(q) && q >= 1 ? Math.min(q, 50) : 1,
    notes,
  };
}

/** Levenshtein distance, stopped early (two short words). */
function close(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** A wilaya written in Arabic (« ولاية سطيف »): its number. */
function arabicWilaya(text: string): number | null {
  const all = Object.entries(WILAYAS_AR)
    .map(([k, v]) => [Number(k), String(v)] as const)
    .filter(([, v]) => v)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [id, ar] of all) if (text.includes(ar)) return id;
  return null;
}

/** The wilayas a word could be (« Bordj » → 34 and 50; « Bourdj Bou » → 34), best first, 4 at most; `all`: every word matched. */
function candidatesOf(text: string): { ids: number[]; all: boolean } {
  const ws = strip(words(text))
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter((w) => w.length >= 3 && !['wilaya', 'ولاية', 'الولاية'].includes(w));
  if (!ws.length) return { ids: [], all: false };
  const scored = WILAYAS.map((name, i) => {
    const nameWords = [...strip(name).split(/[^a-z0-9]+/), ...strip(String(WILAYAS_AR[i + 1] ?? '')).split(/\s+/)].filter((w) => w.length >= 2);
    const score = ws.filter((w) => nameWords.some((nw) => nw.startsWith(w) || (w.length >= 4 && nw.length >= 4 && close(w, nw, w.length >= 7 ? 2 : 1)))).length;
    return { id: i + 1, score };
  }).filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  return { ids: scored.filter((x) => x.score === best).slice(0, 4).map((x) => x.id), all: best === ws.length };
}
export const wilayaCandidates = (text: string): number[] => candidatesOf(text).ids;

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A wilaya named in a wilaya's answer: its number (« 16 », « wilaya 16 »), its name (French or Arabic). Not a commune. */
function wilayaNamed(text: string): number | null {
  const t = strip(words(text));
  if (!t) return null;
  const ws = WILAYAS.map((w, i) => ({ id: i + 1, k: strip(w) })).sort((a, b) => b.k.length - a.k.length);
  for (const w of ws) if (new RegExp(`(^|[^a-z])${reEsc(w.k)}($|[^a-z])`).test(t)) return w.id;
  const ar = arabicWilaya(text);
  if (ar) return ar;
  // « wilaya 16 », « 06 - Bgayet »: its number
  const n = Number(digits(t).match(/(?:^|\D)(\d{1,2})(?:\D|$)/)?.[1] ?? 0);
  return n >= 1 && n <= WILAYAS.length ? n : null;
}

/** A commune written another way (« Bab Ezzouar »: Bab Azzouar, by sound): the wilayas it can be in. */
function communeWilayas(text: string): { wilayaId: number; commune: string }[] {
  const out: { wilayaId: number; commune: string }[] = [];
  for (let w = 1; w <= WILAYAS.length; w++) {
    const c = officialCommune(w, text);
    if (c) out.push({ wilayaId: w, commune: c });
  }
  return out;
}

/** The wilayas that have a commune of exactly this name (« Aïn Benian »: Alger and Aïn Defla). */
function sameName(text: string): number[] {
  const k = strip(words(text));
  if (!k) return [];
  return [...new Set(COMMUNES.filter(([, fr, ar]) => strip(fr) === k || (!!ar && ar === text.trim())).map(([w]) => w))];
}

/** Where the customer lives: the wilaya (and commune) Pilotix understood, or the wilayas to choose from. */
export function placeOf(wilaya: string, commune: string, address = ''): { wilayaId: number | null; commune: string | null; candidates: number[]; wrote: string } {
  // a wilaya or a commune named in the text, else a commune written another way, when only one wilaya has it
  const town = (t: string) => {
    if (!t.trim()) return null;
    const p = findPlace(t);
    if (p) return p;
    const s = communeWilayas(t);
    return s.length === 1 ? { wilayaId: s[0].wilayaId, wilaya: WILAYAS[s[0].wilayaId - 1], commune: s[0].commune } : null;
  };
  if (wilaya.trim()) {
    const named = wilayaNamed(wilaya);
    if (named) return { wilayaId: named, commune: commune || null, candidates: [], wrote: wilaya };
    // the start of a name (« Tizi »), a letter wrong (« Tlemcan »): the one wilaya it can be
    const k = candidatesOf(wilaya);
    const at = (id: number, c: string | null) => ({ wilayaId: id, commune: commune || c || null, candidates: [], wrote: wilaya });
    if (k.ids.length === 1 && k.all) return at(k.ids[0], null);
    // a commune written as the wilaya (« Bab Ezzouar »); one that two wilayas have (« Aïn Benian »): the choice
    const twin = sameName(wilaya);
    if (twin.length > 1) return { wilayaId: null, commune: commune || null, candidates: twin.slice(0, 4), wrote: wilaya };
    const own = town(wilaya);
    if (own?.commune && (!k.ids.length || !k.all || k.ids.includes(own.wilayaId))) return at(own.wilayaId, own.commune);
    if (k.ids.length === 1) return at(k.ids[0], null);
    // the commune says which one (« Bordj » and « Medjana »: Bordj Bou Arréridj)
    const byCommune = town(commune);
    if (byCommune?.commune && (!k.ids.length || k.ids.includes(byCommune.wilayaId))) return at(byCommune.wilayaId, null);
    return { wilayaId: null, commune: commune || null, candidates: k.ids, wrote: wilaya };
  }
  // the form does not ask the wilaya: the commune or the address may say it
  for (const t of [commune, address]) {
    const twin = sameName(t);
    if (twin.length > 1) return { wilayaId: null, commune: commune || null, candidates: twin.slice(0, 4), wrote: t };
    const p = town(t);
    if (p) return { wilayaId: p.wilayaId, commune: commune || p.commune || null, candidates: [], wrote: '' };
  }
  // « Aïn Benian »: a commune of Alger and of Aïn Defla
  const both = commune ? communeWilayas(commune).map((x) => x.wilayaId) : [];
  return { wilayaId: null, commune: commune || null, candidates: (both.length ? both : commune ? wilayaCandidates(commune) : []).slice(0, 4), wrote: commune };
}

/** A variant named in the answer (« rose », « taille 2 »): one of the product's, else null. */
export function variantOf(vars: { id: number; title: string }[], text: string | null | undefined): number | null {
  const t = strip(words(text ?? ''));
  if (!t || !vars.length) return null;
  const exact = vars.find((v) => strip(v.title) === t);
  if (exact) return exact.id;
  const ws = t.split(/[^a-z0-9؀-ۿ]+/).filter((w) => w.length >= 2);
  const hit = vars.filter((v) => {
    const k = strip(v.title);
    return k && (t.includes(k) || ws.some((w) => w.length >= 3 && k.split(/[^a-z0-9؀-ۿ]+/).includes(w)));
  });
  return hit.length === 1 ? hit[0].id : null;
}

/** Meta's created_time: unix seconds (webhook) or « 2026-11-03T14:32:00+0000 » (Graph). */
export function metaTime(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : null;
  }
  const t = Date.parse(String(v).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A test lead from Meta's testing tool (« <test lead: dummy data for full_name> »). */
const isTestLead = (l: MetaLead) => l.fieldData.some((f) => f.values.some((v) => /test lead|dummy data/i.test(String(v))));

// ---------------------------------------------------------------- forms
const LEAD_ROLES = ['marketer'] as const;
const id = z.number().int().positive();
const me = (ctx: Ctx) => ctx.session.profile.id;

async function pageIdOf(db: Db): Promise<string> {
  return (await linkedPage(db))?.pageId || (await dellalSettings(db)).messengerPageId || '';
}

async function saveForm(db: Db, f: MetaForm, pageId: string) {
  await db.query(
    `INSERT INTO lead_forms (form_id, page_id, name, meta_status, questions, synced_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (form_id) DO UPDATE SET page_id = CASE WHEN EXCLUDED.page_id <> '' THEN EXCLUDED.page_id ELSE lead_forms.page_id END,
       name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE lead_forms.name END, meta_status = EXCLUDED.meta_status,
       questions = CASE WHEN jsonb_array_length(EXCLUDED.questions) > 0 THEN EXCLUDED.questions ELSE lead_forms.questions END, synced_at = now()`,
    [f.id, pageId, f.name.slice(0, 200), (f.status || 'ACTIVE').toUpperCase().slice(0, 20), JSON.stringify(f.questions.slice(0, 40))],
  );
}

/** The form a lead came from: known, else read from Meta once (a form made after the last reading), else its number. */
async function ensureForm(ctx: Ctx, formId: string, pageId: string): Promise<any> {
  const db = ctx.db;
  const have = (await db.query(`SELECT * FROM lead_forms WHERE form_id = $1`, [formId]))[0];
  if (have) return have;
  let f: MetaForm = { id: formId, name: '', status: 'ACTIVE', questions: [] };
  if (ctx.server?.dellal) f = { ...f, ...(((await ctx.server.dellal('leadForm', { formId }, ctx).catch(() => null)) as MetaForm | null) ?? {}) };
  await db.query(`INSERT INTO lead_forms (form_id, page_id, name, meta_status, questions) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (form_id) DO NOTHING`, [
    formId,
    pageId,
    (f.name || `Formulaire ${formId}`).slice(0, 200),
    (f.status || 'ACTIVE').toUpperCase().slice(0, 20),
    JSON.stringify((f.questions ?? []).slice(0, 40)),
  ]);
  return (await db.query(`SELECT * FROM lead_forms WHERE form_id = $1`, [formId]))[0];
}

/** Meta's list of the Page's forms, saved (new ones are on, without a product: their first leads wait for it). */
export async function syncForms(ctx: Ctx): Promise<{ forms: number; demo?: boolean }> {
  if (!ctx.server?.dellal) return { forms: num((await ctx.db.query(`SELECT count(*)::int AS n FROM lead_forms`))[0]?.n), demo: true };
  const pageId = await pageIdOf(ctx.db);
  if (!pageId) throw bad('Aucune page Facebook liée : reliez-la dans Pilot AI › Comptes.');
  const list = (await ctx.server.dellal('leadForms', { pageId }, ctx)) as MetaForm[];
  for (const f of list) await saveForm(ctx.db, f, pageId);
  await noteSync(ctx, { forms: list.length });
  return { forms: list.length };
}
/** When the forms were last read (the safety net reads them again 6 hours later, also after a refusal). */
async function noteSync(ctx: Ctx, v: Record<string, unknown>) {
  await ctx.db.query(`INSERT INTO settings (key, value) VALUES ('leads_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ at: new Date(ctx.now()).toISOString(), ...v })]);
}

// ---------------------------------------------------------------- one lead
/** Stores a lead Meta gave (once: the same lead twice is stored once) and turns it into an order when it can. */
export async function ingestLead(ctx: Ctx, l: MetaLead, hook: { formId?: string; pageId?: string; adsetId?: string | null; createdTime?: unknown } = {}): Promise<{ leadId: number; status: LeadStatus } | null> {
  const db = ctx.db;
  if ((await db.query(`SELECT 1 FROM leads WHERE leadgen_id = $1`, [l.id])).length) return null;
  const formId = String(l.formId || hook.formId || '');
  const pageId = hook.pageId || (await pageIdOf(db));
  const form = formId ? await ensureForm(ctx, formId, pageId) : null;
  const qs: { key: string; label: string }[] = Array.isArray(form?.questions) ? form.questions : [];
  const answers: LeadAnswer[] = l.fieldData
    .filter((f) => f.name)
    .slice(0, 40)
    .map((f) => ({ key: f.name.slice(0, 120), label: (qs.find((q) => q.key === f.name)?.label || '').slice(0, 200), value: f.values.map(String).join(', ').slice(0, 500) }));
  const a = readAnswers(answers, (form?.mapping ?? {}) as Record<string, LeadField>);
  const place = placeOf(a.wilaya, a.commune, a.address);
  const phone = normalizePhone(a.phone) ?? a.phone.slice(0, 40);
  const at = metaTime(l.createdTime) ?? metaTime(hook.createdTime) ?? new Date(ctx.now()).toISOString();
  const r = await db.query(
    `INSERT INTO leads (leadgen_id, form_id, page_id, platform, ad_id, adset_id, campaign_id, ad_name, answers, customer_name, phone, wilaya_id,
       commune, address, qty, variant_text, note, wrote, candidates, is_test, received_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (leadgen_id) DO NOTHING RETURNING id`,
    [
      l.id,
      formId,
      pageId,
      l.platform === 'ig' ? 'ig' : 'fb',
      l.adId || null,
      l.adsetId || hook.adsetId || null,
      l.campaignId || null,
      l.adName ? String(l.adName).slice(0, 200) : null,
      JSON.stringify(answers),
      a.name.slice(0, 120) || null,
      phone || null,
      place.wilayaId,
      place.commune?.slice(0, 120) ?? null,
      a.address.slice(0, 300) || null,
      a.qty,
      a.variant.slice(0, 200) || null,
      a.notes.join('\n').slice(0, 1000) || null,
      place.wrote.slice(0, 120) || null,
      place.candidates.length ? JSON.stringify(place.candidates) : null,
      isTestLead(l),
      new Date(ctx.now()).toISOString(),
      at,
    ],
  );
  if (!r[0]) return null;
  if (formId) await db.query(`UPDATE lead_forms SET last_lead_at = GREATEST(COALESCE(last_lead_at, $2), $2) WHERE form_id = $1`, [formId, at]);
  const leadId = num(r[0].id);
  return { leadId, status: await processLead(ctx, leadId) };
}

async function setLead(db: Db, leadId: number, status: LeadStatus, v: { problem?: LeadProblem; orderId?: number | null; dupOrderId?: number | null; error?: string | null; by?: number | null } = {}) {
  await db.query(
    `UPDATE leads SET status = $2, problem = $3, order_id = COALESCE($4, order_id), dup_order_id = $5, error = $6,
       handled_by = COALESCE($7, handled_by), handled_at = CASE WHEN $7::bigint IS NULL THEN handled_at ELSE now() END WHERE id = $1`,
    [leadId, status, v.problem ?? null, v.orderId ?? null, v.dupOrderId ?? null, v.error ?? null, v.by ?? null],
  );
}

/**
 * Turns one lead into an order when nothing is missing; else says what is (its phone, its wilaya, its form's product, a
 * duplicate…). `force`: a duplicate, an ignored lead or a form « Garder à vérifier » becomes an order too.
 */
export async function processLead(ctx: Ctx, leadId: number, o: { force?: boolean; by?: number | null } = {}): Promise<LeadStatus> {
  const db = ctx.db;
  // two runs never take the same lead: the first one marks it
  const mine = (await db.query(`UPDATE leads SET status = 'busy', busy_at = now() WHERE id = $1 AND status NOT IN ('created', 'busy') RETURNING *`, [leadId]))[0];
  if (!mine) return ((await db.query(`SELECT status FROM leads WHERE id = $1`, [leadId]))[0]?.status ?? 'created') as LeadStatus;
  const lead = mine;
  const by = o.by ?? null;
  try {
    if (lead.is_test) return await done('test');
    if (!(Array.isArray(lead.answers) && lead.answers.length)) return await done('error', { error: lead.error || 'Facebook n’a pas donné les réponses de ce lead.' });
    const phone = normalizePhone(String(lead.phone ?? ''));
    if (!phone) return await done('fix', { problem: 'phone' });
    if (!lead.wilaya_id) return await done('fix', { problem: 'wilaya' });
    const form = (await db.query(`SELECT * FROM lead_forms WHERE form_id = $1`, [lead.form_id]))[0];
    if (!form?.product_id) return await done('waiting', { problem: 'product' });
    if (!form.active && !o.force) return await done('waiting', { problem: 'off' });
    if (form.mode === 'review' && !o.force) return await done('waiting', { problem: 'review' });
    if (!o.force && num(form.dup_days) > 0) {
      const since = new Date(ctx.now() - num(form.dup_days) * 86_400_000).toISOString();
      const d = (await db.query(`SELECT id FROM orders WHERE phone = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 1`, [phone, since]))[0];
      if (d) return await done('dup', { dupOrderId: num(d.id) });
    }
    const vars = (await db.query(`SELECT id, title FROM product_variants WHERE product_id = $1 AND active ORDER BY id`, [form.product_id])).map((v: any) => ({ id: num(v.id), title: String(v.title ?? '') }));
    const named = numOrNull(lead.variant_id) ?? variantOf(vars, lead.variant_text);
    const variantId = named ?? (vars.some((v) => v.id === num(form.variant_id)) ? num(form.variant_id) : (vars[0]?.id ?? null));
    const guessed = !named && !form.variant_id && vars.length > 1;
    const ig = lead.platform === 'ig';
    const utm: Record<string, string> = { utm_source: ig ? 'instagram' : 'facebook', utm_medium: 'lead_form', form_id: String(lead.form_id), leadgen_id: String(lead.leadgen_id) };
    for (const [k, v] of [['ad_id', lead.ad_id], ['adset_id', lead.adset_id], ['campaign_id', lead.campaign_id], ['utm_content', lead.ad_name]] as const) if (v) utm[k] = String(v).slice(0, 200);
    const formName = String(form.name || 'Formulaire');
    const order = await createOrder(
      await orderCtx(ctx),
      {
        customerName: String(lead.customer_name ?? '').trim().length >= 2 ? String(lead.customer_name).trim().slice(0, 120) : 'Client',
        phone,
        wilayaId: num(lead.wilaya_id),
        commune: String(lead.commune ?? ''),
        address: String(lead.address ?? ''),
        isStopdesk: false,
        channel: ig ? 'instagram' : 'facebook',
        source: `Formulaire « ${formName} »`.slice(0, 120),
        items: [{ productId: num(form.product_id), variantId, qty: Math.max(1, num(lead.qty) || 1) }],
        discount: 0,
        customerNote: lead.note ? String(lead.note).slice(0, 1000) : null,
        internalNote: [`Formulaire de pub « ${formName} »`, lead.ad_name && `pub « ${lead.ad_name} »`, guessed && 'variante à confirmer', lead.candidates && 'wilaya choisie à la main']
          .filter(Boolean)
          .join(' · ')
          .slice(0, 1000),
        confirm: false,
        isExchange: false,
        utm,
      },
      db,
      // typed by someone the shop has not verified: never renames a customer; the anti-fraud check as for a landing page
      { untrusted: true, guard: 'check', adsetId: lead.adset_id ? String(lead.adset_id) : null },
    );
    return await done('created', { orderId: order.id });
  } catch (e: any) {
    return await done('error', { error: String(e?.message ?? e).slice(0, 300) });
  }

  async function done(status: LeadStatus, v: { problem?: LeadProblem; orderId?: number; dupOrderId?: number; error?: string } = {}): Promise<LeadStatus> {
    await setLead(db, leadId, status, { ...v, by });
    return status;
  }
}

/** The order is made by Pilotix (the shop's first administrator, as for Meta's webhook): a marketer does not open orders. */
async function orderCtx(ctx: Ctx): Promise<Ctx> {
  if (!noOrderAccess(ctx)) return ctx;
  const r = (await ctx.db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  const p = r ? await profileById(ctx.db, num(r.id)) : null;
  if (!p) throw forbidden('Aucun administrateur actif dans cette boutique');
  return { ...ctx, session: makeSession(p) };
}

/** Leads waiting for their form (its product, switched on, « Créer la commande »): they go again once it changes. */
async function runWaiting(ctx: Ctx, formId: string, by: number | null): Promise<Record<string, number>> {
  const rows = await ctx.db.query(
    `SELECT l.id FROM leads l JOIN lead_forms f ON f.form_id = l.form_id
     WHERE l.form_id = $1 AND l.status = 'waiting' AND (l.problem IN ('product', 'off') OR (l.problem = 'review' AND f.mode = 'order'))
       AND l.created_at > $2 ORDER BY l.created_at LIMIT 200`,
    [formId, new Date(ctx.now() - 30 * 86_400_000).toISOString()],
  );
  const out: Record<string, number> = { created: 0, fix: 0, waiting: 0, dup: 0, error: 0 };
  for (const r of rows) {
    const s = await processLead(ctx, num(r.id), { by });
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------- the safety net
/** Every few minutes: the forms' leads Meta did not send (and the forms list, every 6 hours). */
export async function catchUpLeads(ctx: Ctx): Promise<{ found: number; forms: number; errors: string[]; skipped?: string }> {
  if (!ctx.server?.dellal) return { found: 0, forms: 0, errors: [], skipped: 'preview' };
  const db = ctx.db;
  if (!(await pageIdOf(db))) return { found: 0, forms: 0, errors: [], skipped: 'Aucune page Facebook liée' };
  const errors: string[] = [];
  const last = (await db.query(`SELECT value->>'at' AS at FROM settings WHERE key = 'leads_sync'`))[0]?.at;
  if (!last || ctx.now() - Date.parse(last) > 6 * 3_600_000)
    await syncForms(ctx).catch(async (e) => {
      const why = String(e?.message ?? e).slice(0, 200);
      errors.push(why);
      await noteSync(ctx, { error: why });
    });
  // the forms that run: a lead these 30 days, or found these 7 days (Meta counts each question: not the old ones)
  const recent = (days: number) => new Date(ctx.now() - days * 86_400_000).toISOString();
  const forms = await db.query(
    `SELECT form_id, last_lead_at FROM lead_forms WHERE meta_status = 'ACTIVE' AND (last_lead_at > $1 OR created_at > $2)
     ORDER BY last_lead_at DESC NULLS LAST, id DESC LIMIT 15`,
    [recent(30), recent(7)],
  );
  const floor = ctx.now() - 2 * 86_400_000;
  let found = 0;
  for (const f of forms) {
    const since = Math.max(floor, f.last_lead_at ? Date.parse(iso(f.last_lead_at)) - 3_600_000 : floor);
    try {
      const list = (await ctx.server.dellal('formLeads', { formId: String(f.form_id), since: Math.floor(since / 1000) }, ctx)) as MetaLead[];
      for (const l of list) if (await ingestLead(ctx, l, { formId: String(f.form_id) })) found++;
    } catch (e: any) {
      errors.push(String(e?.message ?? e).slice(0, 200));
    }
  }
  // a run stopped in the middle of a lead: it is tried again
  await db.query(`UPDATE leads SET status = 'error', error = 'Interrompu : réessayez.' WHERE status = 'busy' AND busy_at < $1`, [new Date(ctx.now() - 15 * 60_000).toISOString()]);
  return { found, forms: forms.length, errors: [...new Set(errors)].slice(0, 5) };
}

// ---------------------------------------------------------------- reading the page
const FILTER_SQL: Record<LeadFilter, string> = {
  all: 'true',
  created: `l.status = 'created'`,
  fix: `l.status IN ('fix', 'error')`,
  waiting: `l.status = 'waiting'`,
  dup: `l.status = 'dup'`,
};

/** Midnight in Algeria (UTC+1), today. */
const algeriaMidnight = (now: number) => new Date(Math.floor((now + 3_600_000) / 86_400_000) * 86_400_000 - 3_600_000).toISOString();

function toLead(r: any) {
  const candidates: number[] = Array.isArray(r.candidates) ? r.candidates.map(Number).filter((n: number) => n >= 1 && n <= WILAYAS.length) : [];
  return {
    id: num(r.id),
    at: iso(r.created_at),
    platform: (r.platform === 'ig' ? 'ig' : 'fb') as 'fb' | 'ig',
    name: (r.customer_name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    wilayaId: numOrNull(r.wilaya_id),
    commune: (r.commune as string | null) ?? null,
    product: (r.order_item as string | null) ?? (r.product_name ? `${r.product_name}${r.variant_text ? ` · ${r.variant_text}` : ''}` : ((r.variant_text as string | null) ?? null)),
    qty: num(r.qty) || 1,
    formId: String(r.form_id ?? ''),
    formName: (r.form_name as string | null) ?? null,
    adName: (r.ad_name as string | null) ?? null,
    status: r.status as LeadStatus,
    problem: (r.problem as LeadProblem) ?? null,
    wrote: (r.wrote as string | null) ?? null,
    candidates: candidates.map((n) => ({ id: n, name: WILAYAS[n - 1] })),
    order: r.order_id ? { id: num(r.order_id), ref: String(r.order_ref ?? '') } : null,
    dup: r.dup_order_id ? { id: num(r.dup_order_id), ref: String(r.dup_ref ?? ''), at: isoOrNull(r.dup_at) } : null,
    error: (r.error as string | null) ?? null,
    isTest: !!r.is_test,
    answers: (Array.isArray(r.answers) ? r.answers : []) as LeadAnswer[],
    handledAt: isoOrNull(r.handled_at),
  };
}

const LEAD_FROM = `FROM leads l LEFT JOIN lead_forms f ON f.form_id = l.form_id LEFT JOIN products p ON p.id = f.product_id
  LEFT JOIN orders o ON o.id = l.order_id LEFT JOIN orders d ON d.id = l.dup_order_id`;
const LEAD_COLS = `l.*, f.name AS form_name, p.name AS product_name, o.ref AS order_ref, d.ref AS dup_ref, d.created_at AS dup_at,
  (SELECT i.name || COALESCE(' · ' || NULLIF(i.variant_title, ''), '') FROM order_items i WHERE i.order_id = l.order_id ORDER BY i.id LIMIT 1) AS order_item`;

async function leadOf(db: Db, leadId: number) {
  const r = (await db.query(`SELECT ${LEAD_COLS} ${LEAD_FROM} WHERE l.id = $1`, [leadId]))[0];
  if (!r) throw notFound('Lead introuvable');
  return toLead(r);
}

export const leadsProcs = {
  /** The leads, newest first, with the counts of the chips, today's result and the forms (Marketing › Formulaires). */
  'leads.feed': proc(
    [...LEAD_ROLES],
    z.object({ filter: z.enum(LEAD_FILTERS).default('all'), formId: z.string().max(40).optional(), limit: z.number().int().min(1).max(500).default(40) }),
    async (ctx, i) => {
      const db = ctx.db;
      const p: unknown[] = [];
      const formW = i.formId ? `l.form_id = $${p.push(i.formId)}` : 'true';
      const rows = await db.query(`SELECT ${LEAD_COLS} ${LEAD_FROM} WHERE ${formW} AND ${FILTER_SQL[i.filter]} AND l.status <> 'busy' ORDER BY l.created_at DESC, l.id DESC LIMIT ${i.limit}`, p);
      const k = (
        await db.query(
          `SELECT count(*)::int AS n_all, count(*) FILTER (WHERE status = 'created')::int AS created, count(*) FILTER (WHERE status IN ('fix', 'error'))::int AS fix,
                  count(*) FILTER (WHERE status = 'waiting')::int AS waiting, count(*) FILTER (WHERE status = 'dup')::int AS dup
           FROM leads l WHERE ${formW} AND status <> 'busy'`,
          p,
        )
      )[0];
      const today = (
        await db.query(`SELECT count(*)::int AS leads, count(*) FILTER (WHERE status = 'created')::int AS orders FROM leads WHERE created_at >= $1 AND NOT is_test`, [algeriaMidnight(ctx.now())])
      )[0];
      const forms = await db.query(
        `SELECT f.*, p.name AS product_name, v.title AS variant_title,
           (SELECT count(*) FROM leads l WHERE l.form_id = f.form_id)::int AS leads,
           (SELECT count(*) FROM leads l WHERE l.form_id = f.form_id AND l.status = 'waiting')::int AS waiting
         FROM lead_forms f LEFT JOIN products p ON p.id = f.product_id LEFT JOIN product_variants v ON v.id = f.variant_id
         WHERE f.meta_status <> 'DELETED' ORDER BY (f.meta_status = 'ACTIVE') DESC, f.last_lead_at DESC NULLS LAST, f.id DESC LIMIT 100`,
      );
      const page = await linkedPage(db);
      const counts = { all: num(k.n_all), created: num(k.created), fix: num(k.fix), waiting: num(k.waiting), dup: num(k.dup) };
      const shown = counts[i.filter];
      return {
        rows: rows.map(toLead),
        counts,
        more: Math.max(0, shown - rows.length),
        today: { leads: num(today.leads), orders: num(today.orders) },
        forms: forms.map((f: any) => ({
          id: num(f.id),
          formId: String(f.form_id),
          name: String(f.name ?? ''),
          metaStatus: String(f.meta_status ?? 'ACTIVE'),
          active: !!f.active,
          mode: (f.mode === 'review' ? 'review' : 'order') as (typeof FORM_MODES)[number],
          dupDays: num(f.dup_days),
          productId: numOrNull(f.product_id),
          productName: (f.product_name as string | null) ?? null,
          variantId: numOrNull(f.variant_id),
          variantTitle: (f.variant_title as string | null) ?? null,
          leads: num(f.leads),
          waiting: num(f.waiting),
          lastLeadAt: isoOrNull(f.last_lead_at),
          questions: (Array.isArray(f.questions) ? f.questions : []) as { key: string; label: string; type: string }[],
        })),
        page: page ? { name: page.name } : null,
        live: !!ctx.server?.dellal,
      };
    },
  ),

  /** The products a form can sell (the « Choisir le produit » window). */
  'leads.products': proc([...LEAD_ROLES], z.object({}), async (ctx) => {
    const prods = await ctx.db.query(`SELECT id, name, price FROM products WHERE active AND NOT is_service AND archived_at IS NULL ORDER BY lower(name), id LIMIT 500`);
    const vars = prods.length
      ? await ctx.db.query(`SELECT id, product_id, title FROM product_variants WHERE product_id = ANY($1) AND active ORDER BY id`, [prods.map((p: any) => num(p.id))])
      : [];
    return prods.map((p: any) => ({
      id: num(p.id),
      name: String(p.name),
      price: num(p.price),
      variants: vars.filter((v: any) => num(v.product_id) === num(p.id)).map((v: any) => ({ id: num(v.id), title: String(v.title ?? '') })),
    }));
  }),

  /** « Actualiser »: the Page's forms, read from Meta again. */
  'leads.syncForms': proc([...LEAD_ROLES], z.object({}), (ctx) => syncForms(ctx)),

  /** A form's settings: its product (and colour or size), on or off, « Créer la commande » or « Garder à vérifier », duplicates. */
  'leads.formSave': proc(
    [...LEAD_ROLES],
    z.object({ id, productId: id.nullable(), variantId: id.nullable().default(null), active: z.boolean(), mode: z.enum(FORM_MODES).default('order'), dupDays: z.number().int().min(0).max(60).default(7) }),
    async (ctx, i) => {
      const db = ctx.db;
      const f = (await db.query(`SELECT * FROM lead_forms WHERE id = $1`, [i.id]))[0];
      if (!f) throw notFound('Formulaire introuvable');
      if (i.productId) {
        const p = (await db.query(`SELECT id FROM products WHERE id = $1 AND active AND NOT is_service AND archived_at IS NULL`, [i.productId]))[0];
        if (!p) throw bad('Ce produit n’est pas actif');
      }
      if (i.variantId) {
        const v = (await db.query(`SELECT id FROM product_variants WHERE id = $1 AND product_id = $2 AND active`, [i.variantId, i.productId]))[0];
        if (!v) throw bad('Cette variante n’est pas de ce produit');
      }
      await db.query(`UPDATE lead_forms SET product_id = $2, variant_id = $3, active = $4, mode = $5, dup_days = $6 WHERE id = $1`, [
        i.id,
        i.productId,
        i.productId ? i.variantId : null,
        i.active,
        i.mode,
        i.dupDays,
      ]);
      const ran = i.productId && i.active ? await runWaiting(ctx, String(f.form_id), me(ctx)) : {};
      return { ok: true, ...ran };
    },
  ),

  /** « Corriger »: the wilaya (and commune) or the number the customer wrote, then the order. */
  'leads.fix': proc(
    [...LEAD_ROLES],
    z.object({ id, wilayaId: z.number().int().min(1).max(WILAYAS.length).optional(), commune: z.string().trim().max(120).optional(), phone: z.string().trim().max(30).optional() }),
    async (ctx, i) => {
      const db = ctx.db;
      const l = (await db.query(`SELECT status FROM leads WHERE id = $1`, [i.id]))[0];
      if (!l) throw notFound('Lead introuvable');
      if (l.status === 'created') throw bad('Ce lead est déjà une commande');
      if (i.phone !== undefined) {
        const p = normalizePhone(i.phone);
        if (!p) throw bad('Numéro de téléphone algérien invalide');
        await db.query(`UPDATE leads SET phone = $2 WHERE id = $1`, [i.id, p]);
      }
      if (i.wilayaId) await db.query(`UPDATE leads SET wilaya_id = $2 WHERE id = $1`, [i.id, i.wilayaId]);
      if (i.commune !== undefined) await db.query(`UPDATE leads SET commune = $2 WHERE id = $1`, [i.id, i.commune || null]);
      await processLead(ctx, i.id, { by: me(ctx) });
      return leadOf(db, i.id);
    },
  ),

  /** « Créer quand même »: a duplicate, a lead of a form « Garder à vérifier », an ignored lead or one that failed. */
  'leads.create': proc([...LEAD_ROLES], z.object({ id }), async (ctx, i) => {
    await processLead(ctx, i.id, { force: true, by: me(ctx) });
    return leadOf(ctx.db, i.id);
  }),

  /** « Ignorer »: no order (a test, a joke, someone who already called). */
  'leads.ignore': proc([...LEAD_ROLES], z.object({ id }), async (ctx, i) => {
    const r = await ctx.db.query(`UPDATE leads SET status = 'ignored', problem = NULL, handled_by = $2, handled_at = now() WHERE id = $1 AND status NOT IN ('created', 'busy') RETURNING id`, [i.id, me(ctx)]);
    if (!r[0]) throw bad('Ce lead est déjà une commande');
    return leadOf(ctx.db, i.id);
  }),

  /** « Réessayer »: a lead Facebook would not give (read again), or one whose order was refused. */
  'leads.retry': proc([...LEAD_ROLES], z.object({ id }), async (ctx, i) => {
    const db = ctx.db;
    const l = (await db.query(`SELECT * FROM leads WHERE id = $1`, [i.id]))[0];
    if (!l) throw notFound('Lead introuvable');
    if (!(Array.isArray(l.answers) && l.answers.length) && ctx.server?.dellal) {
      const raw = (await ctx.server.dellal('lead', { leadgenId: String(l.leadgen_id) }, ctx)) as MetaLead;
      // read again: stored as if it came now (the old row goes; the same lead number stays)
      await db.query(`DELETE FROM leads WHERE id = $1 AND status NOT IN ('created', 'busy')`, [i.id]);
      const r = await ingestLead(ctx, raw, { formId: String(l.form_id), pageId: String(l.page_id), adsetId: l.adset_id, createdTime: iso(l.created_at) });
      return r ? leadOf(db, r.leadId) : leadOf(db, i.id);
    }
    await processLead(ctx, i.id, { by: me(ctx) });
    return leadOf(db, i.id);
  }),

  /** Meta's webhook: a form was sent. The lead is read from Meta with the Page's key and stored (system only). */
  'leads.receive': proc(
    [],
    z.object({
      leadgenId: z.string().regex(/^\d{1,30}$/),
      formId: z.string().max(40).default(''),
      pageId: z.string().max(40).default(''),
      adId: z.string().max(40).nullable().optional(),
      adsetId: z.string().max(40).nullable().optional(),
      createdTime: z.number().int().nullable().optional(),
    }),
    async (ctx, i) => {
      if (!ctx.server?.dellal) return null;
      const db = ctx.db;
      if ((await db.query(`SELECT 1 FROM leads WHERE leadgen_id = $1`, [i.leadgenId])).length) return null;
      let raw: MetaLead;
      try {
        raw = (await ctx.server.dellal('lead', { leadgenId: i.leadgenId }, ctx)) as MetaLead;
      } catch (e: any) {
        // Facebook would not give it (a permission missing, the Page's key…): it waits on the page with the reason
        if (i.formId) await ensureForm(ctx, i.formId, i.pageId);
        const r = await db.query(
          `INSERT INTO leads (leadgen_id, form_id, page_id, ad_id, adset_id, status, error, received_at, created_at) VALUES ($1,$2,$3,$4,$5,'error',$6,$7,$8)
           ON CONFLICT (leadgen_id) DO NOTHING RETURNING id`,
          [i.leadgenId, i.formId, i.pageId, i.adId ?? null, i.adsetId ?? null, String(e?.message ?? e).slice(0, 300), new Date(ctx.now()).toISOString(), metaTime(i.createdTime) ?? new Date(ctx.now()).toISOString()],
        );
        return r[0] ? { leadId: num(r[0].id), status: 'error' as LeadStatus } : null;
      }
      return ingestLead(ctx, { ...raw, adId: raw.adId ?? i.adId ?? null }, { formId: i.formId, pageId: i.pageId, adsetId: i.adsetId ?? null, createdTime: i.createdTime });
    },
  ),

  /** The safety net (every 10 minutes, and the cron hook): the forms' leads Meta did not send. */
  'leads.catchUp': proc([], z.object({}), (ctx) => catchUpLeads(ctx)),
};
