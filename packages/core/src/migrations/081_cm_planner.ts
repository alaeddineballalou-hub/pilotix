// Pilot Comments › Planner: posts planned on a calendar. The AI writes the caption, and Pilotix posts them on the shop's
// Facebook Page and Instagram account at the chosen time (the 'cm-plan' job, every minute).
// - cm_media: a post's photos and videos. A photo as Meta needs it: JPEG (Instagram takes nothing else), at most 1440 px
//   wide, between 4:5 and 1.91:1 (cropped in the browser before it is sent), and a small copy for the calendar. A video:
//   the original file, untouched (only its index moved to the front, as Instagram asks), kept on the server's disk
//   (MEDIA_DIR), and a still from it for the calendar. Meta downloads each one from Pilotix's public address
//   (…/lp/pic/<id>/<key>.jpg, …/lp/vid/<id>/<key>.mp4); the random key keeps the address unguessable. `src`: an outside
//   address instead (the demo's drawn pictures).
// - cm_planned: one post, for one network or both. What happened on each network (the id Meta gave, the error) is kept
//   apart, so a post that went out on Facebook but not on Instagram is tried again on Instagram only.
export default `
CREATE TABLE IF NOT EXISTS cm_media (
  id         bigserial   PRIMARY KEY,
  key        text        NOT NULL,
  w          integer     NOT NULL,
  h          integer     NOT NULL,
  jpeg       text,                                  -- base64 JPEG for Meta (emptied a week after the post went out)
  thumb      text,                                  -- base64 JPEG, 360 px wide (the calendar, the editor)
  src        text,                                  -- an outside address instead of the two above
  kind       text        NOT NULL DEFAULT 'photo',  -- photo | video
  mime       text,                                  -- a video's type (video/mp4, video/quicktime)
  duration   real,                                  -- a video's length, in seconds
  ready      boolean     NOT NULL DEFAULT true,     -- false while a video is still being sent
  bytes      bigint      NOT NULL DEFAULT 0,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cm_planned (
  id           bigserial   PRIMARY KEY,
  caption      text        NOT NULL DEFAULT '',
  media        bigint[]    NOT NULL DEFAULT '{}',   -- cm_media ids, in order (2 to 10: a carousel)
  channels     text[]      NOT NULL DEFAULT '{}',   -- facebook, instagram
  product_id   bigint,                              -- what it sells: the AI's caption, then CM AI's answers to its comments
  publish_at   timestamptz,                         -- null: a draft without a day
  status       text        NOT NULL DEFAULT 'draft', -- draft | scheduled | publishing | published | failed
  fb_id        text,                                -- the Facebook post, once out
  fb_url       text,
  fb_error     text,
  ig_id        text,                                -- the Instagram post, once out
  ig_url       text,
  ig_error     text,
  ig_container text,                                -- a video Instagram is still preparing (checked every minute)
  ig_wait_at   timestamptz,
  ai_lang      text,                                -- the caption's language when the AI wrote it
  published_at timestamptz,
  tries        integer     NOT NULL DEFAULT 0,
  created_by   bigint,
  updated_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cm_planned_due ON cm_planned (publish_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS cm_planned_at ON cm_planned (publish_at);
`;
