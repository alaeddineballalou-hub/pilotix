/** localStorage that never throws (private mode, blocked storage, previews). */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem('px.' + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem('px.' + key);
      else localStorage.setItem('px.' + key, value);
    } catch {
      /* storage unavailable */
    }
  },
  json<T>(key: string, fallback: T): T {
    try {
      const v = store.get(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
};
