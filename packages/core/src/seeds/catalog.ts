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
/** Sales guides (Guide de vente) for four products; the others have none, as in a real shop starting. */
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
    upsell: 'Proposez le tapis d’éveil musical pour les moments de jeu, ou le sac à langer à dos pour les sorties.',
    never: ['Qu’elle est en bois : elle est en métal et plastique.', 'Une livraison en 24 h partout : le délai dépend de la wilaya.', 'Un cadeau ou une remise qui n’existe pas.'],
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
    upsell: 'Proposez le sac à langer à dos : il s’accroche à la poignée de la poussette.',
    never: ['Qu’elle convient dès la naissance : c’est à partir de 6 mois.', 'Qu’elle est acceptée en cabine par toutes les compagnies.'],
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
  },
};

async function seedGuides(db: Db, users: Record<string, number>, now: number) {
  const by = users.admin ?? users.depot ?? null;
  let k = 0;
  for (const [sku, guide] of Object.entries(GUIDES)) {
    const p = (await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0];
    if (!p) continue;
    await db.query(
      `INSERT INTO product_guides (product_id, guide, updated_by, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (product_id) DO NOTHING`,
      [num(p.id), JSON.stringify(guide), by, new Date(now - (6 - k++) * 86_400_000).toISOString()],
    );
  }
}
