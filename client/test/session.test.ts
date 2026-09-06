import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create, destroyAll, mockFetch } from './helpers.js';

const KEY = 'eagle_analytics.session_id';

describe('session and user identity', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    destroyAll();
  });

  it('stores one session id per tab and reuses it', async () => {
    const first = mockFetch();
    const second = mockFetch();

    const a = create({ fetch: first.fn });
    a.track('First');
    await a.flush();

    const stored = sessionStorage.getItem(KEY);
    expect(stored).toBeTruthy();
    expect(first.events()[0]?.['sessionId']).toBe(stored);

    const b = create({ fetch: second.fn });
    b.track('Second');
    await b.flush();
    expect(second.events()[0]?.['sessionId']).toBe(stored);
  });

  it('attaches the user id to every event after identify', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.identify('idir-guid-1', { role: 'staff' });
    analytics.track('Project Edited');
    await analytics.flush();

    expect(http.events()[0]).toMatchObject({
      eventType: 'User Identified',
      userId: 'idir-guid-1',
      properties: { traits: { role: 'staff' } },
    });
    expect(http.events()[1]).toMatchObject({ eventType: 'Project Edited', userId: 'idir-guid-1' });
  });

  it('clears the user and starts a new session on reset', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.identify('idir-guid-1');
    await analytics.flush();
    const before = sessionStorage.getItem(KEY);

    analytics.reset();
    analytics.track('After Logout');
    await analytics.flush();

    const after = sessionStorage.getItem(KEY);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);

    const sent = http.events();
    const last = sent[sent.length - 1];
    expect(last).toMatchObject({ eventType: 'After Logout', sessionId: after });
    expect(last).not.toHaveProperty('userId');
  });

  it('ends and restarts the session on reset when sessions are tracked', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, enhancedTracking: true });

    analytics.reset();
    await analytics.flush();

    expect(http.types()).toEqual(['Session Started', 'Session Ended', 'Session Started']);
  });

  it('does not repeat Session Started for a session the tab already has', async () => {
    const http = mockFetch();
    const first = create({ fetch: http.fn, enhancedTracking: true });
    const second = create({ fetch: http.fn, enhancedTracking: true });

    await first.flush();
    await second.flush();
    expect(http.types().filter((type) => type === 'Session Started')).toHaveLength(1);
  });
});
