/** Run at local midnight, or on first foreground after Android suspends the timer. */
export function atLocalMidnight(check: () => void) {
  const next = () => { const d = new Date(); return d.setHours(24, 0, 0, 0); };
  let due = next();
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    clearTimeout(timer);
    if (Date.now() >= due && document.visibilityState === 'visible') {
      due = next();
      check();
    }
    if (Date.now() < due) timer = setTimeout(arm, due - Date.now() + 1);
  };
  document.addEventListener('visibilitychange', arm);
  arm();
}
