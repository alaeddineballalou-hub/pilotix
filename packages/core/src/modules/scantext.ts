// The depot scanner's answers in the worker's language (French, English, Arabic). The French text is the reference;
// a key missing in a language falls back to French.
export type ScanLang = 'fr' | 'en' | 'ar';
type Text = Record<ScanLang, string>;

const T: Record<string, Text> = {
  // « Expédier »
  already: {
    fr: 'Déjà dispatchée{at} (statut : {status}).',
    en: 'Already dispatched{at} (status: {status}).',
    ar: 'أُرسل من قبل{at} (الحالة: {status}).',
  },
  alreadyFix: {
    fr: 'Double scan ou étiquette en double : mettez ce colis de côté.',
    en: 'Double scan or duplicate label: put this parcel aside.',
    ar: 'مسح مرتين أو ملصق مكرر: ضع هذا الطرد جانباً.',
  },
  notConfirmed: {
    fr: 'Commande « {conf} » : elle ne doit pas partir.',
    en: 'Order “{conf}”: it must not leave.',
    ar: 'الطلبية «{conf}»: يجب ألا تخرج.',
  },
  notConfirmedFix: {
    fr: 'Ne pas expédier. Remettez les produits en place.',
    en: 'Do not send. Put the products back on the shelf.',
    ar: 'لا ترسلها. أرجع المنتجات إلى مكانها.',
  },
  cancelled: { fr: 'Livraison annulée.', en: 'Delivery cancelled.', ar: 'التوصيل ملغى.' },
  dontSend: { fr: 'Ne pas expédier.', en: 'Do not send.', ar: 'لا ترسلها.' },
  noCompany: { fr: 'Aucune société ni livreur choisi.', en: 'No delivery company or livreur chosen.', ar: 'لم تُختر شركة توصيل ولا موزّع.' },
  noCompanyFix: {
    fr: 'Choisissez la société ou le livreur dans la commande, puis scannez de nouveau.',
    en: 'Choose the company or the livreur in the order, then scan again.',
    ar: 'اختر الشركة أو الموزّع في الطلبية، ثم امسح من جديد.',
  },
  notSent: {
    fr: 'Pas encore envoyée à {company} : l’étiquette Pilotix ne suffit pas.',
    en: 'Not sent to {company} yet: the Pilotix label is not enough.',
    ar: 'لم تُرسل بعد إلى {company}: ملصق Pilotix لا يكفي.',
  },
  notSentFix: {
    fr: 'Envoyez-la d’abord à la société, puis collez l’étiquette qu’elle donne.',
    en: 'Send it to the company first, then stick the label it gives.',
    ar: 'أرسلها أولاً إلى الشركة، ثم الصق الملصق الذي تعطيه.',
  },
  replaced: {
    fr: 'Étiquette Pilotix remplacée : la commande a été envoyée à {company} avec son propre suivi.',
    en: 'Pilotix label replaced: the order was sent to {company} with its own tracking number.',
    ar: 'ملصق Pilotix استُبدل: أُرسلت الطلبية إلى {company} برقم تتبع خاص بها.',
  },
  replacedFix: {
    fr: 'Collez l’étiquette de la société {tracking} et scannez-la.',
    en: 'Stick the company’s label {tracking} and scan it.',
    ar: 'الصق ملصق الشركة {tracking} وامسحه.',
  },
  returnLabel: {
    fr: 'Étiquette de retour de l’échange : elle sert au retour de l’ancien produit.',
    en: 'Exchange return label: it is for bringing the old product back.',
    ar: 'ملصق إرجاع التبديل: هو لإرجاع المنتج القديم.',
  },
  returnLabelFix: {
    fr: 'Scannez l’étiquette du nouveau colis ({code}).',
    en: 'Scan the new parcel’s label ({code}).',
    ar: 'امسح ملصق الطرد الجديد ({code}).',
  },
  notPrepared: {
    fr: 'Pas encore préparée (statut : {status}).',
    en: 'Not prepared yet (status: {status}).',
    ar: 'لم تُحضّر بعد (الحالة: {status}).',
  },
  notPreparedFix: {
    fr: 'Préparez-la et marquez-la « Préparée » avant de la remettre.',
    en: 'Prepare it and mark it “Prepared” before handing it over.',
    ar: 'حضّرها وعلّمها «محضّرة» قبل تسليمها.',
  },
  alertCancel: {
    fr: '{ref} est annulée : ce colis ne part pas. Rendez-le au responsable du dépôt.',
    en: '{ref} is cancelled: this parcel does not leave. Give it to the depot manager.',
    ar: '{ref} ملغاة: هذا الطرد لا يخرج. سلّمه لمسؤول المخزن.',
  },
  alertEdit: {
    fr: '{ref} a été modifiée après sa préparation : alerte rouge ouverte. Le colis ne part pas avant qu’elle soit réglée.',
    en: '{ref} was changed after packing: red alert open. The parcel does not leave until it is fixed.',
    ar: '{ref} عُدّلت بعد تحضيرها: إنذار أحمر مفتوح. الطرد لا يخرج قبل حلّه.',
  },
  alertFix: {
    fr: 'Mettez ce colis de côté. Le responsable du dépôt règle l’alerte rouge (scan de l’ancienne étiquette).',
    en: 'Put this parcel aside. The depot manager fixes the red alert (scan of the old label).',
    ar: 'ضع هذا الطرد جانباً. مسؤول المخزن يحلّ الإنذار الأحمر (مسح الملصق القديم).',
  },
  okDispatch: {
    fr: 'Bonne pour le dispatch. Passée « Expédiée ».',
    en: 'Good to dispatch. Now “Shipped”.',
    ar: 'صالحة للإرسال. أصبحت «مُرسلة».',
  },
  // « Retour / Échange »
  exchangeNotReturn: { fr: 'C’est un colis d’échange, pas un retour.', en: 'This is an exchange parcel, not a return.', ar: 'هذا طرد تبديل، وليس إرجاعاً.' },
  exchangeNotReturnFix: {
    fr: 'Scannez-le avec « Retour / Échange » : l’ancien produit sera remis en stock.',
    en: 'Scan it with “Return / Exchange”: the old product goes back in stock.',
    ar: 'امسحه في «إرجاع / تبديل»: يعود المنتج القديم إلى المخزون.',
  },
  returnAlready: { fr: 'Retour déjà reçu{at}.', en: 'Return already received{at}.', ar: 'الإرجاع استُلم من قبل{at}.' },
  returnAlreadyFix: { fr: 'Double scan : ce colis est déjà compté.', en: 'Double scan: this parcel is already counted.', ar: 'مسح مرتين: هذا الطرد محسوب من قبل.' },
  deliveredNotReturn: { fr: 'Livrée selon Pilotix, pas en retour.', en: 'Delivered according to Pilotix, not a return.', ar: 'مُسلّمة حسب Pilotix، ليست في الإرجاع.' },
  deliveredNotReturnFix: {
    fr: 'Gardez le colis de côté et vérifiez avec la société : le client a peut-être payé.',
    en: 'Keep the parcel aside and check with the company: the customer may have paid.',
    ar: 'احتفظ بالطرد جانباً وتحقّق مع الشركة: ربما دفع الزبون.',
  },
  notReturning: {
    fr: 'Pas marquée « Retour en cours » (statut : {status}).',
    en: 'Not marked “Returning” (status: {status}).',
    ar: 'غير معلّمة «في طريق الإرجاع» (الحالة: {status}).',
  },
  notReturningFix: {
    fr: 'Vérifiez avec la société avant d’accepter ce retour.',
    en: 'Check with the company before accepting this return.',
    ar: 'تحقّق مع الشركة قبل قبول هذا الإرجاع.',
  },
  okReturn: { fr: 'Retour reçu. Stock remis : {items}.', en: 'Return received. Back in stock: {items}.', ar: 'استُلم الإرجاع. عاد إلى المخزون: {items}.' },
  products: { fr: 'produits', en: 'products', ar: 'المنتجات' },
  notExchange: { fr: 'Ce n’est pas une commande d’échange.', en: 'This is not an exchange order.', ar: 'هذه ليست طلبية تبديل.' },
  notExchangeFix: {
    fr: 'Si le colis est revenu, choisissez « Retour / Échange » : un retour normal sera reçu.',
    en: 'If the parcel came back, choose “Return / Exchange”: a normal return is received.',
    ar: 'إذا عاد الطرد، اختر «إرجاع / تبديل»: يُستلم كإرجاع عادي.',
  },
  noOrig: {
    fr: 'Échange {ref} sans commande d’origine : impossible de savoir quel produit revient.',
    en: 'Exchange {ref} has no first order: Pilotix cannot know which product comes back.',
    ar: 'التبديل {ref} بدون طلبية أصلية: لا يمكن معرفة أي منتج يعود.',
  },
  byHandFix: {
    fr: 'Remettez l’ancien produit en stock à la main (Produits & stock).',
    en: 'Put the old product back in stock by hand (Products & stock).',
    ar: 'أرجع المنتج القديم إلى المخزون يدوياً (المنتجات والمخزون).',
  },
  exNotDone: {
    fr: 'L’échange {ref} n’est pas encore fait chez le client (statut : {status}).',
    en: 'Exchange {ref} is not done at the customer’s yet (status: {status}).',
    ar: 'التبديل {ref} لم يتم بعد عند الزبون (الحالة: {status}).',
  },
  exNotDoneFix: {
    fr: 'L’ancien produit ne peut pas être revenu. Vérifiez l’étiquette.',
    en: 'The old product cannot be back yet. Check the label.',
    ar: 'لا يمكن أن يكون المنتج القديم قد عاد. تحقّق من الملصق.',
  },
  parts: {
    fr: 'Échange de pièces {ref} : l’article reste chez le client, rien ne revient en stock.',
    en: 'Parts exchange {ref}: the item stays with the customer, nothing comes back to stock.',
    ar: 'تبديل قطع {ref}: المنتج يبقى عند الزبون، لا شيء يعود إلى المخزون.',
  },
  nothingBack: { fr: 'Rien à remettre en stock.', en: 'Nothing to put back in stock.', ar: 'لا شيء يعود إلى المخزون.' },
  origEmpty: {
    fr: 'La commande d’origine {ref} n’a pas de produit à remettre.',
    en: 'The first order {ref} has no product to put back.',
    ar: 'الطلبية الأصلية {ref} ليس فيها منتج يعود.',
  },
  byHandShortFix: { fr: 'Remettez l’ancien produit en stock à la main.', en: 'Put the old product back in stock by hand.', ar: 'أرجع المنتج القديم إلى المخزون يدوياً.' },
  exAlready: { fr: 'Échange déjà reçu le {at}{by}.', en: 'Exchange already received on {at}{by}.', ar: 'التبديل استُلم من قبل في {at}{by}.' },
  by: { fr: ' par {name}', en: ' by {name}', ar: ' من طرف {name}' },
  exAlreadyFix: { fr: 'Double scan : l’ancien produit est déjà en stock.', en: 'Double scan: the old product is already in stock.', ar: 'مسح مرتين: المنتج القديم في المخزون من قبل.' },
  okExchange: { fr: 'Échange reçu. Ancien produit remis en stock : {items}.', en: 'Exchange received. Old product back in stock: {items}.', ar: 'استُلم التبديل. عاد المنتج القديم إلى المخزون: {items}.' },
  okExchangeFix: { fr: 'Commande d’origine : {ref}.', en: 'First order: {ref}.', ar: 'الطلبية الأصلية: {ref}.' },
  exchangedItems: { fr: '{n} article(s) échangé(s)', en: '{n} exchanged item(s)', ar: '{n} منتج(ات) مُبدّلة' },
  // the code itself
  notLabel: { fr: 'Ce n’est pas l’étiquette du colis (téléphone ou code incomplet).', en: 'This is not the parcel’s label (phone number or incomplete code).', ar: 'هذا ليس ملصق الطرد (رقم هاتف أو رمز ناقص).' },
  notLabelFix: {
    fr: 'Scannez le code-barres ou le QR code de l’étiquette collée sur le colis.',
    en: 'Scan the barcode or the QR code of the label stuck on the parcel.',
    ar: 'امسح الباركود أو رمز QR للملصق الملصوق على الطرد.',
  },
  pick: { fr: 'Plusieurs commandes avec ce code : choisissez la bonne.', en: 'Several orders with this code: choose the right one.', ar: 'عدّة طلبيات بهذا الرمز: اختر الصحيحة.' },
  unknown: { fr: 'Ce code n’existe pas dans Pilotix.', en: 'This code does not exist in Pilotix.', ar: 'هذا الرمز غير موجود في Pilotix.' },
  unknownFix: {
    fr: 'Vérifiez que toute l’étiquette a été scannée. Si la commande a été modifiée, cherchez-la par le téléphone du client et utilisez la nouvelle étiquette.',
    en: 'Check that the whole label was scanned. If the order was changed, find it by the customer’s phone and use the new label.',
    ar: 'تحقّق أن الملصق مُسح كاملاً. إذا عُدّلت الطلبية، ابحث عنها برقم هاتف الزبون واستعمل الملصق الجديد.',
  },
  emptyCode: { fr: 'Code vide.', en: 'Empty code.', ar: 'رمز فارغ.' },
  forbidden: { fr: 'Action refusée : {msg}', en: 'Not allowed: {msg}', ar: 'غير مسموح: {msg}' },
  forbiddenFix: { fr: 'Votre compte n’a pas le rôle Dépôt pour ce changement.', en: 'Your account does not have the Depot role for this change.', ar: 'حسابك ليس له دور المخزن لهذا التغيير.' },
  blockedFix: {
    fr: 'Mettez ce colis de côté. Réglez ce point dans la commande, puis scannez-le de nouveau.',
    en: 'Put this parcel aside. Fix this point in the order, then scan it again.',
    ar: 'ضع هذا الطرد جانباً. أصلح هذه النقطة في الطلبية، ثم امسحه من جديد.',
  },
  company: { fr: 'la société', en: 'the company', ar: 'الشركة' },
};

