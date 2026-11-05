import { WILAYAS } from '@pilotix/shared';
import type { Db } from '../db';
import { num } from '../db';
import type { Ctx } from '../rpc';
import { ingestLead } from '../modules/leads';

const iso = (t: number) => new Date(t).toISOString();

/**
 * Marketing › Formulaires demo: the lead forms of « Bébé Confort DZ »'s ads. Most recent Facebook and Instagram orders
 * came from a form (each one a lead that became its order); a few leads wait for a person, as on a real page: a wilaya
 * written « Bordj » (34 or 50?), a number too short, a form whose product is not chosen yet (3 leads), a customer who
 * already ordered yesterday, and Meta's test lead.
 */
export async function seed(db: Db, _users: Record<string, number>, now: number): Promise<void> {
  const pid = async (sku: string) => num((await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0]?.id) || null;
  const questions = (variant?: string) =>
    JSON.stringify([
      { key: 'full_name', label: 'Nom et prénom', type: 'FULL_NAME' },
      { key: 'phone_number', label: 'Numéro de téléphone', type: 'PHONE' },
      { key: 'wilaya', label: 'Wilaya', type: 'CUSTOM' },
      { key: 'commune', label: 'Commune', type: 'CUSTOM' },
      ...(variant ? [{ key: 'couleur', label: variant, type: 'CUSTOM' }] : []),
    ]);
  const forms = [
    { key: 'lit', id: '771204503310001', name: 'Lit parapluie – Offre spéciale', sku: 'PX-LIT', variant: 'Couleur', active: true },
    { key: 'cha', id: '771204503310002', name: 'Chaise haute – Livraison 58 wilayas', sku: 'PX-CHA', variant: undefined, active: true },
    { key: 'tap', id: '771204503310003', name: 'Tapis d’éveil – Promo novembre', sku: 'PX-TAP', variant: undefined, active: true },
    { key: 'bod', id: '771204503310004', name: 'Lot de bodies – Naissance', sku: 'PX-BOD', variant: 'Taille', active: true },
    { key: 'pou', id: '771204503310005', name: 'Poussette canne – nouveau', sku: null, variant: 'Couleur', active: true },
    { key: 'ech', id: '771204503310006', name: 'Écharpe de portage – ancien', sku: 'PX-ECH', variant: 'Couleur', active: false },
  ] as const;
  const productOf: Record<string, number | null> = {};
  for (const f of forms) {
    const product = f.sku ? await pid(f.sku) : null;
    productOf[f.key] = product;
    await db.query(
      `INSERT INTO lead_forms (form_id, page_id, name, meta_status, questions, product_id, active, mode, synced_at, created_at)
       VALUES ($1, '1029384756', $2, 'ACTIVE', $3, $4, $5, 'order', $6, $7) ON CONFLICT (form_id) DO NOTHING`,
      [f.id, f.name, questions(f.variant), product, f.active, iso(now - 3_600_000), iso(now - 40 * 86_400_000)],
    );
  }
  const formFor = (productId: number) => forms.find((f) => f.active && productOf[f.key] === productId);

  // the Facebook and Instagram orders of the last 3 days: each came from its product's form
  const orders = await db.query(
    `SELECT o.id, o.ref, o.channel, o.customer_name, o.phone, o.wilaya_id, o.commune, o.created_at,
            (SELECT i.product_id FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS product_id,
            (SELECT i.variant_title FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS variant_title
     FROM orders o WHERE o.channel IN ('facebook', 'instagram') AND o.created_at > $1 AND o.created_at < $2
       AND o.source IS NULL AND o.conversation_id IS NULL AND o.conf_status <> 'duplicate'
     ORDER BY o.created_at DESC LIMIT 60`,
    [iso(now - 3 * 86_400_000), iso(now - 30 * 60_000)],
  );
  const ADS: Record<string, string[]> = {
    lit: ['Lit parapluie – vidéo pliage', 'Lit parapluie – carrousel'],
    cha: ['Chaise haute – vidéo repas'],
    tap: ['Tapis d’éveil – réel musique', 'Tapis d’éveil – photo'],
    bod: ['Bodies coton – lot de 6'],
  };
  let n = 0;
  const lead = () => String(1_220_000_000_000_000 + ++n);
  const answers = (name: string, phone: string, wilaya: string, commune: string, variant?: { label: string; value: string } | null) =>
    JSON.stringify([
      { key: 'full_name', label: 'Nom et prénom', value: name },
      { key: 'phone_number', label: 'Numéro de téléphone', value: phone },
      { key: 'wilaya', label: 'Wilaya', value: wilaya },
      { key: 'commune', label: 'Commune', value: commune },
      ...(variant ? [{ key: 'couleur', label: variant.label, value: variant.value }] : []),
    ]);
  for (const o of orders) {
    const f = formFor(num(o.product_id));
    if (!f) continue;
    const ig = o.channel === 'instagram';
    const at = Date.parse(new Date(o.created_at).toISOString()) - 40_000;
    const wilaya = WILAYAS[num(o.wilaya_id) - 1] ?? '';
    const variant = f.variant && o.variant_title ? { label: f.variant, value: String(o.variant_title) } : null;
    const ads = ADS[f.key] ?? [];
    const leadgen = lead();
    await db.query(
      `INSERT INTO leads (leadgen_id, form_id, page_id, platform, ad_id, adset_id, ad_name, answers, customer_name, phone, wilaya_id, commune, qty, variant_text,
         note, status, order_id, received_at, created_at)
       VALUES ($1,$2,'1029384756',$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,'created',$14,$15,$15)`,
      [
        leadgen,
        f.id,
        ig ? 'ig' : 'fb',
        `2384${String(n).padStart(11, '0')}`,
        `2384${String(n % 3).padStart(11, '0')}`,
        ads[n % Math.max(1, ads.length)] ?? null,
        answers(String(o.customer_name), String(o.phone), wilaya, String(o.commune ?? ''), variant),
        o.customer_name,
        o.phone,
        o.wilaya_id,
        o.commune,
        variant?.value ?? null,
        variant ? `${variant.label} : ${variant.value}` : null,
        o.id,
        iso(at),
      ],
    );
    await db.query(`UPDATE orders SET source = $2, utm = $3 WHERE id = $1`, [
      o.id,
      `Formulaire « ${f.name} »`.slice(0, 120),
      JSON.stringify({ utm_source: ig ? 'instagram' : 'facebook', utm_medium: 'lead_form', form_id: f.id, leadgen_id: leadgen }),
    ]);
  }

  // the leads that wait for a person: read as when they come from Meta (ingestLead), so Pilotix finds what is missing
  const ctx = { db, now: () => now, emit: () => {} } as unknown as Ctx;
  const fields = (name: string, phone: string, wilaya: string, commune: string, variant: { label: string; value: string } | null) => [
    { name: 'full_name', values: [name] },
    { name: 'phone_number', values: [phone] },
    { name: 'wilaya', values: [wilaya] },
    { name: 'commune', values: [commune] },
    ...(variant ? [{ name: 'couleur', values: [variant.value] }] : []),
  ];
  type Waiting = { form: string; name: string; phone: string; wilaya: string; commune: string; variant: { label: string; value: string } | null; ago: number; platform: 'fb' | 'ig' };
  const waiting: Waiting[] = [
    { form: 'lit', name: 'Amina Boukhalfa', phone: '0661 34 50 12', wilaya: 'Bordj', commune: 'Cité 20 Août', variant: { label: 'Couleur', value: 'Gris' }, ago: 3, platform: 'fb' },
    { form: 'cha', name: 'Yasmine Ait Ali', phone: '0557 3', wilaya: 'Tizi Ouzou', commune: 'Azazga', variant: null, ago: 11, platform: 'ig' },
    { form: 'pou', name: 'Khaled Mansouri', phone: '0771 22 48 90', wilaya: 'Sétif', commune: 'El Eulma', variant: { label: 'Couleur', value: 'Rose' }, ago: 18, platform: 'fb' },
    { form: 'pou', name: 'Souad Bensaid', phone: '0698 41 07 33', wilaya: 'Oran', commune: 'Bir El Djir', variant: { label: 'Couleur', value: 'Bleu marine' }, ago: 47, platform: 'ig' },
    { form: 'pou', name: 'Hocine Larbi', phone: '0550 18 62 04', wilaya: 'Blida', commune: 'Boufarik', variant: { label: 'Couleur', value: 'Gris' }, ago: 26 * 60, platform: 'fb' },
  ];
  // a customer who already ordered yesterday sends the form again: a duplicate, no second order
  const old = (await db.query(`SELECT phone FROM orders WHERE created_at < $1 AND created_at > $2 AND phone IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [iso(now - 20 * 3_600_000), iso(now - 4 * 86_400_000)]))[0];
  if (old) waiting.push({ form: 'tap', name: 'Nawel Hamdi', phone: String(old.phone), wilaya: 'Alger', commune: 'Bab Ezzouar', variant: null, ago: 33, platform: 'fb' });
  for (const w of waiting) {
    const f = forms.find((x) => x.key === w.form)!;
    await ingestLead(
      ctx,
      {
        id: lead(),
        createdTime: iso(now - w.ago * 60_000),
        formId: f.id,
        adName: ADS[w.form]?.[0] ?? (w.form === 'pou' ? 'Poussette canne – vidéo' : null),
        platform: w.platform,
        fieldData: fields(w.name, w.phone, w.wilaya, w.commune, w.variant),
      },
      { formId: f.id, pageId: '1029384756' },
    );
  }
  // Meta's test lead, two days ago (« Envoyer un lead test » in Meta's tool): it says the connection works, no order
  const dummy = (k: string) => `<test lead: dummy data for ${k}>`;
  await ingestLead(
    ctx,
    { id: lead(), createdTime: iso(now - 2 * 86_400_000 - 5 * 3_600_000), formId: forms[1].id, platform: 'fb', fieldData: fields(dummy('full_name'), dummy('phone_number'), dummy('wilaya'), dummy('commune'), null) },
    { formId: forms[1].id, pageId: '1029384756' },
  );
  // the older form's last leads, before it was switched off
  await db.query(`UPDATE lead_forms f SET last_lead_at = (SELECT max(created_at) FROM leads l WHERE l.form_id = f.form_id)`);
  await db.query(`UPDATE lead_forms SET last_lead_at = $1 WHERE form_id = $2`, [iso(now - 9 * 86_400_000), forms[5].id]);
}
