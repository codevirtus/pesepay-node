/**
 * The published artifacts, as a consumer receives them.
 *
 * The load-bearing assertion in this file is `esm.Pesepay === cjs.Pesepay`.
 * A dual build — tsup, unbuild, two `tsc` runs — would compile the sources
 * twice and give `require('pesepay')` and `import 'pesepay'` two distinct
 * `PesepayError` constructors, at which point `instanceof` silently answers
 * `false` for an error that crossed the boundary. It is silent, it only shows
 * up in a mixed-module application, and it is the reason the build is a single
 * `tsc` run emitting an `.mjs` wrapper *next to* the CommonJS it re-exports.
 * Everything else here guards that shape: the wrapper's explicit named
 * re-exports (`export *` leaks `__esModule` and `module.exports` into the ESM
 * namespace), the parity of the two export lists, and zero dependencies.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require_ = createRequire(import.meta.url);
const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/**
 * A declaration file with its TSDoc removed.
 *
 * `removeComments` is off for the build — for most consumers the declarations
 * *are* the API reference, via editor hover — so a name merely discussed in
 * prose would otherwise satisfy a search for it, in both directions.
 */
const declarationsOf = (p: string): string => read(p).replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Resolve a built artifact at runtime.
 *
 * The specifier is built dynamically on purpose: `dist/` does not exist when
 * `npm run typecheck` runs, so a static `import('../../dist/index.mjs')` would
 * fail to compile. These tests assert runtime behaviour of the build output and
 * run only after `npm run build`.
 */
const distUrl = (p: string): string => new URL(`../../dist/${p}`, import.meta.url).href;

/** Values the README documents. Every one must exist in both flavours. */
const PUBLIC_VALUES = [
  'DEFAULT_BASE_URL',
  'DEFAULT_TIMEOUT_MS',
  'NON_TERMINAL_TRANSACTION_STATUSES',
  'Pesepay',
  'PesepayApiError',
  'PesepayAuthError',
  'PesepayConfigError',
  'PesepayCryptoError',
  'PesepayError',
  'PesepayNetworkError',
  'PesepayTimeoutError',
  'TERMINAL_TRANSACTION_STATUSES',
  'TRANSACTION_STATUS_CODES',
  'TRANSACTION_STATUS_DESCRIPTIONS',
  'TransactionStatus',
  'VERSION',
  'createHttpsTransport',
  'httpsTransport',
  'isPaid',
  'isTerminal',
  'isTransactionStatus',
] as const;

/** Types the README documents. Declarations are the API reference for these. */
const PUBLIC_TYPES = [
  'AmountDetails',
  'CallbackHeaders',
  'CallbackKeyStatus',
  'CallbackVerification',
  'Currency',
  'CustomerDetails',
  'HttpsTransportOptions',
  'InitiateInvoiceOptions',
  'InitiateTransactionOptions',
  'InitiateTransactionResponse',
  'Invoice',
  'InvoicePayer',
  'InvoiceResult',
  'InvoiceStatus',
  'PaymentMethod',
  'PaymentResult',
  'PaymentTransactionResult',
  'PesepayApiErrorInit',
  'PesepayErrorBody',
  'PesepayErrorCode',
  'PesepayOptions',
  'RecurringFrequency',
  'RequiredField',
  'RequiredFieldType',
  'SeamlessPaymentOptions',
  'SplitReversalResponse',
  'TransactionType',
  'Transport',
  'TransportMethod',
  'TransportRequest',
  'TransportResponse',
] as const;

/** v1's surface, as `pesepay/v1-compat` must present it. */
const V1_COMPAT_VALUES = [
  'ALGORITHM',
  'Amount',
  'BASE_URL',
  'CHECK_PAYMENT_URL',
  'Customer',
  'INITIATE_PAYMENT_URL',
  'MAKE_SEAMLESS_PAYMENT_URL',
  'Payment',
  'Pesepay',
  'PesepayResponse',
  'Transaction',
  'V1_COMPAT',
] as const;

// biome-ignore lint/suspicious/noExplicitAny: a runtime-built specifier gives `any`.
const loadEsm = (p: string): Promise<any> => import(distUrl(p));

