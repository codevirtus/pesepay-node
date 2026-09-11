/**
 * The GitHub release body, cut out of `CHANGELOG.md`.
 *
 * Two failures matter here and neither is loud: a section that stops at the
 * wrong place ships the previous release's notes, and a relative link that
 * survives verbatim resolves against github.com rather than the repository, so
 * every "see MIGRATION.md" in a release announcement 404s.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { browsableRepositoryUrl, extractReleaseNotes } from '../../scripts/release-notes.mts';

const CHANGELOG = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const REPOSITORY = 'https://github.com/codevirtus/pesepay-node';

describe('release notes — against the real CHANGELOG', () => {
  it('takes the 2.0.0 section and stops at the next release', () => {
    const notes = extractReleaseNotes(CHANGELOG, '2.0.0');

    assert.equal(notes.date, '2026-09-11');
    assert.match(notes.body, /^A complete rewrite\./);
    assert.ok(notes.body.includes('### Breaking'));
    assert.ok(notes.body.includes('### Security'));
    assert.ok(!notes.body.includes('## [1.0.4]'));
    assert.ok(!notes.body.includes('Initial release.'));
  });

  it('does not carry the heading it was found by', () => {
    assert.ok(!extractReleaseNotes(CHANGELOG, '2.0.0').body.includes('## [2.0.0]'));
  });

  it('ends with the compare link the changelog already defines', () => {
    const notes = extractReleaseNotes(CHANGELOG, '2.0.0');
    assert.ok(
      notes.body.endsWith(`**Full changelog**: ${REPOSITORY}/compare/v1.0.4...v2.0.0`),
      notes.body.slice(-120),
    );
  });

  it('finds a heading written without brackets', () => {
    assert.match(extractReleaseNotes(CHANGELOG, '1.0.0').body, /Initial release\./);
  });

  it('refuses a version that is not in the changelog', () => {
    assert.throws(() => extractReleaseNotes(CHANGELOG, '3.1.4'), /no "## \[3\.1\.4\]" section/);
  });

  it('refuses an empty section, rather than releasing blank notes', () => {
    assert.throws(() => extractReleaseNotes(CHANGELOG, 'Unreleased'), /is empty/);
  });
});

describe('release notes — links', () => {
  const changelog = [
    '## [2.0.0] - 2026-09-11',
    '',
    'See [MIGRATION.md](MIGRATION.md) and [the docs](docs/API.md).',
    'Unchanged: [npm](https://npmjs.com/package/pesepay), [below](#breaking).',
    '',
    '## [1.0.4] - 2024-06-22',
  ].join('\n');

  it('rewrites relative links against the tag being released', () => {
    const { body } = extractReleaseNotes(changelog, '2.0.0', { repositoryUrl: REPOSITORY });

    assert.ok(body.includes(`[MIGRATION.md](${REPOSITORY}/blob/v2.0.0/MIGRATION.md)`));
    assert.ok(body.includes(`[the docs](${REPOSITORY}/blob/v2.0.0/docs/API.md)`));
  });

  it('leaves absolute links and anchors alone', () => {
    const { body } = extractReleaseNotes(changelog, '2.0.0', { repositoryUrl: REPOSITORY });

    assert.ok(body.includes('[npm](https://npmjs.com/package/pesepay)'));
    assert.ok(body.includes('[below](#breaking)'));
  });

  it('leaves every link alone when there is no repository to resolve against', () => {
    const { body } = extractReleaseNotes(changelog, '2.0.0');

    assert.ok(body.includes('[MIGRATION.md](MIGRATION.md)'));
  });
});

describe('release notes — repository URLs', () => {
  it('normalises the forms package.json is written in', () => {
    for (const url of [
      'git+https://github.com/codevirtus/pesepay-node.git',
      'https://github.com/codevirtus/pesepay-node',
      'git@github.com:codevirtus/pesepay-node.git',
      'git+ssh://git@github.com/codevirtus/pesepay-node.git',
    ]) {
      assert.equal(browsableRepositoryUrl(url), REPOSITORY, url);
    }
  });

  it('has nothing to offer for a missing or unbrowsable repository', () => {
    assert.equal(browsableRepositoryUrl(undefined), undefined);
    assert.equal(browsableRepositoryUrl(''), undefined);
    assert.equal(browsableRepositoryUrl('codevirtus/pesepay-node'), undefined);
  });
});
