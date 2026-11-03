import type { Db } from '../db';
import { num } from '../db';

/** Extra demo data for the catalog feature (runs after the main demo seed). users: demo account key → id. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const day = 86_400_000;
  const at = (d: number) => new Date(now - d * day).toISOString();
  const depot = users.depot ?? null;
  const wh = await db.query('SELECT id FROM warehouses ORDER BY is_default DESC, id');
  const main = num(wh[0]?.id);
  const second = wh[1] ? num(wh[1].id) : null;
  const vars = await db.query('SELECT v.id, p.name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE NOT p.is_service ORDER BY v.id');
  // A few realistic movements: arrivals, an inventory count, a breakage, a transfer to the second depot.
  for (const [k, v] of vars.entries()) {
    const vid = num(v.id);
    if (k % 3 === 0) {
      await db.query(`INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, user_id, note, created_at) VALUES ($1,$2,$3,'entry',$4,'Arrivage fournisseur',$5)`, [vid, main, 10 + (k % 4) * 5, depot, at(20 - k / 2)]);
      await db.query('UPDATE stock SET qty = qty + $3 WHERE variant_id = $1 AND warehouse_id = $2', [vid, main, 10 + (k % 4) * 5]);
    }
    if (k % 5 === 1) {
      await db.query(`INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, user_id, note, created_at) VALUES ($1,$2,-1,'loss',$3,'Carton abîmé',$4)`, [vid, main, depot, at(9 - k / 4)]);
      await db.query('UPDATE stock SET qty = qty - 1 WHERE variant_id = $1 AND warehouse_id = $2', [vid, main]);
    }
    if (second && k % 4 === 2) {
      const q = 3 + (k % 3);
      await db.query(`INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, user_id, note, created_at) VALUES ($1,$2,$3,'transfer_out',$4,'Vers Oran',$5), ($1,$6,$7,'transfer_in',$4,'Vers Oran',$5)`, [vid, main, -q, depot, at(6), second, q]);
      await db.query('UPDATE stock SET qty = qty - $3 WHERE variant_id = $1 AND warehouse_id = $2', [vid, main, q]);
      await db.query(`INSERT INTO stock (variant_id, warehouse_id, qty, alert_qty) VALUES ($1,$2,$3,2) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty`, [vid, second, q]);
    }
  }
  await seedGuides(db, users, now);
}

const TO_FILL = '[À compléter]';
/** Sales guides (Guide de vente) for five products (one size: the small size guide; the bodies: one line per size); the others have none, as in a real shop starting. */
const GUIDES: Record<string, object> = {
  'PX-CHA': {
    brief: 'Chaise haute qui grandit avec l’enfant : chaise de repas de 6 mois à 3 ans, puis petite chaise et table jusqu’à 6 ans.',
    strengths: [
      'Un seul achat de 6 mois à 6 ans : elle devient une chaise et une table d’enfant.',
      'Harnais 5 points et tablette amovible : l’enfant est bien tenu pendant le repas.',
      'Assise en simili-cuir qui se nettoie d’un coup d’éponge.',
      'Les pieds se démontent sans outil pour la ranger.',
    ],
    faq: [
      { q: 'À partir de quel âge ?', a: 'Dès que bébé tient assis tout seul, vers 6 mois. Chaise haute jusqu’à 3 ans, puis chaise et table jusqu’à 6 ans.' },
      { q: 'Elle a une ceinture ?', a: 'Oui, un harnais 5 points réglable.' },
      { q: 'Poids maximum ?', a: '15 kg en chaise haute, 25 kg en petite chaise.' },
      { q: 'Elle arrive montée ?', a: 'Non, en carton. Le montage prend 10 minutes avec la notice en images.' },
      { q: 'Il y a une garantie ?', a: TO_FILL },
    ],
    doubts: [
      { q: '« Ghali »', a: 'Elle remplace trois achats : chaise haute, petite chaise et table. Et vous payez seulement à la livraison.' },
      { q: '« Nkhamem m3a rajli »', a: 'Bien sûr. Je vous la garde jusqu’à demain soir, sans engagement, et vous payez seulement à la livraison.' },
      { q: '« Kayna f l’hanout b rkhis »', a: 'Regardez si elle devient une table et si elle a le harnais 5 points : la nôtre a les deux.' },
    ],
    upsell: 'Le tapis pour les moments de jeu, le sac pour les sorties.',
    upsellSkus: ['PX-TAP', 'PX-SAC'],
    never: ['Qu’elle est en bois : elle est en métal et plastique.', 'Une livraison en 24 h partout : le délai dépend de la wilaya.', 'Un cadeau ou une remise qui n’existe pas.'],
    fit: { age: '6 mois à 3 ans (puis petite chaise jusqu’à 6 ans)', weight: 'jusqu’à 15 kg (25 kg en petite chaise)', measures: '' },
  },
  'PX-POU': {
    brief: 'Poussette légère qui se plie d’une main, pour les sorties et les voyages, de 6 mois à 3 ans.',
    strengths: ['Se plie d’une main en 3 secondes et tient debout pliée.', 'Légère : 6 kg, facile à porter dans les escaliers.', 'Dossier inclinable pour la sieste et capote contre le soleil.', 'Entre dans le coffre de toutes les voitures.'],
    faq: [
      { q: 'Dès quel âge ?', a: 'Dès 6 mois, quand bébé tient assis, jusqu’à 15 kg (environ 3 ans).' },
      { q: 'Quelles couleurs ?', a: 'Gris, bleu marine et rose.' },
      { q: 'Les roues ont des freins ?', a: 'Oui, un frein au pied sur les deux roues arrière.' },
      { q: 'Elle passe en cabine dans l’avion ?', a: 'Pliée, elle a la taille d’un bagage cabine, mais chaque compagnie a ses règles : il faut lui demander.' },
    ],
    doubts: [
      { q: '« Ghali »', a: 'Elle sert jusqu’à 3 ans et se plie d’une main : c’est celle qu’on garde. Vous payez à la livraison.' },
      { q: '« Nkhaf ma tkounch solide »', a: 'Le châssis est en aluminium et elle porte jusqu’à 15 kg.' },
    ],
    upsell: 'Il s’accroche à la poignée de la poussette.',
    upsellSkus: ['PX-SAC'],
    never: ['Qu’elle convient dès la naissance : c’est à partir de 6 mois.', 'Qu’elle est acceptée en cabine par toutes les compagnies.'],
    fit: { age: '6 mois à 3 ans', weight: 'jusqu’à 15 kg', measures: '' },
  },
  'PX-LIT': {
    brief: 'Lit de voyage pliant avec son matelas, de la naissance à 3 ans, qui se range dans son sac.',
    strengths: ['Se monte et se plie en une minute.', 'Côtés en filet : bébé respire bien et on le voit.', 'Matelas et sac de transport fournis.'],
    faq: [
      { q: 'Le matelas est inclus ?', a: 'Oui, un matelas pliant est dans le sac.' },
      { q: 'Jusqu’à quel âge ?', a: 'De la naissance à 3 ans, ou 15 kg.' },
      { q: 'Quelle taille ?', a: '120 × 60 cm ouvert.' },
      { q: 'Il y a une garantie ?', a: TO_FILL },
    ],
    doubts: [{ q: '« Ghali »', a: 'Il sert chez les grands-parents et en vacances, jusqu’à 3 ans.' }],
    upsell: '',
    never: ['Qu’il sert de parc pour un enfant qui grimpe : à 3 ans ou 15 kg, on arrête.'],
    fit: { age: 'de la naissance à 3 ans', weight: 'jusqu’à 15 kg', measures: '120 × 60 cm ouvert' },
  },
  // a product with sizes: customers give the baby's age and weight, the size guide says which size
  'PX-BOD': {
    brief: 'Lot de 6 bodies en coton doux, à pressions, pour tous les jours.',
    strengths: ['100 % coton : doux sur la peau de bébé.', 'Pressions à l’entrejambe : on change la couche sans tout enlever.', '6 bodies : de quoi tenir la semaine.'],
    faq: [
      { q: 'Quelle taille choisir ?', a: 'Dites-moi l’âge et le poids de bébé : je vous donne la bonne taille (voir le guide des tailles).' },
      { q: 'Ça passe en machine ?', a: 'Oui, à 40 °C.' },
      { q: 'Quelles couleurs ?', a: 'Blanc, gris et bleu ciel dans le lot.' },
    ],
    doubts: [{ q: '« Ghali »', a: 'Le lot revient à environ 530 DA le body, en coton.' }],
    upsell: 'Pour un cadeau de naissance complet.',
    upsellSkus: ['PX-ENS'],
    never: ['Que le coton est bio : ce n’est pas écrit.'],
    sizes: [
      { size: 'Naissance', age: '0 à 1 mois', weight: '2,5 à 4 kg' },
      { size: '3 mois', age: '1 à 3 mois', weight: '4 à 6 kg' },
      { size: '6 mois', age: '3 à 6 mois', weight: '6 à 8 kg' },
      { size: '12 mois', age: '6 à 12 mois', weight: '8 à 10 kg' },
    ],
  },
  'PX-BIB': {
    brief: 'Biberon de 260 ml avec valve anti-colique, pour les bébés qui avalent de l’air en buvant.',
    strengths: ['La valve fait entrer l’air sans bulles dans le lait : moins de coliques.', 'Tétine souple en silicone, débit lent.', 'Sans BPA.'],
    faq: [
      { q: 'Pour quel âge ?', a: 'Dès la naissance : la tétine débit lent est fournie.' },
      { q: 'Il passe au stérilisateur ?', a: 'Oui, au stérilisateur et à l’eau bouillante.' },
    ],
    doubts: [{ q: '« Ghali »', a: 'Le pack de 3 revient à 1 300 DA le biberon (3 900 DA les trois).' }],
    upsell: 'Proposez le pack de 3 (3 900 DA) : un biberon pendant qu’un autre sèche.',
    never: ['Que les coliques disparaissent à coup sûr : le biberon aide, il ne guérit pas.'],
    fit: { age: 'dès la naissance', weight: '', measures: '260 ml' },
  },
};

