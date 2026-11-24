// Rendez-vous (owner's choice, 24 Nov 2026: « Seats in sessions », the training centres first): a boutique that sells a
// service adds its sessions (a date, its hours, a city and a place, a number of seats, a price); its website shows them
// and people book a seat. Each booking comes into Pilotix › Rendez-vous to be called and confirmed, like an order.
// A booking's `token` opens its ticket on the website (/?billet=…); `code` (RDV-0421) is what the person shows at the
// door. `status`: new | no_answer | callback | confirmed | cancelled | present | absent | blocked (a number of the
// boutique's black list: kept apart, it takes no seat). The module is off until an administrator turns it on
// (Management › Modules).
export default `
CREATE TABLE IF NOT EXISTS rdv_sessions (
  id          bigserial   PRIMARY KEY,
  title       text        NOT NULL DEFAULT '',     -- what is taught (« E-commerce de zéro »)
  city        text        NOT NULL DEFAULT '',
  place       text        NOT NULL DEFAULT '',     -- the address, the room
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  seats       integer     NOT NULL DEFAULT 20,
  price       numeric     NOT NULL DEFAULT 0,
  note        text        NOT NULL DEFAULT '',     -- shown on the website and the ticket (« apportez votre ordinateur »)
  open        boolean     NOT NULL DEFAULT true,   -- the website takes bookings
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS rdv_sessions_when ON rdv_sessions (starts_at) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS rdv_bookings (
  id          bigserial   PRIMARY KEY,
  session_id  bigint      NOT NULL REFERENCES rdv_sessions(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  phone       text        NOT NULL,
  seats       smallint    NOT NULL DEFAULT 1,
  status      text        NOT NULL DEFAULT 'new',
  tries       smallint    NOT NULL DEFAULT 0,      -- calls without an answer
  call_at     timestamptz,                         -- « Rappeler à 18:00 »
  note        text        NOT NULL DEFAULT '',
  code        text,
  token       text        NOT NULL,
  source      text        NOT NULL DEFAULT 'site', -- site | hand (added in Pilotix: a call, a visit)
  lang        text,                                -- the website's language it was booked in
  ip          text,
  agent_id    bigint,                              -- the last person who handled it
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rdv_bookings_token ON rdv_bookings (token);
CREATE INDEX IF NOT EXISTS rdv_bookings_session ON rdv_bookings (session_id, status);
CREATE INDEX IF NOT EXISTS rdv_bookings_status ON rdv_bookings (status, created_at DESC);
CREATE INDEX IF NOT EXISTS rdv_bookings_phone ON rdv_bookings (phone);
`;
