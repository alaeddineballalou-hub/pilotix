// Studio photo (Espace créateur › Studio photo): the shop's backgrounds (its showroom, a table, a floor…). The page blurs
// each one once and keeps that file, so every product photo made on it looks the same; the logo box is the part of the
// picture the product must never cover (the shop's sign). The photos are small (1600 px, 0.2 to 0.6 MB): they stay in
// the shop's database, a few per shop.
export default `
CREATE TABLE IF NOT EXISTS studio_backgrounds (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  data       text NOT NULL,
  thumb      text NOT NULL,
  w          integer NOT NULL DEFAULT 0,
  h          integer NOT NULL DEFAULT 0,
  -- the logo box, as parts of the picture (0 to 1): left, top, width, height
  logo       jsonb,
  -- where the product stands: « table » or « floor »
  surface    text NOT NULL DEFAULT 'table' CHECK (surface IN ('table', 'floor')),
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
