'use strict';

/**
 * Device context from what the client already sent. No lookup and no library: a coarse form factor
 * and a browser family are everything the dashboards group by, and both are readable off the user
 * agent string.
 *
 * The raw user agent leaves with them. It is the single most identifying thing a browser hands over,
 * it is not needed once the family is known, and a 400-day table is the wrong place to keep it.
 */

// Consumed here, so none of them stay in Detail.
const DEVICE_PROPERTIES = Object.freeze(['user_agent', 'screen_width', 'screen_height']);

const TABLET_UA = /ipad|tablet|kindle|silk|playbook/;
const MOBILE_UA = /mobi|iphone|ipod|iemobile|blackberry|opera mini|windows phone/;

// First match wins, so the impostors come first: Edge, Opera and Samsung Internet all claim Chrome,
// and Chrome claims Safari.
const BROWSER_FAMILIES = Object.freeze([
  [/edg(e|a|ios)?\//, 'Edge'],
  [/opr\/|opera/, 'Opera'],
  [/samsungbrowser/, 'Samsung Internet'],
  [/firefox\/|fxios\//, 'Firefox'],
  [/chrome\/|crios\//, 'Chrome'],
  [/safari\//, 'Safari'],
  [/msie |trident\//, 'Internet Explorer']
]);

/**
 * The user agent decides when there is one: screen.width is the physical screen, so a desktop
 * plugged into a small monitor is still a desktop. Width is the fallback for a producer that sends
 * no user agent, which is every server-side one.
 */
function deviceType(userAgent, screenWidth) {
  if (userAgent) {
    if (TABLET_UA.test(userAgent)) return 'tablet';
    // Android tablets carry 'Android' without 'Mobile'; phones carry both.
    if (/android/.test(userAgent) && !/mobile/.test(userAgent)) return 'tablet';
    if (MOBILE_UA.test(userAgent)) return 'mobile';
    return 'desktop';
  }

  if (screenWidth === undefined) return '';
  if (screenWidth < 768) return 'mobile';
  if (screenWidth < 1024) return 'tablet';
  return 'desktop';
}

function browserFamily(userAgent) {
  for (const [pattern, family] of BROWSER_FAMILIES) {
    if (pattern.test(userAgent)) return family;
  }
  return '';
}

/** A plausible screen dimension, or undefined. Above 20000 is a bug or a lie, not a monitor. */
function pixels(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 20000 ? number : undefined;
}

/**
 * Fills DeviceType, Browser, ScreenW and ScreenH from the row's own Detail, and takes what it read
 * out of Detail. Mutates and returns the row.
 */
function enrichDevice(row) {
  const detail = row.Detail;
  // Own properties only: everything here comes from a request body, and a value inherited from
  // Object.prototype is one somebody else put there.
  const own = (key) => (Object.hasOwn(detail, key) ? detail[key] : undefined);

  const rawAgent = own('user_agent');
  const userAgent = typeof rawAgent === 'string' ? rawAgent.toLowerCase() : '';
  const width = pixels(own('screen_width'));
  const height = pixels(own('screen_height'));

  for (const key of DEVICE_PROPERTIES) delete detail[key];

  row.DeviceType = deviceType(userAgent, width);
  row.Browser = browserFamily(userAgent);
  if (width !== undefined) row.ScreenW = width;
  if (height !== undefined) row.ScreenH = height;

  return row;
}

module.exports = { enrichDevice };
