// Event and audit store for EPIC product analytics — `analytics-logs-<env>`.
//
// WHY ITS OWN WORKSPACE. The application-log workspaces (`eagle-logs-<env>`, `demi-logs-<env>`)
// carry `workspaceCapping.dailyQuotaGb`, which STOPS COLLECTION for the rest of the UTC day once
// hit. That is the right backstop for a runaway log loop and the wrong behaviour for an analytics
// series and an audit trail: a chatty error path would take the record down with it. A separate,
// uncapped workspace keeps both, and read access to analytics becomes a deliberate grant rather
// than a side effect of Reader on a monitored resource.
//
// NO `workspaceCapping` HERE, deliberately. The cost guard is elsewhere and layered: a per-session and
// a per-address event cap in the ingest Function — APIM Consumption has no rate-limit-by-key, so both
// live in the app — and the forecast notification on `analytics-budget-<env>`.
//
// TABLES
//   EagleEvents_CL       raw product events, 400 days (thirteen months: this month against the
//                        same month last year, and no longer)
//   EagleAudit_CL        EPIC-wide staff audit trail, 730 interactive / 2556 total
//   EagleEventsDaily_CL  daily rollup written by the summary rule, 730 days
//
// All three are Analytics plan, not Auxiliary. Unlike DEMI's `DemiEvents_CL`, this store is the
// backing table of a self-serve dashboard builder: interactive queries have to cost nothing, or
// every chart a member of staff draws is a bill.

@description('Location for the workspace and data collection rule. Both must share a region.')
param location string = resourceGroup().location

@description('Environment name (e.g. test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Principal IDs granted publish-only rights on the DCR: the analytics identity, and the DEMI identity, which writes its audit rows straight to this pipeline.')
param publisherPrincipalIds array

@description('Principal IDs granted Log Analytics Reader on this workspace. The DEMI identity is one: eagle-demi\'s GET /admin/audit reads the union of its own rows and EagleAudit_CL, so it needs read on the workspace holding the second half.')
param readerPrincipalIds array = []

@description('Resource ID of the APPLICATION logs workspace behind eagle-insights-<env>. The ingest writer reports its own dropped batches to that logger, so the alert below queries that workspace, not this one. Empty skips the alert.')
param appLogsWorkspaceId string = ''

@description('Action group notified when the ingest pipeline drops rows. Empty deploys the rule with no notification, which still records the alert in Azure Monitor.')
param alertActionGroupId string = ''

var workspaceName = 'analytics-logs-${environmentName}'
var dcrName = 'analytics-dcr-${environmentName}'
var eventsTableName = 'EagleEvents_CL'
var auditTableName = 'EagleAudit_CL'
var dailyTableName = 'EagleEventsDaily_CL'

// 2556 and NOT 2555, which is what 7 x 365 gives and what the API rejects: past two years, total
// retention must be a whole number of years drawn from a fixed list — 1095, 1460, 1826, 2191, 2556,
// 2922, 3288, 3653, 4018, 4383. Anything else fails the deployment with InvalidParameter. 730 is
// the platform maximum for interactive retention; the rest sits in long-term retention and comes
// back through a search job.
var eventsRetentionDays = 400
var auditInteractiveDays = 730
var auditTotalDays = 2556
var dailyRetentionDays = 730

// Column sets are declared once and used twice: once as the table schema, once as the DCR stream
// declaration. They must agree, and a single source is the only way to keep them agreeing.
//
// Fixed columns exist for anything ever filtered or grouped on — which is exactly the dimension
// list the dashboard builder offers. Everything else goes in `Detail`, which is dynamic, so a new
// event type is a new value rather than a schema change.
//
// NO SourceIp COLUMN. The ingest Function resolves coarse geo from the address and drops it before
// writing, so there is nothing here to mask: `EagleEvents_CL | where isnotempty(SourceIp)` cannot
// return rows because the column does not exist. Sessions are per-tab and anonymous; UserId is set
// only by the staff apps, which authenticate.
var eventsColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'EventName', type: 'string' }
  { name: 'SourceApp', type: 'string' }
  { name: 'SessionId', type: 'string' }
  { name: 'UserId', type: 'string' }
  { name: 'Page', type: 'string' }
  { name: 'Referrer', type: 'string' }
  { name: 'ProjectId', type: 'string' }
  { name: 'DocumentId', type: 'string' }
  { name: 'Country', type: 'string' }
  { name: 'Region', type: 'string' }
  { name: 'City', type: 'string' }
  { name: 'DeviceType', type: 'string' }
  { name: 'Browser', type: 'string' }
  { name: 'ScreenW', type: 'int' }
  { name: 'ScreenH', type: 'int' }
  { name: 'DurationMs', type: 'real' }
  { name: 'Env', type: 'string' }
  { name: 'Detail', type: 'dynamic' }
]

