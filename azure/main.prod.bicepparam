using './main.bicep'

// Production: rg-eagle-public-prod in c4b0a8-prod. Read the what-if before a live deploy; deploy,
// Front Door id lookup and the hand-made reader grant: README "The estate".

param environmentName = 'prod'
param location = 'canadacentral'

// demi-identity-prod, in rg-demi-prod; a principal id works across resource groups.
param demiIdentityPrincipalId = '7d904cf2-2918-4a54-bbb4-acdf27c55e8b'

// eagle-public-logs-prod (no eagle-logs-prod exists): eagle-public-insights-prod's workspace, the only
// one the dropped-rows alert can query. Same group, so the template grants reader.
param eagleLogsWorkspaceId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/rg-eagle-public-prod/providers/Microsoft.OperationalInsights/workspaces/eagle-public-logs-prod'

// In rg-demi-prod: the deployer needs read on it, and Log Analytics Reader is granted by hand (README
// "The estate"). Until then the audit viewer's DemiAudit_CL union returns 403.
param demiAuditWorkspaceId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/rg-demi-prod/providers/Microsoft.OperationalInsights/workspaces/demi-audit-prod'

// eagle-public-insights-prod, not eagle-insights-prod: prod names it after the app, test does not.
param appInsightsName = 'eagle-public-insights-prod'

param keycloakUrl = 'https://loginproxy.gov.bc.ca/auth'

// Same client as test: one Keycloak client serves the admin console in every environment.
param keycloakAllowedClients = 'eagle-admin-console'

// From the environment: it gates trust in X-Azure-SocketIP, so knowing it lets a caller pick its address.
param frontDoorId = readEnvironmentVariable('FRONT_DOOR_ID')

// OpenShift egress pool as APIM stamps it in X-Client-Ip, same in both environments. Safe in the open:
// APIM sets X-Client-Ip with `override`, so knowing them does not let a caller claim to be the cluster.
param trustedProxyIps = '142.34.194.121,142.34.194.122,142.34.194.123,142.34.194.124'

// Apex, www, and the AFD endpoint the site is still reachable on directly. No localhost.
param allowedOrigins = [
  'https://projects.eao.gov.bc.ca'
  'https://www.projects.eao.gov.bc.ca'
  'https://eagle-public-prod-aafug4ahavgzbvh9.a01.azurefd.net'
]

// demi-alerts-prod, in rg-demi-prod; an alert rule takes a full action-group id.
param alertActionGroupId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/rg-demi-prod/providers/microsoft.insights/actionGroups/demi-alerts-prod'

// demi-kv-prod is in rg-demi-prod, so the vault grant deploys there. eagle-demi owns the vault.
param keyVaultName = 'demi-kv-prod'
param keyVaultResourceGroup = 'rg-demi-prod'

// In c4b0a8-prod-networking, shared with demi-api-fc-prod; same /27 capacity limit as test.
param vnetSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/snet-demi-func-fc1-prod'

param contactEmails = [ readEnvironmentVariable('BUDGET_CONTACT_EMAIL') ]

// Pinned: an existing budget rejects a startDate change.
param budgetStartDate = '2026-09-01'
