'use strict';

const assert = require('node:assert');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * azure/main.bicep compiled as PR Validation does, then read as ARM. Not grepped: the secret URI is
 * composed from three pieces across two files, so no one source line shows what the app gets.
 */

const AZURE_DIR = path.join(__dirname, '..', 'azure');
const KEY_VAULT_SECRETS_USER = '4633458b-17de-408a-b874-0445c86b69e6';

const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-bicep-'));
after(() => fs.rmSync(buildDir, { recursive: true, force: true }));

/** `null` when the Azure CLI is not installed; a failed compile throws rather than skipping. */
function compile(file) {
  const outFile = path.join(buildDir, `${path.basename(file, '.bicep')}.json`);
  const result = spawnSync('az', ['bicep', 'build', '--file', path.join(AZURE_DIR, file), '--outfile', outFile], {
    encoding: 'utf8'
  });

  if (result.error && result.error.code === 'ENOENT') return null;
  assert.strictEqual(result.status, 0, `az bicep build failed: ${result.stderr}`);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

/** Parameter values a .bicepparam resolves to, environment reads included. */
function resolveParams(file, env) {
  const result = spawnSync('az', ['bicep', 'build-params', '--file', path.join(AZURE_DIR, file), '--stdout'], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });

  if (result.error && result.error.code === 'ENOENT') return null;
  assert.strictEqual(result.status, 0, `az bicep build-params failed: ${result.stderr}`);
  return JSON.parse(JSON.parse(result.stdout).parametersJson).parameters;
}

const PARAM_ENV = { FRONT_DOOR_ID: 'placeholder', BUDGET_CONTACT_EMAIL: 'someone@example.invalid' };

const template = compile('main.bicep');
const noAzureCli = template ? false : 'Azure CLI not installed, so the template was never compiled';

const moduleNamed = (name) => template.resources.find((resource) => resource.name === name);
const functionApp = () =>
  moduleNamed('deploy-api-function-flex').properties.template.resources.find(
    (resource) => resource.type === 'Microsoft.Web/sites'
  );
const appSetting = (name) =>
  functionApp().properties.siteConfig.appSettings.find((setting) => setting.name === name);

