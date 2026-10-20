// Not here: the gateway is demi-apim-<env> (a second Consumption APIM doubles a fixed cost), Front
// Door routing is eagle-edge, and Function telemetry goes to the existing eagle-insights-<env>.
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

// Landing-zone subnet in c4b0a8-<env>-networking, made by the platform team; no default on purpose.
@description('Existing subnet delegated to Microsoft.App/environments that the Function App integrates with. Required: the vault holding both header values only answers from inside the VNet.')
param vnetSubnetId string

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

// Split from the resource id ([2] subscription, [4] group) so a second parameter cannot drift from it.
var eagleLogsSubscriptionId = split(eagleLogsWorkspaceId, '/')[2]
var eagleLogsResourceGroup = split(eagleLogsWorkspaceId, '/')[4]
var eagleLogsName = last(split(eagleLogsWorkspaceId, '/'))
var demiAuditSubscriptionId = split(demiAuditWorkspaceId, '/')[2]
var demiAuditResourceGroup = split(demiAuditWorkspaceId, '/')[4]
var demiAuditName = last(split(demiAuditWorkspaceId, '/'))

// Read here, not passed in: the connection string carries the ingestion key and param files are public.
resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

// Queries address workspaces by customer id: a name resolves only in groups the caller can see, and
// demi-audit-prod is in another. Reading the GUID needs deploy-time read on both workspaces.
resource eagleLogsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: eagleLogsName
  scope: resourceGroup(eagleLogsSubscriptionId, eagleLogsResourceGroup)
}

resource demiAuditWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: demiAuditName
  scope: resourceGroup(demiAuditSubscriptionId, demiAuditResourceGroup)
}

// Literal, not the module output: role-assignment names cannot hold runtime values. Workspaces in
// other groups (demi-audit-prod) are granted by hand, as the README says.
var analyticsWorkspaceName = 'analytics-logs-${environmentName}'

// Composed versionless URIs: the resolver follows them to the current version, and the deploy needs no
// read on a VNet-only vault. The names match the APIM named values on demi-apim-<env>.
var apimSharedHeaderSecretName = 'analytics-shared-header'
var auditSharedHeaderSecretName = 'analytics-audit-header'

var vaultUri = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}'
var apimSharedHeaderSecretUri = '${vaultUri}/secrets/${apimSharedHeaderSecretName}'
var auditSharedHeaderSecretUri = '${vaultUri}/secrets/${auditSharedHeaderSecretName}'

var localWorkspaceNames = union(
  [ analyticsWorkspaceName ],
  (eagleLogsSubscriptionId == subscription().subscriptionId && eagleLogsResourceGroup == resourceGroup().name) ? [ eagleLogsName ] : [],
  (demiAuditSubscriptionId == subscription().subscriptionId && demiAuditResourceGroup == resourceGroup().name) ? [ demiAuditName ] : []
)

module identity './modules/identity.bicep' = {
  name: 'deploy-identity'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
  }
}

// Own module scope: a role assignment lands only in the targeted group, and prod's vault is in another.
module keyVaultAccess './modules/key-vault-access.bicep' = {
  name: 'deploy-key-vault-access'
  scope: resourceGroup(keyVaultResourceGroup)
  params: {
    keyVaultName: keyVaultName
    principalId: identity.outputs.principalId
  }
}

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
    // DEMI also reads: GET /admin/audit unions its own rows with EagleAudit_CL.
    readerPrincipalIds: [ demiIdentityPrincipalId ]
    appLogsWorkspaceId: eagleLogsWorkspaceId
    alertActionGroupId: alertActionGroupId
  }
}

module apiFunctionFlex './modules/api-function-flex.bicep' = {
  name: 'deploy-api-function-flex'
  // Nothing in the params links the two, and an app that starts before the grant exists reads an
  // empty header value and refuses to boot.
  dependsOn: [ keyVaultAccess ]
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    virtualNetworkSubnetId: vnetSubnetId
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
// The GUID the query API addresses the workspace by, otherwise a portal lookup.
output analyticsWorkspaceCustomerId string = analyticsLogs.outputs.workspaceCustomerId
// Both halves of the ingestion URL; eagle-demi needs them for its audit writer settings.
output eventsDcrEndpoint string = analyticsLogs.outputs.dcrEndpoint
output eventsDcrImmutableId string = analyticsLogs.outputs.dcrImmutableId
output identityClientId string = identity.outputs.clientId
