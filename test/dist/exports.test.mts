import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require_ = createRequire(import.meta.url);
const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/**
 * Resolve a built artifact at runtime.
 *
 * The specifier is built dynamically on purpose: `dist/` does not exist when
 * `npm run typecheck` runs, so a static `import('../../dist/index.mjs')` would
 * fail to compile. These tests assert runtime behaviour of the build output and
 * run only after `npm run build`.
 */
const distUrl = (p: string): string => new URL(`../../dist/${p}`, import.meta.url).href;

describe('published artifacts', () => {
  it('is requirable as CommonJS', () => {
    const cjs = require_('../../dist/index.js');
    assert.equal(typeof cjs.VERSION, 'string');
  });

  it('exposes named exports through the ESM wrapper', async () => {
    // Guards the cjs-module-lexer named-export detection that dist/index.mjs
    // depends on. If TypeScript ever changes its CJS emit shape, this fails.
    const esm = await import(distUrl('index.mjs'));
    assert.equal(typeof esm.VERSION, 'string');
  });

  it('resolves require and import to a single module instance', async () => {
    const cjs = require_('../../dist/index.js');
    const esm = await import(distUrl('index.mjs'));
    assert.equal(esm.VERSION, cjs.VERSION);
  });

  it('exposes the v1 compatibility entry point in both formats', async () => {
    assert.equal(require_('../../dist/compat/v1.js').V1_COMPAT, true);
    assert.equal((await import(distUrl('compat/v1.mjs'))).V1_COMPAT, true);
  });

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
  });

  it('emits CommonJS from .ts and ESM from .mts', () => {
    assert.match(read('dist/index.js'), /exports\./, 'dist/index.js should be CommonJS');
    assert.match(read('dist/index.mjs'), /^export /m, 'dist/index.mjs should be ESM');
  });
});
