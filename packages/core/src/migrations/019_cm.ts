// CM AI agent (community manager): comments left under the shop's Facebook and Instagram posts and ads, and what the
// agent did with each one (public reply, private message that opens a conversation in Message AI agent, hidden).
// Settings live in `settings` (key 'cm'); the Meta connection (page token, app secret) is the one of Message AI agent.
export default `
CREATE TABLE IF NOT EXISTS cm_posts (
  id          bigserial PRIMARY KEY,
  channel     text        NOT NULL,                 -- facebook | instagram | tiktok
  external_id text        NOT NULL,                 -- post / media id on that channel
  account_id  text,                                 -- our page / Instagram account
  caption     text,
  permalink   text,
  is_ad       boolean     NOT NULL DEFAULT false,
  product_id  bigint,                               -- the product this post sells (guessed from the caption, or chosen)
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

CREATE TABLE IF NOT EXISTS cm_comments (
  id                 bigserial PRIMARY KEY,
  post_id            bigint      REFERENCES cm_posts(id) ON DELETE CASCADE,
  channel            text        NOT NULL,
  external_id        text        NOT NULL,          -- comment id on the channel (dedupe)
  parent_external_id text,                          -- set when it answers another comment
  author_id          text,
  author_name        text,
  body               text        NOT NULL,
  status             text        NOT NULL DEFAULT 'new',  -- new | answered | hidden | handoff | ignored | error
  intent             text,                          -- price | delivery | availability | order | question | praise | complaint | spam | insult | tag | other
  public_reply       text,
  public_reply_id    text,
  private_reply      text,
  private_sent       boolean     NOT NULL DEFAULT false,
  hidden             boolean     NOT NULL DEFAULT false,
  conversation_id    bigint,                        -- the conversation the private message opened
  phone              text,                          -- a phone number the commenter left (the comment is hidden)
  reason             text,
  send_error         text,
  handled_by         bigint,                        -- a person who answered or changed it by hand
  handled_at         timestamptz,
  claimed_at         timestamptz,                   -- the agent is working on it (one answer at a time)
  meta               jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);
CREATE INDEX IF NOT EXISTS cm_comments_new ON cm_comments (status, created_at DESC);
CREATE INDEX IF NOT EXISTS cm_comments_post ON cm_comments (post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cm_comments_author ON cm_comments (channel, author_id);
`;
