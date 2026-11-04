'use strict';

const { logger } = require('../utils/logger');

const TTL_MS = 5 * 60 * 1000;
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
// read between promote's two writes keeps N; a retired value stops within 2 TTLs.
function createRotatingSecrets(sources) {
  const vaultSources = Object.entries(sources).filter(([, source]) => source.uri);
  const loaded = new Map();
  let refreshing = null;
  let refreshedAt = 0;
  let firstReady = null;
  let firstSettled = false;

  async function loadOne(name, uri) {
    try {
      // The managed identity path ignores an abort signal, and a hung token would pin `refreshing`.
      const token = await within(getToken(), READ_TIMEOUT_MS, new Error('token request timed out'));
      // The rotator writes standby before name, so reading name first never pairs a new name with
      // a standby read before its write: that pair would drop the value APIM may still stamp.
      const current = await readSecret(uri, token);
      if (!current) throw new Error(`${uri} answered 404`);
      const standby = await readSecret(`${uri}-standby`, token);
      const read = standby ? [current, standby] : [current];
      loaded.set(name, { previous: loaded.get(name)?.current ?? [], current: read });
    } catch (err) {
      const keeping = loaded.has(name) ? 'keeping the values last read' : 'accepting the app setting value';
      logger.warn(`[rotating-secret] ${name}: Key Vault read failed, ${keeping}: ${err?.message ?? String(err)}`);
    }
  }

  function refresh() {
    refreshedAt = Date.now();
    refreshing = Promise.all(vaultSources.map(([name, source]) => loadOne(name, source.uri)))
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  /** Resolves once the first read settles, or after 3 s; later calls only start a refresh when due. */
  function ready() {
    if (vaultSources.length === 0) return Promise.resolve();
    if (!firstReady) {
      firstReady = within(refresh().then(() => { firstSettled = true; }), READY_CAP_MS);
    } else if (!refreshing && Date.now() - refreshedAt >= TTL_MS) {
      refresh().catch(() => {});
    }
    return firstSettled ? Promise.resolve() : firstReady;
  }

  function acceptedValues(name) {
    const reads = loaded.get(name);
    return reads ? [...new Set([...reads.current, ...reads.previous])] : [sources[name].fallback];
  }

  return { ready, acceptedValues };
}

module.exports = {
  createRotatingSecrets,
  _setTokenProvider: (provider) => { getToken = provider; },
  _resetTokenProvider: () => { getToken = managedIdentityToken; }
};
