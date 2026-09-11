/**
 * ESM facade over the CommonJS build.
 *
 * Re-exports are listed explicitly rather than using `export *`, which would
 * leak `__esModule` and `module.exports` into the ESM namespace. Both entry
 * points resolve to a single module instance, so `instanceof` holds across the
 * require/import boundary and there is no dual-package hazard.
 */
export { VERSION } from './index.js';
