import { useEffect, useState } from 'react';

type Tone = 'ok' | 'bad' | 'info';
interface T {
  id: number;
  text: string;
  tone: Tone;
}
let items: T[] = [];
let nextId = 1;
const subs = new Set<(t: T[]) => void>();
const publish = () => subs.forEach((s) => s([...items]));

/** Small message at the bottom of the screen (like the original app). */
export function toast(text: string, tone: Tone = 'info', ms = 3500) {
  const t = { id: nextId++, text, tone };
  items = [...items, t].slice(-3);
  publish();
  setTimeout(() => {
    items = items.filter((x) => x.id !== t.id);
    publish();
  }, ms);
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
    <div aria-live="polite" style={{ position: 'fixed', insetInline: 0, bottom: 'max(18px, env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, zIndex: 100, pointerEvents: 'none' }}>
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role="status" style={{ position: 'static', transform: 'none' }}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
