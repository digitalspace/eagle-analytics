'use strict';

const config = require('../config');

// Liveness only: a probe reporting a dependency it never contacted stays green with nothing behind it.
exports.health = (req, res) => res.json({ status: 'ok', env: config.environmentName });
