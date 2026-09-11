/**
 * The package as a consumer receives it: installed from the tarball, on the
 * oldest Node the `engines` field claims to support.
 *
 * Plain JavaScript on purpose — the test suite is `.mts` and needs type
 * stripping, which Node 22 only enables by default from 22.18. This runs
 * anywhere the published package claims to.
 *
 * Copy it next to a `node_modules` holding `pesepay`, then `node smoke-installed.mjs`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const cjs = require('pesepay');
const esm = await import('pesepay');
const manifest = require('pesepay/package.json');

assert.equal(esm.Pesepay, cjs.Pesepay, 'ESM and CJS must resolve to one class');
assert.equal(esm.PesepayConfigError, cjs.PesepayConfigError);
assert.equal(cjs.VERSION, manifest.version);
assert.deepEqual(manifest.dependencies ?? {}, {}, 'the package must have no runtime dependencies');

const pesepay = new cjs.Pesepay({
  integrationKey: '00000000-0000-0000-0000-000000000000',
  encryptionKey: '0'.repeat(32),
  resultUrl: 'https://example.com/webhook',
  returnUrl: 'https://example.com/done',
});
assert.equal(typeof pesepay.initiateTransaction, 'function');
assert.equal(cjs.isPaid(cjs.TransactionStatus.SUCCESS), true);

// Thrown through `require`, caught through `import`.
assert.throws(
  () => new cjs.Pesepay({ integrationKey: 'k', encryptionKey: 'too short' }),
  (error) => error instanceof esm.PesepayConfigError,
);

const { Pesepay: V1Pesepay } = require('pesepay/v1-compat');
assert.equal(typeof new V1Pesepay('k', '0'.repeat(32)).createTransaction, 'function');

process.stdout.write(`ok — pesepay@${manifest.version} on Node ${process.version}\n`);
