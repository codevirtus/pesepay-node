/**
 * Typed access to the individual built modules.
 *
 * Same pattern as `sdk.mts`, one loader per module, and for the same reason:
 * the package is `"type": "commonjs"`, so `src/**\/*.ts` emits CommonJS and
 * Node cannot load those sources directly under type stripping — an `.mts` test
 * importing `../../src/crypto.ts` fails with "does not provide an export named
 * encryptPayload", because Node treats the file as CJS and finds no `exports.`
 * assignments in what is still ESM syntax.
 *
 * So: **types from source, values from `dist/`**. The `import type` lines below
 * are erased at runtime, so nothing in `src/` is ever loaded, while every test
 * stays checked against the real declarations. `pretest` runs `build`, so the
 * values are never stale.
 *
 * These modules are not in the package's `exports` map yet — entry points land
 * in stage 6 — so they are reached by path, which is exactly what the tests
 * want anyway: the unit under test, not the public facade.
 */
import { createRequire } from 'node:module';
import type * as CryptoModule from '../../src/crypto.ts';
import type * as ErrorsModule from '../../src/errors.ts';
import type * as TransportModule from '../../src/internal/transport.ts';
import type * as StatusModule from '../../src/status.ts';

const require_ = createRequire(import.meta.url);

/** `src/crypto.ts`, loaded from `dist/crypto.js`. */
export const crypto: typeof CryptoModule = require_('../../dist/crypto.js');

/** `src/errors.ts`, loaded from `dist/errors.js`. */
export const errors: typeof ErrorsModule = require_('../../dist/errors.js');

/** `src/status.ts`, loaded from `dist/status.js`. */
export const status: typeof StatusModule = require_('../../dist/status.js');

/** `src/internal/transport.ts`, loaded from `dist/internal/transport.js`. */
export const transport: typeof TransportModule = require_('../../dist/internal/transport.js');
