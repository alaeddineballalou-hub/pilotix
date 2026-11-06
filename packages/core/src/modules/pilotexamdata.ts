// The exam's table and Pilotix's own sales lessons, apart from the exam itself (pilotexam.ts): the platform's migration
// list reads them, and must not load Dellal to do it.
import { Db } from '../db';
import { COACH_PRIO, lessonFp, similar } from './pilotlearn';

export const EXAM_SQL = `
CREATE TABLE IF NOT EXISTS platform.pilot_exams (
  id          bigserial   PRIMARY KEY,
  shop_id     bigint      NOT NULL,
  shop_name   text,
  book        text        NOT NULL,                  -- live | trial | test | none: the version the chats used
  version     integer     NOT NULL DEFAULT 0,        -- that book's version (0: none, the basic method)
  status      text        NOT NULL DEFAULT 'running', -- running | done | failed
  score       numeric(4,1),
  done        integer     NOT NULL DEFAULT 0,        -- questions marked so far
  items       jsonb       NOT NULL DEFAULT '[]',
  error       text,
  by_user     text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS pilot_exams_recent ON platform.pilot_exams (started_at DESC);
`;

/** The 100 situations: each exam keeps the ten it asks (one per stage, chosen before it starts), with their titles. */
export const EXAM_PLAN_SQL = `ALTER TABLE platform.pilot_exams ADD COLUMN IF NOT EXISTS plan jsonb;`;

// ---------------------------------------------------------------- Pilotix's own lessons (with the photos and the exam)
/**
 * Lessons written by Pilotix for no mistakes and a chat kept in order (and the new photo abilities). Added once by the
 * platform's migration, approved in Pilotix's name, they wait for the next « Push en test » like any coach lesson (each one
 * passes the lesson checks); one the coach refuses or removes is never added again. Leçons › Vente offers in one click
 * the ones still missing.
 */
export const PILOTIX_LESSONS: { topic: string; text: string; meaning: string }[] = [
  {
    topic: 'closing',
    text: "Keep the chat in order: answer the customer's question first, add one useful benefit, then ask one single question to move forward. Never skip a step and never ask several questions at once.",
    meaning: 'Garder la conversation en ordre : répondre d’abord à sa question, un seul avantage utile, puis une seule question pour avancer. Ne jamais sauter une étape ni poser plusieurs questions à la fois.',
  },
  {
    topic: 'product',
    text: 'When the customer asks for a photo or another colour, send the real photos with the photo tool instead of talking about them, then ask which colour they like.',
    meaning: 'Le client demande une photo ou une autre couleur : envoyer les vraies photos avec l’outil des photos plutôt que d’en parler, puis demander quelle couleur lui plaît.',
  },
  {
    topic: 'product',
    text: 'When the customer sends a photo of a product, first name the product it shows; when you are unsure, offer the closest products and ask which one they mean.',
    meaning: 'Le client envoie la photo d’un produit : nommer d’abord le produit qu’elle montre ; si ce n’est pas sûr, proposer les produits les plus proches et demander lequel.',
  },
  {
    topic: 'price',
    text: 'Before giving a price, a fee or a total, check it with the tool, then say clearly the total to hand to the delivery man, so there is no surprise at the door.',
    meaning: 'Avant un prix, des frais ou un total : le vérifier avec l’outil, puis redire clairement le total à donner au livreur, pour aucune surprise à la porte.',
  },
  {
    topic: 'address',
    text: 'To take the order, ask for one piece of information at a time, in this order: first name, phone number, wilaya, then commune. Read the number back in small groups so the customer can check it.',
    meaning: 'Pour la commande : une seule information à la fois, dans l’ordre prénom, numéro, wilaya, commune. Relire le numéro par petits groupes pour que le client le vérifie.',
  },
  {
    topic: 'trust',
    text: 'If the customer fears a scam, reassure them with simple facts: they settle only when the parcel arrives, they never give a deposit, and you stay here to answer their questions.',
    meaning: 'Peur d’une arnaque : rassurer avec des faits simples (il règle seulement à la réception, jamais d’acompte) et rester là pour répondre à ses questions.',
  },
  {
    topic: 'closing',
    text: "Before saving the order, give a short clear recap (product, colour, wilaya, total checked with the tool) and wait for the customer's yes.",
    meaning: 'Avant d’enregistrer la commande : un récapitulatif court et clair (produit, couleur, wilaya, total vérifié avec l’outil), puis attendre le oui du client.',
  },
  {
    topic: 'followup',
    text: 'When the customer wants to think or to ask their family, respect that moment: offer a short recap they can show, say you are here when they come back, and let them decide.',
    meaning: 'Le client veut réfléchir ou demander à sa famille : respecter ce moment, proposer un petit récapitulatif à montrer, dire qu’on est là s’il revient, et le laisser décider.',
  },
  {
    topic: 'language',
    text: "Write short, like a seller on their phone, in the customer's language and script, with Algerian Darija words and not words from another country.",
    meaning: 'Écrire court, comme un vendeur sur son téléphone, dans la langue et l’écriture du client, avec les mots de la darija algérienne et pas ceux d’un autre pays.',
  },
  {
    topic: 'product',
    text: 'When you do not know a piece of information about the product, say so simply and offer that someone from the team calls the customer back to answer.',
    meaning: 'Une information sur le produit qu’on ne connaît pas : le dire simplement et proposer qu’un conseiller de l’équipe rappelle le client pour lui répondre.',
  },
  {
    topic: 'anger',
    text: 'When the customer is unhappy, apologise in one sentence, repeat their problem in your own words to show you understood, then hand the chat to the team without arguing.',
    meaning: 'Client mécontent : s’excuser en une phrase, redire son problème avec ses propres mots pour montrer qu’on a compris, puis passer la main à l’équipe sans discuter.',
  },
];

/**
 * Pilotix's lessons and whether each one is already there: added (or refused since: never offered again), or one of the
 * lessons says nearly the same (it would be refused as a copy).
 */
export async function pilotixLessons(pdb: Db): Promise<{ topic: string; text: string; meaning: string; added: boolean }[]> {
  const rows = await pdb.query(`SELECT fp, text, status FROM platform.pilot_lessons WHERE fp = ANY($1) OR status IN ('candidate', 'approved')`, [PILOTIX_LESSONS.map((l) => lessonFp(l.text))]);
  const fps = new Set(rows.map((r: any) => String(r.fp)));
  const open = rows.filter((r: any) => r.status === 'candidate' || r.status === 'approved').map((r: any) => String(r.text));
  return PILOTIX_LESSONS.map((l) => ({ ...l, added: fps.has(lessonFp(l.text)) || open.some((t) => similar(t, l.text) >= 0.6) }));
}

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** The platform migration that adds them (once; a lesson already there, even refused, is left as it is). */
export function pilotixLessonsSql(): string {
  return PILOTIX_LESSONS.map(
    (l) =>
      `INSERT INTO platform.pilot_lessons (topic, text, status, source, prio, evidence, fp, by_user, created_at, decided_at)
       VALUES (${sqlText(l.topic)}, ${sqlText(l.text)}, 'approved', 'coach', ${COACH_PRIO}, ${sqlText(JSON.stringify({ coach: true, pilotix: true, meaning: l.meaning }))}::jsonb, ${sqlText(lessonFp(l.text))}, 'Pilotix', now(), now())
       ON CONFLICT (fp) DO NOTHING;`,
  ).join('\n');
}
