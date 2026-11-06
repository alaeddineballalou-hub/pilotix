import { useEffect, useRef, useState } from 'react';

/** Require a continuous intentional 1.2-second hold on touch, mouse or keyboard. */
const HOLD_MS = 1200;

export function HoldToConfirm({ label, busy, onConfirm }: { label: string; busy: boolean; onConfirm: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submitted = useRef(false);
  const pressed = useRef(false);

  const stop = () => {
    pressed.current = false;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };

  const start = () => {
    if (busy || submitted.current || pressed.current) return;
    pressed.current = true;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!pressed.current || submitted.current) return;
      submitted.current = true;
      pressed.current = false;
      setHolding(false);
      onConfirm();
    }, HOLD_MS);
  };

  // A rejected request must be retryable; successful requests unmount the dialog.
  useEffect(() => {
    if (!busy) submitted.current = false;
  }, [busy]);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pressed.current = false;
  }, []);

  return (
    <button
      type="button"
      className={`pxt-hold${holding ? ' is-holding' : ''}`}
      disabled={busy}
      aria-label={label}
      aria-busy={busy}
      onPointerDown={(e) => { if (e.button === 0) start(); }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(); } }}
      onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stop(); } }}
      onBlur={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="pxt-hold-progress" aria-hidden="true" />
      <span className="pxt-hold-label">{label}</span>
    </button>
  );
}
