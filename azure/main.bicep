// eagle-analytics — EPIC product analytics, serverless.
//
// Four things:
//   1. `analytics-identity-<env>`   the principal every data plane grant is made to
//   2. `analytics-logs-<env>`       the event and audit store, its DCR and its daily rollup
//   3. `analytics-api-fc-<env>`     ingest and read API on Flex Consumption
//   4. `analytics-budget-<env>`     monthly cost anomaly guard
//
// NOT here. The gateway in front of ingest is `demi-apim-<env>`, owned by eagle-demi: APIM
// Consumption bills per call and a second instance would double a fixed cost for nothing. Front Door
// routing lives in eagle-edge. Telemetry for the Function itself goes to the existing
// eagle-insights-<env>, referenced below rather than rebuilt.
targetScope = 'resourceGroup'

@description('Azure region. Log Analytics and its DCR must share one.')
param location string = 'canadacentral'

@description('Environment name (test, prod)')
param environmentName string

@description('Principal ID of demi-identity-<env>. Granted publish rights on the analytics DCR so DEMI writes its audit rows straight to this pipeline instead of keeping a second one.')
param demiIdentityPrincipalId string

@description('Resource ID of the application logs workspace behind eagle-insights-<env>. Scope of the dropped-rows alert, and the source of the error counts the dashboard shows.')
param eagleLogsWorkspaceId string

@description('Resource ID of demi-audit-<env>. Read only: the audit viewer unions the pre-cutover DemiAudit_CL rows until they age out.')
param demiAuditWorkspaceId string

@description('Name of the EXISTING Application Insights component in this resource group. Differs by environment, which is why it is a parameter and not a pattern.')
param appInsightsName string

@description('Keycloak base URL for this environment (test/prod loginproxy)')
param keycloakUrl string

@description('Keycloak realm')
param keycloakRealm string = 'eao-epic'

@description('Comma list of Keycloak client ids allowed to call the read API. Empty admits nobody, and src/config.js refuses to boot test or prod on it.')
param keycloakAllowedClients string = ''

@description('Front Door\'s own id, from `az afd profile show --query frontDoorId` on the eagle-edge profile. Only on a match is X-Azure-SocketIP trusted over the caller-supplied X-Forwarded-For.')
param frontDoorId string = ''

@description('Comma list of the addresses our own proxies call out from, as APIM reports them in X-Client-Ip. Decides which requests are read one X-Forwarded-For hop further back for the visitor address, and which server producers are exempt from the per-address event cap. Empty trusts nothing.')
param trustedProxyIps string = ''

@description('Header name demi-apim-<env> stamps on a forwarded request.')
param apimSharedHeaderName string = 'X-Analytics-Gateway'

@description('Name of the EXISTING Key Vault holding both header values: demi-kv-<env>, owned by eagle-demi. Values are set once by hand from the devbox; no deployment writes them.')
param keyVaultName string

@description('Resource group holding that vault. Defaults to this deployment\'s group, which is right for test. Production\'s vault sits in rg-demi-prod while this deployment targets rg-eagle-public-prod, so prod passes it.')
param keyVaultResourceGroup string = resourceGroup().name

@description('Vault secret holding the value of the gateway header, shared with the APIM policy.')
param apimSharedHeaderSecretName string = 'analytics-shared-header'

@description('Vault secret holding the value of the X-Analytics-Audit header the keyed analytics-machine product stamps, guarding POST /audit on its own.')
param auditSharedHeaderSecretName string = 'analytics-audit-header'

@description('Origins POST /events accepts a browser request from. A request with no Origin header is a server-side producer and is allowed; empty refuses every browser Origin.')
param allowedOrigins array = []

@description('Action group notified by the dropped-rows alert. Reuses demi-alerts-<env>: one estate, one on-call address.')
param alertActionGroupId string = ''

@description('Monthly cost anomaly guard in CAD')
param budgetAmount int = 60

@description('Pinned first day of the live budget period — an existing budget rejects startDate changes, so this must match what is deployed. Empty = first of the current month (new budgets only).')
param budgetStartDate string = ''

@description('Email addresses for budget and alert notifications. Sourced from the environment by the param files — never a literal, this repository is public.')
param contactEmails array

var applicationTagKey = 'Application'

var defaultTags = {
  Project: 'EPIC Analytics'
  '${applicationTagKey}': 'eagle-analytics'
  Environment: environmentName
  ManagedBy: 'Bicep'
  CostCenter: 'c4b0a8'
}

// Existing workspaces are addressed by splitting their resource id rather than by taking a second
// name-and-group parameter for each: the id already carries both, and two parameters for one fact
// drift. `[2]` is the subscription, `[4]` the resource group.
var eagleLogsSubscriptionId = split(eagleLogsWorkspaceId, '/')[2]
var eagleLogsResourceGroup = split(eagleLogsWorkspaceId, '/')[4]
var eagleLogsName = last(split(eagleLogsWorkspaceId, '/'))
var demiAuditSubscriptionId = split(demiAuditWorkspaceId, '/')[2]
var demiAuditResourceGroup = split(demiAuditWorkspaceId, '/')[4]
var demiAuditName = last(split(demiAuditWorkspaceId, '/'))

// Read the connection string here rather than pass it in. It is a credential-shaped value (it
// carries the ingestion key), and a param file in a public repository is the wrong place for it.
resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

// The cross-workspace legs of a compiled query address a workspace by its customer id, not its name:
// a bare name resolves against the resource groups the caller can see, and demi-audit-prod lives in
// another one. Reading the GUID here needs read access on both workspaces at deploy time.
resource eagleLogsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: eagleLogsName
  scope: resourceGroup(eagleLogsSubscriptionId, eagleLogsResourceGroup)
}

