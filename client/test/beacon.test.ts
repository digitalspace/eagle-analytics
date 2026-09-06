import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create, destroyAll, mockBeacon, mockFetch, removeBeacon, setVisibility } from './helpers.js';

describe('unload delivery', () => {
  beforeEach(() => {
    sessionStorage.clear();
    setVisibility('visible');
  });

  afterEach(() => {
    destroyAll();
    removeBeacon();
  });

  it('sends queued events by beacon on pagehide', async () => {
    const beacon = mockBeacon();
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.track('Leaving');
    window.dispatchEvent(new Event('pagehide'));

    expect(beacon.fn).toHaveBeenCalledOnce();
    expect(http.batches).toHaveLength(0);
    expect(await beacon.events()).toEqual([expect.objectContaining({ eventType: 'Leaving' })]);
    expect(String(beacon.fn.mock.calls[0]?.[0])).toBe('https://ingest.test/analytics/events');
  });

  it('sends a Session Ended event on pagehide when sessions are tracked', async () => {
    const beacon = mockBeacon();
    const http = mockFetch();
    create({ fetch: http.fn, enhancedTracking: true });

    window.dispatchEvent(new Event('pagehide'));

    const types = (await beacon.events()).map((event) => event['eventType']);
    expect(types).toContain('Session Started');
    expect(types).toContain('Session Ended');
  });

  it('sends by beacon when the page becomes hidden', () => {
    const beacon = mockBeacon();
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.track('Backgrounded');
    setVisibility('hidden');

    expect(beacon.fn).toHaveBeenCalledOnce();
    expect(http.batches).toHaveLength(0);
  });

  it('falls back to keepalive fetch when sendBeacon is missing', async () => {
    removeBeacon();
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.track('Leaving');
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(http.batches).toHaveLength(1));
    expect(http.mock.mock.calls[0]?.[1]).toMatchObject({ keepalive: true, method: 'POST' });
  });

  it('falls back to fetch when the browser refuses the beacon', async () => {
    mockBeacon(false);
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.track('Refused');
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(http.batches).toHaveLength(1));
  });
});
