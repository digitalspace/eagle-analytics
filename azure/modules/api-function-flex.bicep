// No private endpoints: the gateway calls the public hostname. Header secrets come from demi-kv-<env>,
// which is private-only, so the VNet subnet below is what lets their Key Vault references resolve.

@description('Location for the Function App resources')
param location string = resourceGroup().location

@description('Environment name (e.g. test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

// Flex needs a subnet delegated to `Microsoft.App/environments`, at least a /27, and one that holds
// no private endpoints — so it cannot be the landing zone's private-endpoint subnet.
@description('Delegated subnet for Flex VNet integration. Required: demi-kv-<env>, which holds both header values, only answers from inside the VNet.')
param virtualNetworkSubnetId string

@description('Resource ID of the user-assigned managed identity the app runs as')
param identityId string

@description('Client ID of that identity. DefaultAzureCredential cannot pick between several, so AZURE_CLIENT_ID names the one to use.')
param identityClientId string

@description('Principal ID of that identity. Granted the storage data-plane roles the Flex host needs, and reader on the workspaces the query API reads.')
param identityPrincipalId string

@description('Logs Ingestion endpoint of the analytics DCR. Empty drops events after one warning rather than throwing, which is what makes local development work.')
param eventsDcrEndpoint string = ''

@description('Immutable ID of the analytics DCR. Both this and the endpoint are required before anything is sent.')
param eventsDcrImmutableId string = ''

@description('Workspace GUID holding EagleEvents_CL and EagleAudit_CL. Empty makes the query endpoints answer 503.')
param analyticsWorkspaceCustomerId string = ''

@description('Customer id (GUID) of the workspace behind eagle-insights-<env>, where the dashboard reads error counts from AppExceptions. A GUID and not a name: it is emitted into a compiled query as workspace(\'<this>\'), and a bare name is ambiguous across resource groups.')
param eagleLogsWorkspaceCustomerId string = ''

@description('Customer id (GUID) of demi-audit-<env>. The audit viewer unions the pre-cutover DemiAudit_CL rows until they age out.')
param demiAuditWorkspaceCustomerId string = ''

@description('Names of Log Analytics workspaces IN THIS RESOURCE GROUP to grant the identity Log Analytics Reader on. A workspace in another group has to be granted separately — a resource-group deployment cannot carry an assignment outside its own scope.')
param readerWorkspaceNames array = []

@description('Resource ID of the workspace the deploy-access diagnostic setting writes to. Empty skips it rather than failing the deployment.')
param diagnosticsWorkspaceId string = ''

@description('Application Insights connection string. Empty disables telemetry, which is the local-development case.')
param appInsightsConnectionString string = ''

@description('Keycloak base URL for this environment. MUST be pinned per environment: the code default is DEV.')
param keycloakUrl string

@description('Keycloak realm')
param keycloakRealm string = 'eao-epic'

@description('Comma list of Keycloak client ids allowed to call the read API, matched against a token\'s aud and azp. Empty admits nobody — src/config.js refuses to boot test or prod on it.')
param keycloakAllowedClients string = ''

@description('Header name APIM stamps on a forwarded request. The app refuses anything arriving without it, which is what keeps the Function host from being callable directly.')
param apimSharedHeaderName string = 'X-Analytics-Gateway'

@description('Versionless Key Vault secret URI holding the value of that header. The app setting is a reference to it, so no value passes through this template.')
param apimSharedHeaderSecretUri string

@description('Versionless Key Vault secret URI holding the value of the X-Analytics-Audit header the keyed analytics-machine product stamps, guarding POST /audit on its own.')
param auditSharedHeaderSecretUri string

@description('Origins POST /events accepts a browser request from, as a list. A request with no Origin header is a server-side producer and is allowed; empty refuses every browser Origin.')
param allowedOrigins array = []

@description('Front Door\'s own id (`az afd profile show --query frontDoorId`). Only on an X-Azure-FDID match is X-Azure-SocketIP trusted over the caller-supplied X-Forwarded-For.')
param frontDoorId string = ''

@description('Comma list of the addresses our own proxies call out from, as APIM reports them in X-Client-Ip (the OpenShift cluster egress pool). A request stamped with one of these is read one X-Forwarded-For hop further back for the visitor, and a server producer behind them is exempt from the per-address event cap. Empty trusts nothing.')
param trustedProxyIps string = ''

var apiAppName = 'analytics-api-fc-${environmentName}'
var appServicePlanName = 'analytics-plan-fc-${environmentName}'
var storageAccountName = take('analyticsfc${environmentName}${uniqueString(resourceGroup().id)}', 24)

// ponytail: Blob Data Contributor covers deploy and host leases; Blob Data Owner (b7e6dc6d-f1e8-4753-8033-0f276bb0955b) if the host cannot start.
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var tableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var logAnalyticsReaderRoleId = '73c42c96-874c-492b-b04d-ab87d138a893'

resource apiStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // Every caller, the Flex host included, uses the identity, so there is no key to leak or rotate.
    allowSharedKeyAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: apiStorage
  name: 'default'
}