describe('published artifacts — one module, two entry points', () => {
  it('resolves require and import to the same objects, not to copies', async () => {
    const cjs = require_('../../dist/index.js');
    const esm = await loadEsm('index.mjs');

    for (const name of PUBLIC_VALUES) {
      assert.equal(esm[name], cjs[name], `${name} differs between require and import`);
    }
  });

  it('keeps instanceof working across a require/import crossing', async () => {
    const cjs = require_('../../dist/index.js');
    const esm = await loadEsm('index.mjs');

    // Thrown by the require side, caught on the import side — the mixed-module
    // application this package has to survive.
    let thrown: unknown;
    try {
      new cjs.Pesepay({ integrationKey: 'k', encryptionKey: 'too-short' });
    } catch (error: unknown) {
      thrown = error;
    }

    assert.ok(thrown instanceof esm.PesepayConfigError);
    assert.ok(thrown instanceof esm.PesepayError);
    assert.ok(thrown instanceof cjs.PesepayError);
    assert.equal(esm.PesepayConfigError, cjs.PesepayConfigError);
  });

  it('keeps instanceof working in the other direction too', async () => {
    const cjs = require_('../../dist/index.js');
    const esm = await loadEsm('index.mjs');

    const error = new esm.PesepayTimeoutError('timed out', 30_000);

    assert.ok(error instanceof cjs.PesepayTimeoutError);
    assert.ok(error instanceof cjs.PesepayNetworkError);
    assert.ok(error instanceof cjs.PesepayError);
  });

  it('resolves the v1 compat entry point to one module too', async () => {
    const cjs = require_('../../dist/compat/v1.js');
    const esm = await loadEsm('compat/v1.mjs');

    for (const name of V1_COMPAT_VALUES) {
      assert.equal(esm[name], cjs[name], `${name} differs between require and import`);
    }
  });

  it('shares the client between the modern and the compat entry points', () => {
    // The compat layer must wrap the same class, not a second copy: a
    // PesepayError thrown inside it has to be catchable with the modern one.
    const compat = require_('../../dist/compat/v1.js');
    const pesepay = new compat.Pesepay('key', '0123456789abcdef0123456789abcdef');

    assert.ok(pesepay.client instanceof require_('../../dist/index.js').Pesepay);
  });
});

describe('published artifacts — the ESM namespace', () => {
  it('leaks no CommonJS internals', async () => {
    for (const entry of ['index.mjs', 'compat/v1.mjs']) {
      const esm = await loadEsm(entry);

      for (const leak of ['__esModule', 'module.exports', 'exports', 'default']) {
        assert.ok(!(leak in esm), `${entry} namespace carries ${leak}`);
      }
    }
  });

  it('exports exactly what CommonJS does, name for name', async () => {
    // Catches the failure mode of an explicit re-export list: a name added to
    // index.ts and forgotten in index.mts is invisible until a consumer
    // imports it.
    for (const [cjsPath, esmPath] of [
      ['../../dist/index.js', 'index.mjs'],
      ['../../dist/compat/v1.js', 'compat/v1.mjs'],
    ] as const) {
      const cjs = Object.keys(require_(cjsPath)).sort();
      const esm = Object.keys(await loadEsm(esmPath)).sort();

      assert.deepEqual(esm, cjs, `${esmPath} and ${cjsPath} disagree`);
    }
  });

  it('is requirable as CommonJS and importable as ESM', async () => {
    assert.equal(typeof require_('../../dist/index.js').VERSION, 'string');
    assert.equal(typeof (await loadEsm('index.mjs')).VERSION, 'string');
  });

  it('exposes the v1 compatibility entry point in both formats', async () => {
    assert.equal(require_('../../dist/compat/v1.js').V1_COMPAT, true);
    assert.equal((await loadEsm('compat/v1.mjs')).V1_COMPAT, true);
  });
});

