'use strict';

const config = require('../config');

/**
 * Liveness only — the process is up. Deliberately claims nothing about the DCR or the workspace: a
 * probe that reports a dependency it never contacted stays green with nothing behind it.
 */
exports.health = (req, res) => res.json({ status: 'ok', env: config.environmentName });
