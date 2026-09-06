import { browserContext } from './context.js';
import { clearSession, readSession, type Session } from './session.js';
import { trafficSource } from './traffic.js';
import { cleanProperties, createTransport, MAX_PROPERTIES_BYTES, normalizeEventType } from './transport.js';

export interface AnalyticsConfig {
  /** Ingest base URL or path; events are posted to `${apiUrl}/events`. Empty disables tracking. */
  apiUrl: string;
  sourceApp: string;
  debug?: boolean;
  /** Automatic page views, clicks, heartbeat and session events, with device context. */
  enhancedTracking?: boolean;
  trafficTracking?: boolean;
  fetch?: typeof fetch;
}

export interface Analytics {
  page: (name?: string, properties?: Record<string, unknown>) => void;
  track: (event: string, properties?: Record<string, unknown>) => void;
  identify: (userId: string, traits?: Record<string, unknown>) => void;
  reset: () => void;
  flush: () => Promise<void>;
  destroy: () => void;
}

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'scroll', 'click'] as const;
const ACTIVE_WINDOW_MS = 60_000;
const TEXT_LIMIT = 100;
export const HEARTBEAT_MS = 30_000;
export const BATCH_SIZE = 20;
export const FLUSH_MS = 5_000;

const noopAnalytics: Analytics = {
  page: () => undefined,
  track: () => undefined,
  identify: () => undefined,
  reset: () => undefined,
  flush: () => Promise.resolve(),
  destroy: () => undefined,
};

function text(element: Element | null): string {
  return element?.textContent?.trim().substring(0, TEXT_LIMIT) ?? '';
}

function attribute(element: Element | null, selector: string, name: string): string | null {
  return element?.closest(selector)?.getAttribute(name) || null;
}

export function createAnalytics(config: AnalyticsConfig): Analytics {
  if (!config.apiUrl) return noopAnalytics;

  const debug = config.debug ?? false;
  const enhanced = config.enhancedTracking ?? false;
  const traffic = config.trafficTracking ?? false;

  const log = (message: string, detail?: unknown): void => {
    if (debug) console.warn(`[analytics] ${message}`, detail);
  };

  const transport = createTransport({
    url: `${config.apiUrl.replace(/\/+$/, '')}/events`,
    batchSize: BATCH_SIZE,
    doFetch: config.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    onError: (err) => log('send failed', err),
  });

  let session: Session = readSession();
  let sessionStart = new Date().toISOString();
  let sessionAnnounced = false;
  let userId: string | undefined;
  let lastActivity = Date.now();
  let destroyed = false;

  const send = (eventType: string, properties?: Record<string, unknown>): void => {
    if (destroyed) return;
    const cleaned = cleanProperties(properties);
    if (cleaned && new TextEncoder().encode(JSON.stringify(cleaned)).length > MAX_PROPERTIES_BYTES) {
      // Enqueuing it would cost the whole batch: the server rejects an over-cap batch all-or-nothing.
      log('properties over the size cap, event dropped', { eventType });
      return;
    }
    transport.enqueue({
      timestamp: new Date().toISOString(),
      eventType: normalizeEventType(eventType),
      sessionId: session.id,
      sourceApp: config.sourceApp,
      ...(userId ? { userId } : {}),
      ...(cleaned ? { properties: cleaned } : {}),
    });
  };

  const safe =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args);
      } catch (err) {
        log('handler failed', err);
      }
    };

  const teardown: Array<() => void> = [];
  const on = (
    target: EventTarget,
    type: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, handler, options);
    teardown.push(() => target.removeEventListener(type, handler, options));
  };

  const onClick = safe((event: Event) => {
    const target = event.target as Element | null;
    if (typeof target?.closest !== 'function') return;

    const link = target.closest('a');
    const href = link?.getAttribute('href');
    if (href) {
      send('Link Clicked', {
        link_url: href,
        link_text: text(link),
        link_type: href.startsWith('http') || href.startsWith('//') ? 'external' : 'internal',
        path: window.location.pathname,
        section: attribute(link, '[data-section]', 'data-section'),
      });
      return;
    }

    const button = target.closest<HTMLElement>('button, [role="button"], input[type="submit"]');
    if (!button) return;
    send('Button Clicked', {
      button_text: text(button) || button.getAttribute('aria-label') || 'unknown',
      button_type: button.getAttribute('type') || 'button',
      path: window.location.pathname,
      form_id: button.closest('form')?.id || null,
      section: attribute(button, '[data-section]', 'data-section'),
    });
  });

  const onActivity = safe(() => {
    lastActivity = Date.now();
  });

  const onHeartbeat = safe(() => {
    if (document.visibilityState === 'hidden') return;
    const idleMs = Date.now() - lastActivity;
    send('User Active', {
      path: window.location.pathname,
      is_active: idleMs < ACTIVE_WINDOW_MS,
      seconds_since_activity: Math.floor(idleMs / 1000),
    });
  });

  const endSession = (): void => {
    if (!sessionAnnounced) return;
    sessionAnnounced = false;
    send('Session Ended', {
      session_end: new Date().toISOString(),
      session_start: sessionStart,
      session_id: session.id,
    });
  };

  const onPageHide = safe(() => {
    endSession();
    void transport.flush(true);
  });

  const onVisibilityChange = safe(() => {
    if (document.visibilityState === 'hidden') void transport.flush(true);
  });

  const timers: Array<ReturnType<typeof setInterval>> = [setInterval(safe(() => void transport.flush()), FLUSH_MS)];
  on(window, 'pagehide', onPageHide);
  on(document, 'visibilitychange', onVisibilityChange);

  if (enhanced) {
    // Capture phase: a host handler calling stopPropagation would otherwise hide the click.
    on(document, 'click', onClick, { passive: true, capture: true });
    for (const type of ACTIVITY_EVENTS) on(document, type, onActivity, { passive: true });
    timers.push(setInterval(onHeartbeat, HEARTBEAT_MS));
  }

  const startSession = (): void => {
    if (!enhanced || !session.isNew || sessionAnnounced) return;
    sessionAnnounced = true;
    send('Session Started', {
      session_start: sessionStart,
      session_id: session.id,
      ...browserContext(enhanced),
      ...(traffic ? trafficSource() : null),
    });
  };

  safe(startSession)();

  return {
    page: safe((name?: string, properties?: Record<string, unknown>) => {
      send('Page Viewed', {
        page_name: name ?? 'unknown',
        ...browserContext(enhanced),
        ...(traffic ? trafficSource() : null),
        ...properties,
      });
    }),

    track: safe((event: string, properties?: Record<string, unknown>) => {
      send(event, properties);
    }),

    identify: safe((id: string, traits?: Record<string, unknown>) => {
      userId = id;
      send('User Identified', {
        traits,
        session_id: session.id,
        session_start: sessionStart,
      });
    }),

    reset: safe(() => {
      endSession();
      userId = undefined;
      clearSession();
      session = readSession();
      sessionStart = new Date().toISOString();
      startSession();
    }),

    flush: async () => {
      try {
        await transport.flush();
      } catch (err) {
        log('flush failed', err);
      }
    },

    destroy: safe(() => {
      if (destroyed) return;
      for (const timer of timers) clearInterval(timer);
      for (const off of teardown) off();
      void transport.flush();
      destroyed = true;
    }),
  };
}

export default createAnalytics;
