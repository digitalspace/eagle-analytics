// Own module so the caller can scope it to the vault's group (rg-demi-prod in prod). Writes no secret:
// eagle-demi owns the vault and the values are set by hand from the devbox.

@description('Name of the existing vault, in THIS module\'s resource group')
param keyVaultName string

@description('Principal ID granted read on the vault\'s secrets')
param principalId string

var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource sharedSecretsVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sharedSecretsVault
  // Deterministic name, so a redeploy updates the assignment instead of failing on a duplicate.
  name: guid(sharedSecretsVault.id, principalId, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