/** One scanner sentence in this language, {name} filled in. */
export function scanT(lang: ScanLang, key: keyof typeof T, vars: Record<string, string | number> = {}): string {
  const s = T[key][lang] || T[key].fr;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

const FOLLOW: Record<ScanLang, Record<string, string>> = {
  fr: {
    to_prepare: 'À préparer', prepared: 'Préparée', shipped: 'Expédiée', out_for_delivery: 'En livraison', failed: 'Reportée / échec', alert: 'Alerte',
    in_exchange: 'En échange', delivered: 'Livrée', returning: 'Retour en cours', returned: 'Retournée', exchanged: 'Échangée', lost: 'Perdue', cancelled: 'Annulée',
  },
  en: {
    to_prepare: 'To prepare', prepared: 'Prepared', shipped: 'Shipped', out_for_delivery: 'Out for delivery', failed: 'Postponed / failed', alert: 'Alert',
    in_exchange: 'In exchange', delivered: 'Delivered', returning: 'Returning', returned: 'Returned', exchanged: 'Exchanged', lost: 'Lost', cancelled: 'Cancelled',
  },
  ar: {
    to_prepare: 'للتحضير', prepared: 'محضّرة', shipped: 'مُرسلة', out_for_delivery: 'في التوصيل', failed: 'مؤجلة / فشل', alert: 'إنذار',
    in_exchange: 'في التبديل', delivered: 'مُسلّمة', returning: 'في طريق الإرجاع', returned: 'مُرجعة', exchanged: 'مُبدّلة', lost: 'ضائعة', cancelled: 'ملغاة',
  },
};
const CONF: Record<ScanLang, Record<string, string>> = {
  fr: {
    to_check: 'À vérifier', new: 'Nouvelle', no_answer: 'Pas de réponse', busy: 'Occupé', callback: 'À rappeler', postponed: 'Reportée', no_stock: 'Confirmée sans stock',
    confirmed: 'Confirmée', cancelled: 'Annulée', duplicate: 'Doublon', wrong_number: 'Faux numéro', fake: 'Fausse commande',
  },
  en: {
    to_check: 'To check', new: 'New', no_answer: 'No answer', busy: 'Busy', callback: 'Call back', postponed: 'Postponed', no_stock: 'Confirmed, no stock',
    confirmed: 'Confirmed', cancelled: 'Cancelled', duplicate: 'Duplicate', wrong_number: 'Wrong number', fake: 'Fake order',
  },
  ar: {
    to_check: 'للتحقق', new: 'جديدة', no_answer: 'لا رد', busy: 'مشغول', callback: 'إعادة الاتصال', postponed: 'مؤجلة', no_stock: 'مؤكدة بدون مخزون',
    confirmed: 'مؤكدة', cancelled: 'ملغاة', duplicate: 'مكررة', wrong_number: 'رقم خاطئ', fake: 'طلبية مزيفة',
  },
};
export const followIn = (lang: ScanLang, s: string | null | undefined) => (s ? FOLLOW[lang][s] ?? FOLLOW.fr[s] ?? s : '—');
export const confIn = (lang: ScanLang, s: string) => CONF[lang][s] ?? CONF.fr[s] ?? s;
const LOCALE: Record<ScanLang, string> = { fr: 'fr-FR', en: 'en-GB', ar: 'ar-DZ' };
/** « 12 oct., 14:05 » in Algiers time, in this language. */
export const dayIn = (lang: ScanLang, s: string | null | undefined) =>
  s ? new Date(s).toLocaleString(LOCALE[lang], { timeZone: 'Africa/Algiers', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
/** « le 12 oct., 14:05 » after a sentence (empty when unknown). */
export const atIn = (lang: ScanLang, s: string | null | undefined) => (s ? ({ fr: ' le ', en: ' on ', ar: ' في ' } as const)[lang] + dayIn(lang, s) : '');
