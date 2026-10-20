'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const winston = require('winston');
const { format, transports } = winston;
const config = require('../config');

const asyncLocalStorage = new AsyncLocalStorage();

const requestIdFormat = format((info) => {
  const store = asyncLocalStorage.getStore();
  if (store && store.requestId) info.requestId = store.requestId;
  return info;
});

// Console only; index.js ships these lines to Application Insights when it is configured.
const isProduction = config.nodeEnv === 'production';

const logger = winston.createLogger({
  level: config.logLevel,
  exitOnError: false,
  transports: [
    new transports.Console({
      handleExceptions: true,
      // Winston defaults everything to stdout, where a failure reads as ordinary host output.
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
  runWithRequestId: (requestId, callback) => asyncLocalStorage.run({ requestId }, callback)
};
