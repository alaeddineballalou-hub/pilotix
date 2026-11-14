// Pilot Content: the name a photo or video had on the device it was picked on (« IMG_2034.mp4 »), so a post that did
// not go out says which file it was and the file can be found again on the computer or the phone. Only a new column
// with a default: nothing else changes, every shop's database takes it the same way (old media keep an empty name).
export default `
ALTER TABLE cm_media ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
`;