describe('published artifacts — the documented surface', () => {
  it('exports every documented value from both flavours', async () => {
    const cjs = require_('../../dist/index.js');
    const esm = await loadEsm('index.mjs');

    for (const name of PUBLIC_VALUES) {
      assert.ok(name in cjs, `require('pesepay').${name} is missing`);
      assert.ok(name in esm, `import 'pesepay' is missing ${name}`);
    }
  });

  it('declares every documented type in both declaration flavours', () => {
    for (const file of ['dist/index.d.ts', 'dist/index.d.mts']) {
      const declarations = declarationsOf(file);
      for (const name of PUBLIC_TYPES) {
        assert.match(declarations, new RegExp(`\\b${name}\\b`), `${file} does not export ${name}`);
      }
    }
  });

  it('exports v1 whole surface from the compat entry point', async () => {
    const cjs = require_('../../dist/compat/v1.js');
    const esm = await loadEsm('compat/v1.mjs');

    for (const name of V1_COMPAT_VALUES) {
      assert.ok(name in cjs, `require('pesepay/v1-compat').${name} is missing`);
      assert.ok(name in esm, `import 'pesepay/v1-compat' is missing ${name}`);
    }
  });

  it('keeps encryption out of the public surface', () => {
    // Raw AES-256-CBC with no integrity protection is not a primitive to hand
    // out, and nothing public needs it. It ships in dist/, reachable by path;
    // it is simply not part of the API.
    const cjs = require_('../../dist/index.js');

    for (const name of ['encryptPayload', 'decryptPayload', 'assertValidEncryptionKey']) {
      assert.ok(!(name in cjs), `${name} should not be a public export`);
    }
  });

  it('keeps the request wire shapes out of the declarations', () => {
    // No public method takes one, and exporting them would pin this package to
    // the gateway's request shape as a compatibility promise.
    const declarations = declarationsOf('dist/index.d.ts');

    for (const name of [
      'CreateTransactionRequest',
      'SeamlessPaymentRequest',
      'CreateInvoiceRequest',
      'EncryptedEnvelope',
      'AmountRequest',
    ]) {
      assert.ok(!declarations.includes(name), `${name} should not be re-exported from the entry`);
    }
  });
});

describe('published artifacts — the package', () => {
  it('emits both declaration flavours for every entry point', () => {
    for (const f of [
      'dist/index.js',
      'dist/index.mjs',
      'dist/index.d.ts',
      'dist/index.d.mts',
      'dist/compat/v1.js',
      'dist/compat/v1.mjs',
      'dist/compat/v1.d.ts',
      'dist/compat/v1.d.mts',
    ]) {
      assert.ok(read(f).length > 0, `missing or empty ${f}`);
    }
  });

  it('ships no runtime dependencies', () => {
    const pkg = JSON.parse(read('package.json'));

    assert.deepEqual(pkg.dependencies ?? {}, {});
    assert.deepEqual(pkg.peerDependencies ?? {}, {});
    assert.deepEqual(pkg.optionalDependencies ?? {}, {});
    assert.deepEqual(pkg.bundleDependencies ?? [], []);
  });

  it('requires nothing outside node: builtins and its own files', () => {
    for (const file of ['dist/index.js', 'dist/client.js', 'dist/compat/v1.js']) {
      for (const [, specifier] of read(file).matchAll(/require\("([^"]+)"\)/g)) {
        assert.ok(
          (specifier as string).startsWith('node:') || (specifier as string).startsWith('.'),
          `${file} requires ${specifier}`,
        );
      }
    }
  });

  it('emits CommonJS from .ts and ESM from .mts', () => {
    assert.match(read('dist/index.js'), /exports\./, 'dist/index.js should be CommonJS');
    assert.match(read('dist/index.mjs'), /^export /m, 'dist/index.mjs should be ESM');
    assert.match(read('dist/compat/v1.js'), /exports\./, 'dist/compat/v1.js should be CommonJS');
    assert.match(read('dist/compat/v1.mjs'), /^export /m, 'dist/compat/v1.mjs should be ESM');
  });

  it('resolves both entry points through the exports map', () => {
    const pkg = JSON.parse(read('package.json'));

    assert.equal(pkg.exports['.'].require.default, './dist/index.js');
    assert.equal(pkg.exports['.'].import.default, './dist/index.mjs');
    assert.equal(pkg.exports['./v1-compat'].require.default, './dist/compat/v1.js');
    assert.equal(pkg.exports['./v1-compat'].import.default, './dist/compat/v1.mjs');
  });

  it('reports a VERSION that matches package.json', () => {
    assert.equal(require_('../../dist/index.js').VERSION, JSON.parse(read('package.json')).version);
  });
});
