using './main.bicep'

// Test (staging): c4b0a8-test-rg in c4b0a8-test (7897ceb1-9a86-4639-87d7-7f9ff67142b3).
// Deploy with ./scripts/deploy-infra.sh test.

param environmentName = 'test'
param location = 'canadacentral'

// demi-identity-test. Publish-only on the analytics DCR, so DEMI's auditEvent() writes EagleAudit_CL
// rows without a second pipeline. Read 2026-09-05:
//   az identity show -n demi-identity-test -g c4b0a8-test-rg --query principalId
param demiIdentityPrincipalId = '388ed601-3565-4932-a5b8-4d7b543e35a3'

// The workspace behind eagle-insights-test, confirmed from the component's WorkspaceResourceId — not
// assumed from the name. Same resource group, so the reader grant is made by the template.
param eagleLogsWorkspaceId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-rg/providers/Microsoft.OperationalInsights/workspaces/eagle-logs-test'

param demiAuditWorkspaceId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-rg/providers/Microsoft.OperationalInsights/workspaces/demi-audit-test'

// Existing component in this resource group. main.bicep reads its connection string; the value never
// appears in a parameter file.
param appInsightsName = 'eagle-insights-test'

param keycloakUrl = 'https://test.loginproxy.gov.bc.ca/auth'

// eagle-demi-admin's Keycloak client, `eagle-admin-console` — the id in its public/env.js, and the
// same one eagle-demi's own allowedClients names. Not the repository name.
param keycloakAllowedClients = 'eagle-admin-console'

// eagle-edge-test's own id, from:
//   az afd profile show -g c4b0a8-test-rg -n eagle-edge-test --query frontDoorId
// Out of the environment for the same reason as the header values below: it decides whether
// X-Azure-SocketIP is trusted, so a caller who knows it can choose its own client address.
param frontDoorId = readEnvironmentVariable('FRONT_DOOR_ID')

// The OpenShift cluster's egress pool, measured 2026-09-07 from what APIM stamped in X-Client-Ip. The
// same four addresses in both environments. Unlike frontDoorId above these are safe in the open: APIM
// sets X-Client-Ip with `override`, so knowing them does not let a caller claim to be the cluster.
param trustedProxyIps = '142.34.194.121,142.34.194.122,142.34.194.123,142.34.194.124'

// The two AFD hostnames carry a deploy-time hash and cannot be composed: eagle-public's is in
// eagle-edge/README.md, eagle-demi-admin's in eagle-demi/azure/main.test.bicepparam. Third is
// eagle-admin on OpenShift test. Both the apex and the www host serve the public site, same as prod.
// localhost is a developer running an admin app against the deployed gateway, and is deliberately
// absent from prod.
param allowedOrigins = [
  'https://eagle-public-test-dbg8ghh8gjd0bscx.a02.azurefd.net'
  'https://demi-admin-test-hbf7cfh7ggfhf4gf.a02.azurefd.net'
  'https://eagle-test.apps.silver.devops.gov.bc.ca'
  'https://test.projects.eao.gov.bc.ca'
  'https://www.test.projects.eao.gov.bc.ca'
  'http://localhost:4200'
]

// demi-alerts-test, same on-call address as the rest of the estate.
param alertActionGroupId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-rg/providers/microsoft.insights/actionGroups/demi-alerts-test'

// Both header values live in demi-kv-test, which is in this same resource group, so
// keyVaultResourceGroup keeps its default. The app settings are references to the secrets; nothing
// in this file or in the deployment history carries a value. Secret names keep their defaults
// (analytics-shared-header, analytics-audit-header).
param keyVaultName = 'demi-kv-test'

// snet-demi-func-fc1-test, in c4b0a8-test-networking: the landing-zone subnet delegated to
// Microsoft.App/environments, verified 2026-09-11 as a /27 with an NSG. Shared with
// demi-api-fc-test — a delegated subnet takes more than one Flex app, but a /27 leaves 27
// addresses for both apps' instances, so raising either maximumInstanceCount needs a wider subnet.
param vnetSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/snet-demi-func-fc1-test'

param contactEmails = [ readEnvironmentVariable('BUDGET_CONTACT_EMAIL') ]

// Pinned: an existing budget rejects a startDate change.
param budgetStartDate = '2026-09-01'
