import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_MS } from '../src/index.js';
import { create, destroyAll, mockFetch, setVisibility } from './helpers.js';

// jsdom implements neither navigation nor form submission; swallow the default action.
beforeAll(() => {
  document.addEventListener('click', (event) => event.preventDefault());
});

function click(html: string): void {
  document.body.innerHTML = html;
  const target = document.querySelector('[data-click]');
  (target as HTMLElement).click();
}

describe('automatic events', () => {
  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '';
    setVisibility('visible');
  });

  afterEach(() => {
    destroyAll();
    vi.useRealTimers();
  });

  it('tracks a link click through the delegated listener', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, enhancedTracking: true });

    click('<div data-section="documents"><a data-click href="/p/1/docs"> Documents </a></div>');
    await analytics.flush();

    const link = http.events().find((event) => event['eventType'] === 'Link Clicked');
    expect(link?.['properties']).toMatchObject({
      link_url: '/p/1/docs',
      link_text: 'Documents',
      link_type: 'internal',
      section: 'documents',
    });
  });

  it('marks off-site links as external', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, enhancedTracking: true });

    click('<a data-click href="https://engage.example.ca/x">Engage</a>');
    await analytics.flush();

    const link = http.events().find((event) => event['eventType'] === 'Link Clicked');
    expect(link?.['properties']).toMatchObject({ link_type: 'external' });
  });

  it('tracks a button click with its form and label', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, enhancedTracking: true });

    click('<form id="comment-form"><button data-click type="submit" aria-label="ignored">Submit</button></form>');
    await analytics.flush();

    const button = http.events().find((event) => event['eventType'] === 'Button Clicked');
    expect(button?.['properties']).toMatchObject({
      button_text: 'Submit',
      button_type: 'submit',
      form_id: 'comment-form',
    });
  });

  it('falls back to the aria-label of an unlabelled button', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, enhancedTracking: true });

    click('<button data-click aria-label="Close"><svg></svg></button>');
    await analytics.flush();

    const button = http.events().find((event) => event['eventType'] === 'Button Clicked');
    expect(button?.['properties']).toMatchObject({ button_text: 'Close' });
  });

  it('reports one event per click, and a link inside a button counts as a link', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, enhancedTracking: true });

    click('<a href="/x"><span data-click>Deep</span></a>');
    await analytics.flush();

    expect(http.types().filter((type) => type.endsWith('Clicked'))).toEqual(['Link Clicked']);
  });

  it('does not track clicks without enhanced tracking', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    click('<a data-click href="/x">X</a>');
    await analytics.flush();

    expect(http.batches).toHaveLength(0);
  });

  it('stops tracking after destroy', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, enhancedTracking: true });

    analytics.destroy();
    click('<a data-click href="/x">X</a>');
    await analytics.flush();

    expect(http.types()).not.toContain('Link Clicked');
  });

  it('sends a page view with page and device context', async () => {
    const http = mockFetch();
    document.title = 'Project detail';
    const analytics = create({ fetch: http.fn, enhancedTracking: true });

    analytics.page('project-detail', { projectId: 'p1' });
    await analytics.flush();

    const view = http.events().find((event) => event['eventType'] === 'Page Viewed');
    expect(view?.['properties']).toMatchObject({
      page_name: 'project-detail',
      path: window.location.pathname,
      title: 'Project detail',
      projectId: 'p1',
      user_agent: navigator.userAgent,
      language: navigator.language,
      screen_width: window.screen.width,
      viewport_width: window.innerWidth,
    });
  });

  it('leaves device context out when enhanced tracking is off', async () => {
    const http = mockFetch();
    const analytics = create({ fetch: http.fn });

    analytics.page('home');
    await analytics.flush();

    const view = http.events()[0];
    expect(view?.['properties']).toMatchObject({ page_name: 'home', path: window.location.pathname });
    expect(view?.['properties']).not.toHaveProperty('user_agent');
    expect(view?.['properties']).not.toHaveProperty('url');
  });

  it('sends a heartbeat only while the document is visible', async () => {
    vi.useFakeTimers();
    const http = mockFetch();
    const analytics = create({ fetch: http.fn, enhancedTracking: true });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await analytics.flush();
    expect(http.types()).toContain('User Active');

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    await analytics.flush();
    expect(http.types().filter((type) => type === 'User Active')).toHaveLength(1);
  });
});
