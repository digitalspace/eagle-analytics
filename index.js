'use strict';

// Azure Monitor has to start before anything else is required. The distro instruments modules by
// hooking `require`, so any library loaded ahead of it — http, winston — is captured as the
// uninstrumented original and never reports.
//
// Guarded on the connection string so the test suite runs untouched: no connection string, no
// telemetry, no exporter retry noise. Winston instrumentation is opt-in and is the whole reason the
// logger's output reaches Application Insights.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry');
  useAzureMonitor({
    // CPU, memory and request rate are already collected free as App Service platform metrics,
    // which never enter the workspace and so are not billed per GB or capped by it.
    enablePerformanceCounters: false,
    instrumentationOptions: {
      winston: { enabled: true }
    }
  });
}

const { app } = require('@azure/functions');

// Drain buffered rows before the worker goes away. The Functions host owns this worker's lifecycle
// and recycles it on deploy, config change, scale and idle; work deferred past a response is not
// guaranteed to run, and the writer's flush timer is unref'd so it does not hold the process open.
//
// appTerminate covers graceful shutdown only — Microsoft is explicit that it does not run on a
// forced kill — so this shortens the loss window rather than closing it.
app.hook.appTerminate(async () => {
  await require('./src/ingest/dcr-writer').flush();
});

// ONE catch-all, not one registration per route: see src/http/router.js. The require is lazy so a
// test can load this file against a recording `app`.
const handler = (request) => require('./src/http/router').dispatch(request);

const HTTP = {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  handler
};

app.http('api', { ...HTTP, route: '{*path}' });
app.http('apiRoot', { ...HTTP, route: '' });
