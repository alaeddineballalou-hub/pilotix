// Dellal sends the products' real photos: each picture is turned into a JPEG once and kept here with a random key, so
// Meta (WhatsApp, Messenger, Instagram) downloads it from a public address nobody can guess (/lp/dp/<id>/<key>.jpg).
// A copy nobody used for a month is removed when the next one is made.
export default `
CREATE TABLE IF NOT EXISTS dellal_photos (
  id         bigserial   PRIMARY KEY,
  src        text        NOT NULL UNIQUE,              -- the picture it is made from (li:<landing image>:<size>, pp:<product>:<hash>…)
  key        text        NOT NULL,
  mime       text        NOT NULL DEFAULT 'image/jpeg',
  jpeg       text        NOT NULL,                     -- base64
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz NOT NULL DEFAULT now()
);
`;
