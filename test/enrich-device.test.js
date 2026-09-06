'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const { enrichDevice } = require('../src/ingest/enrich-device');

function row(detail) {
  return { EventName: 'Page Viewed', Detail: { ...detail } };
}

// One real user agent per case, so a case that stops matching is a case a real browser hits.
const AGENTS = [
  {
    name: 'an iPhone',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    deviceType: 'mobile',
    browser: 'Safari'
  },
  {
    name: 'an Android phone',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    deviceType: 'mobile',
    browser: 'Chrome'
  },
  {
    name: 'an Android tablet, which says Android without saying Mobile',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    deviceType: 'tablet',
    browser: 'Chrome'
  },
  {
    name: 'an iPad',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1',
    deviceType: 'tablet',
    browser: 'Safari'
  },
  {
    name: 'desktop Chrome',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    deviceType: 'desktop',
    browser: 'Chrome'
  },
  {
    name: 'desktop Edge, which also claims to be Chrome and Safari',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    deviceType: 'desktop',
    browser: 'Edge'
  },
  {
    name: 'desktop Firefox',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    deviceType: 'desktop',
    browser: 'Firefox'
  },
  {
    name: 'Samsung Internet, which also claims to be Chrome',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
    deviceType: 'mobile',
    browser: 'Samsung Internet'
  }
];

for (const agent of AGENTS) {
  test(`${agent.name} is a ${agent.deviceType} running ${agent.browser}`, () => {
    const enriched = enrichDevice(row({ user_agent: agent.userAgent }));
    assert.deepStrictEqual(
      { DeviceType: enriched.DeviceType, Browser: enriched.Browser },
      { DeviceType: agent.deviceType, Browser: agent.browser }
    );
  });
}

// No user agent: a server-side producer, or a client that sends nothing beyond the basics.
const WIDTHS = [
  { width: 390, deviceType: 'mobile' },
  { width: 767, deviceType: 'mobile' },
  { width: 768, deviceType: 'tablet' },
  { width: 1023, deviceType: 'tablet' },
  { width: 1024, deviceType: 'desktop' },
  { width: 2560, deviceType: 'desktop' }
];

for (const { width, deviceType } of WIDTHS) {
  test(`a ${width} pixel screen with no user agent is a ${deviceType}`, () => {
    const enriched = enrichDevice(row({ screen_width: width }));
    assert.strictEqual(enriched.DeviceType, deviceType);
  });
}

test('an event with neither a user agent nor a screen size gets no device type', () => {
  const enriched = enrichDevice(row({}));
  assert.deepStrictEqual(
    { DeviceType: enriched.DeviceType, Browser: enriched.Browser },
    { DeviceType: '', Browser: '' }
  );
});

test('the user agent decides even when the screen is small, because screen.width is the hardware', () => {
  const enriched = enrichDevice(row({
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    screen_width: 640
  }));
  assert.strictEqual(enriched.DeviceType, 'desktop');
});

test('an unrecognised browser leaves the family empty rather than guessing', () => {
  const enriched = enrichDevice(row({ user_agent: 'curl/8.5.0' }));
  assert.strictEqual(enriched.Browser, '');
});

test('the screen size becomes its own columns', () => {
  const enriched = enrichDevice(row({ screen_width: 1512, screen_height: 982 }));
  assert.deepStrictEqual(
    { ScreenW: enriched.ScreenW, ScreenH: enriched.ScreenH },
    { ScreenW: 1512, ScreenH: 982 }
  );
});

test('an implausible screen size is left out rather than stored', () => {
  const enriched = enrichDevice(row({ screen_width: 0, screen_height: 99999 }));
  assert.ok(!('ScreenW' in enriched) && !('ScreenH' in enriched));
});

test('the raw user agent does not survive enrichment', () => {
  const enriched = enrichDevice(row({
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    screen_width: 1920,
    screen_height: 1080,
    viewport_width: 1600
  }));
  assert.deepStrictEqual(enriched.Detail, { viewport_width: 1600 });
});

// Detail comes straight from a request body, so a value that is only on the prototype is one somebody
// else put there, not something this event reported.
test('a value inherited from the prototype is not read as device context', () => {
  const detail = Object.create({
    user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1',
    screen_width: 390
  });

  const enriched = enrichDevice({ EventName: 'Page Viewed', Detail: detail });

  assert.strictEqual(enriched.DeviceType, '');
  assert.strictEqual(enriched.Browser, '');
  assert.ok(!('ScreenW' in enriched));
});
