// Separate from the app-log workspaces: their dailyQuotaGb stops collection for the day, and the
// audit trail must not stop with it. No workspaceCapping: ingest caps and the budget guard cost.

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

// Total retention past two years must be a value from a fixed list (1095, 1460, 1826, 2191, 2556, ...);
// 2555 (7 x 365) fails with InvalidParameter. 730 is the interactive maximum.
var eventsRetentionDays = 400
var auditInteractiveDays = 730
var auditTotalDays = 2556
var dailyRetentionDays = 730

// Each column set is both the table schema and the DCR stream, so the two cannot drift. Ingest drops
// the client address after the geo lookup, so there is no SourceIp column to mask.
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

// SourceApp because the table is EPIC-wide. ActorId (Keycloak sub) joins back to the realm; ActorName
// lets a reader see who acted without a Keycloak lookup.
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
    // Custom tables override this; 90 days covers Azure-owned tables such as AppServiceAuditLogs.
    retentionInDays: 90
    features: {
      // False: reading analytics must be a grant on this workspace, not a side effect of resource Reader.
      enableLogAccessUsingOnlyResourcePermissions: false
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// Tables need this newer API version: the workspace's version accepts only Analytics and Basic for
// `plan`, and rejects totalRetentionInDays past the interactive maximum.
resource eventsTable 'Microsoft.OperationalInsights/workspaces/tables@2025-07-01' = {
  parent: workspace
  name: eventsTableName
  properties: {
    // Analytics, not Auxiliary, on all three tables: dashboard queries must not bill per query.
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

// The summary rule adds four `_` columns the tables API refuses in a PUT (MSG 1008), so what-if shows
// them as deleted on every run; the deployment leaves them in place.
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
  // count() and dcount() return long; a mismatch breaks the rule's write, not the deployment.
  { name: 'Events', type: 'long' }
  { name: 'Sessions', type: 'long' }
  { name: 'Users', type: 'long' }
]

// Declared so the rule cannot create it at workspace default retention. `Day` holds the real date:
// Logs Ingestion rewrites TimeGenerated older than two days, so imported history cannot backdate it.
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

// Direct kind: clients POST to the rule's own endpoint with no Data Collection Endpoint, and the
// landing zone's Deny-PublicPaaSEndpoints policy does not cover that managed endpoint.
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
      // Only for scripts/import-penguin-history.js; the summary rule writes the table without a stream.
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
        // The stream has no SourceIp, so `project-away SourceIp` would fail the transform.
        transformKql: 'source'
      }
      {
        streams: [ 'Custom-${auditTableName}' ]
        destinations: [ 'analyticsWorkspace' ]
        outputStream: 'Custom-${auditTableName}'
        // Masked here so no caller, DEMI included, can bypass it: two octets kept, non-IPv4 'redacted'.
        // `extract` runs twice because a scratch column would have to match the destination table.
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

// Monitoring Metrics Publisher: can send to this rule, cannot read anything back.
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

// Log Analytics Reader for readers outside this API, such as eagle-demi's audit viewer. Scoped to the
// workspace because a DCR grant cannot read.
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

// No time filter or bin: binSize defines the window. `isActive` is read-only on this type (BCP073),
// so the what-if line removing it is not acted on.
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
    // Without it the rule can run first and create the table at the workspace default retention.
    dailyTable
  ]
}

// The ingest writer logs dropped batches instead of failing requests; this alert surfaces them. It
// queries the app workspace because a drop means this one was unreachable.
resource dropAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (!empty(appLogsWorkspaceId)) {
  name: 'analytics-drop-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Analytics rows dropped'
    description: 'The ingest writer gave up on a batch. Those rows exist only in the application log, and only for as long as its retention.'
    // Error, not warning: audit rows share this writer, so a drop can be a gap in the audit trail.
    severity: 1
    enabled: true
    scopes: [ appLogsWorkspaceId ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          // AppTraces, not the classic `traces`. `contains`, not `has`: `has` splits terms on brackets,
          // so it may never match "[analytics] dropped".
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
