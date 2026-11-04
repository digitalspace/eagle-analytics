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

function within(promise, ms) {
  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

// After one good read of `<uri>` and `<uri>-standby` the fallback (app setting) is dropped, so a value
// retired in the vault stops working within one TTL. `sources`: name -> { uri, fallback }.
function createRotatingSecrets(sources) {
  const vaultSources = Object.entries(sources).filter(([, source]) => source.uri);
  const loaded = new Map();
  let refreshing = null;
  let refreshedAt = 0;
  let firstReady = null;
  let firstSettled = false;

  async function loadOne(name, uri) {
    try {
      const token = await getToken();
      const [current, standby] = await Promise.all([readSecret(uri, token), readSecret(`${uri}-standby`, token)]);
      if (!current) throw new Error(`${uri} answered 404`);
      loaded.set(name, standby ? [current, standby] : [current]);
    } catch (err) {
      const keeping = loaded.has(name) ? 'keeping the values last read' : 'accepting the app setting value';
      logger.warn(`[rotating-secret] ${name}: Key Vault read failed, ${keeping}: ${err.message}`);
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
      refresh();
    }
    return firstSettled ? Promise.resolve() : firstReady;
  }

  function acceptedValues(name) {
    return loaded.get(name) ?? [sources[name].fallback];
  }

  return { ready, acceptedValues };
}

module.exports = {
  createRotatingSecrets,
  _setTokenProvider: (provider) => { getToken = provider; },
  _resetTokenProvider: () => { getToken = managedIdentityToken; }
};
