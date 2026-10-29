/** sessionStorage wrappers that never throw (private mode, disabled storage, SSR). */

export function sessionGet<T>(key: string): T | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export function sessionSet(key: string, value: unknown): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the chat still works, it just won't survive a reload.
  }
}

export function sessionRemove(key: string): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Remove every key that starts with `prefix` (e.g. all saved checkout forms on "Start over"). */
export function sessionRemovePrefix(prefix: string): void {
  try {
    if (typeof window === "undefined") return;
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) window.sessionStorage.removeItem(k);
  } catch {
    // ignore
  }
}

/** Saved state of one inline checkout form (this tab only; cleared on success / start over). */
export const CHECKOUT_KEY_PREFIX = "oasis:checkout:";
export const checkoutKey = (draftId: string) => `${CHECKOUT_KEY_PREFIX}${draftId}`;
