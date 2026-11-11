// Espace créateur: the video pieces live in a folder of the user's computer, never on the server. The folder is picked
// once (File System Access API: Chrome, Edge on a computer); its handle is kept in this browser (IndexedDB, one per
// boutique) and opened again on the next visit, after a click when the browser asks for the user's yes again.
//
// Inside it, one folder per product (« montre-x-12 »: the product's name made safe, then its id), and in each:
//   hooks/  the start (2–4 s)   corps/  the rest (10–25 s, it ends with « commandez »)   pubs/  the finished ads
//   pilotix.json  what Pilotix keeps on the computer too: each hook's text, each piece's subtitles, how each ad was made
// Videos put there by hand (Windows Explorer) show up too: the page lists the folders.

export const KINDS = ['hooks', 'corps'] as const;
export type Kind = (typeof KINDS)[number];
/** the finished ads (« Mélanger »), made in this browser */
export const PUBS = 'pubs';

export const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.m4v'];
export const isVideoName = (name: string) => VIDEO_EXT.some((e) => name.toLowerCase().endsWith(e));

/** The browser can pick a folder and write in it (not Firefox, Safari or a phone). */
export function folderApiOn(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function' &&
    typeof window.showOpenFilePicker === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

// ---------------------------------------------------------------- the folder's handle, kept in this browser
const DB = 'pilotix-createur';
const STORE = 'dirs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((ok, ko) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ko(req.error);
    });
  } finally {
    db.close();
  }
}

const keyOf = (boutique: string) => `boutique:${boutique}`;

export async function savedFolder(boutique: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const h = await withStore<unknown>('readonly', (s) => s.get(keyOf(boutique)));
    return h && typeof h === 'object' && (h as FileSystemHandle).kind === 'directory' ? (h as FileSystemDirectoryHandle) : null;
  } catch {
    return null;
  }
}

export async function saveFolder(boutique: string, dir: FileSystemDirectoryHandle | null): Promise<void> {
  try {
    if (dir) await withStore('readwrite', (s) => s.put(dir, keyOf(boutique)));
    else await withStore('readwrite', (s) => s.delete(keyOf(boutique)));
  } catch {
    /* private mode: the folder is asked again next time */
  }
}

// ---------------------------------------------------------------- permission
const RW: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };

/** Without a click: is the folder still ours? */
export async function hasPermission(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    return (await dir.queryPermission?.(RW)) === 'granted';
  } catch {
    return false;
  }
}

/** After a click (« Rouvrir mon dossier »): asks the browser again. */
export async function askPermission(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    if ((await dir.queryPermission?.(RW)) === 'granted') return true;
    return (await dir.requestPermission?.(RW)) === 'granted';
  } catch {
    return false;
  }
}

