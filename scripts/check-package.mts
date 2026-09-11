/**
 * What the tarball contains, and what it must not.
 *
 * 1.0.4 shipped 42 files — its `.gitignore` ignored `test.ts`, so `dist/test.js`
 * went to the registry. `files` is the only thing standing between that and a
 * repeat, and a glob that stops matching fails silently.
 *
 *   node scripts/check-package.mts
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface PackEntry {
  path: string;
}

interface PackResult {
  name: string;
  version: string;
  entryCount: number;
  size: number;
  files: PackEntry[];
}

const ALLOWED_ROOTS = ['dist/', 'src/'];
const ALLOWED_FILES = ['package.json', 'README.md', 'LICENSE'];
const FORBIDDEN = /(^|\/)(test|tests|__tests__)(\/|\.)|\.test\.|\.spec\.|\.tsbuildinfo$/i;

function packedFiles(): PackResult {
  // One string, not an argv: Windows needs a shell to find `npm.cmd`, and a
  // shell with an argv is DEP0190.
  const pack = spawnSync('npm pack --dry-run --json', { encoding: 'utf8', shell: true });
  if (pack.status !== 0) {
    throw new Error(`npm pack failed: ${pack.error?.message ?? pack.stderr}`);
  }
  // npm prints the tarball listing to stderr and the JSON to stdout.
  const parsed = JSON.parse(pack.stdout) as PackResult[];
  const result = parsed[0];
  if (result === undefined) throw new Error('npm pack --json returned nothing');
  return result;
}

function main(): void {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
  };
  const problems: string[] = [];

  const dependencies = Object.keys(manifest.dependencies ?? {});
  if (dependencies.length > 0) {
    problems.push(`runtime dependencies must stay at zero, found: ${dependencies.join(', ')}`);
  }

  const result = packedFiles();
  for (const { path } of result.files) {
    if (FORBIDDEN.test(path)) {
      problems.push(`test artefact in the tarball: ${path}`);
      continue;
    }
    const allowed =
      ALLOWED_FILES.includes(path) || ALLOWED_ROOTS.some((root) => path.startsWith(root));
    if (!allowed) problems.push(`unexpected file in the tarball: ${path}`);
  }

  for (const required of ALLOWED_FILES) {
    if (!result.files.some((file) => file.path === required)) {
      problems.push(`missing from the tarball: ${required}`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write(`${problems.map((problem) => `  ✗ ${problem}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const kb = (result.size / 1024).toFixed(1);
  process.stdout.write(
    `${result.name}@${result.version}: ${result.entryCount} files, ${kb} KB packed, 0 runtime dependencies\n`,
  );
}

main();
