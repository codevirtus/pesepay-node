/**
 * The release notes for one version, read out of `CHANGELOG.md`.
 *
 * The GitHub release and the changelog are the same text or they drift, and the
 * one people read is whichever they found first. `release.yml` runs this.
 *
 *   node scripts/release-notes.mts 2.0.0 [--out notes.md]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ReleaseNotes {
  version: string;
  /** The heading's date, `undefined` for a heading that carries none. */
  date: string | undefined;
  body: string;
}

/** `## [2.0.0] - 2026-09-11`, `## [Unreleased]`, `## 1.0.0 - 2021-10-11`. */
const HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s+[-–]\s+(\S+))?\s*$/;
const RELATIVE_LINK = /\]\((?!\w+:|\/\/|#)([^)\s]+)\)/g;

export function extractReleaseNotes(
  changelog: string,
  version: string,
  options: { repositoryUrl?: string | undefined; tag?: string | undefined } = {},
): ReleaseNotes {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING.exec(line ?? '')?.[1] === version);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  }

  const end = lines.findIndex((line, index) => index > start && HEADING.test(line ?? ''));
  const section = lines.slice(start + 1, end === -1 ? lines.length : end);

  const tag = options.tag ?? `v${version}`;
  const repositoryUrl = options.repositoryUrl;
  const body = trimBlankEdges(section)
    .join('\n')
    .replace(RELATIVE_LINK, (match, target: string) =>
      repositoryUrl === undefined ? match : `](${repositoryUrl}/blob/${tag}/${target})`,
    );

  if (body === '') {
    throw new Error(`The "## [${version}]" section of CHANGELOG.md is empty`);
  }

  const compareUrl = linkDefinition(lines, version);
  return {
    version,
    date: HEADING.exec(lines[start] ?? '')?.[2],
    body: compareUrl === undefined ? body : `${body}\n\n**Full changelog**: ${compareUrl}`,
  };
}

/** `https://github.com/o/r.git`, `git+ssh://git@github.com/o/r.git` → a browsable URL. */
export function browsableRepositoryUrl(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  const normalised = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return /^https?:\/\//.test(normalised) ? normalised : undefined;
}

function linkDefinition(lines: readonly string[], version: string): string | undefined {
  const prefix = `[${version}]:`;
  const line = lines.find((candidate) => (candidate ?? '').startsWith(prefix));
  const url = line?.slice(prefix.length).trim();
  return url === undefined || url === '' ? undefined : url;
}

function trimBlankEdges(lines: readonly string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && (copy[0] ?? '').trim() === '') copy.shift();
  while (copy.length > 0 && (copy.at(-1) ?? '').trim() === '') copy.pop();
  return copy;
}

function main(argv: readonly string[]): void {
  const args = [...argv];
  const outIndex = args.indexOf('--out');
  const out = outIndex === -1 ? undefined : args.splice(outIndex, 2)[1];
  const version = args[0];

  if (version === undefined || version.startsWith('-')) {
    throw new Error('usage: node scripts/release-notes.mts <version> [--out <file>]');
  }

  const root = new URL('..', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
    repository?: { url?: string };
  };

  const notes = extractReleaseNotes(
    readFileSync(new URL('CHANGELOG.md', root), 'utf8'),
    version.replace(/^v/, ''),
    { repositoryUrl: browsableRepositoryUrl(manifest.repository?.url) },
  );

  if (out === undefined) process.stdout.write(`${notes.body}\n`);
  else writeFileSync(out, `${notes.body}\n`, 'utf8');
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
