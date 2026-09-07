using './main.bicep'

// Production: rg-eagle-public-prod in c4b0a8-prod (be5924ac-1083-4a1b-be92-7b444882cfd9).
// Deploy with CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --live, and read the what-if first.

param environmentName = 'prod'
param location = 'canadacentral'

// demi-identity-prod, which lives in rg-demi-prod. A principal id is subscription-wide, so the
// publisher grant on the DCR in this group works across resource groups. Read 2026-09-05:
//   az identity show -n demi-identity-prod -g rg-demi-prod --query principalId
param demiIdentityPrincipalId = '7d904cf2-2918-4a54-bbb4-acdf27c55e8b'

// eagle-public-logs-prod, NOT "eagle-logs-prod" — no workspace of that name exists in prod. Taken
// from eagle-public-insights-prod's WorkspaceResourceId, which is where the Function's own log lines
// land and therefore the only workspace the dropped-rows alert can query. Same resource group as this
// deployment, so the reader grant is made by the template.
param eagleLogsWorkspaceId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/rg-eagle-public-prod/providers/Microsoft.OperationalInsights/workspaces/eagle-public-logs-prod'

// In rg-demi-prod, a DIFFERENT resource group from this deployment. The template reads this
// workspace's customer id at deploy time, so the deploying principal needs read on it; it cannot
// assign a role outside its own group, so Log Analytics Reader for analytics-identity-prod on this
// workspace is granted by hand, once:
//   az role assignment create --assignee <analytics-identity-prod principalId> \
//     --role "Log Analytics Reader" --scope <this id>
// Until then the audit viewer's union over the pre-cutover DemiAudit_CL rows returns 403.
param demiAuditWorkspaceId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/rg-demi-prod/providers/Microsoft.OperationalInsights/workspaces/demi-audit-prod'

// eagle-public-insights-prod, not eagle-insights-prod: prod names it after the app, test does not.
param appInsightsName = 'eagle-public-insights-prod'

param keycloakUrl = 'https://loginproxy.gov.bc.ca/auth'

// Same client as test: one Keycloak client serves the admin console in every environment.
param keycloakAllowedClients = 'eagle-admin-console'

// eagle-edge-prod's own id, from:
//   az afd profile show -g rg-eagle-public-prod -n eagle-edge-prod --query frontDoorId
// Out of the environment for the same reason as the header values below: it decides whether
// X-Azure-SocketIP is trusted, so a caller who knows it can choose its own client address.
param frontDoorId = readEnvironmentVariable('FRONT_DOOR_ID')

// The OpenShift cluster's egress pool, measured 2026-09-07 from what APIM stamped in X-Client-Ip. The
// same four addresses in both environments. Unlike frontDoorId above these are safe in the open: APIM
// sets X-Client-Ip with `override`, so knowing them does not let a caller claim to be the cluster.
param trustedProxyIps = '142.34.194.121,142.34.194.122,142.34.194.123,142.34.194.124'

// Both the apex and the www host serve the public site; the AFD endpoint hostname is the origin the
// site is still reachable on directly. No localhost here.
param allowedOrigins = [
  'https://projects.eao.gov.bc.ca'
  'https://www.projects.eao.gov.bc.ca'
  'https://eagle-public-prod-aafug4ahavgzbvh9.a01.azurefd.net'
]

// demi-alerts-prod, in rg-demi-prod. An alert rule takes a full action-group id, so the group does
// not have to be local.
param alertActionGroupId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/rg-demi-prod/providers/microsoft.insights/actionGroups/demi-alerts-prod'

// Same rule as test: no fallback, so a forgotten export fails the build instead of blanking the live
// header and letting anything call the Function host directly.
param apimSharedHeaderValue = readEnvironmentVariable('APIM_SHARED_HEADER_VALUE')

// Same rule: POST /audit's own credential, no fallback.
param auditSharedHeaderValue = readEnvironmentVariable('AUDIT_SHARED_HEADER_VALUE')

param contactEmails = [ readEnvironmentVariable('BUDGET_CONTACT_EMAIL') ]

// Estimated run rate is about 17 CAD/month; the same 60 as test, because the guard is sized to catch
// a runaway client, not to separate the two environments.
param budgetStartDate = '2026-09-01'
