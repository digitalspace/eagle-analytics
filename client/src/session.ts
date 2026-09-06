const SESSION_KEY = 'eagle_analytics.session_id';

export interface Session {
  id: string;
  /** False when the tab already had a session, so `Session Started` is not sent twice per tab. */
  isNew: boolean;
}

/** sessionStorage access itself throws in Safari private mode, so even the lookup is guarded. */
function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function newId(): string {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  // Safari below 15.4 has crypto but no randomUUID.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function readSession(): Session {
  const store = storage();
  let existing: string | null;
  try {
    existing = store?.getItem(SESSION_KEY) ?? null;
  } catch {
    existing = null;
  }
  if (existing) return { id: existing, isNew: false };

  const id = newId();
  try {
    store?.setItem(SESSION_KEY, id);
  } catch {
    // Storage blocked or full: the id still holds for the life of this instance.
  }
  return { id, isNew: true };
}

export function clearSession(): void {
  try {
    storage()?.removeItem(SESSION_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Optional data; losing it only costs attribution.
  }
}
