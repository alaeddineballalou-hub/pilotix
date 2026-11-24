// AI Spy (24 Nov 2026): a competitor's video plays in Pilotix. Facebook's link to the video is kept with the time it was
// seen (the link stops working after some days: its « oe » part says when); Pilotix keeps its own copy of the videos the
// shop cares about (the ads of the shops it follows, the ads a person tagged), on the server's disk, so they still play
// once Facebook's link has expired or the ad has stopped. video_copy is the copy's key (null: no copy yet), video_tries
// the copies tried with the current link (3 at most; a new link starts again from 0).
export default `
ALTER TABLE spy_ads ADD COLUMN IF NOT EXISTS video_url text;
ALTER TABLE spy_ads ADD COLUMN IF NOT EXISTS video_at timestamptz;
ALTER TABLE spy_ads ADD COLUMN IF NOT EXISTS video_copy text;
ALTER TABLE spy_ads ADD COLUMN IF NOT EXISTS video_tries smallint NOT NULL DEFAULT 0;
`;
