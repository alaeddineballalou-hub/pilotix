import { useEffect, useState } from 'react';

type Tone = 'ok' | 'bad' | 'info';
/** a button in the message (« ↶ Annuler » right after a change) */
export interface ToastAction {
  label: string;
  run: () => void;
}
interface T {
  id: number;
  text: string;
  tone: Tone;
  action?: ToastAction;
}
let items: T[] = [];
let nextId = 1;
const subs = new Set<(t: T[]) => void>();
const publish = () => subs.forEach((s) => s([...items]));

const drop = (id: number) => {
  items = items.filter((x) => x.id !== id);
  publish();
};

/** The messages with a button (« ↶ Annuler ») taken away: a change undone from elsewhere (the order's bar, the scanner)
 *  never leaves a second button that would undo the change before it. */
export function dropActions() {
  if (!items.some((x) => x.action)) return;
  items = items.filter((x) => !x.action);
  publish();
}

/** Small message at the bottom of the screen (like the original app); `action`: one button in it (8 s to press it). */
export function toast(text: string, tone: Tone = 'info', ms = 3500, action?: ToastAction) {
  // the same message already on screen is not shown twice (a double click, two answers saying the same)
  if (!action && items.some((x) => x.text === text && x.tone === tone && !x.action)) return;
  const t: T = { id: nextId++, text, tone, action };
  items = [...items, t].slice(-3);
  publish();
  setTimeout(() => drop(t.id), action ? Math.max(ms, 8000) : ms);
}

export function Toasts() {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    subs.add(setList);
    return () => {
      subs.delete(setList);
    };
  }, []);
  return (
    <div aria-live="polite" style={{ position: 'fixed', insetInline: 0, bottom: 'max(18px, env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, zIndex: 10050, pointerEvents: 'none' }}>
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}${t.action ? ' has-act' : ''}`} role="status" style={{ position: 'static', transform: 'none', pointerEvents: t.action ? 'auto' : undefined }}>
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toast-act"
              onClick={() => {
                drop(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
