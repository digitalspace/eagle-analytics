using './main.bicep'

// Test: c4b0a8-test-rg in c4b0a8-test. Deploy and Front Door id lookup: README "The estate".

param environmentName = 'test'
param location = 'canadacentral'

// demi-identity-test's principalId.
param demiIdentityPrincipalId = '388ed601-3565-4932-a5b8-4d7b543e35a3'

// From eagle-insights-test's WorkspaceResourceId, not assumed from the name. Same group: template grants reader.
param eagleLogsWorkspaceId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-rg/providers/Microsoft.OperationalInsights/workspaces/eagle-logs-test'

param demiAuditWorkspaceId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-rg/providers/Microsoft.OperationalInsights/workspaces/demi-audit-test'

// Existing component; main.bicep reads its connection string.
param appInsightsName = 'eagle-insights-test'

param keycloakUrl = 'https://test.loginproxy.gov.bc.ca/auth'

// eagle-demi-admin's client id (its public/env.js), the same one eagle-demi's allowedClients names.
param keycloakAllowedClients = 'eagle-admin-console'

// From the environment: it gates trust in X-Azure-SocketIP, so knowing it lets a caller pick its address.
param frontDoorId = readEnvironmentVariable('FRONT_DOOR_ID')

// OpenShift egress pool as APIM stamps it in X-Client-Ip, same in both environments. Safe in the open:
// APIM sets X-Client-Ip with `override`, so knowing them does not let a caller claim to be the cluster.
param trustedProxyIps = '142.34.194.121,142.34.194.122,142.34.194.123,142.34.194.124'

// AFD hostnames carry a deploy-time hash, so they are listed, not composed. localhost lets a developer
// run an admin app against the test gateway; prod omits it.
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

// demi-kv-test is in this group, so keyVaultResourceGroup and the secret names keep their defaults.
param keyVaultName = 'demi-kv-test'

// Landing-zone /27 shared with demi-api-fc-test: raising either app's maximumInstanceCount needs a
// wider subnet.
param vnetSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/snet-demi-func-fc1-test'

param contactEmails = [ readEnvironmentVariable('BUDGET_CONTACT_EMAIL') ]

// Pinned: an existing budget rejects a startDate change.
param budgetStartDate = '2026-09-01'
