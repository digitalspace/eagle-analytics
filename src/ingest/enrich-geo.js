'use strict';

/**
 * Coarse location from the caller's address, using the MaxMind GeoLite2 city database.
 *
 * THE ADDRESS ITSELF NEVER LEAVES THIS MODULE. It is not returned, not written to a row and not
 * logged, at any level. Country, region and city are the only things that come out, which is the
 * whole reason the lookup happens server-side instead of the client reporting its own location.
 *
 * The database is a 60 MB blob, not a dependency: it is refreshed monthly by its own workflow, and a
 * Flex Consumption instance fetches it once on the first request it serves. If it cannot be fetched
 * the module says so once and every lookup after that is a no-op — an unenriched row is worth
 * keeping, and a failing enrichment must never cost an event.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const { logger } = require('../utils/logger');
const { safeEqual } = require('../auth/safe-equal');

const GEOIP_CONTAINER = 'geoip';
const GEOIP_BLOB = 'GeoLite2-City.mmdb';

// Survives a warm start, and lets a developer drop their own copy here to work offline.
const CACHE_PATH = path.join(os.tmpdir(), GEOIP_BLOB);

let reader = null;
let loading = null;
let unavailable = false;

const IPV4_PRIVATE = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
  // 100.64.0.0/10, carrier-grade NAT. Shared address space, so it locates a carrier, not a visitor.
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
];

/**
 * Strip what a proxy adds around an address: brackets, and the source port Front Door appends to an
 * IPv4 hop. A bare IPv6 address has several colons, so a port can only be recognised on the
 * bracketed form or on IPv4.
 */
function normalizeIp(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';

  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(raw);
  if (bracketed) return bracketed[1];

  const withPort = /^((?:\d{1,3}\.){3}\d{1,3}):\d+$/.exec(raw);
  if (withPort) return withPort[1];

  return raw;
}

/** Not routable, so there is nothing to look up: private, loopback, link-local or unspecified. */
function isPrivateIp(value) {
  let ip = normalizeIp(value).toLowerCase();
  if (!ip) return true;

  // ::ffff:192.168.1.1 is an IPv4 address wearing an IPv6 hat.
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  if (ip.includes(':')) {
    return ip === '::' || ip === '::1' || ip.startsWith('fe80:') ||
      ip.startsWith('fc') || ip.startsWith('fd');
  }

  return IPV4_PRIVATE.some((range) => range.test(ip));
}

/**
 * Who called, as far as it can be trusted. X-Azure-ClientIP is deliberately not read: Front Door
 * derives it from the caller's own X-Forwarded-For, so the caller controls it. Same trust rule as
 * eagle-api's rateLimitKey helper — the socket address only when the request really came through our
 * Front Door profile.
 */
function clientIp(req) {
  if (config.frontDoorId && safeEqual(req.header('x-azure-fdid'), config.frontDoorId)) {
    const socketIp = normalizeIp(req.header('x-azure-socketip'));
    if (socketIp) return socketIp;
  }

  // The RIGHT-most hop, not the left-most: every entry to its left was written by whoever called us,
  // and the last one is the address the proxy immediately in front of this app appended.
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) return normalizeIp(String(forwarded).split(',').at(-1));

  return '';
}

/** The cached file if there is one, otherwise a fresh copy from the blob container. */
async function databaseFile() {
  if (fs.existsSync(CACHE_PATH)) return CACHE_PATH;
  if (!config.storageAccountName) return null;

  const { BlobServiceClient } = require('@azure/storage-blob');
  const { DefaultAzureCredential } = require('@azure/identity');

  const service = new BlobServiceClient(
    `https://${config.storageAccountName}.blob.core.windows.net`,
    new DefaultAzureCredential()
  );
  const blob = service.getContainerClient(GEOIP_CONTAINER).getBlockBlobClient(GEOIP_BLOB);

  // Downloaded beside the cache and renamed: rename is atomic, so a second worker on the same
  // instance never opens a half-written database.
  const partial = `${CACHE_PATH}.${process.pid}`;
  await blob.downloadToFile(partial);
  fs.renameSync(partial, CACHE_PATH);
  return CACHE_PATH;
}

async function load() {
  try {
    const file = await databaseFile();
    if (file) {
      reader = await require('maxmind').open(file);
      logger.info(`[analytics] GeoLite2 city database loaded from ${file}.`);
      return reader;
    }
  } catch (err) {
    logger.warn(`[analytics] GeoLite2 city database could not be loaded: ${err.message}. ` +
      'Events carry no Country, Region or City.');
    unavailable = true;
    return null;
  }

  logger.warn(`[analytics] no ${GEOIP_BLOB} available. Events carry no Country, Region or City.`);
  unavailable = true;
  return null;
}

/** One load per instance, and one in flight even when the first requests arrive together. */
function ensureReader() {
  if (reader || unavailable) return Promise.resolve(reader);
  if (!loading) {
    loading = load().finally(() => { loading = null; });
  }
  return loading;
}

/**
 * @returns {Promise<{Country?: string, Region?: string, City?: string}>} empty for a private address,
 * an unavailable database or an address the database does not know.
 */
async function geoFields(ip) {
  if (!ip || isPrivateIp(ip)) return {};

  const database = await ensureReader();
  if (!database) return {};

  let found;
  try {
    found = database.get(ip);
  } catch (err) {
    // Message only. A malformed address in a log line is still an address in a log line.
    logger.debug(`[analytics] geo lookup failed: ${err.message}`);
    return {};
  }
  if (!found) return {};

  const fields = {};
  const country = found.country && found.country.iso_code;
  const region = found.subdivisions && found.subdivisions[0] && found.subdivisions[0].iso_code;
  const city = found.city && found.city.names && found.city.names.en;
  if (country) fields.Country = country;
  if (region) fields.Region = region;
  if (city) fields.City = city;
  return fields;
}

module.exports = {
  clientIp,
  geoFields,
  isPrivateIp,
  // Test seam. One reader, one real implementation, so no abstraction over it.
  _setReader: (fake) => { reader = fake; unavailable = fake === null; },
  _reset: () => { reader = null; loading = null; unavailable = false; }
};
