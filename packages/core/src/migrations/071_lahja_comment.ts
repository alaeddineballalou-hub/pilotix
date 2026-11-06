// A Darija lesson can also come from one of Pilot Comments's replies to a comment (public or private): the comment it
// belongs to (modules/lahja.ts). The reply that was sent never changes.
export default `
ALTER TABLE dellal_lahja ADD COLUMN IF NOT EXISTS comment_id bigint;
`;