// The DEMI audit schema plus `SourceApp`: this table is EPIC-wide, so a row has to say which
// application produced it. DEMI's own `auditEvent()` writes here through the same DCR.
//
// Both actor identifiers, deliberately. `ActorId` is the Keycloak `sub`, stable across a rename and
// what joins back to the realm; `ActorName` is what a human reads without going and asking Keycloak
// who a UUID is. An audit trail that needs a second system online to answer "who did this" is worse
// than one that does not.
var auditColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'EventId', type: 'string' }
  { name: 'Action', type: 'string' }
  { name: 'Outcome', type: 'string' }
  { name: 'ActorId', type: 'string' }
  { name: 'ActorName', type: 'string' }
  { name: 'ActorType', type: 'string' }
  { name: 'ActorRoles', type: 'string' }
  { name: 'SourceApp', type: 'string' }
  { name: 'SourceIp', type: 'string' }
  { name: 'TargetType', type: 'string' }
  { name: 'TargetId', type: 'string' }
  { name: 'ProjectId', type: 'string' }
  { name: 'CorrelationId', type: 'string' }
  { name: 'Env', type: 'string' }
  { name: 'Detail', type: 'dynamic' }
]

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    // Workspace default, which the custom tables below all override. 90 rather than 30 because the
    // Azure-owned tables that arrive here on their own — AppServiceAuditLogs from the Function's
    // diagnostic setting — inherit this number, and who deployed the ingest API is worth more than
    // a month. Those tables hold kilobytes, so the retention charge is noise.
    retentionInDays: 90
    features: {
      // FALSE, and true on the application-log workspaces. Reading the analytics record is not an
      // attribute of any monitored resource; it should be a deliberate grant on this workspace.
      enableLogAccessUsingOnlyResourcePermissions: false
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// API version 2025-07-01 is load-bearing: 2023-09-01 accepts only 'Analytics' and 'Basic' for
// `plan`, and rejects `totalRetentionInDays` past the interactive maximum.
resource eventsTable 'Microsoft.OperationalInsights/workspaces/tables@2025-07-01' = {
  parent: workspace
  name: eventsTableName
  properties: {
    plan: 'Analytics'
    retentionInDays: eventsRetentionDays
    totalRetentionInDays: eventsRetentionDays
    schema: {
      name: eventsTableName
      columns: eventsColumns
    }
  }
}

resource auditTable 'Microsoft.OperationalInsights/workspaces/tables@2025-07-01' = {
  parent: workspace
  name: auditTableName
  properties: {
    plan: 'Analytics'
    retentionInDays: auditInteractiveDays
    totalRetentionInDays: auditTotalDays
    schema: {
      name: auditTableName
      columns: auditColumns
    }
  }
}

// Written twice, same as the two above: once as the table schema, once as the DCR stream the history
// import posts to.
//
// The summary rule adds four `_`-prefixed columns to this table that the tables API refuses in a
// PUT (MSG 1008, invalid characters), so what-if reports them as a delete on every run; the
// deployment leaves them in place and the rule keeps writing (observed 2026-09-06 on test).
var dailyColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'Day', type: 'datetime' }
  { name: 'SourceApp', type: 'string' }
  { name: 'EventName', type: 'string' }
  { name: 'Page', type: 'string' }
  { name: 'ProjectId', type: 'string' }
  { name: 'Country', type: 'string' }
  { name: 'DeviceType', type: 'string' }
  { name: 'Env', type: 'string' }
  // count() and dcount() are long. A type mismatch here breaks the summary rule's write rather than
  // the deployment, so these track its query below.
  { name: 'Events', type: 'long' }
  { name: 'Sessions', type: 'long' }
  { name: 'Users', type: 'long' }
]

