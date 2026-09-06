import { vi } from 'vitest';
import { createAnalytics, type Analytics, type AnalyticsConfig } from '../src/index.js';

export interface SentBatch {
  url: string;
  events: Array<Record<string, unknown>>;
}

export function mockFetch() {
  const batches: SentBatch[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    batches.push({
      url: String(input),
      events: JSON.parse(String(init?.body)).events as Array<Record<string, unknown>>,
    });
    return { ok: true, status: 202 } as unknown as Response;
  });
  return {
    fn: fn as unknown as typeof fetch,
    mock: fn,
    batches,
    events: () => batches.flatMap((batch) => batch.events),
    types: () => batches.flatMap((batch) => batch.events.map((event) => String(event['eventType']))),
  };
}

/** The jsdom Blob has no text(), so the payload comes back through FileReader. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Records beacon payloads and controls what sendBeacon reports back. */
export function mockBeacon(result = true) {
  const blobs: Blob[] = [];
  const fn = vi.fn((_url: string, body?: BodyInit | null) => {
    if (body instanceof Blob) blobs.push(body);
    return result;
  });
  Object.defineProperty(navigator, 'sendBeacon', { value: fn, configurable: true, writable: true });
  return {
    fn,
    events: async (): Promise<Array<Record<string, unknown>>> => {
      const out: Array<Record<string, unknown>> = [];
      for (const blob of blobs) out.push(...JSON.parse(await readBlob(blob)).events);
      return out;
    },
  };
}

export function removeBeacon(): void {
  Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true, writable: true });
}

export function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

const instances: Analytics[] = [];

export function create(config: Partial<AnalyticsConfig> & { fetch: typeof fetch }): Analytics {
  const instance = createAnalytics({
    apiUrl: 'https://ingest.test/analytics',
    sourceApp: 'test-app',
    ...config,
  });
  instances.push(instance);
  return instance;
}

export function destroyAll(): void {
  while (instances.length) instances.pop()?.destroy();
}
