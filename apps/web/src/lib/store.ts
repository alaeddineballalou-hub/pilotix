/** Small wrapper over localStorage that never throws (private mode, blocked storage, previews). */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem('pilotix.' + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem('pilotix.' + key);
      else localStorage.setItem('pilotix.' + key, value);
    } catch {
      /* storage unavailable: keep working in memory */
    }
  },
};
