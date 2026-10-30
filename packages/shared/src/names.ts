// Is the customer a woman? Guessed from the first word of the name, among common Algerian women's first names
// (Latin and Arabic letters, the usual spellings). Unknown names say no: the order is given as usual.
const FEMALE_LATIN = `
amina amine? aicha aisha aïcha aichouche asma asmaa assia assya amel amal amira anissa ahlam afaf affaf akila amani
bouchra badia bahia baya basma besma bochra chahinez chaima chaimaa chafia chahrazed chahra chiraz chirine cherifa
dalila djamila djazia dounia douaa dounya dihia damia dyhia
farida fatima fatiha fatma fatna faiza fella feriel ferial fadila fadhila fairouz fayrouz fouzia faten fatiha
ghania ghizlane hafsa hayet hayat hadjer hajar hanane hanan hassiba houria houda hind hiba hadda hamida hasna hania hadia
imane iman ines inès ilhem ilham ibtissem ibtissam ikram imene israa isra
kahina karima kenza khadidja khadija kheira khaoula khawla katia kamila kawther kaouther kaltoum keltoum
lamia latifa leila leïla lila lina lydia linda lamis louiza lilia loubna lynda lyna
malika manel manal maroua marwa meriem meriam maryam mounia mouna nadia nadjet nabila naima nawel naouel nesrine
nesrin nora nouria nassima narimane nihad nihal nina nadjia nabiha
ouarda wahiba wafa wafaa warda widad yasmine yasmina yamina yousra yusra
rachida radia rania rym rim rima razika rahma rokia rokaya rosa ryma rabia
sabrina safia saida salima samia samira sana sarah sara selma siham sihem soraya souad souhila sonia sabah salma
samah selwa sofia sofiane? soumia soumaya sylia sihame
thiziri tinhinane tassadit taous thilleli thinhinane tounes
yamina zahra zakia zineb zina zohra zoulikha zahia zoubida zakia zehor zeyneb
`;

const FEMALE_ARABIC = `
أمينة عائشة اسماء أسماء آسيا آمال أمال أميرة أنيسة أحلام عفاف عقيلة أماني بشرى بهية باية بسمة شيماء شهرزاد شيراز شيرين
دليلة جميلة جازية دنيا دعاء فريدة فاطمة فتيحة فاطنة فايزة فلة فريال فضيلة فيروز فوزية غانية حفصة حياة هاجر حنان حسيبة حورية
هدى هند هبة إيمان ايمان إيناس ايناس إلهام الهام ابتسام إكرام كهينة كريمة كنزة خديجة خيرة خولة كاتيا كوثر كلثوم لمياء لطيفة
ليلى ليلة لينة ليديا لويزة ليليا لبنى مليكة منال مروة مريم مونية منى نادية نجاة نبيلة نعيمة نوال نسرين نورة نورية نسيمة
وردة وهيبة وفاء وداد وئام ياسمين ياسمينة يمينة يسرى رشيدة راضية رانية ريم رزيقة رحمة رقية ربيعة صبرينة صفية سعيدة سليمة سامية
سميرة سناء سارة سلمى سهام ثريا سعاد سهيلة صونيا صباح سلوى صوفيا سمية تينهينان تسعديت زهرة زكية زينب زينة زهور زليخة زهية
`;

const words = (s: string) => s.split(/\s+/).map((w) => w.replace(/\?$/, '')).filter((w) => w && !w.endsWith('?'));
// « amine? », « sofiane? »: men's names that look alike, kept out
const LATIN = new Set(words(FEMALE_LATIN).filter((w) => !['amine', 'sofiane'].includes(w)));
const ARABIC = new Set(words(FEMALE_ARABIC));

const plain = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z؀-ۿ]/g, '');

/** A first name that is a woman's (« Mme », « Madame », « السيدة » count too). */
export function isWomanName(name: string | null | undefined): boolean {
  const parts = String(name ?? '')
    .trim()
    .split(/[\s,.;-]+/)
    .filter(Boolean);
  if (!parts.length) return false;
  const first = parts[0].toLowerCase();
  if (['mme', 'madame', 'mlle', 'mademoiselle', 'السيدة', 'الآنسة', 'مدام'].includes(first)) return true;
  // « Oum Ayoub », « أم محمد »
  if (first === 'oum' || first === 'om' || first === 'أم' || first === 'ام') return parts.length > 1;
  return parts.slice(0, 2).some((p) => {
    const w = plain(p);
    return LATIN.has(w) || ARABIC.has(p) || ARABIC.has(w);
  });
}
