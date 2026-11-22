// The bell at the top of every page (owner's ask, 22 Nov 2026): what each person is told, one line per person, kept 30
// days — a new order given to them, a callback whose time has come, their order delivered, back or cancelled, an order
// taken from them, an alert on the parcel they follow, the depot's orders to prepare, a customer's message, and every
// notification the phones already got (the evening report, the slow queue, the depot's red alerts…).
// A line with a tag is replaced while it is not read (a chat that goes on, an alert that rings again): `n` counts them.
// (« notifications » is already the table of the messages sent to the customers: modules/notify.ts.)
export default `
CREATE TABLE IF NOT EXISTS inbox (
  id          bigserial   PRIMARY KEY,
  profile_id  bigint      NOT NULL,
  kind        text        NOT NULL,              -- order | callback | delivered | returned | cancelled | taken | alert | depot | message | info
  tag         text,
  title       text        NOT NULL,
  body        text        NOT NULL DEFAULT '',
  url         text,                              -- the page it opens (« #/confirmation/nouvelles »)
  order_id    bigint,                            -- the order it opens
  important   boolean     NOT NULL DEFAULT false,
  n           integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
DO $inbox$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inbox'::regclass AND conname = 'inbox_profile_id_fkey'
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'profiles'::regclass AND attname = 'shop_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE inbox ADD COLUMN IF NOT EXISTS shop_id integer NOT NULL DEFAULT public.px_shop_id();
    ALTER TABLE inbox ADD CONSTRAINT inbox_profile_id_fkey
      FOREIGN KEY (shop_id, profile_id) REFERENCES profiles (shop_id, id) ON DELETE CASCADE;
  ELSE
    ALTER TABLE inbox ADD CONSTRAINT inbox_profile_id_fkey
      FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE;
  END IF;
END;
$inbox$;
CREATE INDEX IF NOT EXISTS inbox_person ON inbox (profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inbox_open_tag ON inbox (profile_id, tag) WHERE read_at IS NULL AND tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_tag ON inbox (tag) WHERE tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_age ON inbox (created_at);
`;
