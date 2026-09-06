import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create, destroyAll, mockFetch } from './helpers.js';

function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { value, configurable: true });
}

async function pageViewProperties(search: string): Promise<Record<string, unknown>> {
  const http = mockFetch();
  window.history.replaceState({}, '', `/projects${search}`);
  const analytics = create({ fetch: http.fn, trafficTracking: true });
  analytics.page('projects');
  await analytics.flush();
  return http.events()[0]?.['properties'] as Record<string, unknown>;
}

describe('traffic source', () => {
  beforeEach(() => {
    sessionStorage.clear();
    setReferrer('');
  });

  afterEach(() => {
    destroyAll();
    window.history.replaceState({}, '', '/');
  });

  it('reads utm parameters from the url and classifies the channel', async () => {
    const properties = await pageViewProperties('?utm_source=google&utm_medium=cpc&utm_campaign=spring');

    expect(properties).toMatchObject({
      traffic_channel: 'search',
      traffic_source: 'google',
      traffic_medium: 'cpc',
      traffic_campaign: 'spring',
    });
  });

  it('keeps the first touch of the tab for later views without utm parameters', async () => {
    await pageViewProperties('?utm_source=newsletter&utm_medium=email');
    const later = await pageViewProperties('');

    expect(later).toMatchObject({
      traffic_channel: 'email',
      traffic_source: 'newsletter',
      first_touch_source: 'newsletter',
      first_touch_medium: 'email',
    });
  });

  it('uses the referrer domain when there are no utm parameters', async () => {
    setReferrer('https://news.example.ca/article/1');
    const properties = await pageViewProperties('');

    expect(properties).toMatchObject({
      traffic_channel: 'referral',
      traffic_source: 'news.example.ca',
      traffic_referrer: 'news.example.ca',
    });
  });

  it('reports direct traffic when there is no referrer and no campaign', async () => {
    const properties = await pageViewProperties('');

    expect(properties).toMatchObject({ traffic_channel: 'direct', traffic_source: null });
  });

  it('adds nothing when traffic tracking is off', async () => {
    const http = mockFetch();
    window.history.replaceState({}, '', '/projects?utm_source=google');
    const analytics = create({ fetch: http.fn });
    analytics.page('projects');
    await analytics.flush();

    expect(http.events()[0]?.['properties']).not.toHaveProperty('traffic_channel');
  });
});