// Flex Consumption publishes here rather than to a site filesystem — there is no Kudu wwwroot.
resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'deployment'
}

// GeoLite2-City.mmdb, refreshed monthly by refresh-geoip.yaml. Not in the package: 60 MB, outlives a deploy.
resource geoipContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'geoip'
}

// penguin-analytics CSV exports, kept as the provenance of the imported history.
resource historyContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'history'
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: apiStorage
  name: 'default'
}

// Saved dashboards. Table Storage rather than Cosmos: entities are small, the access pattern is a
// partition scan by owner, and Cosmos here would mean a private endpoint and a subnet request.
resource dashboardsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'dashboards'
}

resource blobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apiStorage
  name: guid(apiStorage.id, identityPrincipalId, blobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource tableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apiStorage
  name: guid(apiStorage.id, identityPrincipalId, tableDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The query API authenticates as this identity (src/query/run.js). A new grant takes minutes to
// apply: retry a 403, do not re-grant.
resource readerWorkspaces 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = [
  for name in readerWorkspaceNames: {
    name: name
  }
]

resource workspaceReaderAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (name, i) in readerWorkspaceNames: {
    scope: readerWorkspaces[i]
    name: guid(readerWorkspaces[i].id, identityPrincipalId, logAnalyticsReaderRoleId)
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logAnalyticsReaderRoleId)
      principalId: identityPrincipalId
      principalType: 'ServicePrincipal'
    }
  }
]

// One app per plan: a Flex plan cannot be shared, so there is no "join an existing plan" parameter.
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true // Linux
  }
}

