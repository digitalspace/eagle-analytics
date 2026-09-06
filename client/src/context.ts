/** Page and device context sent with automatic events. */
export function browserContext(enhanced: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    path: window.location.pathname,
    title: document.title,
    referrer: document.referrer || null,
  };
  if (!enhanced) return base;

  return {
    ...base,
    // Full URL only under enhanced tracking: the query string can carry search terms.
    url: window.location.href,
    screen_width: window.screen.width,
    screen_height: window.screen.height,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    user_agent: navigator.userAgent,
    language: navigator.language,
  };
}
