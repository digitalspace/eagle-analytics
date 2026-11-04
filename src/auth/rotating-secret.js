'use strict';

const { logger } = require('../utils/logger');

const TTL_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const READY_CAP_MS = 3000;
const READ_TIMEOUT_MS = 10000;
const VAULT_SCOPE = 'https://vault.azure.net/.default';

let credential = null;

async function managedIdentityToken() {
  if (!credential) {
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = new DefaultAzureCredential();
  }
  return (await credential.getToken(VAULT_SCOPE)).token;
}

let getToken = managedIdentityToken;

/** The latest version's value, or null when the secret does not exist. */
async function readSecret(uri, token) {
  const response = await fetch(`${uri}?api-version=7.4`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${uri} answered ${response.status}`);
  const { value } = await response.json();
  return typeof value === 'string' ? value.trim() : null;
}

/** Settles with `promise`, or after `ms`: resolved, or rejected with `timeoutError` when given. */
function within(promise, ms, timeoutError) {
  let timer;
  const cap = new Promise((resolve, reject) => {
    timer = setTimeout(() => (timeoutError ? reject(timeoutError) : resolve()), ms);
    timer.unref?.();
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

// The fallback (app setting) is dropped after one good read. The last two good reads are accepted, so a
// read between promote's two writes keeps N; a retired value stops within 2 TTLs, requests or not.
function createRotatingSecrets(sources) {
  const vaultSources = Object.entries(sources).filter(([, source]) => source.uri);
  const loaded = new Map();
  const reading = new Map();
  let retry = null;
  let firstReady = null;
  let firstSettled = false;

  async function loadOne(name, uri) {
    try {
      // The managed identity path ignores an abort signal, and a hung token would pin `reading`.
      const token = await within(getToken(), READ_TIMEOUT_MS, new Error('token request timed out'));
      // The rotator writes standby before name, so reading name first never pairs a new name with
      // a standby read before its write: that pair would drop the value APIM may still stamp.
      const current = await readSecret(uri, token);
      if (!current) throw new Error(`${uri} answered 404`);
      const standby = await readSecret(`${uri}-standby`, token);
      const read = standby ? [current, standby] : [current];
      loaded.set(name, { previous: loaded.get(name)?.current ?? [], current: read, readAt: Date.now() });
    } catch (err) {
      const keeping = loaded.has(name) ? 'keeping the values last read' : 'accepting the app setting value';
      logger.warn(`[rotating-secret] ${name}: Key Vault read failed, ${keeping}: ${err?.message ?? String(err)}`);
    }
  }

  // One read per source at a time: overlapping reads would land as two generations and push the older
  // read out early. Keyed per source, so a retry of one source never stands in for a full refresh.
  function readOnce(name, uri) {
    if (!reading.has(name)) reading.set(name, loadOne(name, uri).finally(() => reading.delete(name)));
    return reading.get(name);
  }

  function refresh(targets = vaultSources) {
    return Promise.all(targets.map(([name, source]) => readOnce(name, source.uri))).finally(() => {
      const unread = vaultSources.filter(([name]) => !loaded.has(name));
      if (retry || unread.length === 0) return;
      retry = setTimeout(() => { retry = null; refresh(unread); }, RETRY_MS);
      retry.unref?.();
    });
  }

  /** Resolves once the first read settles, or after 3 s; the first call also starts the refresh timer. */
  function ready() {
    if (vaultSources.length === 0) return Promise.resolve();
    if (!firstReady) {
      firstReady = within(refresh().then(() => { firstSettled = true; }), READY_CAP_MS);
      setInterval(() => refresh(), TTL_MS).unref?.();
    }
    return firstSettled ? Promise.resolve() : firstReady;
  }

  function acceptedValues(name) {
    const reads = loaded.get(name);
    if (!reads) return [sources[name].fallback];
    // While reads fail, the previous read would otherwise stay accepted for as long as the vault is down.
    const previous = Date.now() - reads.readAt < 2 * TTL_MS ? reads.previous : [];
    return [...new Set([...reads.current, ...previous])];
  }

  return { ready, acceptedValues };
}

module.exports = {
  createRotatingSecrets,
  _setTokenProvider: (provider) => { getToken = provider; },
  _resetTokenProvider: () => { getToken = managedIdentityToken; }
};
