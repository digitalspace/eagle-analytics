import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalytics } from '../src/index.js';

describe('no-op instance', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('sends nothing and starts no timers when apiUrl is empty', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const analytics = createAnalytics({
      apiUrl: '',
      sourceApp: 'test-app',
      enhancedTracking: true,
      trafficTracking: true,
      fetch: send as unknown as typeof fetch,
    });

    analytics.page('home');
    analytics.track('Anything');
    analytics.identify('idir-guid-1');
    analytics.reset();

    // jsdom does not implement navigation; swallow the default action.
    document.addEventListener('click', (event) => event.preventDefault());
    document.body.innerHTML = '<a id="link" href="/x">X</a>';
    document.getElementById('link')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => analytics.destroy()).not.toThrow();
  });
});