resource demiAuditWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: demiAuditName
  scope: resourceGroup(demiAuditSubscriptionId, demiAuditResourceGroup)
}

// A role assignment cannot be made outside the deployment's own resource group, so only the
// workspaces that live here get one from this template. Anything else — demi-audit-prod, which sits
// in rg-demi-prod — is granted by hand once, and the README says so.
// Spelled out rather than read from `analyticsLogs.outputs.workspaceName`: these names end up in
// role-assignment resource names, and a resource name cannot contain a runtime value.
var analyticsWorkspaceName = 'analytics-logs-${environmentName}'

// Versionless secret URIs, composed rather than read off the vault: the App Service resolver follows
// a versionless URI to the current version on its own, and composing means the deployment needs no
// data-plane read on a vault that only answers from inside the VNet.
var vaultUri = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}'
var apimSharedHeaderSecretUri = '${vaultUri}/secrets/${apimSharedHeaderSecretName}'
var auditSharedHeaderSecretUri = '${vaultUri}/secrets/${auditSharedHeaderSecretName}'

var localWorkspaceNames = union(
  [ analyticsWorkspaceName ],
  (eagleLogsSubscriptionId == subscription().subscriptionId && eagleLogsResourceGroup == resourceGroup().name) ? [ eagleLogsName ] : [],
  (demiAuditSubscriptionId == subscription().subscriptionId && demiAuditResourceGroup == resourceGroup().name) ? [ demiAuditName ] : []
)

// 1. Identity first: every grant below names its principal, and the Function App consumes its
// client id as an app setting.
module identity './modules/identity.bicep' = {
  name: 'deploy-identity'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
  }
}

// 1b. Read rights on the vault, before anything that resolves a secret from it. A role assignment
// only lands in the group the deployment targets, so a vault in another group takes its own module
// scoped there — which is prod's case.
module keyVaultAccess './modules/key-vault-access.bicep' = {
  name: 'deploy-key-vault-access'
  scope: resourceGroup(keyVaultResourceGroup)
  params: {
    keyVaultName: keyVaultName
    principalId: identity.outputs.principalId
  }
}

// 2. The store. Both writers are granted publish on the DCR here, DEMI included — its audit writer
// posts to this endpoint after the eagle-demi side of WP1 lands.
module analyticsLogs './modules/event-logs.bicep' = {
  name: 'deploy-event-logs'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    publisherPrincipalIds: [
      identity.outputs.principalId
      demiIdentityPrincipalId
    ]
    // Read as well as write for DEMI: its audit viewer answers GET /admin/audit from the union of its
    // own rows and EagleAudit_CL, which lives here.
    readerPrincipalIds: [ demiIdentityPrincipalId ]
    appLogsWorkspaceId: eagleLogsWorkspaceId
    alertActionGroupId: alertActionGroupId
  }
}

// 3. The API. After the store, because it takes the DCR endpoint and the workspace GUID as settings.
module apiFunctionFlex './modules/api-function-flex.bicep' = {
  name: 'deploy-api-function-flex'
  // Nothing in the params links the two, and an app that starts before the grant exists reads an
  // empty header value and refuses to boot.
  dependsOn: [ keyVaultAccess ]
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    identityId: identity.outputs.identityId
    identityClientId: identity.outputs.clientId
    identityPrincipalId: identity.outputs.principalId
    eventsDcrEndpoint: analyticsLogs.outputs.dcrEndpoint
    eventsDcrImmutableId: analyticsLogs.outputs.dcrImmutableId
    analyticsWorkspaceCustomerId: analyticsLogs.outputs.workspaceCustomerId
    eagleLogsWorkspaceCustomerId: eagleLogsWorkspace.properties.customerId
    demiAuditWorkspaceCustomerId: demiAuditWorkspace.properties.customerId
    readerWorkspaceNames: localWorkspaceNames
    diagnosticsWorkspaceId: analyticsLogs.outputs.workspaceId
    appInsightsConnectionString: appInsights.properties.ConnectionString
    keycloakUrl: keycloakUrl
    keycloakRealm: keycloakRealm
    keycloakAllowedClients: keycloakAllowedClients
    apimSharedHeaderName: apimSharedHeaderName
    apimSharedHeaderSecretUri: apimSharedHeaderSecretUri
    auditSharedHeaderSecretUri: auditSharedHeaderSecretUri
    allowedOrigins: allowedOrigins
    frontDoorId: frontDoorId
    trustedProxyIps: trustedProxyIps
  }
}

// 4. Cost guard.
module costBudget './modules/cost-budget.bicep' = {
  name: 'deploy-cost-budget'
  params: {
    environmentName: environmentName
    budgetAmount: budgetAmount
    contactEmails: contactEmails
    startDate: budgetStartDate
    applicationTagKey: applicationTagKey
    applicationTagValue: defaultTags[applicationTagKey]
  }
}

// The backend hostname the `analytics` API in demi-apim-<env> forwards to.
output apiHostName string = apiFunctionFlex.outputs.apiFunctionAppHostName
output apiFunctionAppName string = apiFunctionFlex.outputs.apiFunctionAppName
// Publish target for scripts/package-api.py, and the container the geoip refresh uploads to.
output storageAccountName string = apiFunctionFlex.outputs.storageAccountName
output analyticsWorkspaceName string = analyticsLogs.outputs.workspaceName
// The GUID the query API addresses the workspace by, and otherwise a portal lookup.
output analyticsWorkspaceCustomerId string = analyticsLogs.outputs.workspaceCustomerId
// Both halves of the ingestion URL. eagle-demi needs them for its own audit writer settings.
output eventsDcrEndpoint string = analyticsLogs.outputs.dcrEndpoint
output eventsDcrImmutableId string = analyticsLogs.outputs.dcrImmutableId
output identityClientId string = identity.outputs.clientId
