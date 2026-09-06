'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const winston = require('winston');
const { format, transports } = winston;
const config = require('../config');

const asyncLocalStorage = new AsyncLocalStorage();

// Pulls the current request id onto every line written inside runWithRequestId.
const requestIdFormat = format((info) => {
  const store = asyncLocalStorage.getStore();
  if (store && store.requestId) info.requestId = store.requestId;
  return info;
});

// stdout only. Shipping to Application Insights is wired in index.js, which starts the Azure
// Monitor OpenTelemetry distro with winston instrumentation; with no connection string (local
// development, tests) nothing starts and this stays a plain stdout logger.
const isProduction = config.nodeEnv === 'production';

const logger = winston.createLogger({
  level: config.logLevel,
  exitOnError: false,
  transports: [
    new transports.Console({
      handleExceptions: true,
      // Errors on stderr, everything else on stdout. Winston writes the lot to stdout by default, so
      // without this a failure reads as ordinary output in the host's log stream.
      stderrLevels: ['error'],
      format: format.combine(
        format.errors({ stack: true }),
        requestIdFormat(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        isProduction
          ? format.json()
          : format.printf(({ timestamp, level, message, requestId, stack }) => {
              const reqTag = requestId ? ` [${requestId}]` : '';
              return `${timestamp} ${level.toUpperCase()}${reqTag}: ${stack ? `${message}\n${stack}` : message}`;
            })
      )
    })
  ]
});

module.exports = {
  logger,
  /** Run a handler with a request id attached to every log line it writes. */
  runWithRequestId: (requestId, callback) => asyncLocalStorage.run({ requestId }, callback)
};
