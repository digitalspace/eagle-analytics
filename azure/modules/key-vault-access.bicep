// Key Vault Secrets User for the analytics identity on demi-kv-<env>.
//
// Its own module because the vault is not always in the group this estate deploys to: in production
// it lives in rg-demi-prod, and a role assignment is created in the group the deployment targets. The
// caller scopes this module to the vault's group. Nothing here creates or writes a secret — the
// values are set once by hand from the devbox, and the vault itself belongs to eagle-demi.

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
  // Same three inputs give the same name on every run, so a redeploy updates one assignment instead
  // of failing on a duplicate.
  name: guid(sharedSecretsVault.id, principalId, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
