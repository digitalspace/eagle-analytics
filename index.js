'use strict';

// Must run before any other require: the distro hooks `require`, so a module loaded earlier (http,
// winston) is never instrumented. Winston is opt-in and is how logs reach Application Insights.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry');
  useAzureMonitor({
    // Platform metrics already cover these for free, outside the billed workspace.
    enablePerformanceCounters: false,
    instrumentationOptions: {
      winston: { enabled: true }
    }
  });
}

const { app } = require('@azure/functions');

// The host recycles workers and the flush timer is unref'd, so buffered rows drain here. This hook
// skips forced kills: it shortens the loss window, it does not close it.
app.hook.appTerminate(async () => {
  await require('./src/ingest/dcr-writer').flush();
});

// One catch-all (see src/http/router.js); lazy require so a test can load this with a fake `app`.
const handler = (request) => require('./src/http/router').dispatch(request);

const HTTP = {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  handler
};

app.http('api', { ...HTTP, route: '{*path}' });
app.http('apiRoot', { ...HTTP, route: '' });
