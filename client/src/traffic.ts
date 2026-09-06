import { readStored, writeStored } from './session.js';

const FIRST_TOUCH_KEY = 'eagle_analytics.first_touch';

interface Touch {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
}

function determineChannel(source: string | null, medium: string | null): string {
  const src = source?.toLowerCase() ?? '';
  const med = medium?.toLowerCase() ?? '';

  if (src.includes('chatgpt') || src.includes('claude') || src.includes('perplexity') || src.includes('gemini')) {
    return 'chatbot';
  }
  if (med === 'email' || src.includes('mail')) return 'email';
  if (med.includes('cpc') || med.includes('ppc') || src === 'google' || src === 'bing') return 'search';
  if (med === 'social' || /facebook|twitter|linkedin|instagram|youtube/.test(src)) return 'social';
  if (src && src.includes(window.location.hostname)) return 'internal';
  if (src) return 'referral';
  return 'other';
}

function fromUrl(): Touch | null {
  const params = new URLSearchParams(window.location.search);
  const touch: Touch = {
    source: params.get('utm_source'),
    medium: params.get('utm_medium'),
    campaign: params.get('utm_campaign'),
    content: params.get('utm_content'),
    term: params.get('utm_term'),
  };
  return touch.source || touch.medium ? touch : null;
}

function referrerHost(): string | null {
  if (!document.referrer) return null;
  try {
    return new URL(document.referrer).hostname || null;
  } catch {
    return null;
  }
}

function fromReferrer(): Touch | null {
  const host = referrerHost();
  if (!host || host === window.location.hostname) return null;
  return { source: host, medium: 'referral', campaign: null, content: null, term: null };
}

function readFirstTouch(): Touch | null {
  const raw = readStored(FIRST_TOUCH_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Touch;
  } catch {
    return null;
  }
}

/** Traffic attribution for the current view, plus the first touch of this tab session. */
export function trafficSource(): Record<string, string | null> | null {
  try {
    const current = fromUrl() ?? fromReferrer();
    let first = readFirstTouch();
    if (!first && current) {
      first = current;
      writeStored(FIRST_TOUCH_KEY, JSON.stringify(current));
    }

    const touch = current ?? first;
    if (!touch) {
      return { traffic_channel: 'direct', traffic_source: null, traffic_medium: null, traffic_referrer: null };
    }

    return {
      traffic_channel: determineChannel(touch.source, touch.medium),
      traffic_source: touch.source,
      traffic_medium: touch.medium,
      traffic_campaign: touch.campaign,
      traffic_content: touch.content,
      traffic_term: touch.term,
      traffic_referrer: referrerHost(),
      first_touch_source: first?.source ?? null,
      first_touch_medium: first?.medium ?? null,
      first_touch_campaign: first?.campaign ?? null,
    };
  } catch {
    // Attribution is optional; never let it break a page view.
    return null;
  }
}