/** « Choisir mon dossier »: null when the user closes the window. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await window.showDirectoryPicker!({ mode: 'readwrite', id: 'pilotix-videos' })) ?? null;
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null;
    throw e;
  }
}

// ---------------------------------------------------------------- a product's folders
/** « Montre X » (id 12) → « montre-x-12 »; a name without Latin letters → « produit-12 ». */
export function productFolderName(name: string, id: number): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${slug || 'produit'}-${id}`;
}

/**
 * The product's folder, created when needed. A folder already ending with « -<id> » is used even when the product was
 * renamed since, so its videos are not lost.
 */
export async function productFolder(root: FileSystemDirectoryHandle, name: string, id: number, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const wanted = productFolderName(name, id);
  const end = `-${id}`;
  let found: FileSystemDirectoryHandle | null = null;
  for await (const h of root.values()) {
    if (h.kind !== 'directory') continue;
    if (h.name === wanted) return h as FileSystemDirectoryHandle;
    if (!found && (h.name.endsWith(end) || h.name === String(id))) found = h as FileSystemDirectoryHandle;
  }
  if (found) return found;
  if (!create) return null;
  return root.getDirectoryHandle(wanted, { create: true });
}

/** Makes hooks/, corps/ and pubs/ inside the product's folder (an old cta/ folder stays as it is). */
export async function ensureKindFolders(product: FileSystemDirectoryHandle): Promise<void> {
  for (const k of [...KINDS, PUBS]) await product.getDirectoryHandle(k, { create: true });
}

export interface Clip {
  kind: Kind;
  name: string;
  file: File;
  /** name + size + last change: the same file keeps its thumbnail */
  key: string;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The videos of the two folders (the files put there by hand too), by name. */
export async function listClips(product: FileSystemDirectoryHandle): Promise<Record<Kind, Clip[]>> {
  const out = { hooks: [], corps: [] } as Record<Kind, Clip[]>;
  for (const kind of KINDS) {
    const dir = await product.getDirectoryHandle(kind, { create: true });
    for await (const h of dir.values()) {
      if (h.kind !== 'file' || !isVideoName(h.name) || h.name.startsWith('.')) continue;
      try {
        const file = await (h as FileSystemFileHandle).getFile();
        out[kind].push({ kind, name: h.name, file, key: `${h.name}|${file.size}|${file.lastModified}` });
      } catch {
        /* a file being written by another program: next refresh */
      }
    }
    out[kind].sort((a, b) => byName.compare(a.name, b.name));
  }
  return out;
}

// ---------------------------------------------------------------- copy in, delete
export type CopyResult = 'copied' | 'same' | 'failed';

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

/** A free name in the folder: « clip.mp4 », else « clip (2).mp4 »… (null: the same file is already there). */
async function freeName(dir: FileSystemDirectoryHandle, file: File): Promise<string | null> {
  const dot = file.name.lastIndexOf('.');
  const base = (dot > 0 ? file.name.slice(0, dot) : file.name).replace(/[\\/:*?"<>|]/g, '_') || 'video';
  const ext = dot > 0 ? file.name.slice(dot) : '.mp4';
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    const there = await exists(dir, name);
    if (!there) return name;
    if (there.size === file.size) return null;
  }
  return `${base} ${Date.now()}${ext}`;
}

/**
 * Copies a video into hooks/ or corps/ piece by piece (a 4K file is never read whole into memory).
 * `progress` gets the bytes written so far.
 */
export async function copyInto(product: FileSystemDirectoryHandle, kind: Kind, file: File, progress: (bytes: number) => void): Promise<CopyResult> {
  const dir = await product.getDirectoryHandle(kind, { create: true });
  const name = await freeName(dir, file);
  if (!name) return 'same';
  const fh = await dir.getFileHandle(name, { create: true });
  let w: FileSystemWritableFileStream | null = null;
  try {
    w = await fh.createWritable();
    let done = 0;
    const count = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        done += chunk.byteLength;
        progress(done);
        c.enqueue(chunk);
      },
    });
    // pipeTo closes the file when the copy ends (and aborts it on an error)
    await file.stream().pipeThrough(count).pipeTo(w);
    return 'copied';
  } catch {
    await w?.abort().catch(() => undefined);
    await dir.removeEntry(name).catch(() => undefined);
    return 'failed';
  }
}

export async function removeClip(product: FileSystemDirectoryHandle, kind: Kind, name: string): Promise<void> {
  const dir = await product.getDirectoryHandle(kind);
  await dir.removeEntry(name);
}

/** « + Ajouter »: the videos the user picks (an empty list when the window is closed). */
export async function pickVideos(): Promise<File[]> {
  try {
    const hs = await window.showOpenFilePicker!({ multiple: true, types: [{ description: 'Vidéos', accept: { 'video/*': ['.mp4', '.mov', '.webm', '.m4v'] } }] });
    return Promise.all(hs.map((h) => h.getFile()));
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return [];
    throw e;
  }
}

/** The browser no longer lets us in (the permission was taken back, the folder was moved or deleted). */
export const lostAccess = (e: unknown) => ['NotAllowedError', 'SecurityError', 'NotFoundError'].includes((e as DOMException)?.name);

// ---------------------------------------------------------------- the finished ads (pubs/)
export interface AdFile {
  name: string;
  file: File;
  key: string;
}

/** The ads of pubs/ (the newest first). */
export async function listAds(product: FileSystemDirectoryHandle): Promise<AdFile[]> {
  const dir = await product.getDirectoryHandle(PUBS, { create: true });
  const out: AdFile[] = [];
  for await (const h of dir.values()) {
    if (h.kind !== 'file' || !h.name.toLowerCase().endsWith('.mp4') || h.name.startsWith('.')) continue;
    try {
      const file = await (h as FileSystemFileHandle).getFile();
      if (file.size > 0) out.push({ name: h.name, file, key: `${h.name}|${file.size}|${file.lastModified}` });
    } catch {
      /* being written */
    }
  }
  return out.sort((a, b) => b.file.lastModified - a.file.lastModified || byName.compare(a.name, b.name));
}

/** A new file in pubs/ (an old one with the same name is replaced). */
export async function adHandle(product: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle> {
  const dir = await product.getDirectoryHandle(PUBS, { create: true });
  return dir.getFileHandle(name, { create: true });
}

export async function removeAd(product: FileSystemDirectoryHandle, name: string): Promise<void> {
  const dir = await product.getDirectoryHandle(PUBS);
  await dir.removeEntry(name);
}

// ---------------------------------------------------------------- pilotix.json: the notes kept next to the videos
export interface Segment {
  start: number;
  end: number;
  text: string;
}
export interface Notes {
  /** a hook's text (drawn big at the top), by its file name */
  text: Record<string, string>;
  /** a piece's subtitles, by name + size + last change (the same file is listened to once) */
  words: Record<string, Segment[]>;
  /** how each ad of pubs/ was made */
  ads: Record<string, { hook: string; body: string; strategy: string; at: string; post?: string; stage?: 'top' | 'middle' | 'bottom'; cta?: boolean }>;
  /** the post's fixed part (prix, livraison, lien…) */
  fixed?: string;
}
const NOTES = 'pilotix.json';
const emptyNotes = (): Notes => ({ text: {}, words: {}, ads: {} });

export async function readNotes(product: FileSystemDirectoryHandle): Promise<Notes> {
  try {
    const f = await (await product.getFileHandle(NOTES)).getFile();
    const j = JSON.parse(await f.text());
    return { ...emptyNotes(), ...(j && typeof j === 'object' ? j : {}) };
  } catch {
    return emptyNotes();
  }
}

export async function writeNotes(product: FileSystemDirectoryHandle, n: Notes): Promise<void> {
  const fh = await product.getFileHandle(NOTES, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(n, null, 1));
  await w.close();
}
