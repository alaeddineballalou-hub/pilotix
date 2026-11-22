// The bell's recorded sounds (layout/Bell, lib/sound.ts › bellSound), loaded the first time they are needed: inside
// this small file, so they are never in the app's first download, and the preview can use them too.
// - « Livrée »: the cash register the owner chose (22 Nov 2026).
import cash from '../assets/sounds/livree.mp3?inline';

export const BELL_FILES = { delivered: cash } as const;
