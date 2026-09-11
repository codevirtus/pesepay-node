/**
 * Typed access to the built package.
 *
 * The package is `"type": "commonjs"`, so `src/**\/*.ts` files emit CommonJS —
 * which also means Node cannot load them directly as ESM under type stripping.
 * Tests therefore exercise the build output in `dist/`, which is what consumers
 * actually receive.
 *
 * Types still come from source: the `import type` below is erased at runtime, so
 * nothing in `src/` is ever loaded, while the test files stay fully type-checked
 * against the real declarations.
 */
import { createRequire } from 'node:module';
import type * as IndexModule from '../../src/index.ts';

const require_ = createRequire(import.meta.url);

/** The package's main entry point, loaded from `dist/`. */
export const sdk: typeof IndexModule = require_('../../dist/index.js');
