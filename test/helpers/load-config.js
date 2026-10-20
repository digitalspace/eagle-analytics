'use strict';

// config.js reads process.env once at load, so only config and the named module are reloaded; the
// logger keeps the config it first loaded with, and no case here touches it.

/** What a deployed instance always has. A case names only the settings it is actually about. */
const DEPLOYED = Object.freeze({
  APIM_SHARED_HEADER_VALUE: 'gateway-value-for-tests',
  AUDIT_SHARED_HEADER_VALUE: 'audit-value-for-tests',
  KEYCLOAK_ALLOWED_CLIENTS: 'eagle-admin-console',
  ANALYTICS_WORKSPACE_CUSTOMER_ID: 'e1d4a0b2-test-workspace'
});

/** Loads src/<name> (e.g. `auth/apim-header`) under `env`; an `undefined` value unsets that setting. */
function loadModule(name, env = {}) {
  const settings = { ...DEPLOYED, ...env };
  const names = Object.keys(settings);
  const previous = { ...process.env };
  const apply = (source) => {
    for (const setting of names) {
      if (source[setting] === undefined) delete process.env[setting];
      else process.env[setting] = source[setting];
    }
  };

  apply(settings);
  delete require.cache[require.resolve('../../src/config')];
  const target = require.resolve(`../../src/${name}`);
  delete require.cache[target];

  try {
    return require(target);
  } finally {
    apply(previous);
  }
}

module.exports = { loadModule, DEPLOYED };
