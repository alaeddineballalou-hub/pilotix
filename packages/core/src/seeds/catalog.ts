import type { Db } from '../db';
import { num } from '../db';
import { cleanGuide, guideSources } from '../modules/guide';

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

/** The demo guides in the other reading languages: each guide's lines in order (modules/guide.ts guideSources). */
const GUIDE_TR: Record<string, { ar: string[]; en: string[] }> = {
  'PX-CHA': {
    ar: [
      "كرسي طعام عالٍ يكبر مع الطفل: كرسي للأكل من 6 أشهر إلى 3 سنوات، ثم كرسي صغير وطاولة حتى 6 سنوات.",
      "من 6 أشهر إلى 3 سنوات (ثم كرسي صغير حتى 6 سنوات)",
      "حتى 15 كغ (25 كغ ككرسي صغير)",
      "شراء واحد من 6 أشهر إلى 6 سنوات: يصبح كرسياً وطاولة للطفل.",
      "حزام بخمس نقاط وصينية قابلة للنزع: الطفل مثبّت جيداً أثناء الأكل.",
      "مقعد من الجلد الصناعي يُنظَّف بمسحة إسفنجة.",
      "الأرجل تُفكّ بدون أدوات لتخزينه.",
      "من أي عمر؟",
      "عندما يجلس الطفل وحده، في حوالي 6 أشهر. كرسي عالٍ حتى 3 سنوات، ثم كرسي وطاولة حتى 6 سنوات.",
      "هل فيه حزام؟",
      "نعم، حزام بخمس نقاط قابل للتعديل.",
      "ما هو الوزن الأقصى؟",
      "15 كغ ككرسي عالٍ، و25 كغ ككرسي صغير.",
      "هل يصل مركّباً؟",
      "لا، يصل في علبة. التركيب يأخذ 10 دقائق مع دليل مصوّر.",
      "هل هناك ضمان؟",
      "« Ghali » (غالي)",
      "يعوّض ثلاث مشتريات: كرسي عالٍ وكرسي صغير وطاولة. وتدفع فقط عند الاستلام.",
      "« Nkhamem m3a rajli » (سأفكر مع زوجي)",
      "بالطبع. أحجزه لك حتى مساء الغد، بدون التزام، وتدفع فقط عند الاستلام.",
      "« Kayna f l’hanout b rkhis » (يوجد في المحل بسعر أرخص)",
      "انظر هل يتحول إلى طاولة وهل فيه حزام بخمس نقاط: كرسينا فيه الاثنان.",
      "البساط لأوقات اللعب، والحقيبة للخرجات.",
      "أنه مصنوع من الخشب: هو من المعدن والبلاستيك.",
      "توصيل في 24 ساعة إلى كل مكان: المدة تتعلق بالولاية.",
      "هدية أو تخفيض غير موجود.",
    ],
    en: [
      "High chair that grows with the child: a feeding chair from 6 months to 3 years, then a small chair and table up to 6 years.",
      "6 months to 3 years (then a small chair up to 6 years)",
      "up to 15 kg (25 kg as a small chair)",
      "One purchase from 6 months to 6 years: it becomes a child’s chair and table.",
      "5-point harness and removable tray: the child is held well during meals.",
      "Faux-leather seat that cleans with one wipe of a sponge.",
      "The legs come off without tools to store it.",
      "From what age?",
      "As soon as baby sits up alone, around 6 months. High chair up to 3 years, then chair and table up to 6 years.",
      "Does it have a belt?",
      "Yes, an adjustable 5-point harness.",
      "Maximum weight?",
      "15 kg as a high chair, 25 kg as a small chair.",
      "Does it come assembled?",
      "No, in a box. Assembly takes 10 minutes with the picture instructions.",
      "Is there a warranty?",
      "« Ghali » (too expensive)",
      "It replaces three purchases: high chair, small chair and table. And you only pay on delivery.",
      "« Nkhamem m3a rajli » (I’ll think about it with my husband)",
      "Of course. I’ll keep it for you until tomorrow evening, with no commitment, and you only pay on delivery.",
      "« Kayna f l’hanout b rkhis » (the shop has it cheaper)",
      "Check whether it turns into a table and has the 5-point harness: ours has both.",
      "The mat for playtime, the bag for outings.",
      "That it is made of wood: it is metal and plastic.",
      "Delivery in 24 h everywhere: the delay depends on the wilaya.",
      "A gift or a discount that does not exist.",
    ],
  },
  'PX-POU': {
    ar: [
      "عربة أطفال خفيفة تُطوى بيد واحدة، للخرجات والسفر، من 6 أشهر إلى 3 سنوات.",
      "من 6 أشهر إلى 3 سنوات",
      "حتى 15 كغ",
      "تُطوى بيد واحدة في 3 ثوانٍ وتقف وحدها وهي مطوية.",
      "خفيفة: 6 كغ، سهلة الحمل في السلالم.",
      "ظهر قابل للإمالة للقيلولة ومظلة ضد الشمس.",
      "تدخل في صندوق كل السيارات.",
      "من أي عمر؟",
      "من 6 أشهر، عندما يجلس الطفل، حتى 15 كغ (حوالي 3 سنوات).",
      "ما هي الألوان؟",
      "رمادي، أزرق داكن ووردي.",
      "هل للعجلات مكابح؟",
      "نعم، مكبح بالرجل على العجلتين الخلفيتين.",
      "هل تُقبل في مقصورة الطائرة؟",
      "وهي مطوية لها حجم حقيبة المقصورة، لكن لكل شركة قواعدها: يجب سؤالها.",
      "« Ghali » (غالي)",
      "تخدم حتى 3 سنوات وتُطوى بيد واحدة: هي التي نحتفظ بها. وتدفع عند الاستلام.",
      "« Nkhaf ma tkounch solide » (أخاف ألا تكون متينة)",
      "الهيكل من الألمنيوم وتحمل حتى 15 كغ.",
      "تُعلَّق بمقبض العربة.",
      "أنها مناسبة منذ الولادة: هي من 6 أشهر.",
      "أنها مقبولة في المقصورة عند كل الشركات.",
    ],
    en: [
      "Light stroller that folds with one hand, for outings and trips, from 6 months to 3 years.",
      "6 months to 3 years",
      "up to 15 kg",
      "Folds with one hand in 3 seconds and stands up when folded.",
      "Light: 6 kg, easy to carry on the stairs.",
      "Reclining back for naps and a hood against the sun.",
      "Fits in the boot of every car.",
      "From what age?",
      "From 6 months, when baby sits up, up to 15 kg (about 3 years).",
      "Which colours?",
      "Grey, navy blue and pink.",
      "Do the wheels have brakes?",
      "Yes, a foot brake on both back wheels.",
      "Can it go in the plane cabin?",
      "Folded, it is the size of a cabin bag, but each airline has its own rules: you need to ask it.",
      "« Ghali » (too expensive)",
      "It lasts until 3 years and folds with one hand: it is the one you keep. You pay on delivery.",
      "« Nkhaf ma tkounch solide » (I’m afraid it isn’t sturdy)",
      "The frame is aluminium and it holds up to 15 kg.",
      "It hooks onto the stroller’s handle.",
      "That it suits newborns: it is from 6 months.",
      "That every airline accepts it in the cabin.",
    ],
  },
  'PX-LIT': {
    ar: [
      "سرير سفر قابل للطي مع فرشته، من الولادة حتى 3 سنوات، يُحفظ في حقيبته.",
      "من الولادة حتى 3 سنوات",
      "حتى 15 كغ",
      "120 × 60 سم مفتوحاً",
      "يُركَّب ويُطوى في دقيقة.",
      "جوانب من الشبك: الطفل يتنفس جيداً ونراه.",
      "الفرشة وحقيبة النقل مرفقتان.",
      "هل الفرشة مرفقة؟",
      "نعم، فرشة قابلة للطي داخل الحقيبة.",
      "حتى أي عمر؟",
      "من الولادة حتى 3 سنوات، أو 15 كغ.",
      "ما هو الحجم؟",
      "120 × 60 سم مفتوحاً.",
      "هل هناك ضمان؟",
      "« Ghali » (غالي)",
      "يخدم عند الأجداد وفي العطل، حتى 3 سنوات.",
      "أنه يصلح كحديقة لعب لطفل يتسلق: عند 3 سنوات أو 15 كغ نتوقف.",
    ],
    en: [
      "Folding travel cot with its mattress, from birth to 3 years, that packs into its bag.",
      "from birth to 3 years",
      "up to 15 kg",
      "120 × 60 cm open",
      "Sets up and folds in one minute.",
      "Mesh sides: baby breathes well and you can see them.",
      "Mattress and carry bag included.",
      "Is the mattress included?",
      "Yes, a folding mattress is in the bag.",
      "Up to what age?",
      "From birth to 3 years, or 15 kg.",
      "What size?",
      "120 × 60 cm open.",
      "Is there a warranty?",
      "« Ghali » (too expensive)",
      "It is used at the grandparents’ and on holiday, up to 3 years.",
      "That it works as a playpen for a child who climbs: at 3 years or 15 kg, you stop.",
    ],
  },
  'PX-BOD': {
    ar: [
      "لوت من 6 بودي من القطن الناعم، بأزرار كبس، لكل يوم.",
      "من 0 إلى 1 شهر",
      "من 2,5 إلى 4 كغ",
      "من 1 إلى 3 أشهر",
      "من 4 إلى 6 كغ",
      "من 3 إلى 6 أشهر",
      "من 6 إلى 8 كغ",
      "من 6 إلى 12 شهراً",
      "من 8 إلى 10 كغ",
      "100 % قطن: ناعم على بشرة الطفل.",
      "أزرار كبس بين الساقين: نغيّر الحفاضة بدون نزع كل شيء.",
      "6 بودي: ما يكفي للأسبوع.",
      "أي مقاس أختار؟",
      "أخبرني بعمر الطفل ووزنه: أعطيك المقاس المناسب (انظر دليل المقاسات).",
      "هل يُغسل في الغسالة؟",
      "نعم، على 40 °C.",
      "ما هي الألوان؟",
      "أبيض ورمادي وأزرق فاتح في اللوت.",
      "« Ghali » (غالي)",
      "اللوت يعود بحوالي 530 DA للبودي، من القطن.",
      "لهدية ولادة كاملة.",
      "أن القطن عضوي: هذا غير مكتوب.",
    ],
    en: [
      "Pack of 6 soft cotton bodysuits, with snaps, for every day.",
      "0 to 1 month",
      "2.5 to 4 kg",
      "1 to 3 months",
      "4 to 6 kg",
      "3 to 6 months",
      "6 to 8 kg",
      "6 to 12 months",
      "8 to 10 kg",
      "100% cotton: soft on baby’s skin.",
      "Snaps between the legs: you change the nappy without taking everything off.",
      "6 bodysuits: enough for the week.",
      "Which size should I take?",
      "Tell me baby’s age and weight: I’ll give you the right size (see the size guide).",
      "Can it go in the washing machine?",
      "Yes, at 40 °C.",
      "Which colours?",
      "White, grey and light blue in the pack.",
      "« Ghali » (too expensive)",
      "The pack comes to about 530 DA per bodysuit, in cotton.",
      "For a complete birth gift.",
      "That the cotton is organic: it is not written.",
    ],
  },
  'PX-BIB': {
    ar: [
      "رضّاعة 260 مل بصمام مضاد للمغص، للرضّع الذين يبلعون الهواء أثناء الشرب.",
      "منذ الولادة",
      "260 مل",
      "الصمام يُدخل الهواء بدون فقاعات في الحليب: مغص أقل.",
      "حلمة لينة من السيليكون، تدفق بطيء.",
      "بدون BPA.",
      "لأي عمر؟",
      "منذ الولادة: الحلمة ذات التدفق البطيء مرفقة.",
      "هل تُعقَّم في جهاز التعقيم؟",
      "نعم، في جهاز التعقيم وفي الماء المغلي.",
      "« Ghali » (غالي)",
      "الحزمة من 3 تعود بـ 1 300 DA للرضّاعة (3 900 DA للثلاث).",
      "اقترح الحزمة من 3 (3 900 DA): رضّاعة بينما تجفّ الأخرى.",
      "أن المغص يختفي بالتأكيد: الرضّاعة تساعد، لا تعالج.",
    ],
    en: [
      "260 ml bottle with an anti-colic valve, for babies who swallow air while drinking.",
      "from birth",
      "260 ml",
      "The valve lets air in without bubbles in the milk: less colic.",
      "Soft silicone teat, slow flow.",
      "BPA free.",
      "For what age?",
      "From birth: the slow-flow teat is included.",
      "Can it go in the steriliser?",
      "Yes, in the steriliser and in boiling water.",
      "« Ghali » (too expensive)",
      "The pack of 3 comes to 1 300 DA per bottle (3 900 DA for the three).",
      "Offer the pack of 3 (3 900 DA): one bottle while another dries.",
      "That the colic will surely go away: the bottle helps, it does not cure.",
    ],
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
    const g = cleanGuide({ ...guide, upsellIds, lang: 'fr' });
    // its Arabic and English (the lines in the guide's order)
    const src = guideSources(g);
    const tr = Object.fromEntries(
      (['ar', 'en'] as const).map((l) => {
        const out = GUIDE_TR[sku]?.[l] ?? [];
        if (out.length !== src.length) throw new Error(`Guide de démo ${sku} : ${src.length} lignes, ${out.length} en ${l}`);
        return [l, Object.fromEntries(src.map((x, n) => [x, out[n]]))];
      }),
    );
    await db.query(
      `INSERT INTO product_guides (product_id, guide, tr, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (product_id) DO NOTHING`,
      [id, JSON.stringify(g), JSON.stringify(tr), by, new Date(now - (7 - k++) * 86_400_000).toISOString()],
    );
  }
}
