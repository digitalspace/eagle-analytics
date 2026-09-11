'use strict';

const assert = require('node:assert');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * scripts/deploy-infra.sh, exercised with no Azure: the required-variable checks run before the
 * first `az` call, and a stub `az` first on PATH stands in for the deploy the accepted case reaches.
 */

const SCRIPT = path.join(__dirname, '..', 'scripts', 'deploy-infra.sh');
const AZURE_DIR = path.join(__dirname, '..', 'azure');
const SECRET = 'value-that-must-never-be-printed';

// What the param files read from the environment with no fallback, so an unset one would deploy a
// blank setting. The header values are not here any more: they are Key Vault references now.
const REQUIRED = ['FRONT_DOOR_ID', 'BUDGET_CONTACT_EMAIL'];

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-infra-guard-'));
fs.writeFileSync(path.join(stubDir, 'az'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
after(() => fs.rmSync(stubDir, { recursive: true, force: true }));

const CLEAN = Object.freeze({
  PATH: `${stubDir}:${process.env.PATH}`,
  FRONT_DOOR_ID: '11111111-2222-3333-4444-555555555555',
  BUDGET_CONTACT_EMAIL: 'someone@example.invalid'
});

/** A what-if run, which is the shortest path through the script. */
const run = (env) =>
  spawnSync('bash', [SCRIPT, 'test', '--what-if'], { env: { ...CLEAN, ...env }, encoding: 'utf8' });

test('clean values reach the deployment', () => {
  const result = run({});
  assert.strictEqual(result.status, 0, result.stderr);
});

// The 401s on test: the operator's shell held the two header values with a trailing literal
// backslash-n, this script passed them into the app settings verbatim, and APIM stamped the clean
// value on every forwarded request.
const MANGLED = [
  ['a literal backslash-n', `${SECRET}\\n`],
  ['a trailing newline', `${SECRET}\n`],
  ['a leading newline', `\n${SECRET}`],
  ['a trailing space', `${SECRET} `],
  ['a tab', `${SECRET}\t`],
  ['an inner space', `${SECRET} more`],
  ['a carriage return', `${SECRET}\r`],
  ['nothing but whitespace', ' ']
];

for (const variable of REQUIRED) {
  for (const [label, value] of MANGLED) {
    test(`${variable} carrying ${label} stops the deploy`, () => {
      const result = run({ [variable]: value });

      assert.strictEqual(result.status, 2, `stderr: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(variable));
      // A secret in an operator's scrollback is a secret leaked; the error names the variable only.
      assert.ok(!result.stderr.includes(SECRET), `stderr repeated the value: ${result.stderr}`);
    });
  }
}

test('an unset variable is still reported as unset, not as mangled', () => {
  const result = run({ FRONT_DOOR_ID: '' });

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /FRONT_DOOR_ID is not set/);
});

// The values moved into demi-kv-<env> and the app settings became references to them, so the script
// has no reason to demand them — and an operator who still has a mangled one exported is not stopped
// by something that never reaches the deployment.
test('a header value left over in the operator\'s shell is not a deploy input', () => {
  const result = run({ APIM_SHARED_HEADER_VALUE: `${SECRET}\\n`, AUDIT_SHARED_HEADER_VALUE: `${SECRET} ` });

  assert.strictEqual(result.status, 0, result.stderr);
});

test('a deploy runs with neither header value in the environment', () => {
  const result = run({});

  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(!/SHARED_HEADER_VALUE/.test(result.stderr), `stderr still asks for a header value: ${result.stderr}`);
});

// A param file that reads a variable the loop above does not cover would deploy a blank setting: the
// build resolves the read to an empty string rather than failing.
test('every environment read the param files make is guarded', () => {
  const sources = fs
    .readdirSync(AZURE_DIR)
    .filter((name) => name.endsWith('.bicepparam'))
    .map((name) => fs.readFileSync(path.join(AZURE_DIR, name), 'utf8'))
    .join('\n');
  const read = [...sources.matchAll(/readEnvironmentVariable\('([^']+)'/g)].map((match) => match[1]);

  assert.deepStrictEqual([...new Set(read)].sort(), [...REQUIRED].sort());
});
