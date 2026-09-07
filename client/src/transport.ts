/** Mirrors the ingest endpoint's `detailBytes` cap; a batch holding a bigger event is rejected whole. */
export const MAX_PROPERTIES_BYTES = 8000;

export interface AnalyticsEvent {
  timestamp: string;
  eventType: string;
  sessionId: string;
  sourceApp: string;
  userId?: string;
  properties?: Record<string, unknown>;
}

export interface TransportOptions {
  url: string;
  batchSize: number;
  doFetch: typeof fetch;
  onError: (err: unknown) => void;
}

export interface Transport {
  enqueue: (event: AnalyticsEvent) => void;
  flush: (useBeacon?: boolean) => Promise<void>;
  size: () => number;
}

/**
 * Drops trailing slashes from a base URL. A scan, not `/\/+$/`: on a long run of
 * slashes that regex backtracks quadratically (CodeQL js/polynomial-redos).
 */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

export function normalizeEventType(eventType: string | undefined): string {
  return eventType?.trim().substring(0, 100) || 'unknown';
}

export function cleanProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!properties) return undefined;
  const entries = Object.entries(properties).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function trySendBeacon(url: string, body: string): boolean {
  if (typeof navigator?.sendBeacon !== 'function') return false;
  try {
    // Ingest is same-origin (Front Door or rproxy path), so a JSON beacon needs no preflight.
    return navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
  } catch {
    return false;
  }
}

export function createTransport({ url, batchSize, doFetch, onError }: TransportOptions): Transport {
  let queue: AnalyticsEvent[] = [];

  const flush = async (useBeacon = false): Promise<void> => {
    if (!queue.length) return;
    const events = queue;
    queue = [];
    const body = JSON.stringify({ events });

    if (useBeacon && trySendBeacon(url, body)) return;

    try {
      await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      });
    } catch (err) {
      // Dropped, not retried: a retry queue on an unload path duplicates rows and grows without bound.
      onError(err);
    }
  };

  return {
    enqueue: (event) => {
      queue.push(event);
      if (queue.length >= batchSize) void flush();
    },
    flush,
    size: () => queue.length,
  };
}