// The rollup destination is declared rather than left to the summary rule.
//
// The rule creates the table on its first run if it is absent, but it creates it with the WORKSPACE
// default retention. A rollup that expires before the raw events it summarises cannot answer "this
// month against the same month last year", which is most of why it exists.
//
// `Day` is ours, not the rule's. The Logs Ingestion API overwrites `TimeGenerated` on rows older
// than two days, so the penguin-analytics history import (WP9) cannot backdate rows through it —
// the real date has to travel in a column of its own. The summary rule fills the same column, so
// imported history and live rollups are queried identically.
resource dailyTable 'Microsoft.OperationalInsights/workspaces/tables@2025-07-01' = {
  parent: workspace
  name: dailyTableName
  properties: {
    plan: 'Analytics'
    retentionInDays: dailyRetentionDays
    totalRetentionInDays: dailyRetentionDays
    schema: {
      name: dailyTableName
      columns: dailyColumns
    }
  }
}

// `kind: 'Direct'` is what lets a client POST straight to the rule's own ingestion endpoint. The
// alternative is a Data Collection Endpoint resource, which is only needed to put ingestion behind
// Private Link — and this landing zone's `Deny-PublicPaaSEndpoints` policy applies to PaaS
// accounts, not to the Microsoft-managed endpoint a Direct DCR exposes.
resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: dcrName
  location: location
  tags: tags
  kind: 'Direct'
  properties: {
    streamDeclarations: {
      'Custom-${eventsTableName}': {
        columns: eventsColumns
      }
      'Custom-${auditTableName}': {
        columns: auditColumns
      }
      // The summary rule writes the rollup table directly and needs no stream. This one exists for
      // scripts/import-penguin-history.js, which posts historical rollup rows through the ingestion
      // API — the only way into the table from outside the workspace.
      'Custom-${dailyTableName}': {
        columns: dailyColumns
      }
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: workspace.id
          name: 'analyticsWorkspace'
        }
      ]
    }
    dataFlows: [
      {
        streams: [ 'Custom-${eventsTableName}' ]
        destinations: [ 'analyticsWorkspace' ]
        outputStream: 'Custom-${eventsTableName}'
        // Identity minimisation already happened in the ingest Function, and the stream declares no
        // SourceIp column — so there is nothing to strip. `project-away SourceIp` here would fail
        // the transform on a column that does not exist.
        transformKql: 'source'
      }
      {
        streams: [ 'Custom-${auditTableName}' ]
        destinations: [ 'analyticsWorkspace' ]
        outputStream: 'Custom-${auditTableName}'
        // The IP mask lives HERE rather than in the app, so it cannot be bypassed by whatever calls
        // the ingestion endpoint — including DEMI, which writes audit rows directly. Keeps the first
        // two octets, enough to tell "inside the gov network" from "not", and drops anything that is
        // not dotted-quad (IPv6, 'unknown') to 'redacted' rather than passing it through unmasked.
        //
        // `extract` is called twice instead of stashing a temp column: a transform's output columns
        // must match the destination table, and a leftover scratch column is one more thing to strip.
        transformKql: 'source | extend SourceIp = iff(isempty(extract(@"^(\\d{1,3}\\.\\d{1,3})\\.", 1, SourceIp)), "redacted", strcat(extract(@"^(\\d{1,3}\\.\\d{1,3})\\.", 1, SourceIp), ".0.0"))'
      }
      {
        streams: [ 'Custom-${dailyTableName}' ]
        destinations: [ 'analyticsWorkspace' ]
        outputStream: 'Custom-${dailyTableName}'
        transformKql: 'source'
      }
    ]
  }
  dependsOn: [
    eventsTable
    auditTable
    dailyTable
  ]
}

// Monitoring Metrics Publisher. Publish-only: the right to SEND data to this rule and no right to
// read anything back. A writer is not a reader.
var monitoringMetricsPublisherRoleId = '3913510d-42f4-4e42-8a64-420c390055eb'

