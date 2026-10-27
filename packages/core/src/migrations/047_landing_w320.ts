// Landing page pictures: a 320 px width, for the small boxes a computer shows (a 240 px wide photo no longer downloads
// the 480 file). Pictures stored before get theirs the next time their page is opened in the editor; until then the
// page simply leaves 320 out of its srcset.
export default `
ALTER TABLE landing_images ADD COLUMN IF NOT EXISTS w320 text;
`;
