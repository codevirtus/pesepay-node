/**
 * Typed access to the individual built modules — types from source, values
 * from `dist/`.
 *
 * Same pattern and same reason as `sdk.mts`: the package is
 * `"type": "commonjs"`, so `src` emits CommonJS and Node cannot load those
 * sources directly under type stripping. The `import type` lines below are
 * erased at runtime, so nothing in `src/` is ever loaded while the tests stay
 * checked against the real declarations. `pretest` runs `build`, so the values
 * are never stale.
 *
 * Reached by path, which keeps these tests aimed at one module at a time; the
 * entry points and their `exports` map are covered in `test/dist/`.
 */
import { createRequire } from 'node:module';
import type * as ClientModule from '../../src/client.ts';
import type * as V1CompatModule from '../../src/compat/v1.ts';
import type * as CryptoModule from '../../src/crypto.ts';
import type * as ErrorsModule from '../../src/errors.ts';
import type * as TransportModule from '../../src/internal/transport.ts';
import type * as StatusModule from '../../src/status.ts';

const require_ = createRequire(import.meta.url);

export const client: typeof ClientModule = require_('../../dist/client.js');
export const crypto: typeof CryptoModule = require_('../../dist/crypto.js');
export const errors: typeof ErrorsModule = require_('../../dist/errors.js');
export const status: typeof StatusModule = require_('../../dist/status.js');
export const transport: typeof TransportModule = require_('../../dist/internal/transport.js');
export const v1: typeof V1CompatModule = require_('../../dist/compat/v1.js');