resource publisherAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in publisherPrincipalIds: {
    scope: dcr
    name: guid(dcr.id, principalId, monitoringMetricsPublisherRoleId)
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisherRoleId)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

// Log Analytics Reader on the workspace, for a principal that reads the record without running this
// API — eagle-demi, whose audit viewer unions EagleAudit_CL with its own rows. On the workspace and
// not the DCR: reading is not what a publisher grant covers.
var logAnalyticsReaderRoleId = '73c42c96-874c-492b-b04d-ab87d138a893'

resource readerAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in readerPrincipalIds: {
    scope: workspace
    name: guid(workspace.id, principalId, logAnalyticsReaderRoleId)
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logAnalyticsReaderRoleId)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

// No time filter and no bin on the aggregation window: `binSize` already defines it, and the
// destination rows carry `_BinStartTime`. `Day` is projected anyway because the history import needs
// the column, and at binSize 1440 the day bin and the rule's own bin coincide.
//
// `isActive` is absent because it cannot be set: it is read-only on this type (bicep BCP073), so the
// what-if line proposing its removal is one ARM does not act on.
resource eventsDailyRollup 'Microsoft.OperationalInsights/workspaces/summaryLogs@2025-07-01' = {
  parent: workspace
  name: 'eagle-events-daily'
  properties: {
    ruleType: 'User'
    displayName: 'EPIC product events, daily'
    description: 'Daily rollup of ${eventsTableName}. Ranges over 30 days read this instead of scanning raw events, which is what keeps a self-serve dashboard cheap.'
    ruleDefinition: {
      query: '${eventsTableName} | summarize Events = count(), Sessions = dcount(SessionId), Users = dcount(UserId) by Day = bin(TimeGenerated, 1d), SourceApp, EventName, Page, ProjectId, Country, DeviceType, Env'
      binSize: 1440
      destinationTable: dailyTableName
      timeSelector: 'TimeGenerated'
    }
  }
  dependsOn: [
    eventsTable
    // Load-bearing, not tidiness. Without it the rule and its destination deploy in parallel, and a
    // rule that reaches its first run before the table exists CREATES the destination itself — at
    // the workspace default retention, which is the whole defect `dailyTable` exists to avoid.
    dailyTable
  ]
}

// The other half of fire-and-forget. The ingest writer never fails a request when Log Analytics is
// unreachable; it drops the batch into the application logger instead. That is only a recovery path
// if somebody finds out it happened.
//
// The query runs against the APPLICATION workspace, not this one — by the time the writer is logging
// a drop, this workspace is precisely what it could not reach.
resource dropAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (!empty(appLogsWorkspaceId)) {
  name: 'analytics-drop-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Analytics rows dropped'
    description: 'The ingest writer gave up on a batch. Those rows exist only in the application log, and only for as long as its retention.'
    // Error, not warning: EagleAudit_CL travels through the same writer, so a dropped batch can be a
    // gap in the audit trail rather than a missing chart point.
    severity: 1
    enabled: true
    scopes: [ appLogsWorkspaceId ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          // `AppTraces` is the workspace-based Application Insights table the logger lines land in —
          // not `traces`, which is the classic schema and does not exist here.
          //
          // `contains`, not `has`: `has` matches whole terms and the tokeniser treats brackets as
          // separators, so whether `has "[analytics] dropped"` matches depends on how the term
          // sequence is split. At this volume the indexed lookup is worth nothing, and an alert that
          // silently never matches is worse than no alert.
          query: 'AppTraces | where Message contains "[analytics] dropped"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: empty(alertActionGroupId) ? {} : {
      actionGroups: [ alertActionGroupId ]
    }
  }
}

@description('Ingestion endpoint clients POST to. Empty until the Direct DCR finishes provisioning.')
output dcrEndpoint string = dcr.properties.endpoints.logsIngestion

@description('Immutable ID of the DCR — the path segment in the ingestion URL, not the resource name.')
output dcrImmutableId string = dcr.properties.immutableId

@description('Name of the analytics workspace, for cross-workspace KQL')
output workspaceName string = workspace.name

@description('Resource ID of the analytics workspace')
output workspaceId string = workspace.id

@description('GUID the query API addresses this workspace by — not the resource ID')
output workspaceCustomerId string = workspace.properties.customerId
