// Pilot Content: stories, the first comment under a post, the admin's yes before a post goes out (when the
// shop asks for it), « Post again » for a post that sold, the Algerian calendar's day a post was made for, and the numbers
// Meta gives for each post (views, reach, likes, comments, shares, saves) and the followers of each day.
export default `
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'post';   -- post | story
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS first_comment text;                  -- posted under it right after it goes out
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS fb_comment_id text;
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS ig_comment_id text;
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS comment_error text;
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS review_note text;                    -- the admin's word when a post goes back to its writer
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS approved_by bigint;
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS again_of bigint;                     -- « Post again »: the post it repeats
ALTER TABLE cm_planned ADD COLUMN IF NOT EXISTS event_key text;                      -- the Algerian calendar's day it was made for
CREATE INDEX IF NOT EXISTS cm_planned_review ON cm_planned (updated_at DESC) WHERE status = 'review';
CREATE INDEX IF NOT EXISTS cm_planned_out ON cm_planned (published_at DESC) WHERE published_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS cm_post_stats (
  channel     text        NOT NULL,                 -- facebook | instagram
  external_id text        NOT NULL,                 -- the post on that network
  planned_id  bigint,
  views       integer,
  reach       integer,
  likes       integer,
  comments    integer,
  shares      integer,
  saves       integer,
  insights    boolean     NOT NULL DEFAULT false,   -- Meta gave its numbers (false: likes and comments only, no permission yet)
  error       text,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, external_id)
);

CREATE TABLE IF NOT EXISTS cm_follow_days (
  day       date    NOT NULL,                       -- in Algeria
  channel   text    NOT NULL,
  followers integer NOT NULL,
  PRIMARY KEY (day, channel)
);
`;