// Bicep compiles `'a${b}c'` to `[format('a{0}c', ...)]`; a plain string comes back unchanged.
const literalText = (value) => value.match(/^\[format\('([^']*)'/)?.[1] ?? value;

const HEADER_SECRETS = [
  { header: 'gateway', setting: 'APIM_SHARED_HEADER_VALUE', uri: 'apimSharedHeaderSecretUri', name: 'apimSharedHeaderSecretName' },
  { header: 'audit', setting: 'AUDIT_SHARED_HEADER_VALUE', uri: 'auditSharedHeaderSecretUri', name: 'auditSharedHeaderSecretName' }
];

for (const { header, setting, uri, name } of HEADER_SECRETS) {
  test(`the ${header} header app setting is a Key Vault reference to its own secret`, { skip: noAzureCli }, () => {
    const value = appSetting(setting).value;

    assert.match(literalText(value), /^@Microsoft\.KeyVault\(SecretUri=/);
    assert.ok(value.includes(`parameters('${uri}')`), value);
  });

  // A URI with a version pinned would freeze the app on the value that was current at deploy time, so
  // rotating the secret in the vault would change nothing until the next deployment.
  test(`the ${header} secret URI is versionless and names its own secret`, { skip: noAzureCli }, () => {
    const value = template.variables[uri];

    assert.match(literalText(value), /\/secrets\/[^/]+$/);
    assert.ok(value.includes(`variables('${name}')`), value);
  });
}

test('the vault host comes from the vault name and the cloud\'s own suffix', { skip: noAzureCli }, () => {
  const vaultUri = template.variables.vaultUri;

  assert.match(literalText(vaultUri), /^https:\/\//);
  assert.match(vaultUri, /parameters\('keyVaultName'\)/);
  assert.match(vaultUri, /environment\(\)\.suffixes\.keyvaultDns/);
});

// Left unset, the platform resolves references as the system-assigned identity, which this app does
// not have: every reference would come back empty and the app would boot with no header to check.
test('the app resolves its Key Vault references with the identity attached to it', { skip: noAzureCli }, () => {
  const site = functionApp();

  assert.strictEqual(site.properties.keyVaultReferenceIdentity, "[parameters('identityId')]");
  assert.deepStrictEqual(Object.keys(site.identity.userAssignedIdentities), [
    "[format('{0}', parameters('identityId'))]"
  ]);
});

// demi-kv-<env> is private, and App Service resolves references over the app's own outbound path,
// so with no subnet both header settings resolve to nothing and guarded routes answer 401.
test('the app integrates with the subnet its vault answers on', { skip: noAzureCli }, () => {
  const site = functionApp();
  const module = moduleNamed('deploy-api-function-flex');

  assert.strictEqual(site.properties.virtualNetworkSubnetId, "[parameters('virtualNetworkSubnetId')]");
  assert.strictEqual(module.properties.parameters.virtualNetworkSubnetId.value, "[parameters('vnetSubnetId')]");
});

// A default would let a deployment that forgot the subnet succeed and come up unable to read either
// header, which is the failure this whole arrangement exists to avoid.
test('the subnet is required, not defaulted', { skip: noAzureCli }, () => {
  assert.ok(!('defaultValue' in template.parameters.vnetSubnetId), 'vnetSubnetId has a default');
});

// Fixed strings in both environments, so not parameters.
test('the secret names are fixed in the template, not passed in', { skip: noAzureCli }, () => {
  assert.strictEqual(template.variables.apimSharedHeaderSecretName, 'analytics-shared-header');
  assert.strictEqual(template.variables.auditSharedHeaderSecretName, 'analytics-audit-header');
  assert.ok(!('apimSharedHeaderSecretName' in template.parameters), 'apimSharedHeaderSecretName is a parameter again');
  assert.ok(!('auditSharedHeaderSecretName' in template.parameters), 'auditSharedHeaderSecretName is a parameter again');
});

test('the resolving identity is the one the identity module creates', { skip: noAzureCli }, () => {
  assert.match(
    moduleNamed('deploy-api-function-flex').properties.parameters.identityId.value,
    /'deploy-identity'.*outputs\.identityId/
  );
});

// No @secure() params: a secure param still puts the value in the shell and the deployment record.
test('no template parameter carries a header value', { skip: noAzureCli }, () => {
  const secureParams = Object.entries(template.parameters)
    .filter(([, definition]) => definition.type === 'securestring')
    .map(([name]) => name);

  assert.deepStrictEqual(secureParams, []);
  assert.ok(!('apimSharedHeaderValue' in template.parameters), 'apimSharedHeaderValue is back');
  assert.ok(!('auditSharedHeaderValue' in template.parameters), 'auditSharedHeaderValue is back');
});

// A role assignment is created in the group the deployment targets, so granting a vault in another
// group needs its own deployment scoped there.
test('the vault grant deploys into the vault\'s own resource group', { skip: noAzureCli }, () => {
  assert.strictEqual(moduleNamed('deploy-key-vault-access').resourceGroup, "[parameters('keyVaultResourceGroup')]");
});

test('the grant is Key Vault Secrets User for the analytics identity', { skip: noAzureCli }, () => {
  const grant = moduleNamed('deploy-key-vault-access').properties.template;
  const roleAssignment = grant.resources.find(
    (resource) => resource.type === 'Microsoft.Authorization/roleAssignments'
  );

  assert.strictEqual(grant.variables.keyVaultSecretsUserRoleId, KEY_VAULT_SECRETS_USER);
  assert.strictEqual(roleAssignment.properties.principalId, "[parameters('principalId')]");
  assert.match(
    moduleNamed('deploy-key-vault-access').properties.parameters.principalId.value,
    /'deploy-identity'.*outputs\.principalId/
  );
});

// Without the grant the Function App starts with empty header values, so the app must not come up
// before the assignment exists.
test('the Function App waits on the vault grant', { skip: noAzureCli }, () => {
  assert.ok(
    moduleNamed('deploy-api-function-flex').dependsOn.some((id) => id.includes('deploy-key-vault-access')),
    'the Function App does not depend on the vault grant'
  );
});

// The prod vault is in rg-demi-prod while this template deploys to rg-eagle-public-prod; test's vault
// is in the group being deployed to, so only prod moves the grant.
test('prod names the vault\'s resource group, test keeps the deployment\'s own', { skip: noAzureCli }, () => {
  assert.strictEqual(resolveParams('main.prod.bicepparam', PARAM_ENV).keyVaultResourceGroup?.value, 'rg-demi-prod');
  assert.ok(!('keyVaultResourceGroup' in resolveParams('main.test.bicepparam', PARAM_ENV)), 'test pins a resource group it does not need');
});

// The other environment's vault would deploy cleanly and leave both header settings unresolved.
for (const environment of ['test', 'prod']) {
  test(`${environment} reads its own environment's vault`, { skip: noAzureCli }, () => {
    assert.strictEqual(resolveParams(`main.${environment}.bicepparam`, PARAM_ENV).keyVaultName.value, `demi-kv-${environment}`);
  });
}
