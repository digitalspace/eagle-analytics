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
// eagle-public React preview (next site).
param allowedOrigins = [
  'https://eagle-public-test-dbg8ghh8gjd0bscx.a02.azurefd.net'
  'https://eagle-public-next-test-gtaqa6dvexc6edhg.a02.azurefd.net'
  'https://demi-admin-test-hbf7cfh7ggfhf4gf.a02.azurefd.net'
  'https://eagle-test.apps.silver.devops.gov.bc.ca'
  'https://test.projects.eao.gov.bc.ca'
  'https://www.test.projects.eao.gov.bc.ca'
  'http://localhost:4200'
]

// demi-alerts-test, same on-call address as the rest of the estate.
param alertActionGroupId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-rg/providers/microsoft.insights/actionGroups/demi-alerts-test'

// No second argument to readEnvironmentVariable, deliberately. With a `''` fallback a forgotten
// export resolves to empty and the deploy writes that over the live value — silently, because app
// settings are a whole-collection PUT and what-if masks @secure() values as "*******" in BOTH before
// and after. Without the fallback bicep fails the build instead. deploy-infra.sh sources it.
param apimSharedHeaderValue = readEnvironmentVariable('APIM_SHARED_HEADER_VALUE')

// Same rule: POST /audit's own credential, no fallback.
param auditSharedHeaderValue = readEnvironmentVariable('AUDIT_SHARED_HEADER_VALUE')

param contactEmails = [ readEnvironmentVariable('BUDGET_CONTACT_EMAIL') ]

// Pinned: an existing budget rejects a startDate change.
param budgetStartDate = '2026-09-01'