resource apiFunctionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: apiAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  // User-assigned: its grants survive a redeploy and can be made before the app exists.
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    // Key Vault references resolve over this subnet; Flex sends all outbound traffic through it.
    virtualNetworkSubnetId: virtualNetworkSubnetId
    // Defaults to the system-assigned identity, which this app lacks, so references would resolve to nothing.
    keyVaultReferenceIdentity: identityId
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${apiStorage.properties.primaryEndpoints.blob}${deployContainer.name}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: identityId
          }
        }
      }
      // 20 instances caps the bill; ingest is a small write per request. `alwaysReady: []` is scale
      // to zero — the client batches and retries, so a cold start costs latency, not events.
      scaleAndConcurrency: {
        maximumInstanceCount: 20
        instanceMemoryMB: 2048
        alwaysReady: []
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      // Whole-collection PUT: a live setting missing here is deleted on deploy, so declare every one. Flex
      // rejects FUNCTIONS_WORKER_RUNTIME, FUNCTIONS_EXTENSION_VERSION, WEBSITE_NODE_DEFAULT_VERSION, WEBSITE_RUN_FROM_PACKAGE.
      appSettings: [
        {
          name: 'ENVIRONMENT'
          value: environmentName
        }
        // Identity-based because the account refuses shared keys; the blob role above lets the host start.
        {
          name: 'AzureWebJobsStorage__accountName'
          value: apiStorage.name
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          name: 'AzureWebJobsStorage__clientId'
          value: identityClientId
        }
        // Host telemetry; index.js also reads it to decide whether to start the OpenTelemetry distro.
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        // The in-code distro owns instrumentation; the platform agent as well would double-count.
        {
          name: 'APPLICATIONINSIGHTS_ENABLE_AGENT'
          value: 'false'
        }
        // DefaultAzureCredential has no way to choose between several user-assigned identities.
        {
          name: 'AZURE_CLIENT_ID'
          value: identityClientId
        }
        {
          name: 'EVENTS_DCR_ENDPOINT'
          value: eventsDcrEndpoint
        }
        {
          name: 'EVENTS_DCR_IMMUTABLE_ID'
          value: eventsDcrImmutableId
        }
        // The query API keys on the workspace GUID, not the resource id.
        {
          name: 'ANALYTICS_WORKSPACE_CUSTOMER_ID'
          value: analyticsWorkspaceCustomerId
        }
        // Compiled queries use workspace('<guid>'); a name resolves differently per environment.
        {
          name: 'EAGLE_LOGS_WORKSPACE'
          value: eagleLogsWorkspaceCustomerId
        }
        {
          name: 'DEMI_AUDIT_WORKSPACE'
          value: demiAuditWorkspaceCustomerId
        }
        // Blob and table clients build their endpoints from this; the account has no key to embed.
        {
          name: 'STORAGE_ACCOUNT_NAME'
          value: apiStorage.name
        }
        // Pin per environment, or staff tokens are checked against the DEV realm.
        {
          name: 'KEYCLOAK_URL'
          value: keycloakUrl
        }
        {
          name: 'KEYCLOAK_REALM'
          value: keycloakRealm
        }
        {
          name: 'KEYCLOAK_ALLOWED_CLIENTS'
          value: keycloakAllowedClients
        }
        {
          name: 'APIM_SHARED_HEADER_NAME'
          value: apimSharedHeaderName
        }
        // Resolved by the platform as keyVaultReferenceIdentity, so no value sits in deployment history.
        {
          name: 'APIM_SHARED_HEADER_VALUE'
          value: '@Microsoft.KeyVault(SecretUri=${apimSharedHeaderSecretUri})'
        }
        // POST /audit carries its own credential, so a leaked gateway header cannot write audit rows.
        {
          name: 'AUDIT_SHARED_HEADER_VALUE'
          value: '@Microsoft.KeyVault(SecretUri=${auditSharedHeaderSecretUri})'
        }
        {
          name: 'ALLOWED_ORIGINS'
          value: join(allowedOrigins, ',')
        }
        {
          name: 'FRONT_DOOR_ID'
          value: frontDoorId
        }
        {
          name: 'TRUSTED_PROXY_IPS'
          value: trustedProxyIps
        }
        // Picks the JSON log format in src/utils/logger.js.
        {
          name: 'NODE_ENV'
          value: 'production'
        }
        // No ALLOWED_SOURCE_APPS, SESSION_EVENT_CAP or IP_EVENT_CAP: src/config.js owns those defaults.
      ]
    }
  }
}

// SCM is public and answers 401 rather than refusing, so basic auth is an unthrottled guessing surface.
// Nothing needs it: CI signs in with OIDC and publishes with config-zip.
resource apiScmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: apiFunctionApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource apiFtpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: apiFunctionApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

// Who authenticated to SCM and deployed — the one authenticated change that never passes through the
// app's own audit trail.
resource apiAuditDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(diagnosticsWorkspaceId)) {
  scope: apiFunctionApp
  // Distinctly named: the landing zone sets its own `setByPolicy-*` settings here, and a colliding
  // name would have the two overwrite each other on every deploy.
  name: 'analytics-audit'
  properties: {
    workspaceId: diagnosticsWorkspaceId
    logs: [
      {
        category: 'AppServiceAuditLogs'
        enabled: true
      }
    ]
  }
}

output apiFunctionAppName string = apiFunctionApp.name
output apiFunctionAppHostName string = apiFunctionApp.properties.defaultHostName
output storageAccountName string = apiStorage.name
