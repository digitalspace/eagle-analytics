import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATCH_SIZE, FLUSH_MS } from '../src/index.js';
import { MAX_PROPERTIES_BYTES, trimTrailingSlashes } from '../src/transport.js';
import { create, destroyAll, mockFetch } from './helpers.js';

/** Properties whose JSON is exactly `bytes` long; the key and quotes around the value cost the rest. */
function sizedProperties(bytes: number): Record<string, unknown> {
  return { blob: 'x'.repeat(bytes - JSON.stringify({ blob: '' }).length) };
}

describe('batching and flush timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });

  afterEach(() => {
    destroyAll();
    vi.useRealTimers();
  });

  it('holds events until the batch size is reached', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });
    const names = Array.from({ length: BATCH_SIZE }, (_, index) => `Event ${index + 1}`);

    // Timers stay parked, so only a full batch can trigger the send.
    for (const [index, name] of names.entries()) {
      analytics.track(name);
      if (index < names.length - 1) expect(http.batches).toHaveLength(0);
    }

    await vi.waitFor(() => expect(http.batches).toHaveLength(1));
    expect(http.batches[0]?.events).toHaveLength(BATCH_SIZE);
    expect(http.types()).toEqual(names);
  });

  it('flushes a partial batch on the flush interval', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.track('Waited');
    await vi.advanceTimersByTimeAsync(FLUSH_MS - 1);
    expect(http.batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(http.batches).toHaveLength(1);
    expect(http.batches[0]?.events).toHaveLength(1);
  });

  it('posts the penguin batch shape to /events', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, apiUrl: 'https://ingest.test/analytics/' });

    analytics.track('Document Downloaded', { documentId: 'abc', missing: undefined });
    await analytics.flush();

    expect(http.batches[0]?.url).toBe('https://ingest.test/analytics/events');
    const event = http.batches[0]?.events[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      eventType: 'Document Downloaded',
      sourceApp: 'test-app',
      properties: { documentId: 'abc' },
    });
    expect(event['properties']).not.toHaveProperty('missing');
    expect(typeof event['timestamp']).toBe('string');
    expect(typeof event['sessionId']).toBe('string');
    expect(event).not.toHaveProperty('userId');
  });

  it('drops properties entirely when nothing is left after cleaning', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.track('Bare', { gone: undefined });
    await analytics.flush();

    expect(http.batches[0]?.events[0]).not.toHaveProperty('properties');
  });

  it('trims the event type to 100 characters', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.track(`  ${'x'.repeat(200)}  `);
    await analytics.flush();

    expect(String(http.batches[0]?.events[0]?.['eventType'])).toHaveLength(100);
  });

  it('never rejects into the host app when the request fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const analytics = create({ fetch: failing });

    analytics.track('Lost');
    await expect(analytics.flush()).resolves.toBeUndefined();
  });

  it('sends nothing when the queue is empty', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    await analytics.flush();
    expect(http.batches).toHaveLength(0);
  });
});

describe('oversized properties', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    destroyAll();
    vi.restoreAllMocks();
  });

  it('sends an event whose properties sit exactly on the cap', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });
    const properties = sizedProperties(MAX_PROPERTIES_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(properties)).length).toBe(MAX_PROPERTIES_BYTES);

    analytics.track('At Cap', properties);
    await analytics.flush();

    expect(http.types()).toEqual(['At Cap']);
  });

  it('drops an event over the cap, reports it, and keeps the rest of the batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, debug: true });

    analytics.track('Over Cap', sizedProperties(MAX_PROPERTIES_BYTES + 1));
    analytics.track('Small', { ok: true });
    await analytics.flush();

    expect(http.types()).toEqual(['Small']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('event dropped'), { eventType: 'Over Cap' });
  });
});

describe('base URL trimming', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    destroyAll();
  });

  it.each([
    ['https://ingest.test/analytics', 'https://ingest.test/analytics'],
    ['https://ingest.test/analytics/', 'https://ingest.test/analytics'],
    ['https://ingest.test/analytics/////', 'https://ingest.test/analytics'],
    ['/analytics/', '/analytics'],
    ['/', ''],
    ['', ''],
  ])('trims %s to %s', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });

  it('finishes fast on long runs of slashes', () => {
    // The old /\/+$/ needed ~13s on the second string: the run matches, $ fails, and the
    // engine retries from every offset. A scan is linear, so both land in well under 100ms.
    const allSlashes = 'https://ingest.test' + '/'.repeat(100_000);
    const slashesThenText = allSlashes + 'a';

    const started = performance.now();
    expect(trimTrailingSlashes(allSlashes)).toBe('https://ingest.test');
    expect(trimTrailingSlashes(slashesThenText)).toBe(slashesThenText);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('posts to a single-slash /events path however the base URL is written', async () => {
    const http = mockFetch();
    const analytics = create({ apiUrl: 'https://ingest.test/analytics///', fetch: http.fn });

    analytics.track('Trimmed');
    await analytics.flush();

    expect(http.batches[0]?.url).toBe('https://ingest.test/analytics/events');
  });
});
