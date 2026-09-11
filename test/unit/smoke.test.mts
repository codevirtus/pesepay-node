import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sdk } from '../fixtures/sdk.mts';

describe('toolchain smoke', () => {
  it('exposes a semver version from the built package', () => {
    assert.match(sdk.VERSION, /^\d+\.\d+\.\d+/);
  });

  it('keeps the built version in step with package.json', async () => {
    const pkg = await import('../../package.json', { with: { type: 'json' } });
    assert.equal(sdk.VERSION, pkg.default.version);
  });
});
