// User-assigned managed identity for eagle-analytics.
//
// User-assigned rather than system-assigned so the DCR publisher grant, the workspace reader grants
// and the storage data-plane grants can be made before the Function App exists and survive its
// redeploy. The ingest Function, the read API and the operator scripts all run as this one.

@description('Location for the managed identity')
param location string = resourceGroup().location

@description('Environment name (e.g. test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

resource analyticsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'analytics-identity-${environmentName}'
  location: location
  tags: tags
}

output identityId string = analyticsIdentity.id
output principalId string = analyticsIdentity.properties.principalId
output clientId string = analyticsIdentity.properties.clientId