/** Two products made with a « Taille » option (their variants are its values), so their guide has a size guide. */
const SIZE_OPTIONS: Record<string, string[]> = { 'PX-BOD': ['Naissance', '3 mois', '6 mois', '12 mois'], 'PX-ENS': ['0-3 mois', '3-6 mois', '6-12 mois'] };

async function seedGuides(db: Db, users: Record<string, number>, now: number) {
  const by = users.admin ?? users.depot ?? null;
  for (const [sku, values] of Object.entries(SIZE_OPTIONS)) await db.query('UPDATE products SET options = $2 WHERE sku = $1', [sku, JSON.stringify([{ name: 'Taille', values }])]);
  const ids = new Map((await db.query('SELECT id, sku FROM products')).map((r: any) => [String(r.sku), num(r.id)] as const));
  let k = 0;
  for (const [sku, { upsellSkus, ...guide }] of Object.entries(GUIDES) as [string, any][]) {
    const id = ids.get(sku);
    if (!id) continue;
    const upsellIds = ((upsellSkus ?? []) as string[]).map((x) => ids.get(x)).filter((x): x is number => !!x);
    await db.query(
      `INSERT INTO product_guides (product_id, guide, updated_by, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (product_id) DO NOTHING`,
      [id, JSON.stringify({ upsellIds, sizes: [], fit: { age: '', weight: '', measures: '' }, ...guide }), by, new Date(now - (7 - k++) * 86_400_000).toISOString()],
    );
  }
}
